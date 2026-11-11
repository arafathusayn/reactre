// effects's compiler: `entry` and `exit` compile to `b` (`{ node: [entry, exit] }`), each reference to
// a handler's `enq` to the feature's recorder, and a machine that records effects gets the step that
// records (`y: effects.y(inner)`) and the dispatcher, from the runner maps of the features in use
// (`r: effects.l(__run(runners, effects.d([effects.q, emit.q])))`, `l` settling the lifecycle's own
// moves). A final state's `entry` compiles too (the core hands it here: ../index.ts).
//
// `enq` with the methods other features add (emit's `emit`, spawn's `spawn`) is built once per
// shape, from the features setup's `use` lists: `const __reactreStateEnq_<shape> = effects.w([emit])`.
// A machine that records nothing gets none of it, so listing effects costs it nothing.
//
// What it checks, that types can't: `entry` and `exit` are functions written in place, and pure
// (the core's handler check: ../index.ts). A function handed to `enq` is the effect, and isn't
// checked; `enq` used inside one is reported there (../index.ts, `visit`). And `enq.cancel(id)`
// cancels something (M102): its id is one a raise or send of the same machine gives
// (`enq.raise(event, { delay, id })`, in any of its handlers), which is a call in a handler's body,
// not a type. So a cancel's id is written in place, a string, and so are the options and the id
// of every raise and send in a machine that cancels.

//
// And across a machine's handlers, from the file (`file`, read with ./read.ts), what their effects
// do that no type follows: a raise that loops in a state that stays (M502), a delayed raise that
// outlives its state (M512, M513), a raise no state will handle (M514, M515), a raise cancelled
// where it is made (M517), an emit in the start state's entry (M508), a callback enqueued twice
// (M509), an emitted event nothing emits (M516); and in an effect's body, what an effect may do
// but not this way: open what nothing closes (M503, M504), write a module variable (M505), read an
// actor's snapshot (M506), swallow or drop a failure (M510, M511), mutate the data (M518).

import type { CallExpression, Node } from "oxc-parser";

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { exportedFunction } from "../modules.ts";
import { boundNames, isFunction, keyName, rootName, stringValue } from "../syntax.ts";
import { duration } from "./delays.ts";
import {
  calleeName,
  eventType,
  factsOf,
  type FileFacts,
  type FileMachine,
  type Fn,
  fnOf,
  type Handler,
  handlerOf,
  handlersOf,
  handles,
  handlesHere,
  optionsOf,
  type Placed,
  propsOf,
  walkUp,
} from "./read.ts";

/** An effect: the function `enq(fn, ...args)` or `enq.effect(fn)` runs, with the arguments it is given. */
interface Effect {
  readonly fn: Fn;
  readonly args: readonly Node[];
  readonly via: "enq" | "enq.effect";
}

function effectsIn(h: Handler): Effect[] {
  return h.enq.flatMap(({ method, call }) => {
    const fn = fnOf(call.arguments[0]);
    if (fn === null || (method !== null && method !== "effect")) return [];
    return [{ fn, args: call.arguments.slice(1), via: method === null ? "enq" : "enq.effect" }];
  });
}

/** `enq.effect`'s function returns a cleanup: a function, or a name (`return stop`). */
function cleansUp(fn: Fn): boolean {
  const body = fn.body;
  if (body === null) return false;
  if (body.type !== "BlockStatement") return isFunction(body) || body.type === "Identifier";
  let found = false;
  walkUp(body, (node) => {
    if (isFunction(node)) return false;
    if (node.type === "ReturnStatement" && node.argument !== null)
      found ||= isFunction(node.argument) || node.argument.type === "Identifier";
    return true;
  });
  return found;
}

