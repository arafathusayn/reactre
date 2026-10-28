// reactre-compiler: a Bun plugin that compiles reactre's TSX into templates
// and the code that keeps them up to date (the model is in reactre's src/index.ts).
//
// Bun transpiles each file (TypeScript stripped, JSX to the automatic
// runtime's `jsx(type, props, key)` calls). Every jsx call is then compiled:
//
//   - A host element tree becomes a reactre/dom template, hoisted to
//     module scope, and an expression that clones it with the values of its
//     holes. A hole whose expression calls a function is bound (an effect
//     that rewrites it); an `on*` handler is added as a listener; a child
//     that is a component, a `<For>` or an expression holding JSX is a slot.
//   - `<For each={rows} key={(r) => r.id}>{(row) => <tr .../>}</For>` becomes
//     a keyed list (`__for`) whose row template's holes are split by what
//     they read: the row only (written at creation, compared on update), or
//     a function call (re-run when what it read changes). Row handlers are
//     delegated to the list's parent.
//   - A component element `<Button id="run" />` is the call `Button({ id: "run" })`,
//     made once (components run once in reactre).
//
// Nothing is left to a JSX runtime: a construct the compiler does not handle
// (fragments, spread props, a keyed host element outside a list) is a
// compile error, with its source.
//
// Design decisions:
//   - The compiler reads Bun's output as text with the shared scanner (./scan.ts) instead of
//     parsing it. Bun has already resolved TypeScript, JSX whitespace and entities, so the jsx
//     calls are all that is left to find, and everything else is copied through unchanged.
//   - "Calls a function" is the whole test for a reactive hole: in reactre a signal is read by
//     calling it. The test is conservative: a call that reads no signal only costs an effect.
//   - Every name the output adds starts with `__rr`, so it cannot collide with the app's names.
//
//   Bun.build({ plugins: [reactreCompiler()], ... })

import type { BunPlugin } from "bun";

import { isIdent, literal, NOT_LITERAL, skipToken, split, until } from "./scan.ts";

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
    name: "reactre-compiler",
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
 * @returns JavaScript that imports what it needs from `reactre` and no JSX runtime.
 * @throws ReactreCompileError for a construct the compiler does not handle.
 * @example
 *   const js = compileSource(`export const A = () => <p class="x">{count()}</p>;`);
 */
export function compileSource(source: string, loader: "jsx" | "tsx" = "tsx"): string {
  // jsxImportSource only names the runtime Bun would import; no runtime is imported, because every
  // jsx call is compiled away.
  const t = new Bun.Transpiler({
    loader,
    tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "reactre" } },
  } as ConstructorParameters<typeof Bun.Transpiler>[0]);
  return compileJs(t.transformSync(source));
}

// #endregion

// #region Templates and holes

// Hole markers, as reactre/dom's text(), cls(), attr() and slot() make them; 0 is untyped (an event).
const M_TEXT = -1,
  M_CLASS = -2,
  M_ATTR = -4,
  M_SLOT = -5,
  M_EVENT = 0;

/** Elements that have no closing tag and take no children. */
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
/** React prop names whose attribute has another name. */
const ALIASES: Record<string, string> = { className: "class", htmlFor: "for" };

/** One jsx call's arguments, as source text. */
interface Call {
  /** The element type: a quoted tag name for a host element, else a component expression. */
  readonly type: string;
  /** The props object literal. */
  readonly props: string;
  /** The key argument, or undefined when there is none. */
  readonly key: string | undefined;
}

/** A place in a template that the clone fills, with the source expression that fills it. */
type Hole =
  | { readonly kind: "value"; readonly marker: number; readonly expr: string }
  | { readonly kind: "event"; readonly type: string; readonly expr: string }
  | {
      readonly kind: "slot";
      readonly slot: "for" | "comp" | "expr";
      readonly expr: string;
      /** Whether the slot is its element's only child, so a list can own the element. */
      readonly only: boolean;
      /** A <For>'s key function (JSX passes `key` apart from the props). */
      readonly key?: string;
    };

/**
 * A template being built. Like a tagged template's parts, `strings` is the markup between holes,
 * so it always has one more entry than `holes`.
 */
