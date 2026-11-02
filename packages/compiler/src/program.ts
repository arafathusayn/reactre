// @reactre/compiler/program: which props of each component may be passed reactively, read from
// the call sites of one file or of a whole program.
//
// A component call passes a prop whose expression calls a function (reads a signal) as a getter,
// so the component reads it where it uses it. A hole in a component's JSX that reads a prop
// (`{props.title}`) is bound, an effect that rewrites it, only if some call site may pass that
// prop reactively; otherwise it is written once, as any hole that calls nothing. That needs every
// call site, and this module finds them: `Program` links the modules of a build by their imports
// and exports, and gives each module its facts, the props each of its components may be passed
// reactively. The compiler takes them as an option (`compileJs(js, { props })`).
//
// A component whose callers cannot all be seen is reactive in every prop (`true` in the facts):
// one exported from an entry (a library's API), one used as a value (`<Dynamic component={C}>`,
// `const X = C`, `[A, B]`, a function argument), one called with spread props, an object's method,
// a function passed to a call (`const Card = wrap((props) => ...)`), and every export of a module
// whose namespace is used as a value or imported dynamically. A program that cannot see its own
// graph (an import the resolver cannot place, `import(expr)`, `import.meta.glob`,
// `require.context`) gives up, and each file then gets the facts it can see alone.
//
// Design decisions:
//   - The module is read as tokens (identifiers, single punctuation, literals) by the scanner the
//     compiler uses, with no syntax tree: what it needs are the jsx calls, the import and export
//     statements, the component definitions and every other mention of a component's name.
//   - A component is a function named with a capital letter: a declaration, a const (or let, var,
//     assignment) holding an arrow or a function expression, or the default export. Its first
//     parameter is how it reads props: a name (`props`) whose members are read where they are
//     used, or a pattern (`{ title }`), whose values are read once, when the component runs.
//   - Facts are kept by component name within a module: two components of one name (in different
//     scopes) share theirs, as the union of both.
//   - A compiled JSX expression never reads a signal where it is evaluated: a component is called
//     untracked, and a host element's holes are effects of their own. So in a prop's expression,
//     the jsx calls are opaque: `cond() ? <A /> : null` is reactive for `cond()`, `<A n={x()} />`
//     is not (A's own call site passes `n` as a getter). A function literal's body is skipped
//     too: it runs when the function is called, not when the prop is evaluated.
//   - A component is not known to be one by its type, only by its name and shape. A function the
//     scan does not take for a component (a lowercase name other than the default export, one
//     chosen by a ternary) reads its props' members as any member read: once.
//   - `analyze` reads a build from its entries with the bundler's resolver (`Host`), following
//     what lands among the app's files; node_modules and assets are leaves. A late module (one
//     a bundler transforms that the walk did not reach) joins with `walk`, and `check` says
//     whether the facts given to modules compiled before it still hold.
//
// Stores (@reactre/core/features/store, and features/actions's optimistic store) are read by
// member, not by a call: `{store.count}` subscribes to `count`. A module's store roots are the
// names it binds stores to (`const [store, setStore] = createStore(...)`, `const p =
// createProjection(...)`, `const [todos, setTodos] = createOptimisticStore(...)`, `findStores`),
// and those it imports from a module of the program that exports one, through re-exports and
// namespace imports (`Program.factsOf` gives them as `PropFacts.stores`). An import the program
// cannot see into may be a store, and is taken for one, as a component whose callers cannot all
// be seen takes every prop reactively: one from a package outside the program, and, for a module
// seen alone (`moduleFacts`), any import. @reactre's own modules and assets export none. A prop whose value
// mentions a store root (`<Label text={store.title} />`, `<Item todo={store.todos[0]} />`) is passed
// reactively, as one that calls something; so is one that mentions the item of a `<For>` row whose
// `each` mentions a store root, since that item is a store too. A local made of a store root (a
// member, an object holding it, a function returning it: `ModuleInfo.aliases`) is one, exported
// too; so is a store's tuple kept whole, and a `<Show>`'s or `<Match>`'s child function's parameter.
//
// A prop is a store in a component (`<For each={props.todos}>` is copied, its rows bound) when a
// call site passes it one; and so is every prop of a component whose callers cannot all be seen
// (`true` in the facts: one an entry exports, one used as a value, and, in a module seen alone,
// one it exports), as it may be passed anything. Likewise a prop other than children that a call
// site passes JSX is content, inserted as children are. So a dev server renders what a build does;
// the build, seeing the callers, binds fewer holes. What holds a store that the scan cannot follow
// (a store made by a re-export of `createStore`) is not a root: its reads are written once, as any
// member read is, unless they call something (`getStore().count`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isIdent, skipToken, splitAt, trimAt, until } from "./scan.ts";

// #region Facts

/**
 * The props each component of a module may be passed reactively, by the component's name: a set
 * of prop names, or true for every prop (a component whose callers cannot all be seen). A
 * component that is not in the map is treated as true.
 */
export type PropFacts = ReadonlyMap<string, ReadonlySet<string> | true> & {
  /**
   * The names the module reads stores by (see `findStores`): its own, those it imports from
   * modules of the program (`store`, or `state.store` through a namespace import), and those it
   * imports from where the program cannot see, which may be stores (`state.*` for every member of
   * a namespace). Without it, the module's own alone.
   */
  readonly stores?: ReadonlySet<string>;
  /**
   * The props of each component, by its name, that some call site may pass a store (or a store's
   * member or item), or true for every prop (a component whose callers cannot all be seen, or one
   * passed what a spread may hold): a `<For each={props.todos}>` over one reads a copy, and its
   * rows follow their items. A component missing here is passed none, unless it is missing from
   * the facts too.
   */
  readonly storeProps?: ReadonlyMap<string, ReadonlySet<string> | true>;
  /**
   * The props other than children of each component, by its name, that some call site may pass
   * JSX (`<Card header={<h1>Hi</h1>} />`), or a prop that holds it: `{props.header}` is content,
   * inserted as `{props.children}` is, not text. True and missing, as for `storeProps`.
   */
  readonly contentProps?: ReadonlyMap<string, ReadonlySet<string> | true>;
  /**
   * The names the module reads JSX by (`ModuleInfo.jsx`): its locals that hold JSX (`const el =
   * <h1 />`, `function make() { return <b />; }`) or are made of what does, and its imports of
   * such a value from modules of the program (`ui.make` through a namespace import). A hole that
   * mentions one (`{el}`, `{make()}`, `{on() ? el : null}`) is inserted, not written as text.
   * Every import from the app's own files (`ownFile`: `make`, `ui.*` for a namespace import's
   * members) is one, and so is a local made of one, whatever the program sees it holds: a file
   * alone cannot see it, so a dev server and a build compile its holes alike. Without it, the
   * module's own locals and imports, as it says them alone.
   */
  readonly jsx?: ReadonlySet<string>;
};

/** Reactive props, as a set or true for all; also what an expression reads of a props object. */
type Props = Set<string> | true;

/** Whether reads `r` of a props object touch a prop in `facts`. */
export function touches(facts: ReadonlySet<string> | true, r: ReadonlySet<string> | true): boolean {
  if (facts === true) return true;
  if (r === true) return facts.size > 0;
  for (const k of r) if (facts.has(k)) return true;
  return false;
}

// #endregion

// #region Tokens

/** A token: an identifier, one punctuation character, or a literal (`t` is `LIT`). */
interface Token {
  readonly t: string;
  readonly s: number;
  readonly e: number;
}

/** A literal token's text: empty, which no identifier or punctuation is. */
const LIT = "";

/** Whether a token is a name (an identifier or a keyword); a number counts, as nothing needs it not to. */
const isName = (t: string | undefined): t is string => t !== undefined && isIdent(t[0]);

/**
 * The tokens of `src`. A template literal is one literal token, followed by its substitutions'
 * tokens inside `(` `)` of their own, so a name used in `${...}` is seen.
 */
function tokenize(src: string, from = 0, to = src.length, out: Token[] = []): Token[] {
  let prev = "",
    word = "";
  for (let i = from; i < to;) {
    const c = src[i]!;
    const j = skipToken(src, i, prev, word);
    if (j !== i) {
      const comment = c === "/" && (src[i + 1] === "/" || src[i + 1] === "*");
      if (!comment) {
        out.push({ t: LIT, s: i, e: j });
        if (c === "`") substitutions(src, i, j, out);
        prev = "a";
        word = "";
      }
      i = j;
      continue;
    }
    if (isIdent(c)) {
      let e = i;
      while (isIdent(src[e])) e++;
      out.push({ t: src.slice(i, e), s: i, e });
      word = src.slice(i, e);
      prev = "a";
      i = e;
      continue;
    }
    if (!/\s/.test(c)) {
      out.push({ t: c, s: i, e: i + 1 });
      prev = c;
      word = "";
    }
    i++;
  }
  return out;
}

/** The tokens of each `${...}` in the template literal src[start, end), each inside `(` `)`. */
function substitutions(src: string, start: number, end: number, out: Token[]): void {
  for (let j = start + 1; j < end; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "$" && src[j + 1] === "{") {
      const close = until(src, j + 2, "}");
      out.push({ t: "(", s: j, e: j + 2 });
      tokenize(src, j + 2, close, out);
      out.push({ t: ")", s: close, e: close + 1 });
      j = close;
    }
  }
}

/** For each bracket token, the index of the one that matches it; -1 for the rest. */
function matches(tokens: readonly Token[]): Int32Array {
  const m = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  tokens.forEach((tok, i) => {
    if (tok.t === "(" || tok.t === "[" || tok.t === "{") stack.push(i);
    else if (tok.t === ")" || tok.t === "]" || tok.t === "}") {
      const o = stack.pop();
      if (o !== undefined) ((m[o] = i), (m[i] = o));
    }
  });
  return m;
}

// #endregion

// #region Expressions

/**
 * Whether `expr` calls something when it is evaluated: a `(` after a name, a literal, `)`, `]` or
 * `?.` (`count?.()`), or `new`. A jsx call (one of `helpers`) is skipped whole, arguments
 * included, and so is a function literal's body, which runs only when the function is called.
 */
export function callsOutsideJsx(expr: string, helpers: ReadonlySet<string>): boolean {
  const tokens = tokenize(expr),
    m = matches(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const skip = skipped(tokens, m, i, helpers);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (tok.t === "new") return true;
    if (tok.t !== "(" || i === 0) continue;
    const p = tokens[i - 1]!.t;
    if ((p === LIT || isName(p) || p === ")" || p === "]") && !KEYWORDS.has(p)) return true;
    if (p === "." && tokens[i - 2]?.t === "?") return true;
  }
  return false;
}

/**
 * Where what starts at token i and is not evaluated with the expression around it ends: a jsx call
 * (one of `helpers`), or a function literal's body (from its `=>` or its `function`). -1 when
 * nothing of the kind starts there.
 */
