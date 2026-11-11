// A task's `run` may do anything: it is the effect. What the compiler checks in it is that the work
// ends with the state, and that a failure reaches the task's `error`. Types see none of it: a
// `fetch` without the signal, a `catch` that resolves to an event and a cast on the response all
// type-check.
//
//   - Work that outlives the state: a `fetch` not given the signal (or given another one, or
//     options that don't hold it), a function of the file (or a relative import's) that fetches,
//     called without the signal, a client package's request (axios, ky, got, ofetch,
//     graphql-request) without a `signal` option, an AbortController of its own (a hand-made
//     timeout), and a `setTimeout`, `setInterval`, socket, listener, XMLHttpRequest or media stream
//     with no cleanup when the signal aborts. A `timeout` option to fetch is no timeout: a browser
//     ignores it, and Bun's (which its types declare) is the socket's idle timer. A server action
//     (a function with `"use server"`, or an import from a module that starts with it) takes no
//     signal, and a durable run started in run isn't stopped with it.
//   - A failure that doesn't reach `error`: a `catch` that resolves to an event, an empty catch, an
//     async callback to `forEach`, `filter` and the like (run resolves before the work ends, or a
//     promise is always truthy), `new Promise(async ...)`, `for await` over an array of promises, an
//     `allSettled` whose results aren't read, a retry loop (retries are states), a promise started
//     and not awaited (`save(data)` as a statement, of `fetch`, a function the compiler sees return
//     a promise, or a `.then` chain), or returned unawaited from a `try`, a `return` or `throw` in a
//     `finally`, a throw in a callback run schedules or a listener, a `new Error` not thrown, a
//     throw or a rejection of a value that isn't an Error, a rethrow without the caught error as
//     its cause, and a catch's error typed `any` (or a `.catch` callback's, untyped).
//   - Outside data taken on trust: a cast in the event `run` resolves to, `{} as T`, a function
//     whose type parameter is only its result's (`getJson<T>`), and a fetch response's body read
//     (`.json()`, `.text()`, ...) with no look at its status before it on the path: a 404 or 500
//     page would be the task's result. The response is followed through its name (`const res =
//     await fetch(...)`, `.then((res) => ...)`); `(await fetch(...)).json()` has none to check. A
//     look is `res.ok` or `res.status` (or either destructured), or the response passed whole to a
//     function the compiler sees check it: one written in the file (or in run), or exported from a
//     relative import (./modules.ts reads it), whose parameter it looks at, or passes on to such a
//     function. A package's function can't be seen, so it isn't a look. A body is read once, a
//     status is `ok` (not `=== 200`), and `mode: "no-cors"` has none.
//   - What the event holds: a date as local text (`toString()`), an id from the clock or
//     Math.random, and an Idempotency-Key made in run (a retry is a new write).
//   - Outside the task: a hook (`useQuery(...)`, it runs only in a component's render), a test
//     branch (`NODE_ENV === "test"`), a secret key written in the code, a write to a module
//     variable, and a send to an actor (a task resolves to one event).

import { existsSync, readFileSync } from "node:fs";

import type { ArrowFunctionExpression, Function as FunctionNode, Node, ObjectExpression, Program } from "oxc-parser";

import type { Report } from "./feature.ts";
import { resolveImport, type Seen } from "./modules.ts";
import { boundNames, hides, importedName, isFunction, keyName, returned, stringValue, walk } from "./syntax.ts";

type Fn = ArrowFunctionExpression | FunctionNode;

/** A response's methods that read its body. */
const BODY = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);
const STATUS = new Set(["ok", "status"]);

/** A pattern that takes `ok` or `status` out of what it destructures. */
const takesStatus = (pattern: Node): boolean =>
  pattern.type === "ObjectPattern" &&
  pattern.properties.some((p) => p.type === "Property" && STATUS.has(keyName(p) ?? ""));

/**
 * The node looks at `name`'s status: `name.ok`, `name.status`, or `const { ok } = name`. A read
 * that only prints it (`console.info(res.status)`) is not a look: it has no failure path, so a 404
 * page still becomes the task's result. A look must be able to stop the read, which means it is a
 * condition (`if`, `?:`, `&&`, `||`, `!`), a `throw`, or a destructuring that binds the status.
 */
function looksAtStatus(node: Node, name: string, parent: Node | null): boolean {
  if (node.type === "VariableDeclarator")
    return node.init?.type === "Identifier" && node.init.name === name && takesStatus(node.id);
  if (
    node.type !== "MemberExpression" ||
    node.computed ||
    node.object.type !== "Identifier" ||
    node.object.name !== name ||
    node.property.type !== "Identifier" ||
    !STATUS.has(node.property.name)
  )
    return false;
  // The member is a look only where its value decides control flow: a condition, a throw, or a
  // negation. A call's argument (`console.info(res.status)`) or a plain statement is not.
  if (parent === null) return false;
  switch (parent.type) {
    case "IfStatement":
    case "ConditionalExpression":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ThrowStatement":
    case "UnaryExpression":
      return true;
    case "LogicalExpression":
      return true;
    case "BinaryExpression":
      // `res.status === 200` is a comparison, which decides; `res.status + 1` is not.
      return ["===", "!==", "==", "!=", "<", "<=", ">", ">="].includes(parent.operator);
    default:
      return false;
  }
}

/** The node passes `name` whole to a function the compiler sees check its status. */
function passesToCheck(node: Node, name: string, seen: Seen, visited: Set<Node>): boolean {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return false;
  const index = node.arguments.findIndex((a) => a.type === "Identifier" && a.name === name);
  const f = index < 0 ? null : seen(node.callee.name);
  return f !== null && checksStatus(f.fn, index, f.seen, visited);
}

