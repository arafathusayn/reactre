// reactre-compat/compiler: a Bun plugin that compiles JSX trees of host
// elements into reactre-compat templates.
//
// Each .jsx and .tsx file of the app is transpiled by Bun (TypeScript
// stripped, JSX to the automatic runtime's `jsx("tr", { ... }, key)` calls,
// text already cleaned by JSX's whitespace rules and entities decoded). The
// plugin then finds every `jsx`/`jsxs` call whose type is a string and turns
// the largest tree of host elements under it into
//
//   __block(template, key, [hole values])
//
// with the template, a description of the static structure and where each
// hole sits, hoisted to module scope. Holes are attribute, style, event and
// child expressions; components, keyed or bailed elements, fragments and
// arrays stay ordinary jsx calls inside child holes (compiled in turn). The
// runtime (reactre-compat) builds each template once and clones it, and
// writes only the holes whose values changed, with React's semantics.
//
// A component element whose props are an object literal (no spread, key or
// ref) is built inline, as the object the runtime's jsx() would return:
//
//   jsx(Row, { row }, row.id)
//     -> (__hrP = { row }, { $$typeof: __hrE, type: Row, key: row.id === undefined ? null : "" + row.id,
//          ref: null, props: Row?.defaultProps == null ? __hrP : __hrDefaults(Row, __hrP) })
//
// Each call site then sees one type and one props shape, where jsx() sees
// every element of the app; a list's row elements cost an allocation each,
// not a polymorphic call (as Babel's inline-elements transform does for
// React).
//
// A list in a child hole, `items.map((item, i) => <Row ... />)`, becomes an
// indexed loop in place, with map's results (holes skipped, non-arrays left
// to their own map): the loop runs in the render function, which the engine
// optimizes as the loop runs, where a callback stays unoptimized until it
// has been called thousands of times.
//
// A host element is left to the plain runtime when its behavior depends on more
// than its attributes: spread props, refs, form fields and forms, document
// metadata, custom elements, dangerouslySetInnerHTML, autoFocus, and events
// that do not bubble or that React derives (enter and leave). Its children
// are still compiled where they qualify.
//
// Design decisions:
//   - When in doubt, the compiler leaves a call alone. An uncompiled jsx call is always correct
//     (the runtime's own jsx() builds the element), only slower, so every bail-out is safe.
//   - Bun's output is read as text with the scanner shared with reactre-compiler
//     (reactre-compiler/scan), not parsed: the jsx calls are all there is to find.
//   - Every name the output adds starts with `__hr`, so it cannot collide with the app's names,
//     and the free-name analysis below can tell the compiler's names from the app's.
//
//   Bun.build({ plugins: [reactreCompatCompiler()], ... })
//
// The output imports `react` and `react/jsx-runtime`, which the app aliases
// to reactre-compat; with React itself the compiled code would not run.

import type { BunPlugin } from "bun";
import { CLOSE, isIdent, literal, NOT_LITERAL, OPEN, skipToken, split, until } from "reactre-compiler/scan";

// #region Plugin

/** Options for the plugin. */
export interface CompilerOptions {
  /** Files to compile; default .jsx and .tsx outside node_modules. */
  readonly filter?: RegExp;
  /** Skip a file (by path) even if the filter matches. */
  readonly exclude?: (path: string) => boolean;
  /** Build component elements inline (default true). */
  readonly inlineElements?: boolean;
}

/**
 * The Bun plugin: compiles the app's JSX files. Files under node_modules are left to Bun, since
 * packages ship code built for React's own runtime.
 *
 * @example
 *   await Bun.build({
 *     entrypoints: ["./app/main.tsx"],
 *     outdir: "dist",
 *     plugins: [reactreCompatCompiler({ exclude: (path) => path.endsWith(".legacy.jsx") })],
 *   });
 */
export function reactreCompatCompiler(options: CompilerOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.[jt]sx$/;
  return {
    name: "reactre-compat-compiler",
    setup(build) {
      build.onLoad({ filter }, async ({ path }) => {
        if (path.includes("/node_modules/") || options.exclude?.(path)) return undefined;
        const source = await Bun.file(path).text();
        // The output is plain JavaScript: TypeScript and JSX are already gone.
        return { contents: compileSource(source, path.endsWith(".tsx") ? "tsx" : "jsx", options), loader: "js" };
      });
    },
  };
}

