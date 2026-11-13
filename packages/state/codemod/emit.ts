// Writes the @reactre/state machine: setup's shape (each leaf's data, the events) and the machine
// (start, and each node's handlers, timers, task and children). Whatever can't be written becomes a
// TODO comment at its spot.

import { parseSync } from "oxc-parser";

import { type Analysis, isFnEffects, type Plan } from "./analyze.ts";
import { declaredNames, type Edit, isReference, key, keyName, walk } from "./ast.ts";
import { EMPTY_SCOPE, type Env, type Out, reads, readsEvent, rewrite } from "./expr.ts";
import type {
  ActionDef,
  Arg,
  Branch,
  Code,
  Cond,
  Effect,
  FnEffects,
  Handler,
  Invoke,
  MachineModel,
  SNode,
  TargetSpec,
  Todo,
  Write,
} from "./model.ts";

/** The names a handler binds. A v6 function that declares one of them gets another. */
interface Names {
  readonly state: string;
  readonly data: string;
  readonly event: string;
  readonly error: string;
  readonly to: string;
  readonly keep: string;
  readonly back: string;
  readonly enq: string;
  readonly actions: string;
  readonly guards: string;
  readonly reenter: string;
}

const NAMES: Names = {
  state: "state",
  data: "data",
  event: "event",
  error: "error",
  to: "to",
  keep: "keep",
  back: "back",
  enq: "enq",
  actions: "actions",
  guards: "guards",
  reenter: "reenter",
};

/** What a handler is, for its parameters: `entry` is an entry's or an exit's, which has no event. */
type Kind = "on" | "after" | "error" | "done" | "child" | "entry";

/** Where a handler sits, for what its `data` holds. */
type Source =
  | { readonly kind: "leaf"; readonly node: SNode }
  | { readonly kind: "parent"; readonly node: SNode }
  | { readonly kind: "parallel"; readonly node: SNode }
  | { readonly kind: "none" };

export interface Emitted {
  /** `const shape = setup({...});\n\nconst name = shape.machine({...});` */
  readonly text: string;
  /** Internal event names, for the report. */
  readonly internal: readonly string[];
  /** The opt-ins setup's `use` lists, to import. */
  readonly features: readonly string[];
  /** Each opt-in's entry, with the names imported from it (the opt-in, and `createCallbackLogic`). */
  readonly imports: ReadonlyMap<string, readonly string[]>;
}

