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
//     made once (components run once in reactre). A prop that may change, or holds JSX, is a
//     getter (`{ get n() { return count(); } }`), so the component reads it where it uses it, and
//     children are built when it reads them. In a component, a hole that reads a prop
//     (`{props.n}`) is bound only if some call site may pass that prop reactively: the facts of
//     ./program.ts, given as an option or found in the file alone.
//   - A store of @reactre/core/features/store is read by member (`{store.count}`): a hole that
//     mentions one the file binds (`const [store, setStore] = createStore(...)`) or, with a whole
//     program's facts, imports, is bound, and a prop that mentions one is a getter.
//   - A fragment's children join the parent's template; a fragment that is
//     not a child of an element is an array of nodes (`__frag`).
//   - A key on an element outside a list rebuilds the element when the key
//     changes (a slot that reads the key); a key that calls nothing is ignored.
//   - Control flow, when the file imports it from "@reactre/core" (by any
//     local name, or through a namespace import), compiles to slots, memos
//     and lists, so it costs only where it is used. `<Show>` and `<Switch>`
//     are a slot behind a memo of the condition (or of the matched case), so
//     the content is rebuilt only when that changes. `<Repeat>` is a keyed
//     list over the indexes, a `<For>`'s `fallback` a slot fed by the list's
//     `each`, `<Portal>` an insert into another element undone by a cleanup,
//     and `<Dynamic>` a slot that calls the component or builds the tag.
//   - `class` written as an object or array literal is taken apart: literal
//     classes join the template, an object's other keys are classList
//     toggles (bound when they call something), and a part the compiler
//     cannot resolve (an expression in an array, a computed key) makes the
//     whole list one string through `__class`. `ref={[a, b]}` gives the
//     element to each, and `defaultValue`, `defaultChecked`,
//     `defaultSelected` and `defaultMuted` are set as properties.
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
//     Member reads are the exceptions, judged in one place (`readsChanging`). A read of a
//     component's props (`props.title`), which may be a getter, is reactive when a call site may
//     pass that prop reactively, so a component whose callers pass only values costs what it did
//     before props were reactive. A mention of a store root (`store.count`; see ./program.ts) is
//     reactive, since a store's reads subscribe; a file that binds and imports no store has none.
//   - A `<For>` whose `each` mentions a store root reads a copy of it (`[...store.todos]`): a
//     store's array changes in place, and a list needs a new array to render. Its row's item is a
//     store root in the row, so a hole that reads only the item (`t.done`) is reactive, where a
//     list over plain values compares it when the row gets a new item. Other lists compile as before.
//   - Every name the output adds starts with `__rr`, so it cannot collide with the app's names.
//   - Control flow is recognized by import, not by name: `Show`, `Switch` and `Dynamic` are names
//     apps give components of their own (a toggle switch, a dynamic form), and those must stay
//     components. `<For>` is also matched by its name alone, as it always was.
//   - For a source map (`compileJsWithMap`), each piece of source carries where it starts in the
//     input, and the output marks each token it copies with its place (./map.ts). Without a map,
//     nothing is marked, so the code is the same either way.
//
//   Bun.build({ plugins: [reactreCompiler()], ... })

import { dirname, resolve } from "node:path";

import type { BunPlugin } from "bun";

import { hasMarks, mark, type SourceMapV3, unmark } from "./map.ts";
import {
  analyze,
  type Def,
  findDefs,
  findStores,
  type Host,
  isExternal,
  isFunction,
  moduleFacts,
  type Program,
  type PropFacts,
  propReads,
  propUse,
  readsOf,
  rootsIn,
  scanModule,
  scopeAt,
  touches,
  walk,
} from "./program.ts";
import { isIdent, literal, NOT_LITERAL, skipToken, splitAt, trimAt, until } from "./scan.ts";

export type { PropFacts } from "./program.ts";

/** Options for compiling one file. */
export interface CompileOptions {
  /**
   * The props each component the file defines may be passed reactively, by the component's name
   * (`@reactre/compiler/program` finds them for a whole program). A component missing from the
   * map is reactive in every prop. Without the option, the file is seen alone: a component it
   * neither exports nor uses as a value has all its call sites in it, and any other is reactive in
   * every prop. The facts' `stores` are the stores the file imports (`Program.factsOf` gives
   * them); without them, only the stores the file binds itself are known.
   */
  readonly props?: PropFacts;
}

// #region Plugin

/** Options for the plugin. */
export interface ReactreCompilerOptions {
  /** Files to compile; default .jsx and .tsx outside node_modules. */
  readonly filter?: RegExp;
  /**
   * Read the whole program before compiling, from the build's entrypoints, so a component's holes
   * that read a prop are bound only where some call site passes that prop reactively. Default
   * true. With false, or outside `Bun.build`, each file is seen alone (see `CompileOptions`).
   */
  readonly wholeProgram?: boolean;
}

/** A Bun loader for a script's path: tsx, ts, jsx or js. */
const loaderOf = (path: string): "tsx" | "ts" | "jsx" | "js" =>
  /\.[cm]?tsx$/.test(path) ? "tsx" : /\.[cm]?ts$/.test(path) ? "ts" : /\.[cm]?jsx$/.test(path) ? "jsx" : "js";

/**
 * The Bun plugin: compiles the app's TSX files. Files under node_modules are left to Bun, since
 * packages ship JavaScript built for their own runtime. In `Bun.build`, the program is read from
 * the entrypoints first (`@reactre/compiler/program`), resolved as Bun resolves it.
 *
 * @example
 *   await Bun.build({ entrypoints: ["./app/main.tsx"], outdir: "dist", plugins: [reactreCompiler()] });
 */
export function reactreCompiler(options: ReactreCompilerOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.[jt]sx$/;
  return {
    name: "@reactre/compiler",
    setup(build) {
      const external = (build.config as { external?: string[] } | undefined)?.external;
      const host: Host = {
        resolve(spec, importer) {
          try {
            return Bun.resolveSync(spec, dirname(importer));
          } catch {
            // Left to the runtime when the build says so; else another plugin may serve it (a
            // virtual module), whose code the program cannot read.
            return isExternal(spec, external) ? false : null;
          }
        },
        transpile: (file, source) => transpileSource(source, loaderOf(file)),
      };
      let program: Promise<Program | null> = Promise.resolve(null);
      const entries = (build.config as { entrypoints?: string[] } | undefined)?.entrypoints;
      if (options.wholeProgram !== false && entries !== undefined)
        build.onStart(() => {
          program = analyze(
            entries.map((e) => resolve(e)),
            host,
          );
        });
      build.onLoad({ filter }, async ({ path }) => {
        if (path.includes("/node_modules/")) return undefined;
        const js = transpileSource(await Bun.file(path).text(), path.endsWith(".tsx") ? "tsx" : "jsx");
        const props = await factsFor(await program, path, js, host);
        // The output is plain JavaScript: TypeScript and JSX are already gone.
        return { contents: compileJs(js, props === undefined ? {} : { props }), loader: "js" };
      });
    },
  };
}

