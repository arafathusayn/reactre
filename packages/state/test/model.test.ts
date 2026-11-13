// @reactre/state/test: model-based testing. A hand-written cart is checked against the cart machine
// (./model/cart.ts, compiled by the plugin): every shortest path, every simple path, random runs,
// and a broken cart whose divergence is reported with the steps to it.

import { describe, expect, test } from "bun:test";

import "./compiled.ts";

const { modelPaths, propertyTest, testPaths } = await import("@reactre/state/test");
const { cartMachine } = await import("./model/cart.ts");

/** The implementation under test: a plain object, no machine. */
function createCart(broken = false) {
  const items = new Map<string, number>();
  let done = false;
  return {
    add: (sku: string) => void items.set(sku, (items.get(sku) ?? 0) + 1),
    remove: (sku: string) => void (broken ? items.has(sku) && items.set(sku, 0) : items.delete(sku)),
    checkout: () => void (done = items.size > 0),
    read: () => ({ lines: [...items].map(([sku, n]) => ({ sku, n })), done }),
  };
}

const sut = (broken = false) => ({
  create: () => {
    const cart = createCart(broken);
    return {
      send: (event: { readonly type: string; readonly sku?: string }) => {
        if (event.type === "add" && event.sku !== undefined) cart.add(event.sku);
        if (event.type === "remove" && event.sku !== undefined) cart.remove(event.sku);
        if (event.type === "checkout") cart.checkout();
      },
      read: cart.read,
    };
  },
  project: (s: { readonly state: string; readonly data: { readonly lines: readonly unknown[] } }) => ({
    lines: s.data.lines,
    done: s.state !== "shopping",
  }),
});

const events = { add: [{ sku: "apple" }, { sku: "pear" }], remove: [{ sku: "apple" }] } as const;
// Quantities grow without bound: stop expanding a cart with 2 of anything.
const stopWhen = (s: { readonly data: { readonly lines: readonly { readonly n: number }[] } }) =>
  s.data.lines.some((l) => l.n >= 2);

describe("modelPaths", () => {
  test("the shortest path to each distinct snapshot, from transition alone", () => {
    const paths = modelPaths(cartMachine, { events, stopWhen });
    expect(paths[0]).toEqual({ snapshot: { state: "shopping", data: { lines: [] }, version: 0 }, steps: [] });
    expect(paths.every((p, i) => i === 0 || p.steps.length >= (paths[i - 1]?.steps.length ?? 0))).toBe(true);
    const states = new Set(paths.map((p) => p.steps.at(-1)?.snapshot.state ?? "shopping"));
    // `priced` isn't listed, so no path reaches checkedOut: a task's result is listed to be walked.
    expect([...states]).toEqual(["shopping", "pricing"]);
    const priced = modelPaths(cartMachine, { events: { ...events, priced: [{ total: 1 }] }, stopWhen });
    expect(priced.some((p) => p.steps.at(-1)?.snapshot.state === "checkedOut")).toBe(true);
  });

  test("simple paths visit no snapshot twice, so removing leads somewhere already seen only on another path", () => {
    const simple = modelPaths(cartMachine, { events, stopWhen, paths: "simple", depth: 3 });
    const shortest = modelPaths(cartMachine, { events, stopWhen, depth: 3 });
    expect(simple.length).toBeGreaterThan(shortest.length);
    expect(simple.some((p) => p.steps.some((s) => s.event.type === "remove"))).toBe(true);
    for (const p of simple) {
      const keys = p.steps.map((s) => JSON.stringify(s.snapshot));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("testPaths and propertyTest", () => {
  test("a cart that keeps to the model passes every path, with coverage", async () => {
    const result = await testPaths(cartMachine, { events, stopWhen, sut: sut() });
    expect(result.paths).toBeGreaterThan(3);
    expect(result.coverage.states).toEqual({ covered: ["shopping", "pricing"], uncovered: ["checkedOut"] });
    expect(result.coverage.transitions).toContain("shopping --checkout--> pricing");
    const random = await propertyTest(cartMachine, { events, sut: sut(), runs: 20, seed: 7 });
    expect(random).toMatchObject({ paths: 20 });
  });

  test("a broken cart diverges, and the error lists the steps to it", async () => {
    // Shortest paths never remove: an emptied cart is a snapshot already reached. Simple paths do.
    expect((await testPaths(cartMachine, { events, stopWhen, sut: sut(true) })).paths).toBeGreaterThan(3);
    const run = testPaths(cartMachine, { events, stopWhen, paths: "simple", sut: sut(true) });
    // A simple path doesn't come back to the empty cart, so the first remove that diverges is the
    // third step: apple, pear, then apple out.
    await expect(run).rejects.toThrow(
      /S27\] the implementation diverged from the machine at step 3 \(path \d+ of \d+\):/,
    );
    await expect(run).rejects.toThrow(
      /1\. \{"sku":"apple","type":"add"\} -> .*\n2\. \{"sku":"pear","type":"add"\} -> .*\n3\. \{"sku":"apple","type":"remove"\} -> .*\n   diverged\n     model:    \{"lines":\[\{"sku":"pear","n":1\}\],"done":false\}\n     observed: \{"lines":\[\{"sku":"apple","n":0\},\{"sku":"pear","n":1\}\],"done":false\}/,
    );
    await expect(propertyTest(cartMachine, { events, sut: sut(true), seed: 3 })).rejects.toThrow(/S27\].*seed 3/);
  });
});

describe("types", () => {
  test("samples are required for each event with a payload", () => {
    // @ts-expect-error `add` and `remove` take a sku: list their samples
    expect(() => modelPaths(cartMachine, { events: {} })).not.toThrow();
    // @ts-expect-error a sample is the payload, typed
    modelPaths(cartMachine, { events: { add: [{ sku: 1 }], remove: [] } });
  });
});
