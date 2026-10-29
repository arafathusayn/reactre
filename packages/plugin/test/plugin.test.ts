// Unit tests of the plugin's own options and errors, through unplugin's raw factory (the hooks as
// written, before unplugin adapts them to a bundler). Bundling with each bundler is tested in
// ./bundlers.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { baseFor, reactre, type ReactreOptions } from "../src/index.ts";

// biome-ignore lint: the bundlers' hook contexts are stubbed loosely.
type Any = any;

/** The raw plugin (or plugins) for `framework`, with compat options. */
const raw = (framework: string, options: ReactreOptions = { compat: true }): Any =>
  reactre.raw(options, { framework } as never);

/** What a Rollup-style resolveId hook asks the bundler to resolve `id` to, and what it returns. */
async function resolveWith(plugin: Any, id: string): Promise<{ asked: string | null; result: unknown }> {
  let asked: string | null = null;
  const context = {
    resolve: async (source: string) => {
      asked = source;
      return { id: "/resolved/" + source };
    },
  };
  const hook = plugin.resolveId;
  const result = hook.filter.id.test(id) ? await hook.handler.call(context, id, "/app/main.jsx") : "(filtered)";
  return { asked, result };
}

/** The ids the redirect is checked with, and their targets (the client build is `client`). */
const targets = (client: string): [string, string][] => [
  ["react", client],
  ["react/jsx-runtime", client],
  ["react-dom", client],
  ["react-dom/client", client],
  ["react-dom/server", "@reactre/compat/server"],
  ["react-dom/server.browser", "@reactre/compat/server"],
  ["react-dom/server.edge", "@reactre/compat/server"],
  ["react-dom/server.node", "@reactre/compat/server"],
  ["react-dom/server.bun", "@reactre/compat/server"],
  ["react-dom/server.js", "@reactre/compat/server"],
  ["react-dom/static", "@reactre/compat/server"],
  ["react-dom/static.edge", "@reactre/compat/server"],
];

/** The plugin's transform handler for `options`, as Vite would get it. */
function transform(options: ReactreOptions) {
  const raw = reactre.raw(options, { framework: "vite" } as never);
  const t = Array.isArray(raw) ? raw[0]!.transform : raw.transform;
  return t as { handler: (code: string, id: string) => { code: string } } | undefined;
}

