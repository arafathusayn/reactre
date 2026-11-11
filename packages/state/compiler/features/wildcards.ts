// wildcards' compiler: the core compiles `on`'s handlers, wildcard keys included, under their keys;
// this only reads `on` to see whether some node has a wildcard, and then wraps the step
// (`y: wildcards.y(...)`). Nothing to check: types see the keys.

import type { FeatureCompiler } from "../feature.ts";

export const wildcards: FeatureCompiler = {
  keys: ["on"],
  shape: () => ({
    machine: ({ local }) => {
      let used = false;
      return {
        key(_state, _key, value) {
          if (value.type !== "ObjectExpression") return;
          for (const p of value.properties) {
            const name =
              p.type === "Property" && p.key.type === "Literal" && typeof p.key.value === "string" ? p.key.value : "";
            if (name === "*" || name.endsWith(".*")) used = true;
          }
        },
        emit: () => (used ? { step: (inner) => `${local}.y(${inner ?? ""})` } : {}),
      };
    },
  }),
};
