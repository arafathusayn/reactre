// @reactre/compiler's server mode (`compileJs(js, { server: true })`): the same JSX compiled to
// string building, for a server build that renders with @reactre/core/server.
//
//   - A host element tree is its markup: the static parts, escaped while compiling, hoisted to
//     module scope as an array of strings, and each hole's markup between them (`__ssr`). Text
//     and attribute values are escaped at runtime, an attribute is left out for null, undefined
//     and false and written empty for true, a `class` object or array is taken apart as the
//     client's is, and `style` takes an object. Handlers and refs are left out. `value`,
//     `checked` and `selected` (and their `default*`) are attributes, and a textarea's value its
//     text. A tree with no holes is one hoisted value.
//   - A component is called once with its props, as on the client (getters included).
//   - Control flow is evaluated once: `<Show>` and `<Switch>` pick their content, `<For>` and
//     `<Repeat>` write a row per item, `<Dynamic>` calls its component or writes its element, and
//     `<Portal>` writes nothing (its content belongs to another part of the page).
//   - A hole or slot that may change (as the client compiler judges it) is a thunk (`__ssrLazy`),
//     so a read of an async value that is not ready makes it a cell that waits, as a hole's
//     effect waits on the client, and `<Loading>` can show its fallback (@reactre/core/server).
//   - Imports are pointed at the server: @reactre/core at @reactre/core/server, its
//     features/async, dynamic, errors, reaction and timing at their server versions, and `effect`
//     (which does not run there) and `memo` (computed when first read) at the server's
//     (`serverImports`).
//
// The `<For>` and `<Repeat>` handling is in `list` and `forProps`, apart from the rest, as the
// client's is in index.ts's `forList`.

import type { Call, Compiler, Flow } from "./index.ts";
import {
  ALIASES,
  attrText,
  DEFAULTS,
  forIndex,
  isLiteral,
  isNothing,
  keyedOf,
  need,
  PROPERTIES,
  ReactreCompileError,
  spreadValue,
  text,
  VOID,
} from "./index.ts";
import { literal, NOT_LITERAL } from "./scan.ts";

// #region Imports

/**
 * The modules a server build of an app imports in place of the client's: the core, and the
 * feature modules that touch the DOM (`<Loading>`, `dynamic()`) or run effects (`reaction`'s
 * apply half, `onSettled`, `effect(fn, { error })`, `bind`'s apply, `autorun`, `onFlush`), which
 * do not run on the server.
 */
const SERVER_MODULES: Record<string, string> = {
  "@reactre/core": "@reactre/core/server",
  "@reactre/core/features/async": "@reactre/core/server/async",
  "@reactre/core/features/dynamic": "@reactre/core/server/dynamic",
  "@reactre/core/features/effects": "@reactre/core/server/effects",
  "@reactre/core/features/errors": "@reactre/core/server/errors",
  "@reactre/core/features/reaction": "@reactre/core/server/reaction",
  "@reactre/core/features/timing": "@reactre/core/server/timing",
};

/** A module specifier of @reactre/core in an import or export: `from "..."`, `import "..."`, `import("...")`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(@reactre\/core(?:\/features\/[a-z]+)?)\2/g;

/** A named import from @reactre/core or features/errors, the modules whose `effect` and `memo` change. */
const NAMED = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])(@reactre\/core(?:\/features\/errors)?)\2;?/g;

/**
 * A feature module of @reactre/core (its sources' or its build's): a server build loads it with
 * `serverImports(code, false)`, so its core is @reactre/core/server. Check `isCore` too.
 */
export const CORE_FEATURE: RegExp = /[\\/]core[\\/](?:src|dist(?:[\\/]dev)?)[\\/]features[\\/][a-zA-Z]+\.[jt]s$/;

/**
 * Module `js`'s imports of @reactre/core, as a server build makes them: the core and the feature
 * modules of `SERVER_MODULES` point at their server versions (@reactre/core/server, and
 * /server/async, /server/dynamic, ...). With `app`, for the app's own modules, its named imports
 * of `effect` (from the core or features/errors) become @reactre/core/server's `__ssrEffect`,
 * which does not run, and of `memo` from the core its `__ssrMemo`, computed when first read.
 * Without, for @reactre/core's own feature modules, only the core itself points at the server,
 * but for its `effect`, the core's own, which runs.
 */
