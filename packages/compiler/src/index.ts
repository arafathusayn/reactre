// @reactre/compiler: a Bun plugin that compiles reactre's TSX into templates
// and the code that keeps them up to date (the model is in reactre's src/index.ts).
//
// Bun transpiles each file (TypeScript stripped, JSX to the automatic
// runtime's `jsx(type, props, key)` calls). Every jsx call is then compiled:
//
//   - A host element tree becomes a @reactre/dom template, hoisted to
//     module scope, and an expression that clones it with the values of its
//     holes. A hole whose expression calls a function is bound (an effect
//     that rewrites it); an `on*` handler is added as a listener (one that
//     reads a signal and is not a function literal follows it); a child
//     that is a component, a `<For>` or an expression holding JSX is a slot.
//     `value`, `checked` and `selected` are set as properties, `style` takes
//     an object or a string, `ref` gets the element, spread props are applied
//     at runtime, and a template whose root is an SVG element is parsed as SVG.
//   - `<For each={rows} key={(r) => r.id}>{(row) => <tr .../>}</For>` becomes
//     a keyed list (`__for`) whose row template's holes are split by what
//     they read: the row only (written at creation, compared on update), or
//     a function call (re-run when what it read changes). Row handlers are
//     delegated to the list's parent. A row that holds more than host
//     elements and values (a component, a nested list, a JSX expression, a
//     property, a style, a ref or a spread) becomes a `__forMount` list, whose
//     rows own what those parts create; a row of host elements and values
//     compiles as before. A row whose reactive holes make two or more calls
//     with arguments may read two selector keys: the file imports
//     @reactre/core/features/selectors.
//   - A component element `<Button id="run" />` is the call `Button({ id: "run" })`,
//     made once (components run once in reactre).
//   - A fragment's children join the parent's template; a fragment that is
//     not a child of an element is an array of nodes (`__frag`).
//   - A key on an element outside a list rebuilds the element when the key
//     changes (a slot that reads the key); a key that calls nothing is ignored.
//
// Nothing is left to a JSX runtime: a construct the compiler does not handle
// (a `<For>` outside an element, a row that is not one element) is a compile
// error, with its source.
//
// Design decisions:
//   - The compiler reads Bun's output as text with the shared scanner (./scan.ts) instead of
//     parsing it. Bun has already resolved TypeScript, JSX whitespace and entities, so the jsx
//     calls are all that is left to find, and everything else is copied through unchanged.
//   - "Calls a function" is the whole test for a reactive hole: in reactre a signal is read by
//     calling it. The test is conservative: a call that reads no signal only costs an effect.
//   - Every name the output adds starts with `__rr`, so it cannot collide with the app's names.
//   - For a source map (`compileJsWithMap`), each piece of source carries where it starts in the
//     input, and the output marks each token it copies with its place (./map.ts). Without a map,
//     nothing is marked, so the code is the same either way.
//
//   Bun.build({ plugins: [reactreCompiler()], ... })

import type { BunPlugin } from "bun";

import { hasMarks, mark, type SourceMapV3, unmark } from "./map.ts";
import { isIdent, literal, NOT_LITERAL, skipToken, splitAt, trimAt, until } from "./scan.ts";

// #region Plugin

/** Options for the plugin. */
export interface ReactreCompilerOptions {
  /** Files to compile; default .jsx and .tsx outside node_modules. */
  readonly filter?: RegExp;
}

/**
 * The Bun plugin: compiles the app's TSX files. Files under node_modules are left to Bun, since
 * packages ship JavaScript built for their own runtime.
 *
 * @example
 *   await Bun.build({ entrypoints: ["./app/main.tsx"], outdir: "dist", plugins: [reactreCompiler()] });
 */
export function reactreCompiler(options: ReactreCompilerOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.[jt]sx$/;
  return {
    name: "@reactre/compiler",
    setup(build) {
      build.onLoad({ filter }, async ({ path }) => {
        if (path.includes("/node_modules/")) return undefined;
        const source = await Bun.file(path).text();
        // The output is plain JavaScript: TypeScript and JSX are already gone.
        return { contents: compileSource(source, path.endsWith(".tsx") ? "tsx" : "jsx"), loader: "js" };
      });
    },
  };
}

/**
 * Transpile one TSX (or JSX) source with Bun and compile its JSX.
 *
 * @returns JavaScript that imports what it needs from `@reactre/core` and no JSX runtime.
 * @throws ReactreCompileError for a construct the compiler does not handle.
 * @example
 *   const js = compileSource(`export const A = () => <p class="x">{count()}</p>;`);
 */