/** Whether `fn` looks at the status of its parameter at `index`, itself or through a function it passes it to. */
function checksStatus(fn: Fn, index: number, seen: Seen, visited: Set<Node>): boolean {
  if (visited.has(fn) || fn.body === null) return false;
  visited.add(fn);
  const param = fn.params[index];
  const p = param?.type === "AssignmentPattern" ? param.left : param;
  if (p === undefined || takesStatus(p)) return p !== undefined;
  if (p.type !== "Identifier") return false;
  const name = p.name;
  let found = false;
  // A look inside a callback that runs later, or not at all (`[1].forEach(() => { if (!res.ok) ... })`),
  // can't gate a read after it: the read is still unchecked. But a `.then` callback *is* the read's
  // path (its result is the promise's), so a look there counts. The walk descends into a `.then`
  // callback and stops at any other nested function.
  const descend = (node: Node, parent: Node | null): boolean => {
    if (node === fn.body) return true;
    if (!isFunction(node)) return true;
    return parent?.type === "CallExpression" && methodOf(parent) === "then";
  };
  walk(fn.body, (node, parent) => {
    if (found) return false;
    if (!descend(node, parent)) return false;
    if (looksAtStatus(node, name, parent) || passesToCheck(node, name, seen, visited)) found = true;
    return !found;
  });
  return found;
}

const isFetch = (node: Node): boolean =>
  node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "fetch";

/** The name a call calls, `name(...)`. */
const calleeName = (node: Node): string | null =>
  node.type === "CallExpression" && node.callee.type === "Identifier" ? node.callee.name : null;

/** The method a call calls, `object.method(...)`. */
const methodOf = (node: Node): string | null =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier"
    ? node.callee.property.name
    : null;

/** What a method call calls its method on: `object` in `object.method(...)`. */
const objectOf = (node: Node): Node | null =>
  node.type === "CallExpression" && node.callee.type === "MemberExpression" ? node.callee.object : null;

/** Whether `node` reads the variable `name` (a property's name isn't a read of it). */
function mentions(node: Node, name: string | null): boolean {
  let found = false;
  walk(node, (n, parent, key) => {
    const named =
      (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
      (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand);
    if (n.type === "Identifier" && n.name === name && !named) found = true;
    return !found;
  });
  return found;
}

/** Visit `root` and what it holds, outside the functions nested in it. */
function own(root: Node, visit: (node: Node) => void): void {
  walk(root, (n) => {
    if (n !== root && isFunction(n)) return false;
    visit(n);
    return true;
  });
}

/** Whether a statement leaves its block: a return or a throw, or a block that ends with one. */
const exits = (node: Node): boolean =>
  node.type === "ReturnStatement" ||
  node.type === "ThrowStatement" ||
  (node.type === "BlockStatement" && node.body.length > 0 && exits(node.body[node.body.length - 1]!));

/** An object literal that holds a `signal` (or a spread, which may). */
const holdsSignal = (o: ObjectExpression): boolean =>
  o.properties.some((p) => p.type === "SpreadElement" || keyName(p) === "signal");

/** Whether two reads can't both run: in two branches of one choice, or the first on a branch that exits. */
function exclusive(a: Node, b: Node, parents: ReadonlyMap<Node, Node>): boolean {
  const chain = [a];
  for (let p = parents.get(a); p !== undefined; p = parents.get(p)) chain.push(p);
  const above = new Set(chain);
  let child = b;
  let lca = parents.get(b);
  while (lca !== undefined && !above.has(lca)) {
    child = lca;
    lca = parents.get(lca);
  }
  const branches = (n: Node | undefined): Node[] =>
    n?.type === "IfStatement" || n?.type === "ConditionalExpression"
      ? [n.consequent, ...(n.alternate === null ? [] : [n.alternate])]
      : [];
  const other = chain[chain.indexOf(lca!) - 1]!;
  if (branches(lca).includes(child) && branches(lca).includes(other) && child !== other) return true;
  return chain
    .slice(0, chain.indexOf(lca!))
    .some((n) => exits(n) && branches(parents.get(n)).includes(n) && parents.get(n) !== lca);
}

/**
 * A response's body read with no look at its status before it, or read twice: the names bound to
 * a fetch's response, where each is looked at, and the reads.
 */
function checkBodies(body: Node, report: Report, seen: Seen, parents: ReadonlyMap<Node, Node>): void {
  const responses = new Set<string>();
  const assigned: { readonly name: string; readonly at: number }[] = [];
  // run's own functions, then the file's.
  const mine = new Map<string, Fn>();
  walk(body, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const init = node.init;
      if (init?.type === "AwaitExpression" && isFetch(init.argument)) responses.add(node.id.name);
      if (init !== null && isFunction(init)) mine.set(node.id.name, init);
    }
    if (node.type === "FunctionDeclaration" && node.id !== null) mine.set(node.id.name, node);
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      assigned.push({ name: node.left.name, at: node.start });
      if (node.right.type === "AwaitExpression" && isFetch(node.right.argument)) responses.add(node.left.name);
    }
    // fetch(...).then((res) => ...)
    const object = objectOf(node);
    if (methodOf(node) === "then" && node.type === "CallExpression" && object !== null && isFetch(object)) {
      const callback = node.arguments[0];
      const param = callback !== undefined && isFunction(callback) ? callback.params[0] : undefined;
      if (param?.type === "Identifier") responses.add(param.name);
    }
    return true;
  });
  const here: Seen = (name) => {
    const fn = mine.get(name);
    return fn === undefined ? seen(name) : { fn, seen: here };
  };
  // Where each response is looked at. A look inside a callback that runs later, or not at all,
  // can't gate a read on the task's own path, so the walk stops at a nested function — except a
  // `.then` callback, whose result is the promise's, so a look there is on the read's path.
  const looks = new Map<string, number[]>();
  walk(body, (node, parent) => {
    if (node !== body && isFunction(node) && !(parent?.type === "CallExpression" && methodOf(parent) === "then"))
      return false;
    for (const name of responses)
      if (looksAtStatus(node, name, parent) || passesToCheck(node, name, here, new Set()))
        looks.set(name, [...(looks.get(name) ?? []), node.start]);
    return true;
  });
  const fix = (name: string): string =>
    `if (!${name}.ok) throw new Error(\`HTTP \${${name}.status}\`), and let the task's error decide`;
  const reads = new Map<string, Node[]>();
  walk(body, (node) => {
    const object = objectOf(node);
    if (object === null || !BODY.has(methodOf(node) ?? "")) return true;
    const what = "a response read without checking its status takes a 404 or 500 page as a success";
    if (object.type === "AwaitExpression" && isFetch(object.argument))
      report(node, `${what}: name it and check it first, const res = await fetch(url, { signal }); ${fix("res")}`);
    else if (object.type === "Identifier" && responses.has(object.name)) {
      const name = object.name;
      reads.set(name, [...(reads.get(name) ?? []), node]);
      if (!(looks.get(name) ?? []).some((at) => at < node.start))
        report(node, `${what}: check ${name}.ok first, ${fix(name)}`);
    }
    return true;
  });
  // A body read twice on one path: the second read rejects (the body is used).
  for (const [name, all] of reads) {
    const twice = (b: Node, i: number): boolean =>
      all
        .slice(0, i)
        .some(
          (a) =>
            !exclusive(a, b, parents) && !assigned.some((s) => s.name === name && s.at > a.start && s.at < b.start),
        );
    const again = all.find(twice);
    if (again !== undefined)
      report(
        again,
        `the response's body is read twice, and the second read rejects: read it once into a const, const body = await ${name}.${methodOf(again)}(), and use the const`,
      );
  }
}