function skipped(tokens: readonly Token[], m: Int32Array, i: number, helpers?: ReadonlySet<string>): number {
  const tok = tokens[i]!;
  if (helpers?.has(tok.t) && tokens[i + 1]?.t === "(" && tokens[i - 1]?.t !== ".") return m[i + 1]!;
  if (tok.t === "function" && tokens[i - 1]?.t !== ".") {
    let j = i + 1;
    while (j < tokens.length && tokens[j]!.t !== "(") j++;
    return tokens[m[j]! + 1]?.t === "{" ? m[m[j]! + 1]! : -1;
  }
  if (tok.t !== "=" || tokens[i + 1]?.t !== ">" || tokens[i + 1]!.s !== tok.e) return -1;
  // An arrow's body: a block, or an expression up to what ends it.
  if (tokens[i + 2]?.t === "{") return m[i + 2]!;
  let j = i + 2;
  while (j < tokens.length && !ENDS.has(tokens[j]!.t)) j = m[j]! > j ? m[j]! + 1 : j + 1;
  return j - 1;
}

/** Words that are not a binding's target, nor an object it writes into: `const [a] = ...` binds `a`. */
const NOT_OBJECT = new Set(
  "const let var return typeof void await in of new delete case throw yield else do this super null undefined true false export default".split(
    " ",
  ),
);

/** What ends an arrow's expression body. */
const ENDS = new Set([",", ")", "]", "}", ";"]);

/** Words a `(` may follow without being a call. */
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "void",
  "await",
  "in",
  "of",
  "function",
  "async",
]);

/**
 * What `expr` reads of the object named `name` (a component's props): the members it reads
 * (`props.title`, `props?.title`), or true when it uses the object otherwise (`fn(props)`,
 * `props[k]`, `{...props}`); null when it does not mention it. A function literal's body is
 * skipped, as it reads only when called (and an expression that calls it calls something); with
 * `helpers`, so are its jsx calls, as in `callsOutsideJsx`.
 */
export function readsOf(expr: string, name: string, helpers?: ReadonlySet<string>): Props | null {
  const tokens = tokenize(expr),
    m = matches(tokens);
  let out: Set<string> | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const skip = skipped(tokens, m, i, helpers);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    // A member of something else (`x.props`), but not a spread (`...props`, three `.` tokens).
    if (tok.t !== name || (tokens[i - 1]?.t === "." && tokens[i - 2]?.t !== ".")) continue;
    let j = i + 1;
    if (tokens[j]?.t === "?" && tokens[j + 1]?.t === ".") j++;
    const key = tokens[j]?.t === "." ? tokens[j + 1] : undefined;
    if (key === undefined || !isIdent(key.t[0])) return true;
    (out ??= new Set()).add(key.t);
  }
  return out;
}

/** Whether `expr` is a function literal (an arrow or a function expression). */
export function isFunction(expr: string): boolean {
  const s = expr.trim();
  if (/^(async\s+)?function\b/.test(s) || /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(s)) return true;
  const open = /^(async\s*)?\(/.exec(s);
  if (open === null) return false;
  const close = until(s, open[0].length, "");
  return s
    .slice(close + 1)
    .trimStart()
    .startsWith("=>");
}

/**
 * How a component call passes a prop of value `expr`, `scope` being the components it is written
 * in (outermost first). A function literal is passed as it is (`fn`), so is anything else that
 * calls nothing, reads no props and mentions no store root. Otherwise it is a getter: `lazy` when
 * it holds JSX (built when the component reads it), `calls` when it calls something, `reads` the
 * props it reads of each component around it, and `stores` the store roots it mentions (only
 * when it mentions one). A program's scan adds `storeReads`, the props of components around it
 * that a row's item it mentions stands for (`<Item todo={t} />` in a row over `props.todos`).
 */
export interface PropUse {
  readonly fn: boolean;
  readonly lazy: boolean;
  readonly calls: boolean;
  readonly reads: readonly (readonly [Def, Props])[];
  readonly stores?: readonly string[];
  readonly storeReads?: readonly (readonly [Def, Props])[];
}

/**
 * A prop's use (see `PropUse`), for value `expr` written inside the components `scope`, where
 * `roots` are the names that may hold stores (see `rootsIn`).
 */
export function propUse(
  expr: string,
  helpers: ReadonlySet<string>,
  scope: readonly Def[],
  roots: ReadonlySet<string> = NONE,
): PropUse {
  if (isFunction(expr)) return { fn: true, lazy: false, calls: false, reads: [] };
  let lazy = false;
  for (const h of helpers) if (expr.includes(h + "(")) lazy = true;
  const use = { fn: false, lazy, calls: callsOutsideJsx(expr, helpers), reads: propReads(expr, scope, helpers) };
  const stores = rootsIn(expr, roots, helpers);
  return stores.length === 0 ? use : { ...use, stores };
}

/** No names. */
const NONE: ReadonlySet<string> = new Set();
/** No props: what a component no call site passes a store is passed one in (never written to). */
const NO_PROPS: Set<string> = new Set();

/**
 * The names of `roots` that `expr` mentions, other than as a member of something else (`x.store`)
 * or an object's key (`{ store: 1 }`): reading through one (`store.count`, `store[i]`) or passing
 * it on (`f(store)`, `{ ...store }`). A root may be a namespace import's member (`state.store`),
 * and `state.*` stands for every member of `state`. A function literal's body is skipped, as it
 * reads only when called; with `helpers`, so are jsx calls, as in `callsOutsideJsx`.
 */
export function rootsIn(expr: string, roots: ReadonlySet<string>, helpers?: ReadonlySet<string>): string[] {
  if (roots.size === 0) return [];
  const tokens = tokenize(expr);
  return mentions(tokens, matches(tokens), 0, tokens.length, roots, helpers, true);
}

/**
 * `rootsIn` over tokens [from, to) of a tokenized source. With `fns` false, a function literal's
 * body is read too: a local made of it (`const get = () => store.todos`) gives what it mentions.
 */
function mentions(
  tokens: readonly Token[],
  m: Int32Array,
  from: number,
  to: number,
  roots: ReadonlySet<string>,
  helpers: ReadonlySet<string> | undefined,
  fns: boolean,
): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const skip = fns
      ? skipped(tokens, m, i, helpers)
      : helpers?.has(tokens[i]!.t) && tokens[i + 1]?.t === "(" && tokens[i - 1]?.t !== "."
        ? m[i + 1]!
        : -1;
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const t = tokens[i]!.t,
      prev = tokens[i - 1]?.t;
    if ((prev === "." && tokens[i - 2]?.t !== ".") || (tokens[i + 1]?.t === ":" && (prev === "{" || prev === ",")))
      continue;
    let root = roots.has(t) ? t : null;
    const member = tokens[i + 1]?.t === "." ? tokens[i + 2]?.t : undefined;
    if (root === null && isName(member) && (roots.has(`${t}.${member}`) || roots.has(`${t}.*`)))
      root = `${t}.${member}`;
    if (root !== null && !out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * What `expr` reads of the props of each component in `scope` (outermost first) that names its
 * props object; an inner component's parameter hides an outer one of the same name. A use of a
 * local made of the whole props object (`Def.aliases`) may read any prop.
 */
export function propReads(
  expr: string,
  scope: readonly Def[],
  helpers?: ReadonlySet<string>,
): (readonly [Def, Props])[] {
  const out: (readonly [Def, Props])[] = [];
  const seen = new Set<string>();
  for (let i = scope.length - 1; i >= 0; i--) {
    const d = scope[i]!;
    if (d.param.kind !== "name" || seen.has(d.param.name)) continue;
    seen.add(d.param.name);
    const r = d.aliases.some((a) => readsOf(expr, a, helpers) !== null) ? true : readsOf(expr, d.param.name, helpers);
    if (r !== null) out.push([d, r]);
  }
  return out;
}

// #endregion

// #region Components

/** How a component takes its props: by a name, by a pattern of names, or not at all. */
export type Param =
  | { readonly kind: "name"; readonly name: string }
  /** `locals`: each name the pattern binds, with the prop it holds. */
  | { readonly kind: "pattern"; readonly locals: ReadonlyMap<string, string> }
  | { readonly kind: "none" };

/** A component definition: a function named with a capital letter. */
export interface Def {
  /** Its name; `default` for a default export without one. */
  readonly name: string;
  readonly param: Param;
  /**
   * The locals its body makes of its whole props object, for a parameter that names it (see
   * `aliasesOf`): `p` in `const p = merge({ size: "m" }, props)`. Reading one's members may read
   * any prop.
   */
  readonly aliases: readonly string[];
  /** Where it starts and ends in the module (its parameters and body). */
  readonly start: number;
  readonly end: number;
  /** Whether its definition hides its callers: an object's method, a function passed to a call. */
  readonly open: boolean;
}

/** A function literal at token k: where its parameters and body are, or null when none is there. */
interface Fn {
  /** Its own name, for a named function expression. */
  readonly name: string | null;
  readonly params: readonly [number, number];
  readonly end: number;
}

/** The function literal that starts at token k, if one does. */
function fnAt(src: string, tokens: readonly Token[], m: Int32Array, k: number): Fn | null {
  if (tokens[k]?.t === "async" && (tokens[k + 1]?.t === "function" || tokens[k + 1]?.t === "(")) k++;
  const tok = tokens[k];
  if (tok?.t === "function") {
    let j = k + 1;
    if (tokens[j]?.t === "*") j++;
    const name = isName(tokens[j]?.t) ? tokens[j++]!.t : null;
    const close = m[j]!;
    // A function's parameters are followed by its body.
    if (tokens[j]?.t !== "(" || tokens[close + 1]?.t !== "{") return null;
    return { name, params: [tokens[j]!.e, tokens[close]!.s], end: tokens[m[close + 1]!]!.e };
  }
  // An arrow: `(params) =>` or `name =>`, then a block or an expression.
  const after = tok?.t === "(" ? m[k]! + 1 : isName(tok?.t) ? k + 1 : -1;
  const arrow = tokens[after],
    body = tokens[after + 2];
  if (arrow?.t !== "=" || tokens[after + 1]?.t !== ">" || tokens[after + 1]!.s !== arrow.e || body === undefined)
    return null;
  const params: [number, number] = tok!.t === "(" ? [tok!.e, tokens[after - 1]!.s] : [tok!.s, tok!.e];
  return { name: null, params, end: body.t === "{" ? tokens[m[after + 2]!]!.e : until(src, body.s, ",;") };
}

/** How the parameter list src[at[0], at[1]) takes props: by its first parameter. */
function paramOf(src: string, [from, to]: readonly [number, number]): Param {
  const first = splitAt(src, from, to)[0]?.[0] ?? "";
  const name = /^([A-Za-z_$][\w$]*)\s*(=[\s\S]*)?$/.exec(first);
  if (name !== null) return { kind: "name", name: name[1]! };
  if (!first.startsWith("{")) return { kind: "none" };
  const locals = new Map<string, string>();
  const close = until(first, 1, "");
  for (const [part] of splitAt(first, 1, close)) {
    const p = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/.exec(part);
    if (p !== null) locals.set(p[4] ?? p[3]!, p[1] ?? p[2] ?? p[3]!);
  }
  return { kind: "pattern", locals };
}

/**
 * The locals that the body src[from, to) of a component whose props object is `name` makes of the
 * whole object: each name a `const`, `let` or `var` declares whose initializer uses `name`, or an
 * earlier such local, other than by reading a member (`merge(defaults, props)`, `omit(props, "a")`,
 * `props`). Such a local may hold the props' getters (the store's `merge` and `omit` keep them), so
 * a hole that reads one of its members reads props. A destructuring pattern, and a local that reads
 * a member (`const t = props.title`), read their values once, as in Solid.
 */
function aliasesOf(src: string, from: number, to: number, name: string): string[] {
  const tokens = tokenize(src, from, to),
    m = matches(tokens);
  const out = [name];
  for (let i = 0; i < tokens.length; i++) {
    const kw = tokens[i]!.t;
    if (kw !== "const" && kw !== "let" && kw !== "var") continue;
    // Each declarator, `local = init`, up to the `,` or `;` (or the block's end) that ends it.
    for (let j = i + 1; isName(tokens[j]?.t) && tokens[j + 1]?.t === "=" && j + 2 < tokens.length;) {
      let k = j + 2;
      while (k < tokens.length && !ENDS.has(tokens[k]!.t)) k = m[k]! > k ? m[k]! + 1 : k + 1;
      const init = src.slice(tokens[j + 2]!.s, tokens[k - 1]!.e);
      if (out.some((a) => readsOf(init, a) === true)) out.push(tokens[j]!.t);
      if (tokens[k]?.t !== ",") break;
      j = k + 1;
    }
  }
  return out.slice(1);
}

/** Whether `name` names a component: it starts with a capital letter. */
const isComponentName = (name: string): boolean => /^[A-Z]/.test(name);

/** The component definitions in a module, in source order. */
export function findDefs(src: string): Def[] {
  return scanDefs(src, tokenize(src)).defs;
}

/** `findDefs`, from the module's tokens; with the tokens that name each definition. */
function scanDefs(src: string, tokens: readonly Token[], m = matches(tokens)): { defs: Def[]; names: Set<number> } {
  const defs: Def[] = [],
    names = new Set<number>();
  // Where each definition's parameters start, so a function is one definition.
  const found = new Set<number>();
  const add = (name: string, fn: Fn, start: number, open: boolean, at: number) => {
    const param = paramOf(src, fn.params);
    const aliases = param.kind === "name" ? aliasesOf(src, fn.params[1], fn.end, param.name) : [];
    defs.push({ name, param, aliases, start, end: fn.end, open });
    found.add(fn.params[0]);
    if (at >= 0) names.add(at);
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!,
      prev = tokens[i - 1]?.t,
      next = tokens[i + 1]?.t;
    if (tok.t === "function" && prev !== ".") {
      const fn = fnAt(src, tokens, m, i);
      if (fn?.name != null && isComponentName(fn.name))
        add(fn.name, fn, tok.s, false, i + (tokens[i + 1]!.t === "*" ? 2 : 1));
    } else if (tok.t === "default" && prev === "export") {
      // A default export is a component whatever its name: Bun names an anonymous function
      // `input_default`.
      const fn = fnAt(src, tokens, m, i + 1);
      if (fn !== null && (fn.name === null || !isComponentName(fn.name)))
        add(fn.name ?? "default", fn, tokens[i + 1]!.s, false, -1);
    } else if (!isComponentName(tok.t)) continue;
    else if (next === "=" && tokens[i + 2]?.t !== "=" && tokens[i + 2]?.t !== ">") {
      // A member (`Card.Header = ...`) is reached through its object, and a function a call wraps
      // (`const Card = wrap((props) => ...)`) by whatever the call makes: their callers are hidden.
      const fn = fnAt(src, tokens, m, i + 2);
      const inner = fn ?? wrapped(src, tokens, m, i + 2);
      if (inner !== null) add(tok.t, inner, tok.s, fn === null || prev === ".", prev === "." ? -1 : i);
    } else if (prev === ".") continue;
    else if (next === ":" && (prev === "{" || prev === ",")) {
      const fn = fnAt(src, tokens, m, i + 2);
      if (fn !== null) add(tok.t, fn, tok.s, true, -1);
    } else if (next === "(" && (prev === "{" || prev === "," || prev === "}" || prev === ";")) {
      // A method: `Card(props) { ... }`, in an object or a class.
      const close = m[i + 1]!;
      if (tokens[close + 1]?.t === "{")
        add(
          tok.t,
          { name: tok.t, params: [tokens[i + 1]!.e, tokens[close]!.s], end: tokens[m[close + 1]!]!.e },
          tok.s,
          true,
          -1,
        );
    }
  }
  unnamed(src, tokens, m, found, (fn, start) => add(UNNAMED, fn, start, true, -1));
  // Source order, outermost first, as `scopeAt` gives them.
  defs.sort((a, b) => a.start - b.start);
  return { defs, names };
}

/** The name of a component the scan finds no name for (see `unnamed`): no local is named so. */
const UNNAMED = "(unnamed)";

/** The keywords a `(` follows in a block, where a method of an object would have its name. */
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "with", "function", "get", "set", "async"]);

