// What @reactre/core/features/hydrate exports for the values a server render sends the client
// (`takeHydrationValue`, `getHydrationWriter`), and `clientOnly`.
//
// What a server render wrote with its hydration writer (@reactre/core/server's
// `getHydrationWriter`) is in the page's `self.$rrd`, a registry of no prototype that the render's
// scripts fill, as JSON with what JSON has not tagged (`{"$rr": tag}`); see @reactre/core/server's
// "Hydration values". `takeHydrationValue` takes a value out and gives it back as it was written.
//
// Design decisions:
//   - A file of its own, as ./observed.ts is for features/memo: features/hydrate re-exports it, and
//     an app that uses none of it leaves it out of its bundle whole. Bun's minifier names a
//     bundle's symbols by how often its modules use them, dead code included, so the same code in
//     features/hydrate.ts would move the names of every hydrating app's bundle.

import { type PropsOf, signal, untrack } from "@reactre/core";
import type { Child } from "@reactre/core/jsx-runtime";
import type { HydrationWriter } from "@reactre/core/server";

import { __frag, isHydrating } from "./features/hydrate.ts";

export type { HydrationWriter };

// #region Hydration values

/** A value taken from the page's hydration values: as it was written, or the Promise it was until it settles. */
export type HydrationValue<T = unknown> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "pending"; readonly promise: Promise<T> };

/** The page's registry of hydration values, and what the scripts that fill it tell of what they put in. */
const page = globalThis as { $rrd?: Record<string, unknown>; $rrw?: (values: object) => void };

/** The tag of a written value that JSON has not (`{"$rr": tag}`), or undefined. */
function tag(x: unknown): unknown {
  return typeof x === "object" && x !== null && Object.hasOwn(x, "$rr") ? (x as { $rr: unknown }).$rr : undefined;
}

/** A plain object written as `x`: its keys but `__proto__`, which would set its prototype, with their values. */
function plain(x: object): object {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x)) if (k !== "__proto__") out[k] = decode((x as Record<string, unknown>)[k]);
  return out;
}

/** The value written as `x`. */
function decode(x: unknown): unknown {
  if (typeof x !== "object" || x === null) return x;
  if (Array.isArray(x)) return x.map(decode);
  const v = (x as { v?: unknown }).v;
  switch (tag(x)) {
    case "u":
      return undefined;
    case "n":
      return Number(v);
    case "b":
      return BigInt(v as string);
    case "d":
      return new Date(decode(v) as number);
    case "m":
      return new Map((v as [unknown, unknown][]).map(([k, y]) => [decode(k), decode(y)]));
    case "s":
      return new Set((v as unknown[]).map(decode));
    case "o":
      return plain(v as object);
  }
  return plain(x);
}

/** What a rejected Promise's error is on the client when a production server kept it out of the page. */
const KEPT =
  "reactre: the server's hydration value rejected, and its production build keeps the error out of the page; its development build shows it";

/** The error a written Promise rejected with: its name and message from a development server. */
function failure(x: unknown): Error {
  const v = (x as { v?: [string, string] }).v;
  const e = new Error(v === undefined ? KEPT : v[1]);
  if (v !== undefined) e.name = v[0];
  return e;
}

/** The Promises given for values still to come, by key. */
const waiting = new Map<string, [(v: unknown) => void, (e: unknown) => void]>();

/** Take what was written for key `k` out of the registry `d`. */
function take(d: Record<string, unknown>, k: string): unknown {
  const x = d[k];
  delete d[k];
  return x;
}

/** The scripts put `values` in the registry: settle the Promises given for them. */
function settled(values: object): void {
  for (const k of Object.keys(values)) {
    const w = waiting.get(k);
    if (w === undefined) continue;
    waiting.delete(k);
    const x = take(page.$rrd!, k);
    if (tag(x) === "r") w[1](failure(x));
    else w[0](decode(x));
  }
}

