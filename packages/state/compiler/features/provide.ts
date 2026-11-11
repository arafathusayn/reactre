// provide's compiler: setup's actions and guards are runtime values, so their expressions are kept,
// as written, in module constants where the setup call was (`__reactreStateActions_<shape>`,
// `__reactreStateGuards_<shape>`). A handler's `guards` compiles to the guards' constant; its
// `actions` to the feature's names (`provide.n`, so `actions.track` is `"track"`, which `enq`
// records by name). A machine that enqueues a named action gets the actions in `j`, and the `action`
// runner joins its dispatcher. Unused, the constants are dropped by the bundler: listing provide costs
// nothing. Nothing to check that types can't.

import type { FeatureCompiler } from "../feature.ts";
import { recorded } from "./effects.ts";

export const provide: FeatureCompiler = {
  values: ["actions", "guards"],
  shape: ({ name, options, local, src }) => {
    if (local === null) return {}; // without the opt-in, actions and guards are type errors
    const actions = options.get("actions")?.value;
    const guards = options.get("guards")?.value;
    const declarations = [
      ...(actions === undefined ? [] : [`const __reactreStateActions_${name} = ${src(actions)};`]),
      ...(guards === undefined ? [] : [`const __reactreStateGuards_${name} = ${src(guards)};`]),
    ];
    return {
      ...(declarations.length > 0 && { declarations: declarations.join("\n") }),
      machine: () => {
        let named = false;
        return {
          value: (value) => {
            if (value === "guards") return `__reactreStateGuards_${name}`;
            named = true;
            return `${local}.n`;
          },
          emit: () =>
            named && actions !== undefined
              ? { fields: [`j: __reactreStateActions_${name}`], effects: recorded() ? [`${local}.q`] : [] }
              : {},
        };
      },
    };
  },
};