/**
 * The components no name tells apart: a function literal that holds JSX and takes props (a name or
 * a pattern), where it may be rendered as a component, but is not one `scanDefs` names (`found`
 * holds where those' parameters start). Such a place is an object's property or method of any
 * name (`{ default: (props) => ... }`, rendered `<parts.default />`), a ternary's branch, a
 * member it is assigned to (`ui.card = (props) => ...`), and what a function returns (`return
 * (props) => ...`, `(k) => (props) => ...`: a component a `.map` or a wrapper makes). Their callers
 * are hidden, so each is open (`Def.open`): every prop may change, as a component's whose callers
 * cannot all be seen. A function passed to a call (a `.map` callback, a handler) and a jsx call's
 * own props (a <For> row, a render prop's function) are not such places, nor a local of a lowercase
 * name, which JSX cannot render as a component.
 */
function unnamed(
  src: string,
  tokens: readonly Token[],
  m: Int32Array,
  found: ReadonlySet<number>,
  add: (fn: Fn, start: number) => void,
): void {
  // The bracket each token is in, and whether a `{` is a jsx call's props object.
  const parent = new Int32Array(tokens.length).fill(-1),
    stack: number[] = [];
  tokens.forEach((_, j) => {
    parent[j] = stack.at(-1) ?? -1;
    if (m[j]! > j) stack.push(j);
    else if (m[j]! >= 0) stack.pop();
  });
  const jsxProps = (o: number) => o >= 0 && parent[o]! >= 0 && HELPER.test(tokens[parent[o]! - 1]?.t ?? "");
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!.t,
      prev = tokens[i - 1]!;
    let k = -1;
    // A property's value, or a ternary's branch (`?`, but not `?.` or `??`).
    if ((t === ":" || (t === "?" && ![".", "?"].includes(tokens[i + 1]?.t ?? ""))) && !jsxProps(parent[i]!)) k = i + 1;
    else if (t === "return") k = i + 1;
    // An arrow's body (`=>`), and a member assigned (`a.b =`, `a[k] =`, not `==`, `=>` or `+=`).
    else if (t === ">" && prev.t === "=" && prev.e === tokens[i]!.s) k = i + 1;
    else if (
      t === "=" &&
      !["=", ">"].includes(tokens[i + 1]?.t ?? "") &&
      ((isName(prev.t) && tokens[i - 2]?.t === ".") || prev.t === "]")
    )
      k = i + 1;
    else if (
      t === "(" &&
      isName(prev.t) &&
      !NOT_METHOD.has(prev.t) &&
      ["{", ","].includes(tokens[i - 2]?.t ?? "") &&
      tokens[m[i]! + 1]?.t === "{"
    ) {
      // A method, `render(props) { ... }`.
      const close = m[i]!;
      const fn = { name: prev.t, params: [tokens[i]!.e, tokens[close]!.s] as const, end: tokens[m[close + 1]!]!.e };
      if (holdsJsx(tokens, i, fn) && paramOf(src, fn.params).kind !== "none" && !found.has(fn.params[0]))
        add(fn, prev.s);
      continue;
    }
    const fn = k < 0 ? null : fnAt(src, tokens, m, k);
    if (fn === null || found.has(fn.params[0]) || !holdsJsx(tokens, k, fn)) continue;
    if (paramOf(src, fn.params).kind !== "none") add(fn, tokens[k]!.s);
  }
}

/** Whether function `fn`, whose tokens start at token k, holds a jsx call. */
function holdsJsx(tokens: readonly Token[], k: number, fn: Fn): boolean {
  for (let j = k; j < tokens.length && tokens[j]!.s < fn.end; j++) if (HELPER.test(tokens[j]!.t)) return true;
  return false;
}

/** For `wrap(a, fn, ...)` at token k: the first function literal among the call's arguments, in calls too. */
function wrapped(src: string, tokens: readonly Token[], m: Int32Array, k: number): Fn | null {
  while (tokens[k + 1]?.t === "." && isName(tokens[k + 2]?.t)) k += 2;
  if (!isName(tokens[k]?.t) || tokens[k + 1]?.t !== "(") return null;
  const close = m[k + 1]!;
  for (let j = k + 2; j < close; j++) {
    const fn = fnAt(src, tokens, m, j) ?? wrapped(src, tokens, m, j);
    if (fn !== null) return fn;
    // On to the next argument.
    while (j < close && tokens[j]!.t !== ",") j = m[j]! > j ? m[j]! + 1 : j + 1;
  }
  return null;
}

/** The components whose definitions hold position `at`, outermost first. */
export function scopeAt(defs: readonly Def[], at: number): Def[] {
  return defs.filter((d) => d.start <= at && at < d.end);
}

// #endregion

// #region Modules

/** A call site's component: a local name, a namespace import's member, or unknown (null). */
type Target = { readonly local: string } | { readonly ns: string; readonly member: string } | null;

/** A component call: its component, each prop's use, and whether it spreads props. */
interface Site {
  readonly target: Target;
  readonly props: readonly (readonly [string, PropUse])[];
  readonly spread: boolean;
  /**
   * The components whose whole props object it spreads (`{...props}`), which pass on the stores
   * and JSX theirs may hold; null when it spreads what the scan cannot see into.
   */
  readonly spreads: readonly Def[] | null;
}

/** An import binding: the module's specifier and the export (`*` for the namespace). */
interface Binding {
  readonly spec: string;
  readonly name: string;
}

/** What one module says about components: see `scanModule`. */
export interface ModuleInfo {
  readonly defs: readonly Def[];
  /** Each import binding by its local name. */
  readonly imports: ReadonlyMap<string, Binding>;
  /** Each export by its name: a local name, or a binding of another module (a re-export). */
  readonly exports: ReadonlyMap<string, { readonly local: string } | Binding>;
  /** `export * from` specifiers. */
  readonly stars: readonly string[];
  /** Every specifier the module imports, re-exports or imports dynamically. */
  readonly specs: readonly string[];
  readonly sites: readonly Site[];
  /** Local names (components or imports) used as values. */
  readonly escapes: ReadonlySet<string>;
  /** Namespace imports used as values: each member so used, or true for the namespace itself. */
  readonly nsEscapes: ReadonlyMap<string, Set<string> | true>;
  /** Specifiers whose every export escapes: `import()`, `require()`, `export * as ns from`. */
  readonly whole: readonly string[];
  /** Whether it imports what cannot be known while compiling: `import(expr)`, a glob, a context. */
  readonly opaque: boolean;
  /** The names it binds stores to (see `findStores`). */
  readonly stores: ReadonlySet<string>;
  /**
   * The locals whose value may hold a store, with what it is made of: the names that may hold
   * stores it mentions (`roots`: own stores, imports, other such locals) and the props of
   * components around it that it reads (`reads`). A local is one when its value mentions one of
   * those (`const todos = store.todos`, `const box = { store }`, `const [first] = store.list`,
   * `const get = () => store.todos`, `function useTodos() { return store; }`, a `for ... of` over
   * a store's array) or reads a prop (`const todos = props.todos`), and so is a name a component's
   * pattern of props binds (`{ todos }`). The program says which hold one (`Program.factsOf`).
   */
  readonly aliases: ReadonlyMap<string, Alias>;
  /**
   * The locals whose value may hold JSX, each with what it is made of: true for a value that holds
   * a jsx call (`const el = <h1 />`, `const items = [<li />]`, `function make() { return <b />; }`,
   * `const view = memo(() => <p />)`, `const o = { render() { return <i />; } }`), else the names
   * it mentions that may hold JSX: other such locals, and imports from outside @reactre (a
   * namespace import's member). The program says which imports hold JSX (`Program.factsOf`):
   * every one from the app's own files (`ownFile`), and of the others those it sees hold JSX.
   */
  readonly jsx: ReadonlyMap<string, readonly string[] | true>;
}