interface Tree {
  readonly strings: string[];
  readonly holes: Hole[];
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
  // Bun's transpiler names the runtime's helpers with a hash suffix (jsx_w77yafs4, ...); those
  // names are what the compiler looks for.
  const helpers = new Set<string>();
  for (const m of js.matchAll(/\b(jsxs|jsx|jsxDEV)_[a-z0-9]{8}\b/g)) helpers.add(m[0]);
  if (helpers.size === 0) return js;
  const c = new Compiler(helpers);
  const body = c.rewrite(js);
  // Nothing may fall back to a JSX runtime, since reactre has none.
  for (const m of body.matchAll(/\b(jsxs|jsx|jsxDEV|Fragment)_[a-z0-9]{8}\b/g)) {
    throw new ReactreCompileError(`reactre: ${m[1]} left uncompiled (fragments are not supported)`);
  }
  const imports = `import { __template as __rrT, __for as __rrFor, __insert as __rrInsert, __bind as __rrBind, __slot as __rrSlot, untrack as __rrUntrack } from "reactre";\n`;
  return imports + c.templates.join("\n") + "\n" + body;
}

/**
 * Compiles the jsx calls of one file. It collects the hoisted template declarations in
 * `templates` and returns the rewritten code from `rewrite`.
 */
class Compiler {
  /** The file's local names of jsx, jsxs and jsxDEV. */
  readonly helpers: Set<string>;
  /** Module-scope template declarations, in the order they were made. */
  readonly templates: string[] = [];
  constructor(helpers: Set<string>) {
    this.helpers = helpers;
  }

  // #region Finding jsx calls

  /**
   * Rewrite every jsx call in src. The walk is `until`'s, copying as it goes, so the code around
   * the calls comes out unchanged.
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
          out += this.call(this.parse(src.slice(e + 1, close), src.slice(i, close + 1)));
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
   * A jsx call's arguments. jsxDEV passes more than three; the rest are dev information and are
   * dropped.
   *
   * @param whole The whole call, for the error message.
   */
  parse(args: string, whole: string): Call {
    const parts = split(args, 0, args.length);
    const [type, props, key] = parts;
    if (type === undefined || props === undefined) throw new ReactreCompileError(`reactre: cannot compile ${whole}`);
    return { type, props, key: key === undefined || key === "undefined" ? undefined : key };
  }

  // #endregion

  // #region Elements and components

  /** A jsx call that is not a child of a host element compiled with it. */
  call(c: Call): string {
    // Bun quotes a host element's tag name; a component's type is an expression.
    if (c.type.startsWith('"')) return this.host(c);
    // A list renders into a parent element, before an anchor in it, so it cannot stand alone.
    if (c.type === "For") throw new ReactreCompileError("reactre: <For> must be the child of an element");
    return this.component(c);
  }

  /**
   * `<C a={x} />`: C called once with its props, outside any tracking. Untracked so the signals
   * the component reads while it sets up do not subscribe the effect that happens to create it.
   */
  component(c: Call): string {
    return `__rrUntrack(() => ${c.type}(${this.rewrite(c.props)}))`;
  }

  /**
   * The entries of an object literal with plain keys, as [name, value source] pairs. A shorthand
   * entry (`{ a }`) is [a, a]; a quoted key is decoded.
   *
   * @throws ReactreCompileError for spread props, which would hide what the template must hold.
   */
  object(src: string): [string, string][] {
    const s = src.trim();
    if (!s.startsWith("{") || !s.endsWith("}"))
      throw new ReactreCompileError(`reactre: props must be an object literal: ${s}`);
    const out: [string, string][] = [];
    for (const part of split(s, 1, s.length - 1)) {
      if (part.startsWith("...")) throw new ReactreCompileError(`reactre: spread props are not supported: ${part}`);
      const colon = until(part, 0, ":");
      if (colon >= part.length) {
        out.push([part, part]);
        continue;
      }
      let k = part.slice(0, colon).trim();
      if (k.startsWith('"')) k = JSON.parse(k) as string;
      out.push([k, part.slice(colon + 1).trim()]);
    }
    return out;
  }