export function compileSource(source: string, loader: "jsx" | "tsx" = "tsx"): string {
  // jsxImportSource only names the runtime Bun would import; no runtime is imported, because every
  // jsx call is compiled away.
  const t = new Bun.Transpiler({
    loader,
    tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "@reactre/core" } },
  } as ConstructorParameters<typeof Bun.Transpiler>[0]);
  return compileJs(t.transformSync(source));
}

// #endregion

// #region Templates and holes

// Hole markers, as @reactre/dom's text(), cls(), attr() and slot() make them; 0 is untyped (an event).
const M_TEXT = -1,
  M_CLASS = -2,
  M_PROP = -3,
  M_ATTR = -4,
  M_SLOT = -5,
  M_EVENT = 0;

/** Elements that have no closing tag and take no children. */
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
/** React prop names whose attribute has another name. */
const ALIASES: Record<string, string> = { className: "class", htmlFor: "for" };
/** Props set as properties, not attributes, when their value is not a literal: what the user changes. */
const PROPERTIES = new Set(["value", "checked", "selected"]);
/**
 * Tags that exist only in SVG. A template whose root is one is parsed inside an `<svg>`, so it
 * gets the SVG namespace (`a`, `title`, `style` and `script` are HTML ones too, so they are not here).
 */
const SVG_TAGS = new Set(
  (
    "svg g defs use symbol circle ellipse line path polygon polyline rect text tspan textPath " +
    "linearGradient radialGradient stop clipPath mask pattern marker filter foreignObject image " +
    "animate animateMotion animateTransform set desc metadata switch view feBlend feColorMatrix " +
    "feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap " +
    "feDropShadow feFlood feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset " +
    "feSpecularLighting feTile feTurbulence"
  ).split(" "),
);

/** One jsx call's arguments, as source text. */
interface Call {
  /** The element type: a quoted tag name for a host element, else a component expression. */
  readonly type: string;
  /** The props object literal. */
  readonly props: string;
  /** The key argument, or undefined when there is none. */
  readonly key: string | undefined;
  /** Where type, props and key start in the input, for a source map; -1 when not known. */
  readonly typeAt: number;
  readonly propsAt: number;
  readonly keyAt: number;
}

/**
 * A place in a template that the clone fills, with the source expression that fills it, and
 * where that starts in the input (-1 when not known, or when `expr` is compiled already).
 */
type Hole = (
  | { readonly kind: "value"; readonly marker: number; readonly expr: string }
  | { readonly kind: "event"; readonly type: string; readonly expr: string }
  /** A property (`value`, `checked`, `selected`), which cloning does not copy: set after the clone. */
  | { readonly kind: "prop"; readonly expr: string }
  /** What a runtime helper applies to the element itself: a style, a ref or spread props. */
  | { readonly kind: "el"; readonly fn: "style" | "ref" | "spread"; readonly expr: string }
  | {
      readonly kind: "slot";
      readonly slot: "for" | "comp" | "expr";
      readonly expr: string;
      /** Whether the slot is its element's only child, so a list can own the element. */
      readonly only: boolean;
      /** A <For>'s key function (JSX passes `key` apart from the props), and where it starts. */
      readonly key?: string;
      readonly keyAt?: number;
    }
) & { readonly at: number };

/**
 * A template being built. Like a tagged template's parts, `strings` is the markup between holes,
 * so it always has one more entry than `holes`.
 */
interface Tree {
  readonly strings: string[];
  readonly holes: Hole[];
  /** Whether the root is an SVG element, so the markup is parsed inside an `<svg>`. */
  svg: boolean;
}

/** A compile error, pointing at the source it could not compile. */
export class ReactreCompileError extends Error {}

// #endregion

// #region Compiling a file

/**
 * Compile Bun's automatic-runtime output.
 *
 * @returns `js` unchanged when it has no jsx calls; otherwise the compiled code, with the runtime
 *   import and the hoisted templates before it.
 * @throws ReactreCompileError when a jsx or Fragment call is left after compiling (a fragment, or
 *   a call in a place the compiler does not reach).
 */
export function compileJs(js: string): string {
  return compile(js, false);
}

/**
 * `compileJs`, with a source map from the code back to `js`.
 *
 * @returns The code `compileJs` returns, and its map: null when `js` has no jsx calls (the code
 *   is `js`) or holds the characters the map's marks use (see ./map.ts).
 * @throws ReactreCompileError as `compileJs` does.
 */
export function compileJsWithMap(js: string): { code: string; map: SourceMapV3 | null } {
  if (hasMarks(js)) return { code: compileJs(js), map: null };
  const marked = compile(js, true);
  if (marked === js) return { code: js, map: null };
  return unmark(marked, js);
}