/** What a local that may hold a store is made of: see `ModuleInfo.aliases`. */
export interface Alias {
  readonly roots: readonly string[];
  readonly reads: readonly (readonly [Def, Props])[];
}

/** The names Bun and the plugin give jsx, jsxs and jsxDEV, and Fragment. */
const HELPER = /^(jsxs|jsx|jsxDEV)_[a-z0-9]{8}$/,
  FRAGMENT = /^Fragment_[a-z0-9]{8}$/;

/** The control flow element names @reactre/core exports, which are not components. */
const FLOW = new Set(["For", "Show", "Switch", "Match", "Repeat", "Portal", "Dynamic"]);

/** A string literal's value: a specifier. */
const unquote = (lit: string): string => lit.slice(1, -1);

/**
 * The modules whose functions make the stores the compiler follows, and those functions:
 * @reactre/core/features/store's `createStore` and `createProjection`, and
 * @reactre/core/features/actions's `createOptimisticStore`, whose store is a projection too.
 */
const STORE_MAKERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@reactre/core/features/store", new Set(["createStore", "createProjection"])],
  ["@reactre/core/features/actions", new Set(["createOptimisticStore"])],
]);

/**
 * The names a module binds stores to: the first name of the array pattern a `createStore(...)`
 * or `createOptimisticStore(...)` call is destructured into (`const [store, setStore] =
 * createStore(...)`), the name such a call's tuple is kept in whole (`const t = createStore(...)`,
 * read as `t[0].count`), and the name a `createProjection(...)` call is assigned to. The functions
 * are those @reactre/core/features/store and features/actions export, imported under any local
 * name or through a namespace import (`S.createStore`). With them, the locals made of those
 * (see `ModuleInfo.aliases`) that the module's own stores alone make stores.
 */
export function findStores(src: string): Set<string> {
  for (const spec of STORE_MAKERS.keys()) if (src.includes(spec)) return new Set(scanModule(src).stores);
  return new Set();
}

/** `findStores`, from the module's tokens and its import bindings. */
function storesOf(tokens: readonly Token[], m: Int32Array, imports: ReadonlyMap<string, Binding>): Set<string> {
  const out = new Set<string>(),
    fns = new Map<string, string>(),
    namespaces = new Map<string, ReadonlySet<string>>();
  for (const [local, b] of imports) {
    const makers = STORE_MAKERS.get(b.spec);
    if (makers === undefined) continue;
    if (b.name === "*") namespaces.set(local, makers);
    else if (makers.has(b.name)) fns.set(local, b.name);
  }
  for (let i = 0; i < tokens.length; i++) {
    const at = i,
      t = tokens[i]!.t;
    if (tokens[i - 1]?.t === ".") continue;
    let fn = fns.get(t);
    const ns = namespaces.get(t);
    if (ns !== undefined && tokens[i + 1]?.t === "." && ns.has(tokens[i + 2]?.t ?? "")) fn = tokens[(i += 2)]!.t;
    // `name = fn(...)`, or `[name, ...] = fn(...)`: not `==`, `+=` and the like.
    const before = tokens[at - 2];
    if (fn === undefined || tokens[i + 1]?.t !== "(" || tokens[at - 1]?.t !== "=" || before === undefined) continue;
    if (fn === "createProjection" || (isName(before.t) && tokens[at - 3]?.t !== ".")) {
      // A projection, or a store's tuple kept whole (`const t = createStore(...)`, read `t[0].x`).
      if (isName(before.t)) out.add(before.t);
    } else if (before.t === "]") {
      const first = tokens[m[at - 2]! + 1]!;
      if (isName(first.t) && [",", "]", "="].includes(tokens[m[at - 2]! + 2]!.t)) out.add(first.t);
    }
  }
  return out;
}

/** Scan one module's JavaScript (as `compileJs` reads it) for its components and their uses. */
export function scanModule(src: string): ModuleInfo {
  const tokens = tokenize(src),
    m = matches(tokens);
  const { defs, names: skip } = scanDefs(src, tokens, m);
  const imports = new Map<string, Binding>(),
    exports = new Map<string, { local: string } | Binding>(),
    stars: string[] = [],
    specs: string[] = [],
    whole: string[] = [],
    sites: Site[] = [];
  const helpers = new Set<string>();
  for (const tok of tokens) if (HELPER.test(tok.t)) helpers.add(tok.t);
  const flow = new Set<string>(["For"]);
  let opaque = false;
  const lit = (i: number) =>
    tokens[i]?.t === LIT && /^["']/.test(src[tokens[i]!.s]!) ? unquote(src.slice(tokens[i]!.s, tokens[i]!.e)) : null;
  /** Skip the tokens of a statement from i to its end (`;`, or a specifier for an import). */
  const statement = (i: number): number => {
    let j = i;
    while (j < tokens.length && tokens[j]!.t !== ";") j = m[j]! > j ? m[j]! + 1 : j + 1;
    for (let k = i; k < j; k++) skip.add(k);
    return j;
  };
  /** The `a as b` list between braces at token o: [name, local] pairs. */
  const list = (o: number): [string, string][] => {
    const out: [string, string][] = [];
    for (let k = o + 1; k < m[o]!; k++) {
      const a = tokens[k]!;
      if (a.t === ",") continue;
      const name = a.t === LIT ? unquote(src.slice(a.s, a.e)) : a.t;
      if (tokens[k + 1]?.t === "as") out.push([name, tokens[(k += 2)]!.t]);
      else out.push([name, name]);
    }
    return out;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!,
      prev = tokens[i - 1]?.t;
    if (prev === "." || tokens[i + 1]?.t === ":") continue;
    // A statement starts the module or follows another; `import` and `export` elsewhere are not one.
    const starts = prev === undefined || prev === ";" || prev === "}";
    if (tok.t === "import" || tok.t === "require") {
      const next = tokens[i + 1]?.t;
      if (next === "(") {
        const spec = lit(i + 2);
        if (spec !== null && tokens[i + 3]?.t === ")") (specs.push(spec), whole.push(spec));
        else opaque = true;
        continue;
      }
      if (next === ".") {
        // import.meta.glob, require.context: modules chosen by a pattern.
        if (tokens[i + 2]?.t === "context" || (tokens[i + 2]?.t === "meta" && tokens[i + 4]?.t === "glob"))
          opaque = true;
        continue;
      }
      if (tok.t === "require" || !starts) continue;
      const end = statement(i);
      const spec = lit(end - 1);
      if (spec === null) continue;
      specs.push(spec);
      for (let k = i + 1; k < end - 1; k++) {
        const t = tokens[k]!.t;
        if (t === "{") {
          for (const [name, local] of list(k)) imports.set(local, { spec, name });
          k = m[k]!;
        } else if (t === "*") imports.set(tokens[(k += 2)]!.t, { spec, name: "*" });
        else if (t !== "," && t !== "from" && t !== "type") imports.set(t, { spec, name: "default" });
      }
      if (spec === "@reactre/core")
        for (const [local, b] of imports)
          if (b.spec === spec && (FLOW.has(b.name) || b.name === "*")) flow.add(b.name === "*" ? local + ".*" : local);
      i = end;
      continue;
    }
    if (tok.t !== "export" || !starts) continue;
    const next = tokens[i + 1]!;
    if (next.t === "{" || next.t === "*") {
      const end = statement(i);
      const spec = tokens[end - 2]?.t === "from" ? lit(end - 1) : null;
      if (spec !== null) specs.push(spec);
      if (next.t === "*") {
        if (tokens[i + 2]?.t === "as") whole.push(spec!);
        else stars.push(spec!);
      } else for (const [name, as] of list(i + 1)) exports.set(as, spec === null ? { local: name } : { spec, name });
      i = end;
      continue;
    }
    if (next.t === "default") {
      const after = tokens[i + 2];
      const fn = fnAt(src, tokens, m, i + 2);
      if (fn !== null) exports.set("default", { local: fn.name ?? "default" });
      else if (after !== undefined && isName(after.t) && (tokens[i + 3]?.t === ";" || tokens[i + 3] === undefined)) {
        exports.set("default", { local: after.t });
        skip.add(i + 2);
      } else if (after?.t === "class" && tokens[i + 3] !== undefined)
        exports.set("default", { local: tokens[i + 3]!.t });
      continue;
    }
    let k = i + 1;
    if (tokens[k]?.t === "async") k++;
    const kw = tokens[k]?.t;
    if (kw === "function" || kw === "class") {
      const n = tokens[k + 1]?.t === "*" ? k + 2 : k + 1;
      exports.set(tokens[n]!.t, { local: tokens[n]!.t });
    } else if (kw === "const" || kw === "let" || kw === "var") {
      // Every name a declarator binds, patterns' names included.
      const end = until(src, tokens[k]!.e, ";");
      for (const [part] of splitAt(src, tokens[k]!.e, end)) {
        const lhs = part.slice(0, until(part, 0, "="));
        for (const t of tokenize(lhs)) if (isName(t.t)) exports.set(t.t, { local: t.t });
      }
    }
  }
  const own = storesOf(tokens, m, imports);
  // The names that may hold a store, known once the program links the modules: the module's own
  // stores, what it imports from outside @reactre (a namespace import's every member), and the
  // locals made of those or of props (`aliases`). Within a <For> row whose `each` mentions one or
  // reads a prop, so does the row's item, standing for what `each` mentions and reads (`under`),
  // and so does the parameter of a <Show> or <Match> child function, for its `when`.
  const imported = new Set<string>();
  for (const [local, b] of imports) if (exportsStores(b.spec)) imported.add(b.name === "*" ? `${local}.*` : local);
  const roots = new Set([...own, ...imported]);
  const decls = boundIn(tokens, m, defs);
  const aliases = aliasesIn(src, tokens, m, defs, roots, helpers, decls);
  // The locals that may hold JSX: made of a jsx call, of such a local, or of an import that may be
  // one (the program says which are).
  const jsx = jsxIn(tokens, m, decls, imported, helpers);
  for (const a of aliases.keys()) roots.add(a);
  const stores = ownStores(own, aliases);
  const rows: (Alias & { readonly name: string; readonly start: number; readonly end: number })[] = [];
  const rowsAt = (at: number) => rows.filter((r) => r.start <= at && at < r.end);
  const rootsAt = (at: number): ReadonlySet<string> => {
    const here = rowsAt(at);
    return here.length === 0 ? roots : new Set([...roots, ...here.map((r) => r.name)]);
  };
  /** What names found at `at` stand for: a row's item, what its `each` mentions and reads. */
  const under = (names: readonly string[], at: number): Alias => {
    const out = { roots: [] as string[], reads: [] as (readonly [Def, Props])[] };
    for (const n of names) {
      const row = rowsAt(at).findLast((r) => r.name === n);
      if (row === undefined) out.roots.push(n);
      else (out.roots.push(...row.roots), out.reads.push(...row.reads));
    }
    return out;
  };
  /** A row over `each` (or a child function of `when`), from what it mentions and reads at `at`. */
  const found = (each: string, at: number): Alias => {
    const u = under(rootsIn(each, rootsAt(at), helpers), at);
    return { roots: u.roots, reads: u.reads.concat(propReads(each, scopeAt(defs, at), helpers)) };
  };
  const fors = new Set(["For"]),
    shows = new Set<string>();
  for (const [local, b] of imports)
    if (b.spec === "@reactre/core") {
      if (b.name === "For" || b.name === "*") fors.add(b.name === "*" ? `${local}.For` : local);
      if (b.name === "*") (shows.add(`${local}.Show`), shows.add(`${local}.Match`));
      else if (b.name === "Show" || b.name === "Match") shows.add(local);
    }
  // The jsx calls whose type is a component.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!helpers.has(tok.t) || tokens[i + 1]?.t !== "(" || tokens[i - 1]?.t === ".") continue;
    const open = tokens[i + 1]!,
      close = tokens[m[i + 1]!]!;
    const [type, props] = splitAt(src, open.e, close.s);
    if (type === undefined || type[0].startsWith('"')) continue;
    const t = type[0];
    const dot = /^([\w$]+)\.([\w$]+)$/.exec(t);
    // The type's name is a use as a component, not as a value.
    skip.add(i + 2);

    if ((fors.has(t) || shows.has(t)) && props !== undefined) {
      const row = rowOf(src, props, fors.has(t) ? "each" : "when", found);
      if (row !== null) rows.push(row);
    }
    if (FRAGMENT.test(t) || flow.has(t) || (dot !== null && flow.has(dot[1] + ".*") && FLOW.has(dot[2]!))) continue;
    const target: Target = /^[\w$]+$/.test(t) ? { local: t } : dot !== null ? { ns: dot[1]!, member: dot[2]! } : null;
    const scope = scopeAt(defs, tok.s),
      here = rootsAt(tok.s);
    const used: [string, PropUse][] = [];
    let spread = false;
    // The components whose props object a spread passes on whole (`{...props}`), or null when a
    // spread (or a computed key) passes what the scan cannot see into.
    let spreads: Def[] | null = [];
    const spreadOf = (e: string) => {
      spread = true;
      const r = /^[A-Za-z_$][\w$]*$/.test(e) ? propReads(e, scope, helpers) : [];
      if (spreads !== null && r.length === 1 && r[0]![1] === true) spreads.push(r[0]![0]);
      else spreads = null;
    };
    const p = props?.[0] ?? "";
    if (!p.startsWith("{")) spreadOf(p.trim());
    else
      for (const [part] of splitAt(p, 1, p.length - 1)) {
        if (part.startsWith("...")) {
          spreadOf(part.slice(3).trim());
          continue;
        }
        const colon = until(part, 0, ":");
        const key = part.slice(0, colon).trim();
        if (key.startsWith("[")) [spread, spreads] = [true, null];
        else {
          const use = propUse(colon < part.length ? part.slice(colon + 1).trim() : part, helpers, scope, here);
          const u = use.stores === undefined ? null : under(use.stores, tok.s);
          used.push([
            /^["']/.test(key) ? unquote(key) : key,
            u === null ? use : { ...use, stores: u.roots, ...(u.reads.length > 0 ? { storeReads: u.reads } : {}) },
          ]);
        }
      }
    sites.push({ target, props: used, spread, spreads });
  }
  // Every other mention of a component or an import is a use as a value.
  const escapes = new Set<string>(),
    nsEscapes = new Map<string, Set<string> | true>();
  const named = new Set(defs.map((d) => d.name));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!,
      prev = tokens[i - 1]?.t;
    if (skip.has(i) || prev === ".") continue;
    // An object's key (`{ Card: 1 }`), not a use.
    if (tokens[i + 1]?.t === ":" && (prev === "{" || prev === ",")) continue;
    const b = imports.get(tok.t);
    if (b?.name === "*") {
      const member = tokens[i + 1]?.t === "." ? tokens[i + 2]?.t : undefined;
      const set = nsEscapes.get(tok.t);
      if (member === undefined) nsEscapes.set(tok.t, true);
      else if (set !== true) nsEscapes.set(tok.t, (set ?? new Set()).add(member));
    } else if (b !== undefined || named.has(tok.t)) escapes.add(tok.t);
  }
  return { defs, imports, exports, stars, specs, sites, escapes, nsEscapes, whole, opaque, stores, aliases, jsx };
}

