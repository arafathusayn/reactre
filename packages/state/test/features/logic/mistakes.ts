// logic's mistakes, each a type error (`bun check` fails if one stops being one), with the exact
// wording pinned by `Equal` where it can be; ../../explain.ts prints what each says.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import {
  createAsyncLogic,
  createCallbackLogic,
  createStepLogic,
  type Logic,
  logic,
  type SendBack,
} from "@reactre/state/logic";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const load = createAsyncLogic({
  run: async ({ input }: { input: { id: string }; signal: AbortSignal }) => ({ name: input.id }),
});
const socket = createCallbackLogic<{ type: "send"; text: string }, undefined, { type: "message"; text: string }>(
  () => () => {},
);

// Opt-in. Actor logic in setup's children without logic in use: the error names the import.
// @ts-expect-error
setup({ use: [children], states: { idle: types<{}>() }, events: {}, children: { load } });
expect<
  Equal<
    keyof ShapeCheck<{
      use: [typeof children];
      states: { idle: Type<{}> };
      events: {};
      children: { load: typeof load };
    }>,
    `setup's child "load" is actor logic: add logic to setup's use (import { logic } from "@reactre/state/logic")`
  >
>();

const page = setup({
  use: [children, logic],
  states: { idle: types<{}>(), busy: types<{ last: string }>(), done: types<{ name: string }>(), failed: types<{}>() },
  events: { go: types<{}>() },
  children: { load, socket },
});

// The correct machine: done gets the output, error what it threw, on what the socket sends back.
export const ok = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { last: "" }) } },
    busy: {
      children: {
        load: {
          input: () => ({ id: "a" }),
          done: ({ output, to }) => to("done", { name: output.name }),
          error: ({ to }) => to("failed"),
        },
        socket: {
          error: ({ to }) => to("failed"),
          on: { message: ({ event, to }) => to("busy", { last: event.text }) },
        },
      },
    },
    done: { final: true },
    failed: { final: true },
  },
});
createActor(ok);

// A logic child that can fail, without error; one that sends an event nobody handles; and an `on`
// for an event the child doesn't send.
const bad = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { last: "" }) } },
    busy: {
      children: {
        load: { input: () => ({ id: "a" }), done: ({ output, to }) => to("done", { name: output.name }) },
        socket: { error: ({ to }) => to("failed") },
      },
    },
    done: { final: true },
    failed: { final: true },
  },
});
expect<
  Equal<
    typeof bad,
    MachineError<
      | 'state "busy" runs child "load", which can fail, and has no error for it: add error: ({ error, to }) => to(...)'
      | 'state "busy" runs child "socket", which sends "message", and doesn\'t handle it: add on: { message: ({ event, to }) => to(...) }'
    >
  >
>();
// @ts-expect-error A logic child's failure, and what it sends back, need handlers.
createActor(bad);

// An `on` for an event the child doesn't send: TypeScript names the one it does ("Did you mean").
page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { last: "" }) } },
    busy: {
      children: {
        socket: {
          error: ({ to }) => to("failed"),
          // @ts-expect-error 'mesage' does not exist: did you mean to write 'message'?
          on: { mesage: () => null },
        },
      },
    },
    done: { final: true },
    failed: { final: true },
  },
});

// A logic's done output is its run's result: not a machine's `{ state, data }`.
page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { last: "" }) } },
    busy: {
      children: {
        load: {
          input: () => ({ id: "a" }),
          // @ts-expect-error `output` is `{ name }`: there is no `output.data`.
          done: ({ output, to }) => to("done", { name: output.data.name }),
          error: ({ to }) => to("failed"),
        },
      },
    },
    done: { final: true },
    failed: { final: true },
  },
});

// sendBack without the events the logic sends: the parameter names the fix.
createCallbackLogic(({ sendBack }) => {
  // @ts-expect-error
  sendBack({ type: "tick" });
  return () => {};
});
expect<
  Equal<
    Parameters<SendBack<never>>[0],
    "sendBack sends the events this logic declares: createCallbackLogic<Receives, Input, Sends>"
  >
>();

// Callback logic returns its cleanup, so what it starts stops with the actor.
// @ts-expect-error M219. An interval and no cleanup returned: the interval would outlive the child.
createCallbackLogic(() => {
  setInterval(() => {}, 1000);
});

// A root actor of logic that takes input needs it, and takes only the events it receives.
// @ts-expect-error Expected 2 arguments: the input.
createActor(load);
// @ts-expect-error Async logic receives no events.
createActor(load, { input: { id: "a" } }).send({ type: "go" });
// @ts-expect-error "send" needs its text.
createActor(socket).send({ type: "send" });

// A logic's snapshot narrows on its state: `output` only in `done`.
const s = createActor(load, { input: { id: "a" } }).snapshot();
// @ts-expect-error `output` is only on done's data.
s.data.output;
if (s.state === "done") s.data.output.name;

// Step logic: run's patch keeps the context's type, and its events are what it receives.
createStepLogic<{ count: number }, { type: "inc" }>({
  context: { count: 0 },
  // @ts-expect-error `count` is a number.
  run: ({ context }) => ({ context: { count: String(context.count) } }),
});
createStepLogic<{ count: number }, { type: "inc" }>({
  context: { count: 0 },
  // @ts-expect-error "dec" is not an event it receives.
  run: ({ event }) => (event.type === "dec" ? null : null),
});

// A machine's types say which logic it is (for `child` and a parent's handlers).
export type Load =
  typeof load extends Logic<infer I extends object | undefined, object, infer O, never, never, true, true>
    ? [I, O]
    : never;
expect<Equal<Load, [{ id: string }, { name: string }]>>();

// The second round's rows, by their M#.
// @ts-expect-error M530. An async callback: it resolves at once, closing the channel; it returns its cleanup.
createCallbackLogic(async ({ receive }) => {
  receive(() => {});
});
createAsyncLogic({
  run: async ({ input }: { input: { url: string }; signal: AbortSignal }, enq) => {
    // @ts-expect-error M541. A Response as a step's result: the journal stores JSON, so return its JSON.
    await enq.step("get", () => fetch(input.url));
    return enq.step("get json", async () => (await (await fetch(input.url)).json()) as { name: string });
  },
});
// @ts-expect-error M546. Step logic's context is held to the JSON check: a Set and a Date aren't JSON.
createStepLogic<{ seen: Set<string>; at: Date }, { type: "inc" }>({
  context: { seen: new Set(), at: new Date() },
  run: ({ context }) => ({ context }),
});
declare const uploads: Emitter<{ type: "upload.done"; url: string } | { type: "upload.failed" }>;
// @ts-expect-error M545. A misspelled event type matches nothing.
createListenerLogic(uploads, "uplaod.done", (event) => ({ type: "seen", url: event.type }));
// The event's type narrows map's event: its url is there.
createListenerLogic(uploads, "upload.done", (event) => ({ type: "seen", url: event.url }));
createListenerLogic(uploads, "upload.*", (event) => ({ type: "seen", kind: event.type }));
import { createListenerLogic, type Emitter } from "@reactre/state/logic";
// M219 and M530: callback logic's cleanup takes the fix as its parameter, so refusing a run that
// returns none, or a promise, prints it.
expect<
  Equal<
    Parameters<ReturnType<Parameters<typeof createCallbackLogic>[0]>>[0],
    | "run returns its cleanup, a function, not a promise (run isn't async): return () => clearInterval(id), or () => {} when there is nothing to clean up"
    | undefined
  >
>();
