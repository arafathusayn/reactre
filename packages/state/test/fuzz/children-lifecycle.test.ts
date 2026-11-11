// Child cancellation and restart, with an independent walk of the contract. The child input names
// its parent's entry, so "a new child" is observable, not inferred from a runner's internals. Source,
// dev and prod each execute the integration fixture; this file computes all expected outcomes itself.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Actor, Machine, Snapshot, Type } from "@reactre/state";
import { child } from "@reactre/state/children";

import { install, SCRATCH } from "./harness.ts";

type ParentShape = {
  readonly states: {
    readonly idle: Type<{ n: number }>;
    readonly busy: Type<{ n: number; seen: string }>;
    readonly finished: Type<{ n: number }>;
  };
  readonly events: { readonly go: Type<{}>; readonly cancel: Type<{}> };
  readonly "~children": { readonly job: { readonly machine: Machine<JobShape> } };
};
type JobShape = {
  readonly input: Type<{ id: string }>;
  readonly states: { readonly working: Type<{ id: string }>; readonly done: Type<{ id: string }> };
  readonly events: { readonly finish: Type<{}> };
  readonly internal: { readonly started: Type<{}> };
};
type Parent = Machine<ParentShape>;

const types = ["src", "dev", "prod"] as const;

/** Events that can observe an absent child as well as animate a live one. */
type Event = { readonly type: "go" | "cancel" } | { readonly finish: true; readonly missing?: boolean };

/** The compiled table, after the same public entry the integration fixture exports. */
type Page = Snapshot<ParentShape>;
function data(snapshot: Page | ReturnType<Actor<ParentShape>["snapshot"]>): { readonly n: number } {
  if (snapshot.data && typeof snapshot.data === "object" && "n" in snapshot.data && typeof snapshot.data.n === "number")
    return { n: snapshot.data.n };
  throw new Error(`missing entry number in ${snapshot.state}`);
}

/** What the contract gives: idle, busy with a new child per go, or finished. */
function model(events: readonly Event[]): { state: string; n: number; started: string[] }[] {
  let state = "idle";
  let n = 0;
  const started: string[] = [];
  return events.map((event) => {
    if ("type" in event) {
      if (event.type === "go" && state === "idle") {
        state = "busy";
        n++;
        started.push(`start job-${n}`);
      } else if (event.type === "cancel" && state === "busy") state = "idle";
    } else if (event.missing !== true && state === "busy") state = "finished";
    return { state, n, started: [...started] };
  });
}

/** Register the fixture at three paths through the real source/dev/prod compiler plugins. */
async function variants(): Promise<string[]> {
  install();
  await mkdir(SCRATCH, { recursive: true });
  const link = join(SCRATCH, "node_modules", "@reactre", "state");
  if (!existsSync(link)) {
    await mkdir(join(SCRATCH, "node_modules", "@reactre"), { recursive: true });
    await symlink(join(import.meta.dir, "..", ".."), link);
  }
  const fixture = join(import.meta.dir, "..", "integration", "fixtures", "children", "lifecycle.ts");
  const text = await readFile(fixture, "utf8");
  // The source text is in each filename: no distinct machine is ever served from a stale module cache.
  const hash = Bun.hash(text).toString(16);
  const paths: string[] = [];
  for (const type of types) {
    const file = join(SCRATCH, `child-lifecycle-${type}-${hash}.ts`);
    await writeFile(file, text);
    paths.push(file);
  }
  return paths;
}

async function run(file: string, events: readonly Event[]): Promise<ReturnType<typeof model>> {
  const { createActor } = await import("@reactre/state");
  const { parentMachine: machine, log } = (await import(file)) as {
    parentMachine: Parent;
    log: string[];
  };
  log.length = 0;
  const actor = createActor(machine);
  const out: ReturnType<typeof model> = [];
  for (const event of events) {
    if ("type" in event) actor.send({ type: event.type });
    else {
      const found = child(actor, "job");
      expect(found !== undefined, `child exists: ${JSON.stringify(event)}`).toBe(event.missing !== true);
      found?.send({ type: "finish" });
    }
    // Child start tasks resolve on the host; an already-final child reports through a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = actor.snapshot();
    out.push({ state: snapshot.state, n: data(snapshot).n, started: [...log] });
  }
  actor.stop();
  return out;
}

describe("children: cancel, restart, finish and absence agree with a hand-written contract", () => {
  test("cancel drops the child, a new go creates a new entry, and its old handle is stopped", async () => {
    const events: Event[] = [
      { type: "go" },
      { type: "cancel" },
      { finish: true, missing: true },
      { type: "go" },
      { finish: true },
    ];
    const expected = model(events);
    const paths = await variants();
    for (const [i, path] of paths.entries()) expect(await run(path, events), types[i]).toEqual(expected);
  });

  test("completion ends the parent, and further cancellation or child sends have no effect", async () => {
    const events: Event[] = [
      { type: "go" },
      { type: "cancel" },
      { type: "go" },
      { finish: true },
      { type: "cancel" },
      { finish: true, missing: true },
    ];
    const expected = model(events);
    const paths = await variants();
    for (const [i, path] of paths.entries()) expect(await run(path, events), types[i]).toEqual(expected);
  });

  test("children cannot be addressed before the parent enters their owner", async () => {
    const events: Event[] = [
      { finish: true, missing: true },
      { type: "go" },
      { type: "cancel" },
      { finish: true, missing: true },
      { type: "go" },
      { type: "go" },
    ];
    const expected = model(events);
    const paths = await variants();
    for (const [i, path] of paths.entries()) expect(await run(path, events), types[i]).toEqual(expected);
  });
});