/** Whether `fn` returns a promise: it is async, or its return type says so. */
export function returnsPromise(fn: Fn, src: (node: Node) => string): boolean {
  const type = fn.returnType?.typeAnnotation;
  return fn.async || (type !== undefined && /^Promise\s*</.test(src(type)));
}

const CHAIN = new Set(["then", "catch", "finally"]);

/**
 * A promise run starts and doesn't wait for, a call as a statement of its own: `fetch(...)`, a
 * function `promises` says returns one (or run's own async function), or a `.then` chain. run
 * resolves before it settles, and its failure never reaches `error`.
 */
function checkFloating(body: Node, report: Report, promising: (call: Node) => string | null): void {
  walk(body, (node) => {
    if (node !== body && isFunction(node)) return false;
    if (node.type !== "ExpressionStatement" || node.expression.type !== "CallExpression") return true;
    const call = node.expression;
    const named = promising(call);
    const chain = CHAIN.has(methodOf(call) ?? "") ? methodOf(call) : null;
    if (named !== null)
      report(
        call,
        `${named}(...) returns a promise run doesn't wait for: run resolves before it settles, and its failure never reaches error. Await it: await ${named}(...)`,
      );
    else if (chain !== null)
      report(
        call,
        `this .${chain}(...) chain is a promise run doesn't wait for: run resolves before it settles, and its failure never reaches error. Await it (await ...${chain}(...)), or return it`,
      );
    return true;
  });
}

/** The file a task is in, for the rules that read its imports: its path, and its parsed program. */
export interface RunFile {
  readonly file: string;
  readonly program: Program;
}

/** What the rules over one `run` share. */
interface Run {
  readonly fn: Fn;
  readonly body: Node;
  readonly signal: string | null;
  readonly report: Report;
  readonly src: (node: Node) => string;
  readonly seen: Seen;
  /** The fix's wording: the signal's name, and how to take it when run doesn't. */
  readonly name: string;
  readonly take: string;
  /** Each node's parent, under `body`. */
  readonly parents: ReadonlyMap<Node, Node>;
  /** run's consts, by name, and what each holds. */
  readonly consts: ReadonlyMap<string, Node>;
  /** Every name run declares, in it or in a function nested in it. */
  readonly locals: ReadonlySet<string>;
  /** The names run's argument binds, but the signal. */
  readonly given: readonly string[];
  /** The file's imports, by local name. */
  readonly imports: ReadonlyMap<string, { readonly source: string; readonly imported: string }>;
  readonly file: string | null;
  /** The name a call calls, when it returns a promise. */
  readonly promising: (call: Node) => string | null;
}

/** The nearest function `node` is in: run's own, or one nested in it. */
function fnOf(r: Run, node: Node): Fn {
  for (let p = r.parents.get(node); p !== undefined; p = r.parents.get(p)) if (isFunction(p)) return p;
  return r.fn;
}

/**
 * Checks a task's `run`; `signal` is the name it binds `signal` to, if it does. `seen` finds the
 * functions the compiler can see by name (the file's, and relative imports' exports), and
 * `promises` says which of the names it can see return a promise. `at` is the file, for the rules
 * that read its imports (a server action's module, a client package's import).
 */
export function checkRun(
  fn: Fn,
  signal: string | null,
  report: Report,
  src: (node: Node) => string,
  seen: Seen,
  promises: (name: string) => boolean,
  at?: RunFile,
): void {
  const body = fn.body;
  if (body === null) return;
  const parents = new Map<Node, Node>();
  const consts = new Map<string, Node>();
  const locals = new Set<string>();
  const asyncs = new Set<string>();
  walk(fn, (node, parent) => {
    if (parent !== null && node !== body) parents.set(node, parent);
    if (node.type === "VariableDeclaration")
      for (const d of node.declarations) {
        for (const n of boundNames(d.id)) locals.add(n);
        if (d.id.type === "Identifier" && d.init !== null) {
          if (node.kind === "const") consts.set(d.id.name, d.init);
          if (isFunction(d.init) && returnsPromise(d.init, src)) asyncs.add(d.id.name);
        }
      }
    if (isFunction(node)) for (const p of node.params) for (const n of boundNames(p)) locals.add(n);
    if (node.type === "FunctionDeclaration" && node.id !== null) locals.add(node.id.name);
    if (node.type === "CatchClause" && node.param !== null) for (const n of boundNames(node.param)) locals.add(n);
    if (node.type === "ClassDeclaration" && node.id !== null) locals.add(node.id.name);
    return true;
  });
  const imports = new Map<string, { readonly source: string; readonly imported: string }>();
  for (const s of at?.program.body ?? [])
    if (s.type === "ImportDeclaration")
      for (const i of s.specifiers)
        imports.set(i.local.name, {
          source: s.source.value,
          imported: i.type === "ImportSpecifier" ? importedName(i) : "default",
        });
  const r: Run = {
    fn,
    body,
    signal,
    report,
    src,
    seen,
    name: signal ?? "signal",
    take: signal === null ? ` (take it: run: async ({ data, signal }) => ...)` : "",
    parents,
    consts,
    locals,
    given: fn.params[0] === undefined ? [] : boundNames(fn.params[0]).filter((n) => n !== signal),
    imports,
    file: at?.file ?? null,
    promising: (call) => {
      const n = calleeName(call);
      return n !== null && (n === "fetch" || asyncs.has(n) || promises(n)) ? n : null;
    },
  };
  checkBodies(body, report, seen, parents);
  checkFloating(body, report, r.promising);
  checkLasting(r);
  checkSignals(r);
  checkPromises(r);
  checkErrors(r);
  checkData(r);
  checkStub(r);
  // Outside data taken on trust: a cast in the event run resolves to.
  for (const e of returned(body))
    walk(e, (node) => {
      if (isFunction(node)) return false;
      const kind = hides(node, src);
      if (kind !== null)
        report(
          node,
          `a ${kind === "cast" ? "cast" : "non-null assertion (!)"} in the event run resolves to takes outside data on trust: check the value (a schema, or a typeof test), and build the event from what you checked`,
        );
      return true;
    });
}

