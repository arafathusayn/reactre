// choice's compiler: each choice leaf's decision in `ch`, and the graph that takes it
// (`g: choice.g(...)`). Purity is the core's check; types check the rest (a choice that may not
// resolve, a choice with other keys).
//
// What it checks, that types can't: choices that go to each other with the same data (M527). Each
// is pure, so the same data decides the same step again: the cycle never ends (./always.ts's check).

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { cycles, listed } from "./always.ts";
import { factsOf } from "./read.ts";

function checkFile({ program, report }: FileContext): void {
  for (const machine of factsOf(program).machines) {
    if (!machine.shape.uses.has("choice")) continue;
    for (const { nodes, at } of cycles(machine, "choice"))
      report(
        at.call,
        nodes.length === 1
          ? `the choice ${JSON.stringify(nodes[0])} goes to itself with the same data, forever: make it decide`
          : `the choices ${listed(nodes)} go to each other with the same data, forever: make one decide`,
      );
  }
}

export const choice: FeatureCompiler = {
  keys: ["choice"],
  kinds: { choice: { params: ["data", "state"], moves: true } },
  file: checkFile,
  shape: () => ({
    machine: ({ local, handler }) => {
      const found: string[] = [];
      return {
        key(state, _key, value) {
          const code = handler(value, "choice");
          if (code !== null) found.push(`${JSON.stringify(state)}: ${code}`);
        },
        emit: () =>
          found.length > 0
            ? { fields: [`ch: { ${found.join(", ")} }`], graph: (inner) => `${local}.g(${inner ?? ""})` }
            : {},
      };
    },
  }),
};
