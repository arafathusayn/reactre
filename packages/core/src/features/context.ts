// @reactre/core/features/context: Solid 2.0's context, `createContext` and `useContext`. A
// context is a component: `<Theme value="dark">...</Theme>` provides it to what its children
// make, then and later.
//
// How a lookup finds its provider. The core's owners have no link to the owner they were made
// in, and the owner that is current while a component runs is the slot, row or root around it,
// which may outlive the component and make more later (a slot's next content, a `<For>`'s next
// row). So every owner gets a scope, the one in force where it was made, and a lookup reads the
// current owner's:
//
//   - A scope is an object of values by context key, made with `Object.create` on the scope it
//     extends: a lookup is one property read, through the prototype chain of the providers
//     above it.
//   - A provider makes a root owner (owned by the current owner, so it goes with it) whose scope
//     extends the current one with its value, and reads its children under that root, in a slot
//     that reads them again when what they read changes.
//   - Every other owner takes the current owner's scope the first time it is entered: an
//     effect's first run (which is when it is made: an effect runs at once), and a root's first
//     `within` (a row's, an `attach`'s, a `createRoot`'s). Both read the core's owner variable,
//     and that is where they were made.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function.
//   - It costs nothing until loaded. The core's owners stay as they are; loading this module
//     wraps the owned effect class's `once` and its `within` (a method of the class and one of
//     its statics, the same objects every owner is made through), so that from then on owners
//     take their scope. An app that never imports it runs and ships the core's code unchanged.
//   - It brings ownership, as a provider is an owner.
//   - `undefined` means "not provided": a provider of undefined is skipped, as by Solid 2.0.
//   - @reactre/core/features/errors keeps its boundaries' handlers in the same scopes: they are
//     found as a context is, from what threw.

import { __frag, __Owned, __owner, __Root } from "@reactre/core";
import type { Child } from "@reactre/core/jsx-runtime";

/** Values by context key: the values in force where an owner was made. */
export type Scope = Record<symbol, unknown>;
/** An owner, and its scope once it has one. */
type Owner = NonNullable<typeof __owner> & { c?: Scope };
/** A root owner. */
type Root = InstanceType<typeof __Root>;

/** The scope of what was made under no provider at all. */
const TOP: Scope = {};

/** The scope of owner `o`; none (outside any owner) is TOP. */
const scopeOf = (o: Owner | null): Scope => (o === null ? undefined : o.c) ?? TOP;

// Owners take their scope from the owner current when they are first entered: an effect at its
// first run (it runs as it is made), a root at its first `within`.
const effects = __Owned.prototype as unknown as { once(this: Owner & { sources: unknown[] }): void };
const once = effects.once;
effects.once = function () {
  // An effect has no sources before its first run, and one that read none never runs again. One
  // made before this module loaded, running again, was made under no provider it can know of.
  this.c ??= this.sources.length === 0 ? scopeOf(__owner) : TOP;
  once.call(this);
};
const within = __Owned.within;
__Owned.within = <T>(o: Owner | null, fn: () => T): T => {
  if (o !== null) o.c ??= scopeOf(__owner);
  return within(o, fn);
};

/** Internal (@reactre/core/features/errors): the scope of what is made now. */
export function __scope(): Scope {
  return scopeOf(__owner);
}

/** Internal: a root owner with scope `s`, owned by the current owner, so it goes with it. */
export function __root(s: Scope): Root {
  const r = new __Root() as Root & Owner,
    p = __owner;
  r.c = s;
  if (p !== null) (p.owned ??= []).push(r);
  return r;
}

/**
 * Internal: what a provider or a boundary renders of its children, under the current owner: a
 * slot that reads `props.children`, now and again when what the read reads changes, as an element
 * whose hole reads `{props.children}` follows them. So a getter's child that may change
 * (`<Ctx value={v}>{more() ? <A /> : null}</Ctx>`, compiled) is followed, and so is a function
 * child, which the slot calls.
 */
export function __children(props: { readonly children?: unknown }): Node[] {
  return __frag([
    () => {
      const c = props.children;
      return typeof c === "function" ? (c as () => unknown)() : c;
    },
  ]);
}

/** A context's children: what a component's are, or a function, which renders as a slot. */
export type ContextChildren = Child | (() => Child);

/**
 * A context: a component that provides `value` to what its children make, and the key
 * `useContext` reads it by.
 */
export interface Context<T> {
  (props: { value: T; children?: ContextChildren }): unknown;
  /** The key its value is kept by. */
  readonly id: symbol;
  /** What `useContext` returns where no provider is above; undefined: it throws there. */
  readonly defaultValue: T | undefined;
}

