// @reactre/core's builds are index.ts with some of its code stripped. Every line that a build
// leaves out sits between marker comments that name what it is, with the lines it replaces kept
// as comments:
//
//   // #if ASYNC
//   (the code with the async runtime)
//   // #else
//   // (the code without it, commented out)
//   // #endif
//
// The names:
//
//   ASYNC  what @reactre/core/features/async and features/actions need in the core (async memos,
//          waiting for a value, holding an update for a transition).
//   DEV    the development build's diagnostics: warnings that name a code and a fix, and guards
//          that throw where the production build would loop. features/hydrate.ts has them too
//          (its mismatch warning): its builds are made as index.ts's are.
//   TYPES  type declarations added since a release (a function's overloads), which ship no code.
//          Bun's minifier names locals by the letters of the whole source, types included, so
//          they are stripped from the builds whose bytes the size budgets hold.
//
// `strip` drops each block of the names it is given, keeping its #else part uncommented; blocks
// of other names are left as they are, markers included. The builds:
//
//   dist/        the default build: without ASYNC, DEV and TYPES (`PRODUCTION`), so the size
//                budgets and the benchmark app compile the source as it was before any of them
//                existed, byte for byte;
//   dist/async/  without DEV and TYPES (`ASYNC_PRODUCTION`): the async runtime, for production;
//   dist/dev/    the source as it is: the async runtime and the diagnostics, for dev servers.
//
// features/memo.ts has DEV and TYPES blocks too (its checks for options only the compiler can
// give, and their types): dist/features/memo.js is built without them, dist/dev/features/memo.js
// with them, and the plugins strip the source as they strip index.ts.
//
// As in @reactre/compat (see its withoutSlicing.ts), a define that turns the branches off would not
// do: Bun's minifier names symbols by how often they are used, dead code included, so the
// bundle's names would move.
//
// This module is for builds: the package's own (build.ts), its size budgets, and the benchmark
// app's; and @reactre/plugin's and @reactre/compiler's Bun builds, which load `strip` from beside
// the index.ts Bun resolves (the `bun` condition), so the markers are read by the version of the
// core that wrote them. It is not one of the package's exports.

import type { BunPlugin } from "bun";

/** The names of the blocks index.ts marks. */
export type Block = "ASYNC" | "DEV" | "TYPES";

/** What the default build strips. */
export const PRODUCTION: readonly Block[] = ["ASYNC", "DEV", "TYPES"];
/** What the async build strips. */
export const ASYNC_PRODUCTION: readonly Block[] = ["DEV", "TYPES"];

const IF = /^\/\/ #if (\w+)$/,
  ELSE = "// #else",
  END = "// #endif";

/** An open block: its name, whether it is dropped, and whether it is in its #else part. */
type Open = { readonly name: string; readonly drop: boolean; alt: boolean };

/**
 * Source `source` without its blocks named in `names`: each one's #else part, or nothing.
 *
 * A block may hold blocks of other names in its code (a DEV block in an ASYNC block's code, for
 * the code the two share); not in its #else part, which is commented out.
 */
export function strip(source: string, names: readonly string[]): string {
  const out: string[] = [];
  const open: Open[] = [];
  for (const line of source.split("\n")) {
    const t = line.trim();
    const m = IF.exec(t),
      top = open[open.length - 1];
    if (m !== null || t === ELSE || t === END) {
      const stray =
        m !== null
          ? top?.alt === true || open.some((o) => o.name === m[1])
          : top === undefined || (t === ELSE && top.alt);
      if (stray) throw new Error(`strip: a stray "${t}"`);
      if (m !== null) open.push({ name: m[1]!, drop: names.includes(m[1]!), alt: false });
      else if (t === ELSE) top!.alt = true;
      // A block that stays keeps its markers, where what holds it stays.
      if (open.every((o) => !o.drop)) out.push(line);
      if (t === END) open.pop();
    } else if (open.every((o) => !o.drop)) out.push(line);
    // Only the innermost block can be in its #else part: a commented-out blank line is blank.
    else if (top!.alt && open.every((o) => o === top || !o.drop))
      out.push(t === "//" ? "" : line.replace(/^(\s*)\/\/ ?/, "$1"));
  }
  if (open.length !== 0) throw new Error(`strip: a "// #if ${open[0]!.name}" without "${END}"`);
  return out.join("\n");
}

/** Source `source` without its async blocks (see `strip`). */
export function stripAsync(source: string): string {
  return strip(source, ["ASYNC"]);
}

/** Source `source` without its development blocks, nor its type blocks (see `strip`). */
export function stripDev(source: string): string {
  return strip(source, ASYNC_PRODUCTION);
}

/**
 * A Bun plugin that loads @reactre/core's index.ts, and features/memo.ts and features/hydrate.ts
 * (which have development and type blocks of their own), without the blocks `names` (see `strip`).
 */
export function without(...names: Block[]): BunPlugin {
  return {
    name: "reactre-core-without-" + names.join("-").toLowerCase(),
    setup(build) {
      build.onLoad({ filter: /[\\/]core[\\/]src[\\/](?:index|features[\\/](?:memo|hydrate))\.ts$/ }, async (args) => ({
        contents: strip(await Bun.file(args.path).text(), names),
        loader: "ts",
      }));
    },
  };
}

/**
 * The plugin the default build loads index.ts with: without its async, development and type
 * blocks (`PRODUCTION`), as it was before any of them existed.
 */
export const withoutAsync: BunPlugin = without(...PRODUCTION);
