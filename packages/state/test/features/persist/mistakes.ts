// persist's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. The opt-in, 63; then migrations and processEvent.

import { createActor, type NeedsOptIn, setup, type Type, types } from "@reactre/state";
import { migrations, persist, processEvent } from "@reactre/state/persist";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), done: types<{}>() };

// The correct machine: with persist in use, `persist(actor)` saves its timers' deadlines.
export const saved = setup({ use: [persist], states, events: {} }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { after: { "1s": ({ to }) => to("done") } }, done: { final: true } },
});
persist(createActor(saved));

const unsaved = setup({ states, events: {} }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { after: { "1s": ({ to }) => to("done") } }, done: { final: true } },
});
// @ts-expect-error 63. persist(actor) without persist in use: the error names the import.
persist(createActor(unsaved));
expect<
  Equal<
    NeedsOptIn<{ states: { idle: Type<{}> }; events: {} }, "persist", "persist(actor)">,
    {
      readonly 'persist(actor) needs persist: add persist to setup\'s use (import { persist } from "@reactre/state/persist")': never;
    }
  >
>();

// @ts-expect-error migrations(machine) and processEvent(...) without persist in use: the same fix.
migrations(unsaved);
// @ts-expect-error
processEvent(unsaved, undefined, { type: "x" });

// A machine at version 2, whose version 1 had `count` where it has `items`.
const cart = setup({
  use: [persist],
  version: 2,
  input: types<{ id: string }>(),
  states: { open: types<{ id: string; items: number }>(), closed: types<{ id: string }>() },
  events: { close: types<{}>() },
});
const cartMachine = cart.machine({
  start: ({ input, to }) => to("open", { id: input.id, items: 0 }),
  states: { open: { on: { close: ({ data, to }) => to("closed", { id: data.id }) } }, closed: { final: true } },
});
type V1 = { open: { id: string; count: number }; closed: { id: string } };

// The correct migration: each step builds the next version's snapshot with that version's `to`.
migrations(cartMachine)
  .from<1, V1>(({ state, data, to }) =>
    state === "open" ? to("open", { id: data.id, items: data.count }) : to("closed", { id: data.id }),
  )
  .from<0, { cart: { id: string } }>(({ data, to }) => to("open", { id: data.id, count: 0 }));

// A step that skips a version: they go one at a time, newest first.
// @ts-expect-error the step from version 0 before the one from version 1
migrations(cartMachine).from<0, V1>(({ data, to }) => to("closed", { id: data.id }));
const first = migrations(cartMachine);
expect<
  Equal<
    Parameters<typeof first.from<0, V1>>[0],
    "migrations go one version at a time, newest first: after the step to version 2, the next is .from<1, { ...its states }>(...)"
  >
>();

// A step whose data the next version's state doesn't take: exact, as in a transition.
migrations(cartMachine).from<1, V1>(({ data, to }) =>
  // @ts-expect-error a field the state lacks (version 1's name for it)
  to("open", { id: data.id, items: 0, count: data.count }),
);
migrations(cartMachine).from<1, V1>(({ data, to }) =>
  // @ts-expect-error a field the state needs, missing
  to("open", { id: data.id }),
);
migrations(cartMachine).from<1, V1>(({ data, to }) =>
  // @ts-expect-error a state the next version doesn't have
  to("cart", { id: data.id }),
);
// @ts-expect-error a field the old version's state doesn't have
migrations(cartMachine).from<1, V1>(({ data, to }) => to("closed", { id: data.name }));

// A machine without a version is at version 0: nothing is older.
const plain = setup({ use: [persist], states, events: {} }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { after: { "1s": ({ to }) => to("done") } }, done: { final: true } },
});
const none = migrations(plain);
expect<
  Equal<Parameters<typeof none.from<0, {}>>[0], "version 0 is the first: there is no version before it to migrate from">
>();

// processEvent takes the machine's events, and its input when it takes one.
processEvent(cartMachine, undefined, { type: "close" }, { input: { id: "a" } });
// @ts-expect-error an event the machine doesn't have
processEvent(cartMachine, undefined, { type: "open" }, { input: { id: "a" } });
// @ts-expect-error no input, for a machine that takes one
processEvent(cartMachine, undefined, { type: "close" });

// The second round's rows, by their M#.
declare const row: { readonly snapshot: string };
// @ts-expect-error M559. The stored JSON text, unparsed: JSON.parse it first.
processEvent(cartMachine, row.snapshot, { type: "close" }, { input: { id: "a" } });
// @ts-expect-error M559. migrate, the same.
migrations(cartMachine)(row.snapshot);
// @ts-expect-error M560. The old version's states typed any: write their data types.
migrations(cartMachine).from<1, any>(({ data, to }) => to("closed", { id: data.id }));
const saver = setup({
  use: [persist],
  states: { idle: types<{}>(), saving: types<{}>(), done: types<{}>() },
  events: { save: types<{}>(), cancel: types<{}>() },
  internal: { stored: types<{}>() },
}).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ to }) => to("saving") } },
    saving: {
      task: { run: ({ signal }) => posted(signal, "stored"), error: ({ to }) => to("idle") },
      on: { stored: ({ to }) => to("done"), cancel: ({ to }) => to("idle") },
    },
    done: { final: true },
  },
});
// @ts-expect-error M561. processEvent can't run a task: the request ends, and aborts it.
processEvent(saver, undefined, { type: "save" });
import { restoreActor } from "@reactre/state";
// @ts-expect-error M574. One machine's snapshot restored into another: a snapshot's type is its machine's.
restoreActor(cartMachine, migrations(saved)({}));

// What the tasks above call (M461: a task does its work, so none is a stub).
import { posted } from "../../fixtures/service.ts";
