// Children, generated: a parent whose `busy` node runs a keyed collection of child actors, each a
// small machine that finishes on an event. The parent is compiled three ways (source through the
// plugin, dev, prod) and the three must agree on every observable, step by step: the parent's state
// and data, and each child's state.
//
// The expectation is independent of the compiler: the model here says what a keyed collection does
// (each key starts in the child's start state, an event the child handles moves it, a child in a
// final state reports `done` to the parent, and the parent's `done` moves it), and the three
// compiled runs are compared with it. The model is small on purpose: children are a runtime
// feature, and the point is that the compiler's three outputs agree with a hand-written account of
// the contract, not that a second interpreter exists.

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Actor, Machine, Type } from "@reactre/state";
import { child, type children } from "@reactre/state/children";

import { compile } from "../../compiler/index.ts";
import { statePreload } from "../../plugin/runtime.ts";

/** What `use: [children]` gives a shape. */
type Uses = { use: readonly [typeof children] };
/** The child's shape. */
type WorkerShape = {
  states: { working: Type<{}>; finished: Type<{ url: string }> };
  events: { finish: Type<{ url: string }> };
};
/** The parent's shape, as the generated source writes it: the states, events and child. */
type PageShape = Uses & {
  states: { idle: Type<{}>; busy: Type<{ files: string[]; seen: string }>; done: Type<{ url: string }> };
  events: { go: Type<{}>; cancel: Type<{}>; finish: Type<{ url: string }> };
  "~children": { job: { machine: Machine<WorkerShape>; each: unknown } };
};
/** The parent's machine, as the generated module exports it. */
type PageMachine = Machine<PageShape>;

const SCRATCH = join(import.meta.dir, "..", "..", "..", "..", ".fuzz-out");

/** A parent with a keyed child collection: `idle` -> `busy` (children) -> `done`. */
function source(keys: readonly string[]): string {
  return `import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";

const worker = setup({
  states: { working: types<{}>(), finished: types<{ url: string }>() },
  events: { finish: types<{ url: string }>() },
});
export const childMachine = worker.machine({
  start: ({ to }) => to("working"),
  states: { working: { on: { finish: ({ event, to }) => to("finished", { url: event.url }) } }, finished: { final: true } },
});

const page = setup({
  use: [children],
  states: { idle: types<{}>(), busy: types<{ files: string[]; seen: string }>(), done: types<{ url: string }>() },
  events: { go: types<{}>(), cancel: types<{}>(), finish: types<{ url: string }>() },
  children: { job: childMachine },
});
export const pageMachine = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { files: ${JSON.stringify(keys)}, seen: "" }) } },
    busy: {
      on: { cancel: ({ to }) => to("idle") },
      children: {
        job: {
          each: ({ data }) => data.files.map((f) => ({ key: f, input: undefined })),
          done: ({ output, to }) => to("done", { url: output.data.url }),
          update: ({ data, child, to }) => to("busy", { ...data, seen: child.state }),
        },
      },
    },
    done: { final: true },
  },
});
`;
}

/** What the model says a run does: the parent's state and data, and each child's state. */
interface ModelStep {
  readonly state: string;
  readonly data: unknown;
  readonly children: { readonly [key: string]: string };
}

/**
 * A step of the walk: an event to the parent, or a `finish` to one child by key (a child is an
 * actor of its own: the parent's `send` does not reach it).
 */
type WalkEvent =
  | { readonly to: "parent"; readonly type: "go" | "cancel" }
  | { readonly to: "child"; readonly key: string; readonly url: string; readonly missing?: boolean };

/**
 * The model: `go` enters `busy` with one child per key, each in `working`; a `finish` to a child
 * moves that child to `finished`, and the first child to finish reports `done`, which moves the
 * parent to `done` with that child's url. A child that has finished takes no more events, and a
 * parent in `done` takes none.
 */
function model(keys: readonly string[], events: readonly WalkEvent[]): ModelStep[] {
  const steps: ModelStep[] = [];
  let state = "idle";
  let data: unknown = {};
  const children: { [key: string]: string } = {};
  for (const event of events) {
    if (event.to === "parent") {
      if (event.type === "go" && state === "idle") {
        state = "busy";
        data = { files: [...keys], seen: "" };
        for (const key of keys) children[key] = "working";
      } else if (event.type === "cancel" && state === "busy") {
        state = "idle";
        data = {};
        for (const key of keys) delete children[key];
      }
    } else if (state === "busy" && children[event.key] === "working") {
      children[event.key] = "finished";
      // The first child to finish reports `done`, which moves the parent. Leaving `busy` stops the
      // node's children, so none of them is running after the move.
      state = "done";
      data = { url: event.url };
      for (const key of keys) delete children[key];
    }
    steps.push({ state: state === "done" ? "done" : state, data, children: { ...children } });
  }
  return steps;
}

