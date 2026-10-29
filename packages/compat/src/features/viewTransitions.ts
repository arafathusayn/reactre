// @reactre/compat/features/viewTransitions: React's view transitions. Loading this module installs
// them into @reactre/compat/core; @reactre/compat loads it, and @reactre/plugin's generated entry
// loads it while the `viewTransitions` key is on (which needs `concurrentRendering`, React's
// transition lanes). Without it, `<ViewTransition>` renders its children and a transition commits
// without `document.startViewTransition`.
//
// Design decisions:
//   - What React's commit does for a transition or a reveal (its lanes eligible for a view
//     transition) is done here on compat's undo machinery: the render is held (see the core's
//     Pending), its DOM changes undone and its fibers put back, so the names of what leaves or
//     changes go on the old DOM, as React's before-mutation phase puts them; then
//     `document.startViewTransition`'s update makes the render again and commits it, and the
//     names of what enters or changed go on the new DOM, as its after-mutation phase does. A
//     browser without the API commits at once, as React's does when the call throws.
//   - React decides from its fibers' flags which boundaries a commit touches. Compat keeps no
//     flags, so `plan` works them out from the fibers saved before the render: a fiber is new,
//     a host's props or a text changed, children went or moved, or content was hidden or shown.
//   - Everything here runs only for a held commit whose tree has a `<ViewTransition>`: the core
//     tests one variable on the transition path.

import { __installViewTransitions, type VtCore } from "../core.ts";

// biome-ignore lint: fibers, props and DOM nodes are opaque here.
type Any = any;

/** React's ViewTransitionPseudoElement: a view transition's pseudo-element, as an event's instance has it. */
class PseudoElement {
  _scope: Any;
  _selector: string;
  constructor(pseudo: string, name: string) {
    this._scope = document.documentElement;
    this._selector = "::view-transition-" + pseudo + "(" + name + ")";
  }
  animate(keyframes: Any, options: Any): Any {
    const o = typeof options === "number" ? { duration: options } : { ...options };
    o.pseudoElement = this._selector;
    return this._scope.animate(keyframes, o);
  }
  getAnimations(): Any[] {
    const out: Any[] = [];
    for (const a of this._scope.getAnimations({ subtree: true })) {
      const e = a.effect;
      if (e !== null && e.target === this._scope && e.pseudoElement === this._selector) out.push(a);
    }
    return out;
  }
  getComputedStyle(): Any {
    return getComputedStyle(this._scope, this._selector);
  }
}

/** What a commit does to view transitions: worked out by `plan`, used by the phases after it. */
interface Plan {
  /** The fibers' fields before the render: children, props, flags. */
  readonly old: Map<Any, Any[]>;
  /** Fibers whose own render changed what the DOM shows (see own), and those under which one did. */
  readonly changed: Map<Any, boolean>;
  /** What the before-mutation phase does, in pairs (op, fiber), in React's order. */
  readonly ops: Any[];
  /** The props each ViewTransition renders with now. */
  readonly props: Map<Any, Any>;
  /** Named ViewTransitions that mount: what an exit of the same name pairs with. */
  appearing: Map<string, Any> | null;
  /** Whether a name was set before the commit: React starts a view transition only then. */
  start: boolean;
  /** Each updated ViewTransition's measurements before the commit. */
  readonly measured: Map<Any, Any[]>;
  /** ViewTransitions whose content changed (React's Update flag), and whose size changed. */
  readonly updated: Set<Any>;
  readonly resized: Set<Any>;
  /**
   * Each element given a name, its host fiber, the props it had then, its name and class, and the
   * events to call when it is ready. React restores an updated boundary's names from its old props, then its new.
   */
  readonly named: Any[];
  readonly events: Any[];
  /** The roots, and whether React hid the root's own transition. */
  readonly roots: Any[];
  canceled: boolean;
  /** The transition's types. */
  types: string[] | null;
  /** The document of the roots' containers, whose startViewTransition starts it. */
  readonly doc: Any;
}

