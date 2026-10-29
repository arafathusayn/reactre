// @reactre/plugin: reactre's build step for every bundler unplugin supports.
//
// Two modes:
//
//   - core (the default): .jsx and .tsx files are compiled by @reactre/compiler into templates and
//     the code that updates them, as the Bun plugin compiles them.
//   - compat: `react`, `react-dom` and their subpaths resolve to @reactre/compat (or, with `classes: false`,
//     @reactre/compat/core), and `react-dom/server` and `react-dom/static` (with their .browser, .edge, .node
//     and .bun forms) to @reactre/compat/server, in the app and in its dependencies, and the
//     app's .jsx and .tsx files are compiled by @reactre/compat/compiler, whose host element
//     trees become templates. Server Components stay on React: a Vite environment named `rsc`,
//     or a build that resolves with the `react-server` condition, is left alone.
//
// Each bundler's entry (`@reactre/plugin/vite`, `/rollup`, `/rolldown`, `/esbuild`, `/webpack`,
// `/rspack`, `/bun`) is this plugin, built by unplugin for that bundler.
//
// Design decisions:
//   - TypeScript and JSX go through oxc first (./transpile.ts), not Bun's transpiler, so the plugin
//     runs under Node too. The compilers then read oxc's output as they read Bun's.
//   - The plugin runs before the bundler's own JSX transform (`enforce: "pre"`), so every bundler
//     gets plain JavaScript.
//   - Each bundler redirects `react` the way it resolves best: the plugin context's resolve for
//     Vite (per environment, and in each environment's dependency optimizer), Rollup and
//     Rolldown, a module replacement for webpack and Rspack, esbuild's own resolve for esbuild,
//     and Bun's resolver for Bun. The bundler resolves the target with its own conditions, from
//     a directory that reaches @reactre/compat (see `baseFor`), so a dependency installed in
//     isolation gets the copy the app's own imports get. Vite's `resolve.alias` would be simpler, but it applies to every
//     environment, the RSC one too.
//   - No source maps yet: the compilers rewrite text without tracking positions. A transformed
//     file maps to nothing rather than to the wrong line.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileJs as compileCompat } from "@reactre/compat/compiler";
import { compileJs as compileCore, ReactreCompileError } from "@reactre/compiler";
import { createUnplugin, type UnpluginInstance, type UnpluginOptions } from "unplugin";

import { transpile } from "./transpile.ts";

// #region Options

