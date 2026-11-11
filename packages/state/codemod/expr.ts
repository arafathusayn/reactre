// XState code inside a machine (guards, assigners, transition functions), read and rewritten:
// `context.x` becomes the state's `data.x`, the event keeps its name, named guards are inlined.

import type { CallExpression, Expression, Node } from "oxc-parser";

import { apply, type Edit, type Fn, isFunction, isReference, stringValue, walk } from "./ast.ts";
import type { Code, Field, Scope } from "./model.ts";

/** What the rewritten code is part of, and the module around it. */
export interface Env {
  readonly source: string;
  /** setup's named guards, by name. */
  readonly guards: ReadonlyMap<string, Expression>;
  /** Module-level names a transition may read: constants, functions, imports. */
  readonly constants: ReadonlySet<string>;
  /** Module-level `let` and `var`. */
  readonly mutable: ReadonlySet<string>;
}

export const EMPTY_SCOPE: Scope = {
  ctx: new Set(),
  event: new Set(),
  args: new Set(),
  guards: new Set(),
  params: new Map(),
  guardParams: null,
};

/**
 * The scope of a function's parameters. v5 and v6 functions take `({ context, event, guards }, params)`;
 * v4's take `(context, event)`.
 */
export function scopeOf(fn: Fn, positional: boolean, guardParamsValue: Code | null = null): Scope {
  const ctx = new Set<string>();
  const event = new Set<string>();
  const args = new Set<string>();
  const guards = new Set<string>();
  let guardParams: Scope["guardParams"] = null;
  const [first, second] = fn.params;
  if (positional) {
    if (first?.type === "Identifier") ctx.add(first.name);
    if (second?.type === "Identifier") event.add(second.name);
  } else {
    if (first?.type === "ObjectPattern")
      for (const p of first.properties) {
        if (p.type === "RestElement" || p.value.type !== "Identifier") continue;
        const name = p.key.type === "Identifier" ? p.key.name : stringValue(p.key);
        if (name === "context") ctx.add(p.value.name);
        else if (name === "event") event.add(p.value.name);
        else if (name === "guards") guards.add(p.value.name);
      }
    else if (first?.type === "Identifier") args.add(first.name);
    if (second?.type === "Identifier" && guardParamsValue !== null)
      guardParams = { name: second.name, value: guardParamsValue };
  }
  return { ctx, event, args, guards, params: new Map(), guardParams };
}

/** The expression a function returns: its expression body, or a block's only `return`. */
export function returned(fn: Fn): Expression | null {
  const body = fn.body;
  if (body === null) return null;
  if (body.type !== "BlockStatement") return body;
  const statements = body.body;
  const only = statements.length === 1 ? statements[0] : undefined;
  return only?.type === "ReturnStatement" && only.argument !== null ? only.argument : null;
}

/** What a piece of code refers to, as the rewriter and the readers see it. */
interface Visitor {
  /** `context.field` (or `args.context.field`). */
  field(node: Node, field: string): void;
  /** The whole context, passed or spread somewhere. */
  whole(node: Node): void;
  /** The event (`event`, or `args.event`); `member` is `event.prop` around it, if any. */
  event(node: Node, member: { readonly node: Node; readonly prop: string } | null): void;
  /** A parameter replaced by code. */
  param(node: Node, code: Code): void;
  /** `guards.name(...)` in a v6 function. */
  guardCall(node: CallExpression, name: string): void;
  /** `params.prop` of a v5 guard with params, and the params given. */
  guardParam(node: Node, prop: string | null, value: Code): void;
}

function memberName(node: Node): string | null {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return node.computed ? stringValue(node.property) : null;
}

