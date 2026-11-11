// Every supported bundler's plugin path, from the installed package: @reactre/state is packed from
// its build and installed into a folder outside the workspace, and each bundler builds the same
// app with the installed plugin entry. The bundle must run and ship the actor alone (no setup,
// types or compiler), which is what the plugin promises.
//
// The bundlers themselves are the repository's dev dependencies, resolved from the workspace: the
// package under test is the installed one, and a bundler is the app's own tool. Rollup, webpack and
// Rspack get the same unplugin entry but need a TypeScript loader after it (the plugin compiles the
// machine, not the rest of the file's types), so those three get oxc-transform's type stripping as
// the app's own loader, as a real app would have.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { emittedFileExports } from "../run-emitted.ts";
import type {
  NodeResolveModule,
  RollupModule,
  RollupPlugin,
  RspackModule,
  RspackPluginInstance,
  Stats,
  WebpackModule,
  WebpackPluginInstance,
} from "./bundlers.d.ts";

const root = join(import.meta.dir, "..", "..", "..", "..");
const pkg = join(root, "packages", "state");
const pluginPkg = join(root, "packages", "plugin");
const fixtures = join(import.meta.dir, "fixtures", "bundlers");

const dir = mkdtempSync(join(tmpdir(), "reactre-state-bundlers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run `cmd` in `cwd`, its output returned; throw with the output when it fails. */
function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}\n${r.stderr.toString()}`);
  return out;
}

/** The installed project: the packed package, and the app's files. */
function install(): string {
  const packs = join(dir, "packs");
  const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
  run(["bun", "pm", "pack", "--quiet", "--destination", packs], pkg);
  const tarball = join(packs, `reactre-state-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
  const app = join(dir, "app");
  cpSync(fixtures, app, { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify(
      {
        name: "bundlers-consumer",
        private: true,
        type: "module",
        dependencies: { "@reactre/state": `file:${tarball}` },
      },
      null,
      2,
    ),
  );
  run(["bun", "install", "--offline", "--no-summary", "--no-progress"], app);
  return app;
}

/** What a bundle must not ship: the compiler's messages, setup and types, the dev freeze. */
const NOT_SHIPPED = /wasn't compiled|Migrate|isFrozen|oxc/;

/** The app's run: the states it went through. */
const EXPECTED = ["open", "closed"];

/** A bundler's plugin, as the installed package exports it. */
async function installed<T>(entry: string, app: string): Promise<T> {
  return (await import(Bun.resolveSync(`@reactre/state/plugin/${entry}`, app))) as T;
}

/** The app's TypeScript, its types stripped: the loader Rollup, webpack and Rspack need after the plugin. */
async function stripTypes(code: string, id: string): Promise<string> {
  const { transformSync } = (await import(Bun.resolveSync("oxc-transform", pkg))) as typeof import("oxc-transform");
  const out = transformSync(id, code, { typescript: { onlyRemoveTypeImports: false } });
  if (out.errors.length > 0) throw new Error(out.errors.map((e) => e.message).join("\n"));
  return out.code;
}

describe("every supported bundler's plugin path, from the installed package", () => {
  const app = install();
  const entry = join(app, "app.ts");
  const out = join(dir, "out");
  // The fixture is source for the installed plugin, not a source-condition shortcut for its runtime.
  cpSync(join(fixtures, "installed-nested.ts"), join(app, "installed-nested.ts"));

  async function verifyNested(bundler: string, build: (file: string) => Promise<unknown>): Promise<void> {
    const file = join(dir, `installed-nested-${bundler}.mjs`);
    await build(file);
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<{ state: string; status: string }>(file);
    expect(result).toEqual({ state: "sent", status: "done" });
  }
  test("vite", async () => {
    const { build } = (await import(Bun.resolveSync("vite", pkg))) as typeof import("vite");
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => import("vite").Plugin }>(
      "vite",
      app,
    );
    const file = join(out, "vite.mjs");
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [state({ dev: false })],
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: true,
        lib: { entry, formats: ["es"], fileName: () => "vite.mjs" },
      },
    });
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested("vite", (file) =>
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [state({ dev: false })],
        build: {
          outDir: dir,
          emptyOutDir: false,
          minify: true,
          lib: { entry: join(app, "run-nested.ts"), formats: ["es"], fileName: () => basename(file) },
        },
      }),
    );
  }, 60_000);

  test("esbuild", async () => {
    const { build } = (await import(Bun.resolveSync("esbuild", pkg))) as typeof import("esbuild");
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => import("esbuild").Plugin }>(
      "esbuild",
      app,
    );
    const file = join(out, "esbuild.mjs");
    await build({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      minify: true,
      logLevel: "silent",
      plugins: [state({ dev: false })],
    });
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    // The installed runtime, too: no reactre-source condition. The compiler selects the nested
    // lifecycle and the emitted production application really executes its work.
    await verifyNested("esbuild", (file) =>
      build({
        entryPoints: [join(app, "run-nested.ts")],
        outfile: file,
        bundle: true,
        format: "esm",
        minify: true,
        logLevel: "silent",
        plugins: [state({ dev: false })],
      }),
    );
    // A flat task+timer machine is its own lifecycle, not the nested runner already checked above.
    const jobFile = join(out, "job.mjs");
    await build({
      entryPoints: [join(app, "run-job.ts")],
      outfile: jobFile,
      bundle: true,
      format: "esm",
      minify: true,
      logLevel: "silent",
      plugins: [state({ dev: false })],
    });
    const job = await emittedFileExports<Record<string, unknown>>(jobFile);
    expect(job).toEqual({
      done: { state: "done", data: { id: "job-1" }, version: 0 },
      stale: { ok: false, reason: "inactive", snapshot: { state: "done", data: { id: "job-1" }, version: 0 } },
      after: ["working", "done"],
    });
  }, 60_000);

  test("rolldown", async () => {
    const { build } = (await import(Bun.resolveSync("rolldown", pkg))) as typeof import("rolldown");
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => import("rolldown").Plugin }>(
      "rolldown",
      app,
    );
    const file = join(out, "rolldown.mjs");
    await build({
      input: entry,
      plugins: [state({ dev: false })],
      output: { file, format: "es", minify: true },
      logLevel: "silent",
    });
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested("rolldown", (file) =>
      build({
        input: join(app, "run-nested.ts"),
        plugins: [state({ dev: false })],
        output: { file, format: "es", minify: true },
        logLevel: "silent",
      }),
    );
  }, 60_000);

  test("bun", async () => {
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => import("bun").BunPlugin }>(
      "bun",
      app,
    );
    const r = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      minify: true,
      plugins: [state({ dev: false })],
      throw: false,
    });
    if (!r.success) throw new Error(r.logs.map((l) => l.message).join("\n"));
    const [output] = r.outputs;
    if (output === undefined) throw new Error("no output");
    const file = join(out, "bun.mjs");
    await Bun.write(file, output);
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested("bun", async (file) => {
      const nested = await Bun.build({
        entrypoints: [join(app, "run-nested.ts")],
        format: "esm",
        minify: true,
        plugins: [state({ dev: false })],
        throw: false,
      });
      if (!nested.success) throw new Error(nested.logs.map((l) => l.message).join("\n"));
      const [output] = nested.outputs;
      if (output === undefined) throw new Error("no nested output");
      await Bun.write(file, output);
    });
  }, 60_000);

  test("rollup", async () => {
    const { rollup } = (await import(Bun.resolveSync("rollup", pluginPkg))) as RollupModule;
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => RollupPlugin }>("rollup", app);
    const strip: RollupPlugin = {
      name: "strip-types",
      async transform(code, id) {
        return id.endsWith(".ts") ? { code: await stripTypes(code, id), map: null } : null;
      },
    };
    // Rollup resolves no bare specifier without a resolver: the app's own, as a real app has.
    const { nodeResolve } = (await import(
      Bun.resolveSync("@rollup/plugin-node-resolve", pluginPkg)
    )) as NodeResolveModule;
    const bundle = await rollup({
      input: entry,
      plugins: [state({ dev: false }), strip, nodeResolve({ extensions: [".ts", ".js"] })],
      logLevel: "silent",
    });
    const { output } = await bundle.generate({ format: "es" });
    const [chunk] = output;
    if (chunk === undefined || chunk.type !== "chunk") throw new Error("no chunk");
    const file = join(out, "rollup.mjs");
    await Bun.write(file, chunk.code);
    expect(chunk.code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested("rollup", async (file) => {
      const bundle = await rollup({
        input: join(app, "run-nested.ts"),
        plugins: [state({ dev: false }), strip, nodeResolve({ extensions: [".ts", ".js"] })],
        logLevel: "silent",
      });
      const { output } = await bundle.generate({ format: "es" });
      const [chunk] = output;
      if (chunk === undefined || chunk.type !== "chunk") throw new Error("no nested chunk");
      await Bun.write(file, chunk.code);
    });
  }, 60_000);

  test("webpack", async () => {
    const webpack = (await import(Bun.resolveSync("webpack", pluginPkg))).default as WebpackModule["default"];
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => WebpackPluginInstance }>(
      "webpack",
      app,
    );
    const file = join(out, "webpack.mjs");
    await new Promise<void>((resolve, reject) => {
      webpack(
        {
          mode: "production",
          entry,
          output: { path: out, filename: "webpack.mjs", library: { type: "module" } },
          experiments: { outputModule: true },
          plugins: [state({ dev: false })],
          module: {
            rules: [
              {
                test: /\.ts$/,
                use: [
                  {
                    loader: join(import.meta.dir, "fixtures", "bundlers", "strip.loader.ts"),
                  },
                ],
              },
            ],
          },
          resolve: { extensions: [".ts", ".js"] },
          stats: "errors-only",
        },
        (error: Error | null, stats?: Stats) => {
          if (error) return reject(error);
          if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
          resolve();
        },
      );
    });
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested(
      "webpack",
      (file) =>
        new Promise<void>((resolve, reject) => {
          webpack(
            {
              mode: "production",
              entry: join(app, "run-nested.ts"),
              output: { path: dir, filename: basename(file), library: { type: "module" } },
              experiments: { outputModule: true },
              plugins: [state({ dev: false })],
              module: {
                rules: [
                  {
                    test: /\.ts$/,
                    use: [{ loader: join(import.meta.dir, "fixtures", "bundlers", "strip.loader.ts") }],
                  },
                ],
              },
              resolve: { extensions: [".ts", ".js"] },
              stats: "errors-only",
            },
            (error: Error | null, stats?: Stats) => {
              if (error) return reject(error);
              if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
              resolve();
            },
          );
        }),
    );
  }, 60_000);

  test("rspack", async () => {
    const { rspack } = (await import(Bun.resolveSync("@rspack/core", pluginPkg))) as RspackModule;
    const { default: state } = await installed<{ default: (o?: { dev?: boolean }) => RspackPluginInstance }>(
      "rspack",
      app,
    );
    const file = join(out, "rspack.mjs");
    await new Promise<void>((resolve, reject) => {
      rspack(
        {
          mode: "production",
          entry,
          output: { path: out, filename: "rspack.mjs", library: { type: "module" } },
          experiments: { outputModule: true },
          plugins: [state({ dev: false })],
          module: {
            rules: [
              {
                test: /\.ts$/,
                use: [{ loader: join(import.meta.dir, "fixtures", "bundlers", "strip.loader.ts") }],
              },
            ],
          },
          resolve: { extensions: [".ts", ".js"] },
          stats: "errors-only",
        },
        (error: Error | null, stats?: Stats) => {
          if (error) return reject(error);
          if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
          resolve();
        },
      );
    });
    const code = await Bun.file(file).text();
    expect(code).not.toMatch(NOT_SHIPPED);
    const result = await emittedFileExports<string[]>(file);
    expect(result).toEqual(EXPECTED);
    await verifyNested(
      "rspack",
      (file) =>
        new Promise<void>((resolve, reject) => {
          rspack(
            {
              mode: "production",
              entry: join(app, "run-nested.ts"),
              output: { path: dir, filename: basename(file), library: { type: "module" } },
              experiments: { outputModule: true },
              plugins: [state({ dev: false })],
              module: {
                rules: [
                  {
                    test: /\.ts$/,
                    use: [{ loader: join(import.meta.dir, "fixtures", "bundlers", "strip.loader.ts") }],
                  },
                ],
              },
              resolve: { extensions: [".ts", ".js"] },
              stats: "errors-only",
            },
            (error: Error | null, stats?: Stats) => {
              if (error) return reject(error);
              if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
              resolve();
            },
          );
        }),
    );
  }, 60_000);
});