type Lasting = "interval" | "timeout" | "socket" | "listener" | "request" | "media";

/** Work that outlives the state when nothing ends it on the signal's abort, and a catch that resolves to an event. */
function checkLasting(r: Run): void {
  const { signal, report, src, name, take } = r;
  // What run does, collected first: the cleanup may come after the resource.
  let cleanup = false;
  const lasting: { at: Node; what: Lasting; name: string }[] = [];
  walk(r.body, (node) => {
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property.type === "Identifier" &&
      node.property.name === "onabort" &&
      node.object.type === "Identifier" &&
      node.object.name === signal
    )
      cleanup = true;
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      const n = node.callee.name;
      if (n === "WebSocket" || n === "EventSource") lasting.push({ at: node, what: "socket", name: n });
      if (n === "XMLHttpRequest") {
        const d = r.parents.get(node);
        lasting.push({
          at: node,
          what: "request",
          name: d?.type === "VariableDeclarator" && d.id.type === "Identifier" ? d.id.name : "xhr",
        });
      }
      if (n === "AbortController")
        report(
          node,
          `run already gets a signal, aborted when the state exits: use it${take}. A timeout is after on the state: after: { "5s": ({ to }) => to("failed", { ... }) }`,
        );
    }
    if (node.type === "ThrowStatement") {
      const t = node.argument.type;
      if (t === "Literal" || t === "TemplateLiteral" || t === "ObjectExpression" || t === "ArrayExpression")
        report(
          node,
          'throw an Error, not a plain value: the task\'s error gets it, and String(error) of an object is "[object Object]". throw new Error("...")',
        );
    }
    if (node.type === "CatchClause")
      for (const e of returned(node.body))
        if (isEvent(e))
          report(
            e,
            "a catch in run that resolves to an event turns a failure into a success: the task's error never runs. Let it throw, and decide the failure in error: ({ error, to }) => to(...)",
          );
    if (node.type !== "CallExpression") return true;
    const callee = node.callee;
    if (callee.type === "Identifier") {
      if (callee.name === "fetch") {
        const options = node.arguments[1];
        const given = options !== undefined && (options.type !== "ObjectExpression" || holdsSignal(options));
        if (!given)
          report(
            node,
            `fetch without the signal keeps going after the state exits: pass run's signal, fetch(url, { ${name} })${take}`,
          );
        // Bun's RequestInit declares `timeout` (the socket's idle timer), so the type checker takes it.
        const timeout =
          options?.type === "ObjectExpression"
            ? options.properties.find((p) => p.type === "Property" && keyName(p) === "timeout")
            : undefined;
        if (timeout !== undefined)
          report(
            timeout,
            `fetch has no timeout option: a browser ignores it, and Bun's is the socket's idle timer, not a deadline. The task's timeout is after on its state: after: { "5s": ({ to }) => to("failed", { ... }) }. For the request alone: fetch(url, { signal: AbortSignal.any([${name}, AbortSignal.timeout(5000)]) })`,
          );
      }
      if (callee.name === "setInterval") lasting.push({ at: node, what: "interval", name: "setInterval" });
      // node:timers/promises' setTimeout takes the signal in its options.
      if (callee.name === "setTimeout" && !node.arguments.some((a) => a.type === "ObjectExpression" && holdsSignal(a)))
        lasting.push({ at: node, what: "timeout", name: "setTimeout" });
      if (/^use[A-Z0-9]/.test(callee.name))
        report(
          node,
          `${callee.name} is a hook: it runs only in a component's render. In run, call what the hook wraps (fetch the data with the signal)`,
        );
      return true;
    }
    const method = methodOf(node);
    if (method === null || callee.type !== "MemberExpression") return true;
    const onSignal = callee.object.type === "Identifier" && callee.object.name === signal;
    if (method === "addEventListener" && onSignal) cleanup = true;
    else if (method === "addEventListener") {
      const options = node.arguments[2];
      if (!(options?.type === "ObjectExpression" && holdsSignal(options)))
        lasting.push({ at: node, what: "listener", name: src(callee.object) });
    }
    const lock = callee.object.type === "MemberExpression" && src(callee.object.property) === "wakeLock";
    if (method === "getUserMedia" || method === "getDisplayMedia" || (method === "request" && lock))
      lasting.push({ at: node, what: "media", name: method === "request" ? "wakeLock.request" : method });
    if (method === "forEach" && node.arguments.some((a) => isFunction(a) && a.async))
      report(
        node,
        "forEach doesn't wait for an async callback: run resolves before the work ends, and its errors are lost. Use for (const x of xs) await ..., or await Promise.all(xs.map(async (x) => ...))",
      );
    if (method === "catch")
      for (const a of node.arguments)
        if (isFunction(a) && a.body !== null && returned(a.body).some(isEvent))
          report(
            a,
            "a .catch in run that resolves to an event turns a failure into a success: the task's error never runs. Let it reject, and decide the failure in error: ({ error, to }) => to(...)",
          );
    return true;
  });

  const on = (what: string): string => `${name}.addEventListener("abort", () => ${what})${take}`;
  const fixes: { readonly [W in Lasting]: (n: string) => string } = {
    interval: () =>
      `setInterval in run keeps going after the state exits: clear it when the signal aborts, ${on("clearInterval(id)")}. Or poll with after on the state`,
    timeout: () =>
      `setTimeout in run outlives a cancel: wait with after on a state, after: { "5s": ({ to }) => to(...) } (or clear it on the signal's abort, ${on("clearTimeout(id)")})`,
    socket: (n) =>
      `new ${n} in run stays open after the state exits: close it when the signal aborts, ${on("socket.close()")}. For a stream of events, use a callback child`,
    listener: (n) =>
      `${n}.addEventListener in run keeps listening after the state exits: pass the signal, ${n}.addEventListener(type, listener, { ${name} })${take}`,
    request: (n) =>
      `the XMLHttpRequest isn't aborted on cancel: call ${n}.abort() on the signal's abort, ${on(`${n}.abort()`)}, or use fetch with the signal`,
    media: (n) =>
      `${n}'s ${n === "wakeLock.request" ? "lock isn't released" : "stream isn't stopped"} on cancel: ${n === "wakeLock.request" ? "release it" : "stop its tracks"} on the signal's abort, ${on(n === "wakeLock.request" ? "lock.release()" : "stream.getTracks().forEach((t) => t.stop())")}, or run it as a callback child`,
  };
  if (!cleanup) for (const l of lasting) report(l.at, fixes[l.what](l.name));
}