/** What an effect opens that stays open, by the call that opens it. */
const OPENS: readonly (readonly [match: (name: string, isNew: boolean) => boolean, what: string])[] = [
  [(n, isNew) => isNew && ["WebSocket", "EventSource", "BroadcastChannel"].includes(n), "a socket"],
  [(n, isNew) => isNew && ["Worker", "SharedWorker"].includes(n), "a worker"],
  [(n) => n === "addEventListener" || n.endsWith(".addEventListener"), "a listener"],
  [(n) => n === "setInterval" || n.endsWith(".setInterval"), "an interval"],
  [(n) => n.endsWith(".subscribe"), "a subscription"],
  [(n) => n.endsWith(".getUserMedia") || n.endsWith(".watchPosition"), "a device stream"],
];
const SCHEDULES = new Set(["setTimeout", "requestAnimationFrame", "requestIdleCallback"]);
const WRITERS = new Set([
  "Object.assign",
  "Object.defineProperty",
  "Object.setPrototypeOf",
  "Reflect.set",
  "Reflect.deleteProperty",
  "Reflect.defineProperty",
]);

/** Checks one effect's body: what it opens, writes, reads and drops. */
function checkEffect(effect: Effect, h: Handler, file: FileFacts, ctx: FileContext): void {
  const { report, src } = ctx;
  const { fn, args, via } = effect;
  if (fn.body === null) return;
  const own = new Set(fn.params.flatMap((p) => boundNames(p)));
  walkUp(fn.body, (node) => {
    if (node.type === "VariableDeclarator") for (const n of boundNames(node.id)) own.add(n);
    if (isFunction(node)) for (const p of node.params) for (const n of boundNames(p)) own.add(n);
    return true;
  });
  // The names that hold the handler's data or event: theirs, and a parameter given one (`enq((items) => ..., data.items)`).
  const held = new Map<string, string>();
  for (const k of ["data", "event"]) {
    const n = h.names.get(k);
    if (n !== undefined && !own.has(n)) held.set(n, n);
  }
  fn.params.forEach((p, i) => {
    const arg = args[i];
    const root = arg === undefined ? null : rootName(arg);
    if (p.type === "Identifier" && arg !== undefined && root !== null && [...held.keys()].includes(root))
      held.set(p.name, src(arg));
  });
  const heldAt = (target: Node): string | null => {
    const root = rootName(target);
    if (root === null || !held.has(root)) return null;
    return target.type === "Identifier" ? (held.get(root) ?? root) : src(target);
  };
  const cleanup = via === "enq.effect" && cleansUp(fn);
  walkUp(fn.body, (node) => {
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const name = calleeName(node) ?? "";
      const opened = OPENS.find(([match]) => match(name, node.type === "NewExpression"));
      if (opened !== undefined && !cleanup)
        report(
          node,
          via === "enq"
            ? `\`enq\` opens ${opened[1]} that nothing closes: a callback child, or \`enq.effect\` returning its cleanup`
            : `\`enq.effect\` opens ${opened[1]} and returns no cleanup: return the function that closes it`,
        );
      // What writes through a readonly type: `Object.assign(data.items, ...)`.
      const target = node.type === "CallExpression" && WRITERS.has(name) ? node.arguments[0] : undefined;
      const written = target === undefined || target.type === "SpreadElement" ? null : heldAt(target);
      if (written !== null) report(node, `an effect mutates \`${written}\`: copy it (\`toSorted\`, a spread)`);
      const bare = name.startsWith("window.") ? name.slice(7) : name;
      if (node.type === "CallExpression" && SCHEDULES.has(bare) && !cleanup)
        report(
          node,
          `\`${via}\` schedules a timer that nothing clears: \`enq.raise(…, { delay })\`, \`after\`, or \`enq.effect\` with a cleanup`,
        );
      // A module actor's snapshot, read when the effect runs.
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier"
      ) {
        const object = node.callee.object.name;
        const method = node.callee.property.type === "Identifier" ? node.callee.property.name : "";
        if (
          (method === "snapshot" || method === "getSnapshot") &&
          !own.has(object) &&
          (file.consts.has(object) || file.mutable.has(object) || file.imports.has(object))
        )
          report(
            node,
            `an effect reads \`${object}.${method}()\`, the actor's snapshot: pass the value from the handler's \`data\``,
          );
      }
    }
    // Assigning into, `delete` from, or a mutating method on held data is a type error (it's readonly).
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = node.type === "AssignmentExpression" ? node.left : node.argument;
      if (target.type === "Identifier" && file.mutable.has(target.name) && !own.has(target.name))
        report(node, `an effect writes the module variable \`${target.name}\`: keep it in the state's data`);
    }
    if (node.type === "CatchClause" && src(node.body).slice(1, -1).trim() === "")
      report(node, "an empty catch in an effect: let it throw, or say in a comment why it can be ignored");
    if (node.type === "UnaryExpression" && node.operator === "void" && node.argument.type === "CallExpression") {
      const callee = node.argument.callee;
      const name = callee.type === "Identifier" ? callee.name : null;
      if (name !== null && !own.has(name) && (name === "fetch" || promises(name, file, ctx.file)))
        report(node, `\`void ${name}(…)\` drops its failure: make it a task`);
    }
    return true;
  });
}

