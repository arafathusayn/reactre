// Syntax helpers over oxc's AST, in the compiler's style (../compiler/index.ts).

import { visitorKeys } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingRestElement,
  Expression,
  FormalParameterRest,
  Function as FunctionNode,
  Node,
  ObjectExpression,
  ObjectProperty,
  ParamPattern,
} from "oxc-parser";

/** A function written in place: an arrow or a function expression. */
export type Fn = ArrowFunctionExpression | FunctionNode;

/** A replacement of `source[start, end)`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
}

/** A node's children, each with the key it hangs from. TypeScript-only nodes are skipped, except the expression of a cast. */
export function children(node: Node): { readonly key: string; readonly node: Node }[] {
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

export function isFunction(node: Node): node is Fn {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
}

export function stringValue(node: Node | null | undefined): string | null {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

/** A property's name, when it is written as a name, a string or a number. */
export function keyName(property: { readonly key: Node; readonly computed: boolean }): string | null {
  const key = property.key;
  if (!property.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number"))
    return String(key.value);
  return null;
}

/** An object literal's named properties, in order. Spreads and computed keys are left out. */
export function props(object: ObjectExpression): Map<string, ObjectProperty> {
  const out = new Map<string, ObjectProperty>();
  for (const p of object.properties) {
    if (p.type === "SpreadElement") continue;
    const name = keyName(p);
    if (name !== null) out.set(name, p);
  }
  return out;
}

/** The value of `object`'s property `name`, when `object` is an object literal. */
export function prop(object: Node | null | undefined, name: string): Expression | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  return props(object).get(name)?.value;
}

/** The names a binding pattern (a declaration's, or a parameter's) binds. */
export function boundNames(pattern: BindingPattern | BindingRestElement | FormalParameterRest): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((p) => boundNames(p.type === "RestElement" ? p.argument : p.value));
    case "ArrayPattern":
      return pattern.elements.flatMap((e) => (e === null ? [] : boundNames(e)));
    case "AssignmentPattern":
      return boundNames(pattern.left);
    case "RestElement":
      return boundNames(pattern.argument);
  }
}

/** The names a parameter binds: a parameter property's (`private x`, a constructor's) are its parameter's. */
function paramNames(param: ParamPattern): string[] {
  return boundNames(param.type === "TSParameterProperty" ? param.parameter : param);
}

/** Every name a function declares: its parameters and the locals of its body and inner functions. */
export function declaredNames(fn: Fn): Set<string> {
  const out = new Set<string>();
  for (const p of fn.params) for (const n of paramNames(p)) out.add(n);
  if (fn.body !== null)
    walk(fn.body, (node) => {
      if (node.type === "VariableDeclarator") for (const n of boundNames(node.id)) out.add(n);
      if (isFunction(node)) for (const p of node.params) for (const n of paramNames(p)) out.add(n);
      return true;
    });
  return out;
}

/**
 * Whether an identifier, at `key` under `parent`, is a reference to a variable (not a property's
 * name, a member's name, a label or a binding).
 */
export function isReference(parent: Node | null, key: string): boolean {
  if (parent === null) return true;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if (parent.type === "Property" && key === "key" && !parent.computed) return false;
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
    return false;
  if (parent.type === "VariableDeclarator" && key === "id") return false;
  if (isFunction(parent) && key === "params") return false;
  return true;
}

/** `source[start, end)` with `edits` (within it, not overlapping) applied. */
export function apply(source: string, start: number, end: number, edits: readonly Edit[]): string {
  let out = "";
  let at = start;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += source.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + source.slice(at, end);
}

/** The 1-based line of an offset. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** A property key as written in output: bare when it is an identifier, quoted otherwise. */
export function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
