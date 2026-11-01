// @reactre/core's default runtime is index.ts without its async code. Every line that
// @reactre/core/features/async and features/actions need in the core (async memos, waiting for a
// value, holding an update for a transition) sits between marker comments, with the lines it
// replaces kept as comments:
//
//   // #if ASYNC
//   (the code with the async runtime)
//   // #else
//   // (the code without it, commented out)
//   // #endif
//
// stripAsync drops each block, keeping its #else part uncommented, so the default build (dist,
// the size budgets, the benchmark app) compiles the source as it was before the async runtime
// existed, byte for byte. dist/async is the source as it is. As in @reactre/compat (see its
// withoutSlicing.ts), a define that turns the branches off would not do: Bun's minifier names
// symbols by how often they are used, dead code included, so the bundle's names would move.
//
// This module is for builds: the package's own (build.ts), its size budgets, and the benchmark
// app's. It is not one of the package's exports.

import type { BunPlugin } from "bun";

const IF = "// #if ASYNC",
  ELSE = "// #else",
  END = "// #endif";

/** Source `source` without its async blocks: each one's #else part, or nothing. */
export function stripAsync(source: string): string {
  const out: string[] = [];
  // 0 outside a block, 1 in its code, 2 in its #else part.
  let part = 0;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t === IF || t === ELSE || t === END) {
      const ok = t === IF ? part === 0 : t === ELSE ? part === 1 : part !== 0;
      if (!ok) throw new Error(`stripAsync: a stray "${t}"`);
      part = t === IF ? 1 : t === ELSE ? 2 : 0;
    } else if (part === 0) out.push(line);
    // A commented-out blank line is blank.
    else if (part === 2) out.push(t === "//" ? "" : line.replace(/^(\s*)\/\/ ?/, "$1"));
  }
  if (part !== 0) throw new Error(`stripAsync: a "${IF}" without "${END}"`);
  return out.join("\n");
}

/** A Bun plugin that loads @reactre/core's index.ts without its async blocks (see stripAsync). */
export const withoutAsync: BunPlugin = {
  name: "reactre-core-without-async",
  setup(build) {
    build.onLoad({ filter: /[\\/]core[\\/]src[\\/]index\.ts$/ }, async (args) => ({
      contents: stripAsync(await Bun.file(args.path).text()),
      loader: "ts",
    }));
  },
};
