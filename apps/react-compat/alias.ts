// Resolves `react`, `react-dom` and their subpaths to a runtime at build time, as a bundler alias
// would in a real app: React itself, or reactre-compat (with or without class components).
//
// The scenarios import from "react" and "react-dom" like any app, so one source checks every
// runtime; only this alias changes between builds.

import { dirname } from "node:path";

import type { BunPlugin } from "bun";

/** The runtimes a page can be built against. */
export type Runtime = "react" | "reactre-compat";

/** Options for `reactAlias`. */
export interface AliasOptions {
  /** reactre-compat only: include class components (reactre-compat/classes). Off by default. */
  readonly classes?: boolean;
}

/**
 * A Bun plugin that resolves `react`, `react-dom` and every subpath of them. For React, each path
 * resolves as written from this folder's dependencies. For reactre-compat, every path maps to
 * the one package root, which provides the APIs of all of them.
 */
export function reactAlias(runtime: Runtime, options: AliasOptions = {}): BunPlugin {
  const compat = Bun.resolveSync(options.classes ? "reactre-compat/classes" : "reactre-compat", import.meta.dir);
  return {
    name: "react-alias-" + runtime,
    setup(build) {
      build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
        if (runtime === "react") return { path: Bun.resolveSync(args.path, import.meta.dir) };
        return { path: compat };
      });
      // reactre-compat imports reactre/dom. A browser build would resolve it to the package's
      // built dist/, which a fresh checkout does not have; Bun's runtime resolution picks the
      // workspace sources (the `bun` export condition), so the check always runs the code in
      // the tree.
      build.onResolve({ filter: /^reactre(\/.*)?$/ }, (args) => ({
        path: Bun.resolveSync(args.path, dirname(args.importer)),
      }));
    },
  };
}
