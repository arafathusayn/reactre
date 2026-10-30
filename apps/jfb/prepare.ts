// Prepares the js-framework-benchmark replica in .cache (not committed):
//
//   1. A sparse clone of krausest/js-framework-benchmark at the commit of the
//      Chrome 156 results, with the shared stylesheet and the keyed entries
//      that ranked first to fifth there: re, thane, vanillajs-lite,
//      vanillajs and doohtml-dp.
//   2. Each entry built as its own build-prod script builds it, without
//      running any package install script: re is bundled by Bun from its
//      local re-core source, doohtml-dp copies its prebuilt module, thane runs
//      its own compiler, and the two vanillajs entries need no build.
//   3. Our entries (OURS), each an app in app/ bundled by Bun.
//
//   bun prepare.ts [--app-only]      (run from apps/jfb)
//
// --app-only rebuilds only our entries (after a change to the packages).
//
// Key decisions:
// - The upstream checkout is pinned to one commit, so the tests, the trace computation and the
//   top 5 entries are the ones the published results came from.
// - The clone is sparse and blobless: the full repository holds hundreds of entries, and only
//   the stylesheet and five of them are needed.
// - Package install scripts never run (`--ignore-scripts`): the builds do not need them, and
//   skipping them keeps third-party code from running at install time.
// - Bun replaces esbuild for re, with the same entry and output format, so the replica needs no
//   other bundler.
// - Our entries are minified IIFEs, the same format as re's production build.

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import type { BunPlugin } from "bun";

// #region Entries and paths

/** The js-framework-benchmark commit of the Chrome 156 results; run.ts and trace.ts match it. */
export const JFB_COMMIT = "ca8715d9ae84916fd24de3a79457d8c328f9b766";
/** Where the checkout and builds live; ignored by git. */
export const cache = join(import.meta.dir, ".cache");
/** The js-framework-benchmark checkout; run.ts serves it. */
export const root = join(cache, "js-framework-benchmark");
/** The keyed entries' folder in the checkout; every entry, ours included, builds into it. */
export const keyed = join(root, "frameworks/keyed");
/** The repository's root. */
export const repo = join(import.meta.dir, "../..");
/** The official keyed top 5 of the Chrome 156 run, best first. */
export const TOP5 = ["re", "thane", "vanillajs-lite", "vanillajs", "doohtml-dp"];

/** How one of our entries is built. */
export interface Entry {
  /** The app in app/. */
  readonly app: string;
  /** What `react` and `react-dom` resolve to, if the app imports them. */
  readonly react?: "react" | "reactre-compat";
  /** The JSX compiler: reactre's, reactre-compat's, or none (Bun's own JSX transform). */
  readonly compiler?: "reactre" | "reactre-compat";
}

/**
 * Our entries. `reactre` is app/reactre.tsx, compiled by reactre-compiler.
 * `reactre-compat` is the idiomatic React app (app/main.jsx) on
 * reactre-compat, its JSX compiled to templates by @reactre/compat/compiler;
 * `react` is the same app on React 19. `reactre-dom` is app/dom.ts,
 * written by hand on @reactre/dom's templates and keyed list.
 */
export const OURS: Record<string, Entry> = {
  reactre: { app: "reactre.tsx", compiler: "reactre" },
  "reactre-compat": { app: "main.jsx", react: "reactre-compat", compiler: "reactre-compat" },
  react: { app: "main.jsx", react: "react" },
  "reactre-dom": { app: "dom.ts" },
};

// #endregion

// #region Building our entries

/** Options for `buildEntry`; the profiling tools use them to build other revisions and variants. */
export interface BuildOptions {
  /** A directory whose node_modules link reactre, reactre-compiler and reactre-compat (default: this workspace's). */
  readonly packages?: string;
  /** Minify the bundle (default true); profiling turns it off to keep function names readable. */
  readonly minify?: boolean;
  /** @reactre/compat/compiler's inlineElements option. */
  readonly inlineElements?: boolean;
}

/**
 * A Bun plugin that resolves our packages, and `react` and `react-dom` where the entry runs on
 * reactre-compat, from `dir`, so a build can take them from another revision. Every `react` and
 * `react-dom` subpath maps to @reactre/compat/core, which provides both APIs.
 */
function resolveFrom(dir: string, react: Entry["react"]): BunPlugin {
  return {
    name: "jfb-resolve",
    setup(build) {
      build.onResolve({ filter: /^@reactre\// }, (args) => ({
        path: Bun.resolveSync(args.path, dir),
      }));
      // The benchmark app's explicit choice: @reactre/compat/core alone, without the modules that
      // install class components, React's component stacks, React's handling of repeated keys and
      // its render retry (@reactre/compat/features/*). It renders no class, throws no error and
      // repeats no key.
      if (react === "reactre-compat")
        build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({
          path: Bun.resolveSync("@reactre/compat/core", dir),
        }));
    },
  };
}

