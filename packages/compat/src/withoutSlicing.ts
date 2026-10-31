// @reactre/compat's builds compile core.ts without time slicing (@reactre/full-compat's alone has
// it) and, but for the development builds, without Fast Refresh. Every line core.ts adds or
// changes for either sits between marker comments, named SLICING or REFRESH, with the lines it
// replaces kept as comments:
//
//   // #if SLICING
//   (the code with time slicing)
//   // #else
//   // (the code without it, commented out)
//   // #endif
//
// stripBlocks drops each block of a name, keeping its #else part uncommented, so compat's builds
// compile the source as it was before slicing and Fast Refresh existed, byte for byte. Blocks of
// another name are left as they are. A define that turns the branches off is not enough: Bun's
// minifier names symbols by how often they are used, dead code included, so the bundle's names,
// and its gzip size, would move.

import type { BunPlugin } from "bun";

/** The blocks core.ts marks: time slicing, and Fast Refresh (development builds only). */
export type Block = "SLICING" | "REFRESH";

const ELSE = "// #else",
  END = "// #endif";

/** Source `source` without its `name` blocks: each one's #else part, or nothing. */
export function stripBlocks(source: string, name: Block): string {
  const IF = "// #if " + name;
  const out: string[] = [];
  // 0 outside a block, 1 in its code, 2 in its #else part; 3 in another name's block.
  let part = 0;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (part === 3 || (part === 0 && t.startsWith("// #if ") && t !== IF)) {
      // Another name's block passes through whole.
      part = t === END ? 0 : 3;
      out.push(line);
    } else if (t === IF || t === ELSE || t === END) {
      const next = t === IF ? 1 : t === ELSE ? 2 : 0;
      if (t === IF ? part !== 0 : t === ELSE ? part !== 1 : part === 0) throw new Error(`stripBlocks: a stray "${t}"`);
      part = next;
    } else if (part === 0) out.push(line);
    // A commented-out blank line is blank.
    else if (part === 2) out.push(t === "//" ? "" : line.replace(/^(\s*)\/\/ ?/, "$1"));
  }
  if (part === 1 || part === 2) throw new Error(`stripBlocks: a "${IF}" without "${END}"`);
  return out.join("\n");
}

/** Source `source` without its time slicing (see stripBlocks). */
export function stripSlicing(source: string): string {
  return stripBlocks(source, "SLICING");
}

/** A Bun plugin that loads @reactre/compat's core.ts without the blocks `names` (see stripBlocks). */
export function without(...names: Block[]): BunPlugin {
  return {
    name: "reactre-compat-without-" + names.join("-").toLowerCase(),
    setup(build) {
      build.onLoad({ filter: /[\\/]compat[\\/]src[\\/]core\.ts$/ }, async (args) => {
        let contents = await Bun.file(args.path).text();
        for (const name of names) contents = stripBlocks(contents, name);
        return { contents, loader: "ts" };
      });
    },
  };
}

/**
 * The plugin @reactre/compat's production builds load core.ts with: without time slicing and
 * without Fast Refresh, as it was before either existed.
 */
export const withoutSlicing: BunPlugin = without("SLICING", "REFRESH");
