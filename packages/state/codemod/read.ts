// Reads XState machines (v4-style, v5, v6) out of a module: the state tree, every transition in
// its forms, the context and event types, timers and invokes. Whatever it can't read becomes a TODO.

import type {
  CallExpression,
  Expression,
  ImportDeclaration,
  Node,
  ObjectExpression,
  Program,
  TSInterfaceBody,
  TSType,
} from "oxc-parser";

import { boundNames, type Fn, isFunction, isReference, keyName, prop, props, stringValue, walk } from "./ast.ts";
import { member, oneLine } from "./emit.ts";
import { EMPTY_SCOPE, type Env, impurities, reads, readsEvent, returned, scopeOf } from "./expr.ts";
import type {
  ActionDef,
  Arg,
  Branch,
  Code,
  Cond,
  ContextInfo,
  DelayDef,
  Effect,
  EventInfo,
  Field,
  Handler,
  Invoke,
  LogicDef,
  MachineModel,
  Note,
  Scope,
  Site,
  SNode,
  Stub,
  TargetSpec,
  Todo,
  Write,
} from "./model.ts";

/** Whether an import specifier is XState: its last segment, without `.ts`, is `xstate` or `xstate<n>`. */
export function isXState(specifier: string): boolean {
  const last = specifier.split("/").pop() ?? "";
  return /^xstate\d*$/.test(last.replace(/\.[cm]?[jt]s$/, ""));
}

/**
 * What a function whose body writes nothing returns, as text ("undefined" for an empty body), or
 * null when it has code. Stately's exports write each implementation as such a stub.
 */
export function stubValue(fn: Fn): string | null {
  const body = fn.body;
  if (body === null) return "undefined";
  const literal = (e: Node | null): string | null => {
    if (e === null) return "undefined";
    if (e.type === "Literal" && (typeof e.value === "boolean" || typeof e.value === "number" || e.value === null))
      return String(e.value);
    if (e.type === "Identifier" && e.name === "undefined") return "undefined";
    return null;
  };
  if (body.type !== "BlockStatement") return literal(body);
  const [only, ...rest] = body.body;
  if (only === undefined) return "undefined";
  return rest.length === 0 && only.type === "ReturnStatement" ? literal(only.argument) : null;
}

/**
 * A type guessed from a value written in place (a context's initial value, a guard's params):
 * `string`, `number`, `boolean`, arrays and objects of those, and where the value doesn't say
 * more, what it is: `null`, `null[]` (an empty array: a list that holds nothing until its element
 * type is written; `never[]` would be a type error, M423). Each is JSON, as data must be. null when
 * it isn't a value written in place.
 */
export function guessType(v: Node): string | null {
  if (v.type === "Literal")
    return typeof v.value === "string"
      ? "string"
      : typeof v.value === "number"
        ? "number"
        : typeof v.value === "boolean"
          ? "boolean"
          : v.value === null
            ? "null"
            : null;
  if (v.type === "TemplateLiteral") return "string";
  if (v.type === "UnaryExpression" && v.operator === "-" && v.argument.type === "Literal") return "number";
  if (v.type === "ArrayExpression") {
    const items = [...new Set(v.elements.map((e) => (e === null || e.type === "SpreadElement" ? null : guessType(e))))];
    if (items.includes(null)) return null;
    if (items.length === 0) return "null[]";
    return items.length === 1 ? `${items[0] ?? ""}[]` : `(${items.join(" | ")})[]`;
  }
  if (v.type === "ObjectExpression") {
    const parts: string[] = [];
    for (const p of v.properties) {
      if (p.type === "SpreadElement") return null;
      const k = keyName(p);
      const t = guessType(p.value);
      if (k === null || t === null) return null;
      parts.push(`${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${t}`);
    }
    return parts.length === 0 ? "{}" : `{ ${parts.join("; ")} }`;
  }
  return null;
}

/** What a module holds, as the reader needs it. */
export interface Module {
  readonly env: Env;
  /** XState's imports: local name to imported name. */
  readonly xstate: Map<string, string>;
  readonly imports: ImportDeclaration[];
  /** Module-level `const` initializers. */
  readonly inits: Map<string, { readonly init: Expression; readonly statement: Node }>;
  /** Type aliases and interfaces, for context and event types. */
  readonly types: Map<string, TSType | TSInterfaceBody>;
  readonly program: Program;
}

export function readModule(source: string, program: Program): Module {
  const xstate = new Map<string, string>();
  const imports: ImportDeclaration[] = [];
  const constants = new Set<string>();
  const mutable = new Set<string>();
  const inits = new Map<string, { init: Expression; statement: Node }>();
  const types = new Map<string, TSType | TSInterfaceBody>();
  for (const top of program.body) {
    const statement =
      (top.type === "ExportNamedDeclaration" || top.type === "ExportDefaultDeclaration") &&
      top.declaration !== null &&
      top.declaration !== undefined
        ? top.declaration
        : top;
    if (statement.type === "ImportDeclaration") {
      for (const s of statement.specifiers) constants.add(s.local.name);
      if (isXState(statement.source.value)) {
        imports.push(statement);
        for (const s of statement.specifiers)
          if (s.type === "ImportSpecifier")
            xstate.set(s.local.name, s.imported.type === "Identifier" ? s.imported.name : s.imported.value);
      }
    } else if (statement.type === "VariableDeclaration") {
      for (const d of statement.declarations) {
        for (const n of boundNames(d.id)) (statement.kind === "const" ? constants : mutable).add(n);
        if (statement.kind === "const" && d.id.type === "Identifier" && d.init !== null)
          inits.set(d.id.name, { init: d.init, statement: top });
      }
    } else if (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id !== null
    )
      constants.add(statement.id.name);
    else if (statement.type === "TSTypeAliasDeclaration") types.set(statement.id.name, statement.typeAnnotation);
    else if (statement.type === "TSInterfaceDeclaration") types.set(statement.id.name, statement.body);
  }
  return {
    env: { source, guards: new Map(), constants, mutable },
    xstate,
    imports,
    inits,
    types,
    program,
  };
}

/** A machine call: `createMachine(config, options?)` or `setup(s).createMachine(config)`. */
export interface MachineCall {
  readonly call: CallExpression;
  readonly name: string;
  readonly exported: boolean;
  readonly statement: Node;
  readonly config: ObjectExpression;
  readonly setup: ObjectExpression | null;
  readonly setupStatement: Node | null;
  readonly options: ObjectExpression | null;
}

/** The machines a module declares at its top level. */
export function findMachines(mod: Module, todos: Todo[]): MachineCall[] {
  const out: MachineCall[] = [];
  const is = (local: string, imported: string): boolean => mod.xstate.get(local) === imported;
  const setupOf = (node: Node): { setup: ObjectExpression | null; statement: Node | null } | null => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && is(node.callee.name, "setup")) {
      const arg = node.arguments[0];
      return { setup: arg?.type === "ObjectExpression" ? arg : null, statement: null };
    }
    if (node.type === "Identifier") {
      const def = mod.inits.get(node.name);
      if (def !== undefined && def.init.type === "CallExpression") {
        const inner = setupOf(def.init);
        if (inner !== null) return { setup: inner.setup, statement: def.statement };
      }
    }
    return null;
  };
  const machineCall = (
    node: Node,
  ): {
    config: Node | undefined;
    setup: ObjectExpression | null;
    setupStatement: Node | null;
    options: Node | undefined;
  } | null => {
    if (node.type !== "CallExpression") return null;
    const callee = node.callee;
    if (callee.type === "Identifier" && is(callee.name, "createMachine"))
      return {
        config: node.arguments[0],
        setup: null,
        setupStatement: null,
        options: node.arguments[1],
      };
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "createMachine"
    ) {
      const s = setupOf(callee.object);
      if (s !== null)
        return { config: node.arguments[0], setup: s.setup, setupStatement: s.statement, options: undefined };
    }
    return null;
  };
  const seen = new Set<Node>();
  for (const top of mod.program.body) {
    const exported = top.type === "ExportNamedDeclaration";
    const statement = exported && top.declaration !== null ? top.declaration : top;
    if (statement.type !== "VariableDeclaration") continue;
    for (const d of statement.declarations) {
      if (d.init === null) continue;
      const m = machineCall(d.init);
      if (m === null || d.init.type !== "CallExpression") continue;
      seen.add(d.init);
      if (d.id.type !== "Identifier" || statement.declarations.length !== 1) {
        todos.push({ at: d.start, message: "declare each machine as its own `const name = createMachine(...)`" });
        continue;
      }
      if (m.config?.type !== "ObjectExpression") {
        todos.push({ at: d.init.start, message: "the machine's config isn't an object literal written in place" });
        continue;
      }
      out.push({
        call: d.init,
        name: d.id.name,
        exported,
        statement: top,
        config: m.config,
        setup: m.setup,
        setupStatement: m.setupStatement,
        options: m.options?.type === "ObjectExpression" ? m.options : null,
      });
    }
  }
  walk(mod.program, (node) => {
    // An empty machine is Stately's stub actor (`createMachine({ /* ... */ })`): it is read with
    // the invoke that names it.
    const empty =
      node.type === "CallExpression" &&
      node.arguments[0]?.type === "ObjectExpression" &&
      node.arguments[0].properties.length === 0;
    if (node.type === "CallExpression" && !seen.has(node) && !empty && machineCall(node) !== null) {
      todos.push({
        at: node.start,
        message: "a machine that isn't a module-level const: move it to `const name = ...`",
      });
      return false;
    }
    return true;
  });
  return out;
}

