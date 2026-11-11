// delays: named delays, delays from data, and ISO 8601 durations in `after`. The machine is
// ../effects/machines.ts's reminder, compiled by the preload plugin.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { __Compiled, __RunContext } from "@reactre/state";
import { compile, StateCompileError } from "@reactre/state/compiler";
import { delays } from "@reactre/state/delays";
import { __lateSaved } from "@reactre/state/delays/saved";
import { SimulatedClock } from "@reactre/state/utils/SimulatedClock";
import { build } from "esbuild";

import state from "../../../plugin/esbuild.ts";

import "../../compiled.ts";
import { duration } from "../../../compiler/features/delays.ts";
import { change, JOB, withUse } from "../../sources.ts";
import { to } from "../../to.ts";
import { optIn } from "../opt-in.ts";

const { createActor } = await import("@reactre/state");
const { reminderMachine } = await import("../effects/machines.ts");

describe("delays", () => {
  optIn("delays");

  test("an ISO key compiles to milliseconds in l, with the runner", () => {
    const source = change(withUse(["delays"], JOB), '"1.5s"', '"PT1M30S"');
    const code = compile("job.ts", source)?.code ?? "";
    expect(code).toContain(
      'l: { "saving": [[90000, () => ({ state: "failed", data: { error: "timed out" }, version: 0 })]] }',
    );
    // The small general lifecycle: this machine has no children, effects, persist, reenter or
    // parallel node, so it needs none of `__run`'s other paths (see src/run-nested.ts).
    expect(code).toContain("r: __reactreStateRunNested([__reactreStateTasks, delays.r])");
  });

  test("a named delay compiles to its name in l, and its value in w", () => {
    const source = change(
      change(withUse(["delays"], JOB), "use: [delays],", 'use: [delays],\n  delays: { patience: "2s" },'),
      '"1.5s"',
      "patience",
    );
    const code = compile("job.ts", source)?.code ?? "";
    expect(code).toContain('l: { "saving": [["patience", () => ({ state: ');
    expect(code).toContain('w: { "patience": 2000 }');
  });

  test("a delay written as a module-level const, an alias, an import or arithmetic compiles to its value", () => {
    const named = (value: string, before: string): string =>
      change(
        change(
          change(withUse(["delays"], JOB), "use: [delays],", `use: [delays],\n  delays: { patience: ${value} },`),
          '"1.5s"',
          "patience",
        ),
        "const job = setup",
        `${before}const job = setup`,
      );
    const w = (source: string): string | undefined => /w: \{[^}]*\}/.exec(compile("job.ts", source)?.code ?? "")?.[0];
    // A const, an alias of one, arithmetic over consts, and a duration in a const: all read at build time.
    expect(w(named("PATIENCE", "const PATIENCE = 2000;\n"))).toBe('w: { "patience": 2000 }');
    expect(w(named("ALIAS", "const PATIENCE = 2000;\nconst ALIAS = PATIENCE;\n"))).toBe('w: { "patience": 2000 }');
    expect(w(named("BASE * 2 + 500", "const BASE = 750;\n"))).toBe('w: { "patience": 2000 }');
    expect(w(named("SLOW", 'const SLOW = "2s";\n'))).toBe('w: { "patience": 2000 }');
    expect(w(named("`${BASE}ms`", "const BASE = 2000;\n"))).toBe('w: { "patience": 2000 }');
    // The same value, written in place, compiles to the same table: the const is not a different machine.
    expect(w(named("2000", ""))).toBe('w: { "patience": 2000 }');
    // And a development build compiles the delay the same: the value is read at build time, not at
    // run time (the dev build's own freeze wrapper is the only difference in the table).
    const source = named("PATIENCE", "const PATIENCE = 2000;\n");
    const dev = /w: \{[^}]*\}/.exec(compile("job.ts", source, { dev: true })?.code ?? "")?.[0];
    expect(dev).toBe('w: { "patience": 2000 }');
  });

  test("a delay imported from another module compiles to its value, and a missing one is refused", () => {
    const dir = join(import.meta.dir, "..", "..", "out", `delays-import-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "timing.ts"), "const PATIENCE = 2000;\nexport { PATIENCE as WAIT };\n");
      const at = join(dir, "machine.ts");
      const source = change(
        change(
          change(withUse(["delays"], JOB), "use: [delays],", "use: [delays],\n  delays: { patience: WAIT },"),
          '"1.5s"',
          "patience",
        ),
        'from "@reactre/state";\n',
        'from "@reactre/state";\nimport { WAIT } from "./timing.ts";\n',
      );
      expect(/w: \{[^}]*\}/.exec(compile(at, source)?.code ?? "")?.[0]).toBe('w: { "patience": 2000 }');
      // A name the module doesn't export is unresolved: the compiler says to write it in place.
      const missing = source.replace("import { WAIT }", "import { NOPE as WAIT }");
      expect(() => compile(at, missing)).toThrow(/delay "patience" is written in place/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a delay in a const compiles to the same shape hash as the same delay written in place", () => {
    // The hash is of the contracts and the work, not of how a delay is written: a persisted machine
    // that moves a delay into a const keeps its saved snapshots.
    const persisted = (value: string, before: string): string =>
      change(
        change(
          change(
            withUse(["delays", "persist"], JOB),
            "use: [delays, persist],",
            `use: [delays, persist],\n  delays: { patience: ${value} },`,
          ),
          '"1.5s"',
          "patience",
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
    const literal = hash(persisted("2000", ""));
    expect(literal).toContain('set shape: "');
    expect(hash(persisted("PATIENCE", "const PATIENCE = 2000;\n"))).toBe(literal);
  });

  test("a delay in a const runs the same compiled app in development and production", async () => {
    // The whole app, bundled by the plugin and executed: the delay is read at build time, so both
    // builds carry the same `w` and the timer fires the same way. Each variation is its own file
    // (and its own bundle), so no compiled output is shared between them.
    const dir = join(import.meta.dir, "..", "..", "out", `delays-run-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const app = (delay: string, before = ""): string => `import { createActor, setup, types } from "@reactre/state";
import { delays } from "@reactre/state/delays";
${before}const m = setup({
  use: [delays],
  delays: { patience: ${delay} },
  states: { a: types<{}>(), b: types<{}>() },
  events: { go: types<{}>() },
});
export const machine = m.machine({
  start: ({ to }) => to("a"),
  states: { a: { on: { go: ({ to }) => to("b") }, after: { patience: ({ to }) => to("b") } }, b: { final: true } },
});
export function run(): string {
  const actor = createActor(machine);
  actor.send({ type: "go" });
  return actor.snapshot().state;
}
`;
    try {
      // The imported value lives in its own module, so the entry's import is what the compiler reads.
      writeFileSync(join(dir, "timing.ts"), "const PATIENCE = 20;\nexport { PATIENCE as WAIT };\n");
      const variations: readonly (readonly [name: string, source: string])[] = [
        ["literal", app("20")],
        ["const", app("PATIENCE", "const PATIENCE = 20;\n")],
        ["alias", app("ALIAS", "const PATIENCE = 20;\nconst ALIAS = PATIENCE;\n")],
        ["arithmetic", app("BASE * 2", "const BASE = 10;\n")],
        ["duration", app("SLOW", 'const SLOW = "20ms";\n')],
        ["import", app("WAIT", 'import { WAIT } from "./timing.ts";\n')],
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
          expect(/w: \{[^}]*\}/.exec(code)?.[0]).toBe('w: { "patience": 20 }');
          const { run } = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
            run(): string;
          };
          expect(run()).toBe("b");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with persist in use, the runner that saves deadlines comes from its own import; without, none of it", () => {
    // A timer of another delay is other work, so persisted, its shape has another hash (M553).
    const iso = (features: string[]) =>
      change(withUse(features, JOB), '"1.5s"', '"PT1M30S"').replace('shape: "3020ooix"', 'shape: "wh3t3h0q"');
    const saved = compile("job.ts", iso(["delays", "persist"]))?.code ?? "";
    expect(saved).toContain('import { __lateSaved as __reactreStateLateSaved } from "@reactre/state/delays/saved";');
    expect(saved).toMatch(/r: __reactreStateRun\(\[persist\.t, __reactreStateLateSaved\]\)/);
    const plain = compile("job.ts", iso(["delays"]))?.code ?? "";
    expect(plain).not.toContain("delays/saved");
    // timeout shares the runner, and the import is written once.
    const both =
      compile(
        "job.ts",
        change(
          iso(["delays", "timeout", "persist"]),
          "saving: {",
          'saving: {\n      timeout: "5s",\n      onTimeout: ({ to }) => to("idle"),',
        ).replace('shape: "wh3t3h0q"', 'shape: "qa9mdy9x"'),
      )?.code ?? "";
    expect(both.split("delays/saved")).toHaveLength(2);
    expect(both).toContain("__reactreStateLateSaved]");
  });

  test("the saving runner gives each deadline, absolute, and a restored one waits what was left; the plain one saves nothing", () => {
    const fired: unknown[] = [];
    const m: __Compiled = { v: 0, e: {}, i: () => to("a"), o: { a: {} }, l: { a: [[500, () => to("b")]] } };
    const ctx = (now: number, saved?: unknown): __RunContext => ({
      deliver: () => null,
      go: (step) => fired.push(step),
      now: () => now,
      current: () => ({ state: "a", data: {} }),
      saved,
    });
    const node = { node: "a", state: "a", data: {} };
    const work = __lateSaved.start(m, node, ctx(1000));
    expect(work?.save?.()).toEqual([1500]);
    work?.stop();
    const restored = __lateSaved.start(m, node, ctx(1100, [1200]));
    expect(restored?.save?.()).toEqual([1200]);
    restored?.stop();
    // A timer that fired before the save doesn't fire again.
    const done = __lateSaved.start(m, node, ctx(1100, [null]));
    expect(done?.save?.()).toEqual([null]);
    done?.stop();
    const plain = delays.r.start(m, node, ctx(1000));
    expect(plain?.save).toBeUndefined();
    plain?.stop();
    expect(fired).toEqual([]);
  });

  test("durations: the core's and ISO 8601 of fixed length", () => {
    expect(duration("500ms")).toBe(500);
    expect(duration("1.5s")).toBe(1500);
    expect(duration("2m")).toBe(120000);
    expect(duration("PT1M30S")).toBe(90000);
    expect(duration("P1DT12H")).toBe(129600000);
    expect(duration("P1W")).toBe(604800000);
    expect(duration("PT0.5S")).toBe(500);
    expect(duration("P")).toBeNull();
    expect(duration("PT")).toBeNull();
    expect(duration("P1Y")).toBeNull();
    expect(duration("5 sec")).toBeNull();
  });
});

