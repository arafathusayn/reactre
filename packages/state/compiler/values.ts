// Static metadata, evaluated from immutable module bindings without executing application code.
// A resolved expression keeps its AST and defining module: contract hashes still see `types<T>()`.
// Anything unresolved, mutable or ambient fails closed rather than becoming an invented value.

import type { Node, Program, StringLiteral } from "oxc-parser";

import { importedModule, resolveImport } from "./modules.ts";

export type StaticValue =
  null | boolean | number | string | readonly StaticValue[] | { readonly [key: string]: StaticValue };

interface Binding {
  readonly init?: Node | null;
  readonly exported?: string;
  readonly import?: { readonly source: string; readonly name: string };
}
interface Scope {
  readonly file: string;
  readonly bindings: ReadonlyMap<string, Binding>;
}
interface Result {
  readonly known: boolean;
  readonly value?: StaticValue | undefined;
  readonly node?: Node;
}
const FAIL: Result = { known: false };
const modules = new WeakMap<Program, Scope>();

function primitive(value: StaticValue | undefined): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

/** Resolve an expression to a JSON-like value. `undefined` means it is not statically known. */
export function staticValue(file: string, program: Program, node: Node | null | undefined): StaticValue | undefined {
  return value(node, at(file, program), new Set()).value;
}

/** A literal/array/object expression, resolving immutable bindings to their defining source node. */
export function staticNode(file: string, program: Program, node: Node | null | undefined): Node | null {
  return value(node, at(file, program), new Set()).node ?? null;
}

function at(file: string, program: Program): Scope {
  const known = modules.get(program);
  if (known !== undefined) return known;
  const bindings = new Map<string, Binding>();
  for (const top of program.body) {
    const statement = top.type === "ExportNamedDeclaration" && top.declaration !== null ? top.declaration : top;
    if (statement.type === "VariableDeclaration" && statement.kind === "const")
      for (const d of statement.declarations)
        if (d.id.type === "Identifier") {
          const binding: Binding = { init: d.init };
          bindings.set(d.id.name, top === statement ? binding : { ...binding, exported: d.id.name });
        }
    if (statement.type === "ImportDeclaration")
      for (const s of statement.specifiers)
        bindings.set(s.local.name, {
          import: {
            source: statement.source.value,
            name:
              s.type === "ImportSpecifier"
                ? s.imported.type === "Identifier"
                  ? s.imported.name
                  : String(s.imported.value)
                : s.type === "ImportDefaultSpecifier"
                  ? "default"
                  : "*",
          },
        });
    if (top.type === "ExportNamedDeclaration" && top.declaration === null)
      for (const s of top.specifiers) {
        if (s.local.type !== "Identifier" || s.exported.type !== "Identifier") continue;
        const binding = bindings.get(s.local.name);
        if (binding !== undefined) bindings.set(s.local.name, { ...binding, exported: s.exported.name });
        else if (top.source !== null)
          bindings.set(s.local.name, {
            import: { source: top.source.value, name: s.local.name },
            exported: s.exported.name,
          });
      }
  }
  const scope = { file, bindings };
  modules.set(program, scope);
  return scope;
}

