// XState's one shared context, split into per-state data.
//
// Every leaf starts with the context's type, then keeps only the fields it needs, when the source
// proves it:
//   - the fields its own transitions (and its parents') read;
//   - the fields the transitions into it set to something other than null;
//   - the fields a later state needs that no transition on the way sets (they are carried);
//   - for a final state, every field that holds a value there: it is the machine's result.
// A field that is null for sure in a state is dropped where nothing reads it; a transition that
// carries it on writes `null`. A field known never to be null there loses `| null` from its type.
//
// When the source uses the context whole (passes it to a function, spreads it into something else,
// updates it with a value built elsewhere) or its type isn't written in this file, each state keeps
// the whole context, and the report says to narrow it.

import { keyName, lineOf } from "./ast.ts";
import { EMPTY_SCOPE, type Env, join, type Kind, kindOf, reads } from "./expr.ts";
import type {
  Arg,
  Code,
  Cond,
  Effect,
  Field,
  FnEffects,
  Handler,
  MachineModel,
  SNode,
  TargetSpec,
  Todo,
  Write,
} from "./model.ts";

/** Where a transition goes, as @reactre/state writes it. */
export type Plan =
  | { readonly kind: "leaf"; readonly leaf: SNode }
  | {
      readonly kind: "parallel";
      readonly node: SNode;
      readonly regions: readonly { readonly region: SNode; readonly plan: Plan }[];
    }
  | { readonly kind: "back"; readonly parent: SNode; readonly fallback: Plan };

/** A transition from one leaf, as the analysis sees it. */
interface Edge {
  readonly from: SNode;
  /** The node that declares it. */
  readonly decl: SNode;
  readonly reads: Set<string> | "opaque";
  readonly writes: readonly Write[] | "opaque";
  /** The leaves it enters (the fallback of a `back`); `[from]` when it stays. */
  readonly targets: readonly SNode[];
  readonly eventFields: ReadonlyMap<string, Field> | null;
}

export interface Analysis {
  /** Where the machine starts. */
  readonly start: Plan | null;
  readonly leaves: readonly SNode[];
  /** Each leaf keeps the whole context, and why; null when each leaf's data is narrowed. */
  readonly whole: string | null;
  /** Each leaf's fields, in the context's order, with their types. */
  readonly fields: ReadonlyMap<SNode, ReadonlyMap<string, string>>;
  /** The parallel node a leaf is in, and its region there. */
  readonly region: (leaf: SNode) => { readonly parallel: SNode; readonly region: SNode } | null;
  /** The region of P that holds a field. */
  readonly owner: (parallel: SNode, field: string) => SNode | null;
  readonly resolve: (spec: TargetSpec, from: SNode) => Plan | null;
  readonly enter: (node: SNode) => Plan | null;
  readonly leavesUnder: (node: SNode) => SNode[];
  readonly planLeaves: (plan: Plan) => SNode[];
  readonly root: SNode;
}

