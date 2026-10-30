// Builds @reactre/full-compat's dist: @reactre/compat's client sources, bundled with time slicing
// compiled in (globalThis.__REACTRE_SLICING__ defined true, see ../compat/src/core.ts), its entry
// and core installing it, and the feature modules sharing that core. The server entries re-export
// @reactre/compat's as they are. @reactre/dom stays a dependency, as in @reactre/compat's build.
//
//   bun run build

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = import.meta.dir;
const compatSrc = join(dirname(Bun.resolveSync("@reactre/compat/package.json", dir)), "src");

/** @reactre/compat's client entries, from its sources: the rest stays a dependency. */
const fromSource: Bun.BunPlugin = {
  name: "compat-sources",
  setup(build) {
    build.onResolve({ filter: /^@reactre\/compat(?:\/core|\/features\/[a-zA-Z]+)?$/ }, (args) => ({
      path: join(
        compatSrc,
        args.path === "@reactre/compat" ? "index.ts" : args.path.slice("@reactre/compat/".length) + ".ts",
      ),
    }));
  },
};

const features = ["classes", "stacks", "keys", "retry", "concurrent", "viewTransitions", "undo"];

rmSync(join(dir, "dist"), { recursive: true, force: true });
const r = await Bun.build({
  entrypoints: [
    "src/index.ts",
    "src/core.ts",
    ...features.map((f) => `src/features/${f}.ts`),
    "src/server.ts",
    "src/server.browser.ts",
    "src/server.edge.ts",
  ].map((f) => join(dir, f)),
  root: join(dir, "src"),
  outdir: join(dir, "dist"),
  target: "browser",
  format: "esm",
  splitting: true,
  naming: { chunk: "chunk-[hash].[ext]" },
  external: ["@reactre/dom", "@reactre/compat/server*"],
  define: { "globalThis.__REACTRE_SLICING__": "true" },
  plugins: [fromSource],
});
if (!r.success) throw new AggregateError(r.logs, "@reactre/full-compat: the build failed");
