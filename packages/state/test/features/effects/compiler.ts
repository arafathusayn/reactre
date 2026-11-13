// effects's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). What the types can't see: that a handler's code outside its
// `enq(...)` closures is still pure, and that `enq` itself isn't used where it records nothing.

import { type Case, change, DOOR, withUse } from "../../sources.ts";

const DOORS = withUse(["effects"], DOOR);
const PUSH = 'push: ({ event, to }) => to("open", { by: event.by })';
const CLOSE = 'close: ({ to }) => to("closed")';

/** DOORS with `open`'s entry (on line 25). */
const entry = (handler: string): string => change(DOORS, "open: { on:", `open: { entry: ${handler}, on:`);

/** `base` with `line` put before the machine, as a module-level declaration. */
const declare = (base: string, line: string): string =>
  change(base, "export const doorMachine", `${line}\nexport const doorMachine`);

/** DOOR with effects and emit in use, and an emitted event, `ready` (on line 6). */
const EMITS = change(
  withUse(["effects", "emit"], DOOR),
  "  states: {",
  "  emitted: { ready: types<{}>() },\n  states: {",
);

/** A shelf whose data holds an array: `add` puts an item in it. */
const SHELF = `import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";

const shelf = setup({
  use: [effects],
  states: { open: types<{ items: string[] }>() },
  events: { add: types<{ item: string }>() },
});

export const shelfMachine = shelf.machine({
  start: ({ to }) => to("open", { items: [] }),
  states: {
    open: {
      on: {
        add: ({ data, event, to }) =>
          to("open", { items: [...data.items, event.item] }),
      },
    },
  },
});
`;

/** DOORS with a delayed raise on push (its options as written, on line 20) and a cancel on close (line 24). */
export function cancels(options: string, id: string, before = ""): string {
  const source = change(
    change(
      DOORS,
      PUSH,
      `push: ({ event, enq, to }) => (enq.raise({ type: "close" }, ${options}), to("open", { by: event.by }))`,
    ),
    CLOSE,
    `close: ({ enq, to }) => (enq.cancel(${id}), to("closed"))`,
  );
  return before === "" ? source : change(source, "export const doorMachine", `${before}\nexport const doorMachine`);
}