/**
 * The facts of module `file` (of code `js`) in a build's `program`; undefined without one. A
 * module the program does not have (or has with other code) joins it first, with what it reaches.
 *
 * @throws ReactreCompileError when that module makes the program incomplete, or passes a prop
 *   reactively to a component compiled already without it.
 */
export async function factsFor(
  program: Program | null,
  file: string,
  js: string,
  host: Host,
): Promise<PropFacts | undefined> {
  if (program === null) return undefined;
  if (!program.has(file, js)) {
    const complete = await walk(program, [file], host, new Map([[file, js]]));
    const wrong = program.check();
    if (!complete || wrong !== null)
      throw new ReactreCompileError(
        `reactre: ${file} was not in the program read before the build` +
          (wrong === null
            ? `, and it imports what cannot be known while compiling`
            : `, and it passes ${wrong.prop} reactively to ${wrong.component} in ${wrong.file}, compiled already`) +
          "; set the plugin's `wholeProgram` option to false",
      );
  }
  return program.factsOf(file);
}

/**
 * Transpile one TSX (or JSX) source with Bun and compile its JSX.
 *
 * @returns JavaScript that imports what it needs from `@reactre/core` and no JSX runtime.
 * @throws ReactreCompileError for a construct the compiler does not handle.
 * @example
 *   const js = compileSource(`export const A = () => <p class="x">{count()}</p>;`);
 */
export function compileSource(source: string, loader: "jsx" | "tsx" = "tsx", options?: CompileOptions): string {
  return compileJs(transpileSource(source, loader), options);
}

/**
 * One TSX (or JSX) source as Bun transpiles it for the compiler: TypeScript stripped, JSX turned
 * into jsx calls. What `compileJs` reads, and what `@reactre/compiler/program` scans.
 */
export function transpileSource(source: string, loader: "jsx" | "tsx" | "ts" | "js" = "tsx"): string {
  // jsxImportSource only names the runtime Bun would import; no runtime is imported, because every
  // jsx call is compiled away.
  const t = new Bun.Transpiler({
    loader,
    tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "@reactre/core" } },
  } as ConstructorParameters<typeof Bun.Transpiler>[0]);
  return t.transformSync(source);
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
 * Props that are properties only, set even when their value is a literal: each reflects another
 * attribute (`defaultValue` is `value`'s, or a textarea's text), so there is none of its name.
 */