export function serverImports(js: string, app: boolean = true): string {
  let out = js;
  if (app)
    out = out.replace(NAMED, (whole, list: string, _q: string, from: string) => {
      const kept: string[] = [],
        server: string[] = [];
      for (const part of list.split(",")) {
        const p = part.trim();
        const [name, local = name] = p.split(/\s+as\s+/) as [string, string?];
        if (name === "effect") server.push(`__ssrEffect as ${local}`);
        else if (name === "memo" && from === "@reactre/core") server.push(`__ssrMemo as ${local}`);
        else if (p !== "") kept.push(p);
      }
      if (server.length === 0) return whole;
      const own = `import { ${server.join(", ")} } from "@reactre/core/server";`;
      // A module imported for nothing still loads: features/errors's boundaries need it.
      return (kept.length === 0 ? `import "${from}";` : `import { ${kept.join(", ")} } from "${from}";`) + own;
    });
  out = out.replace(SPECIFIER, (whole, head: string, q: string, spec: string) => {
    const to = app ? SERVER_MODULES[spec] : spec === "@reactre/core" ? "@reactre/core/server" : undefined;
    return to === undefined ? whole : `${head}${q}${to}${q}`;
  });
  if (app) return out;
  // A feature module's effects compute what it returns (a projection, a derived signal,
  // `resolve`): it takes the core's `effect`, which runs, where @reactre/core/server's does not.
  return out.replace(SERVER_NAMED, (whole, list: string) => {
    const parts = list.split(",").map((p) => p.trim());
    const effect = parts.filter((p) => p.split(/\s+as\s+/)[0] === "effect");
    if (effect.length === 0) return whole;
    const kept = parts.filter((p) => p !== "" && !effect.includes(p));
    return (
      (kept.length === 0 ? "" : `import { ${kept.join(", ")} } from "@reactre/core/server";`) +
      `import { ${effect.join(", ")} } from "@reactre/core";`
    );
  });
}

/** A named import of @reactre/core/server, as `serverImports` points a feature module's import of the core. */
const SERVER_NAMED = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])@reactre\/core\/server\2;?/g;

/** @reactre/core/server's helpers, with their local names, imported where the code uses them. */
export const SERVER_HELPERS: readonly (readonly [string, string])[] = [
  ["__ssr", "__rrsH"],
  ["__ssrText", "__rrsT"],
  ["__ssrAttr", "__rrsA"],
  ["__ssrClass", "__rrsC"],
  ["__ssrStyle", "__rrsY"],
  ["__ssrAttrs", "__rrsP"],
  ["__ssrClasses", "__rrsK"],
  ["__ssrSlot", "__rrsS"],
  ["__ssrInsert", "__rrsI"],
  ["__ssrLazy", "__rrsL"],
  ["__ssrFor", "__rrsF"],
  ["__ssrRepeat", "__rrsR"],
  ["__ssrElement", "__rrsE"],
  ["__frag", "__rrFrag"],
  ["untrack", "__rrUntrack"],
  ["__props", "__rrProps"],
  ["__class", "__rrClass"],
  ["__ref", "__rrRef"],
];

// #endregion

/**
 * A character no tag or attribute name the server writes may hold, as @reactre/core/server's
 * check of the names it gets at runtime: whitespace, a control character, a quote, `<`, `>`, `/`
 * or `=`. A name with one could end the tag and start markup of its own.
 */
