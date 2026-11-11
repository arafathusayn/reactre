// output's compiler: a parent's `done` (not a parallel node's: that one is parallel's) in `od`, and
// the graph that takes it (`g: output.g(...)`). Purity is the core's check; types check the rest.

import type { FeatureCompiler } from "../feature.ts";

export const output: FeatureCompiler = {
  keys: ["done"],
  kinds: { parentDone: { params: ["data", "state"], moves: true } },
  shape: ({ options }) => {
    // The parallel nodes, whose done is parallel's to compile.
    const value = options.get("parallel")?.value;
    const parallel = new Set(
      value?.type === "ArrayExpression"
        ? value.elements.flatMap((e) => (e?.type === "Literal" && typeof e.value === "string" ? [e.value] : []))
        : [],
    );
    return {
      machine: ({ local, handler, states }) => {
        const found: string[] = [];
        return {
          key(state, _key, value) {
            // A leaf's done is a type error; a parallel node's is parallel's.
            if (parallel.has(state) || !states.some((s) => s.startsWith(`${state}.`))) return;
            const code = handler(value, "parentDone");
            if (code !== null) found.push(`${JSON.stringify(state)}: ${code}`);
          },
          emit: () =>
            found.length > 0
              ? { fields: [`od: { ${found.join(", ")} }`], graph: (inner) => `${local}.g(${inner ?? ""})` }
              : {},
        };
      },
    };
  },
};
