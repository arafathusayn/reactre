// route's compiler: each node's `route` (a handler like an event's) in `ro`, the route event in
// `e`, and the step that takes it (`y: route.y(...)`). Purity is the core's check; types check the
// rest (which nodes may take a route, the event's `to`).

import type { FeatureCompiler } from "../feature.ts";

export const route: FeatureCompiler = {
  keys: ["route"],
  shape: () => ({
    machine: ({ local, handler }) => {
      const found: string[] = [];
      return {
        key(state, _key, value) {
          const code = handler(value, "on");
          if (code !== null) found.push(`${JSON.stringify(state)}: ${code}`);
        },
        emit: () =>
          found.length > 0
            ? {
                fields: [`ro: { ${found.join(", ")} }`],
                events: ["route"],
                step: (inner) => `${local}.y(${inner ?? ""})`,
              }
            : {},
      };
    },
  }),
};
