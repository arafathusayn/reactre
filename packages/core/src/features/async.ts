// @reactre/core/features/async: Solid 2.0's async data. A memo may return a Promise or an
// AsyncIterable; `<Loading>` shows a fallback while what its children read is not ready yet;
// `isPending`, `latest`, `resolve` and `refresh` read and drive what is in flight; `<Reveal>`
// orders sibling boundaries; `lazy` loads a component.
//
// How it works (the core's "Async" section has the rest):
//   - Loading this module turns on the core's async runtime (`__installAsync`), which this module
//     gives its boundaries: a run that read a value that was not ready asks `hooks.wait` for the
//     nearest `<Loading>` above it, found in the scope it was made in, as a context is found
//     (@reactre/core/features/context, whose scopes this module shares), and the boundary counts
//     it until it runs through or goes.
//   - `<Loading>` builds its children at once, off the page, and puts them in the page when
//     nothing under it waits. Until then, and when `on` changes while an update is pending, it
//     shows its fallback.
//   - An update that makes an async memo with a value pending is a transition: the effects it
//     would run are held, the page keeps showing the old values, and they run when the memo has
//     its new value. `isPending` is true meanwhile; `latest` shows the newest value at once.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free. It needs the core's async runtime, which only @reactre/core's async build
//     (dist/async) and its sources have: @reactre/plugin picks that build for a program that
//     imports this module or features/actions. With the default build, loading it throws, naming
//     the fix.
//   - It reaches the core's async internals through the namespace, so that against the default
//     build it can say so instead of failing to link.

import * as core from "@reactre/core";
import { __frag, __Owned, __Root, effect, onCleanup, signal, untrack } from "@reactre/core";
import { __children, __root, __scope, type Scope } from "@reactre/core/features/context";
import type { Child } from "@reactre/core/jsx-runtime";

/** What loading this module with the core's default build throws. */
const NEEDS =
  "reactre: @reactre/core/features/async needs @reactre/core's async runtime, and this @reactre/core is its " +
  "default build. Build with @reactre/plugin, which picks the async build for a program that imports this " +
  'module, or resolve @reactre/core with the "reactre-async" export condition.';
if (typeof core.__installAsync !== "function") throw new Error(NEEDS);

/** What reading an async value before it resolved throws, where nothing waits for it. */
export const NotReadyError: typeof core.__NotReadyError = core.__NotReadyError;

/** The key a boundary is kept by in a scope, and the key of a `<Reveal>`. */
const LOADING: unique symbol = Symbol(),
  REVEAL: unique symbol = Symbol();

/** A `<Loading>`: the runs under it that wait, and whether it shows its children. */
class Boundary {
  /** The runs under it that wait. */
  n = 0;
  /** Its children are built: until they are, it is not ready. */
  built = false;
  /** It has shown its children: it shows them from then on, unless `on` changes. */
  ever = false;
  /** `on` changed while an update was pending: the fallback shows until it settles. */
  hold = false;
  readonly v: [() => number, (f: (n: number) => number) => void] = signal(0);
  bump(): void {
    this.v[1]((n) => n + 1);
  }
  /** Whether nothing under it waits; reading it follows that. */
  ready(): boolean {
    this.v[0]();
    return this.built && this.n === 0;
  }
}

/** What has a scope: an effect, a list. */
type Scoped = { c?: Scope };

/** Internal: the boundaries the core's async runtime asks for (see the core's "Async"). */
export const __hooks: core.AsyncHooks = {
  wait(o, list) {
    // A row's runs find their boundary through their list's scope, taken when one first waits:
    // as the rows are made, in the list's effect.
    const s = list !== null ? ((list as Scoped).c ??= __scope()) : ((o as Scoped).c ?? __scope());
    const b = s[LOADING] as Boundary | undefined;
    if (b === undefined) return true;
    b.n++;
    return b;
  },
  done(t) {
    if (t !== true && --(t as Boundary).n === 0) (t as Boundary).bump();
  },
};

core.__installAsync(__hooks);

/**
 * `memo` from @reactre/core, typed for an async function: `memo(async () => ...)` reads as the
 * value it resolves to. A read before it has one is not ready (see `<Loading>`).
 *
 * @example
 *   import { memo } from "@reactre/core/features/async";
 *
 *   const user = memo(async () => (await fetch(`/users/${id()}`)).json());
 */
export const memo: <R>(fn: () => R) => () => Settled<R> = core.memo as never;

/** What a memo of a function that returns `R` reads as: what a Promise resolves to, what an AsyncIterable gives. */
export type Settled<R> = R extends PromiseLike<infer V> ? V : R extends AsyncIterable<infer V> ? V : R;