export function analyze(model: MachineModel, todos: Todo[]): Analysis {
  const env: Env = model.env;
  const todo = (at: number, message: string): void => {
    todos.push({ at, message });
  };
  const root = model.root;

  // #region The tree

  const all: SNode[] = [];
  const visit = (n: SNode): void => {
    all.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  const leaves = all.filter((n) => n !== root && (n.type === "atomic" || n.type === "final"));
  const leavesUnder = (n: SNode): SNode[] =>
    n.type === "atomic" || n.type === "final" ? [n] : n.children.flatMap((c) => leavesUnder(c));
  const ancestors = (n: SNode): SNode[] => {
    const out: SNode[] = [];
    for (let p: SNode | null = n; p !== null; p = p.parent) out.push(p);
    return out;
  };
  const region = (leaf: SNode): { parallel: SNode; region: SNode } | null => {
    for (let n: SNode = leaf; n.parent !== null; n = n.parent)
      if (n.parent.type === "parallel") return { parallel: n.parent, region: n };
    return null;
  };
  if (root.type === "parallel") todo(root.at, "a parallel machine root: wrap its regions in a named parallel state");

  const byId = new Map<string, SNode>();
  for (const n of all) if (n.id !== null) byId.set(n.id, n);

  /** A node by reference: "sibling.child", ".child", "#id.child". */
  const lookup = (ref: string, from: SNode): SNode | null => {
    let base: SNode | null;
    let path: string[];
    if (ref.startsWith("#")) {
      const [id = "", ...rest] = ref.slice(1).split(".");
      base = byId.get(id) ?? null;
      path = rest;
    } else if (ref.startsWith(".")) {
      base = from;
      path = ref.slice(1).split(".");
    } else {
      base = from.parent ?? from;
      path = ref.split(".");
    }
    for (const seg of path) {
      if (base === null) return null;
      base = base.children.find((c) => c.key === seg) ?? null;
    }
    return base;
  };

  const enter = (node: SNode): Plan | null => {
    switch (node.type) {
      case "atomic":
      case "final":
        return { kind: "leaf", leaf: node };
      case "compound": {
        const first = node.initial === null ? null : lookup(`.${node.initial.refs[0] ?? ""}`, node);
        if (first === null) {
          todo(node.at, `state "${node.name}" has no initial state the codemod can find: name the leaf to go to`);
          const any = node.children.find((c) => c.type !== "history");
          return any === undefined ? null : enter(any);
        }
        return enter(first);
      }
      case "parallel": {
        const regions: { region: SNode; plan: Plan }[] = [];
        for (const r of node.children) {
          if (r.type === "history") continue;
          const plan = enter(r);
          if (plan !== null) regions.push({ region: r, plan });
        }
        return { kind: "parallel", node, regions };
      }
      case "history": {
        const parent = node.parent;
        if (parent === null) return null;
        const def = node.history?.target ?? null;
        const fallbackNode = def === null ? parent : lookup(def.refs[0] ?? "", node);
        const fallback = fallbackNode === null ? null : fallbackNode === parent ? enter(parent) : enter(fallbackNode);
        if (fallback === null) return null;
        if (parent.type === "parallel" || region(node) !== null)
          todo(node.at, "history inside a parallel state isn't supported: go back to the parallel state itself");
        if (node.history?.deep !== true && parent.children.some((c) => c.type === "compound" || c.type === "parallel"))
          todo(node.at, "shallow history: @reactre/state's back is deep (it restores the last leaf, with its data)");
        return { kind: "back", parent, fallback };
      }
    }
  };

  const resolve = (spec: TargetSpec, from: SNode): Plan | null => {
    const nodes = spec.refs.map((r) => lookup(r, from));
    if (nodes.some((n) => n === null)) {
      todo(spec.at, `target ${spec.refs.map((r) => JSON.stringify(r)).join(", ")} isn't a state the codemod can find`);
      return null;
    }
    const found = nodes.filter((n): n is SNode => n !== null);
    if (found.length === 1 && found[0] !== undefined) return enter(found[0]);
    // Several targets: one per region of a parallel state.
    const parallels = found.map((n) => region(n)?.parallel ?? null);
    const p = parallels[0];
    if (p === null || p === undefined || parallels.some((x) => x !== p)) {
      todo(spec.at, "several targets that aren't regions of one parallel state: pick one");
      return null;
    }
    if (ancestors(from).includes(p))
      todo(
        spec.at,
        "several targets inside the parallel state: this enters it again, with the other regions at their start",
      );
    const regions: { region: SNode; plan: Plan }[] = [];
    for (const r of p.children) {
      if (r.type === "history") continue;
      const t = found.find((n) => ancestors(n).includes(r));
      const plan = t === undefined ? enter(r) : enter(t);
      if (plan !== null) regions.push({ region: r, plan });
    }
    return { kind: "parallel", node: p, regions };
  };

  const planLeaves = (plan: Plan): SNode[] =>
    plan.kind === "leaf"
      ? [plan.leaf]
      : plan.kind === "parallel"
        ? plan.regions.flatMap((r) => planLeaves(r.plan))
        : planLeaves(plan.fallback);

  // #endregion

  // #region Edges

  /** Why each state keeps the whole context, if it does. */
  let whole: string | null =
    model.context.fields === null
      ? "the context's type isn't written in this file, so its fields are unknown"
      : model.stubs.size > 0 && model.context.fields.size > 0
        ? `the stubs (${[...model.stubs.values()].map((s) => s.name).join(", ")}) aren't written yet, so the fields each state reads aren't known`
        : null;
  const opaque = (at: number, what: string): void => {
    whole ??= `line ${lineOf(env.source, at)} ${what}`;
  };
  const edges: Edge[] = [];
  const readsOf = (code: Code | null): Set<string> => {
    if (code === null) return new Set();
    const r = reads(code, env);
    if (r === "opaque") {
      opaque(code.node.start, "uses the context whole");
      return new Set();
    }
    return r;
  };
  const condReads = (c: Cond | null, out: Set<string>): void => {
    if (c === null) return;
    if (c.kind === "code") for (const f of readsOf(c.code)) out.add(f);
    else if (c.kind === "and" || c.kind === "or") for (const i of c.items) condReads(i, out);
    else if (c.kind === "not") condReads(c.item, out);
    else if (c.kind === "stub") for (const f of readsOf(c.params)) out.add(f);
  };
  const writeReads = (writes: readonly Write[] | "opaque", at: number, out: Set<string>): void => {
    if (writes === "opaque") {
      opaque(at, "updates the context with a value built elsewhere");
      return;
    }
    for (const w of writes) for (const f of readsOf(w.code)) out.add(f);
  };
  /** What effects read: their arguments, and their conditions. */
  const effectReads = (fx: readonly Effect[] | FnEffects, out: Set<string>): void => {
    if (isFnEffects(fx)) {
      for (const f of readsOf({ node: fx.fn.body ?? fx.fn, scope: fx.scope })) out.add(f);
      return;
    }
    const arg = (a: Arg): void => {
      if (a.kind === "code" || a.kind === "thunk") for (const f of readsOf(a.code)) out.add(f);
      else if (a.kind === "object") for (const [, v] of a.entries) arg(v);
    };
    for (const e of fx) {
      if (e.kind === "enq") for (const a of e.args) arg(a);
      else {
        condReads(e.cond, out);
        effectReads(e.then, out);
        effectReads(e.otherwise, out);
      }
    }
  };
  /** Extra reads a leaf has: its nodes' invoke inputs, entry and exit effects, computed delays. */
  const leafReads = new Map<SNode, Set<string>>();
  const addLeafReads = (n: SNode, fields: Set<string>): void => {
    for (const leaf of leavesUnder(n)) {
      const set = leafReads.get(leaf) ?? new Set<string>();
      for (const f of fields) set.add(f);
      leafReads.set(leaf, set);
    }
  };

  const handlerEdges = (
    h: Handler,
    decl: SNode,
    eventFields: ReadonlyMap<string, Field> | null,
    froms: readonly SNode[] = leavesUnder(decl),
  ): void => {
    const targetsOf = (spec: TargetSpec | null, from: SNode): SNode[] => {
      if (spec === null) return [from];
      const plan = resolveQuiet(spec, decl);
      return plan === null ? [] : planLeaves(plan);
    };
    for (const from of froms) {
      if (h.kind === "branches")
        for (const b of h.branches) {
          const r = new Set<string>();
          condReads(b.guard, r);
          writeReads(b.writes, b.at, r);
          effectReads(b.effects, r);
          edges.push({ from, decl, reads: r, writes: b.writes, targets: targetsOf(b.target, from), eventFields });
        }
      else {
        const r = readsOf({ node: h.fn.body ?? h.fn, scope: h.scope });
        for (const s of h.sites)
          if (s.kind === "to") {
            if (s.writes === "opaque") opaque(s.start, "updates the context with a value built elsewhere");
            edges.push({ from, decl, reads: r, writes: s.writes, targets: targetsOf(s.target, from), eventFields });
          }
        if (h.sites.length === 0) edges.push({ from, decl, reads: r, writes: [], targets: [], eventFields });
      }
    }
  };
  // Resolving reports problems once, when the output is written; here it stays quiet.
  const resolveQuiet = (spec: TargetSpec, from: SNode): Plan | null => {
    const before = todos.length;
    const plan = resolve(spec, from);
    todos.length = before;
    return plan;
  };

  for (const n of all) {
    for (const [event, h] of n.on) handlerEdges(h, n, model.events.get(event)?.fields ?? null);
    for (const t of n.after) {
      handlerEdges(t.handler, n, null);
      const d = t.named ? model.delays.get(t.duration ?? "") : undefined;
      if (d !== undefined) addLeafReads(n, readsOf(d.code));
    }
    if (n.always !== null) handlerEdges(n.always, n, null);
    if (n.timeout !== null) {
      handlerEdges(n.timeout.handler, n, null);
      const v = n.timeout.value;
      if (v.kind === "code") addLeafReads(n, readsOf(v.code));
      const d = n.timeout.delay === null ? undefined : model.delays.get(n.timeout.delay);
      if (d !== undefined) addLeafReads(n, readsOf(d.code));
    }
    for (const fx of [n.entry, n.exit]) {
      const r = new Set<string>();
      effectReads(fx, r);
      addLeafReads(n, r);
    }
    for (const inv of n.invokes) {
      addLeafReads(n, readsOf(inv.input));
      if (inv.onDone !== null) handlerEdges(inv.onDone, n, null);
      if (inv.onError !== null) handlerEdges(inv.onError, n, null);
    }
    // A parallel state's done runs when every region is final; a compound's (`output`), when a
    // final leaf under it is reached.
    if (n.onDone !== null && n.type === "parallel") handlerEdges(n.onDone, n, null);
    if (n.onDone !== null && n.type === "compound")
      handlerEdges(
        n.onDone,
        n,
        null,
        leavesUnder(n).filter((l) => l.type === "final"),
      );
  }

  // #endregion

  const contextFields = model.context.fields;
  const order = contextFields === null ? [] : [...contextFields.keys()];

  // #region Values: what each field holds in each leaf (forward)

  const val = new Map<SNode, Map<string, Kind>>();
  const start = startPlan(model, lookup, enter, todo);
  const initialKinds = new Map<string, Kind>();
  const initialProps = new Map<string, Code>();
  if (model.context.initial !== null)
    for (const p of model.context.initial.properties) {
      const name = p.type === "Property" ? keyName(p) : null;
      if (p.type === "Property" && name !== null)
        initialProps.set(name, { node: p.value, scope: model.context.initialScope ?? EMPTY_SCOPE });
    }
  for (const f of order) {
    const code = initialProps.get(f);
    initialKinds.set(f, code === undefined ? "null" : kindOf(code, null, null));
  }
  const merge = (leaf: SNode, kinds: ReadonlyMap<string, Kind>): boolean => {
    const cur = val.get(leaf);
    if (cur === undefined) {
      val.set(leaf, new Map(kinds));
      return true;
    }
    let changed = false;
    for (const [f, k] of kinds) {
      const next = join(cur.get(f) ?? null, k);
      if (cur.get(f) !== next) {
        cur.set(f, next);
        changed = true;
      }
    }
    return changed;
  };
  if (start !== null) for (const l of planLeaves(start)) merge(l, initialKinds);
  const applyWrites = (from: ReadonlyMap<string, Kind>, e: Edge): Map<string, Kind> => {
    const out = new Map(from);
    if (e.writes === "opaque") {
      for (const f of order) out.set(f, "maybe");
      return out;
    }
    // Each write reads the context after the writes it sees (its `seen`), not those of its own assign.
    const stages: ReadonlyMap<string, Kind>[] = [new Map(out)];
    for (const w of e.writes) {
      const before = stages[w.seen] ?? out;
      out.set(
        w.field,
        kindOf(w.code, (f) => before.get(f) ?? "maybe", e.eventFields),
      );
      stages.push(new Map(out));
    }
    return out;
  };
  for (let changed = true, rounds = 0; changed && rounds < 100; rounds++) {
    changed = false;
    for (const e of edges) {
      const from = val.get(e.from);
      if (from === undefined) continue;
      const out = applyWrites(from, e);
      for (const t of e.targets) if (merge(t, out)) changed = true;
    }
  }

  // #endregion

  // #region Needs: the fields each leaf must hold (backward)

  const written = (e: Edge): Set<string> =>
    e.writes === "opaque" ? new Set(order) : new Set(e.writes.map((w) => w.field));
  const readsAt = new Map<SNode, Set<string>>();
  const setAt = new Map<SNode, Set<string>>();
  for (const l of leaves) {
    readsAt.set(l, new Set(leafReads.get(l) ?? []));
    setAt.set(l, new Set());
  }
  if (start !== null)
    for (const l of planLeaves(start)) for (const [f, k] of initialKinds) if (k !== "null") setAt.get(l)?.add(f);
  for (const e of edges) {
    if (e.reads !== "opaque") for (const f of e.reads) readsAt.get(e.from)?.add(f);
    const from = val.get(e.from);
    if (from === undefined || e.writes === "opaque") continue;
    const out = applyWrites(from, e);
    for (const t of e.targets) for (const w of e.writes) if (out.get(w.field) !== "null") setAt.get(t)?.add(w.field);
  }

  /** For an edge that leaves a parallel state from its node (or above), the parallel state. */
  const crossing = (e: Edge): SNode | null => {
    const r = region(e.from);
    if (r === null) return null;
    return ancestors(r.parallel).includes(e.decl) ? r.parallel : null;
  };

  // Which region of each parallel state holds each field: the one whose own transitions touch it.
  const owners = new Map<SNode, Map<string, SNode>>();
  const owner = (p: SNode, field: string): SNode | null => owners.get(p)?.get(field) ?? null;
  for (const p of all.filter((n) => n.type === "parallel")) {
    const touch = new Map<string, Set<SNode>>();
    for (const e of edges) {
      const r = region(e.from);
      if (r === null || r.parallel !== p || crossing(e) !== null) continue;
      const fs = new Set<string>([...(e.reads === "opaque" ? [] : e.reads), ...written(e)]);
      for (const f of fs) {
        const set = touch.get(f) ?? new Set<SNode>();
        set.add(r.region);
        touch.set(f, set);
      }
    }
    for (const l of leavesUnder(p)) {
      const r = region(l);
      if (r === null) continue;
      for (const f of [...(leafReads.get(l) ?? [])]) {
        const set = touch.get(f) ?? new Set<SNode>();
        set.add(r.region);
        touch.set(f, set);
      }
    }
    const map = new Map<string, SNode>();
    const first = p.children.find((c) => c.type !== "history");
    for (const f of order) {
      const rs = [...(touch.get(f) ?? [])];
      if (rs.length > 1)
        todo(
          p.at,
          `regions ${rs.map((r) => `"${r.key}"`).join(" and ")} share context field ${f}: each region has its own data. Keep ${f} in one region, or send it in the events`,
        );
      const o = rs[0] ?? first;
      if (o !== undefined) map.set(f, o);
    }
    owners.set(p, map);
  }

  const need = new Map<SNode, Set<string>>();
  const parentCarry = new Map<SNode, Set<string>>();
  for (const l of leaves) {
    need.set(l, new Set([...(readsAt.get(l) ?? []), ...(setAt.get(l) ?? [])]));
    parentCarry.set(l, new Set());
    // A final state holds every field that has a value there (it is the result): the states on
    // the way carry them.
    if (l.type === "final") for (const [f, k] of val.get(l) ?? []) if (k !== "null") need.get(l)?.add(f);
  }
  for (let changed = true, rounds = 0; changed && rounds < 100; rounds++) {
    changed = false;
    for (const e of edges) {
      const mine = need.get(e.from);
      if (mine === undefined) continue;
      const w = written(e);
      const p = crossing(e);
      const r = region(e.from);
      for (const t of e.targets)
        for (const f of need.get(t) ?? []) {
          if (w.has(f)) continue;
          if (p !== null && r !== null && owner(p, f) !== r.region) continue;
          if (!mine.has(f)) {
            mine.add(f);
            changed = true;
          }
          if (e.decl !== e.from) parentCarry.get(e.from)?.add(f);
        }
    }
  }

  // #endregion

  // #region Each leaf's fields and types

  const fields = new Map<SNode, Map<string, string>>();
  for (const l of leaves) {
    const map = new Map<string, string>();
    if (!whole && contextFields !== null) {
      const v = val.get(l) ?? new Map<string, Kind>();
      const n = need.get(l) ?? new Set<string>();
      for (const f of order) {
        const kind = v.get(f) ?? "null";
        const keep =
          l.type === "final"
            ? kind !== "null" || n.has(f)
            : n.has(f) && (kind !== "null" || readsAt.get(l)?.has(f) === true || parentCarry.get(l)?.has(f) === true);
        if (!keep) continue;
        const field = contextFields.get(f);
        const typestate = l.typestate?.get(f);
        map.set(
          f,
          typestate?.type ?? (field === undefined ? "unknown" : kind === "value" ? nonNull(field) : field.type),
        );
      }
    }
    fields.set(l, map);
  }

  // A region's leaves hold only their region's fields.
  for (const p of all.filter((n) => n.type === "parallel")) {
    const seen = new Map<string, SNode>();
    for (const l of leavesUnder(p)) {
      const r = region(l)?.region;
      if (r === undefined) continue;
      for (const f of fields.get(l)?.keys() ?? []) {
        const other = seen.get(f);
        if (other !== undefined && other !== r)
          todo(
            p.at,
            `regions "${other.key}" and "${r.key}" both need context field ${f}: each region has its own data. Keep ${f} in one region, or send it in the events`,
          );
        seen.set(f, r);
      }
    }
  }

  // #endregion

  return {
    start,
    leaves,
    whole,
    fields,
    region,
    owner,
    resolve,
    enter,
    leavesUnder,
    planLeaves,
    root,
  };
}

/** Whether a node's entry or exit is v6's function, rather than actions. */
export function isFnEffects(fx: readonly Effect[] | FnEffects): fx is FnEffects {
  return "fn" in fx;
}

/** A field's type without `null` and `undefined`, for a state where it always holds a value. */
function nonNull(field: Field): string {
  const node = field.node;
  if (node?.type !== "TSUnionType") return field.type;
  const kept = node.types.filter((t) => t.type !== "TSNullKeyword" && t.type !== "TSUndefinedKeyword");
  if (kept.length === node.types.length || kept.length === 0) return field.type;
  // Types as written: each member's text, from the field's own text by offset.
  const base = node.start;
  return kept.map((t) => field.type.slice(t.start - base, t.end - base)).join(" | ");
}

/** Where the machine starts: the root's initial state, entered. */
function startPlan(
  model: MachineModel,
  lookup: (ref: string, from: SNode) => SNode | null,
  enter: (node: SNode) => Plan | null,
  todo: (at: number, message: string) => void,
): Plan | null {
  const root = model.root;
  const ref = root.initial?.refs[0];
  if (ref === undefined) {
    if (root.type !== "parallel") todo(root.at, "the machine has no initial state: write start by hand");
    return null;
  }
  const node = lookup(`.${ref}`, root);
  if (node === null) {
    todo(root.initial?.at ?? root.at, `initial state "${ref}" isn't a state the codemod can find`);
    return null;
  }
  return enter(node);
}