/** `compileJs`, with marks for a source map in the code when `map` is set. */
function compile(js: string, map: boolean): string {
  // Bun's transpiler names the runtime's helpers with a hash suffix (jsx_w77yafs4, ...); those
  // names are what the compiler looks for.
  const helpers = new Set<string>();
  for (const m of js.matchAll(/\b(jsxs|jsx|jsxDEV)_[a-z0-9]{8}\b/g)) helpers.add(m[0]);
  if (helpers.size === 0) return js;
  const fragments = new Set<string>();
  for (const m of js.matchAll(/\bFragment_[a-z0-9]{8}\b/g)) fragments.add(m[0]);
  const c = new Compiler(helpers, fragments, map);
  const body = c.rewrite(js, 0);
  // Nothing may fall back to a JSX runtime, since reactre has none.
  for (const m of body.matchAll(/\b(jsxs|jsx|jsxDEV|Fragment)_[a-z0-9]{8}\b/g)) {
    throw new ReactreCompileError(`reactre: ${m[1]} left uncompiled (in a place the compiler does not reach)`);
  }
  const code = c.templates.join("\n") + "\n" + body;
  // The helpers every file has imported since the start, then those newer constructs use, only
  // where used: a file without them compiles to the same code as before they existed.
  let names = `__template as __rrT, __for as __rrFor, __insert as __rrInsert, __bind as __rrBind, __slot as __rrSlot, untrack as __rrUntrack`;
  for (const [name, alias] of EXTRA_HELPERS)
    if (new RegExp(`\\b${alias}\\b`).test(code)) names += `, ${name} as ${alias}`;
  const features = c.selectors ? `import "@reactre/core/features/selectors";\n` : "";
  return `${features}import { ${names} } from "@reactre/core";\n` + code;
}

/** @reactre/core's helpers for the newer constructs, with their local names. */
const EXTRA_HELPERS: readonly (readonly [string, string])[] = [
  ["__forMount", "__rrForM"],
  ["__frag", "__rrFrag"],
  ["__apply", "__rrApply"],
  ["__spread", "__rrSpread"],
  ["__style", "__rrStyle"],
  ["__ref", "__rrRef"],
  ["__on", "__rrOn"],
];

/**
 * Compiles the jsx calls of one file. It collects the hoisted template declarations in
 * `templates` and returns the rewritten code from `rewrite`.
 */
class Compiler {
  /** The file's local names of jsx, jsxs and jsxDEV. */
  readonly helpers: Set<string>;
  /** The file's local names of Fragment. */
  readonly fragments: Set<string>;
  /** Module-scope template declarations, in the order they were made. */
  readonly templates: string[] = [];
  /** Whether a row may read several selector keys, so the file imports @reactre/core/features/selectors. */
  selectors = false;
  /** Whether the output carries marks for a source map (./map.ts). */
  readonly map: boolean;
  constructor(helpers: Set<string>, fragments: Set<string> = new Set(), map = false) {
    this.helpers = helpers;
    this.fragments = fragments;
    this.map = map;
  }

  /** The mark for input offset `at`, when the output carries marks and `at` is known; else "". */
  private m(at: number): string {
    return this.map && at >= 0 ? mark(at) : "";
  }

  // #region Finding jsx calls

  /**
   * Rewrite every jsx call in src. The walk is `until`'s, copying as it goes, so the code around
   * the calls comes out unchanged.
   *
   * @param at Where src starts in the input, for the marks; -1 when not known (no marks).
   */
  rewrite(src: string, at: number): string {
    let out = "",
      i = 0,
      prev = "",
      word = "";
    const marks = this.map && at >= 0;
    while (i < src.length) {
      const c = src[i]!;
      const j = skipToken(src, i, prev, word);
      if (j !== i) {
        if (marks) out += mark(at + i);
        out += src.slice(i, j);
        prev = "a";
        word = "";
        i = j;
        continue;
      }
      if (isIdent(c) && !isIdent(src[i - 1])) {
        let e = i;
        while (isIdent(src[e])) e++;
        const name = src.slice(i, e);
        if (marks) out += mark(at + i);
        // A helper's name as a property (`x.jsx_...(`) is some other function.
        if (this.helpers.has(name) && src[e] === "(" && src[i - 1] !== ".") {
          const close = until(src, e + 1, "");
          out += this.call(this.parse(src.slice(e + 1, close), src.slice(i, close + 1), at < 0 ? -1 : at + e + 1));
          i = close + 1;
          prev = "a";
          word = "";
          continue;
        }
        out += name;
        word = name;
        prev = "a";
        i = e;
        continue;
      }
      if (!/\s/.test(c)) {
        prev = c;
        word = "";
        if (marks) out += mark(at + i);
      }
      out += c;
      i++;
    }
    return out;
  }

