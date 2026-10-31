// Builds @reactre/compat's dist: the client and server entries and the feature modules for the
// browser, sharing chunks, and the compiler and the API keys for Node. core.ts compiles without
// time slicing (src/withoutSlicing.ts), which @reactre/full-compat's build compiles in, and
// without Fast Refresh, which the development build of the client entries in dist/dev keeps
// (package.json's `development` condition resolves it).
//
//   bun run build

import { rmSync } from "node:fs";
import { join } from "node:path";

import { without, withoutSlicing } from "./src/withoutSlicing.ts";

const dir = import.meta.dir;
const src = (files: string[]): string[] => files.map((f) => join(dir, "src", f));
const features = ["classes", "stacks", "keys", "retry", "concurrent", "viewTransitions", "undo"];

rmSync(join(dir, "dist"), { recursive: true, force: true });
for (const r of [
  await Bun.build({
    entrypoints: src([
      "index.ts",
      "core.ts",
      "server.ts",
      "server.browser.ts",
      "server.edge.ts",
      ...features.map((f) => `features/${f}.ts`),
    ]),
    root: join(dir, "src"),
    outdir: join(dir, "dist"),
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { chunk: "chunk-[hash].[ext]" },
    packages: "external",
    plugins: [withoutSlicing],
  }),
  // The development build, with Fast Refresh: the same entries, so a dev server's server renderer
  // shares its core with the client API.
  await Bun.build({
    entrypoints: src([
      "index.ts",
      "core.ts",
      "server.ts",
      "server.browser.ts",
      "server.edge.ts",
      ...features.map((f) => `features/${f}.ts`),
    ]),
    root: join(dir, "src"),
    outdir: join(dir, "dist/dev"),
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { chunk: "chunk-[hash].[ext]" },
    packages: "external",
    plugins: [without("SLICING")],
  }),
  await Bun.build({
    entrypoints: src(["compiler.ts", "api.ts"]),
    root: join(dir, "src"),
    outdir: join(dir, "dist"),
    target: "node",
    format: "esm",
    packages: "external",
  }),
])
  if (!r.success) throw new AggregateError(r.logs, "@reactre/compat: the build failed");