/** What `useContext` throws for a context without a default, where no provider is above. */
export class ContextNotFoundError extends Error {
  override name: string = "ContextNotFoundError";
  // #if DEV
  /**
   * In the development build, with the context and whether a provider above gave it `undefined`:
   * a message that says which case it is and how to fix it.
   */
  constructor(ctx?: Context<unknown>, provided?: boolean) {
    super(ctx === undefined ? GENERIC : notFound(ctx, provided === true));
  }
  // #else
  // constructor() {
  //   super("reactre: useContext found no provider of a context that has no default");
  // }
  // #endif
}
// #if DEV

/**
 * `createContext`'s options, Solid 2.0's: `name`, which the development build's messages name the
 * context by. (A string is taken as the name too, as Solid's signals layer takes it.)
 */
export interface ContextOptions {
  readonly name?: string;
}

/** ContextNotFoundError's message without a context: the production build's. */
const GENERIC = "reactre: useContext found no provider of a context that has no default";

/** By context, what the development build knows of it: its name, and whether `undefined` was given as its default. */
const named = new WeakMap<object, { readonly name: string | undefined; readonly undef: boolean }>();

/** The development build's message for a read of `ctx` that found no value. */
function notFound(ctx: Context<unknown>, provided: boolean): string {
  const info = named.get(ctx),
    which = info?.name === undefined ? "a context" : `the context "${info.name}"`,
    nul = "createContext<T | null>(null)";
  if (provided)
    return `reactre CONTEXT_PROVIDED_UNDEFINED: useContext read ${which}, and the provider above gave it undefined, which counts as not provided ("no value", for a context). Fix: for an empty value, create the context with a null default (${nul}) and provide null.`;
  if (info?.undef === true)
    return `reactre CONTEXT_NOT_FOUND: useContext found no provider of ${which}, and createContext(undefined) gives it no default (undefined is "no value", for a context). Fix: render a provider above this read, or use null as its empty default (${nul}).`;
  return `reactre CONTEXT_NOT_FOUND: useContext found no provider of ${which}, which has no default. Fix: render a provider above this read, or create the context with a default; for an optional context, use null as its empty default (${nul}), not undefined.`;
}
// #endif

/**
 * A context, which is a component: `<Ctx value={v}>children</Ctx>` makes `v` what `useContext(Ctx)`
 * returns in everything its children make, then and later (a slot's next content, a `<For>`'s next
 * row, an effect's next run), unless a provider nearer provides another. There is no
 * `.Provider`, as in Solid 2.0.
 *
 * `value` is read once, when the provider runs: to share something that changes, provide a
 * signal's read function, or an object of them. Its children are read inside it, so the provider
 * must get them unbuilt: a getter (`get children()`, as the compiler passes JSX children), or a
 * function, which renders as a slot.
 *
 * With `defaultValue`, `useContext` returns it where no provider is above. Without one,
 * `useContext` throws `ContextNotFoundError` there. A provider of `undefined` is no provider.
 * In the development build, `options.name` (Solid 2.0's option) names the context in that
 * error's message, which says whether a provider gave it `undefined` and how to fix the read.
 *
 * @example
 *   import { createContext, useContext } from "@reactre/core/features/context";
 *
 *   const Theme = createContext("light");
 *   const Label = () => <b>{useContext(Theme)}</b>;
 *   const App = () => (
 *     <Theme value="dark">
 *       <Label />
 *     </Theme>
 *   ); // <b>dark</b>
 */
// #if DEV
export function createContext<T>(defaultValue?: T, options?: ContextOptions | string): Context<T> {
  // #else
  // export function createContext<T>(defaultValue?: T): Context<T> {
  // #endif
  const id = Symbol();
  const provider = (props: { value: T; children?: ContextChildren }): unknown => {
    const s: Scope = Object.create(__scope());
    s[id] = props.value;
    return __Owned.within(__root(s), () => __children(props));
  };
  // #if DEV
  const ctx = Object.assign(provider, { id, defaultValue });
  named.set(ctx, {
    name: typeof options === "string" ? options : options?.name,
    // An explicit undefined is no default either; the message says so.
    undef: arguments.length > 0 && defaultValue === undefined,
  });
  return ctx;
  // #else
  // return Object.assign(provider, { id, defaultValue });
  // #endif
}

/**
 * The value of `ctx` where it is called: the nearest provider's above what is running (a
 * component, an effect, a slot's content, a row), else the context's default.
 *
 * @throws ContextNotFoundError where no provider is above and the context has no default.
 *
 * @example
 *   const Theme = createContext<"light" | "dark">();
 *   function Label() {
 *     const theme = useContext(Theme); // throws outside a <Theme>
 *     return <b class={theme}>hi</b>;
 *   }
 */
export function useContext<T>(ctx: Context<T>): T {
  const v = __scope()[ctx.id] as T | undefined;
  if (v !== undefined) return v;
  if (ctx.defaultValue !== undefined) return ctx.defaultValue;
  // #if DEV
  // A provider of undefined above is in the scope's chain, as a key holding undefined.
  throw new ContextNotFoundError(ctx as Context<unknown>, ctx.id in __scope());
  // #else
  // throw new ContextNotFoundError();
  // #endif
}