const DEFAULTS = new Set(["defaultValue", "defaultChecked", "defaultSelected", "defaultMuted"]);
/** The elements @reactre/core's control flow compiles, by their exported names. */
const FLOW = ["For", "Show", "Switch", "Match", "Repeat", "Portal", "Dynamic"] as const;
type Flow = (typeof FLOW)[number];
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
  | {
      readonly kind: "value";
      readonly marker: number;
      readonly expr: string;
      /** A function the compiled expression is passed through (`__rrClass`, for a class list). */
      readonly wrap?: string;
    }
  | { readonly kind: "event"; readonly type: string; readonly expr: string }
  /** A property (`value`, `checked`, `selected`), which cloning does not copy: set after the clone. */
  | { readonly kind: "prop"; readonly expr: string }
  /** What a runtime helper applies to the element itself: a style, a ref or spread props. */
  | { readonly kind: "el"; readonly fn: "style" | "ref" | "spread"; readonly expr: string }
  /** A class object's keys whose values are expressions: [class, value, where it starts]. */
  | { readonly kind: "el"; readonly fn: "toggle"; readonly expr: ""; readonly toggles: readonly Toggle[] }
  | {
      readonly kind: "slot";
      /**
       * "for": a list (`expr` is its props); "comp": content inserted once; "expr": an expression
       * re-run as a slot; "fn": a slot whose function `expr` is (control flow's).
       */
      readonly slot: "for" | "comp" | "expr" | "fn";
      readonly expr: string;
      /** Whether the slot is its element's only child, so a list can own the element. */
      readonly only: boolean;
      /** A <For>'s key function (JSX passes `key` apart from the props), and where it starts. */
      readonly key?: string;
      readonly keyAt?: number;
      /** For a list: a <Repeat>'s props, not a <For>'s. */
      readonly repeat?: boolean;
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

/** A class object's key toggled by an expression: the class, the expression, where it starts. */
type Toggle = readonly [string, string, number];

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
export function compileJs(js: string, options?: CompileOptions): string {
  return compile(js, false, options);
}

/**
 * `compileJs`, with a source map from the code back to `js`.
 *
 * @returns The code `compileJs` returns, and its map: null when `js` has no jsx calls (the code
 *   is `js`) or holds the characters the map's marks use (see ./map.ts).
 * @throws ReactreCompileError as `compileJs` does.
 */
export function compileJsWithMap(js: string, options?: CompileOptions): { code: string; map: SourceMapV3 | null } {
  if (hasMarks(js)) return { code: compileJs(js, options), map: null };
  const marked = compile(js, true, options);
  if (marked === js) return { code: js, map: null };
  return unmark(marked, js);
}

/** `compileJs`, with marks for a source map in the code when `map` is set. */
function compile(js: string, map: boolean, options: CompileOptions = {}): string {
  // Bun's transpiler names the runtime's helpers with a hash suffix (jsx_w77yafs4, ...); those
  // names are what the compiler looks for.
  const helpers = new Set<string>();
  for (const m of js.matchAll(/\b(jsxs|jsx|jsxDEV)_[a-z0-9]{8}\b/g)) helpers.add(m[0]);
  if (helpers.size === 0) return js;
  const fragments = new Set<string>();
  for (const m of js.matchAll(/\bFragment_[a-z0-9]{8}\b/g)) fragments.add(m[0]);
  // The components the file defines, and which of their props may be passed reactively.
  let defs: Def[], props: PropFacts, stores: Set<string>;
  if (options.props !== undefined) [defs, props, stores] = [findDefs(js), options.props, findStores(js)];
  else {
    const info = scanModule(js);
    [defs, props, stores] = [[...info.defs], moduleFacts(js, info), new Set(info.stores)];
  }
  // The stores the file binds, and those the program says it imports.
  for (const s of props.stores ?? []) stores.add(s);
  const c = new Compiler(helpers, fragments, map, flowNames(js), defs, props, stores);
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
  ["memo", "__rrMemo"],
  ["signal", "__rrSignal"],
  ["onCleanup", "__rrOnCleanup"],
  ["__class", "__rrClass"],
  ["__props", "__rrProps"],
];

/**
 * The control flow elements the file imports from @reactre/core, by the type a jsx call names
 * them with: `Show` (or its local name, `S` for `Show as S`), and `R.Show` for `import * as R`.
 */
function flowNames(js: string): Map<string, Flow> {
  const names = new Map<string, Flow>();
  const isFlow = (n: string): n is Flow => (FLOW as readonly string[]).includes(n);
  for (const m of js.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']@reactre\/core["']/g)) {
    for (const part of m[1]!.split(",")) {
      const [name, local = name] = part.trim().split(/\s+as\s+/) as [string, string?];
      if (isFlow(name)) names.set(local, name);
    }
  }
  for (const m of js.matchAll(/\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*["']@reactre\/core["']/g))
    for (const name of FLOW) names.set(`${m[1]}.${name}`, name);
  return names;
}

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
  /** The control flow the file imports, by the type its jsx calls name (see `flowNames`). */
  private readonly flow: ReadonlyMap<string, Flow>;
  /** Numbers the names control flow declares (`__rrC0`), so nested ones are told apart. */
  private uid = 0;
  /** The file's components, and the props each may be passed reactively (see `CompileOptions`). */
  private readonly defs: readonly Def[];
  private readonly props: PropFacts;
  /** The components the jsx call being compiled is written in, outermost first. */
  private scope: readonly Def[] = [];
  /**
   * The names that hold stores where the jsx call being compiled is: the file's (see
   * `compile`), and the item of each <For> row over a store around it.
   */
  private readonly stores: Set<string>;
  constructor(
    helpers: Set<string>,
    fragments: Set<string>,
    map: boolean,
    flow: ReadonlyMap<string, Flow>,
    defs: readonly Def[],
    props: PropFacts,
    stores: Set<string>,
  ) {
    this.helpers = helpers;
    this.fragments = fragments;
    this.map = map;
    this.flow = flow;
    this.defs = defs;
    this.props = props;
    this.stores = stores;
  }

  /**
   * Whether an expression may change: it calls something (a signal read), or its member reads
   * read what may change (`readsChanging`).
   */
  private changes(expr: string): boolean {
    return reactive(expr) || this.readsChanging(expr);
  }

  /**
   * Whether the member reads of `expr` read what may change: a prop that a call site of the
   * component it is written in may pass reactively (`props.title`), or a store's property
   * (`store.count`, a store row's `t.done`; any mention of a store root). Every member read the
   * compiler judges comes here. A file that binds and imports no store has no store roots, so
   * only its props are judged, as before stores were.
   */
  private readsChanging(expr: string): boolean {
    return (
      propReads(expr, this.scope).some(([d, r]) => touches(this.props.get(d.name) ?? true, r)) || this.readsStore(expr)
    );
  }

  /** Whether `expr` mentions a store root (see `rootsIn`). */
  private readsStore(expr: string): boolean {
    return rootsIn(expr, this.stores).length > 0;
  }

  /**
   * Whether an element's child reads `children` from its component's props (`{props.children}`, or
   * `{children}` from a pattern, `{p.children}` from a local made of the props): content, which
   * may be nodes, so it is inserted, not text.
   */
  private readsChildren(expr: string): boolean {
    for (const d of this.scope) {
      if (d.param.kind === "pattern") {
        for (const [local, key] of d.param.locals) if (key === "children" && readsOf(expr, local) !== null) return true;
      }
      for (const a of d.aliases) {
        const r = readsOf(expr, a);
        if (r !== null && r !== true && r.has("children")) return true;
      }
    }
    return propReads(expr, this.scope).some(([, r]) => r !== true && r.has("children"));
  }

  /** The mark for input offset `at`, when the output carries marks and `at` is known; else "". */
  private m(at: number): string {
    return this.map && at >= 0 ? mark(at) : "";
  }

  /** The control flow element a jsx call's type names, or null: `For` by its name too. */
  private kind(type: string): Flow | null {
    return this.flow.get(type) ?? (type === "For" ? "For" : null);
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
          // The components around the call, where it is known: a call compiled from another's
          // text (at -1) is in the components that one is in.
          const outer = this.scope;
          if (at >= 0) this.scope = scopeAt(this.defs, at + i);
          out += this.call(this.parse(src.slice(e + 1, close), src.slice(i, close + 1), at < 0 ? -1 : at + e + 1));
          this.scope = outer;
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
    const f = this.kind(c.type);
    // A list renders into a parent element, before an anchor in it, so it cannot stand alone.
    if (f === "For" || f === "Repeat") throw new ReactreCompileError(`reactre: <${f}> must be the child of an element`);
    // Control flow that stands alone is a one-slot fragment, or for a <Portal> or a <Dynamic> of
    // a component that calls nothing, the expression itself.
    if (f !== null) {
      const flow = this.flowOf(c, f, false);
      if ("host" in flow) return this.call(flow.host);
      return "fn" in flow ? `__rrFrag([${flow.fn}])` : flow.expr;
    }
    if (this.fragments.has(c.type)) return this.fragment(c);
    return this.component(c);
  }

  /**
   * For a host element whose key calls something: the slot expression that reads the key and
   * builds the element, so the slot rebuilds it when the key changes. Null when there is no key
   * or it calls nothing: such a key never changes, so it means nothing.
   */
  private keyed(c: Call): string | null {
    if (c.key === undefined || !this.changes(c.key)) return null;
    return `(${this.rewrite(c.key, c.keyAt)}), ${this.host({ ...c, key: undefined, keyAt: -1 })}`;
  }

  /**
   * A fragment that is not a child of an element: an array of its children's nodes, built in a
   * document fragment (`__frag`). A child that may change is passed as a function, which `__frag`
   * makes a slot.
   */
  private fragment(c: Call): string {
    return this.frag(this.childrenOf(c.props, c.propsAt));
  }

  /** `fragment`'s array of nodes, for a list of children. */
  private frag(children: readonly [string, number][]): string {
    const kids: string[] = [];
    for (const [child, at] of children) {
      const lit = literal(child);
      if (lit === null || lit === undefined || typeof lit === "boolean") continue;
      if (typeof lit === "string" || typeof lit === "number") {
        kids.push(this.m(at) + JSON.stringify("" + lit));
        continue;
      }
      const inner = this.only(child, at);
      const f = inner === null ? null : this.kind(inner.type);
      if (f === "For" || f === "Repeat")
        throw new ReactreCompileError(`reactre: <${f}> must be the child of an element`);
      // A slot of control flow joins the fragment's slots, not a fragment of its own.
      const flow = inner !== null && f !== null ? this.flowOf(inner, f, false) : null;
      if (flow !== null)
        kids.push(this.m(at) + ("fn" in flow ? flow.fn : "host" in flow ? this.call(flow.host) : flow.expr));
      else if (inner !== null) kids.push(this.m(at) + this.call(inner));
      else if (this.hasJsx(child) || this.changes(child)) kids.push(`() => (${this.rewrite(child, at)})`);
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
   * A prop that may change, or holds JSX, is a getter (see `passProps`).
   */
  component(c: Call): string {
    const props = this.passProps(this.object(c.props, true, c.propsAt)) ?? this.rewrite(c.props, c.propsAt);
    return `__rrUntrack(() => ${this.m(c.typeAt)}${c.type}(${props}))`;
  }

  /**
   * A component's props object, as Solid passes them: a prop whose expression may change (it calls
   * something) is a getter, so the component reads it where it uses it, in a hole that follows it;
   * one that holds JSX (children, mostly) is a getter too, so it is built when the component reads
   * it, after the component's own code before that. So is one that reads a prop of the component
   * around the call (`<Theme value="dark">{props.children}</Theme>`), which may be either: read
   * where it is passed, it would build children before the component they are passed to runs, a
   * provider's children outside the provider. So is one that mentions a store root
   * (`text={store.title}`, `todo={t}` in a store's row), whose reads are reactive. Spread props are
   * merged by `__props`, which keeps their getters. Null when every prop is a value and there is
   * no spread: the props are written as they are.
   */
  private passProps(entries: readonly [string, string, number][]): string | null {
    const kinds = entries.map(([k, v]) => {
      if (k === "...") return "spread";
      const use = propUse(v, this.helpers, this.scope, this.stores);
      if (use.fn) return "value";
      return use.lazy || use.calls || use.reads.length > 0 || use.stores !== undefined ? "getter" : "value";
    });
    if (kinds.every((k) => k === "value")) return null;
    const groups: string[] = [];
    let group: string[] | null = null;
    entries.forEach(([k, v, at], i) => {
      if (kinds[i] === "spread") {
        if (group !== null) groups.push(`{ ${group.join(", ")} }`);
        group = null;
        groups.push(this.rewrite(v.slice(3), at < 0 ? -1 : at + 3));
        return;
      }
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      const e = this.rewrite(v, at);
      (group ??= []).push(kinds[i] === "getter" ? `get ${key}() { return ${e}; }` : `${key}: ${e}`);
    });
    if (group !== null) groups.push(`{ ${(group as string[]).join(", ")} }`);
    return kinds.includes("spread") ? `__rrProps(${groups.join(", ")})` : groups[0]!;
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
        .map(([k, v]) => (k === "..." ? v : `${JSON.stringify(k)}: ${spreadValue(k, v)}`));
      this.add(t, " rr-spread=");
      // The expression is made here, so its places in the input are not known.
      this.hole(t, { kind: "el", fn: "spread", expr: `{ ${rest.join(", ")} }`, at: -1 });
    }
    const spread = entries.some(([k]) => k === "...");
    // A class object or array is taken apart with every other class prop of the element
    // (`className` beside `class`), so that together they make one class list.
    const classes = entries.filter(([k]) => k !== "..." && (ALIASES[k] ?? k) === "class");
    const classList = !spread && classes.some(([, v]) => isLiteral(v, "{") || isLiteral(v, "["));
    let classDone = false;
    for (const [rawName, value, at] of entries) {
      if (rawName === "children") {
        // Several children come as one array literal (jsxs); split it into one child each.
        children = this.items(value, at);
        continue;
      }
      if (spread) continue;
      const name = ALIASES[rawName] ?? rawName;
      if (name === "class" && classList) {
        // All of them, at the first class prop.
        if (!classDone) this.classList(classes, t, inSvg);
        classDone = true;
        continue;
      }
      if (!inSvg && DEFAULTS.has(name)) {
        // Always the property: a literal too, since no attribute has the name.
        const lit = literal(value);
        if (lit === null || lit === undefined) continue;
        this.add(t, ` .${name}=`);
        this.hole(t, { kind: "prop", expr: value, at });
        continue;
      }
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

  /**
   * An element's class props, one of which is an object or array literal, as one class list.
   * When every part is known while compiling, the literal classes join the template and an
   * object's other keys become toggles (an element hole); otherwise the whole list is one class
   * hole whose value goes through `__class`.
   */
  private classList(classes: readonly [string, string, number][], t: Tree, svg: boolean): void {
    const tokens: string[] = [],
      toggles: Toggle[] = [];
    if (!classes.every(([, v, at]) => this.classParts(v, at, tokens, toggles))) {
      // On SVG, class is an attribute (className is read-only there).
      const [expr, at] =
        classes.length === 1 ? [classes[0]![1], classes[0]![2]] : [`[${classes.map(([, v]) => v).join(", ")}]`, -1];
      this.add(t, " class=");
      this.hole(t, { kind: "value", marker: svg ? M_ATTR : M_CLASS, expr, at, wrap: "__rrClass" });
      return;
    }
    if (tokens.length) this.add(t, ` class="${attrText(tokens.join(" "))}"`);
    if (toggles.length) {
      this.add(t, " rr-class=");
      this.hole(t, { kind: "el", fn: "toggle", expr: "", toggles, at: -1 });
    }
  }

  /**
   * One class value taken apart: its literal classes into `tokens`, an object's keys whose values
   * are expressions into `toggles`. False when some part of it is known only at runtime: an
   * expression that is not an object or array literal, a spread, or a computed key.
   */
  private classParts(v: string, at: number, tokens: string[], toggles: Toggle[]): boolean {
    const lit = literal(v);
    const names = (s: string) => s.split(/\s+/).filter(Boolean);
    if (lit !== NOT_LITERAL) {
      if (typeof lit === "string" || (typeof lit === "number" && lit !== 0)) tokens.push(...names("" + lit));
      return true;
    }
    if (isLiteral(v, "["))
      return splitAt(v, 1, v.length - 1).every(([s, i]) => this.classParts(s, at < 0 ? -1 : at + i, tokens, toggles));
    if (!isLiteral(v, "{")) return false;
    const entries = this.object(v, true, at);
    if (entries.some(([k]) => k === "..." || k.startsWith("["))) return false;
    for (const [k, x, xAt] of entries) {
      const l = literal(x);
      // A key of several names toggles each.
      if (l === NOT_LITERAL) for (const c of names(k)) toggles.push([c, x, xAt]);
      else if (l) tokens.push(...names(k));
    }
    return true;
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
      const f = inner === null ? null : this.kind(inner.type);
      if (f === "For" || f === "Repeat")
        this.hole(t, {
          kind: "slot",
          slot: "for",
          expr: inner!.props,
          only,
          at: inner!.propsAt,
          ...(inner!.key !== undefined ? { key: inner!.key, keyAt: inner!.keyAt } : {}),
          ...(f === "Repeat" ? { repeat: true } : {}),
        });
      else if (f !== null) {
        // Control flow: a slot of its own function, content inserted once, or (a <Dynamic> of a
        // tag name written as a string) an element of the template.
        const flow = this.flowOf(inner!, f, svg);
        if ("host" in flow) this.element(flow.host, t, svg);
        else if ("fn" in flow) this.hole(t, { kind: "slot", slot: "fn", expr: this.m(at) + flow.fn, only, at: -1 });
        else this.hole(t, { kind: "slot", slot: "comp", expr: this.m(at) + flow.expr, only, at: -1 });
      } else if (inner !== null)
        this.hole(t, { kind: "slot", slot: "comp", expr: this.m(at) + this.component(inner), only, at: -1 });
      // A component's children may be nodes: inserted, and followed when they may change.
      else if (this.readsChildren(child)) {
        const expr = this.rewrite(child, at);
        this.hole(t, { kind: "slot", slot: this.changes(child) ? "expr" : "comp", expr, only, at: -1 });
      }
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

  /** A value hole's compiled expression, through its `wrap` when it has one. */
  private value(h: Extract<Hole, { kind: "value" }>): string {
    const e = this.rewrite(h.expr, h.at);
    return h.wrap === undefined ? e : `${h.wrap}(${e})`;
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
        if (this.changes(h.expr)) {
          vals.push('""');
          after.push(`${this.m(h.at)}__rrBind(${id}, ${i}, __n[${i}], () => (${this.value(h)}));`);
        } else vals.push(`(${this.value(h)})`);
        return;
      }
      // An element hole is an attribute the clone must leave out: null is what the prototype holds.
      vals.push(h.kind === "el" ? "null" : '""');
      if (h.kind === "event") {
        // A handler that reads a signal (and is not a function literal, which only reads when
        // called) is followed: the listener calls its current value.
        if (this.changes(h.expr) && !isFunction(h.expr))
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
      else if (h.slot === "fn") after.push(`__rrSlot(__n[${i}], ${h.expr});`);
      else after.push(this.forList(h.expr, h.at, h.key, h.keyAt ?? -1, `__n[${i}]`, h.only, h.repeat));
    });
    after.push(...late);
    const locate = after.length ? `const __n = []; ${id}.locate(__r, __n); ` : "";
    return `(() => { const __r = ${id}.clone([${vals.join(", ")}]); ${locate}${after.join(" ")} return __r; })()`;
  }

  // #endregion

  // #region Lists

  /**
   * `<For each key>{(row) => <tr/>}</For>` in the slot at `anchor`: a statement that starts the
   * keyed list, with a spec in the shape of reactre's ForSpec. A `<Repeat count from>` is the
   * same list over the indexes, keyed by the index.
   *
   * With a `fallback`, `each` also writes a signal of whether the list is empty, which a slot
   * beside the list follows. The list then keeps its anchor even as its element's only child: a
   * list that owns its parent clears it natively, which would take the fallback too.
   *
   * @param keyArg The key function when JSX passed it as the call's key argument.
   * @param only Whether the list is its element's only child. The list then takes the whole
   *   parent: the anchor is removed and rows append to the parent, with no anchor to insert before.
   * @param repeat Whether `props` are a <Repeat>'s.
   */
  forList(
    props: string,
    propsAt: number,
    keyArg: string | undefined,
    keyArgAt: number,
    anchor: string,
    only: boolean,
    repeat = false,
  ): string {
    const name = repeat ? "Repeat" : "For";
    const p = new Map(this.object(props, false, propsAt).map(([k, v, at]) => [k, [v, at] as const]));
    const [children, childrenAt] = p.get("children") ?? [];
    // The list's each and key, compiled where the spec is written (after the row's template).
    let each: () => string, key: () => string;
    // Whether `each` mentions a store root: its items are stores, so the row follows what it reads
    // of its item (see below).
    let store = false;
    if (repeat) {
      const [count, countAt] = p.get("count") ?? [];
      const other = [...p.keys()].find((k) => !["count", "from", "fallback", "children"].includes(k));
      if (count === undefined || children === undefined || keyArg !== undefined || other !== undefined)
        throw new ReactreCompileError(
          "reactre: <Repeat> takes count, from, fallback and a row function as its child" +
            (other !== undefined ? `, not ${other}` : keyArg !== undefined ? ", not key" : ""),
        );
      const from = p.get("from");
      each = () => {
        const range = `Array.from({ length: ${this.rewrite(count, countAt!)} }, (__rrU, __rrI) => `;
        return from === undefined
          ? `${range}__rrI)`
          : `((__rrF) => ${range}__rrF + __rrI))(${this.rewrite(from[0], from[1])})`;
      };
      key = () => "(__rrI) => __rrI";
    } else {
      const [e, eAt] = p.get("each") ?? [],
        [k, kAt] = keyArg !== undefined ? [keyArg, keyArgAt] : (p.get("key") ?? []);
      if (e === undefined || k === undefined || children === undefined) {
        throw new ReactreCompileError("reactre: <For> needs each, key and a row function as its child");
      }
      // A store's array is changed in place, and the list needs a new array for each render: it is
      // read through a copy (`[...store.todos]`), which reads its length and every index tracked,
      // so pushes, removals and moves render. An array literal is a new array already.
      store = this.readsStore(e);
      const copy = store && !isLiteral(e, "[");
      each = () => (copy ? `[...(${this.rewrite(e, eAt ?? -1)})]` : this.rewrite(e, eAt ?? -1));
      key = () => this.rewrite(k, kAt ?? -1);
    }
    // One plain parameter, so it can name the row in every hole's own function below.
    const fn = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([\s\S]*)$/.exec(children.trim());
    if (fn === null)
      throw new ReactreCompileError(
        `reactre: a <${name}> row must be (${repeat ? "i" : "row"}) => <element />: ${children}`,
      );
    const param = fn[1]!;
    // The body ends where children does (children is trimmed already).
    let [body, bodyAt] = trimAt(fn[2]!, childrenAt! < 0 ? -1 : childrenAt! + children.length - fn[2]!.length);
    // Strip any parentheses around the body.
    while (body.startsWith("(") && until(body, 1, "") === body.length - 1)
      [body, bodyAt] = trimAt(body.slice(1, -1), bodyAt < 0 ? -1 : bodyAt + 1);
    const row = this.only(body, bodyAt);
    if (row === null || !row.type.startsWith('"'))
      throw new ReactreCompileError(`reactre: a <${name}> row must be one element: ${body}`);
    // In a row over a store, the item is a store root: a hole that reads it (`t.done`) is reactive,
    // since a store's item changes in place and the row never gets a new item for it. Only the
    // row's own code sees it so; `each`, `key` and `fallback` are compiled after.
    const item = store && !this.stores.has(param);
    if (item) this.stores.add(param);
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
            ? this.forList(h.expr, h.at, h.key, h.keyAt ?? -1, "__m", false, h.repeat)
            : h.slot === "fn"
              ? `__rrSlot(__m, ${h.expr});`
              : `__rrSlot(__m, () => (${h.expr}));`;
        mounts.push(`[${i}, (${param}, __m) => { ${stmt} }]`);
        return;
      }
      if (h.kind === "prop" || h.kind === "el") {
        mounts.push(`[${i}, (${param}, __m) => { ${this.part(id, i, h, "__m")} }]`);
        return;
      }
      const e = this.value(h);
      if (this.changes(h.expr)) {
        keyCalls += callsWithArguments(h.expr);
        dyn.push(`__d[${dynHoles.length}] = (${e});`);
        dynHoles.push(i);
      } else {
        fill.push(`__v[${i}] = (${e});`);
        holes.push(i);
      }
    });
    if (item) this.stores.delete(param);
    const fallback = p.get("fallback");
    const n = fallback === undefined ? -1 : this.uid++;
    // dyn, events and mounts are left out when empty, so the runtime does no work for them per row.
    const spec =
      (fallback === undefined
        ? `{ each: () => (${each()}), `
        : `{ each: () => { const __rrL = (${each()}); __rrS${n}(__rrL.length === 0); return __rrL; }, `) +
      `key: ${key()}, t: ${id}, ` +
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
    if (fallback !== undefined) {
      // The list's first run writes the signal, before the slot first reads it.
      const shown = `__rrSlot(${anchor}, () => (__rrE${n}() ? (${this.rewrite(fallback[0], fallback[1])}) : null));`;
      return `{ const [__rrE${n}, __rrS${n}] = __rrSignal(true); ${call}(${anchor}.parentNode, ${anchor}, ${spec}); ${shown} }`;
    }
    return only
      ? `{ const __a = ${anchor}, __p = __a.parentNode; __p.removeChild(__a); ${call}(__p, null, ${spec}); }`
      : `${call}(${anchor}.parentNode, ${anchor}, ${spec});`;
  }

  /**
   * The statement that sets a property or element hole on its node: once, or in an effect when
   * its expression calls something.
   */
  private part(id: string, i: number, h: Extract<Hole, { kind: "prop" | "el" }>, node: string): string {
    if (h.kind === "el" && h.fn === "toggle")
      // One toggle per class, in an effect of its own when its value calls something.
      return h.toggles
        .map(([c, x, at]) => {
          const e = this.rewrite(x, at),
            name = JSON.stringify(c);
          return this.changes(x)
            ? `${this.m(at)}__rrApply(${node}, (__rrE, __rrV) => __rrE.classList.toggle(${name}, !!__rrV), () => (${e}));`
            : `${this.m(at)}${node}.classList.toggle(${name}, !!(${e}));`;
        })
        .join(" ");
    if (h.kind === "el" && h.fn === "ref" && isLiteral(h.expr, "["))
      // Each ref of an array literal gets the element, a spread item's refs each; a literal null
      // or undefined is left out.
      return splitAt(h.expr, 1, h.expr.length - 1)
        .filter(([r]) => literal(r) !== null && literal(r) !== undefined)
        .map(([r, i]) => {
          const at = h.at < 0 ? -1 : h.at + i;
          return r.startsWith("...")
            ? `${this.m(at)}for (const __rrR of ${this.rewrite(r.slice(3), at < 0 ? -1 : at + 3)}) __rrRef(${node}, __rrR);`
            : `${this.m(at)}__rrRef(${node}, ${this.rewrite(r, at)});`;
        })
        .join(" ");
    const e = this.rewrite(h.expr, h.at);
    const m = this.m(h.at);
    if (h.kind === "prop")
      return this.changes(h.expr)
        ? `${m}__rrBind(${id}, ${i}, ${node}, () => (${e}));`
        : `${m}${id}.write(${i}, ${node}, (${e}));`;
    // A ref is called once, with the element; a function literal passed as one reads nothing.
    if (h.fn === "ref") return `${m}__rrRef(${node}, ${e});`;
    const fn = h.fn === "style" ? "__rrStyle" : "__rrSpread";
    return this.changes(h.expr)
      ? `${m}__rrApply(${node}, ${fn}, () => (${e}));`
      : `${m}${fn}(${node}, (${e}), undefined);`;
  }

  // #endregion

  // #region Control flow

  // <Show>, <Switch> and <Dynamic> of a component that may change are slots: each compiles to a
  // function for `__slot` (`fn`), whose setup (the memos it reads) runs where the element is,
  // under the same owner. A row of a list runs it again for a new item, as its other slots. The
  // content is built inside the slot's run, so the slot owns what it makes and disposes it when
  // the condition changes. Every name these declare carries a number of its own (`__rrC0`).

  /**
   * What control flow element `c` compiles to: a slot function (`fn`), an expression that builds
   * its content once (`expr`), or a host element to compile in its place (`host`).
   *
   * @param svg Whether it is inside an SVG element, where a <Dynamic>'s tag is an SVG one.
   */
  private flowOf(
    c: Call,
    f: Exclude<Flow, "For" | "Repeat">,
    svg: boolean,
  ): { fn: string } | { expr: string } | { host: Call } {
    if (f === "Show") return { fn: this.show(c) };
    if (f === "Switch") return { fn: this.switchOf(c) };
    if (f === "Portal") return { expr: this.portal(c) };
    if (f === "Dynamic") return this.dynamicOf(c, svg);
    throw new ReactreCompileError("reactre: <Match> must be a child of <Switch>");
  }

  /**
   * `<Show when fallback keyed>`. Without `keyed`, a memo of whether `when` is truthy, so the
   * content is rebuilt only when that changes; a function child gets an accessor of the value.
   * With it, a memo of the value, so a new value rebuilds the content; a function child gets the
   * value. A `when` that calls nothing never changes: it is read once, with no memo.
   */
  private show(c: Call): string {
    const p = this.flowProps(c, "Show", ["when", "fallback", "keyed", "children"]);
    const [when, whenAt] = need(p, "when", "Show");
    const keyed = keyedOf(p, "Show");
    const w = this.rewrite(when, whenAt),
      fb = this.fallback(p),
      n = this.uid++,
      x = `__rrX${n}`;
    const kids = (arg: () => string) => this.content(this.kids(p), arg);
    if (!this.changes(when))
      return `((${x}) => () => (${x} ? ${kids(() => (keyed ? x : `() => ${x}`))} : ${fb}))(${w})`;
    if (keyed) {
      const v = `__rrV${n}`;
      return `(() => { const ${v} = __rrMemo(() => (${w})); return () => ((${x}) => (${x} ? ${kids(() => x)} : ${fb}))(${v}()); })()`;
    }
    const cond = `__rrC${n}`;
    return `(() => { const ${cond} = __rrMemo(() => !!(${w})); return () => (${cond}() ? ${kids(() => accessor(w))} : ${fb}); })()`;
  }

  /**
   * `<Switch fallback>` of `<Match when keyed>`: a memo of the first truthy match's index, so the
   * content is rebuilt only when another match becomes the first. With a keyed match the memo is
   * of [index, value] (the same array while neither changes), so that match's new value rebuilds
   * it too. The conditions are read in order, and only up to the first truthy one.
   */
  private switchOf(c: Call): string {
    const p = this.flowProps(c, "Switch", ["fallback", "children"]);
    const fb = this.fallback(p),
      n = this.uid++;
    const [memo, index, value, last, x] = ["M", "I", "V", "L", "X"].map((s) => `__rrS${s}${n}`) as [
      string,
      string,
      string,
      string,
      string,
    ];
    // Space between the matches, as JSX keeps it on one line, is not a child.
    const matches = this.kids(p)
      .filter(([k]) => !isNothing(k) && !(typeof literal(k) === "string" && !(literal(k) as string).trim()))
      .map(([k, at]) => {
        const m = this.only(k, at);
        if (m === null || this.kind(m.type) !== "Match")
          throw new ReactreCompileError(`reactre: <Switch> takes only <Match> children: ${k}`);
        const mp = this.flowProps(m, "Match", ["when", "keyed", "children"]);
        const [when, whenAt] = need(mp, "when", "Match");
        return { w: this.rewrite(when, whenAt), keyed: keyedOf(mp, "Match"), props: mp };
      });
    const keyed = matches.some((m) => m.keyed);
    const chain = matches
      .map((m, k) => (m.keyed ? `(${x} = (${m.w})) ? [${k}, ${x}]` : `(${m.w}) ? ${keyed ? `[${k}]` : k}`))
      .concat(keyed ? "[-1]" : "-1")
      .join(" : ");
    const cases = matches
      .map((m, k) => {
        const kids = this.content(this.kids(m.props), () => (m.keyed ? value : accessor(m.w)));
        return `case ${k}: return ${kids};`;
      })
      .join(" ");
    const pick = `switch (${keyed ? index : `${memo}()`}) { ${cases} default: return ${fb}; }`;
    if (!keyed) return `(() => { const ${memo} = __rrMemo(() => (${chain})); return () => { ${pick} }; })()`;
    return (
      `(() => { let ${x}, ${last} = []; const ${memo} = __rrMemo(() => { const ${index} = ${chain}; ` +
      `return ${index}[0] === ${last}[0] && ${index}[1] === ${last}[1] ? ${last} : (${last} = ${index}); }); ` +
      `return () => { const [${index}, ${value}] = ${memo}(); ${pick} }; })()`
    );
  }

  /**
   * `<Portal mount>`: the children inserted at the end of `mount` (read once, untracked), after
   * an anchor of their own, and taken out with it by a cleanup of the current owner. It renders
   * nothing where it is.
   */
  private portal(c: Call): string {
    const p = this.flowProps(c, "Portal", ["mount", "children"]);
    const mount = p.get("mount");
    const into = mount === undefined ? "document.body" : `(${this.rewrite(mount[0], mount[1])} ?? document.body)`;
    const kids = this.kids(p);
    if (kids.length === 1 && isFunction(kids[0]![0]))
      throw new ReactreCompileError(`reactre: <Portal>'s children are content, not a function: ${kids[0]![0]}`);
    return (
      `__rrUntrack(() => { const __rrA = ${into}.appendChild(document.createTextNode("")), ` +
      `__rrN = __rrInsert(__rrA, ${this.content(kids, null)}, null); ` +
      `__rrOnCleanup(() => { __rrInsert(__rrA, null, __rrN); __rrA.parentNode.removeChild(__rrA); }); return null; })`
    );
  }

  /**
   * `<Dynamic component {...props}>`. A tag name written as a string is that element, compiled
   * as if written out. Any other `component` is looked at when the content is built: a function
   * is called with the props, untracked, as a component is; a tag name builds its element, with
   * the props applied as spread props (followed when they call something) and the children
   * inserted; anything falsy renders nothing. A `component` that calls something is a slot.
   */
  private dynamicOf(c: Call, svg: boolean): { fn: string } | { expr: string } | { host: Call } {
    if (c.key !== undefined) throw new ReactreCompileError("reactre: <Dynamic> takes no key");
    const entries = this.object(c.props, true, c.propsAt);
    const comp = entries.find(([k]) => k === "component");
    if (comp === undefined) throw new ReactreCompileError("reactre: <Dynamic> needs component");
    const rest = entries.filter((e) => e !== comp);
    const raw = ([k, v]: readonly [string, string, number]) => (k === "..." ? v : `${JSON.stringify(k)}: ${v}`);
    const tag = literal(comp[1]);
    if (typeof tag === "string")
      return {
        host: {
          type: JSON.stringify(tag),
          props: `{ ${rest.map(raw).join(", ")} }`,
          key: undefined,
          typeAt: -1,
          propsAt: -1,
          keyAt: -1,
        },
      };
    const compiled = ([k, v, at]: readonly [string, string, number], spread: boolean) =>
      k === "..."
        ? this.rewrite(v, at)
        : `${JSON.stringify(k)}: ${spread ? spreadValue(k, this.rewrite(v, at)) : this.rewrite(v, at)}`;
    const props = this.passProps(rest) ?? `{ ${rest.map((e) => compiled(e, false)).join(", ")} }`;
    const attrs = rest.filter(([k]) => k !== "children"),
      kids = rest.find(([k]) => k === "children");
    const obj = `{ ${attrs.map((e) => compiled(e, true)).join(", ")} }`;
    const set =
      attrs.length === 0
        ? ""
        : attrs.some(([, v]) => this.changes(v))
          ? `__rrApply(__rrE, __rrSpread, () => (${obj})); `
          : `__rrSpread(__rrE, ${obj}, undefined); `;
    const put =
      kids === undefined
        ? ""
        : `__rrInsert(__rrE.appendChild(document.createTextNode("")), ${this.content(this.items(kids[1], kids[2]), null)}, null); `;
    const create = svg
      ? `document.createElementNS("http://www.w3.org/2000/svg", __rrD)`
      : "document.createElement(__rrD)";
    const build =
      `((__rrD) => __rrUntrack(() => typeof __rrD === "function" ? __rrD(${props}) : ` +
      `__rrD ? ((__rrE) => { ${set}${put}return __rrE; })(${create}) : null))(${this.rewrite(comp[1], comp[2])})`;
    return this.changes(comp[1]) ? { fn: `() => ${build}` } : { expr: build };
  }

  /**
   * The content of control flow's children, built where it shows. One element or component is
   * its own expression; text is a string; several children are a fragment's nodes.
   *
   * @param arg For a function child: the argument it is called with (an accessor, or the value),
   *   compiled only when used. A child that is a function literal is called with it, untracked;
   *   one that may be a function (a name, which calls nothing) is called when it is one. Null when
   *   the children are content only.
   */
  private content(children: readonly [string, number][], arg: (() => string) | null): string {
    const kept = children.filter(([x]) => !isNothing(x));
    if (kept.length === 0) return "null";
    if (kept.length === 1) {
      const [k, at] = kept[0]!;
      const lit = literal(k);
      if (typeof lit === "string" || typeof lit === "number") return this.m(at) + JSON.stringify("" + lit);
      const inner = this.only(k, at);
      if (inner !== null) return this.m(at) + this.call(inner);
      if (arg !== null && isFunction(k)) return `__rrUntrack(() => (${this.rewrite(k, at)})(${arg()}))`;
      if (arg !== null && !this.hasJsx(k) && !this.changes(k))
        return `((__rrK) => typeof __rrK === "function" ? __rrUntrack(() => __rrK(${arg()})) : __rrK)(${this.rewrite(k, at)})`;
    }
    return this.frag(kept);
  }

  /** A control flow element's props, checked against those it takes. */
  private flowProps(c: Call, name: Flow, takes: readonly string[]): Map<string, readonly [string, number]> {
    if (c.key !== undefined) throw new ReactreCompileError(`reactre: <${name}> takes no key`);
    const p = new Map<string, readonly [string, number]>();
    for (const [k, v, at] of this.object(c.props, false, c.propsAt)) {
      if (!takes.includes(k)) throw new ReactreCompileError(`reactre: <${name}> takes ${takes.join(", ")}, not ${k}`);
      p.set(k, [v, at]);
    }
    return p;
  }

  /** The children in control flow props, one source each. */
  private kids(p: ReadonlyMap<string, readonly [string, number]>): [string, number][] {
    const ch = p.get("children");
    return ch === undefined ? [] : this.items(ch[0], ch[1]);
  }

  /** The compiled `fallback` of control flow props: null when there is none. */
  private fallback(p: ReadonlyMap<string, readonly [string, number]>): string {
    const f = p.get("fallback");
    return f === undefined ? "null" : `(${this.rewrite(f[0], f[1])})`;
  }

  // #endregion
}

