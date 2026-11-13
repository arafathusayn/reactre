// @reactre/state/logic (prototype): actor logic beyond machines, each usable as a root actor
// (`createActor(load, { input })`) and as a node's child (setup's `children`, with
// `use: [children, logic]`): async, callback, observable, event observable, step, listener and
// subscription logic, and the empty actor.
//
// Design decisions:
//   - Each kind is a small machine whose table this module builds at runtime: states `active`,
//     `done` (`{ output }`) and `error` (`{ error }`), and its own lifecycle in `r`. So an actor of
//     logic is an actor like any other: `createActor`, `subscribe`, `child`, `persist` and
//     `restoreActor` take it, and its snapshot narrows on `state`. XState's `status`, `output` and
//     `error` are its states: `state === "done"` and `data.output`.
//   - `task` and async logic: one obvious way per job. A node's own promise is `task` (its result
//     an event the node handles, its `error` required). Async logic is for work that is an actor of
//     its own: run as a root actor, reached with `child`, given a timeout, or with steps that
//     survive a restore. A node runs it as a child, whose `done` gets the output.
//   - A logic's failure is its `error` state, which a parent's child `error` handler gets (the
//     thrown value as it was, so `error instanceof TimeoutError` works); `done` gets the output.
//   - Events a logic sends back (`sendBack`, an event observable's events) go to the parent's child
//     spec, `children: { socket: { on: { message: ({ event, to }) => ... } } }`, typed by the logic:
//     not to the node's `on`, where a sent event would be one more kind of internal event.
//   - Received events (callback and step logic) are effects of a pure step: the step returns them
//     on `fx`, and the lifecycle hands them to the logic after the move. Step logic's `run` is pure
//     the same way: `enq.raise`, `enq.sendBack` and `enq.effect` are recorded, then run.
//   - Restoring a logic actor restarts its work from its data (async logic re-runs `run`, whose
//     recorded steps return what they returned), as a node's task restarts.
//   - Not here: `emit` from logic (the emit feature's), and step logic's run on the initial event
//     (its `context` is the start).

import {
  type __Actor,
  __snap,
  __step,
  type Actor,
  createActor,
  type Duration,
  type Feature,
  type Shape,
  type Snapshot,
  StateError,
} from "../../index.ts";
import type {
  __Compiled,
  __Effect,
  __Event,
  __Lifecycle,
  __Snapshot,
  __Step,
  __StepHook,
  __To,
} from "../../internal.ts";
import { __outcome, type Observed } from "./outcome.ts";
import type { AnyEvent, ContextJson, ListenCheck, Listened, Logic, LogicShape, StepJson } from "./types.ts";

export type { AnyEvent, Logic, LogicInfo, LogicShape } from "./types.ts";

/** The logic opt-in: `setup({ use: [children, logic], children: { load: loadLogic } })`. */
export interface LogicFeature extends Feature<"logic"> {}

/** The logic opt-in: a setup child that is actor logic needs it. It adds nothing to the table. */
export const logic: LogicFeature = {};

// #region The table and lifecycle every kind shares

/** What a kind's work gets when its actor starts (or is restored). */
interface Begin {
  /** The `active` data it starts from. */
  readonly data: { readonly input: unknown; readonly steps?: { readonly [key: string]: unknown } };
  /** Moves the actor (dropped once it stopped, or ended). */
  readonly go: (step: __Step) => void;
  /** An event to the actor itself, through its step. */
  readonly raise: (event: __Event) => void;
  /** An event to the parent (dropped for a root actor). */
  readonly sendBack: (event: __Event) => void;
}

/** An effect a logic's step records for its own lifecycle: an event, or step logic's `enq.effect`. */
interface Fx extends __Effect {
  readonly event?: __Event;
  readonly key?: string;
  readonly exec?: (() => unknown) | undefined;
}

/** A kind's work: what receives the effects its steps record, and its cleanup. */
interface Work {
  readonly effect?: (effect: Fx) => void;
  readonly stop: () => void;
}

/** A received event, recorded by the step for the lifecycle to hand over (callback logic). */
const received: __StepHook = (_m, from, event) => {
  const fx: Fx = { type: "receive", event };
  return { ok: true, snapshot: from, fx: [fx] };
};

/** Every event type: a logic that receives types its events, so the runtime takes any. */
const any: __Compiled["e"] = /* @__PURE__ */ new Proxy({}, { get: () => 1 });

/**
 * A logic's table: `start` gives its first step from the input, `begin` starts its work when the
 * actor starts (or is restored), `y` steps a received event. Its final states end the work.
 */
