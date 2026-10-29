// @reactre/compat/features/classes: the class component runtime (lifecycles, setState, error
// boundaries). Loading this module installs it into @reactre/compat/core, once, for every root;
// @reactre/compat loads it, and @reactre/plugin's generated entry loads it while `Component` is on.
// Without it, a class that renders throws a clear error.
//
// Design decisions:
//   - Class support lives in its own module so apps that opt out of it do not ship it.
//   - The runtime hands over only what classes need (ClassCore): flags, reconcile, refs, context
//     and the commit queue. Fibers stay opaque here; the fields used are listed on `support`.
//   - Lifecycles follow React's order and rules, including the legacy (UNSAFE_) ones, which React
//     skips when a class defines getDerivedStateFromProps or getSnapshotBeforeUpdate.

import { __installClasses, type ClassCore, type ClassSupport, type Props, shallowEqual } from "../core.ts";

// biome-ignore lint: fibers and instances are opaque here.
type Any = any;

// A symbol, so the link cannot collide with a field of the app's class.
const INSTANCE = Symbol("fiber"); // class instance -> its fiber
// An instance's snapshot until its update commits: [prevProps, prevState, snapshot].
const SNAPSHOT = Symbol("snapshot");
/** Whether a thrown value is a promise (a suspension), which error boundaries do not catch. */
const isThenable = (v: Any): boolean => v !== null && typeof v === "object" && typeof v.then === "function";

/**
 * The class component runtime, built on the core the runtime passes in.
 *
 * The fiber fields it uses: `t` the class, `p` the props, `s` the instance, `f` the flags, `q` the
 * queue of setState updates, `rx` the queue of setState callbacks, `x` a value thrown to this
 * boundary, and `o` the root (for its options).
 */
