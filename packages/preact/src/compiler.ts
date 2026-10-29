// @reactre/preact/compiler: a Bun plugin that compiles the JSX of .jsx and .tsx files into
// @reactre/preact's templates (src/block.ts).
//
// Bun transpiles each file (TypeScript stripped, JSX to the automatic runtime's
// `jsx("tr", { ... }, key)` calls). Every `jsx`/`jsxs` call whose type is a host tag then becomes
//
//   __block(template, key, [hole values])
//
// with the template, its static structure and where each hole sits, hoisted to module scope.
// Nothing is added at run time that the JSX did not already cost: the template is built once
// and cloned, and a render compares hole values where the plain runtime would diff a vnode per
// element.
//
// The output renders what Preact renders for the same JSX:
//   - A prop is static when it is a literal, else a hole. Both are written with Preact's
//     setProperty, by the same `in` rule.
//   - An element's children are inlined into the template only when every one is static: text,
//     or a host element that compiles. Otherwise the element gets one children hole whose value
//     is its `props.children` as JSX builds it (`[a, "b", <c/>]`, the static elements compiled
//     in turn), diffed by Preact's diffChildren: keys, types, placement and component state
//     behave as without the compiler.
//   - Host elements whose behavior depends on more than their attributes stay jsx calls: refs,
//     keys inside a tree, spread props, dangerouslySetInnerHTML, `is`, value and checked, form
//     fields, templates, noscript and custom elements. Their children are still compiled.
// When in doubt the compiler leaves a call alone: an uncompiled call is always correct.
//
//   Bun.build({ plugins: [reactrePreactCompiler({ source: "react" })], ... })

import { isIdent, literal, NOT_LITERAL, skipToken, split, until } from "@reactre/compiler/scan";
import type { BunPlugin } from "bun";

import { ALWAYS, entrySource, offKeys, SOURCES, usedApis } from "./api.ts";
import { BAIL_PROPS, BAIL_TAGS, reactName, reactValue, UNCLONED } from "./rules.ts";

// #region Plugin

/** Options for the plugin. */
export interface CompilerOptions {
  /** Files to compile; default .jsx and .tsx outside node_modules. */
  readonly filter?: RegExp;
  /** Skip a file (by path) even if the filter matches. */
  readonly exclude?: (path: string) => boolean;
  /**
   * The module the app imports JSX from: "preact" (aliased to @reactre/preact/core) or "react"
   * (aliased to @reactre/preact/compat). Default "preact".
   */
  readonly source?: "preact" | "react";
  /**
   * APIs to switch off, by the name an app imports (useEffect, createPortal, Component) or a
   * group (@classes, @suspense, @transitions); see src/api.ts. With any off, the plugin resolves
   * `preact`, `preact/hooks`, `preact/compat` and `react` itself, each switched-off name throws,
   * and a module that imports one fails the build. "Component" switches class support off.
   */
  readonly off?: readonly string[];
}

const SRC = import.meta.dir;

/**
 * The Bun plugin: compiles the app's JSX files (node_modules is left to Bun), and switches off
 * the APIs `off` names.
 */
export function reactrePreactCompiler(options: CompilerOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.[jt]sx$/;
  const compile = (source: string, path: string) => ({
    contents: compileSource(source, path.endsWith(".tsx") ? "tsx" : "jsx", options),
    loader: "js" as const,
  });
  const skip = (path: string) => path.includes("/node_modules/") || !!options.exclude?.(path);
  return {
    name: "@reactre/preact/compiler",
    setup(build) {
      if (!options.off?.length) {
        build.onLoad({ filter }, async ({ path }) =>
          skip(path) ? undefined : compile(await Bun.file(path).text(), path),
        );
        return;
      }
      const exports = {
        core: Object.keys(require(`${SRC}/core.ts`)),
        compat: Object.keys(require(`${SRC}/compat.ts`)),
      };
      const off = offKeys(options.off, new Set([...exports.core, ...exports.compat].filter((k) => !ALWAYS.has(k))));
      build.onResolve({ filter: SOURCES }, ({ path }) => ({
        path: /^preact(\/hooks)?$/.test(path) ? "core" : "compat",
        namespace: "reactre-preact-off",
      }));
      build.onLoad({ filter: /^(core|compat)$/, namespace: "reactre-preact-off" }, ({ path }) => ({
        contents: entrySource(`${SRC}/${path}.ts`, exports[path as "core" | "compat"], off),
        loader: "js",
      }));
      // Class support off: the class-only code of the engine and compat goes, by their constant.
      if (off.has("Component"))
        build.onLoad({ filter: /(engine|compat)\.ts$/ }, async ({ path }) =>
          path === `${SRC}/engine.ts` || path === `${SRC}/compat.ts`
            ? {
                // Bun folds the constant inside functions, but not in a top-level `if`: that one
                // is rewritten too.
                contents: (await Bun.file(path).text())
                  .replace(/const (CLASSES\w*): boolean = true;/, "const $1: boolean = false;")
                  .replace("if (CLASSES_COMPAT)", "if (false)"),
                loader: "ts",
              }
            : undefined,
        );
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        // Component stays importable with class support off (instanceof checks, a class never
        // rendered); a class that renders throws.
        for (const k of usedApis(source, path))
          if (off.has(k) && k != "Component")
            throw new Error(`${path}: uses ${k}, which @reactre/preact/compiler's off option switches off.`);
        return filter.test(path) && !skip(path) ? compile(source, path) : undefined;
      });
    },
  };
}