/**
 * A <For>'s row over what may be a store, or a <Show>'s or <Match>'s child function of a `when`
 * that may be one (`key` names the prop): the parameter's name, where the function is in `src`,
 * and what the prop stands for (`found`, given its value and where it starts). Null when it
 * mentions no store root and reads no prop, or the function's parameter is not a plain name.
 */
function rowOf(
  src: string,
  [props, at]: readonly [string, number],
  key: "each" | "when",
  found: (each: string, at: number) => Alias,
): (Alias & { name: string; start: number; end: number }) | null {
  let each: readonly [string, number] | undefined, children: readonly [string, number] | undefined;
  // A <For>'s props are an object literal: JSX writes spread props as one too.
  for (const [part, pAt] of splitAt(src, at + 1, at + props.length - 1)) {
    const colon = until(part, 0, ":");
    const entry = colon < part.length ? trimAt(part.slice(colon + 1), pAt + colon + 1) : ([part, pAt] as const);
    const k = part.slice(0, colon).trim();
    if (k === key) each = entry;
    else if (k === "children") children = entry;
  }
  const param = children === undefined ? null : /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/.exec(children[0]);
  if (each === undefined || param === null) return null;
  const u = found(each[0], each[1]);
  return u.roots.length === 0 && u.reads.length === 0
    ? null
    : { ...u, name: param[1]!, start: children![1], end: children![1] + children![0].length };
}

/**
 * The locals of a module whose value may hold a store (see `ModuleInfo.aliases`), given the
 * names that may hold one (`roots`): found until no more are.
 */
function aliasesIn(
  src: string,
  tokens: readonly Token[],
  m: Int32Array,
  defs: readonly Def[],
  roots: ReadonlySet<string>,
  helpers: ReadonlySet<string>,
  decls: readonly Bound[],
): Map<string, Alias> {
  const out = new Map<string, Alias>();
  // A component's pattern of props: each name it binds holds its prop.
  for (const d of defs)
    if (d.param.kind === "pattern")
      for (const [local, prop] of d.param.locals) out.set(local, { roots: [], reads: [[d, new Set([prop])]] });
  // What each value reads of props, and then, until no new local is found, what it mentions of the
  // names known to hold stores so far.
  const reads = decls.map((d) =>
    d.scope.length === 0 ? [] : propReads(src.slice(tokens[d.from]!.s, tokens[d.to - 1]!.e), d.scope, helpers),
  );
  for (let known = new Set([...roots, ...out.keys()]), base = out; ;) {
    const next = new Map(base);
    decls.forEach((d, k) => {
      const found = known.size === 0 ? [] : mentions(tokens, m, d.from, d.to, known, helpers, false);
      if (found.length === 0 && reads[k]!.length === 0) return;
      for (const n of d.names) {
        const a = next.get(n);
        next.set(
          n,
          a === undefined
            ? { roots: found, reads: reads[k]! }
            : { roots: [...new Set([...a.roots, ...found])], reads: a.reads.concat(reads[k]!) },
        );
      }
    });
    if ([...next.keys()].every((n) => known.has(n))) return next;
    known = new Set([...known, ...next.keys()]);
  }
}

/**
 * The locals of a module whose value may hold JSX (see `ModuleInfo.jsx`), given its bindings and
 * the names it imports (`imported`): found until no more are.
 */
function jsxIn(
  tokens: readonly Token[],
  m: Int32Array,
  decls: readonly Bound[],
  imported: ReadonlySet<string>,
  helpers: ReadonlySet<string>,
): Map<string, readonly string[] | true> {
  const out = new Map<string, readonly string[] | true>();
  // A value that holds a jsx call holds JSX; one that mentions such a local or an import may.
  const own = decls.map((d) => {
    for (let j = d.from; j < d.to; j++) if (helpers.has(tokens[j]!.t) && tokens[j + 1]?.t === "(") return true;
    return false;
  });
  decls.forEach((d, k) => {
    if (own[k]) for (const n of d.names) out.set(n, true);
  });
  for (let grew = true; grew;) {
    grew = false;
    const known = new Set([...imported, ...out.keys()]);
    decls.forEach((d, k) => {
      if (own[k]) return;
      const found = mentions(tokens, m, d.from, d.to, known, undefined, false);
      if (found.length === 0) return;
      for (const n of d.names) {
        const a = out.get(n);
        if (a === true) continue;
        const all = [...new Set([...(a ?? []), ...found])];
        if (all.length !== (a?.length ?? -1)) (out.set(n, all), (grew = true));
      }
    });
  }
  return out;
}

/** What comes before a module's first token: no token at all. */
const START: Token = { t: ";", s: 0, e: -1 };

/** A value bound to names: the names, its value's tokens [from, to), and the components it is in. */
interface Bound {
  readonly names: readonly string[];
  readonly from: number;
  readonly to: number;
  readonly scope: readonly Def[];
}

/**
 * Each value a module binds to names: a `=` (a declarator, an assignment, a pattern's), a `for
 * ... of`'s item, and a function declaration's name, whose value is its parameters and body.
 */