/**
 * Bundles one of our entries' apps into frameworks/keyed/<name>: dist/main.js, and an
 * index.html from app/index.html with the entry's name in the title.
 *
 * The folder is removed first, so no file from an earlier build survives. NODE_ENV is defined
 * as "production" so React, and any code that checks it, drops its development-only work.
 */
export async function buildEntry(name: string, entry: Entry, options: BuildOptions = {}): Promise<void> {
  const packages = options.packages ?? import.meta.dir;
  const plugins: BunPlugin[] = [];
  // The compilers load from the same place as the runtime they compile for.
  if (entry.compiler === "reactre") {
    const { reactreCompiler } = (await import(
      Bun.resolveSync("@reactre/compiler", packages)
    )) as typeof import("@reactre/compiler");
    plugins.push(reactreCompiler());
  } else if (entry.compiler === "reactre-compat") {
    const { reactreCompatCompiler } = (await import(
      Bun.resolveSync("@reactre/compat/compiler", packages)
    )) as typeof import("@reactre/compat/compiler");
    plugins.push(
      reactreCompatCompiler(options.inlineElements === undefined ? {} : { inlineElements: options.inlineElements }),
    );
  }
  plugins.push(resolveFrom(packages, entry.react));
  const dir = join(keyed, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  const r = await Bun.build({
    entrypoints: [join(import.meta.dir, "app", entry.app)],
    format: "iife",
    minify: options.minify ?? true,
    plugins,
    // @reactre/compat's sources as its own builds compile them: without time slicing (src/slicing.ts).
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "globalThis.__REACTRE_SLICING__": "false" },
  });
  if (!r.success) throw new Error(r.logs.join("\n"));
  await Bun.write(join(dir, "dist/main.js"), r.outputs[0]!);
  const html = await Bun.file(join(import.meta.dir, "app/index.html")).text();
  await Bun.write(join(dir, "index.html"), html.replace("NAME", name));
}

// #endregion

// #region The official top 5

/** Runs a command in `cwd` with its output shown, and throws if it fails. */
function sh(cmd: string[], cwd: string): void {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} (in ${cwd}) exited ${p.exitCode}`);
}

/**
 * The sparse, blobless checkout of the pinned commit, with only the shared stylesheet and the
 * top 5 entries. Skipped when the checkout already exists, so a rerun does not hit the network.
 */
function fetchRepo(): void {
  if (existsSync(join(root, ".git"))) return;
  mkdirSync(cache, { recursive: true });
  sh(
    [
      "git",
      "clone",
      "--filter=blob:none",
      "--sparse",
      "--no-checkout",
      "https://github.com/krausest/js-framework-benchmark.git",
      root,
    ],
    cache,
  );
  sh(["git", "sparse-checkout", "set", "css", ...TOP5.map((f) => "frameworks/keyed/" + f)], root);
  sh(["git", "checkout", JFB_COMMIT], root);
}

/** Builds each top 5 entry as its own build-prod script would, without install scripts. */
function buildTop5(): void {
  // re: esbuild src/main.ts --bundle --format=iife --minify, with @re/core from file:re-core.
  // A symlink stands in for the file: dependency, so no install is needed.
  const re = join(keyed, "re");
  mkdirSync(join(re, "node_modules/@re"), { recursive: true });
  if (!existsSync(join(re, "node_modules/@re/core"))) symlinkSync("../../re-core", join(re, "node_modules/@re/core"));
  sh(["bun", "build", "src/main.ts", "--format=iife", "--minify", "--outfile=dist/bundle.js"], re);
  // doohtml-dp: copies doohtml's prebuilt module.
  const doo = join(keyed, "doohtml-dp");
  sh(["bun", "install", "--ignore-scripts"], doo);
  mkdirSync(join(doo, "dist"), { recursive: true });
  cpSync(join(doo, "node_modules/doohtml/dist/doohtml.mjs"), join(doo, "dist/doohtml.mjs"));
  // thane: its own compiler, with the entry's build-prod arguments.
  const thane = join(keyed, "thane");
  sh(["bun", "install", "--ignore-scripts"], thane);
  sh(
    [
      "bun",
      "node_modules/thane/dist/compiler/cli/thane.js",
      "build",
      "--prod",
      "--entry",
      "./main.ts",
      "--out",
      "./dist",
      "--assets",
      "./assets",
      "--html",
      "./index.html",
      "--base",
      "/frameworks/keyed/thane/dist/",
    ],
    thane,
  );
}

// #endregion

// Run only as a script: run.ts and the profiling tools import the paths and `buildEntry`.
if (import.meta.main) {
  if (!process.argv.includes("--app-only")) {
    fetchRepo();
    buildTop5();
  }
  for (const [name, entry] of Object.entries(OURS)) await buildEntry(name, entry);
  console.log(`ready: ${[...TOP5, ...Object.keys(OURS)].join(", ")} in ${keyed}`);
}
