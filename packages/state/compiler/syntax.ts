// The compiler's syntax helpers, over oxc-parser's ESTree: walking a tree, reading names and
// literals. Shared by the core (./index.ts) and its rule modules (./run.ts, ./modules.ts).

import { visitorKeys } from "oxc-parser";
import type { ArrowFunctionExpression, Function as FunctionNode, Node } from "oxc-parser";

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
}

/** A node's children, each with the key it hangs from. TypeScript-only nodes are skipped, except the expression of a cast. */
function children(node: Node): { readonly key: string; readonly node: Node }[] {
  const out: { key: string; node: Node }[] = [];
  const keys = node.type.startsWith("TS") ? ["expression"] : (visitorKeys[node.type] ?? []);
  for (const key of keys) {
    const value: unknown = Reflect.get(node, key);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      for (const item of items) if (isNode(item)) out.push({ key, node: item });
    } else if (isNode(value)) out.push({ key, node: value });
  }
  return out;
}

/** Visit `node` and its descendants; `visit` returns false to skip a node's children. */
export function walk(
  node: Node,
  visit: (node: Node, parent: Node | null, key: string) => boolean,
  parent: Node | null = null,
  key = "",
): void {
  if (!visit(node, parent, key)) return;
  for (const child of children(node)) walk(child.node, visit, node, child.key);
}

/**
 * Visit `node` and its descendants with the path of their ancestors (outermost first); `visit`
 * returns false to skip a node's children. TypeScript-only nodes are skipped as `walk` skips them.
 */
export function walkPath(node: Node, visit: (node: Node, path: readonly Node[]) => boolean, path: Node[] = []): void {
  if (!visit(node, path)) return;
  path.push(node);
  for (const child of children(node)) walkPath(child.node, visit, path);
  path.pop();
}

/** Visit a type node and every node under it (type nodes included): `visit` returns false to skip a node's children. */
export function walkType(node: Node, visit: (node: Node) => boolean): void {
  if (!visit(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    const items: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const item of items) if (isNode(item)) walkType(item, visit);
  }
}

/** The type a call is given, `T` in `types<T>()`, if any. */
export function typeArgument(node: Node): Node | null {
  if (node.type !== "CallExpression") return null;
  const args: unknown = Reflect.get(node, "typeArguments");
  const params: unknown = isNode(args) ? Reflect.get(args, "params") : null;
  const first: unknown = Array.isArray(params) ? params[0] : null;
  return isNode(first) ? first : null;
}

/** A field of a contract written as a type literal: its type, and whether it may be left out. */
export interface Field {
  readonly type: Node;
  readonly optional: boolean;
}

/** The fields of a type literal (`{ by: string; at?: number }`), by name; null for any other type. */
export function fieldsOf(type: Node | null): ReadonlyMap<string, Field> | null {
  if (type?.type !== "TSTypeLiteral") return null;
  const out = new Map<string, Field>();
  for (const m of type.members) {
    if (m.type !== "TSPropertySignature" || m.typeAnnotation === null) continue;
    const name = keyName(m);
    if (name !== null) out.set(name, { type: m.typeAnnotation.typeAnnotation, optional: m.optional });
  }
  return out;
}

/**
 * What a field's type admits, as far as the compiler's rules need it: strings, numbers and
 * booleans of any value, the literals it lists, objects, arrays (of numbers), null or undefined,
 * and anything else (a named type, a generic) as `other`.
 */
export interface Admits {
  string: boolean;
  number: boolean;
  boolean: boolean;
  literals: unknown[];
  object: boolean;
  array: boolean;
  numbers: boolean;
  nullish: boolean;
  other: boolean;
}

export function admits(field: Field): Admits {
  const out: Admits = {
    string: false,
    number: false,
    boolean: false,
    literals: [],
    object: false,
    array: false,
    numbers: false,
    nullish: field.optional,
    other: false,
  };
  const add = (t: Node): void => {
    if (t.type === "TSUnionType") for (const u of t.types) add(u);
    else if (t.type === "TSTypeOperator" && t.operator === "readonly") add(t.typeAnnotation);
    else if (t.type === "TSStringKeyword") out.string = true;
    else if (t.type === "TSNumberKeyword") out.number = true;
    else if (t.type === "TSBooleanKeyword") out.boolean = true;
    else if (t.type === "TSNullKeyword" || t.type === "TSUndefinedKeyword") out.nullish = true;
    else if (t.type === "TSLiteralType" && t.literal.type === "Literal") out.literals.push(t.literal.value);
    else if (t.type === "TSTypeLiteral") out.object = true;
    else if (t.type === "TSArrayType" || t.type === "TSTupleType") {
      out.array = true;
      if (t.type === "TSArrayType" && t.elementType.type === "TSNumberKeyword") out.numbers = true;
    } else out.other = true;
  };
  add(field.type);
  return out;
}

/** A function: an arrow, `function () {}`, or a declaration. */
export function isFunction(node: Node): node is ArrowFunctionExpression | FunctionNode {
  return (
    node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration"
  );
}

export function stringValue(node: Node | null | undefined): string | null {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

/** A property's name, when it is written as a name or a string. */
export function keyName(property: { readonly key: Node; readonly computed: boolean }): string | null {
  if (property.computed) return stringValue(property.key);
  if (property.key.type === "Identifier") return property.key.name;
  return stringValue(property.key);
}

/** The variable an expression like `a.b[c].d` starts from, if any. */
export function rootName(node: Node): string | null {
  let n = node;
  while (n.type === "MemberExpression") n = n.object;
  return n.type === "Identifier" ? n.name : null;
}

/** The names a binding pattern binds. */
export function boundNames(pattern: Node): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((p) => boundNames(p.type === "RestElement" ? p.argument : p.value));
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap((e) => (e === null ? [] : boundNames(e)));
  if (pattern.type === "AssignmentPattern") return boundNames(pattern.left);
  // A rest element, or a constructor's parameter property (which binds no local of a handler's).
  return pattern.type === "RestElement" ? boundNames(pattern.argument) : [];
}

/** The name an import specifier imports: `a` in `import { a as b }`, or a string name. */
export function importedName(specifier: { readonly imported: Node }): string {
  return specifier.imported.type === "Identifier" ? specifier.imported.name : String(stringValue(specifier.imported));
}

/**
 * What a node hides from the type checker: a cast (`as const` and `satisfies` hide nothing), or a
 * non-null assertion.
 */
export function hides(node: Node, src: (node: Node) => string): "cast" | "non-null" | null {
  if (node.type === "TSAsExpression") return src(node.typeAnnotation) === "const" ? null : "cast";
  if (node.type === "TSTypeAssertion") return "cast";
  return node.type === "TSNonNullExpression" ? "non-null" : null;
}

/**
 * The expressions a function's body returns: an arrow's expression body, or each `return`'s
 * argument in a block, outside nested functions.
 */
export function returned(body: Node): Node[] {
  if (body.type !== "BlockStatement") return [body];
  const out: Node[] = [];
  walk(body, (node) => {
    if (isFunction(node)) return false;
    if (node.type === "ReturnStatement" && node.argument !== null) out.push(node.argument);
    return true;
  });
  return out;
}