function boundIn(tokens: readonly Token[], m: Int32Array, defs: readonly Def[]): Bound[] {
  const decls: Bound[] = [];
  /** The end of the expression that starts at token k: a `,`, `;` or a closing bracket. */
  const end = (k: number): number => {
    while (k < tokens.length && !ENDS.has(tokens[k]!.t)) k = m[k]! > k ? m[k]! + 1 : k + 1;
    return k;
  };
  /** The names a binding's target ending at token j binds, and where it starts. */
  const target = (j: number): [string[], number] | null => {
    const t = tokens[j]!.t;
    if (t === "]" || t === "}") {
      const o = m[j]!;
      if (o < 0) return null;
      // `a[k] = ...` writes into `a`.
      const before = tokens[o - 1]?.t;
      if (t === "]" && (before === ")" || before === "]" || (isName(before) && !NOT_OBJECT.has(before))))
        return target(o - 1);
      // A pattern: its names, not its keys (`{ todos: list }`) or defaults (`{ a = b }`).
      const names: string[] = [];
      for (let k = o + 1; k < j; k++) {
        const n = tokens[k]!.t;
        if (n === "=") k = end(k + 1) - 1;
        else if (isName(n) && tokens[k + 1]?.t !== ":") names.push(n);
      }
      return [names, o];
    }
    if (!isName(t)) return null;
    // `a.b.c = ...` and `a[k].c = ...` write into `a`.
    if (tokens[j - 1]?.t === ".") return isName(tokens[j - 2]?.t) || tokens[j - 2]?.t === "]" ? target(j - 2) : null;
    return NOT_OBJECT.has(t) ? null : [[t], j];
  };
  /** A binding whose target ends at token j and whose value is tokens [from, to), written at `s`. */
  const add = (j: number, from: number, to: number, s?: number) => {
    const at = target(j);
    if (at === null || at[0].length === 0 || to <= from) return;
    s ??= tokens[at[1]]!.s;
    decls.push({ names: at[0], from, to, scope: defs.filter((d) => d.start < s && s < d.end) });
  };
  // From the first token, which may be a function declaration's `function`.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!,
      prev = tokens[i - 1] ?? START,
      next = tokens[i + 1];
    if (tok.t === "=") {
      // `=` alone: not `==`, `=>`, `+=` and the like, whose value is not the target's.
      const joined = (a: Token, b: Token) => a.e === b.s;
      if (next !== undefined && joined(tok, next) && (next.t === "=" || next.t === ">")) continue;
      if (joined(prev, tok) && "=!<>+-*/%&|^?~".includes(prev.t)) continue;
      add(i - 1, i + 1, end(i + 1));
    } else if (
      tok.t === "of" &&
      (prev.t === "]" || prev.t === "}" || (isName(prev.t) && ["const", "let", "var", "("].includes(tokens[i - 2]!.t)))
    ) {
      // `for (const t of store.todos)`: each item.
      add(i - 1, i + 1, end(i + 1));
    } else if (tok.t === "function" && prev.t !== "." && isName(next?.t)) {
      // `function useTodos() { return store; }`: what it returns. A component's own props are not
      // around it.
      const j = i + 2;
      if (tokens[j]?.t === "(" && tokens[m[j]! + 1]?.t === "{") add(i + 1, j, m[m[j]! + 1]! + 1, tok.s);
    }
  }
  return decls;
}

/** A module's own stores, and the locals (`aliases`) those alone make stores. */
function ownStores(own: ReadonlySet<string>, aliases: ReadonlyMap<string, Alias>): Set<string> {
  const out = new Set(own);
  for (let grew = true; grew;) {
    grew = false;
    for (const [n, a] of aliases) if (!out.has(n) && a.roots.some((r) => out.has(r))) (out.add(n), (grew = true));
  }
  return out;
}

// #endregion

// #region Programs

/**
 * Where a specifier leads: a module of the program (its file), `false` for a module outside it (a
 * package, a file the program does not compile), or null when it cannot be known, which makes the
 * program give up.
 */
export type Resolved = string | false | null;

/** A program: modules linked by their imports, and the facts of each. */
export class Program {
  /** Each module's scan, its code, and where its specifiers lead. */
  private readonly modules = new Map<
    string,
    { readonly js: string; readonly info: ModuleInfo; readonly resolved: ReadonlyMap<string, Resolved> }
  >();
  /** The modules whose exports anyone may call: the build's entries. */
  private readonly entries: Set<string>;
  /** Each component's reactive props, computed when first asked for; null when stale. */
  private facts: Map<Def, Props> | null = null;
  /** The props each component may be passed a store in, as `solve` finds them (`storeOf`). */
  private stored = new Map<Def, Props>();
  /** The props other than children each component may be passed JSX in (`contentOf`). */
  private content = new Map<Def, Props>();
  /** The facts each compiled module was given, to check that later modules leave them true. */
  private readonly given = new Map<string, PropFacts>();

  constructor(entries: Iterable<string>) {
    this.entries = new Set(entries);
  }

  /** Whether `file` is a module of the program, with the code `js`. */
  has(file: string, js?: string): boolean {
    const mod = this.modules.get(file);
    return mod !== undefined && (js === undefined || mod.js === js);
  }

  /** Add (or replace) a module, with where each of its specifiers leads. */
  add(file: string, js: string, resolved: ReadonlyMap<string, Resolved>, info: ModuleInfo = scanModule(js)): void {
    this.modules.set(file, { js, info, resolved });
    this.facts = null;
    // A module replaced is compiled again, with the facts it is given then.
    this.given.delete(file);
  }

  /** The module's scan, if the program has it. */
  info(file: string): ModuleInfo | undefined {
    return this.modules.get(file)?.info;
  }

  /** Whether the program can see its whole graph: no module is opaque and every specifier is known. */
  get complete(): boolean {
    for (const { info, resolved } of this.modules.values()) {
      if (info.opaque) return false;
      for (const r of resolved.values()) if (r === null) return false;
    }
    return true;
  }

  /**
   * The facts of module `file`, by its components' names, recorded as given: a later `add` that
   * would make them false throws (see `check`).
   */
  factsOf(file: string): PropFacts {
    const facts = this.solve(),
      out = new Map<string, Set<string> | true>(),
      storeProps = new Map<string, Set<string> | true>(),
      contentProps = new Map<string, Set<string> | true>();
    const mod = this.modules.get(file);
    for (const d of mod?.info.defs ?? []) {
      out.set(d.name, union(out.get(d.name), facts.get(d)!));
      for (const [into, s] of [
        [storeProps, this.storeOf(d)],
        [contentProps, this.contentOf(d)],
      ] as const)
        if (s === true || s.size > 0) into.set(d.name, union(into.get(d.name), s));
    }
    this.given.set(file, out);
    // The module's store roots: its own, the stores it imports, what it imports from where the
    // program cannot see (`unseen`), which may be one, and its locals made of a store or of a prop
    // that some call site passes one (`ModuleInfo.aliases`).
    const stores = new Set(mod?.info.stores);
    for (const [local, b] of mod?.info.imports ?? []) {
      const target = mod!.resolved.get(b.spec);
      if (b.name !== "*") {
        if (unseen(b.spec, target) || this.storeExport(target, b.name)) stores.add(local);
      } else if (unseen(b.spec, target)) stores.add(`${local}.*`);
      else for (const k of this.exportNames(target)) if (this.storeExport(target, k)) stores.add(`${local}.${k}`);
    }
    for (const n of mod?.info.aliases.keys() ?? []) if (!stores.has(n) && this.storeIn(file, n)) stores.add(n);
    // What the module reads JSX by: its locals made of JSX, its imports from the app's own files,
    // which it sees as a file alone does, and its other imports of JSX from the program.
    const jsx = new Set<string>();
    for (const n of mod?.info.jsx.keys() ?? []) if (this.jsxIn(file, n)) jsx.add(n);
    for (const [local, b] of mod?.info.imports ?? []) {
      const target = mod!.resolved.get(b.spec);
      if (ownFile(b.spec)) jsx.add(b.name === "*" ? `${local}.*` : local);
      else if (b.name !== "*") {
        if (this.jsxExport(target, b.name)) jsx.add(local);
      } else for (const k of this.exportNames(target)) if (this.jsxExport(target, k)) jsx.add(`${local}.${k}`);
    }
    return Object.assign(
      out,
      { jsx },
      stores.size === 0 ? {} : { stores },
      storeProps.size === 0 ? {} : { storeProps },
      contentProps.size === 0 ? {} : { contentProps },
    );
  }

  /**
   * Check that every module compiled so far was given facts that still hold: each component's
   * reactive props, and the props it may be passed a store or JSX in, are among those it was
   * given.
   *
   * @returns The first component that now takes a reactive prop (or a store, or JSX) it was
   *   compiled without, or null.
   */
  check(): { file: string; component: string; prop: string } | null {
    const facts = this.solve();
    for (const [file, given] of this.given) {
      for (const d of this.modules.get(file)!.info.defs) {
        const kinds = [
          [facts.get(d)!, given.get(d.name)!, ""],
          [this.storeOf(d), given.storeProps?.get(d.name), " (a store)"],
          [this.contentOf(d), given.contentProps?.get(d.name), " (JSX)"],
        ] as const;
        for (const [now, was, what] of kinds) {
          if (was === true) continue;
          if (now === true) return { file, component: d.name, prop: `(every prop)${what}` };
          for (const k of now) if (was?.has(k) !== true) return { file, component: d.name, prop: k + what };
        }
      }
    }
    return null;
  }

  /**
   * The props component `d` may be passed a store in, as far as `solve` has found them: those its
   * call sites pass one, or every prop (true) for a component whose callers cannot all be seen,
   * which may be passed anything (see the module's comment).
   */
  private storeOf(d: Def): Props {
    return this.stored.get(d) ?? NO_PROPS;
  }

  /** The props other than children that component `d` may be passed JSX in: as `storeOf`. */
  private contentOf(d: Def): Props {
    return this.content.get(d) ?? NO_PROPS;
  }

  /** Each component's reactive props: what escapes is true, and call sites add the rest. */
  private solve(): Map<Def, Props> {
    if (this.facts !== null) return this.facts;
    const facts = new Map<Def, Props>();
    // The props each component may be passed a store or JSX in, found with the reactive ones.
    this.stored = new Map();
    this.content = new Map();
    // A component whose callers cannot all be seen may be passed anything: every prop is reactive,
    // and may hold a store or JSX.
    const all = (ds: Iterable<Def>) => {
      for (const d of ds) (facts.set(d, true), this.stored.set(d, true), this.content.set(d, true));
    };
    for (const { info } of this.modules.values())
      for (const d of info.defs) d.open ? all([d]) : facts.set(d, new Set());
    for (const [file, { info, resolved }] of this.modules) {
      if (this.entries.has(file)) all(this.exported(file));
      for (const n of info.escapes) all(this.local(file, n));
      for (const [ns, members] of info.nsEscapes) {
        const target = resolved.get(info.imports.get(ns)!.spec);
        if (members === true) all(this.exported(target));
        else for (const k of members) all(this.export(target, k));
      }
      for (const spec of info.whole) all(this.exported(resolved.get(spec)));
    }
    // Call sites, until nothing changes: a prop read of a component passed on to another is
    // reactive when the first component's prop is.
    for (let changed = true; changed;) {
      changed = false;
      for (const [file, { info, resolved }] of this.modules) {
        for (const site of info.sites) {
          const t = site.target;
          const targets =
            t === null
              ? []
              : "local" in t
                ? this.local(file, t.local)
                : info.imports.get(t.ns)?.name === "*"
                  ? this.export(resolved.get(info.imports.get(t.ns)!.spec), t.member)
                  : [];
          for (const d of targets) {
            if (site.spread) {
              if (facts.get(d) !== true) (facts.set(d, true), (changed = true));
              // A spread passes on the stores and JSX the props it spreads may hold; what the scan
              // cannot see into may hold any.
              for (const map of [this.stored, this.content])
                if (site.spreads === null) changed = widen(map, d, true) || changed;
                else for (const o of site.spreads) changed = widen(map, d, map.get(o) ?? NO_PROPS) || changed;
            }
            const f = facts.get(d)!;
            for (const [k, use] of site.props) {
              // A store, a store's member or item, or a prop that may be one: reactive, and a store
              // in the component too.
              const store =
                (use.stores?.some((n) => this.storeIn(file, n)) ?? false) ||
                use.reads.some(([o, r]) => touches(this.storeOf(o), r)) ||
                (use.storeReads?.some(([o, r]) => touches(this.storeOf(o), r)) ?? false);
              if (store) changed = widen(this.stored, d, new Set([k])) || changed;
              // JSX, or a prop that may hold it, passed on: content, as children are.
              const content =
                k !== "children" && (use.lazy || use.reads.some(([o, r]) => touches(this.contentOf(o), r)));
              if (content) changed = widen(this.content, d, new Set([k])) || changed;
              const changes = store || use.calls || use.reads.some(([o, r]) => touches(facts.get(o)!, r));
              if (f === true || f.has(k) || !changes) continue;
              f.add(k);
              changed = true;
            }
          }
        }
      }
    }
    return (this.facts = facts);
  }