/** Request libraries whose calls take a `signal` option: by their usual name, or by their package. */
const CLIENTS = new Set(["axios", "ky", "got", "ofetch", "$fetch", "redaxios", "graphql-request"]);
const REQUESTS = new Set(["request", "get", "post", "put", "patch", "delete", "head", "options", "raw"]);

/** `"use server"` as a module's first statement: after comments only. */
const SERVER = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(["'])use server\1/;
const servers = new Map<string, boolean>();

/** Whether the relative import `specifier` (from `file`) is a module of server actions. */
function serverModule(file: string, specifier: string): boolean {
  const path = resolveImport(file, specifier);
  if (path === null) return false;
  let marked = servers.get(path);
  if (marked === undefined) {
    marked = existsSync(path) && SERVER.test(readFileSync(path, "utf8"));
    servers.set(path, marked);
  }
  return marked;
}

/** Whether `fn` fetches: itself, or through a function it calls that the compiler sees. */
function fetches(fn: Fn, seen: Seen, visited: Set<Node>): boolean {
  if (visited.has(fn) || fn.body === null) return false;
  visited.add(fn);
  let found = false;
  walk(fn.body, (node) => {
    const f = isFetch(node) ? null : seen(calleeName(node) ?? "");
    if (isFetch(node) || (f !== null && fetches(f.fn, f.seen, visited))) found = true;
    return !found;
  });
  return found;
}

/** The work run starts is given run's signal: fetch's, a helper's, a client's; and what can't take it. */
function checkSignals(r: Run): void {
  const { report, src, name, take } = r;
  /** A signal that is run's, or made from it (`AbortSignal.any([signal, ...])`); a name run doesn't bind may be. */
  const fromSignal = (v: Node): boolean => {
    const held = v.type === "Identifier" ? r.consts.get(v.name) : v;
    return held === undefined || mentions(held, r.signal);
  };
  const passes = (a: Node): boolean => mentions(a, r.signal) || (a.type === "ObjectExpression" && holdsSignal(a));
  walk(r.body, (node) => {
    if (node.type !== "CallExpression") return true;
    const called = calleeName(node);
    const options = node.arguments[1];
    if (called === "fetch" && options?.type === "ObjectExpression") {
      const given = options.properties.find((p) => p.type === "Property" && keyName(p) === "signal");
      if (given?.type === "Property" && !fromSignal(given.value))
        report(
          given.value,
          `fetch's signal isn't run's, so the request goes on after the state exits: pass ${name} (or AbortSignal.any([${name}, AbortSignal.timeout(5000)]))${take}`,
        );
    }
    const held = called === "fetch" && options?.type === "Identifier" ? r.consts.get(options.name) : undefined;
    if (held?.type === "ObjectExpression" && !holdsSignal(held))
      report(
        options!,
        `the fetch's options don't hold run's signal, so the request goes on after the state exits: write { ...${src(options!)}, ${name} }${take}`,
      );
    const f = called === null || called === "fetch" ? null : r.seen(called);
    if (f !== null && fetches(f.fn, f.seen, new Set()) && !node.arguments.some(passes))
      report(
        node,
        `${called} fetches without run's signal, so its request goes on after the state exits: pass ${name} to it, and to its fetch${take}`,
      );
    // A client's request: `axios.post(url, body)`, `ky(url)`, `request(url, document)`.
    const object = objectOf(node);
    const client = called ?? (object?.type === "Identifier" && REQUESTS.has(methodOf(node) ?? "") ? object.name : "");
    const known = CLIENTS.has(client) || CLIENTS.has(r.imports.get(client)?.source ?? "");
    if (known && !node.arguments.some(passes))
      report(
        node,
        `${src(node.callee)} without run's signal keeps going after the state exits: pass it in its options, { ${name} }${take}`,
      );
    // A server action: `"use server"` in it, or atop the module it's imported from.
    const fnBody = f?.fn.body;
    const first = fnBody?.type === "BlockStatement" ? fnBody.body[0] : undefined;
    const imported = r.imports.get(called ?? "");
    const inline = first?.type === "ExpressionStatement" && stringValue(first.expression) === "use server";
    if (inline || (imported !== undefined && r.file !== null && serverModule(r.file, imported.source)))
      report(
        node,
        `${called} is a server action, which takes no signal (and actions run one at a time): call a route with fetch and the signal, fetch(url, { method: "POST", body, ${name} })${take}`,
      );
    const durable = imported?.source === "@reactre/state/durable" ? imported.imported : called;
    const machine = node.arguments[0]?.type === "Identifier" ? node.arguments[0].name : "machine";
    if (durable === "durable")
      report(
        node,
        `a durable run started in a task isn't stopped with it, nor journaled under this run: run it as a child, children: { ${machine} } in setup (use: [children]) and the state's children: { ${machine}: { done: ({ output, to }) => to(...) } }, so the host runs it inside this one`,
      );
    return true;
  });
}

/** Array methods that test their callback's result: an async callback's promise is always truthy. */
const TESTS = new Map([
  ["filter", "every item passes"],
  ["some", "it is always true"],
  ["every", "it is always true"],
  ["find", "it finds the first item"],
  ["findLast", "it finds the last item"],
  ["findIndex", "it finds index 0"],
  ["findLastIndex", "it finds the last index"],
]);
/** What schedules a callback outside run's promise. */
const SCHEDULERS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
  "nextTick",
]);
const LISTENS = new Set(["addEventListener", "addListener", "on", "once", "subscribe"]);