// On a simulated clock: real timers under a loaded machine (the whole suite) fire late, and a
// 40ms timeout checked 60ms later then fails now and then.
describe("at runtime", () => {
  let clock: SimulatedClock | undefined;
  afterEach(() => clock?.uninstall());

  test("an ISO timer fires, and a delay from the data is read at entry", () => {
    clock = new SimulatedClock();
    const actor = createActor(reminderMachine, { now: clock.now });
    actor.send({ type: "start", ms: 15 });
    // sla reads data.ms (15); the timeout (also 15) is later in the list, so sla goes first.
    clock.advance(15);
    expect(actor.snapshot()).toEqual({ state: "late", data: { by: "sla" }, version: 0 });
    // late's timeout is the named delay "soon" (40ms).
    clock.advance(39);
    expect(actor.snapshot().state).toBe("late");
    clock.advance(1);
    expect(actor.snapshot().state).toBe("done");
  });

  test("leaving the state cancels its timers", () => {
    clock = new SimulatedClock();
    const actor = createActor(reminderMachine, { now: clock.now });
    actor.send({ type: "start", ms: 15 });
    actor.send({ type: "answer" });
    expect(actor.snapshot().state).toBe("done");
    expect(clock.pending()).toBe(0);
  });
});

// llm:B2, llm:B3, apps:C24: a delay computed past setTimeout's limit (2^31 − 1 ms, about 24.8 days),
// which a real setTimeout fires at once. The clock is wrapped to do what the real timers do there.
describe("a delay past setTimeout's limit", () => {
  const LIMIT = 2147483647;
  const DAY = 864e5;
  let clock: SimulatedClock | undefined;
  afterEach(() => clock?.uninstall());

  /** A simulated clock whose setTimeout overflows as the real one does: past the limit, at once. */
  function overflowing(): SimulatedClock {
    const c = new SimulatedClock();
    const set = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      set(fn, (ms ?? 0) > LIMIT ? 1 : ms)) as unknown as typeof setTimeout;
    return c;
  }

  test("a 30-day delay from the data waits 30 days", () => {
    clock = overflowing();
    const actor = createActor(reminderMachine, { now: clock.now });
    actor.send({ type: "start", ms: 30 * DAY });
    clock.advance(1);
    expect(actor.snapshot().state).toBe("waiting");
    clock.advance(30 * DAY - 2);
    expect(actor.snapshot().state).toBe("waiting");
    clock.advance(1);
    expect(actor.snapshot().state).toBe("late");
    actor.stop();
  });

  // M35: data is JSON, and JSON has no Infinity. A development build refuses it at the move that
  // would store it (S3), so a delay can't be made infinite through data. The runner still never
  // fires one (a hand-written table, or a delay computed past the float range), which the next
  // test pins.
  test("an infinite delay in data is refused in development, before it is stored", () => {
    clock = overflowing();
    const actor = createActor(reminderMachine, { now: clock.now });
    expect(() => actor.send({ type: "start", ms: Number.POSITIVE_INFINITY })).toThrow(
      /\[@reactre\/state S3\] data\.ms is Infinity, which JSON turns into null/,
    );
    expect(actor.snapshot().state).toBe("idle");
    actor.stop();
  });

  test("the runner never fires an infinite delay", () => {
    clock = overflowing();
    const fired: unknown[] = [];
    const m: __Compiled = {
      v: 0,
      e: {},
      i: () => to("a"),
      o: { a: {} },
      l: { a: [[Number.POSITIVE_INFINITY, () => to("b")]] },
    };
    const work = __lateSaved.start(
      m,
      { node: "a", state: "a", data: {} },
      {
        deliver: () => null,
        go: (step) => fired.push(step),
        now: clock.now,
        current: () => ({ state: "a", data: {} }),
        saved: undefined,
      },
    );
    clock.advance(365 * DAY);
    expect(fired).toEqual([]);
    expect(clock.pending()).toBe(0);
    work?.stop();
  });

  test("the saving runner waits a long deadline out, from the actor's clock", () => {
    clock = overflowing();
    const fired: unknown[] = [];
    const m: __Compiled = { v: 0, e: {}, i: () => to("a"), o: { a: {} }, l: { a: [[40 * DAY, () => to("b")]] } };
    const work = __lateSaved.start(
      m,
      { node: "a", state: "a", data: {} },
      {
        deliver: () => null,
        go: (step) => fired.push(step),
        now: clock.now,
        current: () => ({ state: "a", data: {} }),
        saved: undefined,
      },
    );
    expect(work?.save?.()).toEqual([40 * DAY]);
    clock.advance(40 * DAY - 1);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([to("b")]);
    expect(work?.save?.()).toEqual([null]);
    work?.stop();
  });

  test("stopping in the middle of a long wait cancels what is left", () => {
    clock = overflowing();
    const actor = createActor(reminderMachine, { now: clock.now });
    actor.send({ type: "start", ms: 60 * DAY });
    clock.advance(LIMIT + 1);
    expect(clock.pending()).toBeGreaterThan(0);
    actor.stop();
    expect(clock.pending()).toBe(0);
  });
});
