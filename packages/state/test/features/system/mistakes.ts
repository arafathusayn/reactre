// system's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says.

import { setup, type Type, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createSystem, initialSystem, rootOf, system } from "@reactre/state/system";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const worker = setup({ states: { busy: types<{}>(), over: types<{}>() }, events: { end: types<{}>() } });
const workerMachine = worker.machine({
  start: ({ to }) => to("busy"),
  states: { busy: { on: { end: ({ to }) => to("over") } }, over: { final: true } },
});

// Opt-in. A child's registryKey without system in use: the value's expected type is the fix.
const off = setup({
  use: [children],
  states: { idle: types<{}>(), done: types<{}>() },
  events: { go: types<{}>() },
  children: { worker: workerMachine },
});
off.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      // @ts-expect-error "w" is not assignable to "registryKey needs system: add system to setup's use (…)".
      children: { worker: { registryKey: "w", done: ({ to }) => to("done") } },
      on: { go: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});

// With system in use, it is a string.
const on = setup({
  use: [children, system],
  states: { idle: types<{}>(), done: types<{}>() },
  events: { go: types<{}>() },
  children: { worker: workerMachine },
});
export const ok = on.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      children: { worker: { registryKey: "w", done: ({ to }) => to("done") } },
      on: { go: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});

// A declared registry types its keys and its actors.
const sys = createSystem({ registry: { worker: workerMachine } });
// @ts-expect-error "wroker" is not a key of the registry.
sys.get("wroker");
// @ts-expect-error The worker takes "end", not "stop".
sys.get("worker")?.send({ type: "stop" });
// @ts-expect-error A root's registryKey is one of the registry's keys.
sys.createActor(workerMachine, { registryKey: "wroker" });
sys.createActor(workerMachine, { registryKey: "worker" });
// @ts-expect-error M304. A machine cast to any: system.createActor's `this` is the fix, as the core's.
sys.createActor(workerMachine as any);

// Without a registry, any key, and an actor to narrow before sending.
const loose = createSystem();
// @ts-expect-error Its events are unknown: `send` takes never.
loose.get("anything")?.send({ type: "end" });

// The root of a system snapshot is typed by its machine.
const [s] = initialSystem(workerMachine);
expect<Equal<ReturnType<typeof rootOf<{ states: { busy: Type<{}> }; events: {} }>>["state"], "busy">>();
// @ts-expect-error "bsy" is not a state of the worker.
if (rootOf(s).state === "bsy") rootOf(s);
