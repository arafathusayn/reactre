import { expect, test } from "bun:test";
import "./compiled.ts";
import { immutableData } from "@reactre/state/data";

import type { Catalog } from "./data.types.ts";
const { migrations } = await import("@reactre/state/persist");
const { createActor, restoreActor } = await import("@reactre/state");
const { catalogMachine } = await import("./fixtures/catalog.ts");

test("plain SDK data is copied, recursively frozen and retains shared values without retaining mutable aliases", () => {
  const shared = { label: "first", tags: ["tag"] };
  const input: Catalog = { entries: { first: shared, second: shared } };
  const value = immutableData(input);
  expect(value).toEqual(input);
  expect(value).not.toBe(input);
  expect(value.entries.first).toBe(value.entries.second);
  expect(Object.hasOwn(value, "title")).toBe(false);
  shared.label = "mutated outside";
  shared.tags.push("outside");
  expect(value.entries.first).toEqual({ label: "first", tags: ["tag"] });
  expect(() => Object.assign(value.entries.first!, { label: "inside" })).toThrow(TypeError);
  expect(() => Reflect.set(value.entries, "third", shared)).not.toThrow();
  expect(Object.hasOwn(value.entries, "third")).toBe(false);
});

test("arrays, null, finite primitives, null-prototype records and own __proto__ data survive JSON", () => {
  const record: Record<string, number> = Object.create(null);
  Object.defineProperty(record, "__proto__", { value: 3, enumerable: true });
  const empty: number[] = [];
  const data = immutableData({ record, items: [1, 2], empty, nullable: null, flag: true, text: "ok" });
  expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  expect(Object.getPrototypeOf(data.record)).toBe(Object.prototype);
  expect(Object.hasOwn(data.record, "__proto__")).toBe(true);
  expect(data.record["__proto__"]).toBe(3);
  expect(Object.isFrozen(data.items)).toBe(true);
  expect(Object.isFrozen(data.record)).toBe(true);
});

test("actor input, events, old snapshots and JSON restoration retain structural payloads", () => {
  const original: Catalog = { entries: { a: { label: "A" } } };
  const actor = createActor(catalogMachine, { input: { value: immutableData(original) } });
  const before = actor.snapshot();
  actor.send({
    type: "replace",
    value: immutableData<Catalog>({ title: "new", entries: { b: { label: "B", tags: [] } } }),
  });
  expect(before.data).toEqual({ value: original });
  expect(actor.snapshot().data).toEqual({ value: { title: "new", entries: { b: { label: "B", tags: [] } } } });
  const saved = JSON.stringify(actor.snapshot());
  const restored = restoreActor(catalogMachine, migrations(catalogMachine)(JSON.parse(saved)));
  expect(restored.snapshot()).toEqual(actor.snapshot());
  expect(Object.isFrozen(restored.snapshot().data)).toBe(true);
  actor.stop();
  restored.stop();
});

test("runtime data validation rejects resources and lossy JSON values even from untyped callers", () => {
  const cycle: { self?: object } = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  const decorated = [1];
  Object.defineProperty(decorated, "extra", { value: 2, enumerable: true });
  const replaced = [1];
  delete replaced[0];
  Object.defineProperty(replaced, "01", { value: 2, enumerable: true });
  let getterReads = 0;
  const accessor = {
    get field() {
      getterReads++;
      return "value";
    },
  };
  for (const [value, message] of [
    [{ value: undefined }, "undefined"],
    [{ value: () => {} }, "function"],
    [{ value: 1n }, "bigint"],
    [{ value: Symbol() }, "symbol"],
    [{ value: NaN }, "finite"],
    [{ value: Infinity }, "finite"],
    [new Date(), "class or resource"],
    [new Map(), "class or resource"],
    [new Set(), "class or resource"],
    [cycle, "cycle"],
    [sparse, "sparse"],
    [decorated, "decorated"],
    [replaced, "non-index"],
    [{ [Symbol()]: 1 }, "symbol key"],
    [accessor, "data property"],
    [Object.defineProperty({}, "hidden", { value: 1 }), "data property"],
  ] as const) {
    // Invoke the public entry as untyped JS could; no assertion can make validation pass.
    expect(() => Reflect.apply(immutableData, undefined, [value])).toThrow(message);
  }
  expect(getterReads).toBe(0);
});

test("structural payloads retain compiler cast checks", async () => {
  const { compile } = await import("../compiler/index.ts");
  const source = `import { setup, types } from "@reactre/state";
    const s = setup({ states: { ready: types<{ value: { title?: string; entries: Record<string, string> } }>(), closed: types<{}>() },
      events: { replace: types<{ value: { title?: string; entries: Record<string, string> } }>(), close: types<{}>() } });
    export const machine = s.machine({ start: ({ to }) => to("ready", { value: { entries: {} } }), states: {
      ready: { on: { replace: ({ event, to }) => BODY, close: ({ to }) => to("closed") } }, closed: { final: true }
    } });`;
  expect(compile("payload.machine.ts", source.replace("BODY", 'to("ready", { value: event.value })'))).not.toBeNull();
  expect(() =>
    compile("payload.machine.ts", source.replace("BODY", 'to("ready", { value: event.value as any })')),
  ).toThrow();
});