  /**
   * A jsx call's arguments. jsxDEV passes more than three; the rest are dev information and are
   * dropped.
   *
   * @param whole The whole call, for the error message.
   * @param at Where args starts in the input; -1 when not known.
   */
  parse(args: string, whole: string, at: number): Call {
    const parts = splitAt(args, 0, args.length);
    const [type, props, key] = parts;
    if (type === undefined || props === undefined) throw new ReactreCompileError(`reactre: cannot compile ${whole}`);
    const pos = (p: [string, number] | undefined) => (at < 0 || p === undefined ? -1 : at + p[1]);
    return {
      type: type[0],
      props: props[0],
      key: key === undefined || key[0] === "undefined" ? undefined : key[0],
      typeAt: pos(type),
      propsAt: pos(props),
      keyAt: pos(key),
    };
  }

  // #endregion

  // #region Elements and components

  /** A jsx call that is not a child of a host element compiled with it. */
  call(c: Call): string {
    // Bun quotes a host element's tag name; a component's type is an expression.
    if (c.type.startsWith('"')) {
      // A keyed element stands alone in a one-slot fragment, which rebuilds it when the key changes.
      const keyed = this.keyed(c);
      return keyed === null ? this.host(c) : `__rrFrag([() => (${keyed})])`;
    }
    // A list renders into a parent element, before an anchor in it, so it cannot stand alone.
    if (c.type === "For") throw new ReactreCompileError("reactre: <For> must be the child of an element");
    if (this.fragments.has(c.type)) return this.fragment(c);
    return this.component(c);
  }

  /**
   * For a host element whose key calls something: the slot expression that reads the key and
   * builds the element, so the slot rebuilds it when the key changes. Null when there is no key
   * or it calls nothing: such a key never changes, so it means nothing.
   */
  private keyed(c: Call): string | null {
    if (c.key === undefined || !reactive(c.key)) return null;
    return `(${this.rewrite(c.key, c.keyAt)}), ${this.host({ ...c, key: undefined, keyAt: -1 })}`;
  }

  /**
   * A fragment that is not a child of an element: an array of its children's nodes, built in a
   * document fragment (`__frag`). A child that may change is passed as a function, which `__frag`
   * makes a slot.
   */
  private fragment(c: Call): string {
    const kids: string[] = [];
    for (const [child, at] of this.childrenOf(c.props, c.propsAt)) {
      const lit = literal(child);
      if (lit === null || lit === undefined || typeof lit === "boolean") continue;
      if (typeof lit === "string" || typeof lit === "number") {
        kids.push(this.m(at) + JSON.stringify("" + lit));
        continue;
      }
      const inner = this.only(child, at);
      if (inner !== null && inner.type === "For")
        throw new ReactreCompileError("reactre: <For> must be the child of an element");
      if (inner !== null) kids.push(this.m(at) + this.call(inner));
      else if (this.hasJsx(child) || reactive(child)) kids.push(`() => (${this.rewrite(child, at)})`);
      else kids.push(`(${this.rewrite(child, at)})`);
    }
    return `__rrFrag([${kids.join(", ")}])`;
  }

  /** The children in a props object literal, one source each, with where each starts. */
  private childrenOf(props: string, at: number): [string, number][] {
    for (const [name, value, vAt] of this.object(props, true, at)) {
      // Several children come as one array literal (jsxs); split it into one child each.
      if (name === "children") return this.items(value, vAt);
    }
    return [];
  }

  /** A children value's children: an array literal's items (jsxs), else the value itself. */
  private items(value: string, at: number): [string, number][] {
    if (!(value.startsWith("[") && value.endsWith("]"))) return [[value, at]];
    return splitAt(value, 1, value.length - 1).map(([s, i]) => [s, at < 0 ? -1 : at + i]);
  }

  /**
   * `<C a={x} />`: C called once with its props, outside any tracking. Untracked so the signals
   * the component reads while it sets up do not subscribe the effect that happens to create it.
   */
  component(c: Call): string {
    return `__rrUntrack(() => ${this.m(c.typeAt)}${c.type}(${this.rewrite(c.props, c.propsAt)}))`;
  }