function viewTransitions(core: VtCore) {
  const { FRAG, TEXT, ACTIVITY, SLOT, BOX, HIDDEN, DEAD, VIEW_TRANSITION } = core;
  const isVT = (f: Any): boolean => f.n === FRAG && f.t === VIEW_TRANSITION;
  /** `f`'s children in tree order: a compiled template's holes (slots) are kept in the order they filled. */
  const kids = (f: Any): Any[] => (f.c.length > 1 && f.c[0].n === SLOT ? [...f.c].sort((a, b) => a.k - b.k) : f.c);
  // A fiber's view transition state (React's ViewTransitionState): its name when it has none, the
  // boundary it pairs with, and its events' instance.
  const states = new WeakMap<Any, { autoName: string | null; paired: Any; ref: Any }>();
  const stateOf = (f: Any) => {
    let s = states.get(f);
    if (s === undefined) states.set(f, (s = { autoName: null, paired: null, ref: null }));
    return s;
  };
  let autoNames = 0;

  // The plan being carried out, and the measuring state of React's commit.
  let p: Plan = null as Any;
  let hostIndex = 0;
  let cancelable: Any[] | null = null;
  let contextChanged = false;

  /** React's getViewTransitionName: the `name` prop, or a name made once for the boundary. */
  function nameOf(f: Any, props: Any): string {
    if (props.name != null && props.name !== "auto") return props.name;
    const s = stateOf(f);
    return (s.autoName ??= "_" + f.o.prefix + "t_" + (autoNames++).toString(32) + "_");
  }

  /** React's getClassNameByType: a class, or the classes of the transition's types. */
  function classByType(c: Any, types: string[] | null): Any {
    if (c == null || typeof c === "string") return c;
    let out: Any = null;
    if (types !== null)
      for (const t of types) {
        const m = c[t];
        if (m != null) {
          if (m === "none") return "none";
          out = out == null ? m : out + " " + m;
        }
      }
    return out == null ? c.default : out;
  }
  let types: string[] | null = null;
  /** React's getViewTransitionClassName. */
  function classOf(def: Any, event: Any): Any {
    const d = classByType(def, types),
      e = classByType(event, types);
    return e == null ? (d === "auto" ? null : d) : e === "auto" ? null : e;
  }

  /** Where element `el` is, as React's measureInstance measures it. */
  function measure(el: Any): Any {
    const rect = el.getBoundingClientRect(),
      cs = getComputedStyle(el),
      w = el.ownerDocument.defaultView;
    return {
      rect,
      abs: cs.position === "absolute" || cs.position === "fixed",
      clip:
        cs.clipPath !== "none" ||
        cs.overflow !== "visible" ||
        cs.filter !== "none" ||
        cs.mask !== "none" ||
        cs.borderRadius !== "0px",
      view: rect.bottom >= 0 && rect.right >= 0 && rect.top <= w.innerHeight && rect.left <= w.innerWidth,
    };
  }

  /** React's applyViewTransitionName. */
  function applyName(f: Any, el: Any, name: string, cls: Any): void {
    name = CSS.escape(name) !== name ? "r-" + btoa(name).replace(/=/g, "") : name;
    p.named.push(el, f, f.p, name, cls);
    setName(el, name, cls);
  }
  function setName(el: Any, name: string, cls: Any): void {
    el.style.viewTransitionName = name;
    if (cls != null) el.style.viewTransitionClass = cls;
    const cs = getComputedStyle(el);
    if (cs.display === "inline") {
      const rects = el.getClientRects();
      let n = 0;
      if (rects.length === 1) n = 1;
      else for (const r of rects) if (r.width > 0 && r.height > 0) n++;
      if (n === 1) {
        const s = el.style;
        s.display = rects.length === 1 ? "inline-block" : "block";
        s.marginTop = "-" + cs.paddingTop;
        s.marginBottom = "-" + cs.paddingBottom;
      }
    }
  }

  /** React's restoreViewTransitionName: what element `el`'s own style props set. */
  function restoreName(el: Any, props: Any): void {
    const s = el.style,
      st = props.style;
    const read = (a: string, b: string): Any =>
      st != null ? (Object.hasOwn(st, a) ? st[a] : Object.hasOwn(st, b) ? st[b] : null) : null;
    const str = (v: Any): string => (v == null || typeof v === "boolean" ? "" : ("" + v).trim());
    s.viewTransitionName = str(read("viewTransitionName", "view-transition-name"));
    s.viewTransitionClass = str(read("viewTransitionClass", "view-transition-class"));
    if (s.display === "inline-block") {
      if (st == null) s.display = s.margin = "";
      else {
        const v = (x: Any): string => (x == null || typeof x === "boolean" ? "" : x);
        s.display = v(st.display);
        if (st.margin != null) s.margin = st.margin;
        else {
          s.marginTop = v(read("marginTop", "margin-top"));
          s.marginBottom = v(read("marginBottom", "margin-bottom"));
        }
      }
    }
  }

  /** A fiber that places an element of its own: React's host instances. */
  const element = (f: Any): boolean => (f.f & BOX) !== 0 && f.n !== TEXT && f.d.nodeType === 1;

  /** React's applyViewTransitionToHostInstances: the names on the elements nearest under `f`. */
  function applyHosts(f: Any, name: string, cls: Any, out: Any[] | null, stop: boolean): boolean {
    hostIndex = 0;
    return applyIn(kids(f), name, cls, out, stop);
  }
  function applyIn(cs: Any[], name: string, cls: Any, out: Any[] | null, stop: boolean): boolean {
    let view = false;
    for (const c of cs) {
      if (element(c)) {
        const m = measure(c.d);
        if (out !== null) out.push(m);
        if (m.view) view = true;
        p.start = true;
        applyName(c, c.d, hostIndex === 0 ? name : name + "_" + hostIndex, cls);
        hostIndex++;
      } else if (!(c.f & HIDDEN) && !(isVT(c) && stop) && applyIn(kids(c), name, cls, out, stop)) view = true;
    }
    return view;
  }
  /** React's restoreViewTransitionOnHostInstances. */
  function restoreIn(cs: Any[], stop: boolean): void {
    for (const c of cs) {
      if (element(c)) restoreName(c.d, c.p);
      else if (!(c.f & HIDDEN) && !(isVT(c) && stop)) restoreIn(kids(c), stop);
    }
  }

  /** React's scheduleViewTransitionEvent. */
  function event(f: Any, props: Any, cb: Any): void {
    if (cb == null) return;
    const s = stateOf(f),
      name = nameOf(f, props);
    s.ref ??= {
      name,
      group: new PseudoElement("group", name),
      imagePair: new PseudoElement("image-pair", name),
      old: new PseudoElement("old", name),
      new: new PseudoElement("new", name),
    };
    p.events.push(cb, s.ref);
  }

  /**
   * Whether `f`'s subtree holds a ViewTransition (React's static flag), which an element hides:
   * React clears it from a host's subtree, so a boundary inside an element that enters or leaves
   * does not animate.
   */
  const holds = (f: Any): boolean => isVT(f) || (!(f.f & BOX) && f.c.some(holds));
  /** Whether a ViewTransition is anywhere under `f`. */
  const anyVT = (f: Any): boolean => isVT(f) || f.c.some(anyVT);

  // #region Working out the commit

  /** Whether `f`, as rendered, shows something other than it did (React's flags on it). */
  function own(f: Any): boolean {
    const o = p.old.get(f);
    if (o === undefined) return true;
    // A host, a text or a compiled template whose props or text changed (React marks a host
    // given new props).
    if (f.f & BOX && o[1] !== f.p) return true;
    if ((o[2] ^ f.f) & HIDDEN) return true;
    const oc = o[0];
    if (oc.length !== f.c.length) return true;
    for (let i = 0; i < oc.length; i++) if (oc[i] !== f.c[i]) return true;
    return false;
  }
  /** Whether anything under `f` changed (React's subtree flags). */
  function under(f: Any): boolean {
    let any = false;
    for (const c of kids(f)) if (changed(c)) any = true;
    return any;
  }
  function changed(f: Any): boolean {
    let c = p.changed.get(f);
    if (c === undefined) p.changed.set(f, (c = under(f) || own(f)));
    return c;
  }
  const hiddenNow = (f: Any): boolean => (f.f & HIDDEN) !== 0;

  /** React's commitBeforeMutationEffects, worked out on the new tree as ops for the old one. */
  function visit(f: Any): void {
    const o = p.old.get(f);
    if (o !== undefined) for (const d of o[0]) if (d.f & DEAD) p.ops.push(0, d);
    if (o === undefined) {
      if (holds(f)) p.start = true;
      return;
    }
    if ((o[2] ^ f.f) & HIDDEN && (f.n === ACTIVITY || f.n === FRAG)) {
      if (hiddenNow(f)) p.ops.push(1, f);
      else if (holds(f)) p.start = true;
      return;
    }
    if (under(f)) for (const c of kids(f)) visit(c);
    else p.ops.push(2, f);
    if (isVT(f)) {
      p.props.set(f, f.p);
      p.ops.push(3, f);
    }
  }

  /** Named ViewTransitions mounting (React's appearing view transitions), under new fiber `f`. */
  function appear(f: Any, isNew: boolean): void {
    if (f.f & HIDDEN) return;
    if (isNew && isVT(f) && f.p.name != null && f.p.name !== "auto") {
      stateOf(f).paired = null;
      (p.appearing ??= new Map()).set(f.p.name, stateOf(f));
    }
    for (const c of kids(f)) appear(c, isNew || !p.old.has(c));
  }

  // #endregion

  // #region Before the commit (the old DOM and fibers)

  /** React's commitExitViewTransitions, for removed fiber `d`. */
  function exit(d: Any): void {
    if (isVT(d)) {
      const props = d.p,
        name = nameOf(d, props),
        pair = p.appearing !== null ? p.appearing.get(name) : undefined,
        cls = classOf(props.default, pair !== undefined ? props.share : props.exit);
      if (cls !== "none") {
        if (applyHosts(d, name, cls, null, false)) {
          if (pair !== undefined) {
            const s = stateOf(d);
            pair.paired = s;
            s.paired = pair;
            p.appearing!.delete(name);
            event(d, props, props.onShare);
          } else event(d, props, props.onExit);
        } else restoreIn(kids(d), false);
      }
      if (p.appearing !== null) pairs(d);
    } else if (holds(d)) for (const c of kids(d)) exit(c);
    else if (p.appearing !== null) pairs(d);
  }
  /** React's commitDeletedPairViewTransitions. */
  function pairs(d: Any): void {
    const a = p.appearing!;
    if (a.size === 0) return;
    for (const c of kids(d)) {
      if (c.f & HIDDEN) continue;
      if (isVT(c)) {
        const props = c.p,
          name = props.name;
        if (name != null && name !== "auto") {
          const pair = a.get(name);
          if (pair !== undefined) {
            const cls = classOf(props.default, props.share);
            if (cls !== "none") {
              if (applyHosts(c, name, cls, null, false)) {
                const s = stateOf(c);
                pair.paired = s;
                s.paired = pair;
                event(c, props, props.onShare);
              } else restoreIn(kids(c), false);
            }
            a.delete(name);
            if (a.size === 0) return;
          }
        }
      }
      pairs(c);
    }
  }
  /** React's commitNestedViewTransitions: the ViewTransitions nearest under unchanged `f`. */
  function nested(f: Any): void {
    for (const c of kids(f)) {
      if (isVT(c)) {
        const cls = classOf(c.p.default, c.p.update);
        p.updated.delete(c);
        const m: Any[] = [];
        p.measured.set(c, m);
        if (cls !== "none") applyHosts(c, nameOf(c, c.p), cls, m, false);
      } else if (holds(c)) nested(c);
    }
  }

  // #endregion

  // #region After the commit (the new DOM and fibers)

  /** React's measureViewTransitionHostInstancesRecursive. */
  function measureIn(
    vt: Any,
    cs: Any[],
    name: string,
    oldName: string,
    cls: Any,
    prev: Any[] | null,
    stop: boolean,
  ): boolean {
    let view = false;
    for (const c of cs) {
      if (element(c)) {
        const el = c.d;
        if (prev !== null && hostIndex < prev.length) {
          const a = prev[hostIndex],
            b = measure(el);
          if (a.view || b.view) view = true;
          if (!p.updated.has(vt)) {
            const r = a.rect,
              s = b.rect;
            if (b.clip || r.y !== s.y || r.x !== s.x || r.height !== s.height || r.width !== s.width) p.updated.add(vt);
          }
          const sized = b.abs ? !a.abs : a.rect.height !== b.rect.height || a.rect.width !== b.rect.width;
          if (sized) p.resized.add(vt);
        } else p.resized.add(vt);
        if (p.updated.has(vt)) applyName(c, el, hostIndex === 0 ? name : name + "_" + hostIndex, cls);
        if (!view || !p.updated.has(vt))
          (cancelable ??= []).push(el, hostIndex === 0 ? oldName : oldName + "_" + hostIndex, c.p);
        hostIndex++;
      } else if (!(c.f & HIDDEN)) {
        if (isVT(c) && stop) {
          if (p.resized.has(c)) p.resized.add(vt);
        } else if (measureIn(vt, kids(c), name, oldName, cls, prev, stop)) view = true;
      }
    }
    return view;
  }
  /** React's measureNestedViewTransitions. */
  function measureNested(f: Any): void {
    for (const c of kids(f)) {
      if (isVT(c)) {
        const props = c.p,
          name = nameOf(c, props),
          cls = classOf(props.default, props.update);
        hostIndex = 0;
        const view = measureIn(c, kids(c), name, name, cls, p.measured.get(c) ?? null, false);
        p.measured.delete(c);
        if (p.updated.has(c) && view) event(c, props, props.onUpdate);
      } else if (holds(c)) measureNested(c);
    }
  }
  /** React's commitEnterViewTransitions, for new fiber (or shown content) `f`. */
  function enter(f: Any): void {
    if (isVT(f)) {
      const s = stateOf(f),
        props = f.p,
        name = nameOf(f, props),
        cls = classOf(props.default, s.paired ? props.share : props.enter);
      if (cls !== "none") {
        if (applyHosts(f, name, cls, null, false)) {
          appearing(f);
          if (!s.paired) event(f, props, props.onEnter);
        } else restoreIn(kids(f), false);
      } else appearing(f);
    } else if (holds(f)) for (const c of kids(f)) enter(c);
    else appearing(f);
  }
  /** React's commitAppearingPairViewTransitions. */
  function appearing(f: Any): void {
    for (const c of kids(f)) {
      if (c.f & HIDDEN) continue;
      appearing(c);
      // Only a named boundary pairs, so its name is its own (React throws #544 for none).
      if (isVT(c) && stateOf(c).paired) {
        const props = c.p,
          cls = classOf(props.default, props.share);
        if (cls !== "none" && !applyHosts(c, props.name, cls, null, false)) restoreIn(kids(c), false);
      }
    }
  }
  /** React's commitAfterMutationEffectsOnFiber. */
  function after(f: Any): void {
    const o = p.old.get(f);
    if (o === undefined) return enter(f);
    if ((f.n === ACTIVITY || f.n === FRAG) && (o[2] | f.f) & HIDDEN) {
      if (!hiddenNow(f)) o[2] & HIDDEN ? enter(f) : traverse(f);
      return;
    }
    if (!isVT(f)) return traverse(f);
    const prevChanged = contextChanged,
      prevCancelable = cancelable;
    cancelable = null;
    contextChanged = false;
    traverse(f);
    if (contextChanged) p.updated.add(f);
    const props = f.p,
      name = nameOf(f, props),
      oldName = nameOf(f, o[1]),
      cls = classOf(props.default, props.update);
    let view = false;
    if (cls !== "none") {
      const prev = p.measured.get(f) ?? null;
      p.measured.delete(f);
      hostIndex = 0;
      view = measureIn(f, kids(f), name, oldName, cls, prev, true);
      if (hostIndex !== (prev === null ? 0 : prev.length)) p.resized.add(f);
    }
    if (p.updated.has(f) && view) {
      event(f, props, props.onUpdate);
      cancelable = prevCancelable;
    } else if (prevCancelable !== null) {
      prevCancelable.push(...(cancelable ?? []));
      cancelable = prevCancelable;
    }
    contextChanged = p.resized.has(f) ? true : prevChanged;
  }
  /** React's recursivelyTraverseAfterMutationEffects. */
  function traverse(f: Any): void {
    if (under(f)) for (const c of kids(f)) after(c);
    else measureNested(f);
  }

  // #endregion

  return {
    plan(roots: Set<Any>, sv: Any[], records: MutationRecord[]): Plan | null {
      const old = new Map<Any, Any[]>();
      let any = false;
      for (let i = 0; i < sv.length;) {
        const f = sv[i];
        // A root's own fields: four.
        if (f.n === undefined) {
          i += 4;
          continue;
        }
        old.set(f, [sv[i + 3], sv[i + 1], sv[i + 6]]);
        if (isVT(f)) any = true;
        i += 16;
        if (sv[i - 1] !== null) i++;
      }
      p = {
        old,
        changed: new Map(),
        ops: [],
        props: new Map(),
        appearing: null,
        start: false,
        measured: new Map(),
        updated: new Set(),
        resized: new Set(),
        named: [],
        events: [],
        roots: [...roots],
        canceled: false,
        types: null,
        doc: [...roots].map((r) => (r.f.d.nodeType === 9 ? r.f.d : r.f.d.ownerDocument))[0],
      };
      for (const r of roots) if (anyVT(r.f)) any = true;
      if (!any) return null;
      for (const r of roots) {
        appear(r.f, false);
        visit(r.f);
      }
      // Content a ViewTransition holds changed (React's Update flag, set as its mutation runs): the
      // fibers that place each node, old and new, find the boundary above a change.
      const byNode = new Map<Any, Any>();
      for (const f of old.keys()) if (f.f & BOX) byNode.set(f.d, f);
      const placing = (f: Any): void => {
        if (f.f & BOX) byNode.set(f.d, f);
        for (const c of kids(f)) placing(c);
      };
      for (const r of roots) placing(r.f);
      const fiberOf = (n: Any): Any => {
        while (n != null && !byNode.has(n)) n = n.parentNode;
        return n == null ? null : byNode.get(n);
      };
      for (const rec of records) {
        const nodes = rec.type === "childList" ? [...rec.addedNodes, ...rec.removedNodes] : [rec.target];
        for (const n of nodes) {
          let fiber: Any = fiberOf(n);
          if (fiber === null && rec.type === "childList") fiber = fiberOf(rec.target);
          for (; fiber !== null; fiber = fiber.r)
            if (isVT(fiber)) {
              if (old.has(fiber)) p.updated.add(fiber);
              break;
            }
        }
      }
      return p;
    },
    before(plan: Plan, t: string[] | null): boolean {
      p = plan;
      types = plan.types = t;
      for (let i = 0; i < p.ops.length; i += 2) {
        const f = p.ops[i + 1];
        switch (p.ops[i]) {
          case 0:
          case 1:
            exit(f);
            break;
          case 2:
            nested(f);
            break;
          default: {
            const props = p.props.get(f),
              cls = classOf(props.default, props.update),
              m: Any[] = [];
            p.measured.set(f, m);
            if (cls !== "none") applyHosts(f, nameOf(f, f.p), cls, m, true);
          }
        }
      }
      p.appearing = null;
      return p.start;
    },
    after(plan: Plan): void {
      p = plan;
      types = plan.types;
      // The commit set the style attributes its render left, without the old page's names; React's
      // mutations keep them, as on content an Activity hides.
      const n = p.named;
      for (let i = 0; i < n.length; i += 5) if (n[i].style.viewTransitionName === "") setName(n[i], n[i + 3], n[i + 4]);
      for (const r of p.roots) {
        contextChanged = false;
        cancelable = null;
        traverse(r.f);
        if (!contextChanged) {
          const c = cancelable as Any[] | null;
          const doc = r.f.d.nodeType === 9 ? r.f.d.documentElement : r.f.d.ownerDocument.documentElement;
          if (c !== null)
            for (let i = 0; i < c.length; i += 3) {
              restoreName(c[i], c[i + 2]);
              doc.animate(
                { opacity: [0, 0], pointerEvents: ["none", "none"] },
                { duration: 0, fill: "forwards", pseudoElement: "::view-transition-group(" + c[i + 1] + ")" },
              );
            }
          if (doc.style.viewTransitionName === "") {
            doc.style.viewTransitionName = "none";
            doc.animate(
              { opacity: [0, 0], pointerEvents: ["none", "none"] },
              { duration: 0, fill: "forwards", pseudoElement: "::view-transition-group(root)" },
            );
            doc.animate(
              { width: [0, 0], height: [0, 0] },
              { duration: 0, fill: "forwards", pseudoElement: "::view-transition" },
            );
          }
          p.canceled = true;
        }
        cancelable = null;
      }
    },
    ready(plan: Plan, finished: Promise<unknown>): void {
      for (let i = 0; i < plan.events.length; i += 2) {
        const cleanup = plan.events[i](plan.events[i + 1], plan.types ?? []);
        if (cleanup !== undefined) finished.finally(cleanup);
      }
    },
    done(plan: Plan): void {
      const n = plan.named;
      for (let i = 0; i < n.length; i += 5) if (!(n[i + 1].f & DEAD)) restoreName(n[i], n[i + 2]);
      if (plan.canceled)
        for (const r of plan.roots) {
          const c = r.f.d,
            body = c.nodeType === 9 ? c.body : c.nodeName === "HTML" ? c.ownerDocument.body : c;
          if (body.style.viewTransitionName === "root") body.style.viewTransitionName = "";
          const doc = body.ownerDocument.documentElement;
          if (doc !== null && doc.style.viewTransitionName === "none") doc.style.viewTransitionName = "";
        }
    },
  };
}

__installViewTransitions(viewTransitions);
