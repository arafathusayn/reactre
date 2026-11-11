// history's compiler: `back(parent, to(...))` becomes `({ b: parent, t: step })` (deep), and
// `back(parent, to(...), { child: to(...) })` becomes `({ b: parent, t: step, s: { child: step } })`
// (shallow).
// The parents `back` goes to are listed in `h`, so the snapshot keeps only their last leaves. The
// parent, the fallback and the shallow steps must be written in place to compile.

import type { FeatureCompiler } from "../feature.ts";

export const history: FeatureCompiler = {
  moves: ["back"],
  shape: () => ({
    machine: () => {
      const parents = new Set<string>();
      return {
        move(call, { isMove, compileMove, report, properties }) {
          const [parentArg, fallbackArg, shallowArg] = call.arguments;
          const parent = parentArg?.type === "Literal" && typeof parentArg.value === "string" ? parentArg.value : null;
          if (parent === null) {
            report(
              parentArg ?? call,
              "back's first argument is a parent's name written in place: back(\"edit\", to(...))",
            );
            return "null";
          }
          parents.add(parent);
          // No fallback, or a spread one (not a tuple): type errors, which compile to nothing.
          if (fallbackArg === undefined || fallbackArg.type === "SpreadElement") return "null";
          if (!isMove(fallbackArg)) {
            report(fallbackArg, 'back\'s fallback is to(...) written in place: back("edit", to("edit.draft", data))');
            return "null";
          }
          const fallback = compileMove(fallbackArg);
          // In parentheses: an arrow's body that starts with `{` would be a block.
          if (shallowArg === undefined) return `({ b: ${JSON.stringify(parent)}, t: ${fallback} })`;
          if (shallowArg.type !== "ObjectExpression") {
            report(
              shallowArg,
              `back's shallow steps are an object literal written in place: back("${parent}", to(...), { child: to(...) })`,
            );
            return "null";
          }
          const steps = [...properties(shallowArg, "back's shallow steps")].map(([child, p]) => {
            if (isMove(p.value)) return `${JSON.stringify(child)}: ${compileMove(p.value)}`;
            report(
              p.value,
              `write child "${child}"'s step as to(...) in place: back("${parent}", to(...), { ${child}: to(...) })`,
            );
            return "";
          });
          return `({ b: ${JSON.stringify(parent)}, t: ${fallback}, s: { ${steps.filter(Boolean).join(", ")} } })`;
        },
        emit: () => ({
          fields: parents.size > 0 ? [`h: { ${[...parents].map((h) => `${JSON.stringify(h)}: 1`).join(", ")} }`] : [],
        }),
      };
    },
  }),
};
