// Control flow and dynamic elements: <Show>, <Switch> and <Match>, <Repeat>, <Portal> and
// <Dynamic>. `dynamic()`, a component chosen at runtime, is a runtime function, so it is the
// feature module @reactre/core/features/dynamic; its types are here, beside <Dynamic>'s.
//
// The elements are compiled away, as <For> is: @reactre/compiler turns each into the code it
// stands for, made of the calls compiled code already makes (`__slot`, `__insert`, `__for`,
// `memo`, `onCleanup`, ...). What is here is their types, and a body that throws when one is
// called, which happens only when a file reached the bundle without the compiler (or used an
// element it imported from somewhere other than "@reactre/core", where the compiler does not
// look). An app that uses none of them ships none of this file.
//
//   - <Show when fallback keyed>: its children while `when` is truthy, else `fallback`.
//   - <Switch fallback> of <Match when keyed>: the first truthy match's children.
//   - <Repeat count from fallback>: a row per index, from `from` to `from + count - 1`.
//   - <Portal mount>: its children in another element (`document.body` by default).
//   - <Dynamic component>: a component, or a tag name's element, chosen by a value.
//
// One thing here does run: `__class`, the helper the compiler calls for a class list it cannot
// resolve while compiling. It is in a bundle only when compiled code calls it.

import type { Child, JSX } from "./jsx-runtime.ts";

// #region Types

/** A value as a condition sees it, with the falsy values taken out: what a truthy `when` holds. */
export type Truthy<T> = Exclude<T, null | undefined | false | 0 | 0n | "">;

/** A tag name or a component: what `<Dynamic component>` and `dynamic()` take. */
export type DynamicComponent = keyof JSX.IntrinsicElements | ((props: never) => unknown);

/** The props of a tag name's element, or of a component. */
export type PropsOf<C> = C extends keyof JSX.IntrinsicElements
  ? JSX.IntrinsicElements[C]
  : C extends (props: infer P) => unknown
    ? P
    : never;

// #endregion

// #region The compiled elements

/** The error an element compiled away throws when it is called. */
function uncompiled(name: string): never {
  throw new Error(
    `reactre: <${name}> must be compiled by @reactre/compiler (import it from "@reactre/core" in the file that uses it)`,
  );
}

/**
 * `<Show when fallback keyed>`: the children while `when` is truthy, else `fallback`; compiled
 * away, so only its type is used. Calling it at runtime throws.
 *
 * The children are built when `when` turns truthy, and taken down when it turns falsy: a new
 * truthy value does not rebuild them. A function child gets an accessor of the value, so what it
 * reads of it follows the value. With `keyed`, the children are rebuilt for every new value, and
 * a function child gets the value itself.
 *
 * @example
 *   <div>
 *     <Show when={user()} fallback={<p>Signed out</p>}>
 *       {(u) => <p>Hello, {u().name}</p>}
 *     </Show>
 *   </div>
 */
export function Show<T>(props: {
  when: T;
  keyed: true;
  fallback?: Child;
  children: Child | ((value: Truthy<T>) => Child);
}): unknown;
export function Show<T>(props: {
  when: T;
  keyed?: false;
  fallback?: Child;
  children: Child | ((value: () => Truthy<T>) => Child);
}): unknown;
export function Show(_props: unknown): unknown {
  return uncompiled("Show");
}

/**
 * `<Switch fallback>`: the children of its first `<Match>` whose `when` is truthy, else
 * `fallback`; compiled away, so only its type is used. Calling it at runtime throws.
 *
 * The children are rebuilt only when another match (or none) becomes the first truthy one, or,
 * for a keyed match, when its value changes.
 *
 * @example
 *   <div>
 *     <Switch fallback={<p>Not found</p>}>
 *       <Match when={route() === "home"}><Home /></Match>
 *       <Match when={user()}>{(u) => <Profile name={u().name} />}</Match>
 *     </Switch>
 *   </div>
 */
export function Switch(_props: { fallback?: Child; children: Child }): unknown {
  return uncompiled("Switch");
}

/**
 * `<Match when keyed>`: one case of a `<Switch>`, whose children are what `<Show>`'s are.
 * Compiled away with its `<Switch>`; calling it at runtime throws.
 *
 * @example
 *   <Match when={user()} keyed>{(u) => <Profile name={u.name} />}</Match>
 */
export function Match<T>(props: { when: T; keyed: true; children: Child | ((value: Truthy<T>) => Child) }): unknown;
export function Match<T>(props: {
  when: T;
  keyed?: false;
  children: Child | ((value: () => Truthy<T>) => Child);
}): unknown;
export function Match(_props: unknown): unknown {
  return uncompiled("Match");
}

/**
 * `<Repeat count from fallback>`: a row for each index from `from` (0 by default) to
 * `from + count - 1`, with `fallback` while `count` is 0; compiled away to a keyed `<For>` over
 * the indexes, so a row is built once per index and kept while the count keeps it. Calling it at
 * runtime throws. Like a `<For>`, it stands anywhere content does, and a row is any content;
 * children that are not a function are each row's.
 *
 * @example
 *   <ul>
 *     <Repeat count={stars()}>{(i) => <li>Star {i + 1}</li>}</Repeat>
 *   </ul>
 */
export function Repeat(_props: {
  count: number;
  from?: number;
  fallback?: Child;
  children: Child | ((index: number) => unknown);
}): unknown {
  return uncompiled("Repeat");
}

/**
 * `<Portal mount>`: its children, placed at the end of `mount` (`document.body` by default)
 * instead of where the element is, and taken out when their owner is disposed (a slot that
 * replaces them, a row that leaves, `attach`'s disposer). `mount` is read once. Compiled away;
 * calling it at runtime throws.
 *
 * @example
 *   <Show when={open()}>
 *     <Portal><div class="modal">Hi</div></Portal>
 *   </Show>
 */
export function Portal(_props: { mount?: Node | null; children?: Child }): unknown {
  return uncompiled("Portal");
}

/**
 * `<Dynamic component {...props}>`: `component` called with the other props, or for a tag name,
 * that element with them; nothing for null, undefined or false. When `component` calls something
 * (a signal read), the element is rebuilt when it changes. Compiled away; calling it at runtime
 * throws.
 *
 * Props reach a component as they reach any component: once, when it is called. A tag name's
 * element takes them as spread props do, so they follow what they read.
 *
 * @example
 *   <div>
 *     <Dynamic component={heading() ? "h1" : "p"} class="title">Hello</Dynamic>
 *     <Dynamic component={views[tab()]} user={user} />
 *   </div>
 */
export function Dynamic<C extends DynamicComponent>(
  _props: { component: C | null | undefined | false } & PropsOf<C>,
): unknown {
  return uncompiled("Dynamic");
}

// #endregion

// #region What runs

/**
 * Internal: a class list as one string (@reactre/compiler calls it for a `class` array or object
 * whose classes it cannot know while compiling). A string or a number is a class name; an array's
 * items and an object's keys whose values are truthy are added in order; anything falsy is left
 * out, as `true` is.
 */
export function __class(v: unknown): string {
  if (typeof v === "string" || typeof v === "number") return v ? "" + v : "";
  let s = "";
  const add = (c: string): void => void (c && (s = s ? s + " " + c : c));
  if (Array.isArray(v)) for (const x of v) add(__class(x));
  else if (v !== null && typeof v === "object")
    for (const k in v as Record<string, unknown>) if ((v as Record<string, unknown>)[k]) add(k);
  return s;
}

// #endregion

export * from "./props.ts";
