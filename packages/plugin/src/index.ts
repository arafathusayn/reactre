// @reactre/plugin: reactre's build step for every bundler unplugin supports.
//
// Two modes:
//
//   - core (the default): .jsx and .tsx files are compiled by @reactre/compiler into templates and
//     the code that updates them, as the Bun plugin compiles them.
//   - compat: `react`, `react-dom` and their subpaths resolve to @reactre/compat (or, with anything
//     switched off, class support included, a module built on @reactre/compat/core for the
//     options; see ./api.ts), and `react-dom/server` and `react-dom/static` to
//     @reactre/compat/server and /static (and their .browser, .edge, .node and .bun forms to the
//     entry for that build), in the app and in its dependencies, and the app's .jsx and .tsx
//     files are compiled by @reactre/compat/compiler, whose host element trees become templates. Server Components stay on React: a Vite environment named `rsc`,
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
//   - The server renderer resolves as React's does. The bare `react-dom/server` and
//     `react-dom/static` go to @reactre/compat/server and /static, whose export conditions copy
//     react-dom's, so the bundler picks the build for its target: a bundle for the browser or a
//     web worker gets compat's browser entry, which throws React's minified error codes as
//     React's browser build does, and a Node SSR build the Node entry, with React's full
//     messages. A named build (`react-dom/server.browser`, `.edge`, `.node`, `.bun`) goes to
//     compat's entry for that build whatever the target, as it reaches that build of React's.
//   - No source maps yet: the compilers rewrite text without tracking positions. A transformed
//     file maps to nothing rather than to the wrong line.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BEHAVIOURS, enabledApis, KEYS } from "@reactre/compat/api";
import { compileJs as compileCompat } from "@reactre/compat/compiler";
import { compileJs as compileCore, ReactreCompileError } from "@reactre/compiler";
import { createUnplugin, type UnpluginInstance, type UnpluginOptions } from "unplugin";

import { entrySource, offError, usedApis, writeEntry } from "./api.ts";
import { transpile } from "./transpile.ts";

// #region Options