function support(core: ClassCore): ClassSupport {
  const { DIRTY, FORCE, RERENDER, DEAD, NO_CONTEXT } = core;

  // #region Helpers

  /**
   * The state after applying the queued setState updates in order. An update is a partial state
   * or a function of the state so far; null or undefined changes nothing. Each merge makes a new
   * object, so a PureComponent's shallow compare sees the change.
   */
  function nextState(f: Any, inst: Any, state: Any, props: Props): Any {
    const q: Any[] | null = f.q;
    if (q === null) return state;
    f.q = null;
    for (const u of q) {
      const part = typeof u === "function" ? u.call(inst, state, props) : u;
      if (part != null) state = { ...state, ...part };
    }
    return state;
  }

  // Class props leave out `ref`: the ref gets the instance.
  function classProps(p: Props): Props {
    if (!("ref" in p)) return p;
    const out = { ...p };
    delete out["ref"];
    return out;
  }

  /** Whether the class catches errors below it (an error boundary). */
  function boundary(f: Any): boolean {
    return (
      typeof f.t.getDerivedStateFromError === "function" ||
      (f.s !== null && typeof f.s.componentDidCatch === "function")
    );
  }

  /**
   * Render the instance and reconcile its output with the fiber's children. A fallback rendered for
   * an error that counted (`final`) throws an error that counts too: it is not rendered again.
   */
  function render(f: Any, inst: Any, final = false): void {
    const out = core.rendering(f, () => {
      try {
        // Cleared first, so it marks only a setState made during this render (see enqueue).
        f.f &= ~RERENDER;
        return inst.render();
      } catch (e) {
        // A render that threw is not done: the fiber stays dirty, so its next update renders it
        // even when its element is unchanged.
        f.f |= DIRTY;
        if (final) core.thrownIn(f, e);
        else core.renderThrew(f, e);
        throw e;
      }
    });
    core.reconcile(f, out);
  }

  /**
   * Attach the ref to the instance and detach the old ref, when the ref changed. The new one is
   * attached after the commit, as React does, so it sees the finished tree.
   */
  function classRef(f: Any, old: Props | null, inst: Any): void {
    const ref = f.p.ref,
      oref = old === null ? undefined : old["ref"];
    if (ref === oref) return;
    if (oref != null && core.hiddenLevel(f) === 0) core.detachRef(f, oref);
    if (ref != null) {
      core.checkRef(ref);
      core.laterShown(f, () => core.attachRef(f, ref, inst));
    }
  }

  /**
   * React's first pass when its retry renders error `e` again: boundary `f` takes the error's state
   * and renders its fallback, which is thrown away, and is then as it was. With only
   * componentDidCatch it renders nothing, as in React.
   */
  function draft(f: Any, e: Any): void {
    const gdsfe = f.t.getDerivedStateFromError;
    if (typeof gdsfe !== "function") return;
    const inst = f.s,
      kept = f.c,
      state = inst.state;
    f.c = [];
    try {
      const d = gdsfe(e);
      if (d != null) inst.state = { ...state, ...d };
      core.forShow(() => render(f, inst));
    } finally {
      core.discard(f);
      f.c = kept;
      inst.state = state;
    }
  }

  // setState callbacks, with layout effects.
  function callbacks(f: Any): void {
    const cbs: (() => void)[] | null = f.rx;
    if (cbs === null) return;
    f.rx = null;
    for (const cb of cbs) core.later(f, () => cb.call(f.s));
  }

  // #endregion

  // #region Mounting and updating

  /**
   * Mount or update a class component: run its lifecycles in React's order and render it, or,
   * when it is an error boundary that caught an error, render its fallback.
   *
   * @param old The props of the last render, or null on mount.
   */
  function run(f: Any, old: Props | null, mount: boolean): void {
    try {
      const C = f.t;
      const props = classProps(f.p);
      const ctxType = C.contextType;
      const context = ctxType != null ? core.readContext(f, ctxType) : NO_CONTEXT;
      let inst = f.s;
      // An error thrown below on the last pass: this boundary goes straight to its fallback.
      let thrown = f.x;
      f.x = null;
      if (thrown === null) {
        let prevProps: Any = null,
          prevState: Any = null,
          snapshot: Any,
          // What an update changes on the instance besides: put back if its render fails.
          prevContext: Any = null,
          queued: Any = null,
          forced = 0;
        if (mount) {
          // Constructed as during render, with this fiber as the one rendering.
          inst = f.s = core.rendering(f, () => new C(props, context));
          inst.props = props;
          inst.context = context;
          // React's default state is null.
          if (inst.state === undefined) inst.state = null;
          inst[INSTANCE] = f;
          if (typeof C.getDerivedStateFromProps === "function") {
            const d = C.getDerivedStateFromProps(props, inst.state);
            if (d != null) inst.state = { ...inst.state, ...d };
          } else if (typeof inst.getSnapshotBeforeUpdate !== "function") {
            const will = inst.UNSAFE_componentWillMount ?? inst.componentWillMount;
            if (typeof will === "function") {
              // Called as during render, so a setState in it is queued, not scheduled: it applies
              // before the first render, with no second render after it.
              core.rendering(f, () => will.call(inst));
              inst.state = nextState(f, inst, inst.state, props);
            }
          }
        } else {
          prevProps = inst.props;
          prevState = inst.state;
          prevContext = inst.context;
          queued = f.q;
          forced = f.f & FORCE;
          const legacy =
            typeof C.getDerivedStateFromProps !== "function" && typeof inst.getSnapshotBeforeUpdate !== "function";
          // Only new props from the parent, not the component's own setState.
          if (legacy && old !== f.p) {
            const wrp = inst.UNSAFE_componentWillReceiveProps ?? inst.componentWillReceiveProps;
            if (typeof wrp === "function") wrp.call(inst, props, context);
          }
          let state = nextState(f, inst, prevState, props);
          if (typeof C.getDerivedStateFromProps === "function") {
            const d = C.getDerivedStateFromProps(props, state);
            if (d != null) state = { ...state, ...d };
          }
          // forceUpdate and a context change skip shouldComponentUpdate.
          let go = (f.f & FORCE) !== 0 || inst.context !== context;
          if (!go) {
            if (typeof inst.shouldComponentUpdate === "function")
              go = !!inst.shouldComponentUpdate(props, state, context);
            else if (C.prototype.isPureReactComponent)
              go = !shallowEqual(prevProps, props) || !shallowEqual(prevState, state);
            else go = true;
          }
          f.f &= ~FORCE;
          if (!go) {
            // As in React, a skipped update still takes the new props, state and context.
            inst.props = props;
            inst.state = state;
            inst.context = context;
            callbacks(f);
            return;
          }
          if (legacy) {
            const wu = inst.UNSAFE_componentWillUpdate ?? inst.componentWillUpdate;
            if (typeof wu === "function") wu.call(inst, props, state, context);
          }
          inst.props = props;
          inst.state = state;
          inst.context = context;
          // Taken before render, so it reads the DOM before this update changes it. React takes it
          // once, as the update commits: an update rendered again (React's retry of a render that
          // threw, or a transition undone) keeps the one it took first.
          if (typeof inst.getSnapshotBeforeUpdate === "function") {
            const kept = inst[SNAPSHOT];
            if (kept !== undefined && kept[0] === prevProps && kept[1] === prevState) snapshot = kept[2];
            else
              inst[SNAPSHOT] = [prevProps, prevState, (snapshot = inst.getSnapshotBeforeUpdate(prevProps, prevState))];
          }
        }
        try {
          render(f, inst);
          // Did-mount and did-update run after the commit, with layout effects.
          if (mount) {
            if (typeof inst.componentDidMount === "function") core.laterShown(f, () => inst.componentDidMount());
          } else if (typeof inst.componentDidUpdate === "function" || inst[SNAPSHOT] !== undefined) {
            core.laterShown(f, () => {
              inst[SNAPSHOT] = undefined;
              if (typeof inst.componentDidUpdate === "function")
                inst.componentDidUpdate(prevProps, prevState, snapshot);
            });
          }
          classRef(f, old, inst);
          callbacks(f);
          return;
        } catch (e) {
          // A suspension goes up to a Suspense boundary, and anything thrown while hydrating to
          // what recovers from it.
          if (isThenable(e) || core.hydrating()) throw e;
          // React renders a render that failed again (see failed in ../core.ts), from the
          // instance as it was committed: what this update changed on it goes back.
          const undo = (): void => {
            if (mount) return;
            inst.props = prevProps;
            inst.state = prevState;
            inst.context = prevContext;
            f.q = queued;
            f.f |= forced;
          };
          // An error goes up past a class that is not a boundary.
          if (!boundary(f)) {
            undo();
            throw e;
          }
          const errors = core.failed(f, e);
          if (errors === null) thrown = e;
          else {
            // Not counted yet: the fallback renders only for show, as in React's first pass.
            try {
              draft(f, e);
            } finally {
              undo();
            }
            // Then the retry, unless one above renders this again. A mount constructs the class
            // again, as React's retry does.
            if (errors.length) {
              if (mount) core.discard(f);
              f.f &= ~DIRTY;
              const x = core.again(f, errors, () => run(f, old, mount));
              if (x !== null) throw x;
            }
            return;
          }
        }
      }
      // Error boundary: drop the children, take the error's state, render again.
      core.removeAll(f);
      f.f &= ~DIRTY;
      const gdsfe = C.getDerivedStateFromError;
      if (typeof gdsfe === "function") {
        const d = gdsfe(thrown);
        if (d != null) inst.state = { ...inst.state, ...d };
      }
      const caught = thrown,
        componentStack = core.componentStack(caught, f);
      // As React's logCaughtError: the root's onCaughtError first, given the boundary, then
      // componentDidCatch.
      core.later(f, () => {
        const report = f.o.opts.onCaughtError;
        if (report) core.report(report, caught, { componentStack, errorBoundary: inst });
        else console.error(caught);
        if (typeof inst.componentDidCatch === "function") inst.componentDidCatch(caught, { componentStack });
      });
      // With only componentDidCatch, the boundary renders nothing until that method sets state.
      if (typeof gdsfe === "function") render(f, inst, true);
      classRef(f, old, inst);
    } catch (e) {
      // A lifecycle or render of this class threw: its component stack starts here.
      core.thrownIn(f, e);
      throw e;
    }
  }

  // #endregion

  // #region What the runtime calls

  return {
    run,
    boundary,
    /** setState and forceUpdate: queue the update and schedule a render of the fiber. */
    enqueue(inst, partial, cb, force) {
      const f = inst[INSTANCE];
      // Before mount (a setState in the constructor) or after unmount, an update does nothing.
      if (f === undefined || f.f & DEAD) return;
      // In a transition (with ./concurrent.ts), it waits for the transition to render.
      if (!core.waits(f, () => enqueue(f, partial, cb, force))) enqueue(f, partial, cb, force);
    },
    /** componentWillUnmount (the core detached the ref before). */
    unmount(f) {
      const inst = f.s;
      if (inst !== null && typeof inst.componentWillUnmount === "function") inst.componentWillUnmount();
    },
    draft,
  };

  /** Queue an update of class fiber `f` and schedule its render. */
  function enqueue(f: Any, partial: Any, cb: (() => void) | undefined, force: boolean): void {
    if (partial !== null) (f.q ??= []).push(partial);
    if (force) f.f |= FORCE;
    if (typeof cb === "function") (f.rx ??= []).push(cb);
    // A setState during the component's own render is marked, not scheduled: the update waits
    // in the queue for the next render.
    if (core.isRendering(f)) f.f |= RERENDER;
    else core.schedule(f);
  }

  // #endregion
}

__installClasses(support);