/** Whether a module-level name is a function the compiler sees return a promise: async, or a relative import's async function. */
function promises(name: string, file: FileFacts, path: string): boolean {
  const fn = file.functions.get(name);
  if (fn !== undefined) return fn.async;
  const i = file.imports.get(name);
  return i !== undefined && i.source.startsWith(".") && exportedFunction(path, i.source, i.imported)?.fn.async === true;
}

/** A raise's or send's options, as written: its delay and id. */
function later(call: CallExpression, index: number): { readonly delayed: boolean; readonly id: string | null } {
  const options = optionsOf(call, index);
  return { delayed: options.has("delay"), id: idIn(options.get("id")?.value) };
}

/** `idOf`, of a node that may be missing. */
const idIn = (node: Node | undefined): string | null => (node === undefined ? null : idOf(node));

/** The nodes of `machine` whose `on` has `event` (a wildcard that matches counts). */
function handlersFor(machine: FileMachine, event: string): string[] {
  return [...machine.nodes.keys()].filter((n) => handlesHere(machine, n, event));
}

/** Checks a machine's handlers together: raises, cancels, emits, and the callbacks enqueued twice. */
function checkMachine(machine: FileMachine, ctx: FileContext): void {
  const { report } = ctx;
  const placed = handlersOf(machine);
  const parallel = machine.shape.uses.has("parallel");
  const declared = new Set(
    ["events", "internal"].flatMap((map) => [...propsOf(machine.shape.options.get(map)?.value).keys()]),
  );
  const cancelled = new Set(
    placed.flatMap(({ handler }) =>
      handler.enq.flatMap(({ method, call }) => {
        const id = method === "cancel" ? idIn(call.arguments[0]) : null;
        return id === null ? [] : [id];
      }),
    ),
  );
  const stays = (p: Placed): boolean =>
    p.node !== null && !p.handler.declines && p.handler.steps.every((s) => s.state === p.node);
  const name = (p: Placed): string =>
    p.kind === "on" ? `\`${p.key}\`` : p.kind === "start" ? "start" : `"${p.node}"'s ${p.kind}`;

  // M502: an event whose handler stays and always raises the next, back to the first.
  const loops = new Map<string, { readonly to: string; readonly at: CallExpression }[]>();
  for (const p of placed) {
    if (p.kind !== "on" || p.key === null || !stays(p)) continue;
    for (const { method, call, always } of p.handler.enq) {
      const type = method === "raise" && always && !later(call, 1).delayed ? eventType(call.arguments[0]) : null;
      if (type !== null)
        loops.set(`${p.node} ${p.key}`, [...(loops.get(`${p.node} ${p.key}`) ?? []), { to: type, at: call }]);
    }
  }
  const reported = new Set<string>();
  for (const [from, edges] of loops) {
    const [node = "", first = ""] = from.split(" ");
    for (const edge of edges) {
      const path = [first];
      let next = edge.to;
      while (!path.includes(next) && loops.has(`${node} ${next}`)) {
        path.push(next);
        next = loops.get(`${node} ${next}`)?.[0]?.to ?? "";
      }
      if (next !== first) continue;
      const key = [...path].sort().join(" ");
      if (reported.has(`${node} ${key}`)) continue;
      reported.add(`${node} ${key}`);
      report(
        edge.at,
        path.length === 1
          ? `\`${first}\` raises \`${first}\` and stays, forever: raise it only on a condition, or go to another state`
          : `${path.map((e, i) => `\`${e}\` raises \`${path[(i + 1) % path.length]}\``).join(", ")}, and each stays, forever: raise one only on a condition, or go to another state`,
      );
    }
  }

  for (const p of placed) {
    const { handler } = p;
    const targets = handler.steps.flatMap((s) => (s.state === null ? [] : [s.state]));
    const known = handler.steps.every((s) => s.state !== null);
    for (const [i, { method, call, always }] of handler.enq.entries()) {
      if (method !== "raise" && method !== "sendTo" && method !== "cancel" && method !== "emit") continue;
      const { delayed, id } =
        method === "raise" ? later(call, 1) : method === "sendTo" ? later(call, 2) : { delayed: false, id: null };
      // An event setup doesn't declare, or a delay that isn't a number or is out of range (M480,
      // M482), is the type checker's.
      const raised = method === "raise" ? eventType(call.arguments[0]) : null;
      const delay = optionsOf(call, 1).get("delay")?.value;
      const typed = !(
        delay?.type === "Literal" &&
        (typeof delay.value === "string" ||
          (typeof delay.value === "number" && (delay.value <= 0 || delay.value > 2147483647)))
      );
      const type = raised !== null && declared.has(raised) && typed ? raised : null;
      // M517: a raise (or send) with an id, then its cancel, both on every call.
      if (method === "cancel" && always) {
        const cancel = idIn(call.arguments[0]);
        const raised = handler.enq
          .slice(0, i)
          .some(
            (c) =>
              c.always &&
              (c.method === "raise" || c.method === "sendTo") &&
              later(c.call, c.method === "raise" ? 1 : 2).id === cancel,
          );
        if (cancel !== null && raised)
          report(call, `the raise ${JSON.stringify(cancel)} is cancelled in the handler that raised it: drop both`);
      }
      // M513: a delayed raise with an id, from a handler that stays, with no cancel of it before it.
      if (method === "raise" && delayed && id !== null && p.kind === "on" && stays(p)) {
        const before = handler.enq.slice(0, i).some((c) => c.method === "cancel" && idIn(c.call.arguments[0]) === id);
        if (!before)
          report(
            call,
            `the delayed raise ${JSON.stringify(id)} from a handler that stays adds another: \`enq.cancel(${JSON.stringify(id)})\` before it`,
          );
      }
      if (type === null || parallel) continue;
      const handling = handlersFor(machine, type);
      // M512: a delayed raise, never cancelled, of an event only the step's target handles.
      if (delayed && (id === null || !cancelled.has(id)) && p.node !== null && handling.length > 0) {
        const target = targets.find(
          (t) =>
            t !== p.node &&
            handling.every((n) => t === n || t.startsWith(`${n}.`)) &&
            !handling.some((n) => p.node === n || p.node?.startsWith(`${n}.`)),
        );
        if (target !== undefined)
          report(
            call,
            `the delayed \`${type}\` is raised for ${JSON.stringify(target)} only, and nothing cancels it on leaving: \`after\` on ${JSON.stringify(target)}, or cancel it in exit`,
          );
      }
      if (delayed) continue;
      // M514: exit raises an event only the node it exits (or one inside it) handles.
      if (p.kind === "exit" && p.node !== null) {
        const node = p.node;
        if (handling.length > 0 && handling.every((n) => n === node || n.startsWith(`${node}.`)))
          report(
            call,
            `exit raises \`${type}\`, which only the state it leaves handles: handle it where the step goes, or drop the raise`,
          );
      }
      // M515: a raise that no state the handler goes to handles.
      if (
        p.kind !== "exit" &&
        p.kind !== "entry" &&
        known &&
        targets.length > 0 &&
        !targets.some((t) => handles(machine, t, type))
      ) {
        const list = [...new Set(targets)];
        report(
          call,
          `\`${type}\` is raised for ${list.map((t) => JSON.stringify(t)).join(" and ")}, which ${list.length === 1 ? "doesn't" : "don't"} handle it: handle it there, or drop the raise`,
        );
      }
    }
  }

  // M508: the start state's entry (or a parent's) emits before anyone can listen.
  if (machine.start !== null)
    for (const step of handlerOf(machine.start).steps) {
      const state = step.state;
      if (state === null) continue;
      for (const p of placed)
        if (p.kind === "entry" && p.node !== null && (state === p.node || state.startsWith(`${p.node}.`)))
          for (const { method, call } of p.handler.enq)
            if (method === "emit")
              report(call, "the start state's entry emits before anyone can listen: emit it on an event");
    }

  // M509: a callback a handler enqueues, and again the entry of the state it goes to. A callback
  // is a function named by the convention for them, `onOpen` (a log's `push` called twice isn't one).
  const isCallback = (n: string | null): n is string => n !== null && /^on[A-Z]/.test(n.slice(n.lastIndexOf(".") + 1));
  const callbacks = (h: Handler): Map<string, Node> => {
    const out = new Map<string, Node>();
    for (const { method, call } of h.enq) {
      if (method !== null) continue;
      const first = call.arguments[0];
      if (first === undefined) continue;
      if (!isFunction(first)) {
        const n = calleeName(first);
        if (isCallback(n)) out.set(n, call);
        continue;
      }
      if (first.body !== null)
        walkUp(first.body, (node) => {
          if (node.type !== "CallExpression") return true;
          const n = calleeName(node);
          if (isCallback(n)) out.set(n, node);
          return true;
        });
    }
    return out;
  };
  const entries = new Map(
    placed.flatMap((p) => (p.kind === "entry" && p.node !== null ? [[p.node, callbacks(p.handler)] as const] : [])),
  );
  for (const p of placed) {
    if (p.kind === "entry" || p.kind === "exit") continue;
    const mine = callbacks(p.handler);
    for (const target of new Set(
      p.handler.steps.flatMap((s) => (s.kind === "to" && s.state !== null && s.state !== p.node ? [s.state] : [])),
    ))
      for (const [callback, at] of mine)
        if (entries.get(target)?.has(callback)) {
          const short = callback.slice(callback.lastIndexOf(".") + 1);
          report(at, `\`${short}\` runs twice, from ${name(p)} and from ${JSON.stringify(target)}'s entry: keep one`);
        }
  }
}

