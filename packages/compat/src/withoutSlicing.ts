// @reactre/compat's builds compile core.ts without time slicing (@reactre/full-compat's alone has
// it). Every line core.ts adds or changes for slicing sits between marker comments, with the lines
// it replaces kept as comments:
//
//   // #if SLICING
//   (the code with time slicing)
//   // #else
//   // (the code without it, commented out)
//   // #endif
//
// stripSlicing drops each marked block's slicing code and uncomments what it replaces, so compat's
// builds compile the source as it was before slicing existed, byte for byte. A define that turns
// the branches off is not enough: Bun's minifier names symbols by how often they are used, dead
// code included, so the bundle's names, and its gzip size, would move.

import type { BunPlugin } from "bun";

const IF = "// #if SLICING",
  ELSE = "// #else",
  END = "// #endif";

/** Source `source` without its time slicing: each marked block's #else part, or nothing. */
export function stripSlicing(source: string): string {
  const out: string[] = [];
  // 0 outside a block, 1 in its slicing code, 2 in its #else part.
  let part = 0;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t === IF || t === ELSE || t === END) {
      const next = t === IF ? 1 : t === ELSE ? 2 : 0;
      if (t === IF ? part !== 0 : t === ELSE ? part !== 1 : part === 0) throw new Error(`stripSlicing: a stray "${t}"`);
      part = next;
    } else if (part === 0) out.push(line);
    // A commented-out blank line is blank.
    else if (part === 2) out.push(t === "//" ? "" : line.replace(/^(\s*)\/\/ ?/, "$1"));
  }
  if (part !== 0) throw new Error(`stripSlicing: a "${IF}" without "${END}"`);
  return out.join("\n");
}

/** A Bun plugin that loads @reactre/compat's core.ts without time slicing (see stripSlicing). */
export const withoutSlicing: BunPlugin = {
  name: "reactre-compat-without-slicing",
  setup(build) {
    build.onLoad({ filter: /[\\/]compat[\\/]src[\\/]core\.ts$/ }, async (args) => ({
      contents: stripSlicing(await Bun.file(args.path).text()),
      loader: "ts",
    }));
  },
};