/** Reads one machine. */
export function readMachine(mod: Module, m: MachineCall): MachineModel {
  const src = (n: Node): string => mod.env.source.slice(n.start, n.end);
  const todos: Todo[] = [];
  const todo = (at: Node | number, message: string): void => {
    todos.push({ at: typeof at === "number" ? at : at.start, message });
  };
  const config = m.config;
  const cfg = props(config);
  const setup = m.setup === null ? new Map() : props(m.setup);
  const options = m.options === null ? new Map() : props(m.options);

  const notes: Note[] = [];
  const note = (at: Node | number, message: string): void => {
    notes.push({ at: typeof at === "number" ? at : at.start, message });
  };

  // v4: `cond`, positional arguments, `createMachine<Context, Event>`, and what Stately's v4 export
  // writes (`predictableActionArguments`, `tsTypes`, `schema`, options' `services`). v5's
  // `createMachine(config, implementations)` also has a second argument, so that alone isn't v4.
  let v4 =
    (m.call.typeArguments?.params.length ?? 0) > 0 ||
    ["predictableActionArguments", "preserveActionOrder", "tsTypes", "schema"].some((k) => cfg.has(k)) ||
    options.has("services");
  walk(config, (n) => {
    if (n.type === "Property" && keyName(n) === "cond") v4 = true;
    return true;
  });
  const positional = (fn: Fn): boolean => {
    const first = fn.params[0];
    if (first?.type === "ObjectPattern") return false;
    return v4 || fn.params.length >= 2 || (first?.type === "Identifier" && /^(ctx|context|c)$/.test(first.name));
  };

  // What Stately's exports carry for the editor and for v4's typegen: dropped, and said so.
  const layout = /@xstate-layout\b/.exec(mod.env.source.slice(config.start, config.end));
  if (layout !== null)
    note(
      config.start + layout.index,
      "the @xstate-layout comment is dropped: it is Stately's diagram layout, and @reactre/state has no visual editor",
    );
  for (const [k, why] of [
    ["tsTypes", "it names v4's generated types, and setup's states and events type the machine now"],
    ["predictableActionArguments", "it is v4's switch to run actions in order, and effects here always run in order"],
    ["preserveActionOrder", "it is v4's switch to run actions in order, and effects here always run in order"],
  ] as const) {
    const p = cfg.get(k);
    if (p !== undefined) note(p, `${k} is dropped: ${why}`);
  }

  // #region Named implementations

  const named = (
    key: string,
    ...sources: readonly ReadonlyMap<string, { value: Expression }>[]
  ): Map<string, Expression> => {
    const out = new Map<string, Expression>();
    for (const s of sources) {
      const value = s.get(key)?.value;
      if (value?.type === "ObjectExpression") for (const [k, p] of props(value)) out.set(k, p.value);
    }
    return out;
  };
  const guards = named("guards", setup, cfg, options);
  const actions = named("actions", setup, cfg, options);
  const actors = named("actors", setup, cfg, options);
  for (const [k, v] of named("services", options)) actors.set(k, v);
  const delays = named("delays", setup, cfg, options);
  const env: Env = { ...mod.env, guards };

  // Stubs: implementations the source names without writing them (Stately's exports write each
  // one as a function with an empty body; its JSON export names them only). The output declares
  // each as a function for the user to write, which keeps the source's behaviour until then.
  const stubs = new Map<string, Stub>();
  const reserved = new Set([
    ...mod.env.constants,
    ...mod.env.mutable,
    "data",
    "event",
    "state",
    "to",
    "keep",
    "back",
    "error",
    "output",
    "input",
    "signal",
    "setup",
    "types",
  ]);
  const stubName = (source: string): string => {
    const words = source.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
    let name = words.map((w, i) => (i === 0 ? w : `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`)).join("");
    if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
    while (reserved.has(name)) name = `${name}_`;
    reserved.add(name);
    return name;
  };
  const guardStub = (source: string, def: Expression | undefined, params: Code | null, at: Node): Cond => {
    let stub = stubs.get(source);
    if (stub === undefined) {
      const name = stubName(source);
      const value = def !== undefined && isFunction(def) ? (stubValue(def) ?? "false") : "false";
      const result = value === "true" || value === "false" ? value : "false";
      const param =
        params === null
          ? ""
          : `_params: ${params.node.type === "ObjectExpression" ? (guessType(params.node) ?? "unknown") : "unknown"}`;
      const why =
        def === undefined
          ? `guard "${source}" isn't written in this file`
          : `guard "${source}" is a stub in the export`;
      stub = {
        kind: "guard",
        source,
        name,
        text: `function ${name}(${param}): boolean {\nreturn ${result};\n}`,
        todo: {
          at: (def ?? at).start,
          message: `${why}: write its condition in ${name}, and pass it the fields of data and the event it reads. Until then it is ${result}${def === undefined ? "" : ", as in the export"}`,
        },
      };
      stubs.set(source, stub);
    }
    return { kind: "stub", name: stub.name, params };
  };
  /** A task stub for an actor: it finishes at once with no output, or never (as the source's did). */
  const taskStub = (
    source: string,
    def: Expression | undefined,
    settles: boolean,
    output: string | null,
    at: Node,
  ): Stub => {
    let stub = stubs.get(source);
    if (stub === undefined) {
      const name = stubName(source);
      // Its output is part of an internal event, so it is JSON: null until the task is written.
      const type = `Promise<${settles ? "null" : (output ?? "null")}>`;
      const head = `(_: { input?: unknown; signal: AbortSignal }): ${type}`;
      const why =
        def === undefined
          ? `actor "${source}" isn't written in this file`
          : `actor "${source}" is a stub in the export`;
      stub = {
        kind: "task",
        source,
        name,
        text: settles
          ? `async function ${name}${head} {\nreturn null;\n}`
          : `function ${name}${head} {\nreturn new Promise(() => {});\n}`,
        todo: {
          at: (def ?? at).start,
          message: `${why}: write the task in ${name} (it gets the invoke's input and an abort signal). Until then it ${settles ? "finishes at once (its output is null)" : "never finishes"}${def === undefined ? "" : ", as in the export"}`,
        },
      };
      stubs.set(source, stub);
    }
    return stub;
  };
  /** Whether an actor's implementation is a stub, and whether it finishes. */
  const actorStub = (def: Expression): { readonly settles: boolean } | null => {
    if (isFunction(def)) return stubValue(def) === null ? null : { settles: def.async };
    if (def.type !== "CallExpression") return null;
    const callee = def.callee;
    const f = callee.type === "Identifier" ? mod.xstate.get(callee.name) : undefined;
    const arg = def.arguments[0];
    // `createMachine({ /* ... */ })`: an empty machine, which never finishes.
    if (f === "createMachine")
      return arg?.type === "ObjectExpression" && arg.properties.length === 0 ? { settles: false } : null;
    if (arg === undefined || arg.type === "SpreadElement" || !isFunction(arg) || stubValue(arg) === null) return null;
    if (f === "fromPromise") return { settles: true };
    if (f === "fromCallback" || f === "fromObservable" || f === "fromEventObservable") return { settles: false };
    return null;
  };
  // v4's `schema.services`: each service's output type, `{ name: { data: T } }`.
  const serviceOutputs = new Map<string, string>();

  // #endregion

  // #region Types: context, events, input

  const typeFields = (node: TSType | TSInterfaceBody | null | undefined, depth = 0): Map<string, Field> | null => {
    if (node === null || node === undefined || depth > 5) return null;
    if (node.type === "TSTypeLiteral" || node.type === "TSInterfaceBody") {
      const out = new Map<string, Field>();
      for (const member of node.type === "TSTypeLiteral" ? node.members : node.body) {
        if (member.type !== "TSPropertySignature") return null;
        const name = keyName(member);
        const t = member.typeAnnotation?.typeAnnotation ?? null;
        if (name === null) return null;
        out.set(name, { name, type: t === null ? "unknown" : src(t), node: t, optional: member.optional });
      }
      return out;
    }
    if (node.type === "TSTypeReference" && node.typeName.type === "Identifier")
      return typeFields(mod.types.get(node.typeName.name), depth + 1);
    if (node.type === "TSIntersectionType") {
      const out = new Map<string, Field>();
      for (const t of node.types) {
        const f = typeFields(t, depth + 1);
        if (f === null) return null;
        for (const [k, v] of f) out.set(k, v);
      }
      return out;
    }
    return null;
  };
  const members = (node: TSType | TSInterfaceBody | null | undefined, depth = 0): (TSType | TSInterfaceBody)[] => {
    if (node === null || node === undefined || depth > 5) return [];
    if (node.type === "TSUnionType") return node.types.flatMap((t) => members(t, depth + 1));
    if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
      const t = mod.types.get(node.typeName.name);
      return t === undefined ? [node] : members(t, depth + 1);
    }
    return [node];
  };
  /** `types<T>()`'s T. */
  const typesArg = (value: Expression | undefined): TSType | null => {
    if (value?.type !== "CallExpression" || value.callee.type !== "Identifier") return null;
    if (mod.xstate.get(value.callee.name) !== "types") return null;
    return value.typeArguments?.params[0] ?? null;
  };
  const fieldsText = (fields: ReadonlyMap<string, Field>): string =>
    fields.size === 0
      ? "{}"
      : `{ ${[...fields.values()].map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`).join("; ")} }`;

  // v5's `types: {} as { context, events, input }`, or each one cast on its own as Stately's v5
  // export writes them (`types: { context: {} as C, events: {} as E }`), from setup or the config;
  // v4's `schema: { context: {} as C, events: {} as E, services: {} as S }` alike.
  let v5Types: Map<string, Field> | null = null;
  for (const [holder, k] of [
    [setup, "types"],
    [cfg, "types"],
    [cfg, "schema"],
  ] as const) {
    const t = holder.get(k)?.value;
    if (t === undefined) continue;
    if (t.type === "TSAsExpression" || t.type === "TSSatisfiesExpression") v5Types = typeFields(t.typeAnnotation);
    else if (t.type === "ObjectExpression") {
      const each = new Map<string, Field>();
      for (const [name, p] of props(t)) {
        const v = p.value;
        if (
          (v.type === "TSAsExpression" || v.type === "TSSatisfiesExpression") &&
          v.expression.type === "ObjectExpression"
        )
          each.set(name, { name, type: src(v.typeAnnotation), node: v.typeAnnotation, optional: false });
        else todo(p, `${k}.${name} isn't \`{} as Type\`: write its type in setup by hand`);
      }
      v5Types = each;
    }
    if (v5Types === null)
      todo(
        t,
        `${k} isn't \`{} as { context, events }\` with a type written in this file: write setup's states and events by hand`,
      );
  }
  const schemas = new Map<string, Expression>();
  for (const holder of [setup, cfg]) {
    const s = holder.get("schemas")?.value;
    if (s?.type === "ObjectExpression") for (const [k, p] of props(s)) schemas.set(k, p.value);
  }
  const typeArgs = m.call.typeArguments?.params ?? [];

  // The context.
  let contextFields: Map<string, Field> | null = null;
  let whole: string | null = null;
  let schema = false;
  const ctxSchema = schemas.get("context");
  const ctxType = v5Types?.get("context")?.node ?? typeArgs[0] ?? null;
  if (ctxSchema !== undefined) {
    const t = typesArg(ctxSchema);
    if (t !== null) {
      contextFields = typeFields(t);
      whole = src(t);
    } else {
      whole = src(ctxSchema);
      schema = true;
    }
  } else if (ctxType !== null) {
    contextFields = typeFields(ctxType);
    whole = src(ctxType);
  }
  const contextValue = cfg.get("context")?.value;
  let initial: ObjectExpression | null = null;
  let initialScope: Scope | null = null;
  let inputName: string | null = null;
  if (contextValue?.type === "ObjectExpression") {
    initial = contextValue;
    initialScope = EMPTY_SCOPE;
  } else if (contextValue !== undefined && isFunction(contextValue)) {
    const body = returned(contextValue);
    const param = contextValue.params[0];
    if (body?.type === "ObjectExpression") {
      initial = body;
      initialScope = EMPTY_SCOPE;
      if (param?.type === "ObjectPattern")
        for (const p of param.properties)
          if (p.type === "Property" && keyName(p) === "input" && p.value.type === "Identifier")
            inputName = p.value.name;
      if (param !== undefined && param.type !== "ObjectPattern")
        todo(param, "destructure the context function's argument (`({ input })`): start reads `input` from it");
    } else todo(contextValue, "the context function doesn't return an object literal: write start's data by hand");
  } else if (contextValue !== undefined)
    todo(contextValue, "the context isn't an object literal: write start's data by hand");
  if (contextFields === null && whole === null && initial !== null) {
    // No type (an untyped source, or Stately's JSON export): each field's type is guessed from its
    // initial value, and the report lists each guess.
    contextFields = new Map();
    for (const [name, p] of props(initial)) {
      const type = guessType(p.value);
      if (type === null) todo(p, `context field ${name} has no type: write it in setup's states`);
      else if (/\bnull\b|\bnever\b/.test(type))
        todo(
          p,
          `context field ${name} has no type, and its initial value doesn't say (${src(p.value)}): it is ${type} until you write its type in setup's states`,
        );
      else note(p, `context field ${name} has no type: guessed ${type} from its initial value`);
      contextFields.set(name, { name, type: type ?? "unknown", node: null, optional: false });
    }
    whole = fieldsText(contextFields);
  }
  if (contextFields === null && whole === null && contextValue === undefined) {
    // No context: each state's data is empty.
    contextFields = new Map();
    whole = "{}";
  }
  const context: ContextInfo = { fields: contextFields, whole, schema, initial, initialScope, inputName };

  // Events.
  const events = new Map<string, EventInfo>();
  const eventSchemas = schemas.get("events");
  const eventType = v5Types?.get("events")?.node ?? typeArgs[1] ?? null;
  if (eventSchemas?.type === "ObjectExpression") {
    for (const [name, p] of props(eventSchemas)) {
      const t = typesArg(p.value);
      events.set(name, {
        name,
        value: t === null ? src(p.value) : `types<${src(t)}>()`,
        fields: t === null ? null : typeFields(t),
      });
    }
  } else if (eventType !== null) {
    for (const member of members(eventType)) {
      const fields = typeFields(member);
      const type = fields?.get("type")?.node;
      const name =
        type?.type === "TSLiteralType" && type.literal.type === "Literal" && typeof type.literal.value === "string"
          ? type.literal.value
          : null;
      if (fields === null || name === null) {
        todo(member, "an event type the codemod can't read: write it in setup's events");
        continue;
      }
      fields.delete("type");
      events.set(name, { name, value: `types<${fieldsText(fields)}>()`, fields });
    }
  }
  for (const [name, f] of typeFields(v5Types?.get("services")?.node) ?? []) {
    const data = typeFields(f.node)?.get("data");
    if (data !== undefined) serviceOutputs.set(name, data.type);
  }
  let input: string | null = null;
  const inputSchema = schemas.get("input");
  const inputType = v5Types?.get("input")?.node;
  if (inputSchema !== undefined)
    input = typesArg(inputSchema) === null ? src(inputSchema) : `types<${src(typesArg(inputSchema) ?? inputSchema)}>()`;
  else if (inputType !== undefined && inputType !== null) input = `types<${src(inputType)}>()`;

  // #endregion

  // #region States

  const logic = new Map<string, LogicDef>();

  const target = (value: Node | undefined): TargetSpec | null | "bad" => {
    if (value === undefined) return null;
    const s = stringValue(value);
    if (s !== null) return { refs: [s], at: value.start };
    if (value.type === "ArrayExpression") {
      const refs = value.elements.map((e) => stringValue(e));
      if (refs.every((r): r is string => r !== null)) return { refs, at: value.start };
    }
    if (value.type === "Identifier" && value.name === "undefined") return null;
    return "bad";
  };

  /** A guard as a condition. */
  const cond = (value: Expression, at: Node): Cond => {
    if (isFunction(value)) {
      const body = returned(value);
      if (body === null)
        return { kind: "todo", at: value.start, text: "a guard with a block body: write it as one expression" };
      return { kind: "code", code: { node: body, scope: scopeOf(value, positional(value)) } };
    }
    const name = stringValue(value);
    if (name !== null) return namedGuard(name, null, value);
    if (value.type === "ObjectExpression") {
      const type = stringValue(prop(value, "type"));
      const params = prop(value, "params");
      if (type !== null)
        return namedGuard(type, params === undefined ? null : { node: params, scope: EMPTY_SCOPE }, value);
    }
    if (value.type === "CallExpression" && value.callee.type === "Identifier") {
      const f = mod.xstate.get(value.callee.name);
      const items = value.arguments[0];
      if ((f === "and" || f === "or") && items?.type === "ArrayExpression")
        return {
          kind: f,
          items: items.elements.flatMap((e) => (e === null || e.type === "SpreadElement" ? [] : [cond(e, e)])),
        };
      if (f === "not" && items !== undefined && items.type !== "SpreadElement")
        return { kind: "not", item: cond(items, items) };
      if (f === "stateIn")
        return {
          kind: "todo",
          at: value.start,
          text: "stateIn: decide by the state the event is in, or keep the fact in data",
        };
    }
    void at;
    return { kind: "todo", at: value.start, text: `a guard the codemod can't read: ${src(value)}` };
  };
  const namedGuard = (name: string, params: Code | null, at: Node): Cond => {
    const def = guards.get(name);
    if (def === undefined || (isFunction(def) && stubValue(def) !== null)) return guardStub(name, def, params, at);
    if (isFunction(def)) {
      const body = returned(def);
      if (body === null)
        return {
          kind: "todo",
          at: at.start,
          text: `guard "${name}" has a block body: write it as one expression here`,
        };
      const problems = impurities(def, env);
      // A guard that reads nothing of the machine's, but isn't pure (it reads the clock): setup's
      // guard (`provide`), called in the handler, where a test can replace it.
      if (problems.length > 0 && def.params.length === 0) {
        if (!guardDefs.has(name)) {
          guardDefs.set(name, { name, text: src(def), todo: null });
          note(
            def,
            `guard "${name}" isn't pure (${problems.join("; ")}): it is setup's guard, called in the handler, so a test can replace it with provide`,
          );
        }
        uses.add("provide");
        return { kind: "named", name };
      }
      if (problems.length > 0)
        todo(
          at,
          `guard "${name}" isn't pure (${problems.join("; ")}): a transition reads only its data and the event. Put the value in the event`,
        );
      return { kind: "code", code: { node: body, scope: scopeOf(def, positional(def), params) } };
    }
    return {
      kind: "todo",
      at: at.start,
      text: `guard "${name}" is ${src(def)}, defined elsewhere: write its condition here, and keep it pure`,
    };
  };

  /**
   * The writes of an assigner: `assign({ f: v | fn })` or `assign(fn returning { f })`. Each sees
   * the `seen` writes before the assign, not the others of the same assign.
   */
  const assignWrites = (arg: Expression | undefined, seen: number): Write[] | "opaque" => {
    if (arg === undefined) return [];
    if (arg.type === "ObjectExpression") {
      const out: Write[] = [];
      for (const p of arg.properties) {
        if (p.type === "SpreadElement") return "opaque";
        const field = keyName(p);
        if (field === null) return "opaque";
        if (isFunction(p.value)) {
          const body = returned(p.value);
          if (body === null) {
            todo(p.value, `the assigner of ${field} has a block body: write it as one expression`);
            return "opaque";
          }
          out.push({ field, code: { node: body, scope: scopeOf(p.value, positional(p.value)) }, seen });
        } else out.push({ field, code: { node: p.value, scope: EMPTY_SCOPE }, seen });
      }
      return out;
    }
    if (isFunction(arg)) {
      const body = returned(arg);
      // An assigner that returns something built elsewhere: the step that uses it says to write
      // the data by hand.
      if (body?.type !== "ObjectExpression") return "opaque";
      return patch(body, scopeOf(arg, positional(arg)), seen);
    }
    return "opaque";
  };
  /** A context patch `{ f: v, ...context }`: its writes, each seeing the `seen` writes before it. */
  const patch = (object: ObjectExpression, scope: Scope, seen: number): Write[] | "opaque" => {
    const out: Write[] = [];
    for (const p of object.properties) {
      if (p.type === "SpreadElement") {
        const a = p.argument;
        const isContext =
          (a.type === "Identifier" && scope.ctx.has(a.name)) ||
          (a.type === "MemberExpression" &&
            a.object.type === "Identifier" &&
            scope.args.has(a.object.name) &&
            !a.computed &&
            a.property.type === "Identifier" &&
            a.property.name === "context");
        if (isContext) continue;
        return "opaque";
      }
      const field = keyName(p);
      if (field === null) return "opaque";
      out.push({ field, code: { node: p.value, scope }, seen });
    }
    return out;
  };

  // #region Effects

  /** Setup's named actions and guards (`provide`), delays (`delays`), emitted events (`emit`). */
  const actionDefs = new Map<string, ActionDef>();
  const guardDefs = new Map<string, ActionDef>();
  const delayDefs = new Map<string, DelayDef>();
  const emitted = new Map<string, string>();
  /** Machines a handler spawns, by the name setup's children gives them; and each spawn id's name. */
  const spawned = new Map<string, string>();
  const spawnIds = new Map<string, string>();
  const uses = new Set<string>();
  const imports = new Map<string, Set<string>>();
  const importFrom = (feature: string, name: string): void => {
    const set = imports.get(feature) ?? new Set<string>();
    set.add(name);
    imports.set(feature, set);
  };
  /** The event the handler being read handles, for an emitted event's field types. */
  let currentEvent: string | null = null;

  /** A value or a function of `{ context, event }` returning it, as code; null for a block body. */
  const codeOf = (e: Expression, scope: Scope = EMPTY_SCOPE): Code | null => {
    if (isFunction(e)) {
      const body = returned(e);
      return body === null ? null : { node: body, scope: scopeOf(e, positional(e)) };
    }
    return { node: e, scope };
  };
  /** The machine a name or reference in `actors` stands for: its module-level const, or null. */
  const machineConst = (value: Expression | undefined): string | null => {
    if (value?.type !== "Identifier") return null;
    const init = mod.inits.get(value.name)?.init;
    if (init?.type !== "CallExpression") return null;
    const callee = init.callee;
    const isMachine =
      (callee.type === "Identifier" && mod.xstate.get(callee.name) === "createMachine") ||
      (callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "createMachine");
    return isMachine ? value.name : null;
  };
  // Each spawn id's child, known before the actions that stop it are read.
  walk(config, (n) => {
    if (n.type !== "CallExpression") return true;
    const callee = n.callee;
    const f =
      callee.type === "Identifier"
        ? mod.xstate.get(callee.name)
        : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
          ? callee.property.name
          : undefined;
    if (f !== "spawnChild") return true;
    const [srcArg, opts] = n.arguments;
    const name = stringValue(srcArg) ?? (srcArg?.type === "Identifier" ? srcArg.name : null);
    const id = opts?.type === "ObjectExpression" ? stringValue(prop(opts, "id")) : null;
    if (name !== null && id !== null) spawnIds.set(id, name);
    return true;
  });

  /** `{ delay, id }` of raise and sendTo, as text; null (with a TODO) when it can't be read. */
  const later = (opts: Expression | undefined, todos2: Todo[]): string | null => {
    if (opts === undefined) return "";
    if (opts.type !== "ObjectExpression") {
      todos2.push({ at: opts.start, message: `options ${src(opts)} that aren't an object written in place` });
      return null;
    }
    const parts: string[] = [];
    for (const [k, p] of props(opts)) {
      const v = p.value;
      if (k === "id" && stringValue(v) !== null) parts.push(`id: ${JSON.stringify(stringValue(v))}`);
      else if (k === "delay" && v.type === "Literal" && typeof v.value === "number") parts.push(`delay: ${v.value}`);
      else if (k === "delay" && stringValue(v) !== null) {
        const d = delays.get(stringValue(v) ?? "");
        const ms = d?.type === "Literal" && typeof d.value === "number" ? d.value : null;
        if (ms === null) {
          todos2.push({
            at: v.start,
            message: `the delay "${stringValue(v)}" isn't a number written in setup's delays: write it in milliseconds`,
          });
          return null;
        }
        parts.push(`delay: ${ms}`);
      } else {
        todos2.push({ at: p.start, message: `the option ${k}: ${src(v)} isn't converted` });
        return null;
      }
    }
    return parts.length === 0 ? "" : `{ ${parts.join(", ")} }`;
  };

  /** An emitted event's payload type, from its object literal: guessed, or a field's or the event's type. */
  const emittedType = (object: ObjectExpression, scope: Scope, todos2: Todo[]): string | null => {
    const parts: string[] = [];
    for (const p of object.properties) {
      const k = p.type === "Property" ? keyName(p) : null;
      if (p.type !== "Property" || k === null) return null;
      if (k === "type") continue;
      const v = p.value;
      let t = guessType(v);
      if (t === null && v.type === "MemberExpression" && !v.computed && v.property.type === "Identifier") {
        const field = v.property.name;
        const obj = v.object;
        const isCtx =
          (obj.type === "Identifier" && scope.ctx.has(obj.name)) ||
          (obj.type === "MemberExpression" &&
            obj.object.type === "Identifier" &&
            scope.args.has(obj.object.name) &&
            stringValue(obj.property) === null &&
            obj.property.type === "Identifier" &&
            obj.property.name === "context");
        const isEvent =
          (obj.type === "Identifier" && scope.event.has(obj.name)) ||
          (obj.type === "MemberExpression" &&
            obj.object.type === "Identifier" &&
            scope.args.has(obj.object.name) &&
            obj.property.type === "Identifier" &&
            obj.property.name === "event");
        if (isCtx) t = contextFields?.get(field)?.type ?? null;
        else if (isEvent && currentEvent !== null) t = events.get(currentEvent)?.fields?.get(field)?.type ?? null;
      }
      if (t === null) {
        todos2.push({
          at: v.start,
          message: `the emitted field ${k} has no type the codemod can tell: write it in setup's emitted`,
        });
        t = "null";
      }
      parts.push(`${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${t}`);
    }
    return `types<${parts.length === 0 ? "{}" : `{ ${parts.join("; ")} }`}>()`;
  };

  /** One of XState's action creators, called with `args`: its effect, or a TODO. */
  const builtin = (
    f: string,
    args: readonly Node[],
    at: Node,
    writes: Write[],
    fx: Effect[],
    todos2: Todo[],
    scope: Scope,
  ): boolean => {
    const seen = writes.length;
    const push = (method: string | null, list: Arg[]): void => {
      uses.add("effects");
      fx.push({ kind: "enq", at: at.start, method, args: list, seen });
    };
    const fail = (message: string): boolean => {
      todos2.push({ at: at.start, message });
      return true;
    };
    if (args.some((a) => a.type === "SpreadElement")) return fail(`${f}(...) with a spread argument isn't converted`);
    const [a0, a1, a2] = args as readonly (Expression | undefined)[];
    const event = (e: Expression | undefined): Code | null => (e === undefined ? null : codeOf(e, scope));
    switch (f) {
      case "assign": {
        const w = assignWrites(a0, seen);
        if (w === "opaque") return false;
        writes.push(...w);
        return true;
      }
      case "raise": {
        const ev = event(a0);
        const opts = later(a1, todos2);
        if (ev === null) return fail("raise with an event built in a block: return the event as one expression");
        if (opts === null) return true;
        push("raise", [{ kind: "code", code: ev }, ...(opts === "" ? [] : [{ kind: "text" as const, text: opts }])]);
        return true;
      }
      case "sendTo": {
        const to = stringValue(a0);
        const ref = a0?.type === "Identifier" && mod.env.constants.has(a0.name) ? a0.name : null;
        if (to === null && ref === null)
          return fail(
            `sendTo ${a0 === undefined ? "" : src(a0)}: send to a child by its name, or to an actor written at the module's top level`,
          );
        const ev = event(a1);
        const opts = later(a2, todos2);
        if (ev === null) return fail("sendTo with an event built in a block: return the event as one expression");
        if (opts === null) return true;
        push("sendTo", [
          { kind: "text", text: to === null ? (ref ?? "") : JSON.stringify(to) },
          { kind: "code", code: ev },
          ...(opts === "" ? [] : [{ kind: "text" as const, text: opts }]),
        ]);
        return true;
      }
      case "log": {
        if (a0 === undefined)
          return fail("log() logs XState's whole context and event: log the fields you need, enq.log(data.x)");
        const value = event(a0);
        if (value === null) return fail("log with a value built in a block: return it as one expression");
        const label = a1 === undefined ? null : stringValue(a1);
        if (a1 !== undefined && label === null) return fail(`log's label ${src(a1)} isn't a string written in place`);
        push("log", [
          ...(label === null ? [] : [{ kind: "text" as const, text: JSON.stringify(label) }]),
          { kind: "code", code: value },
        ]);
        return true;
      }
      case "emit": {
        const ev = event(a0);
        if (ev === null || a0 === undefined)
          return fail("emit with an event built in a block: return it as one expression");
        const object = ev.node.type === "ObjectExpression" ? ev.node : null;
        const type = object === null ? null : stringValue(prop(object, "type"));
        if (object === null || type === null)
          return fail(`emit ${src(a0)}: write the event as an object with its type written in place`);
        if (!emitted.has(type)) {
          const t = emittedType(object, ev.scope, todos2);
          if (t === null) return fail(`emit ${src(a0)}: write the event as an object with its fields written in place`);
          emitted.set(type, t);
        }
        uses.add("emit");
        push("emit", [{ kind: "code", code: ev }]);
        return true;
      }
      case "cancel": {
        const id = stringValue(a0);
        if (id === null) return fail(`cancel ${a0 === undefined ? "" : src(a0)}: cancel by an id written in place`);
        push("cancel", [{ kind: "text", text: JSON.stringify(id) }]);
        return true;
      }
      case "spawnChild": {
        const name = stringValue(a0) ?? (a0?.type === "Identifier" ? a0.name : null);
        const machine =
          name === null ? null : stringValue(a0) === null ? machineConst(a0) : machineConst(actors.get(name));
        if (name === null || machine === null)
          return fail(
            `spawnChild ${a0 === undefined ? "" : src(a0)}: only a machine declared at the module's top level is spawned here`,
          );
        const entries: (readonly [string, Arg])[] = [];
        if (a1 !== undefined) {
          if (a1.type !== "ObjectExpression")
            return fail(`spawnChild's options ${src(a1)} aren't an object written in place`);
          for (const [k, p] of props(a1)) {
            if (k === "id" && stringValue(p.value) !== null)
              entries.push(["key", { kind: "text", text: JSON.stringify(stringValue(p.value)) }]);
            else if (k === "input") {
              const input = codeOf(p.value, scope);
              if (input === null) return fail("spawnChild's input is built in a block: return it as one expression");
              entries.push(["input", { kind: "code", code: input }]);
            } else return fail(`spawnChild's ${k} isn't converted`);
          }
        }
        const declared = spawned.get(name);
        if (declared !== undefined && declared !== machine)
          return fail(`spawnChild "${name}" runs ${declared} elsewhere: give this one another name`);
        spawned.set(name, machine);
        uses.add("children");
        uses.add("spawn");
        push("spawn", [
          { kind: "text", text: JSON.stringify(name) },
          ...(entries.length === 0 ? [] : [{ kind: "object" as const, entries }]),
        ]);
        return true;
      }
      case "stopChild": {
        const id = stringValue(a0);
        const name = id === null ? null : spawnIds.get(id);
        if (id === null || name === undefined || name === null)
          return fail(
            `stopChild ${a0 === undefined ? "" : src(a0)}: stop a spawned child by the id it was spawned with, written in place (an invoked child stops when its state exits)`,
          );
        uses.add("spawn");
        push("stop", [
          { kind: "text", text: JSON.stringify(name) },
          { kind: "text", text: JSON.stringify(id) },
        ]);
        return true;
      }
      case "enqueueActions": {
        if (a0 === undefined || !isFunction(a0) || a0.body === null)
          return fail("enqueueActions with a function that isn't written in place");
        return enqueued(a0, writes, fx, todos2);
      }
      case "sendParent":
        return fail(
          "sendParent: a child tells its parent through its final state (the parent's children.done), or with an emitted event the parent listens to",
        );
      case "forwardTo":
        return fail("forwardTo: send the event to the child with enq.sendTo(name, event)");
      default:
        return fail(`${f}(...) isn't converted: run it with enq(() => ...)`);
    }
  };

  /** `enqueueActions(({ context, event, enqueue, check }) => { ... })`: its effects, in order. */
  const enqueued = (fn: Fn, writes: Write[], fx: Effect[], todos2: Todo[]): boolean => {
    const scope = scopeOf(fn, false);
    const first = fn.params[0];
    let enqueue = "enqueue";
    let check = "check";
    if (first?.type === "ObjectPattern")
      for (const p of first.properties) {
        const k = p.type === "Property" ? keyName(p) : null;
        const local = p.type === "Property" && p.value.type === "Identifier" ? p.value.name : null;
        if (k === "enqueue" && local !== null) enqueue = local;
        else if (k === "check" && local !== null) check = local;
        else if (k !== "context" && k !== "event")
          todos2.push({ at: p.start, message: `enqueueActions' "${k ?? src(p)}" isn't converted` });
      }
    const statements = (list: readonly Node[], out: Effect[]): void => {
      for (const s of list) {
        if (s.type === "BlockStatement") {
          statements(s.body, out);
          continue;
        }
        if (s.type === "IfStatement") {
          const test = s.test;
          const c: Cond =
            test.type === "CallExpression" &&
            test.callee.type === "Identifier" &&
            test.callee.name === check &&
            test.arguments[0] !== undefined &&
            test.arguments[0].type !== "SpreadElement"
              ? cond(test.arguments[0], test)
              : { kind: "code", code: { node: test, scope } };
          const then: Effect[] = [];
          const otherwise: Effect[] = [];
          statements([s.consequent], then);
          if (s.alternate !== null) statements([s.alternate], otherwise);
          out.push({ kind: "when", at: s.start, cond: c, then, otherwise, seen: writes.length });
          continue;
        }
        if (s.type !== "ExpressionStatement" || !expression(s.expression, out))
          todos2.push({ at: s.start, message: `enqueueActions: ${oneLine(src(s))} isn't converted` });
      }
    };
    /** One call of `enqueue`: false when it isn't one. */
    const expression = (e: Expression, out: Effect[]): boolean => {
      if (e.type !== "CallExpression") return false;
      const callee = e.callee;
      const assignTodo = (at: Node): void => {
        todos2.push({
          at: at.start,
          message: "an assign inside enqueueActions: write the data in the transition, with a ternary over the check",
        });
      };
      // enqueue("name"), enqueue({ type, params }), enqueue(raise(...))
      const arg = e.arguments[0];
      if (
        callee.type === "Identifier" &&
        callee.name === enqueue &&
        arg !== undefined &&
        arg.type !== "SpreadElement"
      ) {
        const w = [...writes];
        if (!action(arg, w, out, todos2, scope) || w.length > writes.length) assignTodo(arg);
        return true;
      }
      // enqueue.raise(...), enqueue.assign(...)
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.object.name === enqueue &&
        callee.property.type === "Identifier"
      ) {
        if (callee.property.name === "assign") assignTodo(e);
        else builtin(callee.property.name, e.arguments, e, writes, out, todos2, scope);
        return true;
      }
      return false;
    };
    const body = fn.body;
    if (body === null) return true;
    if (body.type === "BlockStatement") statements(body.body, fx);
    else if (!expression(body, fx))
      todos2.push({ at: body.start, message: `enqueueActions: ${oneLine(src(body))} isn't converted` });
    return true;
  };

  /**
   * A named action: an assign's writes; or setup's action (`provide`), `enq(actions.name, params)`,
   * when it reads only its params; or its body run after the transition (`enq(() => ...)`), when it
   * reads the context or the event.
   */
  const namedAction = (
    name: string,
    paramsValue: Expression | undefined,
    at: Node,
    writes: Write[],
    fx: Effect[],
    todos2: Todo[],
    scope: Scope,
  ): boolean => {
    const def = actions.get(name);
    const seen = writes.length;
    if (def !== undefined && def.type === "CallExpression" && def.callee.type === "Identifier") {
      const f = mod.xstate.get(def.callee.name);
      if (f !== undefined) {
        if (paramsValue !== undefined)
          todos2.push({ at: at.start, message: `action "${name}" takes params: inline them where it is used` });
        return builtin(f, def.arguments, def, writes, fx, todos2, EMPTY_SCOPE);
      }
    }
    const params = paramsValue === undefined ? null : codeOf(paramsValue, scope);
    if (paramsValue !== undefined && params === null) {
      todos2.push({
        at: at.start,
        message: `action "${name}"'s params are built in a block: return them as one expression`,
      });
      return true;
    }
    const paramType =
      params === null
        ? null
        : params.node.type === "ObjectExpression"
          ? (guessType(params.node) ?? "unknown")
          : "unknown";
    const viaSetup = (text: string, todo2: Todo | null): boolean => {
      if (!actionDefs.has(name)) actionDefs.set(name, { name, text, todo: todo2 });
      uses.add("effects");
      uses.add("provide");
      fx.push({
        kind: "enq",
        at: at.start,
        method: null,
        args: [
          { kind: "text", text: `actions${member(name)}` },
          ...(params === null ? [] : [{ kind: "code" as const, code: params }]),
        ],
        seen,
      });
      return true;
    };
    const stubbed = def === undefined || (isFunction(def) && stubValue(def) !== null);
    if (stubbed)
      return viaSetup(`(${paramType === null ? "" : `_params: ${paramType}`}) => {}`, {
        at: (def ?? at).start,
        message: `action "${name}" ${def === undefined ? "isn't written in this file" : "is a stub in the export"}: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing${def === undefined ? "" : ", as in the export"}`,
      });
    if (!isFunction(def)) {
      todos2.push({
        at: at.start,
        message: `action "${name}" is ${src(def)}, defined elsewhere: write it in setup's actions, as a function of its params`,
      });
      return true;
    }
    // XState calls it with ({ context, event }, params), v4 with (context, event, meta).
    const pos = actionPositional(def);
    const own = scopeOf(def, pos);
    const second = def.params[pos ? 2 : 1];
    const reads =
      def.body !== null &&
      (readsEvent({ node: def.body, scope: own }) ||
        (() => {
          const r = readsOf(def.body, own);
          return r === "opaque" || r.size > 0;
        })());
    if (!reads && (pos ? def.params.length <= 2 : def.params.length <= 1 || second?.type === "Identifier")) {
      // Setup's action: its params are its argument, typed as written or guessed from the call.
      const body = def.body === null ? "{}" : src(def.body);
      const p = second?.type === "Identifier" ? second.name : "_params";
      const typed =
        second?.type === "Identifier" && second.typeAnnotation !== null && second.typeAnnotation !== undefined;
      const head = typed ? `(${src(second)})` : paramType === null ? "()" : `(${p}: ${paramType})`;
      return viaSetup(`${def.async ? "async " : ""}${head} => ${body}`, null);
    }
    if (second !== undefined && second.type !== "Identifier") {
      todos2.push({
        at: def.start,
        message: `action "${name}" destructures its params: name them, (args, params) => ...`,
      });
      return true;
    }
    // Its body, run after the transition: it reads the data the transition had, and its params.
    note(
      at,
      `action "${name}" reads the context or the event: its body runs where it is used (enq(() => ...)). To replace it in tests, make it setup's action and pass it what it reads as params`,
    );
    const body: Code = {
      node: def.body ?? def,
      scope:
        second?.type === "Identifier" && params !== null ? { ...own, params: new Map([[second.name, params]]) } : own,
    };
    uses.add("effects");
    fx.push({ kind: "enq", at: at.start, method: null, args: [{ kind: "thunk", code: body }], seen });
    return true;
  };

  /**
   * Whether an action takes v4's positional (context, event): v5's is ({ context, event }, params),
   * so two parameters alone don't say it.
   */
  const actionPositional = (fn: Fn): boolean => {
    const first = fn.params[0];
    return v4 || (first?.type === "Identifier" && /^(ctx|context|c)$/.test(first.name));
  };

  /** The fields a piece of code reads, without a TODO: "opaque" when it reads the context whole. */
  const readsOf = (node: Node, scope: Scope): Set<string> | "opaque" => reads({ node, scope }, env);

  /** One action: an assign's writes, or an effect (`effects`). False when its writes can't be read. */
  const action = (
    value: Expression,
    writes: Write[],
    fx: Effect[],
    todos2: Todo[],
    scope: Scope = EMPTY_SCOPE,
  ): boolean => {
    if (value.type === "CallExpression" && value.callee.type === "Identifier") {
      const f = mod.xstate.get(value.callee.name);
      if (f !== undefined) return builtin(f, value.arguments, value, writes, fx, todos2, scope);
    }
    const name = stringValue(value) ?? (value.type === "ObjectExpression" ? stringValue(prop(value, "type")) : null);
    if (name !== null)
      return namedAction(
        name,
        value.type === "ObjectExpression" ? prop(value, "params") : undefined,
        value,
        writes,
        fx,
        todos2,
        scope,
      );
    if (isFunction(value)) {
      // An action written inline: its body runs after the transition, with the data it had.
      const own = scopeOf(value, actionPositional(value));
      if (value.params.length > (actionPositional(value) ? 2 : 1)) {
        todos2.push({ at: value.start, message: "an inline action that reads params: write the values in place" });
        return true;
      }
      uses.add("effects");
      fx.push({
        kind: "enq",
        at: value.start,
        method: null,
        args: [{ kind: "thunk", code: { node: value.body ?? value, scope: own } }],
        seen: writes.length,
      });
      return true;
    }
    todos2.push({ at: value.start, message: `an action the codemod can't read: ${src(value)}` });
    return true;
  };

  /** An action list (`entry`, `exit`, a transition's `actions`): its effects, with what it writes. */
  const actionList = (value: Expression, writes: Write[], fx: Effect[], todos2: Todo[]): boolean => {
    let ok = true;
    const list = value.type === "ArrayExpression" ? value.elements : [value];
    for (const a of list) if (a !== null && a.type !== "SpreadElement" && !action(a, writes, fx, todos2)) ok = false;
    return ok;
  };

  // #endregion

  /** A transition's handler, in any form. `kind` says what its event is. */
  const handler = (value: Expression, kind: "on" | "after" | "done" | "error"): Handler | null => {
    if (value.type === "Identifier" && value.name === "undefined") {
      todo(
        value,
        "a forbidden transition (undefined): leave the event unhandled here, and handle it only where it applies",
      );
      return null;
    }
    if (isFunction(value)) return fnHandler(value);
    const items = value.type === "ArrayExpression" ? value.elements : [value];
    const branches: Branch[] = [];
    for (const item of items) {
      if (item === null || item.type === "SpreadElement") continue;
      const b = branch(item, kind);
      if (b !== null) branches.push(b);
    }
    return { kind: "branches", at: value.start, end: value.end, branches };
  };

  const branch = (item: Expression, kind: "on" | "after" | "done" | "error"): Branch | null => {
    const t0 = target(item);
    if (t0 !== "bad" && t0 !== null)
      return {
        at: item.start,
        guard: null,
        target: t0,
        writes: [],
        todos: [],
        description: null,
        effects: [],
        reenter: false,
      };
    if (item.type !== "ObjectExpression") {
      todo(item, `a transition the codemod can't read: ${src(item)}`);
      return null;
    }
    const p = props(item);
    const branchTodos: Todo[] = [];
    const t = target(p.get("target")?.value);
    if (t === "bad") {
      todo(item, 'a target that isn\'t a string written in place: write to("state", data)');
      return null;
    }
    const guardValue = p.get("guard")?.value ?? p.get("cond")?.value;
    const writes: Write[] = [];
    const effects: Effect[] = [];
    let opaque = false;
    const actionsValue = p.get("actions")?.value;
    if (actionsValue !== undefined && !actionList(actionsValue, writes, effects, branchTodos)) opaque = true;
    const contextValue = p.get("context")?.value;
    if (contextValue !== undefined) {
      if (contextValue.type === "ObjectExpression") {
        const w = patch(contextValue, EMPTY_SCOPE, writes.length);
        if (w === "opaque") opaque = true;
        else writes.push(...w);
      } else if (isFunction(contextValue)) {
        const body = returned(contextValue);
        if (body?.type === "ObjectExpression") {
          const w = patch(body, scopeOf(contextValue, false), writes.length);
          if (w === "opaque") opaque = true;
          else writes.push(...w);
        } else opaque = true;
      } else opaque = true;
    }
    const reenterValue = p.get("reenter")?.value;
    const reenter = reenterValue?.type === "Literal" && reenterValue.value === true;
    if (reenter && t === null)
      branchTodos.push({
        at: item.start,
        message: "reenter on a transition without a target does nothing in XState: it is dropped",
      });
    const metaValue = p.get("meta")?.value;
    if (metaValue !== undefined)
      branchTodos.push({
        at: metaValue.start,
        message: `this transition's meta ${src(metaValue)} isn't converted: keep it beside the machine`,
      });
    for (const k of p.keys())
      if (!["target", "guard", "cond", "actions", "context", "reenter", "description", "internal", "meta"].includes(k))
        branchTodos.push({ at: p.get(k)?.start ?? item.start, message: `transition option "${k}" isn't converted` });
    void kind;
    return {
      at: item.start,
      guard: guardValue === undefined ? null : cond(guardValue, guardValue),
      target: t,
      writes: opaque ? "opaque" : writes,
      todos: branchTodos,
      description: stringValue(p.get("description")?.value),
      effects,
      reenter: reenter && t !== null,
    };
  };

  /** A v6 transition function: its returns, rewritten later. */
  const fnHandler = (fn: Fn): Handler => {
    const scope = scopeOf(fn, false);
    const fnTodos: Todo[] = [];
    const enq = v6Enq(fn, fnTodos);
    if (fn.params[0]?.type === "ObjectPattern")
      for (const p of fn.params[0].properties) {
        const k = p.type === "Property" ? keyName(p) : null;
        if (k !== null && !["context", "event", "guards"].includes(k))
          fnTodos.push({
            at: p.start,
            message: `"${k}" isn't available in a transition: depend on data and the event`,
          });
      }
    const sites: Site[] = [];
    const result = (node: Expression, statement: Node | null): void => {
      if (node.type === "ConditionalExpression") {
        result(node.consequent, null);
        result(node.alternate, null);
        return;
      }
      if (
        (node.type === "Identifier" && node.name === "undefined") ||
        (node.type === "UnaryExpression" && node.operator === "void")
      ) {
        sites.push({
          node,
          start: node.start,
          end: node.end,
          kind: "null",
          target: null,
          writes: [],
          statement: false,
          reenter: false,
        });
        return;
      }
      if (node.type === "ObjectExpression") {
        const p = props(node);
        const t = target(p.get("target")?.value);
        if (t === "bad") {
          fnTodos.push({
            at: node.start,
            message: 'a target that isn\'t a string written in place: write to("state", data)',
          });
          return;
        }
        const c = p.get("context")?.value;
        let writes: Write[] | "opaque" = [];
        if (c !== undefined) writes = c.type === "ObjectExpression" ? patch(c, scope, 0) : "opaque";
        const r = p.get("reenter")?.value;
        const reenter = r?.type === "Literal" && r.value === true && t !== null;
        for (const k of p.keys())
          if (k !== "target" && k !== "context" && k !== "reenter")
            fnTodos.push({
              at: p.get(k)?.start ?? node.start,
              message: `"${k}" in a transition's result isn't converted`,
            });
        sites.push({
          node,
          start: node.start,
          end: node.end,
          kind: "to",
          target: t,
          writes,
          statement: false,
          reenter,
        });
        return;
      }
      fnTodos.push({
        at: (statement ?? node).start,
        message: 'a transition result the codemod can\'t read: return to("state", data) or null',
      });
    };
    let fallsThrough = false;
    const body = fn.body;
    if (body !== null && body.type !== "BlockStatement") result(body, null);
    else if (body !== null) {
      walk(body, (n) => {
        if (isFunction(n)) return false;
        if (n.type === "ReturnStatement") {
          if (n.argument === null)
            sites.push({
              node: n,
              start: n.start,
              end: n.end,
              kind: "null",
              target: null,
              writes: [],
              statement: true,
              reenter: false,
            });
          else result(n.argument, n);
          return false;
        }
        return true;
      });
      fallsThrough = !ends(body.body);
    }
    return { kind: "fn", at: fn.start, end: fn.end, fn, scope, sites, fallsThrough, todos: fnTodos, enq };
  };

  /**
   * v6's `enq` (a function's second parameter): its name, when each use is a call @reactre/state's
   * enq has as well (`enq(fn, ...args)`, `enq.raise`, `enq.cancel`, `enq.log`, `enq.sendTo` by a
   * child's name). Null when it isn't used, or (with a TODO) when a use isn't one of those.
   */
  const v6Enq = (fn: Fn, todos2: Todo[]): string | null => {
    const param = fn.params[1];
    if (param === undefined || fn.body === null) return null;
    if (param.type !== "Identifier") {
      todos2.push({ at: param.start, message: "a destructured enq: name it, (args, enq) => ..., to keep its effects" });
      return null;
    }
    const name = param.name;
    let used = false;
    let ok = true;
    walk(fn.body, (n, parent, k) => {
      if (n.type !== "Identifier" || n.name !== name || !isReference(parent, k)) return true;
      used = true;
      const call = parent?.type === "CallExpression" && k === "callee";
      const method =
        parent?.type === "MemberExpression" &&
        k === "object" &&
        !parent.computed &&
        parent.property.type === "Identifier"
          ? parent.property.name
          : null;
      if (call) return true;
      if (method !== null && ["raise", "cancel", "log", "sendTo"].includes(method)) return true;
      ok = false;
      todos2.push({
        at: n.start,
        message: `enq${method === null ? "" : `.${method}`} isn't converted: @reactre/state's enq has enq(fn, ...args), raise, cancel, log, sendTo (and emit, spawn with their opt-ins)`,
      });
      return true;
    });
    if (!used || !ok) return null;
    uses.add("effects");
    return name;
  };

  /** Whether a statement list always returns or throws. */
  const ends = (statements: readonly Node[]): boolean => {
    const last = statements[statements.length - 1];
    if (last === undefined) return false;
    if (last.type === "ReturnStatement" || last.type === "ThrowStatement") return true;
    if (last.type === "IfStatement")
      return last.alternate !== null && endsOne(last.consequent) && endsOne(last.alternate);
    if (last.type === "BlockStatement") return ends(last.body);
    return false;
  };
  const endsOne = (s: Node): boolean => (s.type === "BlockStatement" ? ends(s.body) : ends([s]));

  /**
   * A delay setup computes from the context (`delays: { name: ({ context }) => ms }`): setup's
   * delay of the data (`delays`), whose name is the timer's key. Null when it isn't one.
   */
  const computedDelay = (k: string, at: Node): DelayDef | "todo" | null => {
    const d = delays.get(k);
    if (d === undefined || !isFunction(d)) return null;
    const body = returned(d);
    if (body === null) {
      todo(at, `the delay "${k}" has a block body: write it as one expression`);
      return "todo";
    }
    if (body.type === "Literal" || stringValue(body) !== null) return null;
    const code: Code = { node: body, scope: scopeOf(d, positional(d)) };
    if (readsEvent(code)) {
      todo(at, `the delay "${k}" reads the event: here a delay reads the state's data. Keep what it reads in the data`);
      return "todo";
    }
    const existing = delayDefs.get(k);
    if (existing !== undefined) return existing;
    const def: DelayDef = { name: k, code };
    delayDefs.set(k, def);
    uses.add("delays");
    return def;
  };

  /** `after`'s key as @reactre/state writes it. */
  const duration = (k: string, at: Node): string | null => {
    let ms: number | null = null;
    if (/^\d+$/.test(k)) ms = Number(k);
    else if (/^\d+(\.\d+)?(ms|s|m|h)$/.test(k)) return k;
    else {
      const iso = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(k);
      if (iso !== null && k !== "P" && k !== "PT")
        ms =
          Number(iso[1] ?? 0) * 864e5 +
          Number(iso[2] ?? 0) * 36e5 +
          Number(iso[3] ?? 0) * 6e4 +
          Number(iso[4] ?? 0) * 1e3;
      else {
        let d = delays.get(k);
        // A delay function that returns a number written in place (as Stately's export writes one).
        if (d !== undefined && isFunction(d)) d = returned(d) ?? d;
        if (d?.type === "Literal" && typeof d.value === "number") ms = d.value;
        else if (d !== undefined && stringValue(d) !== null) return duration(stringValue(d) ?? "", at);
        else {
          todo(
            at,
            d === undefined
              ? `timer "${k}" is left out: its delay isn't written in this file. Add it to after as "500ms", "5s", "2m" or "1h"`
              : `timer "${k}" is left out: its delay isn't a number or a function of the context the codemod can read. Write it in setup's delays`,
          );
          return null;
        }
      }
    }
    return ms % 36e5 === 0 && ms > 0
      ? `${ms / 36e5}h`
      : ms % 6e4 === 0 && ms > 0
        ? `${ms / 6e4}m`
        : ms % 1e3 === 0 && ms > 0
          ? `${ms / 1e3}s`
          : `${ms}ms`;
  };

  /** An invoke: a task (async logic) or a child (a machine). */
  const invoke = (value: Expression, node: SNode): Invoke | null => {
    if (value.type !== "ObjectExpression") {
      todo(value, "an invoke that isn't an object literal: write a task or children by hand");
      return null;
    }
    const p = props(value);
    let srcValue = p.get("src")?.value;
    const srcName = stringValue(srcValue);
    if (srcName !== null) srcValue = actors.get(srcName);
    // A name with no implementation (Stately's JSON export names them only) becomes a task stub.
    const missing = srcName !== null && srcValue === undefined;
    if (srcValue === undefined && !missing) {
      todo(value, `invoke's src isn't defined in this file: write a task or children by hand`);
      return null;
    }
    let def: Expression = srcValue ?? value;
    let logicName: string | null = null;
    if (srcValue?.type === "Identifier") {
      logicName = srcValue.name;
      const init = mod.inits.get(srcValue.name)?.init;
      if (init === undefined) {
        todo(value, `invoke's src ${srcValue.name} isn't defined in this file: write a task or children by hand`);
        return null;
      }
      def = init;
    }
    const idValue = stringValue(p.get("id")?.value);
    const id = idValue ?? logicName ?? (node.key === "" ? "root" : node.key);
    for (const k of p.keys())
      if (!["src", "id", "input", "onDone", "onError"].includes(k))
        todo(
          p.get(k) ?? value,
          `invoke's "${k}" isn't converted${k === "timeout" || k === "onTimeout" ? ": give the logic its timeout (createAsyncLogic's timeout), and handle the TimeoutError in error" : ""}`,
        );
    const inputValue = p.get("input")?.value;
    let input: Code | null = null;
    if (inputValue !== undefined) {
      if (isFunction(inputValue)) {
        const body = returned(inputValue);
        if (body === null) todo(inputValue, "an input function with a block body: write it as one expression");
        else input = { node: body, scope: scopeOf(inputValue, positional(inputValue)) };
      } else input = { node: inputValue, scope: EMPTY_SCOPE };
    }
    const onDone = p.get("onDone")?.value;
    const onError = p.get("onError")?.value;
    const done = onDone === undefined ? null : handler(onDone, "done");
    const error = onError === undefined ? null : handler(onError, "error");
    // A stub (or a name with no implementation): a task stub the user writes.
    const stubbed = missing ? { settles: true } : actorStub(def);
    if (srcName !== null && stubbed !== null) {
      const stub = taskStub(
        srcName,
        missing ? undefined : def,
        stubbed.settles,
        serviceOutputs.get(srcName) ?? null,
        p.get("src") ?? value,
      );
      return {
        at: value.start,
        end: value.end,
        id: idValue ?? srcName,
        kind: "task",
        logic: stub.name,
        logicParams: input === null ? ["signal"] : ["input", "signal"],
        input,
        onDone: done,
        onError: error,
        sendsBack: [],
      };
    }
    // A machine: children.
    if (def.type === "CallExpression") {
      const callee = def.callee;
      const isMachine =
        (callee.type === "Identifier" && mod.xstate.get(callee.name) === "createMachine") ||
        (callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "createMachine");
      if (isMachine) {
        if (logicName === null) {
          todo(value, "an inline child machine: declare it as a module-level const, so it converts on its own");
          return null;
        }
        return {
          at: value.start,
          end: value.end,
          id,
          kind: "child",
          logic: logicName,
          logicParams: [],
          input,
          onDone: done,
          onError: error,
          sendsBack: [],
        };
      }
      // Async logic: a task.
      const f = callee.type === "Identifier" ? mod.xstate.get(callee.name) : undefined;
      if (f === "fromCallback") {
        const logicInvoke = callback(def, logicName, value, input !== null);
        return logicInvoke === null
          ? null
          : {
              at: value.start,
              end: value.end,
              id,
              kind: "logic",
              logic: logicInvoke.name,
              logicParams: [],
              input,
              onDone: done,
              onError: error,
              sendsBack: logicInvoke.sendsBack,
            };
      }
      if (f === "fromObservable" || f === "fromEventObservable" || f === "fromTransition") {
        const hint =
          f === "fromTransition"
            ? "write it as createStepLogic from @reactre/state/logic, whose step gets the state and the event"
            : f === "fromObservable"
              ? "write it as createObservableLogic from @reactre/state/logic: its values are the child's snapshots"
              : "write it as createEventObservableLogic<Events> from @reactre/state/logic: the events it sends back can't be read from the observable";
        todo(value, `invoke of ${f}: ${hint}, and handle it in the state's children`);
        return null;
      }
      let fn: Expression | undefined;
      if (f === "fromPromise") fn = def.arguments[0]?.type === "SpreadElement" ? undefined : def.arguments[0];
      if (f === "createAsyncLogic") {
        const opts = def.arguments[0];
        fn = opts?.type === "ObjectExpression" ? prop(opts, "run") : undefined;
        if (opts?.type === "ObjectExpression")
          for (const k of props(opts).keys()) if (k !== "run") todo(opts, `createAsyncLogic's "${k}" isn't converted`);
      }
      if (fn !== undefined && isFunction(fn)) {
        const params: string[] = [];
        const first = fn.params[0];
        if (first?.type === "ObjectPattern")
          for (const q of first.properties) {
            const k = q.type === "Property" ? keyName(q) : null;
            if (k !== null) params.push(k);
          }
        else if (first !== undefined) params.push("input", "signal");
        for (const k of params)
          if (k !== "input" && k !== "signal")
            todo(fn, `the task gets "${k}" in XState; @reactre/state's run gets its data and a signal`);
        if (fn.params[1] !== undefined)
          todo(fn.params[1], "the task's enq: effects of a task run in its run function directly");
        let name = logicName;
        if (name === null) {
          todo(value, "inline async logic: declare it as a module-level const");
          return null;
        }
        if (!logic.has(name)) {
          const typeArgs2 = def.typeArguments?.params ?? [];
          const inType = typeArgs2[1];
          const annotated = first === undefined || Reflect.get(first, "typeAnnotation") !== null;
          const annotation =
            !annotated && inType !== undefined
              ? `{ ${params.map((k) => (k === "input" ? `input: ${src(inType)}` : k === "signal" ? "signal: AbortSignal" : `${k}: unknown`)).join("; ")} }`
              : null;
          if (!annotated && annotation === null)
            todo(fn, "the task's function has no parameter type: annotate its input");
          logic.set(name, { name, call: def, fn, annotation, params, callee: null, cleanup: null });
        }
        name = name ?? id;
        return {
          at: value.start,
          end: value.end,
          id,
          kind: "task",
          logic: name,
          logicParams: params,
          input,
          onDone: done,
          onError: error,
          sendsBack: [],
        };
      }
    }
    todo(
      value,
      `invoke of ${src(srcValue ?? value)}: only fromPromise, createAsyncLogic, fromCallback and machines convert. Write a task or children by hand`,
    );
    return null;
  };

  /**
   * The cleanup a callback's block body lacks: XState's `fromCallback` may return nothing, callback
   * logic's `run` returns its cleanup. A no-op one goes at the end, with a TODO. Null when the body
   * returns a value somewhere (an expression body returns one).
   */
  const cleanupOf = (fn: Fn): LogicDef["cleanup"] => {
    const body = fn.body;
    if (body?.type !== "BlockStatement") return null;
    let returns = false;
    walk(body, (n) => {
      if (n.type === "ReturnStatement" && n.argument !== null) returns = true;
      return !isFunction(n);
    });
    if (returns) return null;
    const message =
      "the callback returned no cleanup, and callback logic returns one: release what it sets up (an interval, a listener) in this function";
    const text = `\n// TODO(@reactre/state): ${message}\nreturn () => {};\n`;
    return { start: body.end - 1, end: body.end - 1, text, todo: { at: fn.start, message } };
  };

  /**
   * `fromCallback(fn)`, as callback logic: `createCallbackLogic<Receives, Input, Sends>(fn)`, where
   * Sends is the events its `sendBack` calls write in place, typed as the machine's events.
   */
  const callback = (
    def: CallExpression,
    name: string | null,
    at: Node,
    hasInput: boolean,
  ): { readonly name: string; readonly sendsBack: readonly string[] } | null => {
    const fn = def.arguments[0];
    if (name === null || fn === undefined || fn.type === "SpreadElement" || !isFunction(fn)) {
      todo(at, "inline callback logic: declare it as a module-level const, so it converts on its own");
      return null;
    }
    const existing = logic.get(name);
    let sendBack = "sendBack";
    const first = fn.params[0];
    if (first !== undefined && first.type !== "ObjectPattern") {
      todo(first, "destructure the callback's argument (({ input, sendBack, receive }) => ...)");
      return null;
    }
    if (first?.type === "ObjectPattern")
      for (const q of first.properties) {
        const k = q.type === "Property" ? keyName(q) : null;
        if (k === "sendBack" && q.type === "Property" && q.value.type === "Identifier") sendBack = q.value.name;
        else if (k !== "input" && k !== "receive")
          todo(q, `the callback's "${k ?? src(q)}" isn't converted: callback logic gets input, sendBack and receive`);
      }
    const sends = new Set<string>();
    let unread = false;
    if (fn.body !== null)
      walk(fn.body, (n) => {
        if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== sendBack) return true;
        const ev = n.arguments[0];
        const type = ev?.type === "ObjectExpression" ? stringValue(prop(ev, "type")) : null;
        if (type === null) unread = true;
        else sends.add(type);
        return true;
      });
    if (unread)
      todo(at, "the callback sends back an event that isn't an object with its type written in place: add it to Sends");
    const [r, i] = def.typeArguments?.params ?? [];
    const sendsType =
      sends.size === 0
        ? "never"
        : [...sends]
            .map((t) => {
              const fields = events.get(t)?.fields;
              const rest =
                fields === null || fields === undefined
                  ? ""
                  : [...fields.values()].map((f) => `; ${f.name}${f.optional ? "?" : ""}: ${f.type}`).join("");
              return `{ type: ${JSON.stringify(t)}${rest} }`;
            })
            .join(" | ");
    let inputType = i === undefined ? null : src(i);
    if (inputType === null && hasInput) {
      todo(fn, "the callback's input has no type: write it in createCallbackLogic's second type argument");
      inputType = "object";
    }
    if (existing === undefined) {
      logic.set(name, {
        name,
        call: def,
        fn,
        annotation: null,
        params: [],
        callee: {
          start: def.callee.start,
          end: def.typeArguments?.end ?? def.callee.end,
          text: `createCallbackLogic<${r === undefined ? "never" : src(r)}, ${inputType ?? "undefined"}, ${sendsType}>`,
        },
        cleanup: cleanupOf(fn),
      });
      importFrom("logic", "createCallbackLogic");
    }
    uses.add("children");
    uses.add("logic");
    return { name, sendsBack: [...sends] };
  };

  const known = new Set([
    "id",
    "type",
    "initial",
    "states",
    "on",
    "after",
    "invoke",
    "onDone",
    "history",
    "target",
    "entry",
    "exit",
    "always",
    "tags",
    "meta",
    "description",
    "output",
    "context",
    "types",
    "schemas",
    "version",
    "guards",
    "actions",
    "actors",
    "delays",
    "predictableActionArguments",
    "preserveActionOrder",
    "tsTypes",
    "schema",
    "timeout",
    "onTimeout",
  ]);

  const readNode = (object: ObjectExpression, k: string, parent: SNode | null): SNode => {
    const p = props(object);
    const name = parent === null || parent.name === "" ? k : `${parent.name}.${k}`;
    const typeValue = stringValue(p.get("type")?.value);
    const statesValue = p.get("states")?.value;
    const node: SNode = {
      key: k,
      name,
      parent,
      at: object.start,
      end: object.end,
      type:
        typeValue === "parallel"
          ? "parallel"
          : typeValue === "final"
            ? "final"
            : typeValue === "history" || p.has("history")
              ? "history"
              : statesValue?.type === "ObjectExpression" && statesValue.properties.length > 0
                ? "compound"
                : "atomic",
      id: stringValue(p.get("id")?.value),
      initial: null,
      children: [],
      on: new Map(),
      after: [],
      invokes: [],
      onDone: null,
      history: null,
      todos: [],
      typestate: null,
      description: null,
      tags: null,
      meta: null,
      entry: [],
      exit: [],
      always: null,
      timeout: null,
    };
    const nodeTodo = (at: Node, message: string): void => {
      node.todos.push({ at: at.start, message });
    };
    if (node.type === "history") {
      const h = p.get("history")?.value;
      const t = target(p.get("target")?.value);
      node.history = {
        deep: stringValue(h) === "deep",
        target: t === "bad" ? null : t,
      };
      if (t === "bad") nodeTodo(object, "a history target that isn't a string: write back(parent, to(...)) by hand");
      return node;
    }
    const initialValue = p.get("initial")?.value;
    if (initialValue !== undefined) {
      const t = target(initialValue);
      if (t === "bad" || t === null) nodeTodo(initialValue, "initial isn't a state's name: write start by hand");
      else node.initial = t;
    }
    if (statesValue?.type === "ObjectExpression")
      for (const [ck, cp] of props(statesValue)) {
        if (cp.value.type !== "ObjectExpression") {
          nodeTodo(cp, `state "${ck}" isn't an object literal written in place`);
          continue;
        }
        node.children.push(readNode(cp.value, ck, node));
      }
    const onValue = p.get("on")?.value;
    if (onValue?.type === "ObjectExpression")
      for (const [event, ep] of props(onValue)) {
        if (event.startsWith("xstate.") || event === "") {
          nodeTodo(
            ep,
            event === ""
              ? 'an eventless transition ("") is v4\'s always: write it as always'
              : `"${event}" transitions aren't converted: XState's own events have no counterpart here`,
          );
          continue;
        }
        // "*" and "prefix.*" (`wildcards`): the exact name wins, then the longest prefix, then "*".
        if (event === "*" || event.endsWith(".*")) uses.add("wildcards");
        currentEvent = event.includes("*") ? null : event;
        const h = handler(ep.value, "on");
        currentEvent = null;
        if (h !== null) node.on.set(event, h);
      }
    const afterValue = p.get("after")?.value;
    if (afterValue?.type === "ObjectExpression")
      for (const ap of afterValue.properties) {
        if (ap.type === "SpreadElement") continue;
        const k2 = keyName(ap);
        if (k2 === null) {
          nodeTodo(ap, "a delay the codemod can't read");
          continue;
        }
        const h = handler(ap.value, "after");
        if (h === null) continue;
        const computed = computedDelay(k2, ap);
        if (computed === "todo") continue;
        node.after.push(
          computed === null
            ? { at: ap.start, end: ap.end, duration: duration(k2, ap), handler: h, named: false }
            : { at: ap.start, end: ap.end, duration: k2, handler: h, named: true },
        );
      }
    const invokeValue = p.get("invoke")?.value;
    if (invokeValue !== undefined) {
      const list = invokeValue.type === "ArrayExpression" ? invokeValue.elements : [invokeValue];
      for (const item of list) {
        if (item === null || item.type === "SpreadElement") continue;
        const inv = invoke(item, node);
        if (inv !== null) node.invokes.push(inv);
      }
      if (node.invokes.filter((i) => i.kind === "task").length > 1)
        nodeTodo(invokeValue, "a state runs one task: merge these into one, or move one to a child state");
    }
    const onDoneValue = p.get("onDone")?.value;
    if (onDoneValue !== undefined) node.onDone = handler(onDoneValue, "on");

    // entry and exit (`effects`): actions, or v6's function of ({ context }, enq).
    for (const k2 of ["entry", "exit"] as const) {
      const v = p.get(k2)?.value;
      if (v === undefined) continue;
      if (parent === null) {
        nodeTodo(v, `${k2} on the machine itself: put it on its top-level states`);
        continue;
      }
      if (k2 === "exit" && node.type === "final") {
        nodeTodo(v, "exit on a final state: the machine ends there, so it never runs");
        continue;
      }
      if (isFunction(v) && v.params.length >= 2 && !positional(v)) {
        const fx = v6Enq(v, node.todos);
        node[k2] = { fn: v, scope: scopeOf(v, false), enq: fx };
        continue;
      }
      const writes: Write[] = [];
      const fx: Effect[] = [];
      const ok = actionList(v, writes, fx, node.todos);
      if (!ok || writes.length > 0)
        nodeTodo(
          v,
          `${k2}'s assign: ${k2 === "entry" ? "write the data in the transitions into" : "write the data in the transitions out of"} ${name}, as an entry here runs after the move`,
        );
      node[k2] = fx;
    }
    // always (`always`): checked after every step that lands here.
    const alwaysValue = p.get("always")?.value;
    if (alwaysValue !== undefined) {
      node.always = handler(alwaysValue, "after");
      if (node.always !== null) uses.add("always");
    }
    // tags, meta and description (`tags`).
    const tagsValue = p.get("tags")?.value;
    if (tagsValue !== undefined) {
      const list =
        tagsValue.type === "ArrayExpression" ? tagsValue.elements.map((e) => stringValue(e)) : [stringValue(tagsValue)];
      if (list.some((t) => t === null))
        nodeTodo(tagsValue, `tags ${src(tagsValue)} that aren't strings written in place`);
      else node.tags = JSON.stringify(list);
    }
    const metaValue = p.get("meta")?.value;
    if (metaValue !== undefined) node.meta = src(metaValue);
    const descriptionValue = p.get("description")?.value;
    if (descriptionValue !== undefined) {
      node.description = stringValue(descriptionValue);
      if (node.description === null)
        nodeTodo(descriptionValue, `a description that isn't a string written in place: ${src(descriptionValue)}`);
    }
    if (parent !== null && (node.tags !== null || node.meta !== null || node.description !== null)) uses.add("tags");
    if (parent === null)
      for (const k2 of ["tags", "meta"] as const)
        if (node[k2] !== null) {
          nodeTodo(p.get(k2) ?? object, `${k2} on the machine itself: put them on its top-level states`);
          node[k2] = null;
        }
    // timeout and onTimeout (`timeout`): v6's "we've been here too long".
    const timeoutValue = p.get("timeout")?.value;
    const onTimeoutValue = p.get("onTimeout")?.value;
    if (timeoutValue !== undefined || onTimeoutValue !== undefined) {
      const h = onTimeoutValue === undefined ? null : handler(onTimeoutValue, "after");
      let value: Arg | null = null;
      let delay: string | null = null;
      const tv = timeoutValue;
      if (tv === undefined) nodeTodo(onTimeoutValue ?? object, "onTimeout without a timeout: it never runs");
      else if (tv.type === "Literal" && typeof tv.value === "number") value = { kind: "text", text: String(tv.value) };
      else if (stringValue(tv) !== null) {
        const delayName = stringValue(tv) ?? "";
        const d = delays.get(delayName);
        const computed = d?.type === "Literal" ? null : computedDelay(delayName, tv);
        if (d?.type === "Literal" && typeof d.value === "number") value = { kind: "text", text: String(d.value) };
        else if (computed !== null && computed !== "todo") {
          value = { kind: "text", text: JSON.stringify(delayName) };
          delay = delayName;
        } else if (computed === null)
          nodeTodo(tv, `timeout "${delayName}" isn't one of setup's delays: write it in milliseconds`);
      } else if (isFunction(tv)) {
        const c = codeOf(tv);
        if (c === null || readsEvent(c))
          nodeTodo(
            tv,
            "a timeout function that reads the event or has a block body: compute it from the data, as one expression",
          );
        else value = { kind: "code", code: c };
      } else nodeTodo(tv, `timeout ${src(tv)} isn't a number, a delay's name or a function written in place`);
      if (value !== null && h === null && onTimeoutValue === undefined)
        nodeTodo(tv ?? object, "a timeout without onTimeout: say where to go when it expires");
      if (value !== null && h !== null && tv !== undefined) {
        node.timeout = { at: tv.start, value, delay, handler: h };
        uses.add("timeout");
      }
    }
    const outputValue = p.get("output")?.value;
    if (outputValue !== undefined)
      nodeTodo(
        outputValue,
        `output ${oneLine(src(outputValue))}: here a final state's data is its output. Write what it computes into the data the transitions into it give`,
      );

    for (const [k2, kp] of p) {
      if (["entry", "exit", "always", "tags", "meta", "description", "timeout", "onTimeout", "output"].includes(k2))
        continue;
      if (
        !known.has(k2) ||
        (parent !== null &&
          ["context", "types", "schemas", "schema", "version", "guards", "actions", "actors", "delays"].includes(k2))
      )
        nodeTodo(kp, `"${k2}" isn't converted`);
    }
    return node;
  };

  const root = readNode(config, "", null);

  // v6 typestates: setup's `states: { open: { schemas: { context: types<T>() } } }`, nested too.
  const statesContract = m.setup === null ? undefined : prop(m.setup, "states");
  const typestates = (contract: Expression | undefined, node: SNode): void => {
    if (contract?.type !== "ObjectExpression") return;
    for (const [k, p] of props(contract)) {
      const child = node.children.find((c) => c.key === k);
      if (child === undefined) continue;
      const t = typesArg(prop(prop(p.value, "schemas"), "context"));
      if (t !== null) child.typestate = typeFields(t);
      typestates(prop(p.value, "states"), child);
    }
  };
  typestates(statesContract, root);

  // #endregion

  const versionValue = cfg.get("version")?.value;
  let version: number | null = null;
  if (versionValue !== undefined) {
    const v = stringValue(versionValue) ?? (versionValue.type === "Literal" ? String(versionValue.value) : null);
    if (v !== null && /^\d+$/.test(v)) version = Number(v);
    else todo(versionValue, "version is a whole number in @reactre/state: bump it when a state's data changes");
  }
  const setupKeys = ["types", "schemas", "guards", "actions", "actors", "delays", "states"];
  if (m.setup !== null)
    for (const [k, p] of props(m.setup)) if (!setupKeys.includes(k)) todo(p, `setup's "${k}" isn't converted`);

  // Events handled somewhere; the declared ones nobody handles are dropped.
  const handled = new Set<string>();
  const collect = (n: SNode): void => {
    for (const e of n.on.keys()) handled.add(e);
    for (const c of n.children) collect(c);
  };
  collect(root);
  // A wildcard handles each event it matches: "*" all, "a.*" those under "a.".
  const wildcards = [...handled].filter((e) => e.includes("*"));
  for (const w of wildcards) handled.delete(w);
  const matched = (e: string): boolean => wildcards.some((w) => w === "*" || e.startsWith(w.slice(0, -1)));
  const unhandled: string[] = [];
  for (const e of [...events.keys()])
    if (!handled.has(e) && !matched(e)) {
      unhandled.push(e);
      events.delete(e);
    }
  const guessed = [...handled].filter((e) => !events.has(e));
  for (const e of guessed) events.set(e, { name: e, value: "types<{}>()", fields: new Map() });
  if (guessed.length > 0)
    note(
      config,
      `event${guessed.length === 1 ? "" : "s"} ${guessed.map((e) => `"${e}"`).join(", ")} ${guessed.length === 1 ? "has" : "have"} no type: guessed no payload. Add the fields ${guessed.length === 1 ? "it carries" : "they carry"} to setup's events`,
    );

  return {
    name: m.name,
    exported: m.exported,
    statement: m.statement,
    at: m.call.start,
    root,
    context,
    events,
    unhandled,
    input,
    version,
    todos,
    setupStatement: m.setupStatement,
    logic,
    env,
    stubs,
    notes,
    actions: actionDefs,
    guards: guardDefs,
    delays: delayDefs,
    emitted,
    spawned,
    uses,
    imports,
  };
}