/** M516: setup's `emitted` events that no `enq.emit` of the shape's machines emits. */
function checkEmitted(file: FileFacts, ctx: FileContext): void {
  for (const shape of file.shapes.values()) {
    if (!shape.uses.has("emit")) continue;
    const machines = file.machines.filter((m) => m.shape === shape);
    if (machines.length === 0) continue;
    const emitted = new Set<string>();
    let unknown = false;
    for (const m of machines)
      for (const { handler } of handlersOf(m))
        for (const { method, call } of handler.enq) {
          if (method !== "emit") continue;
          const type = eventType(call.arguments[0]);
          if (type === null) unknown = true;
          else emitted.add(type);
        }
    if (unknown) continue;
    for (const [type, p] of propsOf(shape.options.get("emitted")?.value))
      if (!emitted.has(type))
        ctx.report(
          p,
          `the emitted event ${JSON.stringify(type)} is never emitted: emit it, or remove it from \`emitted\``,
        );
  }
}

/** The file-level checks: each machine with effects in use. */
function checkFile(ctx: FileContext): void {
  const file = factsOf(ctx.program);
  for (const machine of file.machines) {
    if (!machine.shape.uses.has("effects")) continue;
    for (const { handler } of handlersOf(machine))
      for (const e of effectsIn(handler)) checkEffect(e, handler, file, ctx);
    checkMachine(machine, ctx);
  }
  checkEmitted(file, ctx);
}

