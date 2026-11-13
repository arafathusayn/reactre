// The compiler's rules over the code that uses a machine (../index.ts runs them on every file that
// imports @reactre/state): what an actor is given, who it serves, and how long it runs, which the
// type checker can't see because each call types alone. ./react.ts and ./testing.ts hold the
// rules of components and of tests, on the same context.
//
// Each rule is one an app's code breaks with a call that type-checks:
//   - M430: a value sent in an event, then changed by the sender: the machine holds it.
//   - M431: a `message` listener that sends without a look at `e.origin`: any window drives it.
//   - M577: @reactre/state's types augmented (`declare module "@reactre/state"`) to make an error go.
//   - M585: an actor's variable given a new actor while the old one runs.
//   - M586: an actor made in an async function that returns while the actor's work runs.
//   - M587: one module-level actor serving every request.
//   - M589: a promise of the library's (`waitFor`) neither awaited nor returned.
//   - M591: a pure function's result (`transition`) dropped.

import type { Node, Program } from "oxc-parser";

import type { Report } from "./feature.ts";
import { boundNames, isFunction, keyName, rootName, stringValue, walk, walkPath } from "./syntax.ts";

/** What the use-site rules get: the file, and what ../index.ts found in it. */
export interface SiteContext {
  readonly program: Program;
  readonly src: (node: Node) => string;
  readonly report: Report;
  /** Each name a module-level import binds: its source, and the name it imports (`*` for the module). */
  readonly imports: ReadonlyMap<string, { readonly source: string; readonly imported: string }>;
  /** Names bound to an actor, a snapshot or useActor's pair by a call of @reactre/state, and to its snapshots. */
  readonly tracked: ReadonlySet<string>;
}

/** The @reactre/state function a call calls, by the name it imports, if it calls one. */
export function libraryCall(ctx: SiteContext, node: Node): string | null {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return null;
  const b = ctx.imports.get(node.callee.name);
  return b !== undefined && (b.source === "@reactre/state" || b.source.startsWith("@reactre/state/"))
    ? b.imported
    : null;
}

/** An import's name, for a call of it: `useState` of `import { useState } from "react"`. */
export function importedCall(ctx: SiteContext, node: Node, source: string): string | null {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return null;
  const b = ctx.imports.get(node.callee.name);
  return b?.source === source ? b.imported : null;
}

/** `name.method(...)` on a tracked name (an actor): the name. */
export function actorCall(ctx: SiteContext, node: Node, method: string): string | null {
  return node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === method &&
    node.callee.object.type === "Identifier" &&
    ctx.tracked.has(node.callee.object.name)
    ? node.callee.object.name
    : null;
}

/** Whether `root` has, outside its nested functions when `own` says so, a node `test` accepts. */
export function has(root: Node, test: (node: Node) => boolean, own = false): boolean {
  let found = false;
  walk(root, (n) => {
    if (found || (own && n !== root && isFunction(n))) return false;
    found = test(n);
    return !found;
  });
  return found;
}

/** The methods that change an array, a Map or a Set in place. */
const CHANGES = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

/** The library's functions that return a promise: one dropped rejects unhandled. */
const PROMISES = new Set(["waitFor", "toPromise", "testPaths", "propertyTest"]);

/** The library's pure functions: a call of one does nothing but return its result. */
const RESULTS = new Set([
  "transition",
  "initial",
  "initialTransition",
  "can",
  "matches",
  "matchesState",
  "isIn",
  "hasTag",
  "getNextTransitions",
  "getStateNodes",
  "getMeta",
  "select",
  "mapState",
  "isUnhandled",
]);

/** The names a request handler is exported as (Next.js, Remix, SvelteKit, Hono's file routes). */
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The calls that make an actor, which runs until it is stopped. */
const MAKES = new Set(["createActor", "restoreActor"]);

