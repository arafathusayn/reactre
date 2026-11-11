// Builds the fixture apps with the plugin's entries (Vite, esbuild, Rolldown, Bun.build), runs each
// bundle, and checks what it ships: no setup, types or compiler, and the tasks module only for the
// app whose machine has a task. Rollup, webpack and Rspack get the same unplugin entry; they need
// a TypeScript loader of the app's own after it, so they aren't built here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import bunPlugin from "@reactre/state/plugin/bun";
import esbuildPlugin from "@reactre/state/plugin/esbuild";
import rolldownPlugin from "@reactre/state/plugin/rolldown";
import vitePlugin from "@reactre/state/plugin/vite";
import { build as esbuild } from "esbuild";
import { build as rolldown } from "rolldown";
import { build as vite, defaultClientConditions } from "vite";

import { emittedFileExports } from "./run-emitted.ts";

// Each bundler resolves @reactre/state to its sources, as the repository's own builds do: dist may
// not be built for local runs (CI builds and packs before tests).
const SOURCE = "reactre-source";

// The coverage settings skip folders named reactre-plugin-*: these bundles are not sources.
const out = mkdtempSync(join(tmpdir(), "reactre-plugin-state-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const FIXTURES = join(import.meta.dir, "fixtures");

/** Bundles `entry` (minified, production) into one ES module, and returns its path. */
type Bundle = (entry: string, file: string) => Promise<void>;

const bundlers: Record<string, Bundle> = {
  vite: async (entry, file) => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin({ dev: false })],
      resolve: { conditions: [SOURCE, ...defaultClientConditions] },
      build: {
        outDir: join(file, ".."),
        emptyOutDir: false,
        minify: true,
        lib: { entry, formats: ["es"], fileName: () => file.split("/").pop() ?? "" },
      },
    });
  },
  esbuild: async (entry, file) => {
    await esbuild({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: "esm",
      minify: true,
      conditions: [SOURCE],
      plugins: [esbuildPlugin({ dev: false })],
      logLevel: "silent",
    });
  },
  rolldown: async (entry, file) => {
    await rolldown({
      input: entry,
      resolve: { conditionNames: [SOURCE, "import", "browser", "default"] },
      plugins: [rolldownPlugin({ dev: false })],
      output: { file, format: "es", minify: true },
      logLevel: "silent",
    });
  },
  bun: async (entry, file) => {
    // Bun.build's own error says only "Bundle failed": the plugin's message is in its errors.
    const r = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      minify: true,
      conditions: [SOURCE],
      plugins: [bunPlugin({ dev: false })],
      throw: false,
    });
    if (!r.success) throw new Error(r.logs.map((l) => l.message).join("\n"));
    const [output] = r.outputs;
    if (output === undefined) throw new Error("no output");
    await Bun.write(file, output);
  },
};

const sizes: Record<string, { door: number; job: number }> = {};

describe.each(Object.keys(bundlers))("%s", (name) => {
  test("the plain machine runs, and ships the actor alone", async () => {
    const file = join(out, `${name}-door.mjs`);
    await bundlers[name]!(join(FIXTURES, "door-app.ts"), file);
    const code = await Bun.file(file).text();
    // No setup or types (their S0 message), no restore (S1, S2), no dev freezing, no tasks module.
    expect(code).not.toMatch(/wasn't compiled|Migrate|isFrozen|oxc|AbortController|setTimeout/);
    const app = await emittedFileExports<string[]>(file);
    expect(app).toEqual(["open", "closed", "locked", "closed"]);
    sizes[name] = { door: gzipSync(code).length, job: sizes[name]?.job ?? 0 };
  });

  test("the machine with a task runs, and ships the tasks module", async () => {
    const file = join(out, `${name}-job.mjs`);
    await bundlers[name]!(join(FIXTURES, "job-app.ts"), file);
    const code = await Bun.file(file).text();
    expect(code).toContain("AbortController");
    expect(code).not.toMatch(/wasn't compiled|Migrate|isFrozen|oxc/);
    const app = await emittedFileExports<string[]>(file);
    expect(app).toEqual(["saving", "saved"]);
    sizes[name] = { door: sizes[name]?.door ?? 0, job: gzipSync(code).length };
  });

  test("a broken contract fails the build, with the place and the fix", async () => {
    const broken = join(FIXTURES, "broken.ts");
    await expect(bundlers[name]!(broken, join(out, `${name}-broken.mjs`))).rejects.toThrow(
      /broken\.ts:14:\d+: Date reads the clock/,
    );
  });
});

afterAll(() => {
  // The bundles' gzipped sizes, machine and app code included.
  console.log("gzipped bytes:", JSON.stringify(sizes));
});