/** An id written in place: a string, or a template with nothing in it; else null. */
function idOf(node: Node): string | null {
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return stringValue(node);
}

/** Whether the machine being compiled records effects (`enq`, `entry`, `exit`). */
let used = false;

/**
 * Whether the machine being compiled records effects: a feature that registers effect runners
 * (emit, spawn) gives its map (`Emitted.effects`) only then, so listing it costs nothing.
 */
export const recorded = (): boolean => used;

export const effects: FeatureCompiler = {
  file: checkFile,
  keys: ["entry", "exit"],
  values: ["enq"],
  kinds: {
    entry: { params: ["data", "state"], moves: false },
    exit: { params: ["data", "state"], moves: false },
  },
  shape: ({ name, options, local }) => {
    // The other features in `use`, by the names they're imported with: `w` merges their `enq` methods.
    const list = options.get("use")?.value;
    const others =
      list?.type === "ArrayExpression"
        ? list.elements.flatMap((e) => (e?.type === "Identifier" && e.name !== local ? [e.name] : []))
        : [];
    const enq = others.length > 0 ? `__reactreStateEnq_${name}` : `${local}.enq`;
    return {
      ...(local !== null &&
        others.length > 0 && { declarations: `const ${enq} = /* @__PURE__ */ ${local}.w([${others.join(", ")}]);` }),
      machine: ({ handler, report, src, dev }) => {
        used = false;
        const nodes = new Map<string, [entry: string, exit: string]>();
        // The ids the machine's raises and sends give (`{ delay, id: "bell" }`), the options and ids
        // not written in place (with the fix), and the cancels.
        const ids = new Set<string>();
        const unread: { readonly at: Node; readonly fix: string }[] = [];
        const cancels: CallExpression[] = [];
        return {
          call: (method, call) => {
            if (method === "cancel") cancels.push(call);
            const index = method === "raise" ? 1 : method === "sendTo" ? 2 : -1;
            const options = call.arguments[index];
            if (options === undefined) return;
            const callee = src(call.callee);
            const fix = `${callee}'s options are written in place, the id a string: ${callee}(${method === "raise" ? "event" : "target, event"}, { delay: 1000, id: "bell" }), so the compiler sees the ids enq.cancel takes`;
            if (options.type !== "ObjectExpression") unread.push({ at: options, fix });
            else
              for (const p of options.properties) {
                const id = p.type === "SpreadElement" ? null : keyName(p) === "id" ? idOf(p.value) : "";
                if (id === null) unread.push({ at: p, fix });
                else if (id !== "") ids.add(id);
              }
          },
          done: () => {
            if (cancels.length === 0) return;
            for (const { at, fix } of unread) report(at, fix);
            const list = [...ids].map((i) => JSON.stringify(i)).join(", ");
            for (const call of cancels) {
              const arg = call.arguments[0];
              if (arg === undefined) continue; // a type error: cancel takes an id
              const callee = src(call.callee);
              const id = idOf(arg);
              if (id === null)
                report(
                  arg,
                  `${callee}'s id is written in place, a string: ${callee}("bell"), so the compiler can check that a raise or send of this machine has it`,
                );
              if (id === null || unread.length > 0 || ids.has(id)) continue;
              const timer =
                duration(id) === null
                  ? ""
                  : " A timer in after has no id: it stops when its state exits, so move out of the state to cancel it.";
              report(
                call,
                ids.size === 0
                  ? `${callee}(${JSON.stringify(id)}) cancels nothing: no raise or send in this machine has an id.${timer} Give the delayed one this id, enq.raise(event, { delay: 1000, id: ${JSON.stringify(id)} }), or remove the cancel`
                  : `${callee}(${JSON.stringify(id)}) cancels nothing: no raise or send in this machine has id ${JSON.stringify(id)} (the ids are: ${list}).${timer} Use one of them, or remove the cancel`,
              );
            }
          },
          key: (state, key, value) => {
            const code = handler(value, key);
            if (code === null) return;
            used = true;
            const pair = nodes.get(state) ?? ["0", "0"];
            pair[key === "entry" ? 0 : 1] = code;
            nodes.set(state, pair);
          },
          value: () => {
            used = true;
            return enq;
          },
          emit: () =>
            used
              ? {
                  fields:
                    nodes.size > 0
                      ? [`b: { ${[...nodes].map(([n, [a, b]]) => `${JSON.stringify(n)}: [${a}, ${b}]`).join(", ")} }`]
                      : [],
                  step: (inner) => `${local}.y(${inner ?? ""})`,
                  // Development: the runner map is wrapped so `enq.sendTo` to a child that isn't
                  // running warns (M149). Production: the map itself, so a production build ships
                  // none of the wrapper.
                  effects: [dev ? `__reactreStateDevEffects(${local}.q)` : `${local}.q`],
                  ...(dev
                    ? { imports: [`import { __effects as __reactreStateDevEffects } from "@reactre/state/dev";`] }
                    : {}),
                  dispatch: (maps) => `${local}.d([${maps.join(", ")}])`,
                  // The lifecycle wrap that settles moves that aren't steps. A machine that records
                  // effects always has the general lifecycle (its runner maps ask for it), so `r` is there.
                  wrap: (r) => `${local}.l(${r})`,
                }
              : {},
        };
      },
    };
  },
};