  /** The call in src, when src is exactly one jsx call (so it can join its parent's template). */
  only(src: string): Call | null {
    const m = /^([\w$]+)\(/.exec(src);
    if (m === null || !this.helpers.has(m[1]!)) return null;
    const close = until(src, m[0].length, "");
    if (close !== src.length - 1) return null;
    return this.parse(src.slice(m[0].length, close), src);
  }

  /** The template of host element c and its holes. */
  tree(c: Call): Tree {
    const t: Tree = { strings: [""], holes: [] };
    this.element(c, t);
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
   * joins the same template, so a whole tree is one clone.
   */
  private element(c: Call, t: Tree): void {
    const tag = JSON.parse(c.type) as string;
    // Only a list reorders its rows by key; anywhere else a key would be silently ignored.
    if (c.key !== undefined) throw new ReactreCompileError(`reactre: a key on <${tag}> means nothing outside <For>`);
    this.add(t, "<" + tag);
    let children: string[] = [];
    for (const [rawName, value] of this.object(c.props)) {
      if (rawName === "children") {
        // Several children come as one array literal (jsxs); split it into one child each.
        children = value.startsWith("[") && value.endsWith("]") ? split(value, 1, value.length - 1) : [value];
        continue;
      }
      const name = ALIASES[rawName] ?? rawName;
      if (/^on[A-Z]/.test(name)) {
        // The hole sits where the attribute's value would; the clone adds a listener there instead.
        this.add(t, ` on${name.slice(2).toLowerCase()}=`);
        this.hole(t, { kind: "event", type: name.slice(2).toLowerCase(), expr: value });
        continue;
      }
      const lit = literal(value);
      if (lit !== NOT_LITERAL) {
        // As in React: null, undefined and false leave the attribute out, and true sets it empty.
        if (lit === null || lit === undefined || lit === false) continue;
        this.add(t, lit === true ? ` ${name}` : ` ${name}="${attrText("" + lit)}"`);
        continue;
      }
      this.add(t, ` ${name}=`);
      this.hole(t, { kind: "value", marker: name === "class" ? M_CLASS : M_ATTR, expr: value });
    }
    this.add(t, ">");
    if (VOID.has(tag)) {
      if (children.length) throw new ReactreCompileError(`reactre: <${tag}> takes no children`);
      return;
    }
    // Literal null, undefined and booleans render nothing. They are dropped first, so a list
    // beside them still counts as its element's only child.
    const kept = children.filter((x) => {
      const lit = literal(x);
      return !(lit === null || lit === undefined || typeof lit === "boolean");
    });
    for (const child of kept) {
      const lit = literal(child);
      if (typeof lit === "string" || typeof lit === "number") {
        this.add(t, text("" + lit));
        continue;
      }
      const inner = this.only(child);
      if (inner !== null && inner.type.startsWith('"')) {
        this.element(inner, t);
        continue;
      }
      const only = kept.length === 1;
      if (inner !== null && inner.type === "For")
        this.hole(t, {
          kind: "slot",
          slot: "for",
          expr: inner.props,
          only,
          ...(inner.key !== undefined ? { key: inner.key } : {}),
        });
      else if (inner !== null) this.hole(t, { kind: "slot", slot: "comp", expr: this.component(inner), only });
      // An expression that holds JSX (a conditional, a map) may change what it renders: a slot.
      else if (this.hasJsx(child)) this.hole(t, { kind: "slot", slot: "expr", expr: this.rewrite(child), only });
      else this.hole(t, { kind: "value", marker: M_TEXT, expr: child });
    }
    this.add(t, `</${tag}>`);
  }

  /** Whether src holds a jsx call anywhere, so it must be a slot rather than a text hole. */
  private hasJsx(src: string): boolean {
    for (const h of this.helpers) if (src.includes(h + "(")) return true;
    return false;
  }

  /** Hoist t to module scope, so it is built once, not on every render; returns its name. */
  private template(t: Tree): string {
    const id = `__rrT${this.templates.length}`;
    const markers = t.holes.map((h) => (h.kind === "value" ? h.marker : h.kind === "event" ? M_EVENT : M_SLOT));
    this.templates.push(`const ${id} = __rrT(${JSON.stringify(t.strings)}, ${JSON.stringify(markers)});`);
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
    t.holes.forEach((h, i) => {
      if (h.kind === "value") {
        if (reactive(h.expr)) {
          vals.push('""');
          after.push(`__rrBind(${id}, ${i}, __n[${i}], () => (${this.rewrite(h.expr)}));`);
        } else vals.push(`(${this.rewrite(h.expr)})`);
        return;
      }
      vals.push('""');
      if (h.kind === "event") {
        after.push(`__n[${i}].addEventListener(${JSON.stringify(h.type)}, ${this.rewrite(h.expr)});`);
        return;
      }
      if (h.slot === "comp") after.push(`__rrInsert(__n[${i}], ${h.expr}, null);`);
      else if (h.slot === "expr") after.push(`__rrSlot(__n[${i}], () => (${h.expr}));`);
      else after.push(this.forList(h.expr, h.key, `__n[${i}]`, h.only));
    });
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
  forList(props: string, keyArg: string | undefined, anchor: string, only: boolean): string {
    const p = new Map(this.object(props));
    const each = p.get("each"),
      key = keyArg ?? p.get("key"),
      children = p.get("children");
    if (each === undefined || key === undefined || children === undefined) {
      throw new ReactreCompileError("reactre: <For> needs each, key and a row function as its child");
    }
    // One plain parameter, so it can name the row in every hole's own function below.
    const fn = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([\s\S]*)$/.exec(children.trim());
    if (fn === null) throw new ReactreCompileError(`reactre: a <For> row must be (row) => <element />: ${children}`);
    const param = fn[1]!;
    let body = fn[2]!.trim();
    // Strip any parentheses around the body.
    while (body.startsWith("(") && until(body, 1, "") === body.length - 1) body = body.slice(1, -1).trim();
    const row = this.only(body);
    if (row === null || !row.type.startsWith('"'))
      throw new ReactreCompileError(`reactre: a <For> row must be one element: ${body}`);
    const t = this.tree(row);
    const id = this.template(t);
    // fill/holes: values that depend on the row only, written at creation. dyn/dynHoles: values
    // that call something, re-run when what they read changes. events: delegated to the parent.
    const fill: string[] = [],
      holes: number[] = [],
      dyn: string[] = [],
      dynHoles: number[] = [],
      events: string[] = [];
    t.holes.forEach((h, i) => {
      if (h.kind === "event") {
        events.push(`[${JSON.stringify(h.type)}, ${i}, (${param}) => (${this.rewrite(h.expr)})]`);
        return;
      }
      if (h.kind === "slot")
        throw new ReactreCompileError("reactre: a <For> row cannot hold components, lists or JSX expressions yet");
      const e = this.rewrite(h.expr);
      if (reactive(h.expr)) {
        dyn.push(`__d[${dynHoles.length}] = (${e});`);
        dynHoles.push(i);
      } else {
        fill.push(`__v[${i}] = (${e});`);
        holes.push(i);
      }
    });
    // dyn and events are left out when empty, so the runtime does no work for them per row.
    const spec =
      `{ each: () => (${this.rewrite(each)}), key: ${this.rewrite(key)}, t: ${id}, ` +
      `fill: (${param}, __v) => { ${fill.join(" ")} }, holes: ${JSON.stringify(holes)}` +
      (dyn.length ? `, dyn: (${param}, __d) => { ${dyn.join(" ")} }, dynHoles: ${JSON.stringify(dynHoles)}` : "") +
      (events.length ? `, events: [${events.join(", ")}]` : "") +
      " }";
    return only
      ? `{ const __a = ${anchor}, __p = __a.parentNode; __p.removeChild(__a); __rrFor(__p, null, ${spec}); }`
      : `__rrFor(${anchor}.parentNode, ${anchor}, ${spec});`;
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
  let prev = "",
    word = "";
  for (let i = 0; i < expr.length;) {
    const j = skipToken(expr, i, prev, word);
    if (j !== i) {
      i = j;
      prev = "a";
      continue;
    }
    const c = expr[i]!;
    if (c === "(" && (isIdent(prev) || prev === ")" || prev === "]" || prev === "a")) return true;
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
  return false;
}

/** Text escaped for markup between tags. */
const text = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Text escaped for a double-quoted attribute value. */
const attrText = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// #endregion
