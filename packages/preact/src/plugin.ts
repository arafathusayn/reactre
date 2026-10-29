// @reactre/preact/plugin: @reactre/preact/compiler for Vite, Rollup, Rolldown, esbuild, webpack
// and Rspack, built by unplugin, with the same options.
//
//   // vite.config.ts
//   import { reactrePreact } from "@reactre/preact/plugin";
//   export default { plugins: [reactrePreact.vite({ source: "react", off: ["@classes"] })] };
//
// Each bundler has its entry, as unplugin makes them: reactrePreact.vite, .rollup, .rolldown,
// .esbuild, .webpack and .rspack. For Bun, @reactre/preact/compiler is the plugin.
//
// What it does:
//   - Resolves `preact`, `preact/hooks`, `preact/compat`, `react`, `react-dom` (with /client) and
//     their JSX runtimes to @reactre/preact's build, in the app and in its dependencies, so no
//     alias is needed. With `off`, `@reactre/preact/core` and `/compat` resolve to the switched
//     module too, so an alias to them still switches.
//   - Compiles the app's .jsx and .tsx files as the Bun plugin does. TypeScript and JSX go through
//     oxc first (./transpile.ts), not Bun's transpiler, so it runs under Node too.
//   - With `off`, the Bun plugin's switch: `preact` and the rest resolve to a module whose
//     switched-off names throw, every module bundled is scanned and one that uses a switched-off
//     API fails the build, and with "Component" off the class-only code goes.
//
// Design decisions:
//   - What `preact` resolves to is @reactre/preact's dist build, by absolute path: JavaScript,
//     which every bundler loads without a TypeScript step.
//   - The plugin runs before the bundler's own JSX transform (`enforce: "pre"`).
//   - Vite's dependency optimizer bundles with plugins of its own: the resolve and the scan go
//     there too, so a dependency's `preact` is the same module as the app's.
//   - No source maps yet: the compiler rewrites text without tracking positions.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUnplugin, type UnpluginInstance } from "unplugin";

import { ALWAYS, checkOff, classesOff, entrySource, offKeys, SOURCES } from "./api.ts";
import { compileJs, type CompilerOptions } from "./compiler.ts";
import { transpile } from "./transpile.ts";

/** @reactre/preact's build, next to src/ and to the built plugin alike. */
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** The JSX runtimes, which resolve to @reactre/preact/jsx-runtime. */
const RUNTIME = /^(?:preact|react)\/jsx-(?:dev-)?runtime$/;

/** @reactre/preact's own entries, which an app may import or alias `preact` to. */
const OWN = /^@reactre\/preact\/(?:core|compat)$/;

/** The id of the module `preact` (core) or `react` (compat) resolves to with APIs off. */
const VIRTUAL = "\0reactre-preact-off:";

/** The modules the scan reads. */
const SCRIPT = /\.[cm]?[jt]sx?$/;

/** Loads a module of the build, for its exports. */
const loadBuild = createRequire(import.meta.url);

/** A module id without its query or hash. */
const pathOf = (id: string): string => id.replace(/[?#].*$/, "");

/** The entry of @reactre/preact's build that a request resolves to. */
function entryOf(id: string): "core" | "compat" {
  return /^(?:preact(?:\/hooks)?|@reactre\/preact\/core)$/.test(id) ? "core" : "compat";
}

/** The plugin, for every bundler unplugin supports. */
export const reactrePreact: UnpluginInstance<CompilerOptions | undefined, false> = createUnplugin<
  CompilerOptions | undefined,
  false
>((options = {}) => {
  const from = options.source ?? "preact";
  const filter = options.filter ?? /\.[jt]sx$/;
  const skip = (path: string) => /[\\/]node_modules[\\/]/.test(path) || !!options.exclude?.(path);
  // The keys switched off, read off the build's exports.
  const exports = {
    core: Object.keys(loadBuild(join(DIST, "core.js"))),
    compat: Object.keys(loadBuild(join(DIST, "compat.js"))),
  };
  const off = offKeys(options.off ?? [], new Set([...exports.core, ...exports.compat].filter((k) => !ALWAYS.has(k))));
  const switched = off.size > 0;

  const resolveId = (id: string): string | null =>
    RUNTIME.test(id)
      ? join(DIST, "jsx-runtime.js")
      : switched && (SOURCES.test(id) || OWN.test(id))
        ? VIRTUAL + entryOf(id)
        : SOURCES.test(id)
          ? join(DIST, `${entryOf(id)}.js`)
          : null;
  const load = (id: string): string | null => {
    if (!id.startsWith(VIRTUAL)) return null;
    const entry = id.slice(VIRTUAL.length) as "core" | "compat";
    return entrySource(join(DIST, `${entry}.js`), exports[entry], off);
  };
  /** The scan, and the class switch for the build's own modules: the code to use, or null. */
  const check = (code: string, id: string): string | null => {
    if (!switched) return null;
    const path = pathOf(id);
    checkOff(code, path, off);
    return off.has("Component") && path.startsWith(DIST) ? classesOff(code) : null;
  };

  return {
    name: "@reactre/preact/plugin",
    enforce: "pre",
    resolveId,
    loadInclude: (id) => id.startsWith(VIRTUAL),
    load,
    transformInclude: (id) => SCRIPT.test(pathOf(id)),
    transform(code, id) {
      const path = pathOf(id);
      const checked = check(code, id);
      if (filter.test(path) && !skip(path)) return { code: compileJs(transpile(path, code, from), from), map: null };
      return checked === null ? null : { code: checked, map: null };
    },
    vite: {
      config: () => ({
        optimizeDeps: {
          rolldownOptions: {
            plugins: [
              {
                name: "@reactre/preact/plugin:deps",
                resolveId,
                load,
                transform: (code: string, id: string) => (SCRIPT.test(pathOf(id)) ? check(code, id) : null),
              },
            ],
          },
        },
      }),
    },
  };
});

export default reactrePreact;