export function checkUseSites(ctx: SiteContext): void {
  const { program, src, report } = ctx;
  const makes = (node: Node | null | undefined): boolean => node != null && MAKES.has(libraryCall(ctx, node) ?? "");

  // M430: a binding sent in an event, then changed by the sender. Each list of statements.
  walk(program, (node) => {
    const list = node.type === "Program" || node.type === "BlockStatement" ? node.body : null;
    list?.forEach((statement, i) => {
      const sent = new Set<string>();
      walk(statement, (n) => {
        if (isFunction(n)) return false;
        const payload = actorCall(ctx, n, "send") !== null && n.type === "CallExpression" ? n.arguments[0] : undefined;
        if (payload?.type === "ObjectExpression")
          for (const p of payload.properties)
            if (p.type === "Property" && p.value.type === "Identifier" && keyName(p) !== "type") sent.add(p.value.name);
        return true;
      });
      const told = new Set<string>();
      for (const later of list.slice(i + 1))
        walk(later, (n) => {
          const changed =
            n.type === "CallExpression" &&
            n.callee.type === "MemberExpression" &&
            !n.callee.computed &&
            n.callee.object.type === "Identifier" &&
            n.callee.property.type === "Identifier" &&
            CHANGES.has(n.callee.property.name)
              ? n.callee.object.name
              : (n.type === "AssignmentExpression" || n.type === "UpdateExpression") &&
                  (n.type === "AssignmentExpression" ? n.left : n.argument).type === "MemberExpression"
                ? rootName(n.type === "AssignmentExpression" ? n.left : n.argument)
                : null;
          if (changed !== null && sent.has(changed) && !told.has(changed)) {
            told.add(changed);
            report(
              n,
              `${changed} is sent to the actor and then changed: the machine holds the same object, frozen in development and changed under it in production. Send a copy ([...${changed}], { ...${changed} }), or don't change it after`,
            );
          }
          return true;
        });
    });
    return true;
  });

  walkPath(program, (node, path) => {
    // M431: a message listener that drives an actor takes any window's message.
    const listener =
      node.type === "CallExpression" &&
      ((node.callee.type === "Identifier" && node.callee.name === "addEventListener") ||
        (node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "addEventListener")) &&
      stringValue(node.arguments[0]) === "message"
        ? node.arguments[1]
        : undefined;
    if (listener !== undefined && isFunction(listener) && listener.body !== null) {
      const param = listener.params[0];
      const sends = has(listener.body, (n) => actorCall(ctx, n, "send") !== null);
      const looks =
        param?.type === "ObjectPattern"
          ? param.properties.some((p) => p.type === "Property" && keyName(p) === "origin")
          : param?.type === "Identifier" &&
            has(listener.body, (n) => n.type === "MemberExpression" && src(n) === `${param.name}.origin`);
      if (sends && !looks)
        report(
          listener,
          'a message listener sends to the actor without checking where the message came from, so any window drives the machine: compare e.origin with the origin you expect first, if (e.origin !== "https://app.example") return',
        );
    }

    // M585: a new actor in an actor's variable, the old one still running.
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier" &&
      ctx.tracked.has(node.left.name) &&
      makes(node.right)
    ) {
      const name = node.left.name;
      const scope = [...path].reverse().find((n) => isFunction(n)) ?? program;
      const stopped = has(
        scope,
        (n) =>
          n.start < node.start &&
          n.type === "CallExpression" &&
          n.callee.type === "MemberExpression" &&
          src(n.callee).replace("?.", ".") === `${name}.stop`,
      );
      if (!stopped)
        report(
          node,
          `the old actor in ${name} isn't stopped, so its task and timers keep running: stop it first, ${name}.stop(); ${src(node)}`,
        );
    }

    // M586: an actor made in an async function that awaits nothing, so it returns while the actor's work runs.
    const named =
      isFunction(node) &&
      node.async &&
      (node.type === "FunctionDeclaration" || path[path.length - 1]?.type === "VariableDeclarator");
    if (named && isFunction(node) && node.body !== null && !has(node.body, (n) => n.type === "AwaitExpression", true))
      walk(node.body, (n) => {
        if (isFunction(n)) return false;
        if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier" || !makes(n.init)) return true;
        const actor = n.id.name;
        let kept = false;
        walk(node.body ?? n, (m, parent, key) => {
          if (m.type !== "Identifier" || m.name !== actor || m.start === n.id.start) return !kept;
          const method =
            parent?.type === "MemberExpression" &&
            key === "object" &&
            !parent.computed &&
            parent.property.type === "Identifier"
              ? parent.property.name
              : null;
          // Stopped, or handed on (awaited with waitFor or toPromise, returned, kept elsewhere).
          if (method === null || method === "stop") kept = true;
          return !kept;
        });
        if (!kept && n.init !== null)
          report(
            n.init,
            `the actor made here is neither awaited nor stopped, so the function returns while its task and timers run (a server's request, or the process, ends under them): await it, await toPromise(${actor}) or await waitFor(${actor}, (s) => ...), or call ${actor}.stop() before returning`,
          );
        return true;
      });
    return true;
  });

  // M587: one module-level actor in a request handler serves every request.
  const shared = new Set<string>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations) if (makes(d.init)) for (const n of boundNames(d.id)) shared.add(n);
  }
  const serves = (fn: Node, path: readonly Node[]): boolean => {
    if (!isFunction(fn)) return false;
    const parent = path[path.length - 1];
    const exported =
      fn.type === "FunctionDeclaration" &&
      fn.id !== null &&
      METHODS.has(fn.id.name) &&
      parent?.type === "ExportNamedDeclaration";
    const request = fn.params.some(
      (p) => p.type === "Identifier" && p.typeAnnotation != null && src(p.typeAnnotation.typeAnnotation) === "Request",
    );
    const worker =
      parent?.type === "Property" &&
      keyName(parent) === "fetch" &&
      path.some((n) => n.type === "ExportDefaultDeclaration");
    return exported || request || worker;
  };
  if (shared.size > 0)
    walkPath(program, (node, path) => {
      if (!serves(node, path) || !isFunction(node) || node.body === null) return true;
      let told = false;
      walk(node.body, (n) => {
        if (told || n.type !== "Identifier" || !shared.has(n.name)) return !told;
        told = true;
        report(
          n,
          `${n.name} is one actor at module level, so every request (every user) drives the same machine: make one per request in the handler, createActor(machine), and stop it (or await it) before responding`,
        );
        return false;
      });
      return false;
    });

  // M589, M591: a call as a statement whose value is all it gives.
  walk(program, (node) => {
    if (node.type !== "ExpressionStatement") return true;
    const call =
      node.expression.type === "UnaryExpression" && node.expression.operator === "void"
        ? node.expression.argument
        : node.expression;
    const name = libraryCall(ctx, call) ?? "";
    if (PROMISES.has(name))
      report(
        call,
        `${name}(...) isn't awaited, so its rejection (a timeout, a failed path) is unhandled, and the code after it doesn't wait: await ${name}(...), or return it`,
      );
    if (RESULTS.has(name))
      report(
        call,
        `${name}(...)'s result is dropped: it is pure, so the call does nothing else. Use what it returns, const next = ${name}(...)`,
      );
    return true;
  });

  // M577: @reactre/state's types augmented in app code.
  for (const s of program.body)
    if (s.type === "TSModuleDeclaration" && s.id.type === "Literal" && /^@reactre\/state(\/|$)/.test(s.id.value))
      report(
        s,
        `declare module "${s.id.value}" changes @reactre/state's types, which hides the error it was written for: remove it, and fix the call the type checker refused`,
      );
}