const NOT_NAME = /[\0-\x20\x7F-\x9F"'<>/=]/;

/** A hole of an element tree: its markup's code, or a text hole's parts (see `Markup`). */
type Hole = { readonly code: string } | TextHole;
/** A text hole: its expression, whether it may change, and what text is beside it (1 before, 2 after). */
interface TextHole {
  readonly expr: string;
  readonly lazy: boolean;
  sep: number;
}

/**
 * The markup of an element tree being built: like a tagged template's parts, `strings` has one
 * more entry than `holes`. `text` says whether what came last was text, and `last` is the text
 * hole that came last, which text after it separates from (see `__ssrText`).
 */
interface Markup {
  readonly strings: string[];
  readonly holes: Hole[];
  text: boolean;
  last: TextHole | null;
}

/**
 * Emits a file's jsx calls as string building. The client's `Compiler` walks the file and hands
 * each jsx call outside an element to `call`; the parsing (props, children, which expressions may
 * change) is the client's.
 */
export class ServerEmit {
  private readonly c: Compiler;
  constructor(c: Compiler) {
    this.c = c;
  }

  /** `c.call` on the server: a jsx call that is not a child of a host element compiled with it. */
  call(x: Call): string {
    const c = this.c;
    // A key that may change makes the element a one-slot fragment on the client: its slot here.
    if (x.type.startsWith('"'))
      return x.key !== undefined && c.changes(x.key)
        ? `__rrsS(${this.host({ ...x, key: undefined, keyAt: -1 })})`
        : this.host(x);
    const f = c.kind(x.type);
    if (f === "For" || f === "Repeat") return c.anyList(x, f);
    if (f !== null) {
      const flow = this.flow(x, f);
      return "host" in flow ? this.host(flow.host) : flow.code;
    }
    if (c.fragments.has(x.type)) return c.fragment(x);
    return c.component(x);
  }

  // #region Element trees

  /** A host element tree's markup: one hoisted value when it has no holes. */
  host(x: Call): string {
    const t: Markup = { strings: [""], holes: [], text: false, last: null };
    this.element(x, t, false);
    const id = `__rrsM${this.c.templates.length}`;
    const strings = JSON.stringify(t.strings);
    if (t.holes.length === 0) {
      this.c.templates.push(`const ${id} = __rrsH(${strings});`);
      return id;
    }
    this.c.templates.push(`const ${id} = ${strings};`);
    const holes = t.holes.map((h) => {
      if ("code" in h) return h.code;
      const code = `__rrsT((${h.expr}), ${h.sep})`;
      return h.lazy ? `__rrsL(() => ${code})` : code;
    });
    return `__rrsH(${id}, ${holes.join(", ")})`;
  }

  /** Append static markup; text at its start ends a text hole before it with a marker. */
  private add(t: Markup, s: string): void {
    if (s === "") return;
    if (t.last !== null && !s.startsWith("<")) t.last.sep |= 2;
    t.strings[t.strings.length - 1] += s;
    t.text = !s.endsWith(">");
    t.last = null;
  }

  /** Add a hole whose markup is `code`, lazy when `lazy`; it is not text. */
  private hole(t: Markup, code: string, lazy: boolean): void {
    t.holes.push({ code: lazy ? `__rrsL(() => ${code})` : code });
    t.strings.push("");
    t.text = false;
    t.last = null;
  }

  /** Add a slot: `expr`'s value as content, between slot markers; a thunk when it may change. */
  private slot(t: Markup, expr: string, lazy: boolean): void {
    this.hole(t, lazy ? `__rrsS(__rrsL(() => __rrsI(${expr})))` : `__rrsS(${expr})`, false);
  }

  /** Add a text hole, compiled from `expr`. */
  private textHole(t: Markup, expr: string, at: number): void {
    const h: TextHole = { expr: this.c.rewrite(expr, at), lazy: this.c.changes(expr), sep: t.text ? 1 : 0 };
    t.holes.push(h);
    t.strings.push("");
    t.text = true;
    t.last = h;
  }

  /** Add an attribute hole: `fn`'s markup of the value of `expr`, with `name` when it takes one. */
  private attr(t: Markup, fn: string, expr: string, at: number, name?: string): void {
    const e = this.c.rewrite(expr, at);
    this.hole(t, `${fn}((${e})${name === undefined ? "" : `, ${JSON.stringify(name)}`})`, this.c.changes(expr));
  }

  /**
   * Append host element `x` to the markup, as the client's `element` appends it to a template:
   * the same props, in the same order, written as attributes.
   */
  private element(x: Call, t: Markup, svg: boolean): void {
    const c = this.c;
    const tag = JSON.parse(x.type) as string;
    if (!/^[a-zA-Z]/.test(tag) || NOT_NAME.test(tag))
      throw new ReactreCompileError(`reactre: "${tag}" is not a valid tag name`);
    const inSvg = svg || tag === "svg";
    this.add(t, "<" + tag);
    let children: [string, number][] = [];
    const entries = c.object(x.props, true, x.propsAt);
    const spread = entries.some(([k]) => k === "...");
    if (spread) {
      const rest = entries
        .filter(([k]) => k !== "children")
        .map(([k, v]) => (k === "..." ? v : `${JSON.stringify(k)}: ${spreadValue(k, v)}`));
      const obj = `{ ${rest.join(", ")} }`;
      this.hole(t, `__rrsP(${c.rewrite(obj, -1)})`, c.changes(obj));
    }
    const classes = entries.filter(([k]) => k !== "..." && (ALIASES[k] ?? k) === "class");
    const classList = !spread && classes.some(([, v]) => isLiteral(v, "{") || isLiteral(v, "["));
    let classDone = false;
    // A textarea's value is its text.
    let value: [string, number] | null = null;
    for (const [rawName, v, at] of entries) {
      if (rawName === "children") {
        children = c.items(v, at);
        continue;
      }
      if (spread) continue;
      let name = ALIASES[rawName] ?? rawName;
      if (name === "class" && classList) {
        if (!classDone) this.classList(classes, t);
        classDone = true;
        continue;
      }
      if (/^on[A-Z]/.test(name) || name === "ref") continue;
      const prop = !inSvg && (DEFAULTS.has(name) || PROPERTIES.has(name));
      if (prop) {
        // A property is its attribute on the server, so the page shows the state it sets.
        name = name.startsWith("default") ? name.slice(7).toLowerCase() : name;
        if (tag === "textarea" && name === "value") {
          value = [v, at];
          continue;
        }
      }
      if (name === "" || NOT_NAME.test(name))
        throw new ReactreCompileError(`reactre: <${tag}>'s "${name}" is not a valid attribute name`);
      const lit = literal(v);
      if (lit !== NOT_LITERAL) {
        if (lit === null || lit === undefined || lit === false) continue;
        this.add(t, lit === true ? ` ${name}` : ` ${name}="${attrText("" + (lit as string))}"`);
        continue;
      }
      if (name === "style") this.attr(t, "__rrsY", v, at);
      else if (name === "class" && !inSvg) this.attr(t, "__rrsC", v, at);
      else this.attr(t, "__rrsA", v, at, name);
    }
    this.add(t, ">");
    if (VOID.has(tag)) {
      if (children.length) throw new ReactreCompileError(`reactre: <${tag}> takes no children`);
      return;
    }
    if (value !== null) this.textHole(t, value[0], value[1]);
    else this.children(children, t, inSvg && tag !== "foreignObject");
    this.add(t, `</${tag}>`);
  }

  /**
   * An element's class props, one of which is an object or array literal, as one class list: the
   * classes the client's template holds, then the toggles of an object's keys whose values are
   * expressions; or, when some part is known only at runtime, the whole list through `__class`.
   */
  private classList(classes: readonly [string, string, number][], t: Markup): void {
    const c = this.c;
    const tokens: string[] = [],
      toggles: [string, string, number][] = [];
    if (!classes.every(([, v, at]) => c.classParts(v, at, tokens, toggles))) {
      const expr = classes.length === 1 ? classes[0]![1] : `[${classes.map(([, v]) => v).join(", ")}]`;
      const at = classes.length === 1 ? classes[0]![2] : -1;
      this.hole(t, `__rrsC(__rrClass(${c.rewrite(expr, at)}))`, c.changes(expr));
      return;
    }
    if (toggles.length === 0) {
      if (tokens.length) this.add(t, ` class="${attrText(tokens.join(" "))}"`);
      return;
    }
    const list = toggles.map(([k, x, at]) => `[${JSON.stringify(k)}, (${c.rewrite(x, at)})]`);
    this.hole(
      t,
      `__rrsK(${JSON.stringify(tokens.join(" "))}, [${list.join(", ")}])`,
      toggles.some(([, x]) => c.changes(x)),
    );
  }

  /** Append an element's children; a fragment's children join it in place. */
  private children(children: readonly [string, number][], t: Markup, svg: boolean): void {
    const c = this.c;
    for (const [child, at] of children.filter(([x]) => !isNothing(x))) {
      const lit = literal(child);
      if (typeof lit === "string" || typeof lit === "number") {
        this.add(t, text("" + lit));
        continue;
      }
      const inner = c.only(child, at);
      if (inner !== null && c.fragments.has(inner.type)) {
        this.children(c.childrenOf(inner.props, inner.propsAt), t, svg);
        continue;
      }
      if (inner !== null && inner.type.startsWith('"')) {
        // A key that may change makes the element a slot on the client, which rebuilds it.
        if (inner.key !== undefined && c.changes(inner.key))
          this.slot(t, this.host({ ...inner, key: undefined, keyAt: -1 }), false);
        else this.element(inner, t, svg);
        continue;
      }
      const f = inner === null ? null : c.kind(inner.type);
      // As on the client: a list whose row is not one element is content, in a slot.
      if ((f === "For" || f === "Repeat") && !c.elementRows(inner!, f)) this.slot(t, c.anyList(inner!, f), false);
      else if (f === "For" || f === "Repeat") this.hole(t, this.list(inner!, f), false);
      else if (f !== null) {
        const flow = this.flow(inner!, f);
        if ("host" in flow) this.element(flow.host, t, svg);
        else this.hole(t, flow.code, false);
      } else if (inner !== null) this.slot(t, c.component(inner), false);
      else if (c.readsChildren(child)) this.slot(t, c.rewrite(child, at), c.changes(child));
      else if (c.hasJsx(child)) this.slot(t, c.rewrite(child, at), true);
      else this.textHole(t, child, at);
    }
  }

  // #endregion

  // #region Lists

  /**
   * A `<For each key fallback>` or `<Repeat count from fallback>`: its rows' markup, each row its
   * function's markup for an item (`__ssrFor`). `keyed={false}` (a list by index) gives the row
   * an accessor of its item.
   */
  private list(x: Call, f: "For" | "Repeat"): string {
    const c = this.c;
    const p = this.forProps(x, f);
    const row = c.rewrite(...p.get("children")!);
    const fb = p.get("fallback");
    const fallback = fb === undefined ? "undefined" : `() => (${c.rewrite(...fb)})`;
    let code: string, changes: boolean;
    if (f === "Repeat") {
      const count = p.get("count")!,
        from = p.get("from");
      code = `__rrsR(${c.rewrite(...count)}, ${from === undefined ? "undefined" : c.rewrite(...from)}, ${row}, ${fallback})`;
      changes = c.changes(count[0]) || (from !== undefined && c.changes(from[0]));
    } else {
      const each = p.get("each")!;
      code = `__rrsF(${c.rewrite(...each)}, ${row}, ${fallback}, ${forIndex(p, x.key)})`;
      changes = c.changes(each[0]);
    }
    return changes ? `__rrsL(() => ${code})` : code;
  }

  /**
   * The client's `anyList` on the server: its rows' content (or while there are none, its
   * fallback's) in one pair of markers, as the client's list renders between its two. A row
   * gets its item and an accessor of its index, or by position (`index`), an accessor of its item
   * and its index.
   *
   * @param each The items, compiled; `row` the row's function and `fallback` its content, compiled.
   * @param changes Whether the items may change: the list is then a thunk, which may wait.
   */
  anyList(each: string, index: boolean, row: string, fallback: string | null, changes: boolean): string {
    const args = index ? "() => __rrX, __rrI" : "__rrX, () => __rrI";
    const rows =
      `((__rrW, __rrL) => (__rrL && __rrL.length ? Array.from(__rrL, (__rrX, __rrI) => __rrW(${args})) : ` +
      `${fallback === null ? "null" : `(${fallback})`}))(${row}, ${each})`;
    return changes ? `__rrsS(__rrsL(() => __rrsI(${rows})))` : `__rrsS(${rows})`;
  }

  /** A list's props, checked as the client checks them: what each takes, and what it needs. */
  private forProps(x: Call, f: "For" | "Repeat"): Map<string, [string, number]> {
    const p = new Map(this.c.object(x.props, false, x.propsAt).map(([k, v, at]) => [k, [v, at] as [string, number]]));
    if (f === "Repeat") {
      const other = [...p.keys()].find((k) => !["count", "from", "fallback", "children"].includes(k));
      if (!p.has("count") || !p.has("children") || x.key !== undefined || other !== undefined)
        throw new ReactreCompileError(
          "reactre: <Repeat> takes count, from, fallback and a row function as its child" +
            (other !== undefined ? `, not ${other}` : x.key !== undefined ? ", not key" : ""),
        );
      return p;
    }
    // As the client's: `keyed={false}` is a list by position, which needs no key, and `keyed`
    // written as a function is the key. `forIndex` throws for `keyed` beside `key` or written as
    // anything else.
    const keyed = !forIndex(p, x.key);
    if (!p.has("each") || !p.has("children") || (keyed && x.key === undefined && !p.has("key") && !p.has("keyed")))
      throw new ReactreCompileError("reactre: <For> needs each, key and a row function as its child");
    return p;
  }

  // #endregion

  // #region Control flow

  /**
   * What control flow element `x` compiles to: the code of its markup (a slot), or for a
   * `<Dynamic>` of a tag name written as a string, the element to compile in its place.
   */
  private flow(x: Call, f: Exclude<Flow, "For" | "Repeat">): { code: string } | { host: Call } {
    if (f === "Show") return { code: this.show(x) };
    if (f === "Switch") return { code: this.switchOf(x) };
    if (f === "Portal") {
      this.c.flowProps(x, "Portal", ["mount", "children"]);
      return { code: "__rrsS(null)" };
    }
    if (f === "Dynamic") return this.dynamic(x);
    throw new ReactreCompileError("reactre: <Match> must be a child of <Switch>");
  }

  /** A slot of `body` (an expression): a thunk when what it reads may change. */
  private picked(body: string, changes: boolean): string {
    return changes ? `__rrsS(__rrsL(() => __rrsI(${body})))` : `__rrsS(${body})`;
  }

  /**
   * `<Show when fallback keyed>`: `when` read once, and its children or its fallback. A function
   * child gets an accessor of the value, or with `keyed` the value.
   */
  private show(x: Call): string {
    const c = this.c;
    const p = c.flowProps(x, "Show", ["when", "fallback", "keyed", "children"]);
    const [when, whenAt] = need(p, "when", "Show");
    const keyed = keyedOf(p, "Show");
    const v = `__rrX${c.uid++}`;
    const kids = c.content(c.kids(p), () => (keyed ? v : `() => ${v}`));
    return this.picked(`((${v}) => (${v} ? ${kids} : ${c.fallback(p)}))(${c.rewrite(when, whenAt)})`, c.changes(when));
  }

  /** `<Switch fallback>` of `<Match when keyed>`: the first truthy match's children, read once. */
  private switchOf(x: Call): string {
    const c = this.c;
    const p = c.flowProps(x, "Switch", ["fallback", "children"]);
    const v = `__rrX${c.uid++}`;
    let changes = false;
    const cases = c
      .kids(p)
      .filter(([k]) => !isNothing(k) && !(typeof literal(k) === "string" && !(literal(k) as string).trim()))
      .map(([k, at]) => {
        const m = c.only(k, at);
        if (m === null || c.kind(m.type) !== "Match")
          throw new ReactreCompileError(`reactre: <Switch> takes only <Match> children: ${k}`);
        const mp = c.flowProps(m, "Match", ["when", "keyed", "children"]);
        const [when, whenAt] = need(mp, "when", "Match");
        const keyed = keyedOf(mp, "Match");
        changes ||= c.changes(when);
        const kids = c.content(c.kids(mp), () => (keyed ? v : `() => ${v}`));
        return `if ((${v} = (${c.rewrite(when, whenAt)}))) return ${kids};`;
      });
    return this.picked(`(() => { let ${v}; ${cases.join(" ")} return ${c.fallback(p)}; })()`, changes);
  }

  /**
   * `<Dynamic component {...props}>`: a tag name written as a string is that element; any other
   * `component` is called with the props when it is a function, writes its element when it is a
   * tag name (`__ssrElement`), and renders nothing when it is falsy.
   */
  private dynamic(x: Call): { code: string } | { host: Call } {
    const c = this.c;
    if (x.key !== undefined) throw new ReactreCompileError("reactre: <Dynamic> takes no key");
    const entries = c.object(x.props, true, x.propsAt);
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
    const props =
      c.passProps(rest) ??
      `{ ${rest.map(([k, v, at]) => (k === "..." ? c.rewrite(v, at) : `${JSON.stringify(k)}: ${c.rewrite(v, at)}`)).join(", ")} }`;
    const body =
      `((__rrD) => __rrUntrack(() => typeof __rrD === "function" ? __rrD(${props}) : ` +
      `__rrD ? __rrsE(__rrD, ${props}) : null))(${c.rewrite(comp[1], comp[2])})`;
    return { code: this.picked(body, c.changes(comp[1])) };
  }

  // #endregion
}