/** `<Reveal>`'s state: its boundaries, in the order they were made. */
class Order {
  readonly list: Boundary[] = [];
  readonly order: RevealOrder;
  constructor(order: RevealOrder) {
    this.order = order;
  }
  /** Whether boundary `b`, ready or not, may show its children; reading it follows that. */
  may(b: Boundary): boolean {
    if (this.order === "together") {
      let all = true;
      for (const x of this.list) if (!x.ever && !x.ready()) all = false;
      return all;
    }
    if (this.order === "sequential")
      for (const x of this.list) {
        if (x === b) break;
        x.v[0]();
        if (!x.ever) return false;
      }
    return b.ready();
  }
}

/** How `<Reveal>` shows its boundaries. */
export type RevealOrder = "sequential" | "together" | "natural";

/**
 * `<Loading fallback on>`: its children, once nothing they read waits for an async value; until
 * then, `fallback`. Solid 2.0's `<Loading>`, which replaces `<Suspense>`.
 *
 * The children are built at once, off the page, and go in when every effect and row under it
 * that read a value that was not ready has run again with it. From then on it keeps showing them:
 * an update that makes what they read pending keeps the old values on the page until it settles
 * (see `isPending`). With `on`, a change of its value while an update is pending shows the
 * fallback again until the update settles.
 *
 * Its children are read inside it, so it must get them unbuilt: a getter (`get children()`, as
 * the compiler passes JSX children), or a function, which renders as a slot.
 *
 * @example
 *   import { Loading, memo } from "@reactre/core/features/async";
 *
 *   const user = memo(async () => (await fetch(`/users/${id()}`)).json());
 *   const App = () => (
 *     <Loading fallback={<p>Loading...</p>}>
 *       <h1>{user().name}</h1>
 *     </Loading>
 *   );
 */
export function Loading(props: { fallback?: Child; on?: unknown; children?: Child | (() => Child) }): unknown {
  const b = new Boundary(),
    own = core.__owner,
    up = __scope(),
    reveal = up[REVEAL] as Order | undefined,
    s: Scope = Object.create(up);
  s[LOADING] = b;
  // A boundary inside this one is this one's to show, not the <Reveal>'s.
  s[REVEAL] = undefined;
  // The children, between `start` and their slot's anchor (`last`), kept in `hold` while hidden.
  const hold = document.createDocumentFragment(),
    start = hold.appendChild(document.createTextNode(""));
  for (const n of __Owned.within(__root(s), () => __children(props))) hold.appendChild(n);
  const last = hold.lastChild!;
  b.built = true;
  if (reveal !== undefined) {
    reveal.list.push(b);
    onCleanup(() => void reveal.list.splice(reveal.list.indexOf(b), 1));
  }
  // What this returns: the children or the fallback, before `mark`.
  const out = document.createDocumentFragment(),
    mark = out.appendChild(document.createTextNode(""));
  /** Move the children before `to` in its parent, or, with null, into `hold`. */
  const move = (to: Node | null): void => {
    const parent = to === null ? hold : to.parentNode!;
    for (let n: Node | null = start; n !== null;) {
      const next: Node | null = n === last ? null : n.nextSibling;
      parent.insertBefore(n, to);
      n = next;
    }
  };
  let shown: boolean | null = null,
    fb: InstanceType<typeof __Root> | null = null,
    fbNodes: Node[] = [];
  const unfall = (): void => {
    if (fb === null) return;
    fb.dispose();
    for (const n of fbNodes) n.parentNode?.removeChild(n);
    fb = null;
  };
  effect(() => {
    core.__live();
    b.v[0]();
    const want = !b.hold && (b.ever || (reveal !== undefined ? reveal.may(b) : b.ready()));
    if (want === shown) return;
    shown = want;
    untrack(() => {
      if (want) {
        unfall();
        move(mark);
        if (!b.ever) {
          b.ever = true;
          // A <Reveal> showing them in order shows the next.
          if (reveal !== undefined) b.bump();
        }
      } else {
        move(null);
        // The fallback is outside the boundary: what it throws or waits for goes above. It
        // belongs to the boundary's owner, not to this effect, which runs again without it.
        fb = __Owned.within(own, () => __root(up));
        fbNodes = __Owned.within(fb, () => __frag([() => props.fallback]));
        for (const n of fbNodes) mark.parentNode!.insertBefore(n, mark);
      }
    });
  });
  if ("on" in props) {
    let first = true,
      prev: unknown;
    effect(() => {
      core.__live();
      const v = props.on,
        t = core.__open();
      if (!first && v !== prev && t !== null && b.ever) {
        b.hold = true;
        b.bump();
        t.done.push(() => {
          b.hold = false;
          b.bump();
        });
      }
      first = false;
      prev = v;
    });
  }
  // Disposed with its owner, it takes out what it put in the page.
  onCleanup(() => {
    unfall();
    if (shown) move(null);
    mark.parentNode?.removeChild(mark);
  });
  return Array.from(out.childNodes);
}

