// Server builds through the plugin (`ssr`): the app in fixtures/ssr built for the server by Vite
// (its SSR build and its dev server, which the plugin tells apart by the environment), esbuild and
// Bun (with `ssr: true`), then rendered with @reactre/core/server: control flow, a context, an
// <Errored> boundary, effects that do not run, and a <Loading> whose content streams once its
// async data comes. The same app built for the browser has none of the server's code. The
// packages resolve to their dist builds, as an app's do once installed, so those are built first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build as esbuild } from "esbuild";
import { build as vite, createServer } from "vite";

import bunPlugin from "../src/bun.ts";
import esbuildPlugin from "../src/esbuild.ts";
import { reactre } from "../src/index.ts";
import vitePlugin from "../src/vite.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const ENTRY = FIXTURES + "ssr/entry.tsx";

let out: string;

beforeAll(() => {
  for (const dir of ["dom", "core", "compiler"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${dir} failed:\n${r.stderr.toString()}`);
  }
  out = mkdtempSync(join(tmpdir(), "reactre-plugin-ssr-"));
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** What fixtures/ssr/entry.tsx exports. */
interface Entry {
  isServer: boolean;
  html(): string;
  stream(): ReadableStream<Uint8Array>;
  whole(): Promise<string>;
  resolve(v: string): void;
  ran: string[];
  log: string[];
}

/** The page the app renders, with `loading` where its <Loading> is. */
const page = (loading: string) =>
  '<main><h1>Hello</h1><b class="dark">themed</b><ul><li>A</li><li>B</li></ul><p>many</p>' +
  `<p class="error">broken</p>${loading}</main>`;

/** Render the built entry every way, checking each. */
async function renders(app: Entry): Promise<void> {
  expect(app.isServer).toBe(true);
  expect(app.html()).toBe(page("<i>loading</i>"));
  const reader = app.stream().getReader(),
    dec = new TextDecoder();
  expect(dec.decode((await reader.read()).value)).toBe(page("<!--rr:b0--><i>loading</i><!--/rr:b0-->"));
  const whole = app.whole();
  app.resolve("world");
  const rest = dec.decode((await reader.read()).value);
  expect(rest).toStartWith("<script>self.$rr||");
  expect(rest).toEndWith('<template id="rr:t0"><p class="word">world</p></template><script>$rr(0)</script>');
  expect((await reader.read()).done).toBe(true);
  expect(await whole).toBe(page('<p class="word">world</p>'));
  // Effects do not run on the server, in a compiled module or in a module of plain TypeScript.
  expect(app.ran).toEqual([]);
  expect(app.log).toEqual([]);
}

describe("server builds", () => {
  test("Vite's SSR build: the environment makes it a server build", async () => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin()],
      build: {
        ssr: ENTRY,
        outDir: join(out, "vite"),
        emptyOutDir: false,
        minify: false,
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    const code = await Bun.file(join(out, "vite/entry.js")).text();
    // The core is bundled, its server entry and feature modules with it.
    expect(code).not.toMatch(/from ["']@reactre\//);
    expect(code).toContain("renderToStream");
    await renders((await import(join(out, "vite/entry.js"))) as Entry);
  }, 60_000);

  test("Vite's dev server renders the app with ssrLoadModule", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: FIXTURES + "ssr",
      cacheDir: join(out, "vite-dev"),
      appType: "custom",
      server: { middlewareMode: true, ws: false },
      plugins: [vitePlugin()],
    });
    try {
      await renders((await server.ssrLoadModule("/entry.tsx")) as Entry);
      // The client's environment compiles the same module to templates.
      const client = await server.transformRequest("/app.tsx");
      expect(client!.code).toContain("__rrT(");
      expect(client!.code).not.toContain("__ssr");
    } finally {
      await server.close();
    }
  }, 60_000);

  test("esbuild, with `ssr: true`", async () => {
    await esbuild({
      entryPoints: [ENTRY],
      outfile: join(out, "esbuild/entry.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      plugins: [esbuildPlugin({ ssr: true })],
    });
    await renders((await import(join(out, "esbuild/entry.js"))) as Entry);
  }, 60_000);

  test("Bun, with `ssr: true`", async () => {
    const r = await Bun.build({
      entrypoints: [ENTRY],
      conditions: ["reactre-source"],
      outdir: join(out, "bun"),
      target: "bun",
      format: "esm",
      plugins: [bunPlugin({ ssr: true })],
    });
    if (!r.success) throw new AggregateError(r.logs, "Bun.build failed");
    await renders((await import(join(out, "bun/entry.js"))) as Entry);
  }, 60_000);

  test("the same app built for the browser has none of the server's code", async () => {
    await vite({
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin()],
      build: {
        outDir: join(out, "client"),
        emptyOutDir: false,
        minify: false,
        lib: { entry: FIXTURES + "ssr/app.tsx", formats: ["es"], fileName: () => "app.js" },
      },
    });
    const code = await Bun.file(join(out, "client/app.js")).text();
    expect(code).toMatch(/__(rrT|template)\(\[/);
    expect(code).not.toMatch(/__ssr|renderToString|rr:b/);
  }, 60_000);
});

// #region The hooks

describe("the hooks", () => {
  type Hook = { handler(this: unknown, code: string, id: string, ...rest: unknown[]): unknown };
  /** The Vite plugin's transform hook of plugin `name`, for `options`. */
  const hook = (name: string, options: Parameters<typeof vitePlugin>[0] = {}): Hook | undefined => {
    const plugins = [vitePlugin(options)].flat() as { name: string; transform?: Hook }[];
    return plugins.find((p) => p.name === name)?.transform;
  };

  test("a Vite without environments: the transform's `ssr` flag says", () => {
    const compile = hook("@reactre/plugin")!;
    const code = "export const A = () => <p>{n()}</p>;";
    const ssr = compile.handler.call({}, code, "/app/a.tsx", { ssr: true }) as { code: string };
    expect(ssr.code).toContain("__rrsH(");
    const client = compile.handler.call({}, code, "/app/a.tsx") as { code: string };
    expect(client.code).toContain("__rrT(");
  });

  test("the server hook: what it points at the server, and what it leaves", () => {
    const server = hook("@reactre/plugin:server")!;
    const ctx = { environment: { config: { consumer: "server" } } };
    const run = (code: string, id: string) => server.handler.call(ctx, code, id);
    const imports = `import { effect } from "@reactre/core";`;
    expect(run(imports, "/app/state.ts")).toEqual({
      code: `import "@reactre/core/server";import { __ssrEffect as effect } from "@reactre/core/server";`,
      map: null,
    });
    expect(run(`const a = 1;`, "/app/plain.ts")).toBeNull();
    // A module the plugin compiles, and the core's own modules other than its feature modules.
    expect(run(imports, "/app/view.tsx")).toBeNull();
    expect(run(imports, PACKAGES + "core/src/server.ts")).toBeNull();
    expect(run(imports, PACKAGES + "core/src/features/context.ts")).toEqual({
      code: `import { effect } from "@reactre/core/server";`,
      map: null,
    });
    // The client's environment.
    expect(server.handler.call({ environment: { config: { consumer: "client" } } }, imports, "/app/a.ts")).toBeNull();
  });

  test("with `ssr: false` the hook is not there, and a Vite server render does not bundle the core", () => {
    expect(hook("@reactre/plugin:server", { ssr: false })).toBeUndefined();
    const plugins = [vitePlugin({ ssr: false })].flat() as { name: string; config?: () => Record<string, unknown> }[];
    expect(plugins.find((p) => p.name === "@reactre/plugin")!.config!()["ssr"]).toBeUndefined();
    const on = [vitePlugin()].flat() as { name: string; config?: () => Record<string, unknown> }[];
    expect(on.find((p) => p.name === "@reactre/plugin")!.config!()["ssr"]).toEqual({
      noExternal: [/^@reactre\/core(?:\/|$)/],
    });
  });

  test("another bundler gets the hook only with `ssr: true`", () => {
    const names = (options: { ssr?: boolean }) =>
      ([reactre.raw(options, { framework: "esbuild" } as never)].flat() as { name: string }[]).map((p) => p.name);
    expect(names({})).not.toContain("@reactre/plugin:server");
    expect(names({ ssr: true })).toContain("@reactre/plugin:server");
  });
});

// #endregion