/** Walk `code`'s references to the context, the event, parameters and guards. */
function visit(code: Code, v: Visitor, root: Node = code.node): void {
  const s = code.scope;
  // `{ context: { ...context, x } }`: a patch's spread of the context keeps the other fields; it
  // isn't a use of the context whole.
  const patchSpreads = new Set<Node>();
  walk(root, (node, parent, key) => {
    if (
      node.type === "Property" &&
      !node.computed &&
      node.key.type === "Identifier" &&
      node.key.name === "context" &&
      node.value.type === "ObjectExpression"
    )
      for (const p of node.value.properties)
        if (p.type === "SpreadElement" && p.argument.type === "Identifier" && s.ctx.has(p.argument.name))
          patchSpreads.add(p.argument);
    if (patchSpreads.has(node)) return false;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      s.guards.has(node.callee.object.name)
    ) {
      const name = memberName(node.callee);
      if (name !== null) {
        v.guardCall(node, name);
        return false;
      }
    }
    if (node.type === "MemberExpression") {
      const object = node.object;
      // args.context.x, args.context, args.event
      if (object.type === "MemberExpression" && object.object.type === "Identifier" && s.args.has(object.object.name)) {
        const inner = memberName(object);
        if (inner === "context") {
          const f = memberName(node);
          if (f !== null) v.field(node, f);
          else v.whole(object);
          return false;
        }
      }
      if (object.type === "Identifier" && isReference(parent, key)) {
        const name = memberName(node);
        if (s.ctx.has(object.name)) {
          if (name !== null) v.field(node, name);
          else v.whole(object);
          return false;
        }
        if (s.args.has(object.name)) {
          if (name === "event") {
            const outer = parent?.type === "MemberExpression" && key === "object" ? memberName(parent) : null;
            v.event(node, outer === null || parent === null ? null : { node: parent, prop: outer });
            return false;
          }
          if (name === "context") {
            v.whole(node);
            return false;
          }
        }
        if (s.event.has(object.name)) {
          v.event(object, name === null ? null : { node, prop: name });
          return false;
        }
        if (s.guardParams?.name === object.name) {
          v.guardParam(node, name, s.guardParams.value);
          return false;
        }
      }
      return true;
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      if (s.ctx.has(node.name)) v.whole(node);
      else if (s.event.has(node.name)) v.event(node, null);
      else if (s.args.has(node.name)) v.whole(node);
      else if (s.guardParams?.name === node.name) v.guardParam(node, null, s.guardParams.value);
      else {
        const p = s.params.get(node.name);
        if (p !== undefined) v.param(node, p);
      }
    }
    return true;
  });
}

/** The context fields a piece of code reads; "opaque" when it uses the context whole. */
export function reads(code: Code, env: Env): Set<string> | "opaque" {
  const out = new Set<string>();
  let opaque = false;
  const add = (r: Set<string> | "opaque"): void => {
    if (r === "opaque") opaque = true;
    else for (const f of r) out.add(f);
  };
  visit(code, {
    field: (_, f) => out.add(f),
    whole: () => {
      opaque = true;
    },
    event: () => {},
    param: (_, c) => add(reads(c, env)),
    guardCall: (call) => {
      for (const a of call.arguments) if (a.type !== "SpreadElement") add(reads({ node: a, scope: code.scope }, env));
    },
    guardParam: (_, __, value) => add(reads(value, env)),
  });
  return opaque ? "opaque" : out;
}

/** Whether the code reads the event. */
export function readsEvent(code: Code): boolean {
  let found = false;
  const any = (): void => {
    found = true;
  };
  visit(code, {
    field: () => {},
    whole: () => {},
    event: any,
    param: (_, c) => {
      if (readsEvent(c)) found = true;
    },
    guardCall: (call) => {
      for (const a of call.arguments)
        if (a.type !== "SpreadElement" && readsEvent({ node: a, scope: code.scope })) found = true;
    },
    guardParam: () => {},
  });
  return found;
}

/** How a read of the context, the event and the error is written in the output. */
export interface Out {
  /** A context field read. */
  readonly field: (name: string) => string;
  /** The whole context. */
  readonly whole: string;
  readonly event: string;
  /** Event properties written otherwise: in a task's error handler, `event.error` is `error`. */
  readonly special: ReadonlyMap<string, string>;
}

/** Whether `text` can stand in an expression without parentheses. */
function simple(text: string): boolean {
  return /^[\w$.]+$/.test(text) || /^"[^"]*"$/.test(text);
}

function paren(text: string): string {
  return simple(text) ? text : `(${text})`;
}

/**
 * `code` rewritten for the output. `todo` collects what can't be rewritten, at its offset.
 * `node` limits it to a part of the code (by default, all of it).
 */