  /** The components a local name of module `file` refers to: its own, or an import's. */
  private local(file: string, name: string): Def[] {
    const mod = this.modules.get(file)!;
    const own = mod.info.defs.filter((d) => d.name === name);
    const b = mod.info.imports.get(name);
    return b === undefined || b.name === "*" ? own : own.concat(this.export(mod.resolved.get(b.spec), b.name));
  }

  /** The components export `name` of module `file` refers to, through re-exports. */
  private export(file: Resolved | undefined, name: string, seen = new Set<string>()): Def[] {
    if (typeof file !== "string" || seen.has(file + "\0" + name)) return [];
    seen.add(file + "\0" + name);
    const mod = this.modules.get(file);
    if (mod === undefined) return [];
    const e = mod.info.exports.get(name);
    if (e !== undefined)
      return "local" in e ? this.local(file, e.local) : this.export(mod.resolved.get(e.spec), e.name, seen);
    if (name === "default") return [];
    return mod.info.stars.flatMap((s) => this.export(mod.resolved.get(s), name, seen));
  }

  /**
   * Whether `name` holds a store in module `file`: one of its own roots, an import of a store,
   * (`ns.member`) a namespace import's member that is one, or a local made of one, or of a prop
   * that may be passed one (`ModuleInfo.aliases`).
   */
  private storeIn(file: string, name: string, seen = new Set<string>()): boolean {
    const mod = this.modules.get(file)!;
    const dot = name.indexOf(".");
    if (dot < 0 && mod.info.stores.has(name)) return true;
    const alias = dot < 0 ? mod.info.aliases.get(name) : undefined;
    if (alias !== undefined && !seen.has(`\0${file}\0${name}`)) {
      seen.add(`\0${file}\0${name}`);
      if (
        alias.reads.some(([o, r]) => touches(this.storeOf(o), r)) ||
        alias.roots.some((n) => this.storeIn(file, n, seen))
      )
        return true;
    }
    const b = mod.info.imports.get(dot < 0 ? name : name.slice(0, dot));
    // `ns.member` is a namespace import's member; a plain name, any other import.
    if (b === undefined || (b.name === "*") !== dot >= 0) return false;
    const target = mod.resolved.get(b.spec);
    return unseen(b.spec, target) || this.storeExport(target, dot < 0 ? b.name : name.slice(dot + 1), seen);
  }

  /** Whether export `name` of module `file` is a store, through re-exports. */
  private storeExport(file: Resolved | undefined, name: string, seen = new Set<string>()): boolean {
    if (typeof file !== "string" || seen.has(file + "\0" + name)) return false;
    seen.add(file + "\0" + name);
    const mod = this.modules.get(file);
    if (mod === undefined) return false;
    const e = mod.info.exports.get(name);
    if (e !== undefined)
      return "local" in e
        ? this.storeIn(file, e.local, seen)
        : this.storeExport(mod.resolved.get(e.spec), e.name, seen);
    return name !== "default" && mod.info.stars.some((s) => this.storeExport(mod.resolved.get(s), name, seen));
  }

  /**
   * Whether `name` may hold JSX in module `file`: a local made of a jsx call or of what holds JSX
   * (`ModuleInfo.jsx`), or an import of such a value from a module of the program (`ns.member`, a
   * namespace import's). In the module asked about (`top`), an import from the app's own files
   * (`ownFile`) may, as the module alone sees it, whatever the program sees: a dev server and a
   * build compile its holes alike. An import the program cannot see is not known to: a hole that
   * reads it stays text, which the development build checks (`NODE_AS_TEXT`).
   */
  private jsxIn(file: string, name: string, seen = new Set<string>(), top = true): boolean {
    const mod = this.modules.get(file)!;
    const dot = name.indexOf(".");
    const own = dot < 0 ? mod.info.jsx.get(name) : undefined;
    if (own === true) return true;
    if (own !== undefined && !seen.has(`\0${file}\0${name}`)) {
      seen.add(`\0${file}\0${name}`);
      if (own.some((n) => this.jsxIn(file, n, seen, top))) return true;
    }
    const b = mod.info.imports.get(dot < 0 ? name : name.slice(0, dot));
    if (b === undefined || (b.name === "*") !== dot >= 0) return false;
    if (top && ownFile(b.spec)) return true;
    return this.jsxExport(mod.resolved.get(b.spec), dot < 0 ? b.name : name.slice(dot + 1), seen);
  }

  /** Whether export `name` of module `file` may hold JSX, through re-exports. */
  private jsxExport(file: Resolved | undefined, name: string, seen = new Set<string>()): boolean {
    if (typeof file !== "string" || seen.has(file + "\0" + name)) return false;
    seen.add(file + "\0" + name);
    const mod = this.modules.get(file);
    if (mod === undefined) return false;
    const e = mod.info.exports.get(name);
    if (e !== undefined)
      return "local" in e
        ? this.jsxIn(file, e.local, seen, false)
        : this.jsxExport(mod.resolved.get(e.spec), e.name, seen);
    return name !== "default" && mod.info.stars.some((s) => this.jsxExport(mod.resolved.get(s), name, seen));
  }

  /** The names module `file` exports, through `export *` (which passes on all but the default). */
  private exportNames(file: Resolved | undefined, seen = new Set<string>(), star = false): string[] {
    if (typeof file !== "string" || seen.has(file)) return [];
    seen.add(file);
    const mod = this.modules.get(file);
    if (mod === undefined) return [];
    return [...mod.info.exports.keys()]
      .filter((k) => !star || k !== "default")
      .concat(mod.info.stars.flatMap((s) => this.exportNames(mod.resolved.get(s), seen, true)));
  }

  /**
   * Every component module `file` exports, through re-exports; with `star`, as `export *` passes
   * them on, without the default export.
   */
  private exported(file: Resolved | undefined, seen = new Set<string>(), star = false): Def[] {
    if (typeof file !== "string" || seen.has(file)) return [];
    seen.add(file);
    const mod = this.modules.get(file);
    if (mod === undefined) return [];
    return [...mod.info.exports.keys()]
      .filter((k) => !star || k !== "default")
      .flatMap((k) => this.export(file, k))
      .concat(mod.info.stars.flatMap((s) => this.exported(mod.resolved.get(s), seen, true)));
  }
}

/** Add props `add` to what `map` holds for `d`. @returns Whether that changed it. */
function widen(map: Map<Def, Props>, d: Def, add: Props): boolean {
  const cur = map.get(d);
  if (cur === true) return false;
  if (add === true) return (map.set(d, true), true);
  const set = cur ?? new Set<string>(),
    size = set.size;
  for (const k of add) set.add(k);
  if (set.size === size) return false;
  map.set(d, set);
  return true;
}

/** Two facts as one. */
function union(a: Set<string> | true | undefined, b: Props): Set<string> | true {
  if (a === undefined) return b === true ? true : new Set(b);
  if (a === true || b === true) return true;
  for (const k of b) a.add(k);
  return a;
}

/**
 * The facts of one module seen alone, as `compileJs` gives them when it is not told: a component
 * the module exports or uses as a value is true, and one that is neither has all its callers here.
 * What it imports leads where it cannot know (null), so an import that may export a store
 * (`exportsStores`) is taken for one.
 */
export function moduleFacts(js: string, info: ModuleInfo = scanModule(js)): PropFacts {
  const p = new Program(["\0module"]);
  p.add("\0module", js, new Map(info.specs.map((s) => [s, null])), info);
  return p.factsOf("\0module");
}

/**
 * Whether module `spec` may export a store: any but @reactre's own (whose stores are made by
 * `createStore`, not exported) and an asset's (styles, data, media), which export none.
 */
