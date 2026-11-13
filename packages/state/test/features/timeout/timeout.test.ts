// timeout: a state's `timeout` and `onTimeout`. The compiled form is a timer resolved at entry, in
// `l` beside delays's; the machine at runtime is ../effects/machines.ts's reminder.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile, StateCompileError } from "@reactre/state/compiler";
import { build } from "esbuild";

import state from "../../../plugin/esbuild.ts";

import "../../compiled.ts";
import { emittedExports } from "../../run-emitted.ts";
import { change, JOB, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor } = await import("@reactre/state");
const { reminderMachine } = await import("../effects/machines.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const timed = (timeout: string) =>
  change(
    withUse(["timeout"]),
    'open: { on: { close: ({ to }) => to("closed") } },',
    `open: { timeout: ${timeout}, onTimeout: ({ to }) => to("closed"), on: { close: ({ to }) => to("closed") } },`,
  );

describe("timeout", () => {
  optIn("timeout");

  test("a timeout compiles to l, with the runner: milliseconds, a duration, or a function of the data", () => {
    const closed = '({ state: "closed", data: __reactreStateNone, version: 0 })';
    expect(compile("door.ts", timed("500"))?.code).toContain(`l: { "open": [[500, () => ${closed}]] }`);
    expect(compile("door.ts", timed('"30s"'))?.code).toContain(`l: { "open": [[30000, () => ${closed}]] }`);
    const code = compile("door.ts", timed("({ data }) => data.by.length * 1000"))?.code ?? "";
    expect(code).toContain(`l: { "open": [[(data) => data.by.length * 1000, () => ${closed}]] }`);
    // The small general lifecycle: no children, effects, persist, reenter or parallel node here.
    expect(code).toContain("r: __reactreStateRunNested([timeout.r])");
  });

  test("a timeout written as a module-level const, an alias, an import or arithmetic compiles to its value", () => {
    const l = (source: string): string | undefined =>
      /l: \{ "open": \[\[\d+/.exec(compile("door.ts", source)?.code ?? "")?.[0];
    const closed = 'l: { "open": [[1500';
    const withConst = (value: string, before: string): string =>
      change(timed(value), "const door = setup", `${before}const door = setup`);
    expect(l(withConst("LIMIT", "const LIMIT = 1500;\n"))).toBe(closed);
    expect(l(withConst("ALIAS", "const LIMIT = 1500;\nconst ALIAS = LIMIT;\n"))).toBe(closed);
    expect(l(withConst("BASE + 500", "const BASE = 1000;\n"))).toBe(closed);
    expect(l(withConst("SLOW", 'const SLOW = "1.5s";\n'))).toBe(closed);
    // The same value, written in place, compiles to the same table.
    expect(l(timed("1500"))).toBe(closed);
  });

  test("a timeout imported from another module compiles to its value, and a missing one is refused", () => {
    const dir = join(import.meta.dir, "..", "..", "out", `timeout-import-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "timing.ts"), "const LIMIT = 1500;\nexport { LIMIT as DEADLINE };\n");
      const at = join(dir, "machine.ts");
      const source = change(
        timed("DEADLINE"),
        'from "@reactre/state";\n',
        'from "@reactre/state";\nimport { DEADLINE } from "./timing.ts";\n',
      );
      expect(/l: \{ "open": \[\[\d+/.exec(compile(at, source)?.code ?? "")?.[0]).toBe('l: { "open": [[1500');
      const missing = source.replace("import { DEADLINE }", "import { NOPE as DEADLINE }");
      expect(() => compile(at, missing)).toThrow(/state "open"'s timeout is written in place/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a timeout in a const compiles to the same shape hash as the same timeout written in place", () => {
    // The hash is of the contracts and the work, not of how a timeout is written: a persisted
    // machine that moves a timeout into a const keeps its saved snapshots.
    const persisted = (value: string, before: string): string =>
      change(
        change(
          change(
            withUse(["timeout", "persist"], JOB),
            "use: [timeout, persist],",
            `use: [timeout, persist],\n  shape: "3020ooix",`,
          ),
          'after: { "1.5s": ({ to }) => to("failed", { error: "timed out" }) },',
          `timeout: ${value},\n      onTimeout: ({ to }) => to("failed", { error: "timed out" }),`,
        ),
        "const job = setup",
        `${before}const job = setup`,
      );
    const hash = (source: string): string => {
      try {
        compile("job.ts", source);
        return "compiled";
      } catch (e) {
        if (!(e instanceof StateCompileError)) throw e;
        return e.problems.map((p) => p.message).join("\n");
      }
    };
    const literal = hash(persisted("1500", ""));
    expect(literal).toContain('set shape: "');
    expect(hash(persisted("LIMIT", "const LIMIT = 1500;\n"))).toBe(literal);
  });

  test("a timeout in a const runs the same compiled app in development and production", async () => {
    // The whole app, bundled by the plugin and executed: the timeout is read at build time, so both
    // builds carry the same `l` and the deadline fires the same way. Each variation is its own file
    // (and its own bundle), so no compiled output is shared between them.
    const dir = join(import.meta.dir, "..", "..", "out", `timeout-run-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const app = (timeout: string, before = ""): string => `import { createActor, setup, types } from "@reactre/state";
import { timeout } from "@reactre/state/timeout";
${before}const m = setup({
  use: [timeout],
  states: { a: types<{}>(), b: types<{}>() },
  events: { go: types<{}>() },
});
export const machine = m.machine({
  start: ({ to }) => to("a"),
  states: { a: { timeout: ${timeout}, onTimeout: ({ to }) => to("b"), on: { go: ({ to }) => to("b") } }, b: { final: true } },
});
export function run(): string {
  const actor = createActor(machine);
  actor.send({ type: "go" });
  return actor.snapshot().state;
}
`;
    try {
      writeFileSync(join(dir, "timing.ts"), "const LIMIT = 20;\nexport { LIMIT as DEADLINE };\n");
      const variations: readonly (readonly [name: string, source: string])[] = [
        ["literal", app("20")],
        ["const", app("LIMIT", "const LIMIT = 20;\n")],
        ["alias", app("ALIAS", "const LIMIT = 20;\nconst ALIAS = LIMIT;\n")],
        ["arithmetic", app("BASE * 2", "const BASE = 10;\n")],
        ["duration", app("SLOW", 'const SLOW = "20ms";\n')],
        ["import", app("DEADLINE", 'import { DEADLINE } from "./timing.ts";\n')],
      ];
      for (const [name, source] of variations) {
        const entry = join(dir, `${name}.ts`);
        writeFileSync(entry, source);
        for (const dev of [false, true]) {
          const out = await build({
            entryPoints: [entry],
            bundle: true,
            platform: "neutral",
            format: "esm",
            write: false,
            conditions: ["reactre-source", "module"],
            plugins: [state({ dev })],
          });
          const code = out.outputFiles[0]?.text ?? "";
          expect(/l: \{ "a": \[\[\d+/.exec(code)?.[0]).toBe('l: { "a": [[20');
          const { run } = await emittedExports(code, "run");
          expect(run).toBe("b");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with delays in use too, one l and one runner", () => {
    const source = change(
      change(timed('"PT1S"'), "use: [timeout],", "use: [delays, timeout],"),
      'import { timeout } from "@reactre/state/timeout";',
      'import { delays } from "@reactre/state/delays";\nimport { timeout } from "@reactre/state/timeout";',
    );
    const code = compile("door.ts", source)?.code ?? "";
    expect(code.match(/\bl: /g)).toHaveLength(1);
    expect(code).toContain("r: __reactreStateRunNested([timeout.r])");
  });
});

describe("at runtime", () => {
  test("onTimeout decides where to go when the deadline passes; leaving first cancels it", async () => {
    const actor = createActor(reminderMachine);
    actor.send({ type: "start", ms: 5000 });
    expect(actor.snapshot().state).toBe("waiting");
    actor.send({ type: "answer" });
    await tick(20);
    expect(actor.snapshot().state).toBe("done");
  });
});