/** The compiled machine's steps, through an actor: the parent's snapshot and each child's state. */
async function run(machine: PageMachine, events: readonly WalkEvent[]): Promise<ModelStep[]> {
  const { createActor } = await import("@reactre/state");
  const actor: Actor<PageShape> = createActor(machine);
  const steps: ModelStep[] = [];
  for (const event of events) {
    if (event.to === "parent") actor.send({ type: event.type });
    else {
      const found = child(actor, "job", event.key);
      expect(found !== undefined, `child ${event.key} exists`).toBe(!event.missing);
      found?.send({ type: "finish", url: event.url });
    }
    // A child's `done` is reported in a microtask when it starts already final, and synchronously
    // otherwise; a tick lets either land before the step is read.
    await new Promise((r) => setTimeout(r, 0));
    const snapshot = actor.snapshot();
    const children: { [key: string]: string } = {};
    // The keys are the `busy` state's `files`; another state's data has none.
    const files = "files" in snapshot.data ? snapshot.data.files : [];
    for (const key of files) {
      const kid = child(actor, "job", key);
      if (kid !== undefined) children[key] = kid.snapshot().state;
    }
    steps.push({ state: snapshot.state, data: snapshot.data, children });
  }
  actor.stop();
  return steps;
}

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  mkdirSync(join(SCRATCH, "node_modules", "@reactre"), { recursive: true });
  try {
    symlinkSync(join(import.meta.dir, "..", ".."), join(SCRATCH, "node_modules", "@reactre", "state"));
  } catch {
    // Already there.
  }
  const preload = statePreload({ filter: /\.fuzz-out\/.*-src-[0-9a-f]+\.ts$/ });
  Bun.plugin({ name: preload.name, setup: (build) => preload.setup(build) });
  Bun.plugin({
    name: "@reactre/state (fuzz children)",
    setup(build) {
      build.onLoad({ filter: /\.fuzz-out\/.*-(dev|prod)-[0-9a-f]+\.ts$/ }, async ({ path }) => {
        const text = await Bun.file(path).text();
        const dev = /-dev-[0-9a-f]+\.ts$/.test(path);
        const out = compile(path, text, { dev });
        if (out === null) throw new Error(`the children fixture ${path} didn't compile`);
        return { contents: out.code, loader: "ts" };
      });
    },
  });
}

/** A short, stable hash of `text` (FNV-1a), for a fixture's file name. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function load(keys: readonly string[], variant: "src" | "dev" | "prod"): Promise<PageMachine> {
  install();
  const text = source(keys);
  const file = join(SCRATCH, `children-${variant}-${hash(text)}.ts`);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(file, text);
  const module: { pageMachine: PageMachine } = await import(file);
  return module.pageMachine;
}

describe("children: source, dev and prod agree with the model", () => {
  test("a keyed collection starts, finishes and reports done, the same three ways", async () => {
    const keys = ["a", "b", "c"];
    const events: WalkEvent[] = [
      { to: "parent", type: "go" },
      { to: "child", key: "b", url: "u1" },
      { to: "child", key: "a", url: "u2", missing: true },
      { to: "child", key: "c", url: "u3", missing: true },
    ];
    const expected = model(keys, events);
    const failures: string[] = [];
    for (const variant of ["src", "dev", "prod"] as const) {
      const actual = await run(await load(keys, variant), events);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        failures.push(`${variant}:\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test("cancelling drops the whole collection, and going again starts fresh children", async () => {
    const keys = ["a", "b"];
    const events: WalkEvent[] = [
      { to: "parent", type: "go" },
      { to: "parent", type: "cancel" },
      { to: "child", key: "a", url: "stale", missing: true },
      { to: "parent", type: "go" },
      { to: "child", key: "b", url: "fresh" },
      { to: "parent", type: "cancel" },
      { to: "child", key: "a", url: "stale", missing: true },
    ];
    const expected = model(keys, events);
    for (const variant of ["src", "dev", "prod"] as const)
      expect(await run(await load(keys, variant), events), `${variant}: ${JSON.stringify(expected)}`).toEqual(expected);
  }, 60_000);

  test("an empty collection enters and leaves without a child", async () => {
    const keys: string[] = [];
    const events: WalkEvent[] = [{ to: "parent", type: "go" }];
    const expected = model(keys, events);
    const failures: string[] = [];
    for (const variant of ["src", "dev", "prod"] as const) {
      const actual = await run(await load(keys, variant), events);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        failures.push(`${variant}:\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

// The scratch folder is shared with the other fuzz files; this one leaves it for their cleanup.
export { SCRATCH as CHILDREN_SCRATCH };