/**
 * Transpile one JSX or TSX source with Bun and compile its host element trees.
 *
 * @example
 *   compileSource(`export const A = ({ n }) => <p class="x">{n}</p>;`, "jsx");
 *   // holds `__template(["p",{"class":"x"},0])` and `__block(__hrT0, undefined, [n])`.
 */
export function compileSource(source: string, loader: "jsx" | "tsx" = "tsx", options: CompilerOptions = {}): string {
  const from = options.source ?? "preact";
  const t = new Bun.Transpiler({
    loader,
    tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: from } },
  } as ConstructorParameters<typeof Bun.Transpiler>[0]);
  return compileJs(t.transformSync(source), from);
}

// #endregion

// #region Compiling

/** A template description: [tag, props (a hole is [index]) or 0, ...children]. */
type Desc = [string, Record<string, unknown> | 0, ...(string | number | Desc)[]];

/** One jsx call: its helper's local name, whether it is jsxs, and its arguments as source. */
interface Call {
  helper: string;
  multi: boolean;
  args: string[];
}

class Compiler {
  readonly templates: string[] = [];
  readonly helpers: Map<string, boolean>;
  /** Compiling for compat ("react"), whose vnode hook writes class after every other prop. */
  readonly react: boolean;
  constructor(helpers: Map<string, boolean>, react: boolean) {
    this.helpers = helpers;
    this.react = react;
  }

