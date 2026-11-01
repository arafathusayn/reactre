// The harness of the Solid 2.0 test ports in this folder: what a port's TSX source is compiled and
// run with, and `gap`, which marks a port that fails because reactre lacks a capability or behaves
// differently. plans/solid-parity.md counts the ports and their gaps.
//
// The ports are of Solid's own tests, from solid-js 2.0.0-rc.20 (github.com/solidjs/solid at
// 5e68925cc2fd216a9fb06345019e66d5da5c523c). Solid is MIT licensed:
//
//   MIT License. Copyright (c) 2016-2025 Ryan Carniato.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//   and associated documentation files (the "Software"), to deal in the Software without
//   restriction, including without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions: The above copyright
//   notice and this permission notice shall be included in all copies or substantial portions of
//   the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// How a port is translated:
//   - Solid's names become reactre's: createSignal is `signal`, createMemo `memo`, createEffect
//     `reaction` (its two halves) or `effect`, createRenderEffect `bind`, createTrackedEffect
//     `autorun`, mapArray `map`, and so on, from the module that has them (plans/solid-parity.md
//     has the map; ports written before features/effects keep `reaction` for a render effect that
//     only logs). What a test asserts stays.
//   - Solid holds a write until `flush()`: its reads and effects see it then. reactre applies a
//     write at once, by design (README, "Timing"); its `flush` (features/timing) is kept where
//     Solid calls it, and outside a batch it does nothing. A port keeps the assertions of what a
//     flush shows; an assertion that a read or an effect has not seen a write before the flush is
//     ported once per file, into a `gap("held-writes", ...)` test, so that the difference counts
//     once there instead of failing every port that steps through it.
//   - vitest's `vi.fn()` is bun:test's `mock()`.

import { test } from "bun:test";

import { compileSource } from "@reactre/compiler";

import * as dynamic from "../../src/features/dynamic.ts";
import * as forAny from "../../src/features/for.ts";
import * as index from "../../src/features/index.ts";
import * as memo from "../../src/features/memo.ts";
import * as owner from "../../src/features/owner.ts";
import * as reaction from "../../src/features/reaction.ts";
import * as selectors from "../../src/features/selectors.ts";
import * as store from "../../src/features/store.ts";
import * as timing from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";

/** The Solid release the ports are of. */
export const SOLID = "solid-js 2.0.0-rc.20, solidjs/solid@5e68925cc2fd216a9fb06345019e66d5da5c523c";

/**
 * Why a port fails, by the target that would make it pass. plans/solid-parity.md lists each
 * target with the ports it blocks.
 */
