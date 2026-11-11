// Builds @reactre/state's dist: one ES module beside each module package.json's exports name, read
// from each export's "reactre-source" condition, so an entry added there is built too.
//
//   dist/            the runtime (src/): the actor, the tasks module, each opt-in feature, the
//                    entries (/serialize, /scxml, /graph, /test, /react) and the utils, for the
//                    browser;
//   dist/compiler/, dist/plugin/, dist/codemod/
//                    the build tools (compiler/, plugin/, codemod/), which run in a bundler's or
//                    Bun's process.
//
// Each half is split into shared chunks, so a module the entries share (the actor's ./index.ts,
// which every feature imports) is one module in an app, as it is from the sources. The two halves
// share nothing: the tools import none of the runtime, and the code the compiler writes imports
// the runtime by its package name (`@reactre/state/run`), which resolves to dist/.
//
//   bun run build      (then ../../scripts/declarations.ts writes the .d.ts files beside them)

import { globSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
  readonly exports: { readonly [entry: string]: { readonly "reactre-source": string } };
};
// Each source relative to the package, without "./" (globSync's matches have none).
const sources = Object.values(pkg.exports).flatMap(({ "reactre-source": source }) =>
  (source.includes("*") ? globSync(source, { cwd: dir }) : [source]).map((s) => s.replace(/^\.\//, "")),
);
const runtime = sources.filter((s) => s.startsWith("src/")).map((s) => join(dir, s));
const tools = sources.filter((s) => !s.startsWith("src/")).map((s) => join(dir, s));
const options = { format: "esm", packages: "external", splitting: true, outdir: join(dir, "dist") } as const;

rmSync(join(dir, "dist"), { recursive: true, force: true });
for (const r of [
  await Bun.build({ ...options, entrypoints: runtime, root: join(dir, "src"), target: "browser" }),
  await Bun.build({ ...options, entrypoints: tools, root: dir, target: "node" }),
])
  if (!r.success) throw new AggregateError(r.logs, "@reactre/state: the build failed");