function value(node: Node | null | undefined, scope: Scope, seen: ReadonlySet<string>): Result {
  if (node === null || node === undefined) return FAIL;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "bigint" || node.value instanceof RegExp || !primitive(node.value)
        ? FAIL
        : { known: true, value: node.value, node };
    case "TemplateLiteral": {
      let out = "";
      for (const [i, quasi] of node.quasis.entries()) {
        out += quasi.value.cooked ?? quasi.value.raw;
        const expr = node.expressions[i];
        if (expr === undefined) continue;
        const result = value(expr, scope, seen);
        if (!result.known || !primitive(result.value) || result.value === null) return FAIL;
        out += String(result.value);
      }
      // A template with no expressions is a string literal: `\`2\`` is "2", and a version written
      // that way is the same version. (A template with expressions is a string too, but its value
      // is only known when each expression is, which the loop above checked.)
      return { known: true, value: out, node };
    }
    case "UnaryExpression": {
      const operand = value(node.argument, scope, seen);
      if (!operand.known) return FAIL;
      if ((node.operator === "+" || node.operator === "-") && typeof operand.value === "number") {
        const computed = node.operator === "-" ? -operand.value : operand.value;
        return Number.isFinite(computed) ? { known: true, value: computed, node } : FAIL;
      }
      if (node.operator === "!" && operand.value !== undefined) return { known: true, value: !operand.value, node };
      return FAIL;
    }
    case "BinaryExpression":
    case "LogicalExpression": {
      const left = value(node.left, scope, seen);
      if (!left.known) return FAIL;
      if (node.operator === "??" || node.operator === "||" || node.operator === "&&") {
        if (left.value === undefined) return FAIL;
        const takeLeft =
          node.operator === "??" ? left.value !== null : node.operator === "||" ? !!left.value : !left.value;
        return takeLeft ? left : value(node.right, scope, seen);
      }
      const right = value(node.right, scope, seen);
      if (!right.known) return FAIL;
      if (node.operator === "===" || node.operator === "!==") {
        const equal = left.value === right.value;
        return { known: true, value: node.operator === "===" ? equal : !equal, node };
      }
      if (typeof left.value === "number" && typeof right.value === "number") {
        const a = left.value;
        const b = right.value;
        const computed =
          node.operator === "+"
            ? a + b
            : node.operator === "-"
              ? a - b
              : node.operator === "*"
                ? a * b
                : node.operator === "/" && b !== 0
                  ? a / b
                  : node.operator === "%" && b !== 0
                    ? a % b
                    : node.operator === "**"
                      ? a ** b
                      : undefined;
        if (computed !== undefined) return Number.isFinite(computed) ? { known: true, value: computed, node } : FAIL;
        const compared =
          node.operator === "<"
            ? a < b
            : node.operator === "<="
              ? a <= b
              : node.operator === ">"
                ? a > b
                : node.operator === ">="
                  ? a >= b
                  : undefined;
        if (compared !== undefined) return { known: true, value: compared, node };
      }
      if (node.operator === "+" && typeof left.value === "string" && primitive(right.value) && right.value !== null)
        return { known: true, value: left.value + String(right.value), node };
      if (node.operator === "+" && typeof right.value === "string" && primitive(left.value) && left.value !== null)
        return { known: true, value: String(left.value) + right.value, node };
      return FAIL;
    }
    case "ConditionalExpression": {
      const test = value(node.test, scope, seen);
      if (!test.known || test.value === undefined) return FAIL;
      return value(test.value ? node.consequent : node.alternate, scope, seen);
    }
    case "Identifier": {
      if (node.name === "undefined") return { known: true, value: undefined, node };
      const binding = scope.bindings.get(node.name);
      if (binding === undefined) return FAIL;
      if (binding.init !== undefined) {
        if (binding.init === null) return FAIL;
        const key = `${scope.file}:${node.name}`;
        return seen.has(key) ? FAIL : value(binding.init, scope, new Set(seen).add(key));
      }
      if (binding.import === undefined) return FAIL;
      return external(
        scope.file,
        binding.import.source,
        binding.import.name,
        new Set(seen).add(`${scope.file}:${node.name}`),
      );
    }
    case "MemberExpression": {
      const property = node.computed
        ? value(node.property, scope, seen).value
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      if ((typeof property !== "string" && typeof property !== "number") || forbidden(String(property))) return FAIL;
      if (node.object.type === "Identifier") {
        const namespace = scope.bindings.get(node.object.name);
        if (namespace?.import?.name === "*")
          return external(scope.file, namespace.import.source, String(property), seen);
      }
      const owner = value(node.object, scope, seen);
      if (!owner.known) return FAIL;
      if (owner.node?.type === "ObjectExpression" || owner.node?.type === "ArrayExpression") {
        const selected = select(owner.node, String(property), scope, seen);
        if (selected === null) return FAIL;
        return value(selected, scope, seen);
      }
      // Every known object/array retains its literal node: even a conditional or cast returns the
      // chosen expression, not an inline-object result. Unsupported node kinds fail closed above.
      return FAIL;
    }
    case "ObjectExpression": {
      const out: { [key: string]: StaticValue } = {};
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const spread = value(property.argument, scope, seen);
          if (!spread.known || spread.value === null || typeof spread.value !== "object" || Array.isArray(spread.value))
            return FAIL;
          for (const [key, item] of Object.entries(spread.value)) if (!forbidden(key)) out[key] = item;
          continue;
        }
        if (property.kind !== "init") return FAIL;
        // An object literal's uncomputed ESTree key is an Identifier or Literal. A TemplateLiteral
        // is computed (and evaluated), while class-only private names never reach this switch.
        if (!property.computed && property.key.type !== "Identifier" && property.key.type !== "Literal") return FAIL;
        const key = property.computed
          ? value(property.key, scope, seen).value
          : property.key.type === "Identifier"
            ? property.key.name
            : (property.key as StringLiteral).value;
        if ((typeof key !== "string" && typeof key !== "number") || forbidden(String(key))) return FAIL;
        const result = value(property.value, scope, seen);
        // `types<T>()` is opaque metadata. Retain its expression in the AST; it has no JS value.
        if (!result.known || result.value === undefined) out[String(key)] = null;
        else out[String(key)] = result.value;
      }
      return { known: true, value: out, node };
    }
    case "ArrayExpression": {
      const out: StaticValue[] = [];
      for (const item of node.elements) {
        if (item === null) return { known: false, node };
        if (item.type === "SpreadElement") {
          const spread = value(item.argument, scope, seen);
          if (!spread.known || !Array.isArray(spread.value)) return { known: false, node };
          out.push(...spread.value);
        } else {
          const result = value(item, scope, seen);
          // An element that isn't a static value (an imported feature, a function) leaves the
          // array's *value* unknown, but its *shape* is still this literal: `staticNode` returns it
          // for a caller that reads the elements as references (`use: [nested, history]`), while
          // `staticValue` stays fail-closed.
          if (!result.known || result.value === undefined) return { known: false, node };
          out.push(result.value);
        }
      }
      return { known: true, value: out, node };
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return value(node.expression, scope, seen);
    case "ChainExpression":
      return value(node.expression as unknown as Node, scope, seen);
  }
  return FAIL;
}

