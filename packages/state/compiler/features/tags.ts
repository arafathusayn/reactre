// tags' compiler: each node's tags, meta and description, as written, in `k`. Meta is the table's
// data, read when the module loads: it must be JSON written in place. A call or a variable in it
// type-checks (`Date.now()` is a number), but makes the machine's meta depend on when and where it
// loaded, which the type can't say. That is this compiler's one check.

import type { Expression, Node } from "oxc-parser";

import type { FeatureCompiler } from "../feature.ts";

/**
 * The first part of `value` that isn't a JSON literal written in place, if any. What is never JSON
 * (a function, a class, a bigint, a regular expression, `undefined`) is the type checker's to
 * report: meta's type is JSON.
 */
function notLiteral(value: Expression | Node): Node | null {
  switch (value.type) {
    case "Literal":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "ClassExpression":
      return null;
    case "Identifier":
      return value.name === "undefined" ? null : value;
    case "ArrayExpression":
      for (const e of value.elements) {
        const bad = e === null ? value : notLiteral(e);
        if (bad !== null) return bad;
      }
      return null;
    case "ObjectExpression":
      for (const p of value.properties) {
        if (p.type !== "Property" || p.computed || p.kind !== "init") return p;
        const bad = notLiteral(p.value);
        if (bad !== null) return bad;
      }
      return null;
    case "UnaryExpression":
      return value.operator === "-" && value.argument.type === "Literal" ? null : value;
    case "TemplateLiteral":
      return value.expressions.length === 0 ? null : value;
    default:
      return value;
  }
}

export const tags: FeatureCompiler = {
  keys: ["tags", "meta", "description"],
  shape: () => ({
    machine: ({ src, report }) => {
      const nodes = new Map<string, { tags?: string; meta?: string; description?: string }>();
      return {
        key(state, key, value) {
          const at = nodes.get(state) ?? {};
          nodes.set(state, at);
          if (key === "meta") {
            const bad = notLiteral(value);
            if (bad !== null)
              report(
                bad,
                `state "${state}"'s meta is JSON written in place: a call or a variable makes it depend on when the module loaded. Write the value`,
              );
          }
          if (key === "tags" || key === "meta" || key === "description") at[key] = src(value);
        },
        emit: () => {
          if (nodes.size === 0) return {};
          const entries = [...nodes].map(([node, { tags, meta, description }]) => {
            const parts = [tags ?? "[]", meta ?? "undefined", description ?? "undefined"];
            while (parts.length > 1 && parts[parts.length - 1] === "undefined") parts.pop();
            return `${JSON.stringify(node)}: [${parts.join(", ")}]`;
          });
          return { fields: [`k: { ${entries.join(", ")} }`] };
        },
      };
    },
  }),
};
