// Builds @reactre/core's dist, for the browser (see src/withoutAsync.ts for the blocks each strips):
//
//   dist/            the entries and the feature modules, with index.ts compiled without its
//                    async, development and type blocks, as it was before any of them existed;
//   dist/async/      index.ts with the async runtime that @reactre/core/features/async and
//                    features/actions need, for production: without the development blocks;
//   dist/dev/        index.ts as it is: the async runtime and the development diagnostics; and
//                    the feature modules with development blocks (DEV_FEATURES: features/memo.ts,
//                    hydrate.ts, context.ts, ...) and server.ts as they are, with their checks,
//                    warnings, misuse errors and the error an <Errored>'s hydration marker names
//                    (dist/features/*.js and dist/server.js have none).
//
// dist/hydrate/ holds hydration's <Loading> and <Errored> (src/hydrate/*.ts), and dist/server/ the
// server's versions of the feature modules.
//
// The feature modules import "@reactre/core", which resolves to one of the three: package.json's
// "reactre-async" condition picks dist/async, "development" dist/dev, and @reactre/plugin picks
// for the program it builds.
//
//   bun run build

import { rmSync } from "node:fs";
import { join } from "node:path";

import { ASYNC_PRODUCTION, DEV_FEATURES, without, withoutAsync } from "./src/withoutAsync.ts";

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
  "index",
  "effects",
  "lists",
  "for",
  // Its development blocks are stripped too (`without`); dist/dev/features/hydrate.js keeps them.
  "hydrate",
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
    entrypoints: [
      "index.ts",
      "jsx-runtime.ts",
      "jsx-dev-runtime.ts",
      ...features.map((f) => `features/${f}.ts`),
      // Server rendering (@reactre/core/server), which imports the core as the feature modules do.
      "server.ts",
      "server.browser.ts",
      "server/async.ts",
      "server/dynamic.ts",
      "server/effects.ts",
      "server/errors.ts",
      "server/hydrate.ts",
      "server/reaction.ts",
      "server/timing.ts",
      // Hydration's <Loading> and <Errored>, which import the feature modules as an app does.
      "hydrate/async.ts",
      "hydrate/errors.ts",
      "hydrate/for.ts",
    ].map((f) => join(dir, "src", f)),
    outdir: join(dir, "dist"),
    plugins: [withoutAsync],
  }),
  await Bun.build({
    ...options,
    entrypoints: [join(dir, "src/index.ts")],
    outdir: join(dir, "dist/async"),
    plugins: [without(...ASYNC_PRODUCTION)],
  }),
  // With the development builds of the feature modules that have development blocks:
  // features/memo, which holds its checks too, features/hydrate, which holds its mismatch
  // warnings, and those with Solid 2.0's messages and misuse errors; and of server.ts, whose
  // <Errored> marker names the error.
  await Bun.build({
    ...options,
    entrypoints: ["index.ts", ...DEV_FEATURES.map((f) => `features/${f}.ts`), "server.ts"].map((f) =>
      join(dir, "src", f),
    ),
    outdir: join(dir, "dist/dev"),
  }),
])
  if (!r.success) throw new AggregateError(r.logs, "@reactre/core: the build failed");