function table(
  kind: string,
  start: (input: unknown) => __Step,
  begin: (b: Begin) => Work | undefined,
  y?: __StepHook,
): __Compiled {
  const r: __Lifecycle = (m, move, current, options) => {
    let work: Work | undefined;
    let begun = false;
    let on = true;
    const stop = (): void => {
      if (on) {
        on = false;
        work?.stop();
      }
    };
    return {
      m,
      enter(next, active, result) {
        if (!active) return stop();
        if (!begun) {
          begun = true;
          const go = (step: __Step): void => {
            if (on) move({ ok: true, snapshot: __snap(m, step, current()) });
          };
          try {
            work = begin({
              // The cast: an `active` snapshot holds what this table's start and steps put there.
              data: next.data as Begin["data"],
              go,
              raise: (event) => on && move(__step(m, current(), event, true)),
              sendBack: (event) => on && options?.parent?.(event),
            });
          } catch (error) {
            go(to("error", { error }));
          }
          // It ended while it began (an observable that completes at once): stop what it started.
          if (!on) work?.stop();
        }
        if (result.ok) for (const effect of result.fx ?? []) work?.effect?.(effect);
      },
      stop,
    };
  };
  return { v: 0, e: y ? any : {}, i: start, o: { active: {} }, f: { done: 1, error: 1 }, lg: kind, r, ...(y && { y }) };
}

/** A step of a logic's table (its version is 0): the snapshot itself, as a compiled `to`'s. */
const to = (state: string, data: object): __To => ({ state, data, version: 0 });

const START = (input: unknown): __Step => to("active", { input });

// #endregion

// #region Async logic

/** A timeout as milliseconds, or a duration: "500ms", "10s", "2m", "1h". */
export type Timeout = number | Duration;

const UNIT: { readonly [unit: string]: number } = { ms: 1, s: 1e3, m: 6e4, h: 36e5 };

function ms(timeout: Timeout): number {
  if (typeof timeout === "number") return timeout;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(timeout);
  if (m === null)
    throw new StateError(
      "S31",
      `timeout "${timeout}" is not a duration: write a number and a unit, "500ms", "5s", "2m" or "1h"`,
    );
  return Number(m[1]) * (UNIT[m[2] ?? ""] ?? 1);
}

