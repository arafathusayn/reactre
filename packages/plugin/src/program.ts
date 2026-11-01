// The whole program of a core-mode build, read before it compiles a file (@reactre/compiler/program).
//
// The compiler binds a hole that reads a prop (`{props.title}`) only when some call site of the
// component may pass that prop reactively. Seeing every call site needs the whole program, but a
// bundler transforms one module at a time, so at the build's start the plugin reads it: from the
// entries, it follows every import its bundler's own resolver places among the app's files, and
// scans each module for its components, call sites and imports. Each transform then compiles its
// module with that module's facts.
//
// Design decisions:
//   - The bundler's resolver, so aliases, tsconfig paths and conditions resolve as the build
//     resolves them: `this.resolve` in Rollup, Rolldown and Vite, `build.resolve` in esbuild, the
//     compilation's resolver in webpack and Rspack, Bun's own in Bun.
//   - Only a one-shot production build reads its program. A dev server (Vite's) and watch mode
//     transform modules again, one at a time, as they change, which would leave the facts the
//     other modules were compiled with stale: there each file is seen alone, which is sound.
//   - A build whose entries the plugin cannot read (webpack's function entries) is seen file by
//     file too, and so is one with a module the program cannot see into (`import(expr)`, a
//     virtual module, a file type that may import code).
//   - A module the program did not reach (another plugin's output, a module only a later plugin
//     imports) joins it when it is transformed, compiled or not: the plugin's second transform
//     (`@reactre/plugin:program`) sees every module of the app it does not compile, a `.js` file
//     or a virtual module that may call a component by hand. If it passes a prop reactively to a
//     component compiled already without it, the build fails with that component's name, never
//     ships it; a late file that is not a script it can read fails the build too.

import { dirname, resolve } from "node:path";

import { type Host, isExternal, type Resolved } from "@reactre/compiler/program";

import { transpile } from "./transpile.ts";

/** A build's entries and the resolver to read its program with. */
export interface Build {
  readonly entries: readonly string[];
  readonly host: Host;
}

/** What `readBuild` reads of a hook's context, in each bundler. */
interface BuildContext {
  /** Rollup, Rolldown and Vite. */
  readonly meta?: { readonly watchMode?: boolean };
  readonly resolve?: (
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean; isEntry?: boolean },
  ) => Promise<{ readonly id: string; readonly external?: unknown } | null>;
  /** unplugin's way to esbuild, webpack, Rspack and Bun. */
  readonly getNativeBuildContext?: () => NativeContext;
}

type NativeContext =
  | { readonly framework: "esbuild"; readonly build: EsbuildBuild }
  | { readonly framework: "webpack" | "rspack"; readonly compiler: WebpackCompiler }
  | { readonly framework: "bun"; readonly build: { readonly config?: { readonly entrypoints?: readonly string[] } } }
  | { readonly framework: string };

interface EsbuildBuild {
  readonly initialOptions: {
    readonly entryPoints?: readonly (string | { readonly in: string })[] | Readonly<Record<string, string>>;
    readonly absWorkingDir?: string;
  };
  resolve(
    path: string,
    options: { kind: string; resolveDir: string; importer?: string },
  ): Promise<{
    readonly errors: readonly unknown[];
    readonly path: string;
    readonly external: boolean;
    readonly namespace: string;
  }>;
}

interface WebpackCompiler {
  readonly watchMode?: boolean;
  readonly options: { readonly entry?: unknown; readonly context?: string };
  readonly resolverFactory: {
    get(
      type: "normal",
      options: object,
    ): {
      resolve(
        context: object,
        path: string,
        request: string,
        resolveContext: object,
        callback: (err: unknown, result?: string | false) => void,
      ): void;
    };
  };
}

/** A script's JavaScript as the compiler reads it: oxc's, with the helpers renamed. */
const transpileScript = (file: string, source: string): string => transpile(file, source, "@reactre/core").code;