export const GAPS = {
  "held-writes": "Solid holds a write until flush(), for reads and effects; reactre applies it at once",
  "render-effects": "createEffect's user phase, after the render effects, and its defer option",
  from: "from(), a signal of an external source",
  "memo-options":
    "memo options loadingValue, deferStream, transparent, ssrSource (features/async's memo has them; reaction has none)",
  "client-only": "clientOnly(), a component rendered only in the browser",
  "ssr-helpers": "httpStatus, httpHeader, takeHydrationValue, getHydrationWriter",
  hydration: "hydrate(), claiming server-rendered HTML",
  "for-placement": "<For> and <Repeat> stand only as an element's direct child",
  "jsx-props": "JSX in a prop other than children",
  "store-alias": "a store read through an alias, a box, a function or props.list",
  "unobserved-timing": "Solid calls unobserved as the last reader leaves; reactre in a microtask after",
  "list-functions": "mapArray and repeat, the runtime list functions under <For> and <Repeat>",
  bug: "a reactre bug, with its repro in plans/solid-parity.md under Bugs found",
  "glitch-free": "memos updated once each, in topological order, never seeing half an update",
  "pull-memos": "a memo nothing observes recomputes when read, not when its sources change",
  "row-shape": "a <For> or <Repeat> row is (item) => <one element />: no text, fragment, array or element-child row",
  "for-index": "a keyed <For> row gets its item only, not an index accessor",
  "match-placement": "<Switch> takes only <Match> children, not a <For> or <Show> of them",
  "stale-accessor": "a <Show>/<Match> child's accessor keeps reading after its branch is gone",
  "portal-events": "an event in a <Portal> bubbles through the DOM, not the component tree",
  "dispose-order": "teardown unwinds: children newest first, then an owner's cleanups last-registered first",
  "effect-equals": "an effect's apply half runs each time its compute re-runs, not only on a new value",
  "misuse-errors": "errors for misuse: an invalid cleanup value, flush() or onCleanup where Solid forbids them",
  "owner-ids": "owner ids: createRoot's id option and getNextChildId, under createUniqueId",
  "create-reaction": "createReaction(fn), a one-shot tracker that track(source) arms",
  "cleanup-throw": "a throwing cleanup does not stop the teardown; the first error is rethrown after",
  "settled-async": "onSettled waits for async reads under way before it runs",
  "effect-errors": "an effect's unhandled compute error is logged and the app keeps going",
  "no-owner": "NoOwnerError, for a context read or provided outside any owner",
  "dev-checks": "a development warning or message of Solid's that reactre's dev build lacks",
  "client-error-hook": "configureClientErrors and render's onError hearing what a boundary caught",
  "error-accessor": "<Errored>'s fallback gets an accessor of the latest error, not the first error",
  "fallback-tracking": "<Errored>'s fallback function is tracked: it re-runs when what it read changes",
  "effect-bundle": "createEffect's { effect, error } bundle: an error arm for the compute half",
  "children-helper": "children(), resolving props.children to nodes",
  "pending-signal": "isPending of a plain signal whose readers a transition holds is false",
  "switch-reads": "<Switch> is one computation: a change re-reads each condition up to the first truthy one",
  "memo-errors": "a memo's error reaches the boundary of the reader, not only of where it was made",
  "store-direct-write": "a direct write to a store throws; Solid ignores it",
  "class-instances": "a store wraps plain objects and arrays only; Solid wraps class instances",
  "store-in-place": "a store writes into the object it was given; Solid keeps writes beside it",
  "symbol-keys": "reconcile, a returned replacement, merge, omit and deep skip symbol keys",
  "draft-define": "Object.defineProperty on a store's draft notifies nothing",
  "merge-views": "merge/omit views: function sources, one-source identity, predicates",
  "projection-chain": "a projection whose fn returns a store follows it; a projection with no seed",
  "reconcile-identity": "reconcile throws when the root's key differs from the store's",
  "ssr-semantics": "server primitives: memos computed when read, optimistic writes, no throw on async outside Loading",
  "class-values": "a class object or array works written in place only, not as a runtime value",
  "async-signal": "createSignal(async fn), a writable signal of an async value",
  "array-text": "an array in a call hole is written as its string (a,b), not as its items",
  "store-spread": "a store spread into a component's props is read once: the props do not follow it",
  "dynamic-svg": "<Dynamic> with a tag name chosen at runtime makes an HTML element, even for svg tags",
  "async-store": "createStore(fn) and createProjection(fn) with an async fn, read under <Loading>",
  "transition-scope":
    "a transition holds a whole update: a rebuilt branch and a write whose readers wait on its flight",
  "root-hold": "a read not ready outside any <Loading> holds the whole render, not one empty hole",
  "lazy-retry": "lazy() retries an import that failed, on reset() or preload()",
  "refresh-promise": "refresh()'s Promise: the new value, no unhandled rejection, a no-op for a signal",
  "action-writes": "an action holds and batches its plain writes: reads and effects see them when it ends",
  "action-sync-yield": "an action's sync yield (not a Promise) resumes at once, not in a microtask",
  "optimistic-outside": "an optimistic write outside an action never shows; reactre sets the base",
  // New targets go above this line.
} as const;