/** What a function nested in run is to its caller: a scheduled callback, or a listener. */
function roleOf(r: Run, f: Fn): string | null {
  const p = r.parents.get(f);
  if (p?.type === "AssignmentExpression" && p.right === f && /^on[a-z]/.test(r.src(p.left).split(".").pop() ?? ""))
    return `the ${r.src(p.left)} handler`;
  if (p?.type !== "CallExpression" || !p.arguments.includes(f)) return null;
  const n = calleeName(p) ?? methodOf(p) ?? "";
  return SCHEDULERS.has(n) ? `a ${n} callback` : LISTENS.has(n) ? "a listener" : null;
}

/** run awaits what it starts, and its promise settles with the work. */
function checkPromises(r: Run): void {
  const { report, src } = r;
  const rejects = new Set<string>();
  walk(r.body, (node) => {
    if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Promise") {
      const executor = node.arguments[0];
      if (executor !== undefined && isFunction(executor)) {
        if (executor.async)
          report(
            node,
            "new Promise(async ...) drops a throw in its executor, and the task never ends: await the work in run itself, without the Promise",
          );
        const reject = executor.params[1];
        if (reject?.type === "Identifier") rejects.add(reject.name);
      }
    }
    // A plain value rejected: `Promise.reject("empty")`, `reject({ status })`.
    const plain = node.type === "CallExpression" ? node.arguments[0] : undefined;
    const rejecting =
      node.type === "CallExpression" &&
      (rejects.has(calleeName(node) ?? "") || (methodOf(node) === "reject" && src(node.callee) === "Promise.reject"));
    if (
      rejecting &&
      (plain?.type === "Literal" ||
        plain?.type === "TemplateLiteral" ||
        plain?.type === "ObjectExpression" ||
        plain?.type === "ArrayExpression")
    )
      report(
        node,
        `${src(node)} rejects with ${plain.type === "ObjectExpression" ? "an object" : "a plain value"}, not an Error: String(error) is "[object Object]" or the bare text, with no stack. Reject with an Error, ${src(node.callee)}(new Error(${stringValue(plain) === null ? '"..."' : src(plain)}))`,
      );
    const method = methodOf(node) ?? "";
    const test = node.type === "CallExpression" ? node.arguments[0] : undefined;
    if (TESTS.has(method) && test !== undefined && isFunction(test) && test.async)
      report(
        node,
        `${method}'s callback is async, so it returns a promise, which is always truthy: ${TESTS.get(method)}. Await the checks first, const ok = await Promise.all(xs.map(async (x) => ...)), then ${method} by them`,
      );
    if (node.type === "ForOfStatement" && node.await) {
      const right = node.right.type === "Identifier" ? (r.consts.get(node.right.name) ?? node.right) : node.right;
      if (right.type === "ArrayExpression" || methodOf(right) === "map")
        report(
          node,
          "for await over an array of promises starts them all at once, and one that rejects before its turn is unhandled: await Promise.all(...), then loop over the results",
        );
    }
    if (methodOf(node) === "allSettled") {
      let use = r.parents.get(node);
      while (use?.type === "AwaitExpression") use = r.parents.get(use);
      const unread =
        use?.type === "ExpressionStatement" ||
        (use?.type === "UnaryExpression" && use.operator === "void") ||
        (use?.type === "VariableDeclarator" && !/\bstatus\b/.test(src(r.body)));
      if (unread)
        report(
          node,
          "allSettled's results are unused, so a failure reads as success: read each result's status, and throw if one is \"rejected\" (or await Promise.all, which rejects)",
        );
    }
    // A retry: a loop around a try that awaits, and leaves on success.
    if (node.type === "ForStatement" || node.type === "WhileStatement" || node.type === "DoWhileStatement") {
      let retries = false;
      own(node.body, (t) => {
        if (t.type !== "TryStatement" || t.handler === null) return;
        let awaits = false;
        let leaves = false;
        own(t.block, (n) => {
          awaits ||= n.type === "AwaitExpression";
          leaves ||= n.type === "ReturnStatement" || n.type === "BreakStatement";
        });
        retries ||= awaits && leaves;
      });
      if (retries)
        report(
          node,
          "a retry loop in run: the attempts are hidden from the machine, lost on a restore, and a cancel waits out the backoff. Retries are states: a failed state, after on it, and the attempt in its data",
        );
    }
    if (node.type === "TryStatement") {
      if (node.handler !== null && fnOf(r, node).async)
        own(node.block, (n) => {
          const called = n.type === "ReturnStatement" && n.argument !== null ? r.promising(n.argument) : null;
          if (called !== null)
            report(
              n,
              `return ${called}(…) in try isn't caught there: the promise is returned before it rejects, so the catch never runs. return await ${called}(…)`,
            );
        });
      if (node.finalizer !== null)
        own(node.finalizer, (n) => {
          if (n.type === "ReturnStatement" || n.type === "ThrowStatement")
            report(
              n,
              `a ${n.type === "ReturnStatement" ? "return" : "throw"} in finally replaces the try's result or its error: move it after the try`,
            );
        });
    }
    // A throw outside run's promise: in a scheduled callback or a listener, not caught there.
    if (node.type === "ThrowStatement") {
      const f = fnOf(r, node);
      const role = f === r.fn ? null : roleOf(r, f);
      let caught = false;
      for (let c: Node = node, p = r.parents.get(c); p !== undefined && c !== f; c = p, p = r.parents.get(p))
        caught ||= p.type === "TryStatement" && p.block === c && p.handler !== null;
      if (role !== null && !caught)
        report(
          node,
          `a throw in ${role} doesn't reach run, so the task's error never runs: reject the promise run awaits, new Promise((resolve, reject) => ...), and reject(new Error(...)) there`,
        );
    }
    return true;
  });
}