// #endregion

// #region Helpers

/** Whether src is one literal opened by `open` (`{` or `[`) and closed at its end. */
function isLiteral(src: string, open: "{" | "["): boolean {
  return src.startsWith(open) && until(src, 1, "") === src.length - 1;
}

/** Whether a child is a literal that renders nothing: null, undefined or a boolean. */
function isNothing(src: string): boolean {
  const lit = literal(src);
  return lit === null || lit === undefined || typeof lit === "boolean";
}

/**
 * A prop's value as spread props take it (`__spread`), which knows no class lists or ref arrays:
 * a class object or array literal is made its string, a ref array literal a function that gives
 * each ref the element.
 */
function spreadValue(k: string, v: string): string {
  if ((ALIASES[k] ?? k) === "class" && (isLiteral(v, "{") || isLiteral(v, "["))) return `__rrClass(${v})`;
  if (k === "ref" && isLiteral(v, "[")) return `(__rrE) => ${v}.forEach((__rrR) => __rrRef(__rrE, __rrR))`;
  return v;
}

/** A control flow prop that must be there. */
function need(p: ReadonlyMap<string, readonly [string, number]>, k: string, name: Flow): readonly [string, number] {
  const v = p.get(k);
  if (v === undefined) throw new ReactreCompileError(`reactre: <${name}> needs ${k}`);
  return v;
}

