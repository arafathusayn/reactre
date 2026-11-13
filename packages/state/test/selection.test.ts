import { expect, test } from "bun:test";

import { effect, onCleanup, signal } from "@reactre/core";
import { createRoot } from "@reactre/core/features/owner";

import { createActor, type Machine, type Type } from "../src/index.ts";
import { select, type Selection } from "../src/utils/select.ts";
import { to } from "./to.ts";

type Shape = {
  states: { off: Type<{}>; on: Type<{ n: number }> };
  events: { flip: Type<{}> };
};
const machine: Machine<Shape> = {
  v: 0,
  e: { flip: 1 },
  i: () => to("off"),
  o: { off: { flip: () => to("on", { n: 1 }) }, on: { flip: () => to("off") } },
};

test("selection deliveries preserve Object.is and explicit comparison semantics", () => {
  const actor = createActor(machine);
  const nan = select(actor, () => NaN);
  const zeros = select(actor, (s) => (s.state === "off" ? 0 : -0));
  const always = select(
    actor,
    () => 1,
    () => false,
  );
  const seen: number[] = [],
    repeated: number[] = [];
  let nanCalls = 0;
  nan.subscribe(() => nanCalls++);
  zeros.subscribe((n) => seen.push(n));
  always.subscribe((n) => repeated.push(n));
  actor.send({ type: "flip" });
  actor.send({ type: "flip" });
  expect(nanCalls).toBe(0);
  expect(seen).toEqual([-0, 0]);
  expect(repeated).toEqual([1, 1]);
  actor.stop();
});

test("shared selection caches work, retains equal objects, and keeps subscribers independent", () => {
  const actor = createActor(machine);
  let calls = 0;
  const selection = select(
    actor,
    (s) => {
      calls++;
      return { active: s.state === "on" };
    },
    (a, b) => a.active === b.active,
  );
  const first = selection.get();
  const a: boolean[] = [],
    b: boolean[] = [];
  const offA = selection.subscribe((v) => a.push(v.active));
  const offB = selection.subscribe((v) => b.push(v.active));
  expect(selection.get()).toBe(first);
  expect(calls).toBe(1);
  actor.send({ type: "flip" });
  expect(calls).toBe(2);
  offA();
  offA();
  actor.send({ type: "flip" });
  expect(a).toEqual([true]);
  expect(b).toEqual([true, false]);
  offB();
  actor.send({ type: "flip" });
  expect(calls).toBe(3);
  expect(selection.get()).toEqual({ active: true });
  expect(calls).toBe(4);
  actor.stop();
});

// The documented composition: the wrapper preserves select's equality semantics, which can
// differ from core signal's ===. Function-valued selections remain values, never updater calls.
function observe<T>(selection: Selection<T>): () => T {
  const [read, write] = signal({ value: selection.get() });
  onCleanup(selection.subscribe((value) => write({ value })));
  return () => read().value;
}

test("selected core observations unsubscribe per view and remount from the live external actor", () => {
  const actor = createActor(machine);
  const zero = select(actor, (s) => (s.state === "off" ? 0 : -0));
  const fnOff = () => "off",
    fnOn = () => "on";
  const functions = select(actor, (s) => (s.state === "off" ? fnOff : fnOn));
  const mount = () =>
    createRoot((dispose) => {
      const value = observe(zero),
        fn = observe(functions);
      const seen: number[] = [],
        seenFunctions: (() => string)[] = [];
      effect(() => {
        seen.push(value());
      });
      effect(() => {
        seenFunctions.push(fn());
      });
      return { dispose, value, fn, seen, seenFunctions };
    });
  const a = mount(),
    b = mount();
  actor.send({ type: "flip" });
  expect(a.seen).toEqual([0, -0]);
  expect(a.fn()).toBe(fnOn);
  a.dispose();
  for (let i = 0; i < 100; i++) actor.send({ type: "flip" });
  expect(a.seen).toHaveLength(2);
  expect(b.seen).toHaveLength(102);
  expect(actor.status()).toBe("active");
  const c = mount();
  expect(c.value()).toBe(-0);
  expect(c.seenFunctions).toEqual([fnOn]);
  b.dispose();
  c.dispose();
  actor.stop();
});

test("reentrant selection sends settle and reads observe the current snapshot", () => {
  const actor = createActor(machine);
  const selected = select(actor, (s) => (s.state === "on" ? s.data.n : 0));
  const first: number[] = [],
    second: number[] = [];
  selected.subscribe((n) => {
    first.push(n);
    if (n === 1) actor.send({ type: "flip" });
  });
  selected.subscribe((n) => second.push(n));
  actor.send({ type: "flip" });
  expect(first).toEqual([1, 0]);
  expect(second).toEqual([]);
  expect(selected.get()).toBe(0);
  actor.stop();
});