/** Async logic's run took longer than its `timeout`: its signal aborted, and the actor failed with it. */
export class TimeoutError extends StateError {
  /** The timeout, in milliseconds. */
  readonly ms: number;
  constructor(id: string, ms: number) {
    super(
      "S30",
      `async logic "${id}" took longer than its timeout, ${ms}ms: raise the timeout, or handle it in the child's error ({ error }: error instanceof TimeoutError)`,
    );
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

/** What async logic's `run` gets besides its input and signal. */
export interface AsyncEnq {
  /**
   * Runs `exec` once per key, and records its result in the snapshot (`data.steps[key]`): a
   * restored actor re-runs `run`, and a recorded step returns what it returned, without running
   * again. A step interrupted before it finished runs again (at least once): give its side effect
   * an idempotency key.
   */
  readonly step: <T>(key: string, exec: (() => T | Promise<T>) & StepJson<Awaited<T>>) => Promise<Awaited<T>>;
}

/** Async logic's `active` data: its input, and its steps' recorded results. */
export interface AsyncData<I> {
  readonly input: I;
  readonly steps?: { readonly [key: string]: unknown };
}

/**
 * One async operation as an actor: `run`'s result is its output (`done`), and what it throws is its
 * error (`error`). Its signal aborts when the actor stops, and when `timeout` elapses (then it fails
 * with a TimeoutError).
 *
 * `createAsyncLogic({ run: async ({ input, signal }: { input: { id: string }; signal: AbortSignal }) => load(input.id, signal) })`,
 * or with its types written out, `createAsyncLogic<User, { id: string }>({ run })`.
 */
export function createAsyncLogic<O, I extends object | undefined = undefined>(options: {
  /** Names the logic (in errors), not an actor. */
  readonly id?: string;
  readonly timeout?: Timeout;
  readonly run: (args: { readonly input: I; readonly signal: AbortSignal }, enq: AsyncEnq) => O | Promise<O>;
}): Logic<I, AsyncData<I>, Awaited<O>, never, never, true, true>;
export function createAsyncLogic(options: {
  readonly id?: string;
  readonly timeout?: Timeout;
  readonly run: (args: { readonly input: unknown; readonly signal: AbortSignal }, enq: AsyncEnq) => unknown;
}): __Compiled {
  const id = options.id ?? "async";
  const limit = options.timeout === undefined ? undefined : ms(options.timeout);
  return table(id, START, ({ data, go }) => {
    const controller = new AbortController();
    const steps: { [key: string]: unknown } = { ...data.steps };
    const running = new Map<string, Promise<unknown>>();
    const enq: AsyncEnq = {
      step: <T>(key: string, exec: () => T | Promise<T>): Promise<Awaited<T>> => {
        // The cast: what was recorded under this key is what this key's exec gave.
        if (Object.hasOwn(steps, key)) return Promise.resolve(steps[key] as Awaited<T>);
        const was = running.get(key) as Promise<Awaited<T>> | undefined;
        if (was) return was;
        const now = Promise.resolve(exec()).then((value) => {
          steps[key] = value;
          go(to("active", { input: data.input, steps: { ...steps } }));
          return value;
        });
        running.set(key, now);
        return now;
      },
    };
    const timer =
      limit === undefined
        ? undefined
        : setTimeout(() => {
            const error = new TimeoutError(id, limit);
            controller.abort(error);
            go(to("error", { error }));
          }, limit);
    Promise.resolve(options.run({ input: data.input, signal: controller.signal }, enq)).then(
      (output) => go(to("done", { output })),
      (error: unknown) => go(to("error", { error })),
    );
    return {
      stop() {
        clearTimeout(timer);
        controller.abort();
      },
    };
  });
}

// #endregion

// #region Callback logic

/** `sendBack`, or the fix when the logic didn't say what it sends. */
export type SendBack<S> = [S] extends [never]
  ? (fix: "sendBack sends the events this logic declares: createCallbackLogic<Receives, Input, Sends>") => void
  : (event: S) => void;

/** What callback logic's function gets. */
export interface CallbackArgs<R, I, S> {
  readonly input: I;
  /** An event to the parent: its child spec's `on` handles it. */
  readonly sendBack: SendBack<S>;
  /** Listens to the events sent to this actor (`actor.send`). */
  readonly receive: (listener: (event: R) => void) => void;
}

/**
 * A callback API or a subscription as an actor: `run` starts it, and returns its cleanup, which
 * runs when the actor stops. It sends events to its parent with `sendBack`, and gets the events
 * sent to it with `receive`. It ends only by failing (`run` throws).
 *
 * `createCallbackLogic<{ type: "send"; text: string }, { url: string }, { type: "message"; text: string }>(({ input, sendBack, receive }) => ...)`:
 * the events it receives, its input, and the events it sends back.
 */
export function createCallbackLogic<
  R extends AnyEvent = never,
  I extends object | undefined = undefined,
  S extends AnyEvent = never,
>(
  // Its cleanup, always: an interval or a subscription that `run` starts would outlive the actor.
  // `() => {}` for logic with nothing to clean up. The cleanup's parameter is the fix, written in
  // place so an error prints it (M219: none returned; M530: an async run, which resolves at once).
  run: (
    args: CallbackArgs<R, I, S>,
  ) => (
    fix?: "run returns its cleanup, a function, not a promise (run isn't async): return () => clearInterval(id), or () => {} when there is nothing to clean up",
  ) => void,
): Logic<I, { readonly input: I }, undefined, R, S, true, false>;
export function createCallbackLogic(
  run: (args: {
    readonly input: unknown;
    readonly sendBack: (event: __Event) => void;
    readonly receive: (listener: (event: __Event) => void) => void;
  }) => (() => void) | void,
): __Compiled {
  return table(
    "callback",
    START,
    ({ data, sendBack }) => {
      let listener: ((event: __Event) => void) | undefined;
      const cleanup = run({ input: data.input, sendBack, receive: (l) => (listener = l) });
      return { effect: (e) => e.event && listener?.(e.event), stop: () => cleanup?.() };
    },
    received,
  );
}

// #endregion

// #region Observables

/** Anything with an observable's `subscribe` (RxJS, or one by hand). */
export interface Subscribable<T> {
  subscribe(observer: {
    readonly next: (value: T) => void;
    readonly error: (error: unknown) => void;
    readonly complete: () => void;
  }): { unsubscribe(): void };
}

/** Observable logic's `active` data: its input, and the last value (none before the first). */
export interface ObservableData<I, T> {
  readonly input: I;
  readonly value?: T;
}

/**
 * A stream of values as an actor: its data's `value` is the last one. It ends when the stream
 * completes, and fails when it errors. `createObservableLogic(({ input }: { input: { id: string } }) => positions(input.id))`.
 */
export function createObservableLogic<T, I extends object | undefined = undefined>(
  make: (args: { readonly input: I }) => Subscribable<T>,
): Logic<I, ObservableData<I, T>, undefined, never, never, true, true>;
export function createObservableLogic(make: (args: { readonly input: unknown }) => Subscribable<unknown>): __Compiled {
  return table("observable", START, ({ data, go }) => {
    const sub = make({ input: data.input }).subscribe({
      next: (value) => go(to("active", { input: data.input, value })),
      error: (error) => go(to("error", { error })),
      complete: () => go(to("done", { output: undefined })),
    });
    return { stop: () => sub.unsubscribe() };
  });
}

/**
 * A stream of events as an actor: each one goes to the parent (its child spec's `on`). It ends
 * when the stream completes, and fails when it errors.
 */
export function createEventObservableLogic<S extends AnyEvent, I extends object | undefined = undefined>(
  make: (args: { readonly input: I }) => Subscribable<S>,
): Logic<I, { readonly input: I }, undefined, never, S, true, true>;
export function createEventObservableLogic(
  make: (args: { readonly input: unknown }) => Subscribable<__Event>,
): __Compiled {
  return table("eventObservable", START, ({ data, go, sendBack }) => {
    const sub = make({ input: data.input }).subscribe({
      next: sendBack,
      error: (error) => go(to("error", { error })),
      complete: () => go(to("done", { output: undefined })),
    });
    return { stop: () => sub.unsubscribe() };
  });
}

// #endregion

// #region Step logic

/** What step logic's `run` records: run after the step, in order. */
export interface StepEnq<R, S> {
  /** An event to this actor itself, after this step. */
  readonly raise: (event: R) => void;
  /** An event to the parent. */
  readonly sendBack: SendBack<S>;
  /**
   * A side effect, after the step; what it returns runs when the actor stops. With a key, it starts
   * once: a later step that records the same key does nothing.
   */
  readonly effect: {
    (exec: () => (() => void) | void): void;
    (key: string, exec: () => (() => void) | void): void;
  };
}

/** What step logic's `run` returns: nothing (no change), the next context, or the end. */
export type StepPatch<C, O> =
  | void
  | null
  | { readonly context: C }
  | { readonly status: "done"; readonly output: O }
  | { readonly status: "error"; readonly error: unknown };

/** Step logic's `active` data: its input and its context. */
export interface StepData<I, C> {
  readonly input: I;
  readonly context: C;
}

/**
 * A stateful actor without states: `run` takes its context and each event, and returns the next
 * context, or `{ status: "done", output }`, or `{ status: "error", error }`. It is pure: effects go
 * through `enq` and run after the step.
 *
 * `createStepLogic<{ count: number }, { type: "inc" }>({ context: { count: 0 }, run: ({ context, event }) => ... })`:
 * the context, the events it receives, then (optional) what it sends back, its input and its output.
 */
export function createStepLogic<
  C extends object,
  R extends AnyEvent = never,
  S extends AnyEvent = never,
  I extends object | undefined = undefined,
  O = undefined,
>(
  options: {
    readonly id?: string;
    readonly context: C | ((args: { readonly input: I }) => C);
    readonly run: (
      args: { readonly context: C; readonly event: R; readonly input: I },
      enq: StepEnq<R, S>,
    ) => StepPatch<C, O>;
  } & ContextJson<C>,
): Logic<I, StepData<I, C>, O, R, S, true, true>;
export function createStepLogic(options: {
  readonly id?: string;
  readonly context: object | ((args: { readonly input: unknown }) => object);
  readonly run: (
    args: { readonly context: object; readonly event: __Event; readonly input: unknown },
    enq: {
      readonly raise: (event: __Event) => void;
      readonly sendBack: (event: __Event) => void;
      readonly effect: (a: string | (() => unknown), b?: () => unknown) => void;
    },
  ) => unknown;
}): __Compiled {
  const { context } = options;
  return table(
    options.id ?? "step",
    (input) => to("active", { input, context: typeof context === "function" ? context({ input }) : context }),
    ({ raise, sendBack }) => {
      const keys = new Set<string>();
      const cleanups: (() => void)[] = [];
      return {
        effect(e) {
          if (e.type === "raise" && e.event) raise(e.event);
          else if (e.type === "sendBack" && e.event) sendBack(e.event);
          else if (e.type === "effect" && e.exec && !(e.key !== undefined && keys.has(e.key))) {
            if (e.key !== undefined) keys.add(e.key);
            const cleanup = e.exec();
            if (typeof cleanup === "function") cleanups.push(() => cleanup());
          }
        },
        stop() {
          for (const cleanup of cleanups.splice(0)) cleanup();
        },
      };
    },
    (m, from, event) => {
      const fx: Fx[] = [];
      // The cast: an `active` snapshot of this table holds what its start and steps put there.
      const data = from.data as StepData<unknown, object>;
      const enq = {
        raise: (event: __Event) => fx.push({ type: "raise", event }),
        sendBack: (event: __Event) => fx.push({ type: "sendBack", event }),
        // A key comes with its exec (StepEnq's overloads).
        effect: (a: string | (() => unknown), b?: () => unknown) =>
          fx.push(typeof a === "string" ? { type: "effect", key: a, exec: b } : { type: "effect", exec: a }),
      };
      let next: __Step | null;
      try {
        const patch = options.run({ context: data.context, event, input: data.input }, enq) as
          | { readonly context?: object; readonly status?: string; readonly output?: unknown; readonly error?: unknown }
          | undefined
          | null;
        next =
          patch?.status === "done"
            ? to("done", { output: patch.output })
            : patch?.status === "error"
              ? to("error", { error: patch.error })
              : patch?.context
                ? to("active", { input: data.input, context: patch.context })
                : null;
      } catch (error) {
        next = to("error", { error });
      }
      return { ok: true, snapshot: next === null ? from : __snap(m, next, from), fx };
    },
  );
}

// #endregion

// #region Listening to other actors

/** An actor that emits events (`actor.on(type, listener)`, the emit feature's). */
export interface Emitter<E> {
  readonly on: (type: "*", listener: (event: E) => void) => (() => void) | { unsubscribe(): void };
}

/** `type` matches an emitted event's type: exactly, by a prefix wildcard ("upload.*"), or "*". */
function matches(type: string, event: string): boolean {
  return type === "*" || type === event || (type.endsWith(".*") && event.startsWith(type.slice(0, -1)));
}

/**
 * The events another actor emits (those of `type`: exact, "upload.*", or "*"), each mapped to an
 * event for the parent. It never ends: it stops with its node.
 */
export function createListenerLogic<S extends AnyEvent, E extends AnyEvent = AnyEvent, const T extends string = string>(
  source: Emitter<E>,
  type: ListenCheck<E, T>,
  map: (event: Listened<E, T>) => S,
): Logic<undefined, {}, undefined, never, S, false, false>;
export function createListenerLogic(
  source: Emitter<__Event>,
  type: string,
  map: (event: __Event) => __Event,
): __Compiled {
  return table("listener", START, ({ sendBack }) => {
    const off = source.on("*", (event) => matches(type, event.type) && sendBack(map(event)));
    return { stop: () => (typeof off === "function" ? off() : off.unsubscribe()) };
  });
}

/** What an actor ends with: a logic's output, or a machine's final state and data. */
export type OutputOf<D extends Shape> = D extends { readonly "~logic": { readonly output: infer O } } ? O : Snapshot<D>;

/** What a subscription maps to events for the parent: each snapshot, the output, the error. */
export interface Mappers<D extends Shape, S> {
  readonly snapshot?: (snapshot: Snapshot<D>) => S;
  readonly done?: (output: OutputOf<D>) => S;
  readonly error?: (error: unknown) => S;
}

/**
 * Another actor's snapshots and outcome, each mapped to an event for the parent (omit a mapper to
 * ignore it). It never ends: it stops with its node.
 */
export function createSubscriptionLogic<D extends Shape, S extends AnyEvent>(
  source: Actor<D>,
  mappers: Mappers<D, S>,
): Logic<undefined, {}, undefined, never, S, false, false>;
export function createSubscriptionLogic(
  source: Observed,
  mappers: {
    readonly snapshot?: (snapshot: __Snapshot) => __Event;
    readonly done?: (output: unknown) => __Event;
    readonly error?: (error: unknown) => __Event;
  },
): __Compiled {
  return table("subscription", START, ({ sendBack }) => {
    const off = source.subscribe((s) => {
      if (source.status() !== "done") return mappers.snapshot && sendBack(mappers.snapshot(s));
      const end = __outcome(source);
      const event = "error" in end ? mappers.error?.(end.error) : mappers.done?.(end.output);
      if (event) sendBack(event);
    });
    return { stop: off };
  });
}

// #endregion

/** The empty actor's shape: it takes nothing, and never ends. */
export type EmptyShape = LogicShape<undefined, {}, undefined, never, never, false>;

/** A placeholder actor: active, taking no events, until it is stopped. */
export function createEmptyActor(): Actor<EmptyShape> {
  // `createActor`'s overloads type a machine by its shape, which this table's type doesn't carry.
  const create = createActor as unknown as (m: __Compiled) => Actor<EmptyShape>;
  return create(table("empty", START, () => undefined));
}