export function rewrite(
  code: Code,
  env: Env,
  out: Out,
  todo: (at: number, message: string) => void,
  node: Node = code.node,
  extra: readonly Edit[] = [],
): string {
  const edits: Edit[] = [...extra];
  const src = env.source;
  // A shorthand property (`{ context }`) keeps its key when its value is renamed.
  const shorthand = new Map<number, string>();
  walk(node, (n) => {
    if (n.type === "Property" && n.shorthand && n.key.type === "Identifier") shorthand.set(n.value.start, n.key.name);
    return true;
  });
  const put = (n: Node, text: string): void => {
    const k = shorthand.get(n.start);
    edits.push({ start: n.start, end: n.end, text: k === undefined || k === text ? text : `${k}: ${text}` });
  };
  visit(
    code,
    {
      field: (n, f) => put(n, out.field(f)),
      whole: (n) => put(n, out.whole),
      event: (n, member) => {
        const special = member === null ? undefined : out.special.get(member.prop);
        if (member !== null && special !== undefined) put(member.node, special);
        else if (member !== null)
          put(member.node, `${out.event}${src.slice(n.end, member.node.end).replace(/^\s+/, "")}`);
        else put(n, out.event);
      },
      param: (n, c) => put(n, paren(rewrite(c, env, out, todo))),
      guardCall: (call, name) => put(call, inlineGuard(call, name, code.scope, env, out, todo)),
      guardParam: (n, prop, value) => {
        if (prop !== null && value.node.type === "ObjectExpression") {
          for (const p of value.node.properties)
            if (p.type === "Property" && !p.computed && p.key.type === "Identifier" && p.key.name === prop) {
              put(n, paren(rewrite({ node: p.value, scope: value.scope }, env, out, todo)));
              return;
            }
        }
        const whole = paren(rewrite(value, env, out, todo));
        put(n, prop === null ? whole : `${whole}.${prop}`);
      },
    },
    node,
  );
  return apply(src, node.start, node.end, edits);
}

/**
 * `guards.name(a, b)` of a v6 function, inlined: the guard's body with its parameters replaced by
 * the arguments. A guard that isn't a pure function written in this file gets a TODO.
 */
function inlineGuard(
  call: CallExpression,
  name: string,
  scope: Scope,
  env: Env,
  out: Out,
  todo: (at: number, message: string) => void,
): string {
  const args = call.arguments.map((a) =>
    a.type === "SpreadElement" ? "undefined" : rewrite({ node: a, scope }, env, out, todo),
  );
  const def = env.guards.get(name);
  if (def === undefined) {
    todo(call.start, `guard "${name}" isn't in setup's guards here: write its condition in place`);
    return `${name}(${args.join(", ")})`;
  }
  if (def.type === "Identifier") {
    todo(
      call.start,
      `guard "${name}" is ${def.name}, defined elsewhere: inline it, or make sure it is pure (it reads only its arguments)`,
    );
    return `${def.name}(${args.join(", ")})`;
  }
  if (!isFunction(def)) {
    todo(call.start, `guard "${name}" isn't a function written in place: write its condition here`);
    return "false";
  }
  const body = returned(def);
  const params = def.params.map((p) => (p.type === "Identifier" ? p.name : null));
  if (body === null || params.includes(null)) {
    todo(call.start, `guard "${name}" has a body the codemod can't inline: write its condition here`);
    return `false`;
  }
  const map = new Map<string, Code>();
  params.forEach((p, i) => {
    const a = call.arguments[i];
    if (p !== null && a !== undefined && a.type !== "SpreadElement") map.set(p, { node: a, scope });
  });
  for (const problem of impurities(def, env))
    todo(call.start, `guard "${name}" isn't pure (${problem}): a transition reads only its data and the event`);
  return paren(rewrite({ node: body, scope: { ...EMPTY_SCOPE, params: map } }, env, out, todo));
}

const PURE_GLOBALS = new Set([
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "undefined",
  "NaN",
  "Infinity",
  "encodeURIComponent",
  "decodeURIComponent",
]);

/** Why a function isn't pure, as the compiler would see it: what it reads or changes outside itself. */
export function impurities(fn: Fn, env: Env): string[] {
  const out: string[] = [];
  const local = new Set<string>();
  for (const p of fn.params) walk(p, (n) => (n.type === "Identifier" && local.add(n.name), true));
  if (fn.body === null) return out;
  walk(fn.body, (n) => {
    if (n.type === "VariableDeclarator") walk(n.id, (i) => (i.type === "Identifier" && local.add(i.name), true));
    if (isFunction(n)) for (const p of n.params) walk(p, (i) => (i.type === "Identifier" && local.add(i.name), true));
    return true;
  });
  walk(fn.body, (n, parent, key) => {
    if (n.type === "Identifier" && isReference(parent, key)) {
      if (local.has(n.name) || env.constants.has(n.name) || PURE_GLOBALS.has(n.name)) return true;
      if (n.name === "Date") out.push("it reads the clock");
      else if (env.mutable.has(n.name)) out.push(`it reads module-level let ${n.name}`);
      else out.push(`it reads the global ${n.name}`);
    }
    if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === "Math")
      if (n.property.type === "Identifier" && n.property.name === "random") out.push("it calls Math.random");
    if (n.type === "NewExpression") out.push("it constructs an object with new");
    if (n.type === "AssignmentExpression" || n.type === "UpdateExpression") {
      const target = n.type === "AssignmentExpression" ? n.left : n.argument;
      let root: Node = target;
      while (root.type === "MemberExpression") root = root.object;
      if (!(root.type === "Identifier" && local.has(root.name) && target.type === "Identifier"))
        out.push("it changes something outside itself");
    }
    return true;
  });
  return [...new Set(out)];
}