export function emitMachine(model: MachineModel, an: Analysis, shapeName: string, todos: Todo[]): Emitted {
  const env: Env = model.env;
  const placed = new Set<Todo>();
  const comment = (list: readonly Todo[]): string => {
    let out = "";
    for (const t of list) {
      if (placed.has(t)) continue;
      placed.add(t);
      out += `// TODO(@reactre/state): ${oneLine(t.message)}\n`;
    }
    return out;
  };
  const todo = (at: number, message: string): void => {
    if (todos.some((x) => x.at === at && x.message === message)) return;
    todos.push({ at, message });
  };
  // Every TODO goes above the innermost part written from the source range it is about: a
  // handler, a timer, a task, a state. What fits nowhere goes above the shape.
  for (const n of collect(model.root)) for (const t of n.todos) todos.push(t);
  // The stubs the user writes, each with its TODO, above the shape.
  for (const s of model.stubs.values()) todos.push(s.todo);
  const stubs = [...model.stubs.values()].map((s) => `${comment([s.todo])}${s.text}\n\n`).join("");
  /** The TODOs not placed yet at offsets in [start, end), outside the `skip` ranges. */
  const within = (start: number, end: number, skip: readonly { at: number; end: number }[] = []): Todo[] =>
    todos.filter(
      (t) => !placed.has(t) && t.at >= start && t.at < end && !skip.some((s) => t.at >= s.at && t.at < s.end),
    );

  const fields = (leaf: SNode): ReadonlyMap<string, string> => an.fields.get(leaf) ?? new Map();
  /** A leaf whose config starts work when it is entered (a task; a timer: `after`, `timeout`). */
  // A leaf's entry or exit too: a stay with `to` would read as one that runs them (M501), and XState's
  // stay didn't, so it is `keep`.
  const works = (leaf: SNode): boolean =>
    leaf.invokes.some((i) => i.kind === "task") ||
    leaf.after.some((t) => t.duration !== null) ||
    leaf.timeout !== null ||
    isFnEffects(leaf.entry) ||
    leaf.entry.length > 0 ||
    isFnEffects(leaf.exit) ||
    leaf.exit.length > 0;

  // #region Data

  /** A context field read at a source, before any write. */
  const base = (source: Source, f: string, n: Names): string => {
    switch (source.kind) {
      case "none":
        return "null";
      case "leaf":
        return an.whole || fields(source.node).has(f) ? `${n.data}.${f}` : "null";
      case "parent": {
        const under = an.leavesUnder(source.node);
        const have = under.filter((l) => fields(l).has(f));
        if (an.whole || have.length === under.length) return `${n.data}.${f}`;
        if (have.length === 0) return "null";
        todo(
          source.node.at,
          `field ${f} is in some of ${source.node.name}'s states only: read it with a check of state, or narrow by hand`,
        );
        return `${n.data}.${f}`;
      }
      case "parallel": {
        if (an.whole) return `${wholeData(source, n)}.${f}`;
        const owner = an.owner(source.node, f);
        if (owner === null) return "null";
        const leaves = an.leavesUnder(owner);
        if (!leaves.every((l) => fields(l).has(f))) return "null";
        return `${n.data}${member(owner.key)}.${n.data}.${f}`;
      }
    }
  };

  /**
   * The whole context at a source, when each state keeps it: `data`, or in a parallel state's
   * handler (whose data is its regions), the first region's.
   */
  const wholeData = (source: Source, n: Names): string => {
    if (source.kind !== "parallel") return n.data;
    const first = source.node.children.find((c) => c.type !== "history");
    return first === undefined ? n.data : `${n.data}${member(first.key)}.${n.data}`;
  };

  /** An `Out` for code at a source, with the writes before it applied. */
  const outAt = (source: Source, n: Names, kind: Kind, prior: ReadonlyMap<string, string>): Out => ({
    field: (f) => prior.get(f) ?? base(source, f, n),
    whole: n.data,
    event: n.event,
    special: new Map(kind === "error" ? [["error", n.error]] : kind === "child" ? [["output", "output"]] : []),
  });

  const code = (
    c: Code,
    source: Source,
    n: Names,
    kind: Kind,
    prior: ReadonlyMap<string, string> = new Map(),
  ): string => rewrite(c, env, outAt(source, n, kind, prior), todo);

  /** The writes' values, in order: each sees the ones it is after (its `seen`). */
  const values = (writes: readonly Write[], source: Source, n: Names, kind: Kind): Map<string, string> => {
    const out = new Map<string, string>();
    const texts: string[] = [];
    for (const w of writes) {
      const prior = new Map(writes.slice(0, w.seen).map((p, i) => [p.field, paren(texts[i] ?? "")]));
      const text = code(w.code, source, n, kind, prior);
      texts.push(text);
      out.set(w.field, text);
    }
    return out;
  };

  /** `to(...)` for a plan, with the data its leaves need. */
  const step = (
    plan: Plan,
    source: Source,
    writes: readonly Write[] | "opaque",
    n: Names,
    kind: Kind,
    at: number,
    reenter = false,
  ): string => {
    if (writes === "opaque") {
      todo(at, "write this state's data by hand: the context update can't be read field by field");
      writes = [];
    }
    const written = values(writes, source, n, kind);
    if (reenter && plan.kind !== "leaf")
      todo(at, "reenter into a parallel state or through history: re-enter its leaf with reenter(leaf, data) by hand");
    const go = (p: Plan): string => {
      if (p.kind === "back") return `${n.back}(${JSON.stringify(p.parent.name)}, ${go(p.fallback)})`;
      if (p.kind === "parallel")
        return `${n.to}(${JSON.stringify(p.node.name)}, { ${p.regions.map((r) => `${key(r.region.key)}: ${go(r.plan)}`).join(", ")} })`;
      const leaf = p.leaf;
      const name = JSON.stringify(leaf.name);
      const stays = source.kind === "leaf" && source.node === leaf;
      // A leaf entered at the top (not a region's) that the handler runs in: `reenter` when the
      // source re-entered it (XState's `reenter: true` elsewhere is a plain move); a stay in a leaf
      // with a task, a timer, an entry or an exit is `keep`, which leaves them be, as XState did.
      const own = stays || (source.kind === "parent" && an.leavesUnder(source.node).includes(leaf));
      const to = p !== plan ? n.to : reenter && own ? n.reenter : stays && works(leaf) ? n.keep : n.to;
      if (an.whole) {
        if (source.kind === "none")
          return `${n.to}(${name}, ${model.context.initial === null ? "{}" : objectOf(written)})`;
        const whole = wholeData(source, n);
        // From a parallel state, the region's data is listed field by field: data is an object
        // literal or the handler's own `data`.
        const fs = model.context.fields;
        if (source.kind === "parallel" && fs !== null)
          return `${to}(${name}, { ${[...fs.keys()].map((f) => `${key(f)}: ${written.get(f) ?? `${whole}.${f}`}`).join(", ")} })`;
        if (written.size === 0) return `${to}(${name}, ${whole})`;
        return `${to}(${name}, { ...${whole}, ${[...written].map(([k, v]) => `${key(k)}: ${v}`).join(", ")} })`;
      }
      const want = fields(leaf);
      if (want.size === 0) return `${to}(${name})`;
      // From a leaf whose data has the same fields and types, `data` (spread, with the changes) is it.
      const have = source.kind === "leaf" ? fields(source.node) : null;
      const same = have !== null && have.size === want.size && [...want].every(([f, t]) => have.get(f) === t);
      if (stays || same) {
        const changed = [...want.keys()].filter((f) => written.has(f));
        if (changed.length === 0) return `${to}(${name}, ${n.data})`;
        if (changed.length < want.size)
          return `${to}(${name}, { ...${n.data}, ${changed.map((f) => `${key(f)}: ${written.get(f) ?? ""}`).join(", ")} })`;
      }
      const parts = [...want.keys()].map((f) => `${key(f)}: ${written.get(f) ?? base(source, f, n)}`);
      return `${to}(${name}, { ${parts.join(", ")} })`;
    };
    return go(plan);
  };

  /** A targetless transition: the leaf it is in stays, with its new data. */
  const stay = (
    decl: SNode,
    source: Source,
    writes: readonly Write[] | "opaque",
    n: Names,
    kind: Kind,
    at: number,
  ): string => {
    if (source.kind === "parallel" || decl.type === "parallel") {
      todo(at, "a context update on a parallel state: update the region that holds the field instead");
      return "null";
    }
    const leaves = an.leavesUnder(decl);
    const one = (leaf: SNode): string =>
      step({ kind: "leaf", leaf }, { kind: "leaf", node: leaf }, writes, n, kind, at);
    if (leaves.length === 1 && leaves[0] !== undefined) return one(leaves[0]);
    let out = "";
    leaves.forEach((leaf, i) => {
      out += i === leaves.length - 1 ? one(leaf) : `${n.state} === ${JSON.stringify(leaf.name)} ? ${one(leaf)} : `;
    });
    return out;
  };

  const target = (
    spec: TargetSpec | null,
    decl: SNode,
    source: Source,
    writes: readonly Write[] | "opaque",
    n: Names,
    kind: Kind,
    at: number,
    reenter = false,
  ): string => {
    if (spec === null) return stay(decl, source, writes, n, kind, at);
    const plan = an.resolve(spec, decl);
    if (plan === null) return "null";
    return step(plan, source, writes, n, kind, at, reenter);
  };

  const condText = (c: Cond, source: Source, n: Names, kind: Kind): string => {
    switch (c.kind) {
      case "code":
        return code(c.code, source, n, kind);
      case "and":
      case "or":
        return c.items.map((i) => paren(condText(i, source, n, kind))).join(c.kind === "and" ? " && " : " || ");
      case "not":
        return `!${paren(condText(c.item, source, n, kind))}`;
      case "todo":
        todo(c.at, c.text);
        return "false";
      case "stub":
        return `${c.name}(${c.params === null ? "" : code(c.params, source, n, kind)})`;
      case "named":
        return `${n.guards}${member(c.name)}()`;
    }
  };

  /** An effect argument, rewritten where it lands, with the writes before it applied. */
  const argText = (a: Arg, source: Source, n: Names, kind: Kind, prior: ReadonlyMap<string, string>): string => {
    switch (a.kind) {
      case "text":
        return a.text;
      case "code":
        return code(a.code, source, n, kind, prior);
      case "thunk": {
        const body = code(a.code, source, n, kind, prior);
        return `() => ${body.startsWith("{") && a.code.node.type !== "BlockStatement" ? `(${body})` : body}`;
      }
      case "object":
        return `{ ${a.entries.map(([k, v]) => `${key(k)}: ${argText(v, source, n, kind, prior)}`).join(", ")} }`;
    }
  };

  /** Effects as expressions (`enq(...)`, `enq.raise(...)`), in order; `writes` are the transition's. */
  const effectTexts = (
    fx: readonly Effect[],
    source: Source,
    n: Names,
    kind: Kind,
    writes: readonly Write[] | "opaque",
  ): string[] => {
    const out: string[] = [];
    for (const e of fx) {
      const prior =
        writes === "opaque" || e.seen === 0
          ? new Map<string, string>()
          : new Map([...values(writes.slice(0, e.seen), source, n, kind)].map(([k, v]) => [k, paren(v)]));
      if (kind === "entry" && effectReadsEvent(e)) {
        todo(e.at, "this effect reads the event, and an entry or exit has none: keep what it reads in the data");
        continue;
      }
      if (e.kind === "enq") {
        const args = e.args.map((a) => argText(a, source, n, kind, prior)).join(", ");
        out.push(`${n.enq}${e.method === null ? "" : `.${e.method}`}(${args})`);
        continue;
      }
      const then = effectTexts(e.then, source, n, kind, writes);
      const otherwise = effectTexts(e.otherwise, source, n, kind, writes);
      if (then.length === 0 && otherwise.length === 0) continue;
      const seq = (list: readonly string[]): string =>
        list.length === 0 ? "undefined" : list.length === 1 ? (list[0] ?? "") : `(${list.join(", ")})`;
      out.push(`${paren(condText(e.cond, source, n, kind))} ? ${seq(then)} : ${seq(otherwise)}`);
    }
    return out;
  };

  /** `(e1, e2, step)`: a step with its effects before it. */
  const withEffects = (effects: readonly string[], s: string): string =>
    effects.length === 0 ? s : `(${[...effects.map((e) => (/\?/.test(e) ? `(${e})` : e)), s].join(", ")})`;

  // #endregion

  // #region Handlers

  /** The parameters a handler's body uses, destructured. */
  const params = (body: string, kind: Kind, n: Names): string => {
    const used = freeNames(body);
    const order: [keyof Names | "output" | "input", string][] = [
      ["state", n.state],
      ["data", n.data],
      ["event", n.event],
      ["error", n.error],
      ["output", "output"],
      ["actions", n.actions],
      ["guards", n.guards],
      ["enq", n.enq],
      ["to", n.to],
      ["keep", n.keep],
      ["back", n.back],
      ["reenter", n.reenter],
    ];
    const moves = ["actions", "guards", "enq", "to", "keep", "back", "reenter"];
    const allowed: { readonly [K in Kind]: readonly string[] } = {
      on: ["state", "data", "event", ...moves],
      after: ["state", "data", ...moves],
      error: ["state", "data", "error", ...moves],
      done: ["state", "data", ...moves],
      child: ["state", "data", "output", ...moves],
      entry: ["state", "data", "actions", "enq"],
    };
    const list = order
      .filter(([k, local]) => allowed[kind].includes(k) && used.has(local))
      .map(([k, local]) => (k === local ? k : `${k}: ${local}`));
    return `{ ${list.join(", ")} }`;
  };

  /** One transition: branches chained into a ternary, or a v6 function rewritten. */
  const handler = (
    entries: readonly { readonly h: Handler; readonly decl: SNode }[],
    node: SNode,
    kind: Kind,
    total: boolean,
  ): string => {
    const source = sourceOf(node);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only !== undefined && only.h.kind === "fn") return fnHandler(only.h, only.decl, source, kind, total);
    const branches: { b: Branch; decl: SNode }[] = [];
    for (const e of entries) {
      if (e.h.kind === "fn") {
        todo(e.h.at, "this transition function and another handler for the same event: merge them by hand");
        continue;
      }
      for (const b of e.h.branches) branches.push({ b, decl: e.decl });
    }
    const n = NAMES;
    let body = "";
    let open = true;
    for (const { b, decl } of branches) {
      for (const t of b.todos) todo(t.at, t.message);
      const s = withEffects(
        effectTexts(b.effects, source, n, kind, b.writes),
        target(b.target, decl, source, b.writes, n, kind, b.at, b.reenter),
      );
      if (b.guard === null) {
        body += s;
        open = false;
        break;
      }
      body += `${condText(b.guard, source, n, kind)} ? ${s} : `;
    }
    if (open) {
      if (total) {
        todo(
          entries[0]?.h.at ?? node.at,
          "XState did nothing when no guard passed; this must go somewhere, so it stays",
        );
        body += stay(node.type === "parallel" ? node : node, source, [], n, kind, entries[0]?.h.at ?? node.at);
      } else body += "null";
    }
    if (body === "") body = "null";
    return `(${params(body, kind, n)}) => ${body}`;
  };

  /** A v6 transition function, rewritten in place: its returns become `to(...)` or `null`. */
  const fnHandler = (
    h: Extract<Handler, { kind: "fn" }>,
    decl: SNode,
    source: Source,
    kind: Kind,
    total: boolean,
  ): string => {
    for (const t of h.todos) todo(t.at, t.message);
    const fn = h.fn;
    const declared = declaredNames(fn);
    for (const p of fn.params) walk(p, (x) => (x.type === "Identifier" && declared.delete(x.name), true));
    const pick = (name: string): string => {
      let out = name;
      while (declared.has(out)) out = `${out}_`;
      return out;
    };
    const n: Names = {
      state: pick("state"),
      data: pick("data"),
      event: pick("event"),
      error: pick("error"),
      to: pick("to"),
      keep: pick("keep"),
      back: pick("back"),
      enq: h.enq ?? pick("enq"),
      actions: pick("actions"),
      guards: pick("guards"),
      reenter: pick("reenter"),
    };
    const edits: Edit[] = [];
    for (const s of h.sites) {
      let text: string;
      if (s.kind === "null") {
        if (total) {
          todo(s.start, "XState did nothing here; this must go somewhere, so it stays");
          text = stay(decl, source, [], n, kind, s.start);
        } else text = "null";
        edits.push({ start: s.start, end: s.end, text: s.statement ? `return ${text};` : text });
        continue;
      }
      text = target(s.target, decl, source, s.writes, n, kind, s.start, s.reenter);
      edits.push({ start: s.start, end: s.end, text });
    }
    const body = fn.body;
    if (h.fallsThrough && body?.type === "BlockStatement") {
      const last = body.body[body.body.length - 1];
      const at = last === undefined ? body.start + 1 : last.end;
      edits.push({ start: at, end: at, text: last === undefined ? "return null;" : "\nreturn null;" });
    }
    const PARAMS = "__reactreStateParams__";
    const first = fn.params[0];
    const last = fn.params[fn.params.length - 1];
    if (first !== undefined && last !== undefined) edits.push({ start: first.start, end: last.end, text: PARAMS });
    let text = rewrite({ node: fn, scope: h.scope }, env, outAt(source, n, kind, new Map()), todo, fn, edits);
    if (first === undefined) text = text.replace(/^(async\s*)?\(\s*\)/, `$1(${PARAMS})`);
    return text.replace(PARAMS, params(text.replace(PARAMS, ""), kind, n));
  };

  /** An entry or exit: `({ data, enq }) => (e1, e2)`, or v6's function rewritten in place. */
  const entryText = (fx: readonly Effect[] | FnEffects, node: SNode): string | null => {
    const source = sourceOf(node);
    if (!isFnEffects(fx)) {
      const list = effectTexts(fx, source, NAMES, "entry", []);
      if (list.length === 0) return null;
      const body = list.length === 1 ? (list[0] ?? "") : `(${list.join(", ")})`;
      return `(${params(body, "entry", NAMES)}) => ${body}`;
    }
    const fn = fx.fn;
    const declared = declaredNames(fn);
    for (const p of fn.params) walk(p, (x) => (x.type === "Identifier" && declared.delete(x.name), true));
    const pick = (name: string): string => {
      let out = name;
      while (declared.has(out)) out = `${out}_`;
      return out;
    };
    const n: Names = { ...NAMES, data: pick("data"), state: pick("state"), enq: fx.enq ?? pick("enq") };
    const PARAMS = "__reactreStateParams__";
    const first = fn.params[0];
    const last = fn.params[fn.params.length - 1];
    const edits: Edit[] =
      first !== undefined && last !== undefined ? [{ start: first.start, end: last.end, text: PARAMS }] : [];
    let text = rewrite({ node: fn, scope: fx.scope }, env, outAt(source, n, "entry", new Map()), todo, fn, edits);
    if (first === undefined) text = text.replace(/^(async\s*)?\(\s*\)/, `$1(${PARAMS})`);
    return text.replace(PARAMS, params(text.replace(PARAMS, ""), "entry", n));
  };

  /** Where a node's handlers read their data from. */
  const sourceOf = (node: SNode): Source =>
    node.type === "parallel"
      ? { kind: "parallel", node }
      : node.type === "atomic" || node.type === "final"
        ? { kind: "leaf", node }
        : { kind: "parent", node };

  // #endregion

  // #region The machine's states

  const internal: string[] = [];
  const internalTypes: string[] = [];
  const taken = new Set([...model.events.keys()]);
  const childMachines = new Map<string, string>();

  const task = (inv: Invoke, node: SNode, on: string[]): string => {
    const source = sourceOf(node);
    let event = `${inv.id}Done`;
    while (taken.has(event)) event = `${event}_`;
    taken.add(event);
    internal.push(event);
    internalTypes.push(`${key(event)}: types<{ output: Awaited<ReturnType<typeof ${inv.logic}>> }>()`);
    const args: string[] = [];
    if (inv.logicParams.includes("input"))
      args.push(`input: ${inv.input === null ? "undefined" : code(inv.input, source, NAMES, "on")}`);
    if (inv.logicParams.includes("signal")) args.push("signal");
    const call = `await ${inv.logic}(${args.length === 0 ? "" : `{ ${args.join(", ")} }`})`;
    const runBody = `({ type: ${JSON.stringify(event)}, output: ${call} })`;
    const runParams = [freeNames(runBody).has("data") ? "data" : "", args.includes("signal") ? "signal" : ""].filter(
      Boolean,
    );
    const runText = `async ({ ${runParams.join(", ")} }) => ${runBody}`;
    if (inv.onDone !== null) {
      const h = handler([{ h: inv.onDone, decl: node }], node, "on", false);
      on.push(`${comment(within(inv.onDone.at, inv.onDone.end))}${key(event)}: ${h}`);
    } else {
      todo(inv.at, `XState ignored ${inv.id}'s result: here the task's event must be handled, so the state stays`);
      const s = stay(node, source, [], NAMES, "on", inv.at);
      on.push(`${key(event)}: (${params(s, "on", NAMES)}) => ${s}`);
    }
    let error: string;
    let note = "";
    if (inv.onError === null) {
      todo(inv.at, `XState's actor errored when ${inv.id} failed: say where to go`);
      const s = stay(node, source, [], NAMES, "error", inv.at);
      error = `(${params(s, "error", NAMES)}) => ${s}`;
    } else {
      error = handler([{ h: inv.onError, decl: node }], node, "error", true);
      note = comment(within(inv.onError.at, inv.onError.end));
    }
    return `${comment(within(inv.at, inv.end))}task: ${obj([`run: ${runText}`, `${note}error: ${error}`])}`;
  };

  const child = (inv: Invoke, node: SNode): string => {
    const source = sourceOf(node);
    // The child's machine is declared in setup's children, so `done` gets its output's type.
    const declared = childMachines.get(inv.id);
    if (declared !== undefined && declared !== inv.logic)
      todo(inv.at, `child "${inv.id}" runs ${declared} elsewhere: give this one another id`);
    else childMachines.set(inv.id, inv.logic);
    const parts: string[] = [];
    if (inv.input !== null) {
      const body = code(inv.input, source, NAMES, "on");
      parts.push(`input: (${params(body, "on", NAMES)}) => (${body})`);
    }
    if (inv.onDone !== null) {
      const h = handler([{ h: inv.onDone, decl: node }], node, "child", true);
      if (/\boutput\b/.test(h))
        todo(
          inv.onDone.at,
          "XState's onDone output is the child's output; here output is its final { state, data }: read output.data",
        );
      parts.push(`${comment(within(inv.onDone.at, inv.onDone.end))}done: ${h}`);
    }
    if (inv.onError !== null)
      todo(inv.at, "a child's onError: a child machine reports failure by ending in a final state");
    return `${comment(within(inv.at, inv.end))}${key(inv.id)}: ${obj(parts)}`;
  };

  /**
   * A child of actor logic (`logic`): its input, its error, and the handlers of the events it sends
   * back (XState's handlers of them on the state and its parents), in its `on`.
   */
  const logicChild = (inv: Invoke, node: SNode): string => {
    const source = sourceOf(node);
    const declared = childMachines.get(inv.id);
    if (declared !== undefined && declared !== inv.logic)
      todo(inv.at, `child "${inv.id}" runs ${declared} elsewhere: give this one another id`);
    else childMachines.set(inv.id, inv.logic);
    const parts: string[] = [];
    if (inv.input !== null) {
      const body = code(inv.input, source, NAMES, "on");
      const ps = params(body, "on", NAMES);
      parts.push(`input: (${ps === "{  }" ? "" : ps}) => (${body})`);
    }
    if (inv.onError === null) {
      todo(inv.at, `XState's actor errored when ${inv.id} failed: say where to go`);
      const s = stay(node, source, [], NAMES, "error", inv.at);
      parts.push(`error: (${params(s, "error", NAMES)}) => ${s}`);
    } else
      parts.push(
        `${comment(within(inv.onError.at, inv.onError.end))}error: ${handler([{ h: inv.onError, decl: node }], node, "error", true)}`,
      );
    if (inv.onDone !== null)
      todo(inv.onDone.at, `${inv.id} is callback logic, which never finishes: its onDone never runs`);
    const on: string[] = [];
    for (const event of inv.sendsBack) {
      const list: { h: Handler; decl: SNode }[] = [];
      for (let n: SNode | null = node; n !== null && list.length === 0; n = n.parent) {
        const h = n.on.get(event);
        if (h !== undefined) list.push({ h, decl: n });
      }
      if (list.length > 0) on.push(`${key(event)}: ${handler(list, node, "on", false)}`);
    }
    if (on.length > 0) parts.push(`on: ${obj(on)}`);
    return `${comment(within(inv.at, inv.end))}${key(inv.id)}: ${obj(parts)}`;
  };

  /** The root's `on`: each top-level node gets it, after its own. */
  const rootOn = model.root.on;
  const onOf = (node: SNode): Map<string, { h: Handler; decl: SNode }[]> => {
    const out = new Map<string, { h: Handler; decl: SNode }[]>();
    for (const [e, h] of node.on) out.set(e, [{ h, decl: node }]);
    if (node.parent === model.root)
      for (const [e, h] of rootOn) out.set(e, [...(out.get(e) ?? []), { h, decl: model.root }]);
    return out;
  };
  for (const t of model.root.after) todo(t.at, "a timer on the machine itself: put it on each top-level state");
  for (const i of model.root.invokes) todo(i.at, "an invoke on the machine itself: put it on each top-level state");

  /** An atomic leaf (outside a parallel state) that no transition of its own or its parents' leaves. */
  const deadEnd = (leaf: SNode): boolean => {
    if (leaf.type !== "atomic" || an.region(leaf) !== null || model.root.on.size > 0) return false;
    for (let n: SNode | null = leaf; n !== null && n !== model.root; n = n.parent)
      if (
        n.on.size > 0 ||
        n.after.some((t) => t.duration !== null) ||
        n.invokes.length > 0 ||
        n.always !== null ||
        n.timeout !== null
      )
        return false;
    return true;
  };
  const entries: string[] = [];
  /** A compound state's `done` (`output`) is written: the machine uses nested and output. */
  let completes = false;
  /** A state has tags, meta or a description (`tags`). */
  let tagged = false;
  const nodeEntry = (node: SNode): void => {
    if (node.type === "history") return;
    const isLeaf = node.type === "atomic" || node.type === "final";
    const parts: string[] = [];
    // tags, meta and description (`tags`). A final state takes none of them (only entry): its
    // description stays a comment, and its tags and meta a TODO.
    if (node.tags !== null) parts.push(`tags: ${node.tags}`);
    if (node.meta !== null) parts.push(`meta: ${node.meta}`);
    if (node.description !== null) parts.push(`description: ${JSON.stringify(node.description)}`);
    if (node.tags !== null || node.meta !== null || node.description !== null) tagged = true;
    const entry = entryText(node.entry, node);
    if (entry !== null) parts.push(`entry: ${entry}`);
    if (node.type === "final") {
      const p = node.parent;
      if (p !== model.root && p?.type !== "parallel" && p !== null && p.onDone === null)
        todo(
          node.at,
          `in XState, reaching ${node.name} finished ${p.name} (with no onDone, nothing happened); here a final state ends the machine`,
        );
      parts.push("final: true");
    } else if (deadEnd(node)) {
      // No transition leaves it: a dead end is a type error here, and final is what it does.
      todo(
        node.at,
        `no transition leaves ${node.name}, so it is final here: XState's actor stayed in it without finishing. Add a transition if it should`,
      );
      parts.push("final: true");
    } else {
      const on: string[] = [];
      for (const [event, list] of onOf(node)) {
        const h = handler(list, node, "on", false);
        const notes = list.flatMap((e) => within(e.h.at, e.h.end));
        on.push(`${described(list.map((e) => e.h))}${comment(notes)}${key(event)}: ${h}`);
      }
      const after: string[] = [];
      for (const t of node.after) {
        if (t.duration === null) continue;
        const h = handler([{ h: t.handler, decl: node }], node, "after", true);
        after.push(
          `${described([t.handler])}${comment(within(t.at, t.end))}${t.named ? key(t.duration) : JSON.stringify(t.duration)}: ${h}`,
        );
      }
      let taskText: string | null = null;
      const children: string[] = [];
      for (const inv of node.invokes) {
        if (inv.kind === "task") {
          if (taskText === null) taskText = task(inv, node, on);
        } else if (inv.kind === "logic") children.push(logicChild(inv, node));
        else children.push(child(inv, node));
      }
      if (on.length > 0) parts.push(`on: ${obj(on)}`);
      if (after.length > 0) parts.push(`after: ${obj(after)}`);
      if (node.always !== null) {
        const h = handler([{ h: node.always, decl: node }], node, "after", false);
        parts.push(`${described([node.always])}${comment(within(node.always.at, node.always.end))}always: ${h}`);
      }
      if (node.timeout !== null) {
        const t = node.timeout;
        const v = t.value;
        let value: string;
        if (v.kind === "code") {
          const body = code(v.code, sourceOf(node), NAMES, "after");
          value = `(${params(body, "entry", NAMES)}) => ${body}`;
        } else value = argText(v, sourceOf(node), NAMES, "after", new Map());
        const h = handler([{ h: t.handler, decl: node }], node, "after", true);
        parts.push(`timeout: ${value}`, `${comment(within(t.handler.at, t.handler.end))}onTimeout: ${h}`);
      }
      if (taskText !== null) parts.push(taskText);
      if (children.length > 0) parts.push(`children: ${obj(children)}`);
      if (node.onDone !== null) {
        const h = handler([{ h: node.onDone, decl: node }], node, "done", true);
        if (/\bevent\b/.test(h))
          todo(node.onDone.at, "XState's onDone event (its output): here done gets the final leaf's state and data");
        parts.push(`${comment(within(node.onDone.at, node.onDone.end))}done: ${h}`);
        if (node.type === "compound") completes = true;
      }
      const exit = entryText(node.exit, node);
      if (exit !== null) parts.push(`exit: ${exit}`);
      if (node.type === "parallel" && an.whole)
        todo(
          node.at,
          `each region of ${node.name} keeps its own copy of the context: a change in one region isn't seen by the others, and leaving ${node.name} takes the first region's`,
        );
    }
    const head = comment(
      within(
        node.at,
        node.end,
        node.children.filter((c) => c.type !== "history"),
      ),
    );
    if (isLeaf || parts.length > 0 || head !== "") entries.push(`${head}${key(node.name)}: ${obj(parts)}`);
    for (const c of node.children) nodeEntry(c);
  };
  for (const c of model.root.children) nodeEntry(c);

  // start
  let start: string;
  {
    const writes: Write[] = [];
    const ctx = model.context;
    if (ctx.initial !== null)
      for (const p of ctx.initial.properties) {
        const field = p.type === "SpreadElement" ? null : keyName(p);
        if (p.type === "SpreadElement" || field === null) {
          todo(p.start, "a context property the codemod can't read: write it in start's data");
          continue;
        }
        writes.push({ field, code: { node: p.value, scope: ctx.initialScope ?? EMPTY_SCOPE }, seen: 0 });
      }
    const body = an.start === null ? "null" : step(an.start, { kind: "none" }, writes, NAMES, "on", model.root.at);
    const used = freeNames(body);
    const input = ctx.inputName;
    const ps = [
      input !== null && used.has(input) ? (input === "input" ? "input" : `input: ${input}`) : "",
      "to",
      used.has("back") ? "back" : "",
    ].filter(Boolean);
    const notes = ctx.initial === null ? [] : within(ctx.initial.start, ctx.initial.end);
    start = `${comment(notes)}start: ({ ${ps.join(", ")} }) => ${body}`;
  }

  // #endregion

  // #region Setup

  const parallels = an.leaves.length === 0 ? [] : collect(model.root).filter((n) => n.type === "parallel");
  // The opt-ins the output uses, each imported from `@reactre/state/<feature>`, in setup's `use`.
  // The code without its comments: a TODO's advice can name a call ("reenter(leaf, data) by hand").
  const body = `${start}\n${entries.join("\n")}`.replace(/^[ \t]*\/\/.*$/gm, "");
  const needs = new Set<string>();
  if (an.leaves.some((l) => l.name.includes(".")) || parallels.length > 0) needs.add("nested");
  if (parallels.length > 0) needs.add("parallel");
  if (/\bback\(/.test(body)) needs.add("history");
  if (/\breenter\(/.test(body)) needs.add("reenter");
  if (childMachines.size > 0 || model.spawned.size > 0) needs.add("children");
  if (completes) {
    needs.add("nested");
    needs.add("output");
  }
  for (const f of model.uses) if (f !== "reenter") needs.add(f);
  if (!/\benq\b/.test(body)) needs.delete("effects");
  if (!tagged) needs.delete("tags");
  if (
    model.context.schema ||
    (model.input !== null && !model.input.startsWith("types<")) ||
    [...model.events.values()].some((e) => !e.value.startsWith("types<"))
  )
    needs.add("validate");
  const use = FEATURES.filter((f) => needs.has(f));
  const shape: string[] = [];
  if (use.length > 0) shape.push(`use: [${use.join(", ")}]`);
  if (model.version !== null) shape.push(`version: ${model.version}`);
  if (model.input !== null) shape.push(`input: ${model.input}`);
  if (parallels.length > 0) shape.push(`parallel: [${parallels.map((p) => JSON.stringify(p.name)).join(", ")}]`);
  // Setup's named implementations (`provide`), delays (`delays`) and emitted events (`emit`).
  const named = (defs: ReadonlyMap<string, ActionDef>): string =>
    obj(
      [...defs.values()].map((d) => {
        if (d.todo !== null) todos.push(d.todo);
        return `${d.todo === null ? "" : comment([d.todo])}${key(d.name)}: ${d.text}`;
      }),
    );
  if (model.actions.size > 0) shape.push(`actions: ${named(model.actions)}`);
  if (model.guards.size > 0) shape.push(`guards: ${named(model.guards)}`);
  if (model.delays.size > 0) {
    const fs = model.context.fields;
    const list = [...model.delays.values()].map((d) => {
      const out: Out = { field: (f) => `data${member(f)}`, whole: "data", event: "event", special: new Map() };
      const text = rewrite(d.code, env, out, todo);
      const read = reads(d.code, env);
      const type =
        read === "opaque" || fs === null
          ? (model.context.whole ?? "{}")
          : `{ ${[...read].map((f) => `${key(f)}: ${fs.get(f)?.type ?? "unknown"}`).join("; ")} }`;
      return `${key(d.name)}: ({ data }: { data: ${type} }) => ${text}`;
    });
    shape.push(`delays: ${obj(list)}`);
  }
  if (model.emitted.size > 0) shape.push(`emitted: ${obj([...model.emitted].map(([k, t]) => `${key(k)}: ${t}`))}`);
  const states = an.leaves.map((leaf) => {
    let type: string;
    if (an.whole) {
      const w = model.context.whole;
      type = w === null ? "types<{}>()" : model.context.schema ? w : `types<${w}>()`;
      const t: Todo = { at: leaf.at, message: `narrow this state's data to the fields it uses: ${an.whole}` };
      todos.push(t);
      return `${comment([t])}${key(leaf.name)}: ${type}`;
    } else {
      const f = fields(leaf);
      type = `types<${f.size === 0 ? "{}" : `{ ${[...f].map(([k, t]) => `${key(k)}: ${t}`).join("; ")} }`}>()`;
    }
    return `${key(leaf.name)}: ${type}`;
  });
  shape.push(`states: ${obj(states)}`);
  shape.push(`events: ${obj([...model.events.values()].map((e) => `${key(e.name)}: ${e.value}`))}`);
  if (internalTypes.length > 0) shape.push(`internal: ${obj(internalTypes)}`);
  for (const [name, m] of model.spawned) {
    const other = childMachines.get(name);
    if (other !== undefined && other !== m) todo(model.at, `child "${name}" runs ${other} and ${m}: rename one`);
    else childMachines.set(name, m);
  }
  if (childMachines.size > 0)
    shape.push(`children: ${obj([...childMachines].map(([id, m]) => (id === m ? id : `${key(id)}: ${m}`)))}`);

  // #endregion

  const head = comment(todos);
  const machine = `${doc(model.root.description)}${model.exported ? "export " : ""}const ${model.name} = ${shapeName}.machine({\n${start},\nstates: {\n${entries.join(",\n")},\n},\n});`;
  const text = `${stubs}${head}const ${shapeName} = setup({\n${shape.join(",\n")},\n});\n\n${machine}`;
  const imports = new Map<string, readonly string[]>(
    use.map((f) => [f, [f, ...[...(model.imports.get(f) ?? [])].sort()]]),
  );
  return { text, internal, features: use, imports };
}

/**
 * The opt-ins the codemod writes, in the order `use` lists them. Each is the value
 * `@reactre/state/<name>` exports under its own name.
 */
export const FEATURES: readonly string[] = [
  "nested",
  "parallel",
  "history",
  "output",
  "children",
  "logic",
  "effects",
  "provide",
  "emit",
  "spawn",
  "delays",
  "timeout",
  "always",
  "reenter",
  "tags",
  "wildcards",
  "validate",
];

/** Whether an effect reads the event (an entry's or an exit's can't: it has none). */
function effectReadsEvent(e: Effect): boolean {
  const arg = (a: Arg): boolean =>
    a.kind === "code" || a.kind === "thunk"
      ? readsEvent(a.code)
      : a.kind === "object"
        ? a.entries.some(([, v]) => arg(v))
        : false;
  const condEvent = (c: Cond): boolean =>
    c.kind === "code"
      ? readsEvent(c.code)
      : c.kind === "and" || c.kind === "or"
        ? c.items.some(condEvent)
        : c.kind === "not"
          ? condEvent(c.item)
          : c.kind === "stub" && c.params !== null && readsEvent(c.params);
  return e.kind === "enq"
    ? e.args.some(arg)
    : condEvent(e.cond) || e.then.some(effectReadsEvent) || e.otherwise.some(effectReadsEvent);
}

/**
 * An object literal: on one line, for the formatter to break when it is too long, or one property
 * per line when one has a comment.
 */
function obj(items: readonly string[]): string {
  if (items.length === 0) return "{}";
  return items.some((i) => i.includes("\n")) ? `{\n${items.join(",\n")},\n}` : `{ ${items.join(", ")} }`;
}

/** A message on one line, for a `//` comment: the source text it quotes can span lines. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

/** A `description`, kept as a comment. */
function doc(description: string | null): string {
  if (description === null) return "";
  return description
    .split(/\r?\n/)
    .map((line) => `// ${line}`.trimEnd())
    .join("\n")
    .concat("\n");
}

/** The descriptions of a transition's branches, kept as comments. */
function described(handlers: readonly Handler[]): string {
  return handlers.flatMap((h) => (h.kind === "branches" ? h.branches.map((b) => doc(b.description)) : [])).join("");
}

/** A property access: `.name`, or `["a name"]`. */
export function member(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function collect(node: SNode): SNode[] {
  return [node, ...node.children.flatMap((c) => collect(c))];
}

function objectOf(values: ReadonlyMap<string, string>): string {
  return `{ ${[...values].map(([k, v]) => `${key(k)}: ${v}`).join(", ")} }`;
}

function paren(text: string): string {
  return /^[\w$.]+$/.test(text) ? text : `(${text})`;
}

/** The free names an expression or function text reads (not property names). */
export function freeNames(text: string): Set<string> {
  const out = new Set<string>();
  const parsed = parseSync("x.ts", `(${text});`, { lang: "ts", sourceType: "module" });
  if (parsed.errors.length > 0) {
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
    return out;
  }
  walk(parsed.program, (n, parent, k) => {
    if (n.type === "Identifier" && isReference(parent, k)) out.add(n.name);
    return true;
  });
  return out;
}
