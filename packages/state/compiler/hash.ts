// The shape hash (M260): a saved snapshot fits its machine only while the contracts it was saved
// under still hold, and a change to them is a new version, with a migration from the old. The
// compiler can't see the contracts of a version it no longer has, so setup keeps a hash of them,
// `shape: "..."`: when the contracts change and the hash is kept, the build fails.
//
// The hash is of the text the contracts are written in, normalized so that formatting, comments and
// the order of a literal's members don't change it (`shapeText`): the data is the same. A name in a
// contract (`types<Order>()`, a schema in a const) is followed to its declaration, in the file or in
// a relative import, so a change to `Order` changes the hash too (M554). And it covers each node's
// work, which a saved snapshot holds the progress of: its timers' keys (sorted: a durable run's
// timer ids are their delays, not their positions), its task, its timeout and its children (M553).

import { visitorKeys } from "oxc-parser";
import type { Expression, Node, ObjectProperty, Program } from "oxc-parser";

import { duration } from "./features/delays.ts";
import { factsOf, propsOf } from "./features/read.ts";
import { importedModule } from "./modules.ts";
import { importedName } from "./syntax.ts";

const WORD = /[\w$]/;
const BEFORE_LEADING = new Set(["", "<", "(", "[", "{", ":", ",", ";", "="]);
const CLOSING = new Set(["}", "]", ")", ">"]);

/**
 * `text` without its comments, with whitespace kept only between two words, without a separator
 * before a closing bracket, and without a union's (or an intersection's) leading `|` (`&`): the
 * same contract, however it is formatted, is the same text.
 */
export function normalize(text: string): string {
  let out = "";
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 1;
      i = end <= 0 ? text.length : end;
      space = true;
      continue;
    }
    if (/\s/.test(c)) {
      space = true;
      continue;
    }
    if (space && WORD.test(c) && WORD.test(out.charAt(out.length - 1))) out += " ";
    space = false;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== c) j += text.charAt(j) === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if ((c === "|" || c === "&") && next !== c && BEFORE_LEADING.has(out.charAt(out.length - 1))) continue;
    if (CLOSING.has(c) && (out.endsWith(",") || out.endsWith(";"))) out = out.slice(0, -1);
    out += c;
  }
  return out;
}

/** 64-bit FNV-1a of `text`'s UTF-8 bytes, as 8 base-36 characters. */
export function hash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return (h % 36n ** 8n).toString(36).padStart(8, "0");
}

/** A file the contracts' names are followed into: its text, its declarations and its imports. */
interface Source {
  readonly file: string;
  readonly text: string;
  /** Its module-level types (aliases, interfaces) and consts, by name. */
  readonly declared: ReadonlyMap<string, Node>;
  /** Its relative imports, by local name. */
  readonly imports: ReadonlyMap<string, { readonly source: string; readonly imported: string }>;
}

const sources = new WeakMap<Program, Source>();

function sourceOf(file: string, text: string, program: Program): Source {
  const known = sources.get(program);
  if (known !== undefined) return known;
  const declared = new Map<string, Node>();
  const imports = new Map<string, { source: string; imported: string }>();
  for (const top of program.body) {
    const s = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (s.type === "TSTypeAliasDeclaration" || s.type === "TSInterfaceDeclaration") declared.set(s.id.name, s);
    if (s.type === "VariableDeclaration" && s.kind === "const")
      for (const d of s.declarations)
        if (d.id.type === "Identifier" && d.init !== null) declared.set(d.id.name, d.init);
    if (s.type === "ImportDeclaration" && s.source.value.startsWith("."))
      for (const i of s.specifiers)
        if (i.type === "ImportSpecifier")
          imports.set(i.local.name, { source: s.source.value, imported: importedName(i) });
  }
  const out = { file, text, declared, imports };
  sources.set(program, out);
  return out;
}

/** A name's declaration: in `source`, or in the relative module it's imported from (one hop each). */
function declaration(source: Source, name: string): { readonly node: Node; readonly in: Source } | null {
  const own = source.declared.get(name);
  if (own !== undefined) return { node: own, in: source };
  const i = source.imports.get(name);
  const module = i === undefined ? null : importedModule(source.file, i.source);
  if (i === undefined || module === null) return null;
  return declaration(sourceOf(module.path, module.text, module.program), i.imported);
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
}