/** Options for compat mode. */
export interface CompatOptions {
  /**
   * Include class components. Default true: `react` resolves to @reactre/compat, React's whole
   * client API. `false` resolves it to @reactre/compat/core, which leaves class support out, for
   * an app that renders no class component itself or through a library.
   */
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

/** React's server renderer and its prerender entry, in each of their builds. */
const SERVER = /^react-dom\/(?:server|static)(?:\.(?:browser|edge|node|bun))?(?:\.js)?$/;

/** The export condition React Server Components resolve with. */
const REACT_SERVER = "react-server";

/** Whether an environment or build renders Server Components, which stay on React. */
function isReactServer(environment: string | undefined, conditions: readonly string[] | undefined): boolean {
  return environment === "rsc" || conditions?.includes(REACT_SERVER) === true;
}

/** The plugin, for every bundler unplugin supports. */
export const reactre: UnpluginInstance<ReactreOptions | undefined, boolean> = createUnplugin<
  ReactreOptions | undefined,
  boolean
>((options = {}, meta) => {
  const compat = options.compat === true ? {} : options.compat === false ? undefined : options.compat;
  const compile = compat === undefined || compat.compile !== false;
  const client = compat?.classes === false ? "@reactre/compat/core" : "@reactre/compat";
  /** What a request for `react` or one of its subpaths resolves to. */
  const target = (id: string): string => (SERVER.test(id) ? "@reactre/compat/server" : client);
  // The app's root, where Vite says, else the working directory.
  let root = process.cwd();
  /** The directory a request from `importer` resolves the target from (see `baseFor`). */
  const base = (importer: string | undefined): string => baseFor(importer, root);
  // Rollup, Rolldown and Vite: the bundler resolves the target, with its own conditions.
  const resolveId = {
    filter: { id: REACT },
    async handler(this: unknown, id: string, importer: string | undefined) {
      const context = this as Partial<RollupResolver>;
      // The whole result, not its id: Vite's dependency scan marks the target external.
      return (await context.resolve?.(target(id), join(base(importer), "_"), { skipSelf: true })) ?? null;
    },
  };
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
      plugin.resolveId = resolveId;
      plugin.vite = {
        configResolved(config) {
          root = config.root;
        },
        // Neither the redirect nor the compile reach the RSC environment.
        applyToEnvironment: (environment) => !isReactServer(environment.name, environment.config.resolve.conditions),
        // The dependency optimizer bundles with its own plugins, not the app's: the redirect goes
        // there too, so a dependency's `react` is the app's copy of compat.
        configEnvironment: (name, config) =>
          isReactServer(name, config.resolve?.conditions)
            ? undefined
            : { optimizeDeps: { rolldownOptions: { plugins: [{ name: "@reactre/plugin:react", resolveId }] } } },
      };
      return plugin;
    case "webpack":
      plugin.webpack = (compiler) => replaceReact(compiler.webpack, compiler, target, base);
      return plugin;
    case "rspack":
      plugin.rspack = (compiler) => replaceReact(compiler.rspack, compiler, target, base);
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
              if (isReactServer(undefined, build.initialOptions.conditions)) return;
              build.onResolve({ filter: REACT }, async (args) => {
                const r = await build.resolve(target(args.path), {
                  kind: args.kind,
                  resolveDir: base(join(args.resolveDir, "_")),
                });
                return r.errors.length > 0 ? { errors: r.errors } : { path: r.path, sideEffects: r.sideEffects };
              });
            },
          },
        },
      ];
    case "bun": {
      // Bun.build names the conditions it resolves with.
      let server = false;
      plugin.bun = {
        setup(build) {
          const conditions = (build.config as { conditions?: string | string[] }).conditions;
          server = isReactServer(undefined, typeof conditions === "string" ? [conditions] : conditions);
        },
      };
      plugin.resolveId = {
        filter: { id: REACT },
        handler(id, importer) {
          if (server) return null;
          const { Bun } = globalThis as unknown as { Bun: { resolveSync(id: string, from: string): string } };
          return Bun.resolveSync(target(id), base(importer));
        },
      };
      return plugin;
    }
    default: {
      // Rollup, Rolldown and the rest. Rolldown names the conditions it resolves with.
      let server = false;
      plugin.rolldown = {
        options(options) {
          server = isReactServer(undefined, options.resolve?.conditionNames);
        },
      };
      plugin.resolveId = {
        filter: resolveId.filter,
        handler(id, importer) {
          return server ? null : resolveId.handler.call(this, id, importer);
        },
      };
      return plugin;
    }
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
  ): Promise<{ readonly id: string; readonly external?: boolean } | null>;
}

/** The part of webpack's and Rspack's exports this plugin uses. */
interface ReplacementPlugins {
  readonly NormalModuleReplacementPlugin: new (
    test: RegExp,
    replace: (resource: { request: string; context: string }) => void,
  ) => { apply(compiler: never): void };
}

/**
 * Rewrite every request for `react` to its target before webpack or Rspack resolves it, unless
 * the build resolves with the `react-server` condition.
 */
function replaceReact(
  bundler: ReplacementPlugins,
  compiler: unknown,
  target: (id: string) => string,
  base: (importer: string | undefined) => string,
): void {
  const options = (compiler as { options?: { resolve?: { conditionNames?: string[] } } }).options;
  if (isReactServer(undefined, options?.resolve?.conditionNames)) return;
  new bundler.NormalModuleReplacementPlugin(REACT, (resource) => {
    resource.request = target(resource.request);
    resource.context = base(join(resource.context, "_"));
  }).apply(compiler as never);
}

/** The plugin's own directory, which reaches @reactre/compat: the plugin depends on it. */
const SELF = dirname(fileURLToPath(import.meta.url));

/** Whether `dir`, or a directory above it, has node_modules/@reactre/compat. By directory, cached. */
const reachable = new Map<string, boolean>();
function reaches(dir: string): boolean {
  let r = reachable.get(dir);
  if (r === undefined) {
    const up = dirname(dir);
    r = existsSync(join(dir, "node_modules", "@reactre", "compat")) || (up !== dir && reaches(up));
    reachable.set(dir, r);
  }
  return r;
}

/**
 * The directory to resolve @reactre/compat from, for a request from `importer`: the importer's
 * own, else the app's root, else the plugin's. A dependency installed in isolation, as Bun and
 * pnpm install them, sees only its own dependencies; resolved from its directory, `react` would
 * find nothing, or React itself. Every module then gets the copy the app's own files get.
 */
export function baseFor(importer: string | undefined, root: string): string {
  if (importer !== undefined && !importer.startsWith("\0")) {
    const dir = dirname(importer);
    if (reaches(dir)) return dir;
  }
  return reaches(root) ? root : SELF;
}

function toArray(pattern: RegExp | readonly RegExp[]): RegExp[] {
  return Array.isArray(pattern) ? [...(pattern as readonly RegExp[])] : [pattern as RegExp];
}

// #endregion
