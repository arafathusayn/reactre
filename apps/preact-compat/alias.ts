// Resolves `react`, `react-dom` and their subpaths to the runtime under check: preact/compat
// 11.1.0 (the oracle) or @reactre/preact/compat, each through its shim with the same stubs.

import type { BunPlugin } from "bun";

/** The runtimes a page can be built against. */
export type Runtime = "preact" | "reactre-preact";

export function reactAlias(runtime: Runtime): BunPlugin {
  const dir = import.meta.dir;
  const shim = `${dir}/${runtime === "preact" ? "shim-preact" : "shim-reactre"}.ts`;
  const jsx =
    runtime === "preact"
      ? Bun.resolveSync("preact/compat/jsx-runtime", dir)
      : Bun.resolveSync("@reactre/preact/jsx-runtime", dir);
  return {
    name: "react-alias-" + runtime,
    setup(build) {
      build.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: jsx }));
      build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({ path: shim }));
      // The shims' own imports resolve from this folder, whoever imports the shim.
      build.onResolve({ filter: /^(preact|@reactre\/preact)(\/.*)?$/ }, (args) => ({
        path: Bun.resolveSync(args.path, dir),
      }));
    },
  };
}