/**
 * The build a hook's context belongs to, when its program can be read: a one-shot build whose
 * entries the plugin knows. Null otherwise (a dev server, watch mode, webpack's function entries).
 *
 * @param input Rollup's, Rolldown's and Vite's `buildStart` argument: the input options.
 * @param serve Whether Vite runs its dev server.
 */
export async function readBuild(ctx: unknown, input: unknown, serve: boolean): Promise<Build | null> {
  const c = (ctx ?? {}) as BuildContext;
  if (typeof c.resolve === "function") {
    if (serve || c.meta?.watchMode === true) return null;
    const res = c.resolve.bind(c);
    const given = (input as { input?: unknown } | undefined)?.input;
    const inputs = typeof given === "string" ? [given] : Object.values((given ?? {}) as Record<string, string>);
    const entries = await Promise.all(inputs.map(async (i) => (await res(i, undefined, { isEntry: true }))?.id));
    if (entries.some((e) => e === undefined)) return null;
    return {
      entries: entries as string[],
      host: {
        transpile: transpileScript,
        // What Rollup cannot resolve is external.
        resolve: async (spec, importer) => {
          const r = await res(spec, importer, { skipSelf: true });
          return r === null || r.external ? false : r.id;
        },
      },
    };
  }
  const native = c.getNativeBuildContext?.();
  if (native === undefined) return null;
  if (native.framework === "esbuild") {
    const build = (native as { build: EsbuildBuild }).build;
    const base = build.initialOptions.absWorkingDir ?? process.cwd();
    const points = build.initialOptions.entryPoints ?? [];
    const list: string[] = Array.isArray(points)
      ? (points as readonly (string | { in: string })[]).map((p) => (typeof p === "string" ? p : p.in))
      : Object.values(points as Record<string, string>);
    return {
      entries: list.map((p) => resolve(base, p)),
      host: {
        transpile: transpileScript,
        resolve: async (spec, importer): Promise<Resolved> => {
          const r = await build.resolve(spec, { kind: "import-statement", resolveDir: dirname(importer), importer });
          if (r.errors.length > 0 || r.external) return false;
          return r.namespace === "file" ? r.path : null;
        },
      },
    };
  }
  if (native.framework === "webpack" || native.framework === "rspack") {
    const compiler = (native as { compiler: WebpackCompiler }).compiler;
    const entry = compiler.options.entry;
    if (compiler.watchMode === true || typeof entry !== "object" || entry === null) return null;
    const base = compiler.options.context ?? process.cwd();
    const resolver = compiler.resolverFactory.get("normal", { dependencyType: "esm" });
    const host: Host = {
      transpile: transpileScript,
      // A request webpack cannot resolve may be one a loader or a plugin serves: not known.
      resolve: (spec, importer) =>
        new Promise((done) =>
          resolver.resolve({}, dirname(importer), spec, {}, (err, r) => done(err || !r ? null : r)),
        ),
    };
    const requests = Object.values(entry as Record<string, { import?: readonly string[] }>).flatMap(
      (e) => e.import ?? [],
    );
    const entries = await Promise.all(requests.map((r) => host.resolve(r, resolve(base, "_"))));
    if (entries.some((e) => typeof e !== "string")) return null;
    return { entries: entries as string[], host };
  }
  if (native.framework === "bun") {
    const config = (native as { build: { config?: { entrypoints?: readonly string[]; external?: string[] } } }).build
      .config;
    const points = config?.entrypoints;
    if (points === undefined) return null;
    const { Bun } = globalThis as unknown as { Bun: { resolveSync(id: string, from: string): string } };
    return {
      entries: points.map((p) => resolve(p)),
      host: {
        transpile: transpileScript,
        resolve: (spec, importer) => {
          try {
            return Bun.resolveSync(spec, dirname(importer));
          } catch {
            // Bun cannot tell another plugin's virtual module from a missing one: unknown, unless
            // the build names it external.
            return isExternal(spec, config?.external) ? false : null;
          }
        },
      },
    };
  }
  return null;
}