/** A gap's key. */
export type Gap = keyof typeof GAPS;

/**
 * A port that fails until reactre has `kind`: `test.failing`, so it runs and must fail (and is
 * reported once it passes). The test's name carries the target and `why`, one line.
 *
 * With SOLID_STRICT=1 in the environment, each runs as a plain test, to see why it fails.
 */
export function gap(kind: Gap, why: string, name: string, fn: () => unknown): void {
  const label = `${name} [${kind}: ${why}]`;
  if (process.env["SOLID_STRICT"] === "1") test(label, fn as () => void);
  else test.failing(label, fn as () => void);
}

/**
 * The modules a source may import that install nothing as they load (selectors installs itself
 * for good, as other test files do). A file that uses context, errors, async, actions or the
 * server adds them: async and actions turn the async runtime on, so a file that loads them turns
 * it on before its tests and off after (`core.__installAsync(__hooks)`, then `false`), as
 * ../async.test.ts does.
 */
export const base: Record<string, unknown> = {
  "@reactre/core": core,
  "@reactre/core/features/dynamic": dynamic,
  "@reactre/core/features/for": forAny,
  "@reactre/core/features/index": index,
  "@reactre/core/features/memo": memo,
  "@reactre/core/features/owner": owner,
  "@reactre/core/features/reaction": reaction,
  "@reactre/core/features/selectors": selectors,
  "@reactre/core/features/store": store,
  "@reactre/core/features/timing": timing,
};

/**
 * features/memo's `memo(fn, { lazy })` and `signal(v, { unobserved })` as compiled code calls them.
 * @reactre/compiler sends a call that passes either option to the module's reader-counting entries,
 * `__observedMemo` and `__observedSignal`; the ports are TypeScript the compiler does not see, so
 * they call the entries, as a .tsx file's calls become. (`memo` and `signal` themselves throw for
 * the options in the development build, which `bun test` runs.)
 */
export const folded = { memo: memo.__observedMemo, signal: memo.__observedSignal } as {
  memo: typeof memo.memo;
  signal: <T>(value: T, options?: memo.SignalOptions<T>) => [() => T, core.Setter<T>];
};

/**
 * Compile a TSX module body ending in `return { ... }` as the plugin compiles it (for the server
 * with `server` true, for hydration with "hydrate"), and run it. Its imports of @reactre/core and
 * its feature modules, and the ones the compiler adds, bind to `modules` by specifier; `scope`'s
 * names are in scope.
 */
export function compile<T>(
  src: string,
  modules: Record<string, unknown>,
  scope: Record<string, unknown> = {},
  server: boolean | "hydrate" = false,
): T {
  const mod = (from: string): string => {
    if (!(from in modules)) throw new Error(`harness: no module for ${from}`);
    return `rr[${JSON.stringify(from)}]`;
  };
  const js = compileSource(
    src,
    "tsx",
    server === true ? { server: true } : server === "hydrate" ? { hydrate: true } : undefined,
  )
    .replace(/^(\s*)export /gm, "$1")
    .replace(/^import "([^"]*)";$/gm, (_, from: string) => (mod(from), ""))
    .replace(
      /^import \* as (\w+) from "([^"]*)";$/gm,
      (_, name: string, from: string) => `const ${name} = ${mod(from)};`,
    )
    .replace(/^import \{([^}]*)\} from "([^"]*)";$/gm, (_, names: string, from: string) =>
      names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [a, b] = n.split(" as ");
          return `const ${b ?? a} = ${mod(from)}.${a};`;
        })
        .join("\n"),
    );
  const names = Object.keys(scope);
  return new Function("rr", ...names, js)(modules, ...names.map((k) => scope[k])) as T;
}

/** A Promise with its resolve and reject. */
export function deferred<T>(): { p: Promise<T>; ok: (v: T) => void; no: (e: unknown) => void } {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
}

/** Let timers and promise callbacks run. */
export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