/** Whether control flow props have `keyed`, which must be written as a boolean: it decides what compiles. */
function keyedOf(p: ReadonlyMap<string, readonly [string, number]>, name: Flow): boolean {
  const k = p.get("keyed");
  if (k === undefined) return false;
  const lit = literal(k[0]);
  if (typeof lit !== "boolean")
    throw new ReactreCompileError(`reactre: <${name}>'s keyed must be written as true or false, not ${k[0]}`);
  return lit;
}

/**
 * The accessor a function child of a condition `w` (compiled) gets without `keyed`: a memo of
 * the value. It keeps the last truthy value, so content that has not yet been taken down when
 * the value turns falsy (its effects may run before the condition's) never reads a falsy one.
 */
function accessor(w: string): string {
  return `((__rrP) => __rrMemo(() => (__rrP = (${w}) || __rrP)))()`;
}

/**
 * Whether an expression may change: it calls something (a signal read). A `(` counts as a call
 * after a name, a literal, `)` or `]`; anywhere else it only groups.
 */
function reactive(expr: string): boolean {
  return callAt(expr, 0) >= 0;
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
      // A template literal's substitutions are code: `${count()}` calls.
      if (expr[i] === "`")
        for (let k = i + 1; k < j; k++) {
          if (expr[k] === "\\") k++;
          else if (expr[k] === "$" && expr[k + 1] === "{") {
            const close = until(expr, k + 2, "}");
            const at = callAt(expr.slice(0, close), k + 2);
            if (at >= 0) return at;
            k = close;
          }
        }
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