/** Options for compat mode. */
export interface CompatOptions {
  /**
   * Include class components. Default true. `false` leaves class support out, for an app that
   * renders no class component itself or through a library; the same as excluding `"@classes"`.
   */
  readonly classes?: boolean;
  /** Compile the app's host element trees to templates with @reactre/compat/compiler. Default true. */
  readonly compile?: boolean;
  /**
   * The React APIs the app and its libraries use: `"all"` (the default), or a list of React's
   * export names and groups (`"@suspense"`, `"@transitions"`, `"@forms"`, `"@hints"`,
   * `"@classes"`). The keys are listed in @reactre/compat/api.
   */
  readonly apis?: "all" | readonly string[];
  /**
   * APIs to switch off, as keys or groups. The build fails where code uses one; at run time each
   * is a function that throws, naming the fix. The behaviours `"componentStack"` (React's
   * component stack in error reports), `"repeatedKeys"` (React's handling of a list whose keys
   * repeat), `"renderRetry"` (React's retry of a render that throws) and `"concurrentRendering"`
   * (React's transition lanes) are on unless listed here.
   */
  readonly exclude?: readonly string[];
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

/** @reactre/compat's client entries and feature modules, which the module written for an app's options imports. */
const COMPAT = /^@reactre\/compat(?:\/core|\/features\/[a-zA-Z]+)?$/;

/** The requests the plugin resolves: `react`, `react-dom` and their subpaths, and compat's client entries. */
const REQUEST = /^(?:react(?:-dom)?(?:\/.*)?|@reactre\/compat(?:\/core|\/features\/[a-zA-Z]+)?)$/;

/** The modules the API scan reads. */
const SCRIPT = /\.[cm]?[jt]sx?(?:$|\?)/;

/** esbuild's pluginData for a resolve the plugin asks for itself, which it then leaves alone. */
const OWN = Symbol("@reactre/plugin");

/** React's server renderer and its prerender entry, in each of their builds. */
const SERVER = /^react-dom\/(?:server|static)(?:\.(?:browser|edge|node|bun))?(?:\.js)?$/;

/**
 * The compat entry for a request SERVER matches: for the bare `react-dom/server` and
 * `react-dom/static`, compat's of the same name, whose export conditions pick the build as
 * react-dom's do; for a named build, compat's entry for it (React's Bun build throws as its edge
 * build does).
 */
function serverEntry(id: string): string {
  const [, entry, build] = /^react-dom\/(server|static)(?:\.(browser|edge|node|bun))?/.exec(id)!;
  return build === undefined
    ? "@reactre/compat/" + entry
    : "@reactre/compat/server." + (build === "bun" ? "edge" : build);
}

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
  // The APIs and behaviours that are on. All of them is @reactre/compat; anything off, class
  // support included, is a module written for the options (./api.ts), built on
  // @reactre/compat/core with the feature modules of what is on.
  const on =
    compat === undefined
      ? new Set([...KEYS, ...BEHAVIOURS])
      : enabledApis(compat.apis ?? "all", [
          ...(compat.exclude ?? []),
          ...(compat.classes === false ? ["Component"] : []),
        ]);
  const custom = [...KEYS, ...BEHAVIOURS].some((k) => !on.has(k));
  // An API off, other than class support (whose Component stays, throwing when a class renders):
  // the build scans for its uses.
  const narrowed = KEYS.some((k) => !on.has(k) && k !== "Component" && k !== "PureComponent");
  let entry: string | undefined;
  /** What `react` resolves to: the package entry, or the module written for the options. */
  const client = (): string => (custom ? (entry ??= writeEntry(root, entrySource(on))) : "@reactre/compat");
  /** What a request for `react`, one of its subpaths, or a compat entry resolves to. */
  const target = (id: string): string => (SERVER.test(id) ? serverEntry(id) : COMPAT.test(id) ? id : client());
  /** Throws where `code` uses an API the options switch off. */
  const scan = (code: string, id: string): null => {
    if (!code.includes("react")) return null;
    const file = id.replace(/[?#].*$/, "");
    for (const name of usedApis(code, file)) if (KEYS.includes(name) && !on.has(name)) throw offError(file, name);
    return null;
  };
  // The app's root, where Vite says, else the working directory.
  let root = process.cwd();
  /** The directory a request from `importer` resolves the target from (see `baseFor`). */
  const base = (importer: string | undefined): string => baseFor(importer, root);
  // Rollup, Rolldown and Vite: the bundler resolves the target, with its own conditions.
  const resolveId = {
    filter: { id: REQUEST },
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
  /** The API scan, as a plugin of its own: it reads every module, the dependencies' too. */
  const scanner: UnpluginOptions = {
    name: "@reactre/plugin:api",
    enforce: "pre",
    transform: { filter: { id: { include: [SCRIPT] } }, handler: scan },
  };
  /** The plugins for a bundler: the API scan joins them when the options switch APIs off. */
  const all = (...plugins: UnpluginOptions[]): UnpluginOptions | UnpluginOptions[] =>
    narrowed ? [...plugins, scanner] : plugins.length === 1 ? plugins[0]! : plugins;
  if (compat === undefined) {
    // Vite's dependency scanner compiles JSX on its own, for React's runtime, and would then fail
    // to find react/jsx-runtime. It needs only the imports, so it keeps JSX as written.
    plugin.vite = { config: () => ({ optimizeDeps: { rolldownOptions: { transform: { jsx: "preserve" } } } }) };
    return plugin;
  }

  switch (meta.framework) {
    case "vite": {
      // Neither the redirect, the compile nor the scan reach the RSC environment.
      const applyToEnvironment = (environment: { name: string; config: { resolve: { conditions: string[] } } }) =>
        !isReactServer(environment.name, environment.config.resolve.conditions);
      plugin.resolveId = resolveId;
      plugin.vite = {
        configResolved(config) {
          root = config.root;
        },
        applyToEnvironment,
        // The dependency optimizer bundles with its own plugins, not the app's: the redirect goes
        // there too, so a dependency's `react` is the app's copy of compat, and so does the scan.
        configEnvironment: (name, config) =>
          isReactServer(name, config.resolve?.conditions)
            ? undefined
            : {
                optimizeDeps: {
                  rolldownOptions: {
                    plugins: [{ name: "@reactre/plugin:react", resolveId, ...(narrowed ? { transform: scan } : {}) }],
                  },
                },
              },
      };
      scanner.vite = { applyToEnvironment };
      return all(plugin);
    }
    case "webpack":
      plugin.webpack = (compiler) => replaceReact(compiler.webpack, compiler, target, base);
      return all(plugin);
    case "rspack":
      plugin.rspack = (compiler) => replaceReact(compiler.rspack, compiler, target, base);
      return all(plugin);
    case "esbuild":
      // unplugin puts a path that resolveId returns in the plugin's own namespace, where esbuild
      // cannot load it, so a plugin of its own asks esbuild to resolve the target.
      return all(plugin, {
        name: "@reactre/plugin:react",
        esbuild: {
          setup(build) {
            if (isReactServer(undefined, build.initialOptions.conditions)) return;
            build.onResolve({ filter: REQUEST }, async (args) => {
              // A resolve this plugin asks for comes through it again: left to esbuild.
              if (args.pluginData === OWN) return undefined;
              const r = await build.resolve(target(args.path), {
                kind: args.kind,
                resolveDir: base(join(args.resolveDir, "_")),
                pluginData: OWN,
              });
              return r.errors.length > 0 ? { errors: r.errors } : { path: r.path, sideEffects: r.sideEffects };
            });
          },
        },
      });
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
        filter: { id: REQUEST },
        handler(id, importer) {
          if (server) return null;
          const { Bun } = globalThis as unknown as { Bun: { resolveSync(id: string, from: string): string } };
          return Bun.resolveSync(target(id), base(importer));
        },
      };
      return all(plugin);
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
      return all(plugin);
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
  new bundler.NormalModuleReplacementPlugin(REQUEST, (resource) => {
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