/** A failure keeps its Error: thrown, typed unknown, with its cause. */
function checkErrors(r: Run): void {
  const { report, src } = r;
  walk(r.body, (node) => {
    if (node.type === "ThrowStatement") {
      const a = node.argument;
      const text =
        (a.type === "CallExpression" && calleeName(a) === "String") ||
        (a.type === "MemberExpression" && /\.(?:message|statusText)$/.test(src(a))) ||
        (a.type === "BinaryExpression" && a.operator === "+");
      if (text)
        report(
          node,
          `a throw of a string drops the stack and the cause: throw new Error(${src(a)}), with { cause: e } when it rethrows a caught e`,
        );
      if (a.type === "AwaitExpression")
        report(
          node,
          'a throw of an awaited value isn\'t an Error: it has no stack, and String(error) may be "[object Object]". Read it into a const, and throw new Error("...", { cause: body })',
        );
    }
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "NewExpression" &&
      /Error$/.test(src(node.expression.callee))
    )
      report(
        node,
        `new ${src(node.expression.callee)}(…) without throw does nothing: throw it, throw ${src(node.expression)}`,
      );
    if (node.type === "CatchClause") {
      const param = node.param?.type === "Identifier" ? node.param : null;
      if (node.body.body.length === 0 && !/\/[/*]/.test(src(node.body)))
        report(
          node,
          "an empty catch turns a failure into a success: let it throw, or say in a comment in it why the failure can be ignored",
        );
      if (param?.typeAnnotation?.typeAnnotation.type === "TSAnyKeyword")
        report(
          param,
          `catch (${param.name}: any) turns off the check that a caught value is unknown: leave the type out, and narrow it, ${param.name} instanceof Error ? ${param.name}.message : String(${param.name})`,
        );
      if (node.param === null || (param !== null && !mentions(node.body, param.name)))
        own(node.body, (t) => {
          if (
            t.type === "ThrowStatement" &&
            t.argument.type === "NewExpression" &&
            /Error$/.test(src(t.argument.callee))
          )
            report(
              t,
              `the new Error drops the caught one, its stack and its cause: ${param === null ? "catch (e), and " : ""}pass { cause: ${param?.name ?? "e"} }, new Error("...", { cause: ${param?.name ?? "e"} })`,
            );
        });
    }
    const method = methodOf(node);
    const onRejected = node.type === "CallExpression" ? node.arguments[method === "then" ? 1 : 0] : undefined;
    const p = onRejected !== undefined && isFunction(onRejected) ? onRejected.params[0] : undefined;
    if ((method === "catch" || method === "then") && p?.type === "Identifier" && p.typeAnnotation === null) {
      let read = false;
      walk(onRejected!, (n) => {
        read ||= n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === p.name;
        return !read;
      });
      if (read)
        report(
          p,
          `the .${method} callback's ${p.name} is any, so reading ${p.name}.message is unchecked: write (${p.name}: unknown) and narrow it, ${p.name} instanceof Error ? ${p.name}.message : String(${p.name})`,
        );
    }
    return true;
  });
}

const EQUALS = new Set(["===", "!==", "==", "!="]);
/** A Date's methods whose text is local, or can't be parsed back. */
const LOCAL_TEXT = new Set([
  "toString",
  "toLocaleString",
  "toDateString",
  "toTimeString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);
const ID = /^(?:id|token|key|code|nonce|uuid)$|Id$/;
/** Secret keys by their makers' prefixes: Stripe, GitHub, Slack, AWS, Anthropic, OpenAI. */
const SECRET =
  /\b(?:[sr]k_live_\w{8,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|sk-(?:ant|proj)-[\w-]{10,})/;
/** Types a `{}` may be cast to without skipping a field: every key is optional in them. */
const LOOSE = new Set(["Record", "Partial"]);

/** Whether a type mentions the type parameter `name`: TypeScript's nodes, searched by hand (`walk` skips them). */
function typeMentions(node: unknown, name: string): boolean {
  if (typeof node !== "object" || node === null) return false;
  const typeName: unknown = Reflect.get(node, "typeName");
  if (Reflect.get(node, "type") === "TSTypeReference" && identifierName(typeName) === name) return true;
  return Object.values(node).some((v) => typeMentions(v, name));
}
const identifierName = (n: unknown): unknown =>
  typeof n === "object" && n !== null && Reflect.get(n, "type") === "Identifier" ? Reflect.get(n, "name") : null;

/** What run reads and writes: the data it trusts, the event it builds, and what isn't its own. */
function checkData(r: Run): void {
  const { report, src } = r;
  walk(r.body, (node) => {
    if (node.type === "Property" && keyName(node) === "mode" && stringValue(node.value) === "no-cors")
      report(
        node,
        'mode: "no-cors" gives an opaque response: no status, no headers, no body, so the task can\'t tell a failure. Leave it out, and let the server allow the origin (CORS)',
      );
    // An Idempotency-Key made in run: `{ "Idempotency-Key": crypto.randomUUID() }`, `headers.set(...)`.
    const key =
      node.type === "Property" && keyName(node)?.toLowerCase() === "idempotency-key"
        ? node.value
        : (methodOf(node) === "set" || methodOf(node) === "append") &&
            node.type === "CallExpression" &&
            stringValue(node.arguments[0])?.toLowerCase() === "idempotency-key"
          ? node.arguments[1]
          : undefined;
    let made = false;
    if (key !== undefined && !r.given.some((n) => mentions(key, n)))
      walk(key, (n) => {
        made ||= n.type === "CallExpression" || n.type === "NewExpression";
        return !made;
      });
    if (made)
      report(
        key!,
        "the Idempotency-Key is new on each run, so a retry is a new write: make the key where the job is made, put it in the state's data, and read it from data",
      );
    if (node.type === "BinaryExpression" && EQUALS.has(node.operator)) {
      const [a, b] = [node.left, node.right];
      const status = (s: Node, v: Node): boolean =>
        v.type === "Literal" && v.value === 200 && (src(s) === "status" || /\.status$/.test(src(s)));
      const s = status(a, b) ? a : status(b, a) ? b : null;
      if (s !== null)
        report(
          node,
          `${src(node)} fails a 201 or a 204, which are successes too: check ${s.type === "MemberExpression" ? src(s.object) : "res"}.ok (any 2xx)`,
        );
      const env = /^(?:process\.env|Bun\.env|import\.meta\.env)(?:\.|\[["'])(?:NODE_ENV|MODE)\b/;
      if ((env.test(src(a)) && stringValue(b) === "test") || (env.test(src(b)) && stringValue(a) === "test"))
        report(
          node,
          'run checks NODE_ENV for "test": give the test a fake through provide or the module (useSave(fake)), not a branch that returns a canned success',
        );
    }
    const text = node.type === "Literal" ? stringValue(node) : node.type === "TemplateElement" ? node.value.raw : null;
    if (text !== null && SECRET.test(text))
      report(
        node,
        "a secret key is written in run, so it ships in the bundle: read it on the server (a route that adds it to the request), never in the client's code",
      );
    // A write to a name run doesn't declare: a module variable, which every actor shares.
    const target =
      node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : null;
    if (target?.type === "Identifier" && !r.locals.has(target.name))
      report(
        node,
        `run writes ${target.name}, a module variable every actor shares: return the value in its event, and keep it in the next state's data`,
      );
    const to = methodOf(node) === "send" ? objectOf(node) : null;
    const sent = node.type === "CallExpression" ? node.arguments[0] : undefined;
    if (to?.type === "Identifier" && !r.locals.has(to.name) && sent !== undefined && isEvent(sent))
      report(
        node,
        "run sends to the actor: a task resolves to one event (return it), and the actor may have stopped. Send progress from a callback child: const progress = createCallbackLogic(...) (@reactre/state/logic), and children: { progress } in setup",
      );
    // A function whose type parameter only its result has: `getJson<T>(url): Promise<T>` casts.
    const f = r.seen(calleeName(node) ?? "");
    for (const t of f?.fn.typeParameters?.params ?? [])
      if (typeMentions(f!.fn.returnType, t.name.name) && !typeMentions(f!.fn.params, t.name.name))
        report(
          node,
          `${calleeName(node)}<${t.name.name}> casts its result to ${t.name.name}: nothing checks it. Parse it with a schema (validate's, or a typeof test), and let the schema give the type`,
        );
    if (
      (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
      node.expression.type === "ObjectExpression" &&
      node.expression.properties.length === 0
    ) {
      const t = node.typeAnnotation;
      const strict =
        t.type === "TSTypeLiteral"
          ? t.members.some((m) => m.type === "TSPropertySignature" && !m.optional)
          : t.type === "TSTypeReference" && !LOOSE.has(src(t.typeName));
      if (strict)
        report(
          node,
          `{} as ${src(t)} in run skips the check that every field is there: write the event as a literal, return { type: ..., ... }, with each field's value`,
        );
    }
    return true;
  });
  // What the event holds: a date as text, an id that can collide.
  for (const e of returned(r.body))
    own(e, (node) => {
      const method = methodOf(node) ?? "";
      const object = objectOf(node);
      const held = object?.type === "Identifier" ? r.consts.get(object.name) : object;
      if (LOCAL_TEXT.has(method) && held?.type === "NewExpression" && src(held.callee) === "Date")
        report(
          node,
          `Date's ${method} is local, unparseable text: write ${src(object!)}.toISOString(), which any clock reads back`,
        );
      if (
        node.type === "Property" &&
        ID.test(keyName(node) ?? "") &&
        /\b(?:Date\.now|Math\.random)\(/.test(src(node.value))
      )
        report(
          node,
          `an id from Date.now or Math.random can collide, and can be guessed: use the server's id (what the call returns), or crypto.randomUUID()`,
        );
    });
}

/** What does work in a run: a wait, a call, a construction. */
const WORK = new Set([
  "AwaitExpression",
  "CallExpression",
  "NewExpression",
  "TaggedTemplateExpression",
  "ImportExpression",
]);

/** A value written as constants: literals, and arrays and objects of them. */
function constant(node: Node): boolean {
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") return constant(node.expression);
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression") return node.argument.type === "Literal";
  if (node.type === "ArrayExpression") return node.elements.every((e) => e !== null && constant(e));
  return (
    node.type === "ObjectExpression" &&
    node.properties.every((p) => p.type === "Property" && !p.computed && constant(p.value))
  );
}

/**
 * A stub (M461): an async run that waits on nothing, calls nothing and reads nothing it is given,
 * and resolves to an event written as constants. It reports a success the task never earned.
 */
function checkStub(r: Run): void {
  const { fn, body } = r;
  if (!fn.async) return;
  let works = fn.params.some((p) => boundNames(p).some((n) => mentions(body, n)));
  walk(body, (node) => {
    works ||= WORK.has(node.type);
    return !works;
  });
  const events = returned(body);
  if (works || events.length === 0 || !events.every((e) => isEvent(e) && constant(e))) return;
  r.report(
    fn,
    "run does no work: it resolves to the same event every time, so the task reports a success it never earned. Do the work with what run is given, await fetch(url, { signal }) with the state's data, and build the event from its result (a test fakes the function run calls, not run)",
  );
}

/** An event written in place: an object literal with a `type`. */
function isEvent(node: Node): boolean {
  return (
    node.type === "ObjectExpression" && node.properties.some((p) => p.type === "Property" && keyName(p) === "type")
  );
}