  /**
   * The entries of an object literal with plain keys, as [name, value source] pairs. A shorthand
   * entry (`{ a }`) is [a, a]; a quoted key is decoded.
   *
   * @param spreads Whether a spread entry (`...p`) is allowed: it comes out as ["...", source].
   * @throws ReactreCompileError for spread props where they are not allowed (a `<For>`'s, which
   *   would hide its each, key and row function).
   */
  object(src: string, spreads: boolean, at: number): [string, string, number][] {
    const [s, sAt] = trimAt(src, at);
    if (!s.startsWith("{") || !s.endsWith("}"))
      throw new ReactreCompileError(`reactre: props must be an object literal: ${s}`);
    const out: [string, string, number][] = [];
    for (const [part, i] of splitAt(s, 1, s.length - 1)) {
      const pAt = sAt < 0 ? -1 : sAt + i;
      if (part.startsWith("...")) {
        if (!spreads) throw new ReactreCompileError(`reactre: spread props are not supported here: ${part}`);
        out.push(["...", part, pAt]);
        continue;
      }
      const colon = until(part, 0, ":");
      if (colon >= part.length) {
        out.push([part, part, pAt]);
        continue;
      }
      let k = part.slice(0, colon).trim();
      if (k.startsWith('"')) k = JSON.parse(k) as string;
      out.push([k, ...trimAt(part.slice(colon + 1), pAt < 0 ? -1 : pAt + colon + 1)]);
    }
    return out;
  }

