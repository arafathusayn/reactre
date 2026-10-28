// @reactre/plugin: reactre's build step for every bundler unplugin supports.
//
// Two modes:
//
//   - core (the default): .jsx and .tsx files are compiled by @reactre/compiler into templates and
//     the code that updates them, as the Bun plugin compiles them.
//   - compat: `react`, `react-dom` and their subpaths resolve to @reactre/compat (or its class
//     build), in the app and in its dependencies, and the app's .jsx and .tsx files are compiled
//     by @reactre/compat/compiler, whose host element trees become templates.
//
// Each bundler's entry (`@reactre/plugin/vite`, `/rollup`, `/rolldown`, `/esbuild`, `/webpack`,
// `/rspack`, `/bun`) is this plugin, built by unplugin for that bundler.
//
// Design decisions:
//   - TypeScript and JSX go through oxc first (./transpile.ts), not Bun's transpiler, so the plugin
//     runs under Node too. The compilers then read oxc's output as they read Bun's.
//   - The plugin runs before the bundler's own JSX transform (`enforce: "pre"`), so every bundler
//     gets plain JavaScript.
//   - Each bundler redirects `react` the way it resolves best: an alias for Vite, which its
//     dependency optimizer applies too, a module replacement for webpack and Rspack, esbuild's own
//     resolve for esbuild, Bun's resolver for Bun, and the plugin context's resolve for Rollup and
//     Rolldown. The bundler resolves the target, so @reactre/compat is the copy the app's own
//     imports get.
//   - No source maps yet: the compilers rewrite text without tracking positions. A transformed
//     file maps to nothing rather than to the wrong line.

import { dirname } from "node:path";

import { compileJs as compileCompat } from "@reactre/compat/compiler";
import { compileJs as compileCore, ReactreCompileError } from "@reactre/compiler";
import { createUnplugin, type UnpluginInstance, type UnpluginOptions } from "unplugin";

import { transpile } from "./transpile.ts";

// #region Options

/** Options for compat mode. */
export interface CompatOptions {
  /** Resolve `react` to @reactre/compat/classes, for apps and libraries with class components. Default false. */
  readonly classes?: boolean;
  /** Compile the app's host element trees to templates with @reactre/compat/compiler. Default true. */
  readonly compile?: boolean;
}

/** Options for the plugin. */
export interface ReactreOptions {
  /**
   * Run a React app on @reactre/compat: `true`, or its options. Without it, the plugin compiles
   * reactre TSX with @reactre/compiler.
   */
  readonly compat?: boolean | CompatOptions;
  /** Files to compile, matched against their path. Default: .jsx and .tsx files. */
  readonly include?: RegExp | readonly RegExp[];
  /** Files to leave alone even when `include` matches. Default: anything under node_modules. */
  readonly exclude?: RegExp | readonly RegExp[];
}

// #endregion

// #region The plugin

/** `react`, `react-dom` and every subpath of them. */
const REACT = /^react(?:-dom)?(?:\/.*)?$/;

/** The plugin, for every bundler unplugin supports. */
export const reactre: UnpluginInstance<ReactreOptions | undefined, boolean> = createUnplugin<
  ReactreOptions | undefined,
  boolean
>((options = {}, meta) => {
  const compat = options.compat === true ? {} : options.compat === false ? undefined : options.compat;
  const compile = compat === undefined || compat.compile !== false;
  const target = compat?.classes === true ? "@reactre/compat/classes" : "@reactre/compat";
  const include = toArray(options.include ?? /\.[jt]sx$/);
  const exclude = toArray(options.exclude ?? /[\\/]node_modules[\\/]/);

  const plugin: UnpluginOptions = {
    name: "@reactre/plugin",
    enforce: "pre",
    transform: compile
      ? {
          filter: { id: { include, exclude } },
          handler(code, id) {
            const path = id.replace(/[?#].*$/, "");
            const out = transpile(path, code, compat === undefined ? "@reactre/core" : "react");
            if (compat !== undefined) return { code: compileCompat(out.code), map: null };
            if (out.classic) {
              throw new ReactreCompileError(`reactre: ${path}: a key after {...spread} props cannot be compiled`);
            }
            try {
              return { code: compileCore(out.code), map: null };
            } catch (e) {
              if (e instanceof ReactreCompileError) e.message = `${path}: ${e.message}`;
              throw e;
            }
          },
        }
      : undefined,
  };
  if (compat === undefined) {
    // Vite's dependency scanner compiles JSX on its own, for React's runtime, and would then fail
    // to find react/jsx-runtime. It needs only the imports, so it keeps JSX as written.
    plugin.vite = { config: () => ({ optimizeDeps: { rolldownOptions: { transform: { jsx: "preserve" } } } }) };
    return plugin;
  }

  switch (meta.framework) {
    case "vite":
      // An alias, which Vite applies in its dependency optimizer as well as in the app.
      plugin.vite = { config: () => ({ resolve: { alias: [{ find: REACT, replacement: target }] } }) };
      return plugin;
    case "webpack":
      plugin.webpack = (compiler) => replaceReact(compiler.webpack, compiler, target);
      return plugin;
    case "rspack":
      plugin.rspack = (compiler) => replaceReact(compiler.rspack, compiler, target);
      return plugin;
    case "esbuild":
      // unplugin puts a path that resolveId returns in the plugin's own namespace, where esbuild
      // cannot load it, so a plugin of its own asks esbuild to resolve the target.
      return [
        plugin,
        {
          name: "@reactre/plugin:react",
          esbuild: {
            setup(build) {
              build.onResolve({ filter: REACT }, async (args) => {
                const r = await build.resolve(target, { kind: args.kind, resolveDir: args.resolveDir });
                return r.errors.length > 0 ? { errors: r.errors } : { path: r.path, sideEffects: r.sideEffects };
              });
            },
          },
        },
      ];
    case "bun":
      plugin.resolveId = {
        filter: { id: REACT },
        handler(_id, importer) {
          const { Bun } = globalThis as unknown as { Bun: { resolveSync(id: string, from: string): string } };
          return Bun.resolveSync(target, importer === undefined ? process.cwd() : dirname(importer));
        },
      };
      return plugin;
    default:
      // Rollup, Rolldown and the rest: the bundler resolves the target from the importer.
      plugin.resolveId = {
        filter: { id: REACT },
        async handler(_id, importer) {
          const context = this as unknown as Partial<RollupResolver>;
          const r = await context.resolve?.(target, importer, { skipSelf: true });
          return r?.id ?? null;
        },
      };
      return plugin;
  }
});

export default reactre;

// #endregion

// #region Helpers

/** What the resolveId hook uses of a Rollup-style plugin context. */
interface RollupResolver {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean },
  ): Promise<{ readonly id: string } | null>;
}

/** The part of webpack's and Rspack's exports this plugin uses. */
interface ReplacementPlugins {
  readonly NormalModuleReplacementPlugin: new (
    test: RegExp,
    replace: (resource: { request: string }) => void,
  ) => { apply(compiler: never): void };
}

/** Rewrite every request for `react` to `target` before webpack or Rspack resolves it. */
function replaceReact(bundler: ReplacementPlugins, compiler: unknown, target: string): void {
  new bundler.NormalModuleReplacementPlugin(REACT, (resource) => {
    resource.request = target;
  }).apply(compiler as never);
}

function toArray(pattern: RegExp | readonly RegExp[]): RegExp[] {
  return Array.isArray(pattern) ? [...(pattern as readonly RegExp[])] : [pattern as RegExp];
}

// #endregion
