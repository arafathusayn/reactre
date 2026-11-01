// Builds @reactre/core's dist: the entries and the feature modules, for the browser, with
// index.ts compiled without its async code (src/withoutAsync.ts), as it was before that existed;
// and dist/async/index.js, index.ts as it is, the async runtime that @reactre/core/features/async
// and features/actions need. The feature modules import "@reactre/core", which resolves to one or
// the other (package.json's "reactre-async" and "development" conditions, or @reactre/plugin).
//
//   bun run build

import { rmSync } from "node:fs";
import { join } from "node:path";

import { withoutAsync } from "./src/withoutAsync.ts";

const dir = import.meta.dir;
const features = [
  "selectors",
  "owner",
  "timing",
  "reaction",
  "dynamic",
  "store",
  "memo",
  "context",
  "errors",
  "async",
  "actions",
];
const options = {
  root: join(dir, "src"),
  target: "browser",
  format: "esm",
  packages: "external",
} as const;

rmSync(join(dir, "dist"), { recursive: true, force: true });
for (const r of [
  await Bun.build({
    ...options,
    entrypoints: ["index.ts", "jsx-runtime.ts", "jsx-dev-runtime.ts", ...features.map((f) => `features/${f}.ts`)].map(
      (f) => join(dir, "src", f),
    ),
    outdir: join(dir, "dist"),
    plugins: [withoutAsync],
  }),
  await Bun.build({ ...options, entrypoints: [join(dir, "src/index.ts")], outdir: join(dir, "dist/async") }),
])
  if (!r.success) throw new AggregateError(r.logs, "@reactre/core: the build failed");
