// children + persist: the machine's children save and restore in the app's persisted snapshot. The
// compiler gives the machine the children runner that also restores and saves (an import of its
// own, @reactre/state/children/saved) in place of children's plain one, only when persist is in use.
// The runner itself is tested in test/actors.test.ts on hand-written tables; this file pins what
// the compiler emits, and that the emitted app runs and restores.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { PAGE } from "../../sources.ts";

const SAVED = 'import { __actorsSaved as __reactreStateChildrenSaved } from "@reactre/state/children/saved";';

/** PAGE with persist in use: its shape's hash, and the persist import. */
const PERSISTED = PAGE.replace(
  'import { children } from "@reactre/state/children";',
  'import { children } from "@reactre/state/children";\nimport { persist } from "@reactre/state/persist";',
).replace("use: [children],", 'use: [children, persist],\n  shape: "x6ja2u07",');

describe("children, with persist", () => {
  test("the node's children go in c, and the runner that saves them is imported, in place of children's own", () => {
    const code = compile("page.ts", PERSISTED)?.code ?? "";
    expect(code).toContain('c: { "busy": { "job": { m: childMachine, ');
    expect(code).toContain("r: __reactreStateRun([__reactreStateChildrenSaved])");
    expect(code).toContain(SAVED);
    // The plain runner isn't there too: one import, one runner.
    expect(code).not.toContain("children.r");
    expect(code.split(SAVED)).toHaveLength(2);
  });

  test("without persist, the plain runner runs them and nothing of the saving path is imported", () => {
    const code = compile("page.ts", PAGE)?.code ?? "";
    expect(code).toContain("r: __reactreStateRun([children.r])");
    expect(code).not.toContain("children/saved");
    expect(code).not.toContain("__reactreStateChildrenSaved");
  });

  test("the persisted machine runs, saves a child's snapshot under its node, and restores it", async () => {
    await import("../../compiled.ts");
    const { createActor, restoreActor } = await import("@reactre/state");
    const { child } = await import("@reactre/state/children");
    const { migrations, persist } = await import("@reactre/state/persist");
    const { pageMachine } = await import("./persisted.ts");

    const actor = createActor(pageMachine);
    actor.send({ type: "go" });
    const job = child(actor, "job", "a");
    expect(job?.snapshot().state).toBe("working");
    // The saved snapshot carries the child's run by node and runner id, under the parent's node.
    const saved = persist(actor);
    expect(saved.run).toEqual({ busy: { c: { job: { a: { state: "working", data: {}, version: 0, run: {} } } } } });

    actor.stop();
    const restored = restoreActor(pageMachine, migrations(pageMachine)(JSON.parse(JSON.stringify(saved))));
    expect(child(restored, "job", "a")?.snapshot().state).toBe("working");
    restored.stop();
  });
});