/** A node's children, TypeScript's included, in source order. */
function childrenOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const value: unknown = Reflect.get(node, key);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      for (const item of items) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A member's text, normalized, without the separator after it. */
const member = (text: string): string => normalize(text).replace(/[;,]$/, "");

/**
 * A contract's text for the hash: as written, with each literal's members sorted (a type's, an
 * object's), and each name that has a declaration followed to it (`Order=(...)`), once per name.
 */
function canonical(node: Node, source: Source, seen: ReadonlySet<string>): string {
  const text = (n: Node): string => source.text.slice(n.start, n.end);
  const sorted = (items: readonly Node[]): string =>
    `{${items
      .map((m) => member(canonical(m, source, seen)))
      .sort()
      .join(";")}}`;
  const follow = (name: string): string | null => {
    const found = declaration(source, name);
    const key = `${found?.in.file} ${name}`;
    if (found === null || seen.has(key)) return null;
    const next = new Set([...seen, key]);
    const d = found.node;
    const of = (n: Node): string => canonical(n, found.in, next);
    if (d.type === "TSTypeAliasDeclaration") return of(d.typeAnnotation);
    if (d.type === "TSInterfaceDeclaration") return [...d.extends.map(of), of(d.body)].join("&");
    return of(d);
  };
  if (node.type === "TSTypeLiteral") return sorted(node.members);
  if (node.type === "TSInterfaceBody") return sorted(node.body);
  if (node.type === "ObjectExpression" && node.properties.every((p) => p.type === "Property"))
    return sorted(node.properties);
  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
    const followed = follow(node.typeName.name);
    const args = node.typeArguments === null ? "" : canonical(node.typeArguments, source, seen);
    if (followed !== null) return `${node.typeName.name}${args}=(${followed})`;
  }
  // A name used as a value: a schema held in a const (`open: OrderSchema`, `z.array(Item)`).
  if (node.type === "Identifier") {
    const followed = follow(node.name);
    if (followed !== null) return `${node.name}=(${followed})`;
  }
  let out = "";
  let at = node.start;
  for (const child of childrenOf(node)) {
    if (child.start < at) continue;
    // A member's name, or a property read, is a name, not a reference: kept as written.
    const name =
      child.type === "Identifier" &&
      ((node.type === "MemberExpression" && node.property === child) ||
        ((node.type === "Property" || node.type === "TSPropertySignature") && node.key === child));
    out += source.text.slice(at, child.start) + (name ? text(child) : canonical(child, source, seen));
    at = child.end;
  }
  return out + source.text.slice(at, node.end);
}

/** What `shapeText` reads: the file, and setup's maps and input. */
export interface ShapeInput {
  readonly program: Program;
  readonly file: string;
  readonly src: (node: Node) => string;
  /** The shape's name: its machines are `<name>.machine({...})`. */
  readonly name: string;
  /** Setup's `states`, `events` and `internal`. */
  readonly maps: readonly ReadonlyMap<string, ObjectProperty>[];
  readonly input: Expression | undefined;
}

/**
 * The text a shape's hash is of (beside its version): its contracts, canonical, then its machines'
 * work, node by node.
 */
export function shapeText({ program, file, src, name, maps, input }: ShapeInput): string {
  // The file's text at its offsets (the program spans it, from its first character).
  const source = sourceOf(file, " ".repeat(program.start) + src(program), program);
  const contract = (node: Node): string => normalize(canonical(node, source, new Set()));
  const work = factsOf(program)
    .machines.filter((m) => m.shape.name === name)
    .map((m) =>
      [...m.nodes]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .flatMap(([node, config]) => {
          const parts = [
            // By the delay a durable run's id names: "1.5s" and "1500ms" are one timer.
            ...[...propsOf(config.get("after")?.value).keys()].map((k) => `after:${duration(k) ?? k}`).sort(),
            ...(config.has("task") ? ["task"] : []),
            ...(config.has("timeout") ? ["timeout"] : []),
            ...[...propsOf(config.get("children")?.value).keys()].sort().map((c) => `child:${c}`),
          ];
          return parts.length === 0 ? [] : [`${JSON.stringify(node)}:${parts.join(",")}`];
        })
        .join(";"),
    )
    .join("|");
  return [
    ...maps.map((map) =>
      [...map]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, p]) => `${JSON.stringify(key)}:${contract(p.value)}`)
        .join(","),
    ),
    input === undefined ? "" : contract(input),
    work,
  ].join("|");
}