export const cases: Case[] = [
  [
    "an effect's arguments read the clock",
    change(DOORS, PUSH, 'push: ({ event, enq, to }) => (enq.log("pushed", Date.now()), to("open", { by: event.by }))'),
    20,
    "Date reads the clock",
  ],
  [
    "entry reads the clock outside its effect",
    change(DOORS, "open: { on:", 'open: { entry: ({ enq }) => enq.log("opened", Math.random()), on:'),
    24,
    "Math.random makes a transition give different results",
  ],
  [
    "enq inside an effect",
    change(DOORS, PUSH, 'push: ({ event, enq, to }) => (enq(() => enq.log("later")), to("open", { by: event.by }))'),
    20,
    "enq inside an effect: the effect runs after the transition, when enq records nothing",
  ],
  [
    "entry given by reference",
    change(
      change(DOORS, "open: { on:", "open: { entry: onOpen, on:"),
      "export const doorMachine",
      'const onOpen = ({ enq }: { enq: (fn: () => void) => void }) => enq(() => console.log("open"));\nexport const doorMachine',
    ),
    25,
    "a handler is a function written in place",
  ],
  [
    "M102: a cancel of an id no raise or send has",
    cancels('{ delay: 10, id: "later" }', '"nope"'),
    24,
    'enq.cancel("nope") cancels nothing: no raise or send in this machine has id "nope" (the ids are: "later"). Use one of them, or remove the cancel',
  ],
  [
    "M102: a cancel of an after timer, in a machine that raises no id",
    cancels("{ delay: 10 }", '"5s"'),
    24,
    'enq.cancel("5s") cancels nothing: no raise or send in this machine has an id. A timer in after has no id: it stops when its state exits, so move out of the state to cancel it. Give the delayed one this id, enq.raise(event, { delay: 1000, id: "5s" }), or remove the cancel',
  ],
  [
    "a cancel's id in a constant",
    cancels('{ delay: 10, id: "bell" }', "BELL", 'const BELL = "bell";'),
    25,
    'enq.cancel\'s id is written in place, a string: enq.cancel("bell"), so the compiler can check that a raise or send of this machine has it',
  ],
  [
    "a raise's options in a constant, in a machine that cancels",
    cancels("LATER", '"bell"', 'const LATER = { delay: 10, id: "bell" };'),
    21,
    'enq.raise\'s options are written in place, the id a string: enq.raise(event, { delay: 1000, id: "bell" }), so the compiler sees the ids enq.cancel takes',
  ],
  [
    "a raise's id in a constant, in a machine that cancels",
    cancels("{ delay: 10, id: BELL }", '"bell"', 'const BELL = "bell";'),
    21,
    "enq.raise's options are written in place, the id a string",
  ],
  // What a machine's effects do together, and what an effect's body does (compiler/features/effects.ts).
  [
    "M502: a handler that stays and raises its own event",
    change(
      change(DOORS, "  events: {\n", "  internal: { ring: types<{}>() },\n  events: {\n"),
      CLOSE,
      `${CLOSE}, ring: ({ data, enq, keep }) => (enq.raise({ type: "ring" }), keep("open", data))`,
    ),
    25,
    "`ring` raises `ring` and stays, forever: raise it only on a condition, or go to another state",
  ],
  [
    "M502: two handlers that stay and raise each other's event",
    change(
      change(DOORS, "  events: {\n", "  internal: { ring: types<{}>(), buzz: types<{}>() },\n  events: {\n"),
      CLOSE,
      `${CLOSE},\n        ring: ({ data, enq, keep }) => (enq.raise({ type: "buzz" }), keep("open", data)),\n        buzz: ({ data, enq, keep }) => (enq.raise({ type: "ring" }), keep("open", data))`,
    ),
    26,
    "`ring` raises `buzz`, `buzz` raises `ring`, and each stays, forever: raise one only on a condition, or go to another state",
  ],
  [
    "M503: an effect that opens a socket",
    entry(
      '({ enq }) => enq(() => { const socket = new WebSocket("wss://door"); socket.onmessage = (m) => console.log(m.data); })',
    ),
    24,
    "`enq` opens a socket that nothing closes: a callback child, or `enq.effect` returning its cleanup",
  ],
  [
    "M503: enq.effect that opens a listener and returns no cleanup",
    entry('({ enq }) => enq.effect(() => window.addEventListener("resize", () => console.log("resized")))'),
    24,
    "`enq.effect` opens a listener and returns no cleanup: return the function that closes it",
  ],
  [
    "M504: an exit's effect that schedules a timer",
    change(DOORS, "open: { on:", 'open: { exit: ({ enq }) => enq(() => setTimeout(() => console.log("left"), 0)), on:'),
    24,
    "`enq` schedules a timer that nothing clears: `enq.raise(…, { delay })`, `after`, or `enq.effect` with a cleanup",
  ],
  [
    "M505: an effect writes a module variable",
    declare(entry("({ data, enq }) => enq(() => { opened = data.by; })"), 'let opened = "";'),
    25,
    "an effect writes the module variable `opened`: keep it in the state's data",
  ],
  [
    "M506: an effect reads a module actor's snapshot",
    declare(
      entry("({ enq }) => enq(() => console.log(panel.snapshot().state))"),
      "declare const panel: { snapshot(): { readonly state: string } };",
    ),
    25,
    "an effect reads `panel.snapshot()`, the actor's snapshot: pass the value from the handler's `data`",
  ],
  [
    "M508: the start state's entry emits",
    change(EMITS, "    closed: {\n", '    closed: {\n      entry: ({ enq }) => enq.emit({ type: "ready" }),\n'),
    21,
    "the start state's entry emits before anyone can listen: emit it on an event",
  ],
  [
    "M509: a callback enqueued by a handler and by its target's entry",
    declare(
      change(
        entry("({ data, enq }) => enq(() => props.onOpen(data.by))"),
        PUSH,
        'push: ({ event, enq, to }) => (enq(() => props.onOpen(event.by)), to("open", { by: event.by }))',
      ),
      "declare const props: { onOpen(by: string): void };",
    ),
    21,
    '`onOpen` runs twice, from `push` and from "open"\'s entry: keep one',
  ],
  [
    "M510: an empty catch in an effect",
    entry('({ enq }) => enq(() => { try { console.log("opened"); } catch {} })'),
    24,
    "an empty catch in an effect: let it throw, or say in a comment why it can be ignored",
  ],
  [
    "M511: void of an async function in an effect",
    declare(
      entry("({ data, enq }) => enq(() => { void audit(data.by); })"),
      "async function audit(by: string): Promise<void> {\n  await fetch(`/audit/${by}`);\n}",
    ),
    27,
    "`void audit(…)` drops its failure: make it a task",
  ],
  [
    // The case is compiled in test/out/, so the import is ../compiler/store.ts's async `store`.
    "M511: void of an imported async function in an effect",
    change(
      entry("({ data, enq }) => enq(() => { void store(data.by); })"),
      'import { effects } from "@reactre/state/effects";\n',
      'import { effects } from "@reactre/state/effects";\nimport { store } from "../compiler/store.ts";\n',
    ),
    25,
    "`void store(…)` drops its failure: make it a task",
  ],
  [
    "M512: a delayed raise only the target handles, never cancelled",
    change(
      DOORS,
      PUSH,
      'push: ({ event, enq, to }) => (enq.raise({ type: "close" }, { delay: 1000 }), to("open", { by: event.by }))',
    ),
    20,
    'the delayed `close` is raised for "open" only, and nothing cancels it on leaving: `after` on "open", or cancel it in exit',
  ],
  [
    "M513: a delayed raise with an id from a handler that stays",
    change(
      DOORS,
      CLOSE,
      `${CLOSE}, push: ({ data, enq, keep }) => (enq.raise({ type: "close" }, { delay: 300, id: "debounce" }), keep("open", data))`,
    ),
    24,
    'the delayed raise "debounce" from a handler that stays adds another: `enq.cancel("debounce")` before it',
  ],
  [
    "M514: exit raises an event only the state it leaves handles",
    change(DOORS, "open: { on:", 'open: { exit: ({ enq }) => enq.raise({ type: "close" }), on:'),
    24,
    "exit raises `close`, which only the state it leaves handles: handle it where the step goes, or drop the raise",
  ],
  [
    "M515: a raise the target doesn't handle",
    change(
      DOORS,
      PUSH,
      'push: ({ event, enq, to }) => (enq.raise({ type: "lock", code: "1" }), to("open", { by: event.by }))',
    ),
    20,
    '`lock` is raised for "open", which doesn\'t handle it: handle it there, or drop the raise',
  ],
  [
    "M516: an emitted event nothing emits",
    change(
      change(EMITS, "emitted: { ready: types<{}>() }", "emitted: { ready: types<{}>(), jammed: types<{}>() }"),
      PUSH,
      'push: ({ event, enq, to }) => (enq.emit({ type: "ready" }), to("open", { by: event.by }))',
    ),
    7,
    'the emitted event "jammed" is never emitted: emit it, or remove it from `emitted`',
  ],
  [
    "M517: a raise cancelled in the handler that raised it",
    change(
      DOORS,
      PUSH,
      'push: ({ event, enq, to }) => (enq.raise({ type: "close" }, { delay: 300, id: "d" }), enq.cancel("d"), to("open", { by: event.by }))',
    ),
    20,
    'the raise "d" is cancelled in the handler that raised it: drop both',
  ],
  [
    // `.sort()` and `.push()` on data are type errors (its arrays are readonly); Object.assign isn't.
    "M518: an effect assigns into the data's array",
    change(
      change(SHELF, "add: ({ data, event, to })", "add: ({ data, enq, event, to })"),
      'to("open", { items: [...data.items, event.item] })',
      '(enq((items: readonly string[]) => Object.assign(items, [event.item]), data.items), to("open", { items: [...data.items, event.item] }))',
    ),
    16,
    "an effect mutates `data.items`: copy it (`toSorted`, a spread)",
  ],
];
