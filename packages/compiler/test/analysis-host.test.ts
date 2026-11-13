import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type AnalysisDiagnostic, reactreCompiler, transpileSource } from "../src/index.ts";
import { analyze, type Host } from "../src/program.ts";

const dir = mkdtempSync(join(tmpdir(), "reactre-analysis-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, source: string) => {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
};
const core = resolve(import.meta.dir, "../../core/src/index.ts");
const dom = resolve(import.meta.dir, "../../dom/src/index.ts");
const rows = file(
  "rows.ts",
  `
  let reads = 0;
  export const labelReads = () => reads;
  export const initialRows = [{ id: 1, get label() { reads++; return "one"; } }, { id: 2, label: "two" }];
`,
);
const entry = file(
  "app.tsx",
  `
  import { attach, For, selector, signal } from "@reactre/core";
  import { initialRows, labelReads } from "@data/rows";
  export { labelReads };
  export function mount(root) {
    const [rows, setRows] = signal(initialRows);
    const [selected, setSelected] = signal(1);
    const isSelected = selector(selected);
    const dispose = attach(() => <ul><For each={rows()} key={r => r.id}>{r =>
      <li class={isSelected(r.id) ? "selected" : ""}>{r.label}</li>
    }</For></ul>, root);
    return { dispose, setRows, setSelected };
  }
`,
);
const resolveSource: Host["resolve"] = (spec, importer) => {
  if (spec === "@data/rows") return rows;
  if (spec === "@reactre/core") return core;
  if (spec === "@reactre/dom") return dom;
  return Bun.resolveSync(spec, dirname(importer));
};

test("one custom resolver restores static row facts, keyed updates and delegated selection", async () => {
  for (const custom of [false, true]) {
    const diagnostics: AnalysisDiagnostic[] = [];
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      plugins: [
        {
          name: "sources",
          setup(b) {
            b.onResolve({ filter: /^(@data\/rows|@reactre\/(core|dom))$/ }, async ({ path, importer }) => {
              const resolved = await resolveSource(path, importer);
              return typeof resolved === "string" ? { path: resolved } : undefined;
            });
          },
        },
        reactreCompiler({
          analysis: {
            ...(custom ? { resolve: resolveSource, strict: true } : {}),
            onDiagnostic: (d) => diagnostics.push(d),
          },
        }),
      ],
    });
    expect(result.success).toBe(true);
    const output = file(`bundle-${custom}.js`, await result.outputs[0]!.text());
    const app = await import(output);
    const root = document.createElement("div");
    const mounted = app.mount(root);
    const initial = app.labelReads();
    const first = root.firstChild!.firstChild;
    mounted.setSelected(2);
    expect(root.textContent).toBe("onetwo");
    expect(app.labelReads() === initial).toBe(custom);
    mounted.setRows([
      { id: 1, label: "changed" },
      { id: 2, label: "two" },
    ]);
    expect(root.firstChild!.firstChild).toBe(first);
    expect(root.textContent).toBe("changedtwo");
    mounted.dispose();
    expect(root.textContent).toBe("");
    expect(diagnostics.some((d) => d.specifier === "@data/rows" && d.importer === entry)).toBe(!custom);
  }
});

test("diagnostics distinguish unreadable, opaque, unresolved and external modules", async () => {
  const diagnostics: AnalysisDiagnostic[] = [];
  const host: Host = {
    resolve: () => null,
    transpile: (_, s) => transpileSource(s),
    onDiagnostic: (d) => diagnostics.push(d),
  };
  const missing = file("missing.ts", 'import "missing";');
  expect(await analyze([missing], host)).toBeNull();
  expect(diagnostics[0]).toMatchObject({ code: "unresolved-import", importer: missing, specifier: "missing" });
  expect(diagnostics[0]!.message).toContain("source path");
  diagnostics.length = 0;
  expect(await analyze([missing], { ...host, resolve: () => false })).not.toBeNull();
  expect(diagnostics).toEqual([]);
  const opaque = file("opaque.ts", "import(name);");
  expect(await analyze([opaque], host)).toBeNull();
  expect(diagnostics[0]).toMatchObject({ code: "opaque-module", importer: opaque });
  expect(await analyze([join(dir, "absent.ts")], host)).toBeNull();
  expect(diagnostics[1]!.code).toBe("unreadable-module");
});

test("strict analysis rejects incomplete builds, but explicit externals remain valid", async () => {
  const entrypoint = file("strict.tsx", 'import "virtual:unknown"; export const view = <p>ok</p>;');
  const build = (external: string[]) =>
    Bun.build({
      entrypoints: [entrypoint],
      external,
      plugins: [reactreCompiler({ analysis: { strict: true } })],
      throw: false,
    });
  const failed = await build(["@reactre/core"]);
  expect(failed.success).toBe(false);
  expect(failed.logs.map(String).join("\n")).toContain("virtual:unknown");
  expect((await build(["@reactre/core", "virtual:unknown"])).success).toBe(true);
  expect(() =>
    Bun.build({
      entrypoints: [entrypoint],
      plugins: [reactreCompiler({ wholeProgram: false, analysis: { strict: true } })],
    }),
  ).toThrow("wholeProgram enabled");
});

test("a custom read and transpile host is shared by analysis and compilation", async () => {
  const entrypoint = file("transformed.tsx", "REPLACE_ME");
  const result = await Bun.build({
    entrypoints: [entrypoint],
    external: ["@reactre/core"],
    plugins: [
      reactreCompiler({
        analysis: {
          strict: true,
          read: () => "<p>custom</p>",
          transpile: (_, source) => transpileSource(`export const view = ${source};`),
        },
      }),
    ],
  });
  expect(result.success).toBe(true);
  expect(await result.outputs[0]!.text()).toContain("<p>custom</p>");
});