/**
 * Take the value the server render wrote under `key` with its hydration writer
 * (@reactre/core/server's `getHydrationWriter().write(key, value)`) out of the page, as it was
 * written; undefined when the page has none, or it was taken already. A Promise the server wrote
 * is `"pending"` until the stream sends what it settled to, then `"resolved"` or `"rejected"`. It
 * reads the page, so it works before `hydrate` runs and after it, and in an app that renders
 * afresh; on the server (@reactre/core/server/hydrate) it is undefined.
 *
 * @example
 *   import { takeHydrationValue } from "@reactre/core/features/hydrate";
 *
 *   const got = takeHydrationValue<User>("sq:user");
 *   const user = got?.status === "resolved" ? got.value : await fetchUser();
 */
export function takeHydrationValue<T = unknown>(key: string): HydrationValue<T> | undefined {
  const d = page.$rrd;
  if (d == null || !Object.hasOwn(d, key)) return undefined;
  const x = take(d, key);
  const t = tag(x);
  if (t === "r") return { status: "rejected", error: failure(x) };
  if (t !== "p") return { status: "resolved", value: decode(x) as T };
  page.$rrw = settled;
  return { status: "pending", promise: new Promise((ok, no) => waiting.set(key, [ok as (v: unknown) => void, no])) };
}

/** Undefined in the browser: only a server render writes hydration values (@reactre/core/server's). */
export function getHydrationWriter(): HydrationWriter | undefined {
  return undefined;
}

// #endregion

// #region clientOnly

/** What `clientOnly` gives: a component of `P`'s props and a `fallback`. */
type ClientOnly<P> = (props: P & { readonly fallback?: Child }) => unknown;

/**
 * A component that renders only in the browser: `load()`'s default export (or, with `export`,
 * the export of that name), once it has loaded; until then, and while the page hydrates,
 * `props.fallback`. The server writes the fallback and never loads the module, so the component's
 * code never runs there (one that reads `window`, measures the page, or needs a browser-only
 * library). Hydrating, the fallback claims what the server wrote, and the component takes its
 * place once the page has hydrated; rendering afresh, it does once it has loaded. The module
 * starts to load when `clientOnly` is called, or with `lazy`, when the component first renders.
 * The component gets the props but `fallback`.
 *
 * @example
 *   import { clientOnly } from "@reactre/core/features/hydrate";
 *
 *   const Chart = clientOnly(() => import("./Chart.tsx"));
 *   <Chart data={data()} fallback={<p>Loading the chart...</p>} />
 */
export function clientOnly<P>(
  load: () => PromiseLike<{ default: (props: P) => unknown }>,
  options?: { readonly lazy?: boolean },
): ClientOnly<P>;
export function clientOnly<M, K extends keyof M & string>(
  load: () => PromiseLike<M>,
  options: { readonly lazy?: boolean; readonly export: K },
): ClientOnly<PropsOf<M[K]>>;
export function clientOnly(
  load: () => PromiseLike<unknown>,
  options: { readonly lazy?: boolean; readonly export?: string } = {},
): ClientOnly<Record<string, unknown>> {
  const [comp, setComp] = signal<((props: object) => unknown) | undefined>(undefined);
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    void Promise.resolve(load()).then((m) =>
      setComp(() => (m as Record<string, (props: object) => unknown>)[options.export ?? "default"]),
    );
  };
  if (options.lazy !== true) start();
  return (props) => {
    start();
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(props))
      if (k !== "fallback") Object.defineProperty(rest, k, { get: () => props[k], enumerable: true });
    // Hydrating, the fallback claims the server's, and the component waits for the page to hydrate.
    const hydrating = isHydrating();
    const [mounted, mount] = signal(!hydrating);
    if (hydrating) queueMicrotask(() => mount(true));
    return __frag([
      () => {
        const c = comp();
        return c !== undefined && mounted() ? untrack(() => c(rest)) : props.fallback;
      },
    ]);
  };
}

// #endregion
