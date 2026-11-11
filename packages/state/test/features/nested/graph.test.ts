// @reactre/state/graph: paths through a machine, walked with the pure initial and transition.

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

const { getAdjacencyMap, getPathsFromEvents, getShortestPaths, getSimplePaths, toDirectedGraph } =
  await import("@reactre/state/graph");
const { jobMachine } = await import("../tags/machines.ts");
const { studioMachine } = await import("../parallel/machines.ts");

// save takes a text: traversal sends its samples (a type error without them).
const events = { save: [{ text: "a" }] } as const;
const states = (paths: readonly { readonly state: { readonly state: string } }[]) => paths.map((p) => p.state.state);

describe("graph", () => {
  test("getShortestPaths: one path to each state, the shortest", () => {
    const paths = getShortestPaths(jobMachine, { events });
    expect(states(paths)).toEqual(["idle", "work.saving", "work.retrying", "saved"]);
    const saved = paths.find((p) => p.state.state === "saved");
    expect(saved?.steps.map((s) => s.event.type)).toEqual(["save", "ok"]);
    expect(saved?.weight).toBe(2);
  });

  test("getSimplePaths: every path that visits no state twice", () => {
    const toSaved = getSimplePaths(jobMachine, { events, toState: (s) => s.state === "saved" });
    expect(toSaved.map((p) => p.steps.map((s) => s.event.type))).toEqual([
      ["save", "fail", "ok"],
      ["save", "ok"],
    ]);
  });

  test("getPathsFromEvents: the path the events take, skipping one that doesn't move", () => {
    const paths = getPathsFromEvents(
      jobMachine,
      [{ type: "save", text: "a" }, { type: "save", text: "b" }, { type: "fail" }],
      {
        events,
      },
    );
    expect(states(paths)).toEqual(["idle", "work.saving", "work.retrying"]);
    expect(paths.at(-1)?.steps.map((s) => s.event.type)).toEqual(["save", "fail"]);
  });

  test("getAdjacencyMap: each state, and each event's step from it", () => {
    const map = getAdjacencyMap(jobMachine, { events });
    expect(Object.keys(map)).toHaveLength(4);
    const idle = Object.values(map).find((n) => n.state.state === "idle");
    expect(Object.values(idle?.transitions ?? {}).map((t) => t.state.state)).toEqual(["work.saving"]);
  });

  test("toDirectedGraph: the node tree, with the edges the traversal found", () => {
    const graph = toDirectedGraph(jobMachine, { events });
    expect(graph.children.map((c) => c.id)).toEqual(["idle", "work", "saved"]);
    expect(graph.children[1]?.children.map((c) => c.id)).toEqual(["work.saving", "work.retrying"]);
    expect(graph.children[0]?.edges).toEqual([{ source: "idle", target: "work.saving", label: "save" }]);
    expect(graph.children[2]?.edges).toEqual([]);
    expect(graph.children[1]?.children[0]?.edges).toEqual([
      { source: "work.saving", target: "work.retrying", label: "fail" },
      { source: "work.saving", target: "saved", label: "ok" },
    ]);
  });

  test("a parallel machine: states are units, and stopWhen and limit bound the walk", () => {
    const all = getShortestPaths(studioMachine, { events: { play: [{ title: "t" }] } });
    expect(new Set(states(all))).toEqual(new Set(["off", "on"]));
    expect(all.length).toBeGreaterThan(5);
    expect(
      getShortestPaths(studioMachine, { events: { play: [{ title: "t" }] }, stopWhen: (s) => s.state === "on" }),
    ).toHaveLength(2);
    expect(getShortestPaths(studioMachine, { events: { play: [{ title: "t" }] }, limit: 3 })).toHaveLength(3);
    const map = getAdjacencyMap(studioMachine, { events: { play: [{ title: "t" }] }, limit: 3 });
    expect(Object.keys(map)).toHaveLength(3);
    for (const { transitions } of Object.values(map))
      for (const step of Object.values(transitions))
        expect(Object.values(map).map((n) => n.state)).toContainEqual(step.state);
  });
});