function exportsStores(spec: string): boolean {
  return !spec.startsWith("@reactre/") && !ASSET.test(spec.replace(/[?#].*$/, ""));
}

/**
 * Whether module `spec` is one of the app's own files: one that may export a store
 * (`exportsStores`) and is not a package's. A package is named bare (`lib`, `lib/sub`,
 * `@scope/lib`) or with a scheme (`node:fs`, `virtual:x`); anything else is a path (`./x`, `/x`)
 * or an alias of one (`~/x`, `@/x`, `#x`, `$lib/x`). What it exports may hold JSX, alone and in a
 * whole program alike (`PropFacts.jsx`), as a file alone cannot see what it holds.
 */
function ownFile(spec: string): boolean {
  return exportsStores(spec) && !PACKAGE.test(spec);
}

/** A package's specifier: a bare name, scoped or not, and a subpath, or a scheme. */
const PACKAGE = /^(?:@[\w-][\w.-]*\/)?[\w-][\w.-]*(?:\/|$)|^[a-z][\w+.-]*:/i;

/**
 * Whether module `spec`, which leads to `to`, may export a store the program cannot see: one it
 * cannot place (null: a file seen alone), or a package outside it (false, for a bare specifier),
 * that may export stores at all. A module of the program is seen, and judged by its code; so is a
 * relative specifier that leads outside it (an asset, a file the build leaves out).
 */
function unseen(spec: string, to: Resolved | undefined): boolean {
  if (typeof to === "string" || !exportsStores(spec)) return false;
  return to !== false || !/^[./]/.test(spec);
}

// #endregion

// #region Reading a build

/** How a build reads its modules: its bundler's resolver, and the transpiler the compiler reads. */
export interface Host {
  /**
   * Where `spec`, imported by `importer`, leads: an absolute path (a query or hash after it is
   * ignored), false for a module the build does not bundle (external, or not found), or null when
   * it cannot be known (a virtual module), which makes the program give up.
   */
  resolve(spec: string, importer: string): Resolved | Promise<Resolved>;
  /** A script's JavaScript, TypeScript and JSX stripped, as `compileJs` reads it. */
  transpile(file: string, source: string): string;
  /** A file's text; by default, read from disk. */
  read?(file: string): string | Promise<string>;
}

/**
 * Whether `spec` is one of a Bun build's `external` patterns (a name, its subpaths, or a pattern
 * with `*`): a module Bun leaves to the runtime. Bun's resolver cannot tell another plugin's
 * virtual module from a missing one, so a specifier it cannot resolve is known to be outside the
 * program only when the build names it external; any other is unknown (null), and the program
 * gives up, as for a virtual module elsewhere.
 */
export function isExternal(spec: string, external: readonly string[] = []): boolean {
  return external.some((p) => p === spec || spec.startsWith(p + "/") || (p.includes("*") && glob(p).test(spec)));
}

/** A pattern with `*` (any characters) as a regular expression. */
const glob = (p: string): RegExp => new RegExp(`^${p.split("*").map(escape).join(".*")}$`);
const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Scripts, read for what they import and call. */
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
/** Files that import no modules: styles, data, images, fonts, media. */
const ASSET =
  /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|json|json5|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|eot|ttf|otf|mp4|webm|ogg|mp3|wav|flac|aac|txt|wasm)$/;

/**
 * Read a build's program from its entries, following every import the resolver places among the
 * app's own files (not node_modules). An HTML entry's module scripts are its imports.
 *
 * @returns The program, or null when it cannot see its whole graph (see `Program.complete`).
 */
export async function analyze(entries: readonly string[], host: Host): Promise<Program | null> {
  const program = new Program(entries);
  return (await walk(program, entries, host)) ? program : null;
}

/**
 * Add `files` and every module they reach that `program` does not have yet.
 *
 * @param code Each file's JavaScript when already known (a module the bundler gave the plugin).
 * @returns Whether the program can still see its whole graph.
 */
export async function walk(
  program: Program,
  files: readonly string[],
  host: Host,
  code: ReadonlyMap<string, string> = new Map(),
): Promise<boolean> {
  const read = host.read ?? ((f: string) => readFileSync(f, "utf8"));
  const queue = [...files];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (program.has(file) && !code.has(file)) continue;
    let js: string;
    try {
      js =
        code.get(file) ??
        (file.endsWith(".html") ? htmlScripts(file, await read(file)) : host.transpile(file, await read(file)));
    } catch {
      return false;
    }
    const info = scanModule(js),
      resolved = new Map<string, Resolved>();
    for (const spec of info.specs) {
      const r = await host.resolve(spec, file);
      const path = typeof r === "string" ? r.replace(/[?#].*$/, "") : r;
      let to: Resolved;
      if (typeof path !== "string") to = path;
      else if (/[\\/]node_modules[\\/]/.test(path)) to = false;
      else if (!isAbsolute(path) || !existsSync(path)) to = null;
      else if (SCRIPT.test(path) || path.endsWith(".html")) to = path;
      else to = ASSET.test(path) ? false : null;
      resolved.set(spec, to);
      if (typeof to === "string" && !program.has(to)) queue.push(to);
    }
    program.add(file, js, resolved, info);
  }
  return program.complete;
}

/** An HTML page's module scripts, as a module that imports each (`src`) or holds it (inline). */
function htmlScripts(file: string, html: string): string {
  let js = "";
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    if (src === undefined) js += m[2] + "\n;\n";
    else js += `import ${JSON.stringify(src.startsWith("/") ? src : join(dirname(file), src))};\n`;
  }
  return js;
}

// #endregion

// #region @reactre/core's async runtime

// @reactre/core keeps the code its async feature modules (features/async, features/actions) need
// between `// #if ASYNC` markers in src/index.ts, and its development diagnostics between
// `// #if DEV` markers. Its default build (dist/index.js) has both stripped, dist/async/index.js
// keeps the async code, and dist/dev/index.js keeps both; the `"development"` export condition
// resolves the last, and the sources (the `bun` and `"reactre-source"` conditions) hold both. A
// build that reads its program knows whether some module imports either feature module: if none
// does, the app gets the core without that code, whatever the conditions resolved; and a
// production build gets no diagnostics, a dev server the development build (`coreRuntime`).
// features/memo has development and type blocks of its own, and a development build
// (dist/dev/features/memo.js), picked the same way. @reactre/plugin does this for every bundler,
// the compiler's Bun plugin for Bun.build.

/** The specifiers of @reactre/core's async feature modules. */
const ASYNC_FEATURE: RegExp = /^@reactre\/core\/features\/(?:async|actions)$/;

/**
 * The files of @reactre/core that hold or need its async runtime, by path: its three builds, its
 * source index.ts, and its async feature modules, built or source; and the feature modules whose
 * sources have development blocks too, and whose builds have a development one (`MEMO_FILE`).
 */
export const CORE_RUNTIME: RegExp =
  /[\\/]core[\\/](?:dist[\\/](?:(?:async|dev)[\\/])?index\.js|src[\\/](?:index|server)\.ts|(?:dist|src)[\\/]features[\\/](?:async|actions|memo|hydrate|owner|context|errors|timing|reaction|effects)\.[jt]s|dist[\\/]dev[\\/]features[\\/](?:memo|hydrate|owner|context|errors|timing|reaction|effects)\.js|dist[\\/](?:dev[\\/])?server\.js)$/;

/** Of those, the server entry (@reactre/core/server): its source, its build, and its development build. */
const SERVER_FILE: RegExp = /[\\/](?:src|dist(?:[\\/]dev)?)[\\/]server\.[jt]s$/;

/** Of those, the feature modules. */
const ASYNC_FEATURE_FILE: RegExp = /[\\/]features[\\/](?:async|actions)\.[jt]s$/;

/**
 * Of those, the feature modules with development blocks of their own (the core's `DEV_FEATURES`):
 * features/memo, features/hydrate, and those with Solid 2.0's development messages and misuse
 * errors (owner, context, errors, timing, reaction, effects). Each one's source, build, and
 * development build.
 */
const MEMO_FILE: RegExp = /[\\/]features[\\/](memo|hydrate|owner|context|errors|timing|reaction|effects)\.[jt]s$/;

/** Of those, the source index.ts. */
const CORE_SOURCE: RegExp = /[\\/]src[\\/]index\.ts$/;

/** Whether file `path` (a `CORE_RUNTIME` one) is @reactre/core's: its package is named so. By package, cached. */
const cores = new Map<string, boolean>();
export function isCore(path: string): boolean {
  const dir = path.slice(
    0,
    path.search(/[\\/](?:dist|src)[\\/](?:(?:async|dev)[\\/])?(?:index\.[jt]s|server\.[jt]s|features[\\/])/),
  );
  let r = cores.get(dir);
  if (r === undefined) {
    try {
      r = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === "@reactre/core";
    } catch {
      r = false;
    }
    cores.set(dir, r);
  }
  return r;
}

/**
 * `host`, noting in `seen` whether a module of the program imports @reactre/core's async feature
 * modules, by name or by a path its resolver gives (an alias, a workspace's sources).
 */
export function noticingAsync(host: Host, seen: { async: boolean }): Host {
  return {
    ...host,
    resolve: async (spec, importer) => {
      const r = await host.resolve(spec, importer);
      if (ASYNC_FEATURE.test(spec) || (typeof r === "string" && ASYNC_FEATURE_FILE.test(r) && isCore(r))) {
        seen.async = true;
      }
      return r;
    },
  };
}

/**
 * The code of @reactre/core's source index.ts at `path` (which `read` gives) without its blocks
 * named `names`, as the package's builds compile it: with the stripper the package ships beside
 * it (src/withoutAsync.ts), so the markers are read by the version of the core that wrote them. A
 * core without one has no markers; one whose stripper knows only async blocks (`stripAsync`) has
 * no others. Null: the file as it is, where nothing is to be stripped.
 */
async function stripCore(
  path: string,
  read: () => string | Promise<string>,
  names: string[],
  stripper = join(dirname(path), "withoutAsync.ts"),
): Promise<string | null> {
  const async = names.includes("ASYNC");
  if (!existsSync(stripper)) return async ? read() : null;
  const m = (await import(pathToFileURL(stripper).href)) as {
    stripAsync(source: string): string;
    strip?(source: string, names: readonly string[]): string;
  };
  if (m.strip !== undefined) return m.strip(await read(), names);
  return async ? m.stripAsync(await read()) : null;
}

/** @reactre/core's builds, by the path of each from dist/. */
const BUILDS = { default: "index.js", async: "async/index.js", dev: "dev/index.js" } as const;

/**
 * What a build loads for file `path` of @reactre/core (a `CORE_RUNTIME` one, whose code `read`
 * gives), so every module of the app shares one core: the development build (`dev`), else the
 * async build where the build gets the core's async runtime (`on`), else the default build. A
 * build that is not the one becomes its re-export; the source index.ts is loaded stripped as
 * that build is made (`stripCore`), or as it is for the development build; an async feature
 * module, as it is. features/memo and features/hydrate are each its source stripped of its
 * development and type blocks, or as it is for a dev server; its build, the one of its two
 * (dist/features/memo.js, and dist/dev/features/memo.js with the checks) the build gets. Null:
 * the file as it is.
 *
 * @param forced Whether `on` is the plugin's `async` option, not what the program imports.
 * @param dev Whether the build is a dev server's, which gets the development build; else
 *   (the default) it is a production build, which gets neither of the core's development
 *   blocks, whatever the bundler's conditions resolved: a `"development"` condition holds in
 *   builds too (Bun.build's outside production, Vite's where NODE_ENV is not "production").
 * @throws Error for an async feature module where `on` is false, naming the option.
 */
export async function coreRuntime(
  path: string,
  read: () => string | Promise<string>,
  on: boolean,
  forced: boolean,
  dev = false,
): Promise<string | null> {
  if (CORE_SOURCE.test(path))
    return dev ? null : stripCore(path, read, on ? ["DEV", "TYPES"] : ["ASYNC", "DEV", "TYPES"]);
  if (SERVER_FILE.test(path)) {
    // The server's development block (the error an <Errored>'s marker names): its development
    // build's, or none.
    if (path.endsWith(".ts")) return dev ? null : stripCore(path, read, ["DEV", "TYPES"]);
    const isDev = /[\\/]dev[\\/]server\.js$/.test(path);
    const other = isDev ? "../server.js" : "./dev/server.js";
    // A core built before the server's development build existed has the one build.
    return isDev === dev || !existsSync(join(dirname(path), other)) ? null : `export * from "${other}";\n`;
  }
  const feature = MEMO_FILE.exec(path);
  if (feature !== null) {
    if (path.endsWith(".ts"))
      return dev ? null : stripCore(path, read, ["DEV", "TYPES"], join(dirname(path), "..", "withoutAsync.ts"));
    const isDev = /[\\/]dev[\\/]features[\\/]/.test(path);
    const other = `${isDev ? "../../" : "../dev/"}features/${feature[1]}.js`;
    // A core built before the module's development build existed has the one build.
    return isDev === dev || !existsSync(join(dirname(path), other)) ? null : `export * from "${other}";\n`;
  }
  if (!ASYNC_FEATURE_FILE.test(path)) {
    const is = /[\\/]dev[\\/]index\.js$/.test(path)
      ? "dev"
      : /[\\/]async[\\/]index\.js$/.test(path)
        ? "async"
        : "default";
    const want = dev ? "dev" : on ? "async" : "default";
    return is === want ? null : `export * from "${is === "default" ? "./" : "../"}${BUILDS[want]}";\n`;
  }
  if (on) return null;
  throw new Error(
    `reactre: ${path} needs @reactre/core's async runtime, and this build has its default build: ` +
      (forced
        ? "the plugin's `async` option is false"
        : "the program read at the build's start imports neither @reactre/core/features/async nor /actions") +
      ". Import the module from one the program reaches, or set the plugin's `async` option to true.",
  );
}

// #endregion
