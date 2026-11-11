// persist's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). A migration's mistakes are type errors (./mistakes.ts), and a
// step's purity is the core's. What compiler/features/persist.ts checks is where and how the file
// stores snapshots: a migration not passed, one key for two machines, a save only on unload or
// outside a try, a restore of stored data outside a try, a plain snapshot that loses timers; and in
// setup's text, a secret in persisted data.

import { type Case, change, DOOR, JOB, withUse } from "../../sources.ts";

/** An app's storage of ./orders.ts's machine (persisted, with a timer), with `body` after it (line 14 on). */
export const store = (body: string): string => `import { createActor, restoreActor } from "@reactre/state";
import { migrations, persist, processEvent } from "@reactre/state/persist";
import { orderMachine } from "../features/persist/orders.ts";

const migrate = migrations(orderMachine).from<1, { open: { id: string; count: number }; closed: { id: string } }>(
  ({ state, data, to }) =>
    state === "open" ? to("open", { id: data.id, items: data.count }) : to("cancelled", { id: data.id }),
);

export function handle(stored: unknown) {
  return processEvent(orderMachine, stored, { type: "add" }, { input: { id: "o1" }, migrate });
}

export const actor = createActor(orderMachine, { input: { id: "o1" } });
${body}
`;

export const cases: Case[] = [
  [
    "M567: processEvent without the migrations the file defines",
    change(store(""), '{ input: { id: "o1" }, migrate }', '{ input: { id: "o1" } }'),
    11,
    'the stored value isn\'t migrated: `processEvent(orderMachine, stored, { type: "add" }, { migrate: migrate })`',
  ],
  [
    "M567: restoreActor of a stored value, without the file's migrations",
    store("export const restored = (saved: ReturnType<typeof migrate>) => restoreActor(orderMachine, saved);"),
    15,
    "the stored value isn't migrated: `restoreActor(orderMachine, migrate(saved))`",
  ],
  [
    "M568: a password in a persisted state's data",
    change(
      change(
        withUse(["persist"], DOOR),
        "open: types<{ by: string }>()",
        "open: types<{ by: string; password: string }>()",
      ),
      'to("open", { by: event.by })',
      'to("open", { by: event.by, password: "" })',
    ),
    7,
    "the persisted data holds `password`: keep it out of data, or don't persist the state",
  ],
  [
    "M569: one storage key for two machines' snapshots",
    store(`export const other = createActor(orderMachine, { input: { id: "o2" } });
export function save(): void {
  try {
    localStorage.setItem("state", JSON.stringify(persist(actor)));
    localStorage.setItem("state", JSON.stringify(persist(other)));
  } catch {
    // storage full: keep running
  }
}`),
    19,
    'the key "state" stores two machines: one key each',
  ],
  [
    "M570: saved only on beforeunload",
    store(`window.addEventListener("beforeunload", () => {
  try {
    localStorage.setItem("order", JSON.stringify(persist(actor)));
  } catch {
    // storage full: nothing to do as the page goes
  }
});`),
    17,
    "beforeunload doesn't fire on mobile: save on visibilitychange",
  ],
  [
    "M571: a save in a listener, outside a try",
    store('actor.subscribe(() => localStorage.setItem("order", JSON.stringify(persist(actor))));'),
    15,
    "localStorage.setItem throws when full or blocked: wrap it in try",
  ],
  [
    "M572: a restore of stored data outside a try",
    store(
      'export const restored = restoreActor(orderMachine, migrate(JSON.parse(localStorage.getItem("order") ?? "null")));',
    ),
    15,
    "restoring stored data outside try: a bad value stops the app; catch it and start fresh",
  ],
  [
    "M573: the plain snapshot of a machine with a timer, stored",
    `${JOB}actor.subscribe((s) => {
  try {
    localStorage.setItem("job", JSON.stringify(s));
  } catch {
    // storage full: keep running
  }
});
`,
    29,
    "a stored snapshot of a machine with timers or children: `persist(actor)`",
  ],
  [
    "M573: the plain snapshot of a machine with a timer, read and stored",
    `${JOB}export function save(): void {
  try {
    localStorage.setItem("job", JSON.stringify(actor.snapshot()));
  } catch {
    // storage full: keep running
  }
}
`,
    29,
    "a stored snapshot of a machine with timers or children: `persist(actor)`",
  ],
];