  /** `src` with every jsx call in it compiled where it qualifies; the code around is copied. */
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
        if (this.helpers.has(name) && src[e] === "(" && src[i - 1] !== ".") {
          const close = until(src, e + 1, "");
          out += this.call({ helper: name, multi: this.helpers.get(name)!, args: split(src, e + 1, close) });
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

  /** A jsx call as a block when it is a host element that compiles, else with its arguments compiled. */
  call(c: Call): string {
    const values: string[] = [];
    const desc = this.element(c, true, values);
    if (desc === null) return `${c.helper}(${c.args.map((a) => this.rewrite(a)).join(", ")})`;
    const json = JSON.stringify(desc);
    // Identical templates share one declaration.
    let id = this.templates.findIndex((t) => t === json);
    if (id < 0) id = this.templates.push(json) - 1;
    const key = c.args[2] ?? "undefined";
    return `__hrBlock(__hrT${id}, ${key}, [${values.join(", ")}])`;
  }

  /**
   * The template of a host element, its holes' expressions pushed onto `values`, or null when it
   * stays a jsx call (with `values` as it was).
   */
  element(c: Call, root: boolean, values: string[]): Desc | null {
    const [type, props, key, ...rest] = c.args;
    if (type === undefined || type[0] !== '"' || rest.length) return null;
    const tag = JSON.parse(type) as string;
    if (tag.includes("-") || BAIL_TAGS.has(tag)) return null;
    // Only the root carries a key, as the block's.
    if (!root && key !== undefined) return null;
    const entries = object(props ?? "{}");
    if (entries === null) return null;
    if (entries.some(([k]) => k === "class") && entries.some(([k]) => k === "className")) return null;
    // compat's vnode hook moves class (or className) after every other prop.
    const isClass = (k: string) => +(k === "class" || k === "className");
    if (this.react) entries.sort((a, b) => isClass(a[0]) - isClass(b[0]));
    // Props are written in key order: once one is a hole, the literals after it are holes too,
    // so attributes keep the order Preact gives them.
    let dynamic = false;
    const mark = values.length;
    const ps: Record<string, unknown> = {};
    let children: string[] = [];
    let single = true;
    for (const [name, value] of entries) {
      if (name === "children") {
        // Only jsxs passes a static array of children; under jsx an array is one child.
        single = !(c.multi && value.startsWith("[") && value.endsWith("]"));
        children = single ? [value] : split(value, 1, value.length - 1);
        continue;
      }
      if (BAIL_PROPS.has(name)) {
        values.length = mark;
        return null;
      }
      // Under compat, the template holds the names compat's vnode hook gives, and literals its values.
      const key = this.react ? reactName(name) : name;
      let lit = literal(value);
      if (this.react) lit = reactValue(key, lit);
      if (!dynamic && !UNCLONED.has(name) && lit !== NOT_LITERAL && (lit === null || typeof lit !== "object")) {
        // A prop set to undefined is no prop.
        if (lit !== undefined) ps[key] = lit;
      } else {
        dynamic = true;
        ps[key] = [values.length];
        values.push(this.rewrite(value));
      }
    }
    const desc: Desc = [tag, Object.keys(ps).length ? ps : 0];
    if (!children.length) return desc;
    // Every child static (text, or a host element that compiles): inline them all.
    const statics: (string | Desc)[] = [];
    const m = values.length;
    let inline = true;
    for (const item of children) {
      const lit = literal(item);
      if (typeof lit === "string" || typeof lit === "number") statics.push("" + lit);
      else if (!isEmpty(item)) {
        const inner = this.parseCall(item);
        const d = inner && this.element(inner, false, values);
        if (!d) {
          inline = false;
          break;
        }
        statics.push(d);
      }
    }
    if (inline) {
      desc.push(...statics);
      return desc;
    }
    // A children hole: the value JSX gives props.children, its host elements compiled.
    values.length = m;
    desc.push(values.length);
    values.push(single ? this.rewrite(children[0]!) : `[${children.map((x) => this.rewrite(x)).join(", ")}]`);
    return desc;
  }

  /** `helper(args)` as a whole expression, or null. */
  parseCall(src: string): Call | null {
    const m = /^([\w$]+)\(/.exec(src);
    if (m === null || !this.helpers.has(m[1]!)) return null;
    const close = until(src, m[0].length, "");
    if (close !== src.length - 1) return null;
    return { helper: m[1]!, multi: this.helpers.get(m[1]!)!, args: split(src, m[0].length, close) };
  }
}

/** Whether a child expression renders nothing: null, undefined or a boolean literal. */
function isEmpty(src: string): boolean {
  const lit = literal(src);
  return lit === null || typeof lit === "boolean" || (lit === undefined && src === "undefined");
}

/**
 * The entries of an object literal with plain keys, as [name, value source] pairs, or null
 * (spreads, computed keys, methods). A quoted key is decoded.
 */
function object(src: string): [string, string][] | null {
  const s = src.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const out: [string, string][] = [];
  for (const part of split(s, 1, s.length - 1)) {
    if (part.startsWith("...")) return null;
    const colon = until(part, 0, ":");
    if (colon >= part.length) {
      if (!/^[\w$]+$/.test(part)) return null;
      out.push([part, part]);
      continue;
    }
    let k = part.slice(0, colon).trim();
    if (k.startsWith('"')) k = JSON.parse(k) as string;
    else if (!/^[\w$]+$/.test(k)) return null;
    out.push([k, part.slice(colon + 1).trim()]);
  }
  return out;
}

/**
 * Compile Bun's automatic-runtime output: host element trees become templates.
 *
 * @returns `js` unchanged when it has no JSX; else the compiled code after its imports and templates.
 */
export function compileJs(js: string, from: "preact" | "react" = "preact"): string {
  // Bun leaves the runtime's helpers as unbound names with a hash suffix (jsx_w77yafs4): import them.
  const helpers = new Map<string, boolean>();
  const imports = new Map<string, string>();
  for (const m of js.matchAll(/\b(jsxs|jsx|jsxDEV|Fragment)_[a-z0-9]{8}\b/g)) {
    imports.set(m[0], m[1]!);
    if (m[1] === "jsx" || m[1] === "jsxs") helpers.set(m[0], m[1] === "jsxs");
  }
  if (imports.size === 0) return js;
  const c = new Compiler(helpers, from === "react");
  const body = c.rewrite(js);
  const runtime = `import { ${[...imports].map(([local, name]) => `${name} as ${local}`).join(", ")} } from "${from}/jsx-runtime";\n`;
  if (c.templates.length === 0) return runtime + body;
  return (
    runtime +
    `import { __template as __hrTemplate, __block as __hrBlock } from "${from}";\n` +
    c.templates.map((t, i) => `const __hrT${i} = __hrTemplate(${t});\n`).join("") +
    body
  );
}

// #endregion