/**
 * Transpile one JSX or TSX source with Bun and compile its host element trees.
 *
 * @returns JavaScript that imports from `react` and `react/jsx-runtime` (aliased to reactre-compat).
 * @example
 *   const js = compileSource(`export const A = ({ n }) => <p className="x">{n}</p>;`, "jsx");
 *   // js holds `__hrTemplate(["p",{"className":"x"},0])` and `__hrBlock(__hrT0, null, [n])`.
 */
export function compileSource(source: string, loader: "jsx" | "tsx" = "tsx", options: CompilerOptions = {}): string {
  const t = new Bun.Transpiler({
    loader,
    tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
  } as ConstructorParameters<typeof Bun.Transpiler>[0]);
  return compileJs(t.transformSync(source), options);
}

// #endregion

// #region Compiling jsx calls

// #region What stays a jsx call

// Elements left to the plain runtime: form state, document metadata, scripts, and media (a
// video's `muted` is a DOM property the runtime sets apart from attributes).
const BAIL_TAGS = new Set([
  "input",
  "textarea",
  "select",
  "option",
  "form",
  "title",
  "meta",
  "link",
  "script",
  "style",
  "video",
  "audio",
]);
// Props that are more than an attribute: React gives each a behavior of its own (a ref gets the
// node, autoFocus focuses on mount, `is` changes how the element is created, the default* props
// set uncontrolled form state, action and formAction take functions), which the plain runtime has.
const BAIL_PROPS = new Set([
  "ref",
  "dangerouslySetInnerHTML",
  "suppressHydrationWarning",
  "suppressContentEditableWarning",
  "autoFocus",
  "is",
  "defaultValue",
  "defaultChecked",
  "action",
  "formAction",
]);
// Events with no delegated listener in the runtime: they would need one on the element. Some do
// not bubble (scroll, load, media events); enter and leave are derived by React from over and out.
const BAIL_EVENTS = new Set(
  (
    "onMouseEnter onMouseLeave onPointerEnter onPointerLeave onScroll onScrollEnd onLoad onError onAbort onToggle " +
    "onBeforeToggle onInvalid onCancel onClose onCanPlay onCanPlayThrough onDurationChange onEmptied onEncrypted " +
    "onEnded onLoadedData onLoadedMetadata onLoadStart onPause onPlay onPlaying onProgress onRateChange onResize " +
    "onSeeked onSeeking onStalled onSuspend onTimeUpdate onVolumeChange onWaiting"
  ).split(" "),
);

// #endregion

/**
 * A template's description, as JSON for the runtime's __template:
 * [tag, props (a hole is { h: index }), ...children (text, a hole index, an element)].
 * Props are 0 when there are none, which keeps the JSON short.
 */
type Desc = [string, Record<string, unknown> | 0, ...(string | number | Desc)[]];

/** One jsx call, as source text. */
interface Call {
  /** The helper's local name, to rebuild the call when it is not compiled. */
  helper: string;
  multi: boolean; // jsxs: children is a static array
  /** The arguments, as source: type, props, then the key when there is one. */
  args: string[];
}

/**
 * Compiles the jsx calls of one file. It collects what goes to module scope (templates and list
 * loops) and counts inlined elements, so compileJs imports only the runtime helpers in use.
 */
class Compiler {
  readonly src: string;
  readonly helpers: Map<string, boolean>; // local name -> is jsxs
  /** Hoisted template declarations. */
  readonly templates: string[] = [];
  /** Hoisted list loops. */
  readonly loops: string[] = [];
  /** How many component elements were built inline. */
  inlined = 0;
  readonly inlineElements: boolean;
  constructor(src: string, helpers: Map<string, boolean>, inlineElements: boolean) {
    this.inlineElements = inlineElements;
    this.src = src;
    this.helpers = helpers;
  }

  // #region Finding jsx calls

