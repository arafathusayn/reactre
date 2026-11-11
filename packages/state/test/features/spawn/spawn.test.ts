// spawn: `enq.spawn`, `enq.stop`, `enq.subscribeTo` and `enq.listen`, on a compiled pool of workers
// (./fixture.ts): spawned children by name and key, their reports as the machine's events, persist
// and restore.

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

import type { __Compiled, __Effect, __Lifecycle, __Options } from "@reactre/state";
import { compile } from "@reactre/state/compiler";

import { to } from "../../to.ts";
import { optIn } from "../opt-in.ts";

const { createActor, restoreActor, transition } = await import("@reactre/state");
const { child } = await import("@reactre/state/children");
const { migrations, persist } = await import("@reactre/state/persist");
const { poolMachine } = await import("./fixture.ts");

const { spawn } = await import("@reactre/state/spawn");

const tick = () => new Promise((r) => setTimeout(r, 0));
const RESTORE = 'import { __restoring as __reactreStateSpawnRestore } from "@reactre/state/spawn/restore";';

describe("spawn", () => {
  // Listed but unused (no handler records effects), it adds nothing.
  optIn("spawn");

  test("a machine that records effects gets the machines it may spawn, spawn's runners and the restoring wrap", async () => {
    const source = await Bun.file(new URL("./fixture.ts", import.meta.url)).text();
    const code = compile("fixture.ts", source)?.code ?? "";
    expect(code).toContain('sp: { "worker": workerMachine }');
    // persist is in use: the wrap that restores spawned children, from its own import.
    expect(code).toMatch(
      /r: __reactreStateSpawnRestore\(effects\.l\(__reactreStateRun\(\[.*\], effects\.d\(\[effects\.q, (emit\.q, )?spawn\.q\]\)\)\)\)/,
    );
    expect(code).toContain(RESTORE);
    expect(code).toContain("effects.w([children, spawn, persist])");
  });

  test("off: without persist, spawn's own wrap, and no restoreActor for spawn", async () => {
    const source = await Bun.file(new URL("./fixture.ts", import.meta.url)).text();
    const code =
      compile(
        "fixture.ts",
        source
          .replace('import { persist } from "@reactre/state/persist";\n', "")
          .replace("use: [children, effects, spawn, persist]", "use: [children, effects, spawn]"),
      )?.code ?? "";
    expect(code).toMatch(/r: spawn\.w\(effects\.l\(/);
    expect(code).not.toContain("spawn/restore");
  });

  test("a spawned child inherits its parent's clock, inspect, logger and system, with its path as its id", () => {
    let got: __Options | undefined;
    // A child whose lifecycle shows the options it was created with.
    const worker: __Compiled = {
      v: 0,
      e: {},
      i: () => to("working"),
      o: { working: {} },
      r: (_m, _move, _current, options) => {
        got = options;
        return { enter: () => {}, stop: () => {} };
      },
    };
    const now = () => 7;
    const inspect = { next: () => {} };
    const logger = () => {};
    const system = {};
    const inner: __Lifecycle = () => ({
      m: { v: 0, e: {}, i: () => to("open"), o: {}, sp: { worker } },
      works: new Map(),
      enter: () => {},
      stop: () => {},
    });
    const options = {
      now,
      inspect,
      logger,
      system,
      registryKey: "pool",
      parent: () => {},
      run: {},
      id: "root",
    } as unknown as __Options;
    const live = spawn.w(inner)(
      worker,
      (r) => r,
      () => ({ state: "open", data: {}, version: 0 }),
      options,
    );
    spawn.q["spawn"]?.({ type: "spawn", name: "worker", key: "a", input: { id: "a" } } as __Effect, {
      deliver: () => null,
      go: () => {},
      now,
      snapshot: { state: "open", data: {}, version: 0 },
      live,
    });
    expect(got).toMatchObject({ now, inspect, logger, system, input: { id: "a" }, id: "root/worker:a" });
    // Not what names the parent: its registry key, where it sends back, what it was restored from.
    expect(got).not.toHaveProperty("registryKey");
    expect(got).not.toHaveProperty("parent");
    expect(got).not.toHaveProperty("run");
  });

  test("transition() returns the spawn effects unrun, as data", () => {
    const { fx } = transition(poolMachine, createActor(poolMachine).snapshot(), { type: "add", id: "a" }) as {
      fx: readonly unknown[];
    };
    expect(fx).toEqual([
      { type: "spawn", name: "worker", key: "a", input: { id: "a" } },
      { type: "subscribeTo", name: "worker", key: "a", done: "finished" },
      { type: "listen", name: "worker", event: "progress", as: "progressed", key: "a" },
    ]);
  });

  test("a spawned child runs by name and key; its emitted events and its end come back as events", () => {
    const actor = createActor(poolMachine);
    actor.send({ type: "add", id: "a" });
    actor.send({ type: "add", id: "b" });
    const a = child(actor, "worker", "a");
    expect(a?.snapshot().data).toEqual({ id: "a", pct: 0 });
    a?.send({ type: "step", pct: 40 });
    expect(actor.snapshot().data).toEqual({ running: 2, done: "", pct: 40 });
    a?.send({ type: "finish" });
    expect(actor.snapshot().data).toEqual({ running: 1, done: "a", pct: 40 });
    // It ended, so it left.
    expect(child(actor, "worker", "a")).toBeUndefined();
    expect(child(actor, "worker", "b")?.status()).toBe("active");
  });

  test("enq.stop stops it, and so does the actor's stop; spawning a running key throws S40", () => {
    const actor = createActor(poolMachine);
    actor.send({ type: "add", id: "a" });
    actor.send({ type: "add", id: "b" });
    const a = child(actor, "worker", "a");
    actor.send({ type: "cancel", id: "a" });
    expect(a?.status()).toBe("stopped");
    expect(child(actor, "worker", "a")).toBeUndefined();
    expect(() => actor.send({ type: "add", id: "b" })).toThrow("S40");
    const b = child(actor, "worker", "b");
    actor.stop();
    expect(b?.status()).toBe("stopped");
  });

  test("a machine without the machines it may spawn (sp) throws S40, naming the fix", () => {
    const { sp: _machines, ...bare } = poolMachine as unknown as __Compiled;
    const actor = createActor(bare);
    // An event of the pool's, sent to its untyped table.
    const add = { type: "add", id: "a" };
    expect(() => actor.send(add)).toThrow(
      /S40\].*enq\.spawn\("worker"\) names no child this machine can spawn: add it to setup's children/,
    );
  });

  test("once its spawned children have all left, persist saves none", () => {
    const actor = createActor(poolMachine);
    actor.send({ type: "add", id: "a" });
    actor.send({ type: "cancel", id: "a" });
    const saved = JSON.parse(JSON.stringify(persist(actor)));
    expect(saved.run?.[""]?.s).toBeUndefined();
    const again = restoreActor(poolMachine, migrations(poolMachine)(saved));
    expect(again.snapshot().data).toEqual({ running: 0, done: "", pct: 0 });
    expect(child(again, "worker", "a")).toBeUndefined();
  });

  test("persist saves spawned children with their subscriptions, and restore brings both back", async () => {
    const actor = createActor(poolMachine);
    actor.send({ type: "add", id: "a" });
    child(actor, "worker", "a")?.send({ type: "step", pct: 70 });
    const saved = JSON.parse(JSON.stringify(persist(actor)));
    expect(saved.run[""].s).toEqual([
      {
        name: "worker",
        key: "a",
        snapshot: { state: "working", data: { id: "a", pct: 70 }, version: 0, run: {} },
        subs: { done: "finished" },
        listens: [{ event: "progress", as: "progressed" }],
      },
    ]);
    actor.stop();
    const again = restoreActor(poolMachine, migrations(poolMachine)(saved));
    const a = child(again, "worker", "a");
    expect(a?.snapshot().data).toEqual({ id: "a", pct: 70 });
    a?.send({ type: "step", pct: 90 });
    a?.send({ type: "finish" });
    await tick();
    expect(again.snapshot().data).toEqual({ running: 0, done: "a", pct: 90 });
  });
});