  /** The call in src, when src is exactly one jsx call (so it can join its parent's template). */
  only(src: string, at: number): Call | null {
    const m = /^([\w$]+)\(/.exec(src);
    if (m === null || !this.helpers.has(m[1]!)) return null;
    const close = until(src, m[0].length, "");
    if (close !== src.length - 1) return null;
    return this.parse(src.slice(m[0].length, close), src, at < 0 ? -1 : at + m[0].length);
  }

  /** The template of host element c and its holes. */
  tree(c: Call): Tree {
    const tag = JSON.parse(c.type) as string;
    // An `svg` root is parsed as SVG anyway; another SVG tag needs an `<svg>` around it.
    const t: Tree = { strings: [""], holes: [], svg: tag !== "svg" && SVG_TAGS.has(tag) };
    this.element(c, t, t.svg);
    return t;
  }

  /** Append markup to the template's current string. */
  private add(t: Tree, text: string): void {
    t.strings[t.strings.length - 1] += text;
  }
  /** Add a hole; the markup after it starts a new string. */
  private hole(t: Tree, h: Hole): void {
    t.holes.push(h);
    t.strings.push("");
  }

  /**
   * Append host element c to template t: its attributes, then its children. A child host element
   * joins the same template, so a whole tree is one clone. A key is left to the caller: on a list's
   * row it is the list's, and a child's is handled in `children`.
   *
   * @param svg Whether c is inside an SVG element (or is one), where `class` is an attribute.
   */
  private element(c: Call, t: Tree, svg: boolean): void {
    const tag = JSON.parse(c.type) as string;
    const inSvg = svg || tag === "svg";
    this.add(t, "<" + tag);
    let children: [string, number][] = [];
    const entries = this.object(c.props, true, c.propsAt);
    // With a spread, every prop but the children is applied at runtime, in source order, so
    // later props override earlier ones as in React.
    if (entries.some(([k]) => k === "...")) {
      const rest = entries
        .filter(([k]) => k !== "children")
        .map(([k, v]) => (k === "..." ? v : `${JSON.stringify(k)}: ${v}`));
      this.add(t, " rr-spread=");
      // The expression is made here, so its places in the input are not known.
      this.hole(t, { kind: "el", fn: "spread", expr: `{ ${rest.join(", ")} }`, at: -1 });
    }
    const spread = entries.some(([k]) => k === "...");
    for (const [rawName, value, at] of entries) {
      if (rawName === "children") {
        // Several children come as one array literal (jsxs); split it into one child each.
        children = this.items(value, at);
        continue;
      }
      if (spread) continue;
      const name = ALIASES[rawName] ?? rawName;
      if (/^on[A-Z]/.test(name)) {
        // The hole sits where the attribute's value would; the clone adds a listener there instead.
        this.add(t, ` on${name.slice(2).toLowerCase()}=`);
        this.hole(t, { kind: "event", type: name.slice(2).toLowerCase(), expr: value, at });
        continue;
      }
      if (name === "ref") {
        this.add(t, " ref=");
        this.hole(t, { kind: "el", fn: "ref", expr: value, at });
        continue;
      }
      const lit = literal(value);
      if (lit !== NOT_LITERAL) {
        // As in React: null, undefined and false leave the attribute out, and true sets it empty.
        if (lit === null || lit === undefined || lit === false) continue;
        this.add(t, lit === true ? ` ${name}` : ` ${name}="${attrText("" + lit)}"`);
        continue;
      }
      if (name === "style") {
        this.add(t, " style=");
        this.hole(t, { kind: "el", fn: "style", expr: value, at });
        continue;
      }
      if (!inSvg && PROPERTIES.has(name)) {
        // The property, not the attribute: after the user types or clicks, only it shows the state.
        this.add(t, ` .${name}=`);
        this.hole(t, { kind: "prop", expr: value, at });
        continue;
      }
      this.add(t, ` ${name}=`);
      this.hole(t, { kind: "value", marker: name === "class" && !inSvg ? M_CLASS : M_ATTR, expr: value, at });
    }
    this.add(t, ">");
    if (VOID.has(tag)) {
      if (children.length) throw new ReactreCompileError(`reactre: <${tag}> takes no children`);
      return;
    }
    this.children(children, t, inSvg && tag !== "foreignObject");
    this.add(t, `</${tag}>`);
  }

  /** Append an element's children to template t; a fragment's children join it in place. */
  private children(children: readonly [string, number][], t: Tree, svg: boolean): void {
    // Literal null, undefined and booleans render nothing. They are dropped first, so a list
    // beside them still counts as its element's only child.
    const kept = children.filter(([x]) => {
      const lit = literal(x);
      return !(lit === null || lit === undefined || typeof lit === "boolean");
    });
    for (const [child, at] of kept) {
      const lit = literal(child);
      if (typeof lit === "string" || typeof lit === "number") {
        this.add(t, text("" + lit));
        continue;
      }
      const inner = this.only(child, at);
      const only = kept.length === 1;
      if (inner !== null && this.fragments.has(inner.type)) {
        this.children(this.childrenOf(inner.props, inner.propsAt), t, svg);
        continue;
      }
      // A slot's expression below is compiled already (at -1), and starts with the child's mark.
      if (inner !== null && inner.type.startsWith('"')) {
        const keyed = this.keyed(inner);
        if (keyed === null) this.element(inner, t, svg);
        else this.hole(t, { kind: "slot", slot: "expr", expr: this.m(at) + keyed, only, at: -1 });
        continue;
      }
      if (inner !== null && inner.type === "For")
        this.hole(t, {
          kind: "slot",
          slot: "for",
          expr: inner.props,
          only,
          at: inner.propsAt,
          ...(inner.key !== undefined ? { key: inner.key, keyAt: inner.keyAt } : {}),
        });
      else if (inner !== null)
        this.hole(t, { kind: "slot", slot: "comp", expr: this.m(at) + this.component(inner), only, at: -1 });
      // An expression that holds JSX (a conditional, a map) may change what it renders: a slot.
      else if (this.hasJsx(child))
        this.hole(t, { kind: "slot", slot: "expr", expr: this.rewrite(child, at), only, at: -1 });
      else this.hole(t, { kind: "value", marker: M_TEXT, expr: child, at });
    }
  }

  /** Whether src holds a jsx call anywhere, so it must be a slot rather than a text hole. */
  private hasJsx(src: string): boolean {
    for (const h of this.helpers) if (src.includes(h + "(")) return true;
    return false;
  }

  /** Hoist t to module scope, so it is built once, not on every render; returns its name. */
  private template(t: Tree): string {
    const id = `__rrT${this.templates.length}`;
    const markers = t.holes.map((h) =>
      h.kind === "value"
        ? h.marker
        : h.kind === "event"
          ? M_EVENT
          : h.kind === "prop"
            ? M_PROP
            : h.kind === "el"
              ? M_ATTR
              : M_SLOT,
    );
    this.templates.push(
      `const ${id} = __rrT(${JSON.stringify(t.strings)}, ${JSON.stringify(markers)}${t.svg ? ", true" : ""});`,
    );
    return id;
  }

  /**
   * A host element tree outside a list: clone, then bind what changes.
   *
   * The output is one expression (an arrow called at once), since a jsx call may sit anywhere an
   * expression can. Constant holes are filled by the clone. A reactive hole is cloned empty and
   * bound, and the bind writes its first value. The hole nodes are looked up only when some hole
   * needs its node afterwards.
   */
  host(c: Call): string {
    const t = this.tree(c);
    const id = this.template(t);
    const vals: string[] = [];
    const after: string[] = [];
    // Properties and refs go last: a select's value needs its options, and a ref a whole element.
    const late: string[] = [];
    t.holes.forEach((h, i) => {
      if (h.kind === "value") {
        if (reactive(h.expr)) {
          vals.push('""');
          after.push(`${this.m(h.at)}__rrBind(${id}, ${i}, __n[${i}], () => (${this.rewrite(h.expr, h.at)}));`);
        } else vals.push(`(${this.rewrite(h.expr, h.at)})`);
        return;
      }
      // An element hole is an attribute the clone must leave out: null is what the prototype holds.
      vals.push(h.kind === "el" ? "null" : '""');
      if (h.kind === "event") {
        // A handler that reads a signal (and is not a function literal, which only reads when
        // called) is followed: the listener calls its current value.
        if (reactive(h.expr) && !isFunction(h.expr))
          after.push(
            `${this.m(h.at)}__rrOn(__n[${i}], ${JSON.stringify(h.type)}, () => (${this.rewrite(h.expr, h.at)}));`,
          );
        else
          after.push(
            `${this.m(h.at)}__n[${i}].addEventListener(${JSON.stringify(h.type)}, ${this.rewrite(h.expr, h.at)});`,
          );
        return;
      }
      if (h.kind === "prop" || h.kind === "el") {
        const stmt = this.part(id, i, h, `__n[${i}]`);
        if (h.kind === "prop" || h.fn === "ref") late.push(stmt);
        else after.push(stmt);
        return;
      }
      if (h.slot === "comp") after.push(`__rrInsert(__n[${i}], ${h.expr}, null);`);
      else if (h.slot === "expr") after.push(`__rrSlot(__n[${i}], () => (${h.expr}));`);
      else after.push(this.forList(h.expr, h.at, h.key, h.keyAt ?? -1, `__n[${i}]`, h.only));
    });
    after.push(...late);
    const locate = after.length ? `const __n = []; ${id}.locate(__r, __n); ` : "";
    return `(() => { const __r = ${id}.clone([${vals.join(", ")}]); ${locate}${after.join(" ")} return __r; })()`;
  }

  // #endregion

  // #region Lists

  /**
   * `<For each key>{(row) => <tr/>}</For>` in the slot at `anchor`: a statement that starts the
   * keyed list, with a spec in the shape of reactre's ForSpec.
   *
   * @param keyArg The key function when JSX passed it as the call's key argument.
   * @param only Whether the list is its element's only child. The list then takes the whole
   *   parent: the anchor is removed and rows append to the parent, with no anchor to insert before.
   */
  forList(
    props: string,
    propsAt: number,
    keyArg: string | undefined,
    keyArgAt: number,
    anchor: string,
    only: boolean,
  ): string {
    const p = new Map(this.object(props, false, propsAt).map(([k, v, at]) => [k, [v, at] as const]));
    const [each, eachAt] = p.get("each") ?? [],
      [key, keyAt] = keyArg !== undefined ? [keyArg, keyArgAt] : (p.get("key") ?? []),
      [children, childrenAt] = p.get("children") ?? [];
    if (each === undefined || key === undefined || children === undefined) {
      throw new ReactreCompileError("reactre: <For> needs each, key and a row function as its child");
    }
    // One plain parameter, so it can name the row in every hole's own function below.
    const fn = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([\s\S]*)$/.exec(children.trim());
    if (fn === null) throw new ReactreCompileError(`reactre: a <For> row must be (row) => <element />: ${children}`);
    const param = fn[1]!;
    // The body ends where children does (children is trimmed already).
    let [body, bodyAt] = trimAt(fn[2]!, childrenAt! < 0 ? -1 : childrenAt! + children.length - fn[2]!.length);
    // Strip any parentheses around the body.
    while (body.startsWith("(") && until(body, 1, "") === body.length - 1)
      [body, bodyAt] = trimAt(body.slice(1, -1), bodyAt < 0 ? -1 : bodyAt + 1);
    const row = this.only(body, bodyAt);
    if (row === null || !row.type.startsWith('"'))
      throw new ReactreCompileError(`reactre: a <For> row must be one element: ${body}`);
    const t = this.tree(row);
    const id = this.template(t);
    // fill/holes: values that depend on the row only, written at creation. dyn/dynHoles: values
    // that call something, re-run when what they read changes. events: delegated to the parent.
    // mounts: the parts that create something of their own (slots, properties, styles, refs,
    // spreads), run under the row's owner when it is created and again for a new item.
    const fill: string[] = [],
      holes: number[] = [],
      dyn: string[] = [],
      dynHoles: number[] = [],
      events: string[] = [],
      mounts: string[] = [];
    // Calls with arguments in the reactive holes: a selector is read as one (`isSelected(row.id)`).
    let keyCalls = 0;
    t.holes.forEach((h, i) => {
      if (h.kind === "event") {
        // An event that does not bubble is caught in the capture phase: the 1 says so.
        const capture = NO_BUBBLE.has(h.type) ? ", 1" : "";
        events.push(`[${JSON.stringify(h.type)}, ${i}, (${param}) => (${this.rewrite(h.expr, h.at)})${capture}]`);
        return;
      }
      if (h.kind === "slot") {
        // A nested list never owns its parent here: a new item rebuilds it before the same anchor.
        const stmt =
          h.slot === "for"
            ? this.forList(h.expr, h.at, h.key, h.keyAt ?? -1, "__m", false)
            : `__rrSlot(__m, () => (${h.expr}));`;
        mounts.push(`[${i}, (${param}, __m) => { ${stmt} }]`);
        return;
      }
      if (h.kind === "prop" || h.kind === "el") {
        mounts.push(`[${i}, (${param}, __m) => { ${this.part(id, i, h, "__m")} }]`);
        return;
      }
      const e = this.rewrite(h.expr, h.at);
      if (reactive(h.expr)) {
        keyCalls += callsWithArguments(h.expr);
        dyn.push(`__d[${dynHoles.length}] = (${e});`);
        dynHoles.push(i);
      } else {
        fill.push(`__v[${i}] = (${e});`);
        holes.push(i);
      }
    });
    // dyn, events and mounts are left out when empty, so the runtime does no work for them per row.
    const spec =
      `{ each: () => (${this.rewrite(each, eachAt ?? -1)}), key: ${this.rewrite(key, keyAt ?? -1)}, t: ${id}, ` +
      `fill: (${param}, __v) => { ${fill.join(" ")} }, holes: ${JSON.stringify(holes)}` +
      (dyn.length ? `, dyn: (${param}, __d) => { ${dyn.join(" ")} }, dynHoles: ${JSON.stringify(dynHoles)}` : "") +
      (events.length ? `, events: [${events.join(", ")}]` : "") +
      (mounts.length ? `, mounts: [${mounts.join(", ")}]` : "") +
      " }";
    // A row that may read two selector keys needs the runtime's support for several.
    if (keyCalls > 1) this.selectors = true;
    // Only a row with mounts takes the list that runs them: a row of host elements and values
    // costs what it always has.
    const call = mounts.length ? "__rrForM" : "__rrFor";
    return only
      ? `{ const __a = ${anchor}, __p = __a.parentNode; __p.removeChild(__a); ${call}(__p, null, ${spec}); }`
      : `${call}(${anchor}.parentNode, ${anchor}, ${spec});`;
  }

  /**
   * The statement that sets a property or element hole on its node: once, or in an effect when
   * its expression calls something.
   */
  private part(id: string, i: number, h: Extract<Hole, { kind: "prop" | "el" }>, node: string): string {
    const e = this.rewrite(h.expr, h.at);
    const m = this.m(h.at);
    if (h.kind === "prop")
      return reactive(h.expr)
        ? `${m}__rrBind(${id}, ${i}, ${node}, () => (${e}));`
        : `${m}${id}.write(${i}, ${node}, (${e}));`;
    // A ref is called once, with the element; a function literal passed as one reads nothing.
    if (h.fn === "ref") return `${m}__rrRef(${node}, ${e});`;
    const fn = h.fn === "style" ? "__rrStyle" : "__rrSpread";
    return reactive(h.expr) ? `${m}__rrApply(${node}, ${fn}, () => (${e}));` : `${m}${fn}(${node}, (${e}), undefined);`;
  }

  // #endregion
}

// #endregion

// #region Helpers

/**
 * Whether an expression may change: it calls something (a signal read). A `(` counts as a call
 * after a name, a literal, `)` or `]`; anywhere else it only groups.
 */
function reactive(expr: string): boolean {
  return callAt(expr, 0) >= 0;
}

/**
 * Whether an expression is a function literal (an arrow or a function expression), whose calls
 * happen only when it is called: as a handler it is bound once, whatever it reads.
 */
function isFunction(expr: string): boolean {
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
 * The calls with arguments in an expression: `isSelected(row.id)` is one, `count()` none. The
 * count is of the expression's own text, so a call inside a function it calls is not seen.
 */
function callsWithArguments(expr: string): number {
  let n = 0;
  for (let i = 0; i < expr.length;) {
    const j = callAt(expr, i);
    if (j < 0) break;
    if (expr.slice(j + 1).trimStart()[0] !== ")") n++;
    i = j + 1;
  }
  return n;
}

/** Where the next call's `(` is in `expr`, from `from`, as `reactive` finds calls; -1 for none. */
function callAt(expr: string, from: number): number {
  let prev = "",
    word = "";
  for (let i = from; i < expr.length;) {
    const j = skipToken(expr, i, prev, word);
    if (j !== i) {
      i = j;
      prev = "a";
      continue;
    }
    const c = expr[i]!;
    if (c === "(" && (isIdent(prev) || prev === ")" || prev === "]" || prev === "a")) return i;
    if (isIdent(c)) {
      let e = i;
      while (isIdent(expr[e])) e++;
      word = expr.slice(i, e);
      prev = "a";
      i = e;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
    }
    i++;
  }
  return -1;
}

/** Events that do not bubble, which a list delegates in the capture phase. */
const NO_BUBBLE = new Set(
  (
    "focus blur mouseenter mouseleave pointerenter pointerleave load error scroll scrollend toggle " +
    "invalid play pause ended volumechange timeupdate"
  ).split(" "),
);

/** Text escaped for markup between tags. */
const text = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Text escaped for a double-quoted attribute value. */
const attrText = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// #endregion