  /**
   * Rewrite src: every jsx call in it, compiled where it qualifies. The walk is `until`'s, copying
   * as it goes, so the code around the calls comes out unchanged.
   */
  rewrite(src: string): string {
    let out = "",
      i = 0,
      prev = "",
      word = "";
    while (i < src.length) {
      const c = src[i]!;
      const j = skipToken(src, i, prev, word);
      if (j !== i) {
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
        // A helper's name as a property (`x.jsx_...(`) is some other function.
        if (this.helpers.has(name) && src[e] === "(" && src[i - 1] !== ".") {
          const close = until(src, e + 1, "");
          const call: Call = { helper: name, multi: this.helpers.get(name)!, args: split(src, e + 1, close) };
          out += this.call(call);
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
      }
      out += c;
      i++;
    }
    return out;
  }

  /**
   * A jsx call: a block if it is a host element that compiles, else an inline element when it is
   * a component element that qualifies, else the call with its arguments rewritten.
   */
  call(c: Call): string {
    const values: string[] = [];
    const desc = this.element(c, true, values);
    if (desc === null)
      return (
        (this.inlineElements ? this.inline(c) : null) ?? `${c.helper}(${c.args.map((a) => this.rewrite(a)).join(", ")})`
      );
    const id = `__hrT${this.templates.length}`;
    this.templates.push(`const ${id} = __hrTemplate(${JSON.stringify(desc)});`);
    const key = c.args[2] !== undefined && c.args[2] !== "undefined" ? c.args[2] : "null";
    return `__hrBlock(${id}, ${key}, [${values.join(", ")}])`;
  }

  // #endregion

  // #region Host elements

  /**
   * The template of a host element, adding its holes' expressions to values, or null when it must
   * stay a jsx call. On null, `values` is as it was: holes pushed before the bail-out are dropped.
   *
   * @param root Whether this is the tree's root. Only the root may carry a key (the block's key).
   *   A keyed element inside the tree stays a jsx call in a hole, so React's key rules apply to it.
   */
  element(c: Call, root: boolean, values: string[]): Desc | null {
    const [type, props, key] = c.args;
    if (type === undefined || type[0] !== '"') return null;
    const tag = JSON.parse(type) as string;
    // A dash marks a custom element, whose props may be properties rather than attributes.
    if (tag.includes("-") || BAIL_TAGS.has(tag)) return null;
    if (!root && key !== undefined && key !== "undefined") return null;
    const entries = this.object(props ?? "{}");
    if (entries === null) return null;
    const ps: Record<string, unknown> = {};
    let children: string[] = [];
    const mark = values.length;
    for (const [name, value] of entries) {
      if (name === "children") {
        // Only jsxs passes a static array of children. Under jsx an array literal is one child
        // whose value is an array, which React renders as a list.
        children =
          c.multi && value.startsWith("[") && value.endsWith("]") ? split(value, 1, value.length - 1) : [value];
        continue;
      }
      if (BAIL_PROPS.has(name) || name === "key") return this.undo(values, mark);
      if (/^on[A-Z]/.test(name) && BAIL_EVENTS.has(name.endsWith("Capture") ? name.slice(0, -7) : name))
        return this.undo(values, mark);
      const lit = literal(value);
      if (lit !== NOT_LITERAL) {
        // A prop set to undefined is the same as no prop.
        if (lit !== undefined) ps[name] = lit;
      } else {
        ps[name] = { h: values.length };
        values.push(this.rewrite(value));
      }
    }
    const desc: Desc = [tag, Object.keys(ps).length ? ps : 0];
    for (const item of children) {
      const lit = literal(item);
      if (typeof lit === "string" || typeof lit === "number") {
        desc.push("" + lit);
        continue;
      }
      if (lit === null || typeof lit === "boolean" || (lit === undefined && item === "undefined")) continue;
      const inner = this.parseCall(item);
      if (inner !== null) {
        const m = values.length;
        const d = this.element(inner, false, values);
        if (d !== null) {
          desc.push(d);
          continue;
        }
        // The child stays a call: drop any holes it added, and make it one hole of this element.
        values.length = m;
      }
      desc.push(values.length);
      values.push(this.loop(item) ?? this.rewrite(item));
    }
    return desc;
  }

  // #endregion

  // #region Component elements

  /**
   * A component element as an inline object literal, or null when it must stay a jsx call: a
   * computed type, props that are not a plain object literal, or a key or ref in them.
   *
   * The output reads `type` three times, so it must be a name or a dotted path (PATH), which has
   * no side effects to repeat. `__hrP` holds the props for the moment between building
   * them and reading them back, so no closure or helper call is needed.
   */
  inline(c: Call): string | null {
    const [type, props, key, ...rest] = c.args;
    // Extra arguments are not the automatic runtime's call shape: leave the call to the runtime.
    if (type === undefined || props === undefined || rest.length) return null;
    if (!PATH.test(type) || type === "undefined" || type === "null") return null;
    const entries = this.object(props);
    // jsx() treats these apart from props: `ref` is mirrored on the element, and the classic JSX
    // transform's debug props __self and __source are dropped.
    if (entries === null || entries.some(([k]) => k === "key" || k === "ref" || k === "__self" || k === "__source"))
      return null;
    let k: string;
    if (key === undefined || key === "undefined") k = "null";
    else {
      const lit = literal(key);
      // A name is read twice; any other expression goes through __hrKey once.
      k =
        typeof lit === "string" || typeof lit === "number"
          ? JSON.stringify("" + lit)
          : PATH.test(key)
            ? `${key} === undefined ? null : "" + ${key}`
            : `__hrKey(${this.rewrite(key)})`;
    }
    this.inlined++;
    // The fields in jsx()'s order, so inline and runtime elements share one shape in the engine.
    return `(__hrP = ${this.rewrite(props)}, { $$typeof: __hrE, type: ${type}, key: ${k}, ref: null, props: ${type}?.defaultProps == null ? __hrP : __hrDefaults(${type}, __hrP) })`;
  }

  // #endregion

  // #region List loops

  /**
   * `xs.map(arrow)` with an expression-bodied arrow of plain parameters as a call of a loop
   * hoisted to module scope, or null. The loop takes the body's free names as arguments: a module
   * function keeps its optimized code across garbage collections, where a closure made per render
   * loses it at each one. Bodies that could notice the move are left alone: functions, this,
   * arguments, await, yield, assignments.
   *
   * The call keeps map's meaning: a non-array receiver gets its own map called, and holes in the
   * array stay holes in the result.
   */
  loop(src: string): string | null {
    // The last `.map(` whose call closes at the very end of src, with no top-level comma or
    // semicolon before it: src is then exactly `receiver.map(...)`.
    const m = /\.map\(/g;
    let at = -1;
    for (let x; (x = m.exec(src)) !== null;) {
      const close = until(src, x.index + 5, "");
      if (close === src.length - 1 && until(src.slice(0, x.index), 0, ",;") === x.index) at = x.index;
    }
    if (at <= 0) return null;
    const recv = src.slice(0, at).trim();
    const arrow = src.slice(at + 5, -1).trim();
    const am = /^(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*/.exec(arrow);
    if (am === null) return null;
    const body = arrow.slice(am[0].length).trim();
    // A block body would need its returns rewritten; a comma after the arrow is map's thisArg.
    if (body.startsWith("{") || until(arrow, am[0].length, ",") !== arrow.length) return null;
    // At most map's three parameters (value, index, array), each a plain name (no destructuring
    // or defaults).
    const params = am[1] !== undefined ? split(am[1], 0, am[1].length) : [am[2]!];
    if (params.length > 3 || params.some((q) => !/^[A-Za-z_$][\w$]*$/.test(q))) return null;
    const b = this.rewrite(body);
    const free = freeNames(b);
    // Compiled once: left as a map, with the body already compiled.
    if (free === null) return `${this.rewrite(recv)}.map(${arrow.slice(0, am[0].length)}${b})`;
    const args = [...free].filter((x) => !params.includes(x));
    const [p0, p1, p2] = params;
    const decl =
      (p0 !== undefined ? `const ${p0} = __hrV; ` : "") +
      (p1 !== undefined ? `const ${p1} = __hrI; ` : "") +
      (p2 !== undefined ? `const ${p2} = __hrXs; ` : "");
    const id = `__hrL${this.loops.length}`;
    const memo = this.rowMemo(body, params, id);
    if (memo !== null) {
      const margs = memo.args;
      return (
        `(Array.isArray(__hrM = ${this.rewrite(recv)}) ? ${id}(__hrM${margs.map((x) => ", " + x).join("")}) : ` +
        `__hrM.map((${params.join(", ")}) => ${b}))`
      );
    }
    // A hole reads as undefined, so the `in` check runs only for undefined values.
    this.loops.push(
      `function ${id}(__hrXs${args.map((x) => ", " + x).join("")}) { ` +
        `const __hrN = __hrXs.length, __hrOut = new Array(__hrN); ` +
        `for (let __hrI = 0; __hrI < __hrN; __hrI++) { const __hrV = __hrXs[__hrI]; ` +
        `if (__hrV === undefined && !(__hrI in __hrXs)) continue; ${decl}__hrOut[__hrI] = ${b}; } ` +
        `return __hrOut; }`,
    );
    return (
      `(Array.isArray(__hrM = ${this.rewrite(recv)}) ? ${id}(__hrM${args.map((x) => ", " + x).join("")}) : ` +
      `__hrM.map((${params.join(", ")}) => ${b}))`
    );
  }

  /**
   * A loop whose body is one component element (a list's rows), with the elements memoized by
   * position (or one over): a row whose key, type and props are the same as last time (by
   * Object.is) gets last time's element, which the runtime then bails out on by identity, as React
   * Compiler's memoized JSX does. Pushes the loop and returns its arguments, or null.
   *
   * The cache belongs to the call site, not to a component instance. That stays correct: an
   * element is reused only when it equals what would be built, and the runtime ignores a report
   * (__hrDelta) for a list its slot did not render last.
   */
  rowMemo(body: string, params: string[], id: string): { args: string[] } | null {
    let src = body.trim();
    while (src.startsWith("(") && until(src, 1, "") === src.length - 1) src = src.slice(1, -1).trim();
    const c = this.parseCall(src);
    if (c === null) return null;
    const [type, props, key, ...rest] = c.args;
    if (
      type === undefined ||
      props === undefined ||
      rest.length ||
      !PATH.test(type) ||
      type === "undefined" ||
      type === "null"
    )
      return null;
    const entries = this.object(props);
    // With no props there is nothing to compare, so no cache is worth keeping.
    if (entries === null || entries.length === 0) return null;
    if (entries.some(([k]) => k === "key" || k === "ref" || k === "__self" || k === "__source")) return null;
    const values = entries.map(([, v]) => this.rewrite(v));
    const k = key === undefined || key === "undefined" ? "undefined" : this.rewrite(key);
    const free = freeNames([type, k, ...values].join(", "));
    if (free === null) return null;
    const args = [...free].filter((x) => !params.includes(x));
    const [p0, p1, p2] = params;
    const decl =
      (p0 !== undefined ? `const ${p0} = __hrV; ` : "") +
      (p1 !== undefined ? `const ${p1} = __hrI; ` : "") +
      (p2 !== undefined ? `const ${p2} = __hrXs; ` : "");
    // A prop name as a member access and as an object literal key.
    const prop = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);
    const lit = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
    // Each prop value is evaluated once into __hra<i>, then compared with the cached element's.
    const vals = values.map((v, i) => `__hra${i} = ${v}`).join(", ");
    const same = entries.map(([name], i) => ` && Object.is(__hrc.props${prop(name)}, __hra${i})`).join("");
    const fresh =
      `(__hrP = { ${entries.map(([name], i) => `${lit(name)}: __hra${i}`).join(", ")} }, ` +
      `{ $$typeof: __hrE, type: ${type}, key: __hrk === undefined ? null : "" + __hrk, ref: null, ` +
      `props: ${type}?.defaultProps == null ? __hrP : __hrDefaults(${type}, __hrP) })`;
    // Last render's elements (__hrC<n>) and keys (__hrK<n>), one pair per call site.
    const cache = id.replace("__hrL", "__hrC"),
      keys = id.replace("__hrL", "__hrK");
    this.inlined++;
    this.loops.push(
      `let ${cache} = [], ${keys} = [];\n` +
        `function ${id}(__hrXs${args.map((x) => ", " + x).join("")}) { ` +
        `const __hrN = __hrXs.length, __hrOut = new Array(__hrN), __hrKs = new Array(__hrN), __hrPv = ${cache}, __hrPk = ${keys}; ` +
        // The indexes whose element is not last time's at the same place, while they are few and
        // the list keeps its length and has no holes. Past half the list the report is dropped,
        // and the runtime reconciles the whole list.
        `let __hrD = __hrN === __hrPv.length ? [] : null; ` +
        `for (let __hrI = 0; __hrI < __hrN; __hrI++) { const __hrV = __hrXs[__hrI]; ` +
        `if (__hrV === undefined && !(__hrI in __hrXs)) { __hrD = null; continue; } ${decl}` +
        `const ${vals}; const __hrk = ${k}; __hrKs[__hrI] = __hrk; ` +
        // Last time's element at this position, or one place over (a row
        // removed or added before it), by key.
        `const __hrc = __hrPk[__hrI] === __hrk ? __hrPv[__hrI] : __hrPk[__hrI + 1] === __hrk ? __hrPv[__hrI + 1] : ` +
        `__hrI > 0 && __hrPk[__hrI - 1] === __hrk ? __hrPv[__hrI - 1] : undefined; ` +
        `const __hre = __hrOut[__hrI] = __hrc !== undefined && __hrc.type === ${type}${same} ? __hrc : ${fresh}; ` +
        `if (__hrD !== null && __hre !== __hrPv[__hrI] && __hrD.push(__hrI) > __hrN >> 1) __hrD = null; } ` +
        `if (__hrD !== null) __hrDelta(__hrOut, __hrPv, __hrD); ` +
        `${cache} = __hrOut; ${keys} = __hrKs; return __hrOut; }`,
    );
    return { args };
  }

  // #endregion

  // #region Parsing helpers

  /** Drop the holes pushed since `mark`; returns null so a bail-out is `return this.undo(...)`. */
  undo(values: string[], mark: number): null {
    values.length = mark;
    return null;
  }

  /** `helper(args)` as a whole expression, or null. */
  parseCall(src: string): Call | null {
    const m = /^([\w$]+)\(/.exec(src);
    if (m === null || !this.helpers.has(m[1]!)) return null;
    const close = until(src, m[0].length, "");
    if (close !== src.length - 1) return null;
    return { helper: m[1]!, multi: this.helpers.get(m[1]!)!, args: split(src, m[0].length, close) };
  }

  /**
   * The entries of an object literal with plain keys, as [name, value source] pairs, or null
   * (spreads, computed keys, methods). A quoted key is decoded.
   */
  object(src: string): [string, string][] | null {
    const s = src.trim();
    if (!s.startsWith("{") || !s.endsWith("}")) return null;
    const out: [string, string][] = [];
    for (const part of split(s, 1, s.length - 1)) {
      if (part.startsWith("...")) return null;
      const colon = until(part, 0, ":");
      if (colon >= part.length) {
        // No colon: a shorthand, or a method, which fails the name test.
        if (!/^[\w$]+$/.test(part)) return null;
        out.push([part, part]); // shorthand
        continue;
      }
      let k = part.slice(0, colon).trim();
      if (k.startsWith('"')) k = JSON.parse(k) as string;
      else if (!/^[\w$]+$/.test(k)) return null;
      out.push([k, part.slice(colon + 1).trim()]);
    }
    return out;
  }

  // #endregion
}

// #endregion

// #region Free names

// Words that are not names of variables to pass: keywords that may appear in an expression, and
// common globals, which the hoisted loop reads itself.
const NOT_NAMES = new Set(
  (
    "true false null undefined typeof void new delete in instanceof of if else return " +
    "NaN Infinity Symbol Object Array String Number Boolean Math JSON Date"
  ).split(" "),
);
// Words whose meaning depends on the enclosing function or block, so a body using them cannot move.
const BAIL_WORDS = new Set([
  "this",
  "arguments",
  "await",
  "yield",
  "function",
  "class",
  "super",
  "import",
  "var",
  "let",
  "const",
]);

/**
 * The free variable names an expression reads, in first-use order, or null when moving it out of
 * its function could change what it does: it defines functions, assigns, or uses this,
 * arguments, await or yield. Names the compiler made (__hr...) are module-level and left out.
 *
 * Property names (after a dot) and object literal keys are not variables, so they are skipped.
 */
function freeNames(src: string): Set<string> | null {
  if (src.includes("=>")) return null;
  const out = new Set<string>();
  // The open brackets around the current position, so a name is taken as a key only inside braces.
  const stack: string[] = [];
  let prev = "",
    word = "";
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    const j = skipToken(src, i, prev, word);
    if (j !== i) {
      prev = "a";
      word = "";
      i = j;
      continue;
    }
    if (isIdent(c) && !/[0-9]/.test(c)) {
      let e = i;
      while (isIdent(src[e])) e++;
      const name = src.slice(i, e);
      if (BAIL_WORDS.has(name)) return null;
      let k = e;
      while (/\s/.test(src[k] ?? "")) k++;
      const member = prev === ".";
      // An object literal's key: after { or , inside braces, before a colon.
      const key = src[k] === ":" && (prev === "{" || prev === ",") && stack.at(-1) === "{";
      if (!member && !key && !NOT_NAMES.has(name) && !name.startsWith("__hr")) out.add(name);
      prev = "a";
      word = name;
      i = e;
      continue;
    }
    if (isIdent(c)) {
      // A number, with its decimal point.
      while (isIdent(src[i]) || src[i] === ".") i++;
      prev = "a";
      continue;
    }
    // A lone `=`: not part of ==, ===, !=, <= or >=.
    if (c === "=" && src[i + 1] !== "=" && prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">") {
      // An assignment, unless the compiler's own temporary takes it.
      if (!/__hr[A-Za-z]\s*$/.test(src.slice(0, i))) return null;
    }
    // ++ and -- assign too.
    if ((c === "+" || c === "-") && src[i + 1] === c) return null;
    if (OPEN.includes(c)) stack.push(c);
    else if (CLOSE.includes(c)) stack.pop();
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
    }
    i++;
  }
  return out;
}

// A name or a dotted path of names (no calls, no computed members).
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

// #endregion

// #region Compiling a file

/**
 * Compile Bun's automatic-runtime output: host element trees become templates.
 *
 * @returns `js` unchanged when it uses no JSX helpers; otherwise the compiled code, after the
 *   imports it needs and the hoisted templates, loops and temporaries.
 */
export function compileJs(js: string, options: CompilerOptions = {}): string {
  // Bun's transpiler leaves the runtime's helpers as unbound names with a
  // hash suffix (jsx_w77yafs4, jsxs_..., Fragment_...), bound only when it
  // bundles JSX itself. This output is plain JavaScript, so import them.
  const helpers = new Map<string, boolean>(); // local name -> is jsxs
  const imports = new Map<string, string>(); // local name -> export
  for (const m of js.matchAll(/\b(jsxs|jsx|jsxDEV|Fragment)_[a-z0-9]{8}\b/g)) {
    imports.set(m[0], m[1]!);
    if (m[1] === "jsx" || m[1] === "jsxs") helpers.set(m[0], m[1] === "jsxs");
  }
  if (imports.size === 0) return js;
  const c = new Compiler(js, helpers, options.inlineElements ?? true);
  const body = c.rewrite(js);
  // The runtime import stays even when every call compiled: an uncompiled call or a Fragment may
  // still use it.
  const runtime = `import { ${[...imports].map(([local, name]) => `${name} as ${local}`).join(", ")} } from "react/jsx-runtime";\n`;
  if (c.templates.length === 0 && c.inlined === 0 && c.loops.length === 0) return runtime + body;
  // Only the helpers the output uses are imported.
  const names = [
    ...(c.templates.length ? ["__template as __hrTemplate", "__block as __hrBlock"] : []),
    ...(c.inlined ? ["__defaults as __hrDefaults", "__key as __hrKey"] : []),
    ...(c.loops.some((l) => l.includes("__hrDelta(")) ? ["__delta as __hrDelta"] : []),
  ];
  // Module-level temporaries shared by every call site: each use reads its value back before any
  // other code can assign it. __hrE is React 19's element marker.
  const inline =
    (c.inlined ? `let __hrP;\nconst __hrE = Symbol.for("react.transitional.element");\n` : "") +
    (c.loops.length ? `let __hrM;\n${c.loops.join("\n")}\n` : "");
  const fromReact = names.length ? `import { ${names.join(", ")} } from "react";\n` : "";
  return `${runtime}${fromReact}${inline}${c.templates.join("\n")}${c.templates.length ? "\n" : ""}${body}`;
}

// #endregion
