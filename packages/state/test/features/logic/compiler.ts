// logic's compiler cases: purity in the handlers a logic child adds (`error`, `on`). Collected by
// ../compiler.ts into test/compiler.test.ts (which holds each to "no case is a type error").

import { type Case, change } from "../../sources.ts";

/** A machine running a callback logic child that can fail and sends `tick`. */
const TICKS = `import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createCallbackLogic, logic } from "@reactre/state/logic";

const ticker = createCallbackLogic<never, undefined, { type: "tick"; n: number }>(({ sendBack }) => {
  sendBack({ type: "tick", n: 1 });
  return () => {};
});

const clock = setup({
  use: [children, logic],
  states: { running: types<{ n: number }>(), broken: types<{ reason: string }>() },
  events: {},
  children: { ticker },
});

export const clockMachine = clock.machine({
  start: ({ to }) => to("running", { n: 0 }),
  states: {
    running: {
      children: {
        ticker: {
          error: ({ error, to }) => to("broken", { reason: String(error) }),
          on: { tick: ({ event, to }) => to("running", { n: event.n }) },
        },
      },
    },
    broken: {},
  },
});
`;

/** Logic made by the file's `create*Logic` calls, with `body` after the import (line 4 on). */
export const made = (body: string): string =>
  `import { createAsyncLogic, createCallbackLogic, createObservableLogic, createStepLogic, type Subscribable } from "@reactre/state/logic";

declare const ids: readonly string[];
${body}
`;

/** Async logic whose run (line 5 on) has steps: `body` is its statements. */
export const steps = (...body: string[]): string =>
  made(
    `export const charge = createAsyncLogic({\n  run: async ({ input, signal }: { input: { id: string; at: number }; signal: AbortSignal }, enq) => {\n${body.map((l) => `    ${l}`).join("\n")}\n  },\n});`,
  );

export const cases: Case[] = [
  [
    "M531: a throw in a callback logic's receive listener",
    made(`export const socket = createCallbackLogic<{ type: "frame"; ok: boolean }, undefined, { type: "failed" }>(({ receive }) => {
  receive((e) => {
    if (!e.ok) throw new Error("bad frame");
  });
  return () => {};
});`),
    6,
    "a throw in `receive` stops the child: `sendBack` a failure event",
  ],
  [
    "M544: a catchError that returns EMPTY in observable logic",
    made(`declare const ticks$: { pipe<T>(op: (s: Subscribable<number>) => Subscribable<T>): Subscribable<T> };
declare const EMPTY: Subscribable<never>;
declare function catchError<T>(f: (error: unknown) => Subscribable<T>): (s: Subscribable<number>) => Subscribable<number | T>;
export const ticks = createObservableLogic(() => ticks$.pipe(catchError(() => EMPTY)));`),
    7,
    "catchError returns EMPTY, so the failure looks like completion: send a failure event",
  ],
  [
    "M544: a catchError whose block returns of(…) in observable logic",
    made(`declare const ticks$: { pipe<T>(op: (s: Subscribable<number>) => Subscribable<T>): Subscribable<T> };
declare function of<T>(value: T): Subscribable<T>;
declare function catchError<T>(f: (error: unknown) => Subscribable<T>): (s: Subscribable<number>) => Subscribable<number | T>;
export const ticks = createObservableLogic(() =>
  ticks$.pipe(
    catchError(() => {
      return of(0);
    }),
  ),
);`),
    9,
    "catchError returns of(…), so the failure looks like completion: send a failure event",
  ],
  [
    "M547: step logic's run mutates its context",
    made(`export const tally = createStepLogic<{ at: number; n: number }, { type: "see"; at: number }>({
  context: { at: 0, n: 0 },
  run: ({ context, event }) => {
    context.at = event.at;
    context.n++;
    return { context };
  },
});`),
    7,
    "step logic's run mutates `context`: return the new context, `{ ...context, field }`",
  ],
  [
    "M547: step logic's run mutates its context and reads the clock",
    made(`export const seen = createStepLogic<{ seen: string[]; at: number }, { type: "see"; id: string }>({
  context: { seen: [], at: 0 },
  run: ({ context, event }) => {
    context.seen.push(event.id);
    return { context: { seen: context.seen, at: Date.now() } };
  },
});`),
    7,
    "step logic's run mutates `context` and reads the clock: return the new context, and pass the time in the event",
  ],
  [
    "M539: a step key repeated in a loop",
    steps(
      "const out: string[] = [];",
      'for (const id of ids) out.push(await enq.step("load", () => fetch(`/items/${id}`, { signal }).then((r) => r.text())));',
      "return out;",
    ),
    7,
    'the step key "load" repeats in the loop, so the journal replays the first result: put the id in the key',
  ],
  [
    "M539: the same step key twice",
    steps(
      'const a = await enq.step("load", () => input.id);',
      'const b = await enq.step("load", () => a + input.id);',
      "return b;",
    ),
    7,
    'the step key "load" is used twice, so the second replays the first\'s result: give each step its own key',
  ],
  [
    "M539: a step key repeated in a map's callback",
    steps(
      'return Promise.all(ids.map((id) => enq.step("load", () => fetch(`/items/${id}`, { signal }).then((r) => r.text()))));',
    ),
    6,
    'the step key "load" repeats in the loop, so the journal replays the first result: put the id in the key',
  ],
  [
    "M540: a step's key from new Date()",
    steps("return enq.step(`stamp-${new Date().toISOString()}`, () => input.id);"),
    6,
    "a step's key from new Date() changes on replay: derive it from data",
  ],
  [
    "M540: a step's key from Date()",
    steps("return enq.step(`stamp-${Date()}`, () => input.id);"),
    6,
    "a step's key from Date() changes on replay: derive it from data",
  ],
  [
    "M540: a step's key from the clock",
    steps("return enq.step(`stamp-${Date.now()}`, () => input.id);"),
    6,
    "a step's key from Date.now changes on replay: derive it from data",
  ],
  [
    "M542: a clock read outside a step decides a branch",
    steps(
      'if (Date.now() > input.at) return enq.step("late", () => "late");',
      'return enq.step("on-time", () => "on time");',
    ),
    6,
    "a clock read outside a step changes on replay: read it in `enq.step`",
  ],
  [
    "M542: a random draw outside a step feeds a step",
    steps("const coin = Math.random();", 'return enq.step("toss", () => (coin > 0.5 ? input.id : ""));'),
    6,
    "Math.random outside a step changes on replay: call it in `enq.step`",
  ],
  [
    "M543: a POST outside a step, beside steps",
    steps(
      'await fetch("/charge", { method: "POST", signal });',
      'return enq.step("receipt", () => fetch(`/receipts/${input.id}`, { signal }).then((r) => r.text()));',
    ),
    6,
    "a POST outside `enq.step` runs again on replay: put it in a step",
  ],
  [
    "a cast in a logic child's on",
    change(TICKS, "{ n: event.n }", "{ n: event.n as number }"),
    24,
    "a cast in a transition hides a broken contract",
  ],
  [
    "a global in a logic child's error",
    change(TICKS, "String(error)", "(console.log(error), String(error))"),
    23,
    "console is a global a transition may not read",
  ],
];