/**
 * `<Reveal order>`: the `<Loading>` boundaries among its children, shown in an order. Solid
 * 2.0's `<Reveal>`, which replaces `<SuspenseList>`.
 *
 * - `"natural"` (the default): each as soon as it is ready.
 * - `"sequential"`: each once it is ready and every one before it (in the order they were made)
 *   has shown its children.
 * - `"together"`: all at once, when every one is ready.
 *
 * A boundary nested inside one of them is that one's own. Once shown, a boundary keeps showing
 * its children.
 *
 * @example
 *   <Reveal order="sequential">
 *     <Loading fallback={<p>...</p>}><Profile /></Loading>
 *     <Loading fallback={<p>...</p>}><Posts /></Loading>
 *   </Reveal>
 */
export function Reveal(props: { order?: RevealOrder; children?: Child | (() => Child) }): unknown {
  const s: Scope = Object.create(__scope());
  s[REVEAL] = new Order(props.order ?? "natural");
  return __Owned.within(__root(s), () => __children(props));
}

/**
 * Whether a change to what `fn` reads is in flight: an async memo it reads (or a memo that reads
 * one) is computing a new value for an update, and the update's transition has not ended, or an
 * action marked what it reads with `affects`. False while a value has never resolved (that is
 * `<Loading>`'s), and for `refresh`, which is quiet. Read in an effect or a hole, it follows the
 * change, and the effect is not held by the transition.
 *
 * @example
 *   <button class={isPending(() => user()) ? "dim" : ""}>Next</button>
 */
export function isPending(fn: () => unknown): boolean {
  let p = false;
  try {
    p = core.__probe(fn)[1];
  } catch (e) {
    if (!(e instanceof NotReadyError)) throw e;
  }
  core.__live();
  return p;
}

/**
 * `fn()`, read at once: an effect or a hole that reads through `latest` is not held by a
 * transition, so it shows the newest value while the rest of the page keeps the old one until
 * the update settles. (Writes apply at once in reactre, so `fn()` outside an effect is already
 * the newest value.)
 *
 * @example
 *   <p>Showing {latest(() => page())} of {pages()}</p>
 */
export function latest<T>(fn: () => T): T {
  try {
    return fn();
  } finally {
    core.__live();
  }
}

/**
 * A Promise of `fn()`'s value, the first time it reads no value that is not ready or pending.
 * It rejects with what `fn` throws.
 *
 * @example
 *   const name = await resolve(() => user().name);
 */
export function resolve<T>(fn: () => T): Promise<T> {
  return new Promise<T>((ok, no) => {
    const r = new __Root();
    __Owned.within(r, () =>
      effect(() => {
        core.__live();
        let got: [T, boolean];
        try {
          got = core.__probe(fn);
        } catch (e) {
          if (e instanceof NotReadyError) throw e;
          r.dispose();
          return no(e);
        }
        if (got[1]) return;
        r.dispose();
        ok(got[0]);
      }),
    );
  });
}

/**
 * Compute `target` again, a memo or an optimistic store (@reactre/core/features/actions), and
 * return a Promise of when its new value has come. Quiet: the old value stays until then, and
 * `isPending` does not turn true (`affects` makes it). Inside an action, the action's transition
 * waits for it.
 *
 * @throws TypeError for anything else.
 *
 * @example
 *   const save = action(function* (todo) {
 *     yield api.save(todo);
 *     yield refresh(todos);
 *   });
 */
export function refresh(target: unknown): Promise<void> {
  const r = core.__refreshers.get(target as object);
  if (r === undefined) throw new TypeError("reactre: refresh takes a memo, or a store from createOptimisticStore");
  return r();
}

/**
 * A component that loads `load()`'s default export the first time it renders, and renders it.
 * Until it has loaded, it is not ready: put it under a `<Loading>`. `preload()` starts loading.
 *
 * @example
 *   const Settings = lazy(() => import("./Settings.tsx"));
 *   <Loading fallback={<p>...</p>}><Settings user={user} /></Loading>
 */
export function lazy<P>(
  load: () => PromiseLike<{ default: (props: P) => unknown }>,
): ((props: P) => unknown) & { preload(): Promise<(props: P) => unknown> } {
  let m: (() => (props: P) => unknown) | undefined, p: Promise<(props: P) => unknown> | undefined;
  const preload = (): Promise<(props: P) => unknown> => (p ??= Promise.resolve(load()).then((x) => x.default));
  const component = (props: P): unknown =>
    __frag([
      () => {
        // A memo of no owner: the component, once loaded, stays loaded.
        const c = (m ??= __Owned.within(null, () => memo(preload)))();
        return untrack(() => c(props));
      },
    ]);
  return Object.assign(component, { preload });
}
