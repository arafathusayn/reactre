// nested's compiler: the hierarchy's graph and step, from the feature value (`g: nested.g`,
// `y: nested.y`). Parents' handlers are compiled by the core, as any node's: a parent is a key of
// `states` that is a prefix of a leaf's name. Nothing here checks anything: types see the names.
// A machine with no parent (no dotted leaf) gets none of it, so listing nested costs it nothing.
// The graph is the base of `g`: always, choice, output and reenter wrap it.
//
// A machine with no parallel node gets the flat graph and step (`__flatGraph`, `__flatNested`): the
// snapshot is always one leaf, so the region code (regions in the snapshot, `place`, `unitOf`,
// `finished`'s region walk) is dead code the bundle would still hold. The choice is static, from
// setup's `parallel`: a machine that lists no parallel node never reads `p`, so it never needs it.
// The small pair is imported by name, not read off `nested`: the feature value holds both graphs, so
// a property read would keep the full one in the bundle too. A shallow `back` picks its small wrapper.

import type { FeatureCompiler } from "../feature.ts";

export const nested: FeatureCompiler = {
  shape: ({ options }) => {
    // A parallel node is one setup's `parallel` names with a string literal: the parallel feature
    // emits `p` for those, and only those. A malformed `parallel` (reported there) emits none.
    const parallel = options.get("parallel")?.value;
    const regions =
      parallel?.type === "ArrayExpression" &&
      parallel.elements.some((e) => e?.type === "Literal" && typeof e.value === "string");
    return {
      machine: function ({ local, states }) {
        return {
          emit() {
            const shallow = this.shallow === true;
            return states.some((state) => state.includes("."))
              ? {
                  graph: () =>
                    regions ? `${local}.g` : shallow ? "__reactreStateFlatShallow" : "__reactreStateFlatGraph",
                  // The base step: features after it in the table wrap it.
                  step: () => (regions ? `${local}.y` : "__reactreStateFlatNested"),
                  lifecycle: "general",
                  ...(regions
                    ? {}
                    : {
                        imports: [
                          `import { ${shallow ? "__flatGraphShallow as __reactreStateFlatShallow" : "__flatGraph as __reactreStateFlatGraph"}, __flatNested as __reactreStateFlatNested } from "@reactre/state/nested";`,
                        ],
                      }),
                }
              : {};
          },
        };
      },
    };
  },
};