function forbidden(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

/** A named property or array element, retaining its defining expression. */
function select(object: Node, name: string, scope: Scope, seen: ReadonlySet<string>): Node | null {
  if (object.type === "ObjectExpression") {
    for (const property of object.properties) {
      if (property.type !== "Property" || property.kind !== "init") continue;
      // Same invariant as ObjectExpression above; no parser-produced fallback to manufacture.
      if (!property.computed && property.key.type !== "Identifier" && property.key.type !== "Literal") continue;
      const key = property.computed
        ? value(property.key, scope, seen).value
        : property.key.type === "Identifier"
          ? property.key.name
          : (property.key as StringLiteral).value;
      if (String(key) === name) return property.value;
    }
  }
  if (object.type === "ArrayExpression" && /^(0|[1-9]\d*)$/.test(name)) {
    const element = object.elements[Number(name)];
    return element?.type === "SpreadElement" ? null : (element ?? null);
  }
  return null;
}

function external(file: string, specifier: string, name: string, seen: ReadonlySet<string>): Result {
  const path = resolveImport(file, specifier);
  const module = importedModule(file, specifier);
  if (path === null || module === null) return FAIL;
  const key = `${path}:${name}`;
  if (seen.has(key)) return FAIL;
  const next = new Set(seen).add(key);
  const scope = at(path, module.program);
  if (name === "default")
    for (const statement of module.program.body)
      if (statement.type === "ExportDefaultDeclaration")
        return value(statement.declaration as unknown as Node, scope, next);
  for (const [, binding] of scope.bindings)
    if (binding.exported === name) {
      // An export and its local const are different bindings. In particular, `const X` may share
      // the export's name without being its own definition. A local import is still followed here:
      // the entry carries the defining specifier, not its original export's name or file.
      if (binding.init !== undefined) return binding.init === null ? FAIL : value(binding.init, scope, next);
      if (binding.import !== undefined) return external(scope.file, binding.import.source, binding.import.name, next);
    }
  for (const statement of module.program.body)
    if (statement.type === "ExportAllDeclaration" && statement.source !== null) {
      const found = external(path, statement.source.value, name, next);
      if (found.known) return found;
    }
  return FAIL;
}