/** What a written value is known to be: null, never null, or either. */
export type Kind = "null" | "value" | "maybe";

export function join(a: Kind | null, b: Kind): Kind {
  if (a === null) return b;
  return a === b ? a : "maybe";
}

const VALUE_METHODS = new Set([
  "toUpperCase",
  "toLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "slice",
  "concat",
  "map",
  "filter",
  "join",
  "toString",
  "toFixed",
  "padStart",
  "padEnd",
  "replace",
  "replaceAll",
  "repeat",
  "split",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "some",
  "every",
  "reduce",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "with",
]);

/** Whether a type, as written, can hold null or undefined. */
export function nullable(field: Field): boolean {
  if (field.optional) return true;
  const node = field.node;
  if (node === null) return /\b(null|undefined|any|unknown)\b/.test(field.type);
  const kinds = node.type === "TSUnionType" ? node.types.map((t) => t.type) : [node.type];
  return kinds.some(
    (k) =>
      k === "TSNullKeyword" ||
      k === "TSUndefinedKeyword" ||
      k === "TSAnyKeyword" ||
      k === "TSUnknownKeyword" ||
      k === "TSTypeReference",
  );
}

/**
 * What a written value is, for each state's types: `null`, never null (a literal, arithmetic, an
 * event field typed without null), or either. `context` reads what the source state holds; null
 * where there is no context yet (the initial context's values).
 */
export function kindOf(
  code: Code,
  context: ((field: string) => Kind) | null,
  eventFields: ReadonlyMap<string, Field> | null,
  node: Node = code.node,
): Kind {
  const s = code.scope;
  switch (node.type) {
    case "Literal":
      return node.value === null ? "null" : "value";
    case "TemplateLiteral":
    case "ObjectExpression":
    case "ArrayExpression":
    case "BinaryExpression":
    case "UnaryExpression":
    case "UpdateExpression":
      return "value";
    case "Identifier": {
      if (node.name === "undefined") return "null";
      const p = s.params.get(node.name);
      return p === undefined ? "maybe" : kindOf(p, context, eventFields);
    }
    case "ConditionalExpression":
      return join(
        kindOf(code, context, eventFields, node.consequent),
        kindOf(code, context, eventFields, node.alternate),
      );
    case "LogicalExpression":
      if (node.operator === "&&") return "maybe";
      return kindOf(code, context, eventFields, node.right) === "value" ? "value" : "maybe";
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return kindOf(code, context, eventFields, node.expression);
    case "CallExpression": {
      const callee = node.callee;
      if (callee.type === "Identifier" && ["String", "Number", "Boolean"].includes(callee.name)) return "value";
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        if (VALUE_METHODS.has(callee.property.name)) return "value";
        if (callee.object.type === "Identifier" && ["Math", "JSON"].includes(callee.object.name)) return "value";
      }
      return "maybe";
    }
    case "MemberExpression": {
      const name = memberName(node);
      const object = node.object;
      if (object.type === "Identifier" && s.ctx.has(object.name) && name !== null) return context?.(name) ?? "maybe";
      if (
        object.type === "MemberExpression" &&
        object.object.type === "Identifier" &&
        s.args.has(object.object.name) &&
        memberName(object) === "context" &&
        name !== null
      )
        return context?.(name) ?? "maybe";
      const isEvent =
        (object.type === "Identifier" && s.event.has(object.name)) ||
        (object.type === "MemberExpression" &&
          object.object.type === "Identifier" &&
          s.args.has(object.object.name) &&
          memberName(object) === "event");
      if (isEvent && name !== null) {
        const f = eventFields?.get(name);
        return f === undefined ? "maybe" : nullable(f) ? "maybe" : "value";
      }
      if (name === "length") return "value";
      return "maybe";
    }
    default:
      return "maybe";
  }
}