describe("transform", () => {
  test("core mode names the file in a compile error", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = () => <><b /></>;`, "/app/a.tsx?v=1")).toThrow(
      /^\/app\/a\.tsx: reactre: /,
    );
  });

  test("core mode refuses a key after spread props, which needs React's classic runtime", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = (p) => <b {...p} key="k" />;`, "/app/b.jsx")).toThrow(
      "reactre: /app/b.jsx: a key after {...spread} props cannot be compiled",
    );
  });

  test("errors that are not compile errors pass through unchanged", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = () => <p>;`, "/app/c.tsx")).toThrow(/^\/app\/c\.tsx: /);
  });

  test("compat mode with compile: false only redirects react, with no transform", () => {
    expect(transform({ compat: { compile: false } })).toBeUndefined();
    expect(transform({ compat: true })!.handler(`export const A = () => <b>x</b>;`, "/app/d.jsx").code).toContain(
      "__hrTemplate",
    );
  });
});

describe("compat: where react resolves", () => {
  test("Vite: react to compat, its server renderer to @reactre/compat/server", async () => {
    for (const [options, client] of [
      [{ compat: true }, "@reactre/compat"],
      [{ compat: { classes: true } }, "@reactre/compat"],
    ] as const) {
      const plugin = raw("vite", options);
      for (const [id, target] of targets(client)) {
        const { asked, result } = await resolveWith(plugin, id);
        expect(asked).toBe(target);
        expect(result).toEqual({ id: "/resolved/" + target });
      }
      expect((await resolveWith(plugin, "react-dom-x")).result).toBe("(filtered)");
    }
    // A target the bundler cannot resolve leaves the request alone.
    const plugin = raw("vite");
    expect(await plugin.resolveId.handler.call({ resolve: async () => null }, "react", undefined)).toBeNull();
    expect(await plugin.resolveId.handler.call({}, "react", undefined)).toBeNull();
  });

  test("Vite: the RSC environment, or one with the react-server condition, stays on React", async () => {
    const vite = raw("vite").vite;
    const env = (name: string, conditions: string[]): Any => ({ name, config: { resolve: { conditions } } });
    expect(vite.applyToEnvironment(env("client", ["module", "browser"]))).toBe(true);
    expect(vite.applyToEnvironment(env("ssr", ["module", "node"]))).toBe(true);
    expect(vite.applyToEnvironment(env("rsc", []))).toBe(false);
    expect(vite.applyToEnvironment(env("server", ["react-server", "node"]))).toBe(false);
    // The dependency optimizer of the other environments redirects react too.
    expect(vite.configEnvironment("rsc", {})).toBeUndefined();
    expect(vite.configEnvironment("server", { resolve: { conditions: ["react-server"] } })).toBeUndefined();
    const optimizer = vite.configEnvironment("client", {}).optimizeDeps.rolldownOptions.plugins[0];
    expect(optimizer.name).toBe("@reactre/plugin:react");
    expect((await resolveWith(optimizer, "react-dom/server")).asked).toBe("@reactre/compat/server");
  });

  test("Rollup and Rolldown: resolved by the bundler, unless Rolldown resolves with react-server", async () => {
    for (const framework of ["rollup", "rolldown"]) {
      const plugin = raw(framework);
      for (const [id, target] of targets("@reactre/compat")) expect((await resolveWith(plugin, id)).asked).toBe(target);
      plugin.rolldown.options({ resolve: { conditionNames: ["react-server", "import"] } });
      expect(await resolveWith(plugin, "react")).toEqual({ asked: null, result: null });
      plugin.rolldown.options({});
      expect((await resolveWith(plugin, "react")).asked).toBe("@reactre/compat");
    }
  });

  test("APIs switched off: react resolves to a module written for them, and a scan joins every bundler", async () => {
    const options = { compat: { exclude: ["useEffect"] } };
    for (const framework of ["vite", "rollup", "rolldown", "webpack", "rspack", "bun"]) {
      const plugins = raw(framework, options);
      expect(plugins.map((p: Any) => p.name)).toEqual(["@reactre/plugin", "@reactre/plugin:api"]);
      const { handler } = plugins[1].transform;
      expect(handler("const x = 1;", "/app/a.js")).toBeNull();
      expect(handler('import { useState } from "react";', "/app/a.js")).toBeNull();
      expect(() => handler('import { useEffect } from "react";', "/app/a.jsx?v=1")).toThrow(
        "/app/a.jsx: uses React's useEffect",
      );
    }
    const [vite, scanner] = raw("vite", options);
    vite.vite.configResolved({ root: new URL("..", import.meta.url).pathname });
    expect((await resolveWith(vite, "react")).asked).toMatch(
      /node_modules\/\.cache\/reactre\/compat-[0-9a-f]{12}\.js$/,
    );
    // The written module's own imports of compat resolve as react does.
    expect((await resolveWith(vite, "@reactre/compat/core")).asked).toBe("@reactre/compat/core");
    // The scan stays out of the RSC environment, and runs in the dependency optimizer too.
    expect(scanner.vite.applyToEnvironment({ name: "rsc", config: { resolve: { conditions: [] } } })).toBe(false);
    const optimizer = vite.vite.configEnvironment("client", {}).optimizeDeps.rolldownOptions.plugins[0];
    expect(() => optimizer.transform('import { useEffect } from "react";', "/dep.js")).toThrow(
      "uses React's useEffect",
    );
    // esbuild: the redirect plugin and the scan.
    expect(raw("esbuild", options).map((p: Any) => p.name)).toEqual([
      "@reactre/plugin",
      "@reactre/plugin:react",
      "@reactre/plugin:api",
    ]);
    // Options naming no key, or turning both roots off, fail when the plugin is made.
    expect(() => raw("vite", { compat: { exclude: ["useEfect"] } })).toThrow('"useEfect" is not an API key');
    expect(() => raw("vite", { compat: { apis: ["useState"] } })).toThrow("needs createRoot or hydrateRoot");
  });

  test("class support or a behaviour off: a module built on core with the features that are on, and no scan", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const written = async (options: Any): Promise<string> => {
      const plugin = raw("vite", options);
      // No API is off, so no scan joins: the plugin is one, not a list.
      expect(plugin.name).toBe("@reactre/plugin");
      plugin.vite.configResolved({ root });
      const { asked } = await resolveWith(plugin, "react");
      expect(asked).toMatch(/node_modules\/\.cache\/reactre\/compat-[0-9a-f]{12}\.js$/);
      // Its imports of compat's feature modules resolve as react does.
      expect((await resolveWith(plugin, "@reactre/compat/features/stacks")).asked).toBe(
        "@reactre/compat/features/stacks",
      );
      return readFileSync(asked!, "utf8");
    };
    for (const options of [{ compat: { classes: false } }, { compat: { exclude: ["@classes"] } }]) {
      const src = await written(options);
      expect(src).toContain(
        'import "@reactre/compat/features/stacks";\nimport "@reactre/compat/features/keys";\n' +
          'import "@reactre/compat/features/retry";\n',
      );
      expect(src).not.toContain("features/classes");
      expect(src).toContain('export * from "@reactre/compat/core";');
    }
    const src = await written({ compat: { exclude: ["componentStack"] } });
    expect(src).toContain(
      'import "@reactre/compat/features/classes";\nimport "@reactre/compat/features/keys";\n' +
        'import "@reactre/compat/features/retry";\n',
    );
    expect(src).not.toContain("features/stacks");
    // The render retry off: the others load, it does not.
    const noRetry = await written({ compat: { exclude: ["renderRetry"] } });
    expect(noRetry).toContain(
      'import "@reactre/compat/features/classes";\nimport "@reactre/compat/features/stacks";\n' +
        'import "@reactre/compat/features/keys";\n',
    );
    expect(noRetry).not.toContain("features/retry");
  });

  test("esbuild: its own resolve, not registered for a react-server build", async () => {
    const [, redirect] = raw("esbuild");
    const setup = (conditions?: string[]): Any => {
      let onResolve: Any = null;
      const asked: string[] = [],
        data: unknown[] = [];
      redirect.esbuild.setup({
        initialOptions: conditions === undefined ? {} : { conditions },
        onResolve: (_: unknown, fn: Any) => (onResolve = fn),
        resolve: async (path: string, options: { pluginData: unknown }) => (
          asked.push(path),
          data.push(options.pluginData),
          path === "missing" ? { errors: ["e"] } : { errors: [], path: "/r/" + path, sideEffects: true }
        ),
      });
      return { onResolve, asked, data };
    };
    expect(setup(["react-server"]).onResolve).toBeNull();
    const { onResolve, asked, data } = setup();
    expect(await onResolve({ path: "react-dom/server.edge", kind: "import-statement", resolveDir: "/app" })).toEqual({
      path: "/r/@reactre/compat/server",
      sideEffects: true,
    });
    await onResolve({ path: "react", kind: "import-statement", resolveDir: "/app" });
    expect(asked).toEqual(["@reactre/compat/server", "@reactre/compat"]);
    // The plugin's own resolve of a compat entry comes back through it, and is left to esbuild.
    expect(
      await onResolve({ path: "@reactre/compat", kind: "import-statement", resolveDir: "/", pluginData: data[1] }),
    ).toBe(undefined);
  });

  test("webpack and Rspack: a module replacement, not added for a react-server build", () => {
    for (const framework of ["webpack", "rspack"]) {
      const applied: Any[] = [];
      const bundler = {
        NormalModuleReplacementPlugin: class {
          constructor(
            readonly test: RegExp,
            readonly replace: (r: { request: string; context: string }) => void,
          ) {}
          apply() {
            applied.push(this);
          }
        },
      };
      const hook = raw(framework)[framework];
      hook({ [framework]: bundler, options: { resolve: { conditionNames: ["react-server"] } } });
      expect(applied).toEqual([]);
      hook({ [framework]: bundler, options: {} });
      const replacement = applied[0];
      for (const [id, target] of targets("@reactre/compat")) {
        const resource = { request: id, context: "/nowhere/app" };
        expect(replacement.test.test(id)).toBe(true);
        replacement.replace(resource);
        expect(resource.request).toBe(target);
        // Resolved from a directory that reaches @reactre/compat.
        expect(resource.context).toBe(baseFor("/nowhere/app/_", process.cwd()));
      }
    }
  });

  test("the target resolves from the importer's directory, else the app's root, else the plugin's", () => {
    const here = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
    const plugin = dirname(here) + "/src";
    // The test's own directory reaches the workspace's @reactre/compat.
    expect(baseFor(here + "/x.js", "/nowhere")).toBe(here);
    // A virtual module, no importer, or one that reaches nothing: the root, when it reaches it.
    expect(baseFor("\0virtual", here)).toBe(here);
    expect(baseFor(undefined, here)).toBe(here);
    expect(baseFor("/nowhere/lib/index.js", here)).toBe(here);
    // Neither reaches it: the plugin's own directory, since the plugin depends on @reactre/compat.
    expect(baseFor("/nowhere/lib/index.js", "/nowhere")).toBe(plugin);
  });

  test("Bun: Bun's resolver, unless the build resolves with react-server", () => {
    const plugin = raw("bun");
    const importer = new URL("../src/index.ts", import.meta.url).pathname;
    plugin.bun.setup({ config: {} });
    expect(plugin.resolveId.handler("react-dom/server", importer)).toBe(
      Bun.resolveSync("@reactre/compat/server", importer),
    );
    // Without an importer, from the working directory.
    const cwd = process.cwd();
    process.chdir(new URL("..", import.meta.url).pathname);
    try {
      expect(plugin.resolveId.handler("react", undefined)).toBe(Bun.resolveSync("@reactre/compat", process.cwd()));
    } finally {
      process.chdir(cwd);
    }
    plugin.bun.setup({ config: { conditions: "react-server" } });
    expect(plugin.resolveId.handler("react", importer)).toBeNull();
    plugin.bun.setup({ config: { conditions: ["browser", "react-server"] } });
    expect(plugin.resolveId.handler("react", importer)).toBeNull();
  });
});
