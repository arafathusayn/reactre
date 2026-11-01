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

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { isIdent, skipToken, splitAt, until } from "./scan.ts";

// #region Facts

/**
 * The props each component of a module may be passed reactively, by the component's name: a set
 * of prop names, or true for every prop (a component whose callers cannot all be seen). A
 * component that is not in the map is treated as true.
 */
export type PropFacts = ReadonlyMap<string, ReadonlySet<string> | true>;

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
 * Whether `expr` calls something when it is evaluated: a `(` after a name, a literal, `)` or `]`,
 * or `new`. A jsx call (one of `helpers`) is skipped whole, arguments included, and so is a
 * function literal's body, which runs only when the function is called.
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
 * calls nothing and reads no props. Otherwise it is a getter: `lazy` when it holds JSX (built when
 * the component reads it), `calls` when it calls something, and `reads` the props it reads of
 * each component around it, by the component's index in `scope`.
 */
export interface PropUse {
  readonly fn: boolean;
  readonly lazy: boolean;
  readonly calls: boolean;
  readonly reads: readonly (readonly [Def, Props])[];
}

/** A prop's use (see `PropUse`), for value `expr` written inside the components `scope`. */
export function propUse(expr: string, helpers: ReadonlySet<string>, scope: readonly Def[]): PropUse {
  if (isFunction(expr)) return { fn: true, lazy: false, calls: false, reads: [] };
  let lazy = false;
  for (const h of helpers) if (expr.includes(h + "(")) lazy = true;
  return { fn: false, lazy, calls: callsOutsideJsx(expr, helpers), reads: propReads(expr, scope, helpers) };
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
  const add = (name: string, fn: Fn, start: number, open: boolean, at: number) => {
    const param = paramOf(src, fn.params);
    const aliases = param.kind === "name" ? aliasesOf(src, fn.params[1], fn.end, param.name) : [];
    defs.push({ name, param, aliases, start, end: fn.end, open });
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
  return { defs, names };
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
}

/** The names Bun and the plugin give jsx, jsxs and jsxDEV, and Fragment. */
const HELPER = /^(jsxs|jsx|jsxDEV)_[a-z0-9]{8}$/,
  FRAGMENT = /^Fragment_[a-z0-9]{8}$/;

/** The control flow element names @reactre/core exports, which are not components. */
const FLOW = new Set(["For", "Show", "Switch", "Match", "Repeat", "Portal", "Dynamic"]);

/** A string literal's value: a specifier. */
const unquote = (lit: string): string => lit.slice(1, -1);

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

    if (FRAGMENT.test(t) || flow.has(t) || (dot !== null && flow.has(dot[1] + ".*") && FLOW.has(dot[2]!))) continue;
    const target: Target = /^[\w$]+$/.test(t) ? { local: t } : dot !== null ? { ns: dot[1]!, member: dot[2]! } : null;
    const scope = scopeAt(defs, tok.s);
    const used: [string, PropUse][] = [];
    let spread = false;
    const p = props?.[0] ?? "";
    if (!p.startsWith("{")) spread = true;
    else
      for (const [part] of splitAt(p, 1, p.length - 1)) {
        if (part.startsWith("...")) {
          spread = true;
          continue;
        }
        const colon = until(part, 0, ":");
        const key = part.slice(0, colon).trim();
        if (key.startsWith("[")) spread = true;
        else
          used.push([
            /^["']/.test(key) ? unquote(key) : key,
            propUse(colon < part.length ? part.slice(colon + 1).trim() : part, helpers, scope),
          ]);
      }
    sites.push({ target, props: used, spread });
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
  return { defs, imports, exports, stars, specs, sites, escapes, nsEscapes, whole, opaque };
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
      out = new Map<string, Set<string> | true>();
    for (const d of this.modules.get(file)?.info.defs ?? []) out.set(d.name, union(out.get(d.name), facts.get(d)!));
    this.given.set(file, out);
    return out;
  }

  /**
   * Check that every module compiled so far was given facts that still hold: each component's
   * reactive props are among those it was given.
   *
   * @returns The first component that now takes a reactive prop it was compiled without, or null.
   */
  check(): { file: string; component: string; prop: string } | null {
    const facts = this.solve();
    for (const [file, given] of this.given) {
      for (const d of this.modules.get(file)!.info.defs) {
        const was = given.get(d.name)!,
          now = facts.get(d)!;
        if (was === true) continue;
        if (now === true) return { file, component: d.name, prop: "(every prop)" };
        for (const k of now) if (!was.has(k)) return { file, component: d.name, prop: k };
      }
    }
    return null;
  }

  /** Each component's reactive props: what escapes is true, and call sites add the rest. */
  private solve(): Map<Def, Props> {
    if (this.facts !== null) return this.facts;
    const facts = new Map<Def, Props>();
    for (const { info } of this.modules.values()) for (const d of info.defs) facts.set(d, d.open ? true : new Set());
    const all = (ds: Iterable<Def>) => {
      for (const d of ds) facts.set(d, true);
    };
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
            const f = facts.get(d)!;
            if (f === true) continue;
            if (site.spread) {
              facts.set(d, true);
              changed = true;
              continue;
            }
            for (const [k, use] of site.props) {
              if (f.has(k) || !(use.calls || use.reads.some(([o, r]) => touches(facts.get(o)!, r)))) continue;
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
 */
export function moduleFacts(js: string, info: ModuleInfo = scanModule(js)): PropFacts {
  const p = new Program(["\0module"]);
  p.add("\0module", js, new Map(info.specs.map((s) => [s, false])), info);
  return p.factsOf("\0module");
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
