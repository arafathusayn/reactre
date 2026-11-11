// The mistakes an AI agent makes writing a state machine, made in every library's port of the same
// apps, and where each library catches them. Each case is a row of ../MISTAKES.md (its M#; a
// letter after it marks a second form of the same row).
//
// # For a library's agent: filling ./<lib>.ts
//
// A library's file (./xstate.ts is a full example) exports a `Library`: its name, its bases (the
// port of each app, ../<lib>/door.ts and job.ts, with a tail that creates the actor), how its
// app is driven (`drive`), and `cases`: one entry per case id below, every id.
//
// - A mutation changes the correct port the way an agent would write the mistake in that library:
//   its idioms, as its docs write them, not a contrived form. `edits` replace text in the base
//   (the port, then the tail): each `from` must be in it, or the run stops and names the case;
//   `"all"` replaces every occurrence. `prepend` adds lines after the port's imports (helpers,
//   module state, more imports); `append` adds lines after the tail, where `actor` is in scope
//   (use sites: sending, reading snapshots). Write it so that the rest of the port stays correct:
//   the mistake, and only the mistake, is what a checker may report.
// - `na("reason")` (the case's null) says the mistake can't be made in the library: its API has no
//   such thing, or what the row calls a mistake is how the library is written. One line, saying
//   why, as "a number is milliseconds in v6". A library without a job port answers every job case
//   with `na`.
// - The correct port must report nothing: `bun check` clean, its build (where it has one) clean,
//   and what it says at start is the baseline the cases' runs are compared with. The run checks
//   this first and stops if a base fails.
// - The run finds ./<lib>.ts by itself (its default export). An id the file doesn't fill yet shows
//   as "?" and is listed after the tables; an id cases.ts lacks stops the run.
// - `drive` sends SCENARIO in the library's own API (as ../drivers.ts does), and for the job
//   gives it SAVE first (the port's `useSave`). The app sends what the correct port expects, so a
//   mutation that changes a payload's type mustn't then crash on the app's value: that throw would
//   be the scenario's, not a catch (M17 converts with `String(event.by)` for that reason). The
//   case's process has a `localStorage` (in memory), as a browser does.
//
// Check one case alone (it writes compare/.cases/<lib>/<id>.ts, and prints each check's message):
//
//   bun --conditions=development packages/state/compare/mistakes/run.ts --lib=xstate --case=M12
//
// `--lib` alone runs one library's cases; no flags run them all and write results/mistakes.json.
// The checks, in order (a case's cell is the first that reports it):
//   type    `bun check` reports an error in the case's file (unused-variable errors aside);
//   build   the library's build fails (@reactre/state: its compiler, which the bundler plugin runs);
//   start   importing the file, then driving the app's events (SCENARIO) in the library's
//           development build, throws, rejects, errors the actor, or warns or logs an error the
//           correct port doesn't;
//   silent  nothing reports it: the program builds and runs, and does the wrong thing;
//   n/a     the library can't express it.
//
// Not here: rows of features the two apps don't have (nested, parallel and history states,
// children, spawn, effects, and the other opt-ins). A third app with nested states and history,
// and a fourth with parallel states, were left out: of the other libraries only @stateforward/hsm
// has hierarchy with history, and only @doeixd/machine composes parallel machines.

export type Base = "door" | "job";

/** Replace `from` with `to` (every occurrence with "all"). */
export type Edit = readonly [from: string, to: string] | readonly [from: string, to: string, all: "all"];

/** A mistake, made in one library's port of the case's base. */
export interface Mutation {
  readonly edits?: readonly Edit[];
  /** Lines after the port's imports. */
  readonly prepend?: string;
  /** Lines after the tail, where `actor` is in scope. */
  readonly append?: string;
}

/** The mistake can't be made in this library: why, in one line. */
export interface NotApplicable {
  readonly na: string;
}

export type Entry = Mutation | NotApplicable;

export const edit = (...edits: readonly Edit[]): Mutation => ({ edits });
export const append = (lines: string): Mutation => ({ append: lines });
export const na = (reason: string): NotApplicable => ({ na: reason });
export const isNa = (e: Entry): e is NotApplicable => "na" in e;

/** A case's module, imported: the port's exports and the tail's `actor`. */
export type CaseModule = { readonly [name: string]: unknown };

export interface Library {
  /** The column's name. */
  readonly name: string;
  /** Each app's port: a path from this folder, and the tail appended to it (it creates `actor`). */
  readonly bases: { readonly [B in Base]?: { readonly port: string; readonly tail: string } };
  /** Every case id, and the library's mutation for it (or `na`). */
  readonly cases: { readonly [id: string]: Entry };
  /**
   * Sends the app's events (SCENARIO[base]) to the imported case, in the library's own API, and
   * lets its tasks and timers settle (`settle()`). Throws if the actor ends in an error state.
   */
  readonly drive: (mod: CaseModule, base: Base) => Promise<void>;
  /** Runs in the case's process before it is imported (@reactre/state: its compiler, as a Bun plugin). */
  readonly preload?: () => void | Promise<void>;
  /** A build step, given the case's file: its first problem, or null. */
  readonly build?: (path: string, source: string) => string | null;
}

/** The events each app sends (test/fixtures/door-app.ts and job-app.ts), so a runtime check on a path gets its chance. */
export const SCENARIO: {
  readonly [B in Base]: readonly { readonly type: string; readonly [field: string]: string }[];
} = {
  door: [
    { type: "push", by: "ann" },
    { type: "close" },
    { type: "lock", code: "1" },
    { type: "unlock", code: "2" },
    { type: "unlock", code: "1" },
  ],
  job: [{ type: "save", text: "hi" }],
};

/** What job's task saves, in each app: the task resolves at once, before its 20ms timer. */
export const SAVE = async (text: string): Promise<string> => `id:${text}`;

/** Lets tasks and timers settle after the app's events. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

export interface Case {
  /** The row in ../MISTAKES.md: M12, or M128b for the row's second form. */
  readonly id: string;
  readonly name: string;
  /** Its section in ../MISTAKES.md. */
  readonly group: string;
  readonly base: Base;
  /** @reactre/state's mutation of test/fixtures/<base>.ts. */
  readonly ours: Entry;
}

// The handlers of test/fixtures/door.ts and job.ts, as written there.
const O = {
  push: `push: ({ event, to }) => to("open", { by: event.by }),`,
  lock: `lock: ({ event, to }) => to("locked", { code: event.code }),`,
  open: `open: { on: { close: ({ to }) => to("closed") } },`,
  close: `close: ({ to }) => to("closed")`,
  unlock: `(event.code === data.code ? to("closed") : null)`,
  openType: "open: types<{ by: string }>()",
  pushType: "push: types<{ by: string }>(),",
  start: `start: ({ to }) => to("closed"),`,
  end: `(event.code === data.code ? to("closed") : null) } },\n  },\n});`,
  run: `run: async ({ data, signal }) => ({ type: "stored", id: await save(data.text, signal) }),`,
  error: `error: ({ error, to }) => to("failed", { error: String(error) }),`,
  stored: `stored: ({ event, to }) => to("saved", { id: event.id }),`,
  after: `after: { "20ms": ({ to }) => to("failed", { error: "timed out" }) },`,
};

/** A field added to `open`'s data, given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [O.openType, `open: types<{ by: string; ${field}: ${type} }>()`],
    [O.push, `push: ({ event, to }) => to("open", { by: event.by, ${field}: ${value} }),`],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** A field added to `saving`'s data, given by `save`. */
const savingWith = (field: string, type: string, value: string): Mutation =>
  edit(
    ["saving: types<{ text: string }>(),", `saving: types<{ text: string; ${field}: ${type} }>(),`],
    [`to("saving", { text: event.text })`, `to("saving", { text: event.text, ${field}: ${value} })`],
  );
const run = (body: string): Mutation => edit([O.run, `run: ${body},`]);
/** A task that posts the text and checks the response's status, then reads it. */
const fetched = (args: string, init: string, read: string): Mutation =>
  run(
    `async (${args}) => {\n          const res = await fetch("/api/save", ${init});\n          if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n          return { type: "stored", id: ${read} };\n        }`,
  );
const pushDoes = (effect: string): Mutation =>
  edit([O.push, `push: ({ event, to }) => (${effect}, to("open", { by: event.by })),`]);

/** Helpers the cases' files declare, the same in every library. */
export const HELPERS = {
  fallback: `let fallback = "0000";\nexport function setFallback(code: string): void {\n  fallback = code;\n}`,
  visitor: `class Visitor {\n  constructor(readonly name: string) {}\n  greet(): string {\n    return \`hi \${this.name}\`;\n  }\n}`,
  analytics: `const analytics = {\n  events: [] as string[],\n  track(name: string): void {\n    this.events.push(name);\n  },\n};`,
  stamp: "function stamp(code: string): string {\n  return `${code}@${Date.now()}`;\n}",
  /** A submit button's handler that awaits `send`, then reads whether the task ended. */
  submit: (saved: string) =>
    `export async function submit(text: string): Promise<boolean> {\n  await actor.send({ type: "save", text });\n  return ${saved};\n}`,
  label: (snapshot: string, state: string, by: string) =>
    `export function label(s: ReturnType<typeof ${snapshot}>): string {\n  switch (${state}) {\n    case "open":\n      return \`open, by \${${by}}\`;\n    default:\n      return "closed";\n  }\n}`,
};

const T = "Targets and data in a transition";
const C = "Contracts: data, payloads and input are JSON";
const E = "Events and sending";
const G = "The graph";
const K = "Tasks: run and error";
const D = "Timers, delays and timeouts";
const P = "Pure transitions";
const R = "Persistence";
const U = "Use sites and escape hatches";
const A = "React and app code";
const F = "Flows and modeling";
const H = "Migration habits (XState v4, v5 and v6 syntax)";

// The job's `idle` handler, its task as written, and the door's handlers changed in one place:
// helpers for the cases from M404 on.
const IDLE_SAVE = `save: ({ event, to }) => to("saving", { text: event.text })`;
const idleSave = (body: string): Mutation => edit([IDLE_SAVE, `save: ({ event, to }) => ${body}`]);
const TASK = `task: {\n        ${O.run}\n        ${O.error}\n      },`;
const pushTo = (data: string): Mutation => edit([O.push, `push: ({ event, to }) => to("open", ${data}),`]);
/** A task whose fetch checks the response's status: `init` is fetch's options, `before` runs first. */
const posted = (init: string, read: string, check = "if (!res.ok) throw new Error(`save failed: ${res.status}`);") =>
  run(
    `async ({ data, signal }) => {\n          const res = await fetch("/api/save", ${init});\n          ${check}\n          return { type: "stored", id: ${read} };\n        }`,
  );

export const CASES: readonly Case[] = [
  // Targets and data in a transition.
  {
    id: "M1",
    group: T,
    base: "door",
    name: "a misspelled target state",
    ours: edit([O.push, O.push.replace('"open"', '"opne"')]),
  },
  {
    id: "M2",
    group: T,
    base: "door",
    name: "a field the target state needs, left out",
    ours: edit([O.lock, `lock: ({ event, to }) => to("locked", {}),`]),
  },
  {
    id: "M3",
    group: T,
    base: "door",
    name: "data for a state that takes none",
    ours: edit([O.close, `close: ({ to }) => to("closed", {})`]),
  },
  {
    id: "M4",
    group: T,
    base: "door",
    name: "a field the target state doesn't have",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { by: event.by, at: 1 }),`]),
  },
  {
    id: "M5",
    group: T,
    base: "door",
    name: "an extra field through a spread",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { ...{ by: event.by, at: 1 } }),`]),
  },
  {
    id: "M6",
    group: T,
    base: "door",
    name: "an extra field through a variable",
    ours: edit([
      O.push,
      `push: ({ event, to }) => {\n          const next = { by: event.by, at: 1 };\n          return to("open", next);\n        },`,
    ]),
  },
  {
    id: "M7",
    group: T,
    base: "door",
    name: "a field of the wrong type",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { by: event.by.length }),`]),
  },
  {
    id: "M8",
    group: T,
    base: "door",
    name: "a block body that forgets `return`",
    ours: edit([O.push, `push: ({ event, to }) => { to("open", { by: event.by }); },`]),
  },
  {
    id: "M9",
    group: T,
    base: "door",
    name: "an async transition or guard",
    ours: edit([O.push, O.push.replace("({ event, to })", "async ({ event, to })")]),
  },
  {
    id: "M10",
    group: T,
    base: "door",
    name: "editing data in place",
    ours: edit([O.unlock, `((data.code = event.code), to("closed"))`]),
  },
  {
    id: "M12",
    group: T,
    base: "door",
    name: "data only another state has",
    ours: edit([O.lock, `lock: ({ data, to }) => to("locked", { code: data.code }),`]),
  },
  {
    id: "M13",
    group: T,
    base: "door",
    name: "a payload field the event doesn't carry",
    ours: edit([O.push, O.push.replace("event.by", "event.name")]),
  },
  {
    id: "M14",
    group: T,
    base: "door",
    name: "an index read as present",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { by: event.by.split(" ")[0] }),`]),
  },
  {
    id: "M15",
    group: T,
    base: "door",
    name: "undefined for a required field",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { by: undefined }),`]),
  },

  // Contracts: what a snapshot can hold, so it can be saved and restored.
  {
    id: "M16",
    group: C,
    base: "door",
    name: "a Date in data and payload",
    ours: edit(["by: string", "by: Date", "all"]),
  },
  {
    id: "M17",
    group: C,
    base: "door",
    name: "a Date in a payload",
    ours: edit(
      [O.pushType, "push: types<{ by: Date }>(),"],
      [O.push, `push: ({ event, to }) => to("open", { by: String(event.by) }),`],
    ),
  },
  {
    id: "M18",
    group: C,
    base: "door",
    name: "`any` in data and payload",
    ours: edit(["by: string", "by: any", "all"]),
  },
  {
    id: "M19",
    group: C,
    base: "door",
    name: "`unknown` in data and payload",
    ours: edit(["code: string", "code: unknown", "all"]),
  },
  {
    id: "M20",
    group: C,
    base: "door",
    name: "an index signature in data",
    ours: edit([O.openType, "open: types<{ [key: string]: string }>()"]),
  },
  { id: "M21", group: C, base: "door", name: "`{}` for a field", ours: edit(["by: string", "by: {}", "all"]) },
  { id: "M22", group: C, base: "door", name: "`object` for a field", ours: edit(["by: string", "by: object", "all"]) },
  {
    id: "M23",
    group: C,
    base: "door",
    name: "a tuple in data",
    ours: edit(["code: string", "code: [string, string]", "all"]),
  },
  {
    id: "M24",
    group: C,
    base: "door",
    name: "a payload field named `type`",
    ours: edit([O.pushType, "push: types<{ by: string; type: string }>(),"]),
  },
  {
    id: "M25",
    group: C,
    base: "job",
    name: "an AbortController in data",
    ours: savingWith("controller", "AbortController", "new AbortController()"),
  },
  {
    id: "M26",
    group: C,
    base: "job",
    name: "a Promise in data",
    ours: savingWith("pending", "Promise<string>", "Promise.resolve(event.text)"),
  },
  {
    id: "M27",
    group: C,
    base: "door",
    name: "a File in data",
    ours: openWith("note", "File", 'new File([event.by], "note.txt")'),
  },
  {
    id: "M28",
    group: C,
    base: "door",
    name: "a class instance with methods in data",
    ours: openWith("visitor", "Visitor", "new Visitor(event.by)", HELPERS.visitor),
  },
  {
    id: "M29",
    group: C,
    base: "door",
    name: "a bigint in data",
    ours: openWith("visits", "bigint", "BigInt(event.by.length)"),
  },
  {
    id: "M30",
    group: C,
    base: "door",
    name: "a Set in data",
    ours: openWith("seen", "Set<string>", "new Set([event.by])"),
  },
  {
    id: "M31",
    group: C,
    base: "door",
    name: "a Map in data",
    ours: openWith("byId", "Map<string, string>", 'new Map([["by", event.by]])'),
  },
  {
    id: "M32",
    group: C,
    base: "door",
    name: "a DOM event in a payload",
    ours: edit([O.pushType, "push: types<{ by: string; click: MouseEvent }>(),"]),
  },
  {
    id: "M33",
    group: C,
    base: "door",
    name: "a DOM node in data",
    ours: edit(
      [O.pushType, "push: types<{ by: string; button: HTMLElement }>(),"],
      [O.openType, "open: types<{ by: string; button: HTMLElement }>()"],
      [O.push, `push: ({ event, to }) => to("open", { by: event.by, button: event.button }),`],
    ),
  },
  {
    id: "M34",
    group: C,
    base: "door",
    name: "a field typed `string | undefined`",
    ours: openWith("note", "string | undefined", 'event.by === "" ? undefined : event.by'),
  },
  {
    id: "M41",
    group: C,
    base: "door",
    name: "a flag repeating the state",
    ours: openWith("isOpen", "boolean", "true"),
  },

  // Events and sending.
  {
    id: "M43",
    group: E,
    base: "door",
    name: "sending an event that doesn't exist",
    ours: append(`actor.send({ type: "kick" });`),
  },
  {
    id: "M44",
    group: E,
    base: "door",
    name: "sending an event without its payload",
    ours: append(`actor.send({ type: "push" });`),
  },
  {
    id: "M45",
    group: E,
    base: "door",
    name: "a payload field of the wrong type, sent",
    ours: append(`actor.send({ type: "push", by: 1 });`),
  },
  {
    id: "M46",
    group: E,
    base: "door",
    name: "a payload field the event doesn't have, sent",
    ours: append(`actor.send({ type: "push", by: "ann", at: 1 });`),
  },
  {
    id: "M47",
    group: E,
    base: "job",
    name: "sending a task's result from outside",
    ours: append(`actor.send({ type: "stored", id: "forged" });`),
  },
  {
    id: "M48",
    group: E,
    base: "door",
    name: "a misspelled event in `on`",
    ours: edit([O.push, O.push.replace("push:", "psuh:")]),
  },
  {
    id: "M49",
    group: E,
    base: "door",
    name: "sending an event no current state handles, the result ignored",
    ours: append(`actor.send({ type: "close" });`),
  },
  {
    id: "M50",
    group: E,
    base: "door",
    name: "sending after the actor stopped",
    ours: append(`actor.stop();\nactor.send({ type: "push", by: "ann" });`),
  },
  {
    id: "M52",
    group: E,
    base: "door",
    name: "a listener that throws",
    ours: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
  },
  {
    id: "M53",
    group: E,
    base: "job",
    name: "awaiting `send`, expecting the task to have ended",
    ours: append(HELPERS.submit(`actor.snapshot().state === "saved"`)),
  },
  {
    id: "M55",
    group: E,
    base: "door",
    name: "an event with a reserved name",
    ours: na("no event name is reserved (route only with route in use)"),
  },

  // The graph.
  { id: "M56", group: G, base: "door", name: "a declared state left out", ours: edit([O.open, ""]) },
  {
    id: "M57",
    group: G,
    base: "door",
    name: "a state the declared states lack",
    ours: edit([O.open, `${O.open}\n    broken: { on: { close: ({ to }) => to("closed") } },`]),
  },
  { id: "M58", group: G, base: "door", name: "a state nothing goes to", ours: edit([O.lock, ""]) },
  { id: "M59", group: G, base: "door", name: "a non-final state nothing leaves", ours: edit([O.open, "open: {},"]) },
  {
    id: "M60",
    group: G,
    base: "job",
    name: "a final state with handlers",
    ours: edit(["saved: { final: true },", `saved: { final: true, on: { retry: ({ to }) => to("idle") } },`]),
  },
  {
    id: "M62",
    group: G,
    base: "door",
    name: "a declared event no state handles",
    ours: edit(["close: types<{}>(),", "close: types<{}>(),\n    kick: types<{}>(),"]),
  },
  {
    id: "M63",
    group: G,
    base: "job",
    name: "a declared task result no task produces",
    ours: edit([
      "internal: { stored: types<{ id: string }>() },",
      "internal: { stored: types<{ id: string }>(), lost: types<{}>() },",
    ]),
  },
  {
    id: "M64",
    group: G,
    base: "job",
    name: "a task result handled where no task produces it",
    ours: edit([
      `idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },`,
      `idle: {\n      on: {\n        save: ({ event, to }) => to("saving", { text: event.text }),\n        stored: ({ event, to }) => to("saved", { id: event.id }),\n      },\n    },`,
    ]),
  },

  // Tasks.
  { id: "M65", group: K, base: "job", name: "a task with no failure path", ours: edit([O.error, ""]) },
  { id: "M66", group: K, base: "job", name: "a task whose result nothing handles", ours: edit([O.stored, ""]) },
  {
    id: "M67",
    group: K,
    base: "job",
    name: "a task resolving to an event nobody declared",
    ours: edit([O.run, O.run.replace('"stored"', '"done"')]),
  },
  {
    id: "M68",
    group: K,
    base: "job",
    name: "a catch in the task that logs and returns nothing",
    ours: run(
      `async ({ data, signal }) => {\n          try {\n            return { type: "stored", id: await save(data.text, signal) };\n          } catch (e) {\n            console.error(e);\n          }\n        }`,
    ),
  },
  {
    id: "M69",
    group: K,
    base: "job",
    name: "`error.message` on an unknown error",
    ours: edit([O.error, `error: ({ error, to }) => to("failed", { error: error.message }),`]),
  },
  {
    id: "M70",
    group: K,
    base: "job",
    name: "the unknown error itself as data",
    ours: edit([O.error, `error: ({ error, to }) => to("failed", { error }),`]),
  },
  {
    id: "M71",
    group: K,
    base: "job",
    name: "a failure handler that declines an abort",
    ours: edit([
      O.error,
      `error: ({ error, to }) =>\n          error instanceof DOMException && error.name === "AbortError" ? null : to("failed", { error: String(error) }),`,
    ]),
  },
  {
    id: "M72",
    group: K,
    base: "job",
    name: "the task reading the event that entered the state",
    ours: run(`async ({ event, signal }) => ({ type: "stored", id: await save(event.text, signal) })`),
  },
  {
    id: "M73",
    group: K,
    base: "job",
    name: "a fetch not given the task's signal",
    ours: fetched("{ data }", `{ method: "POST", body: data.text }`, "await res.text()"),
  },
  {
    id: "M74",
    group: K,
    base: "job",
    name: "an AbortController of its own, for a timeout",
    ours: run(
      `async ({ data }) => {\n          const c = new AbortController();\n          setTimeout(() => c.abort(), 5000);\n          return { type: "stored", id: await save(data.text, c.signal) };\n        }`,
    ),
  },
  {
    id: "M75",
    group: K,
    base: "job",
    name: "a `timeout` option to fetch",
    ours: fetched("{ data, signal }", `{ method: "POST", body: data.text, signal, timeout: 5000 }`, "await res.text()"),
  },
  {
    id: "M76",
    group: K,
    base: "job",
    name: "a catch in the task that resolves to success",
    ours: run(
      `async ({ data, signal }) => {\n          try {\n            return { type: "stored", id: await save(data.text, signal) };\n          } catch {\n            return { type: "stored", id: "" };\n          }\n        }`,
    ),
  },
  {
    id: "M77",
    group: K,
    base: "job",
    name: "a response read without checking its status",
    ours: run(
      `async ({ data, signal }) => ({\n          type: "stored",\n          id: await (await fetch("/api/save", { method: "POST", body: data.text, signal })).text(),\n        })`,
    ),
  },
  {
    id: "M78",
    group: K,
    base: "job",
    name: "`res.json()`'s any in the task's result",
    ours: fetched("{ data, signal }", `{ method: "POST", body: data.text, signal }`, "(await res.json()).id"),
  },
  {
    id: "M79",
    group: K,
    base: "job",
    name: "a cast in the task's result",
    ours: fetched("{ data, signal }", `{ method: "POST", body: data.text, signal }`, "(await res.json()) as string"),
  },
  {
    id: "M80",
    group: K,
    base: "job",
    name: "a promise in the task not awaited",
    ours: run(
      `async ({ data, signal }) => {\n          save(data.text, signal);\n          return { type: "stored", id: data.text };\n        }`,
    ),
  },
  {
    id: "M81",
    group: K,
    base: "job",
    name: "`forEach(async …)` in the task",
    ours: run(
      `async ({ data, signal }) => {\n          data.text.split(",").forEach(async (part) => {\n            await save(part, signal);\n          });\n          return { type: "stored", id: data.text };\n        }`,
    ),
  },
  {
    id: "M82",
    group: K,
    base: "job",
    name: "a string thrown in the task",
    ours: run(
      `async ({ data, signal }) => {\n          if (data.text === "") throw "empty";\n          return { type: "stored", id: await save(data.text, signal) };\n        }`,
    ),
  },
  {
    id: "M83",
    group: K,
    base: "job",
    name: "a socket in the task that is never closed",
    ours: run(
      `({ data }) =>\n          new Promise<{ readonly type: "stored"; readonly id: string }>((resolve) => {\n            const socket = new WebSocket("ws://localhost:1/save");\n            socket.onopen = () => socket.send(data.text);\n            socket.onmessage = (m) => resolve({ type: "stored", id: String(m.data) });\n          })`,
    ),
  },
  {
    id: "M84",
    group: K,
    base: "job",
    name: "a setInterval in the task, never cleared",
    ours: run(
      `async ({ data, signal }) => {\n          setInterval(() => void save(data.text, signal), 1000);\n          return { type: "stored", id: data.text };\n        }`,
    ),
  },
  {
    id: "M87",
    group: K,
    base: "job",
    name: "a new request as a move to the same state, expecting the task to restart",
    ours: edit([
      `cancel: ({ to }) => to("idle"),`,
      `cancel: ({ to }) => to("idle"),\n        save: ({ event, to }) => to("saving", { text: event.text }),`,
    ]),
  },

  // Timers.
  { id: "M88", group: D, base: "job", name: "a timer with a malformed duration", ours: edit(['"20ms"', '"20 msec"']) },
  {
    id: "M89",
    group: D,
    base: "job",
    name: "a timer in a unit the library doesn't take",
    ours: edit(['"20ms"', '"1d"']),
  },
  {
    id: "M90",
    group: D,
    base: "job",
    name: "a timer as a bare number",
    ours: edit(['after: { "20ms":', "after: { 20:"]),
  },
  {
    id: "M96",
    group: D,
    base: "job",
    name: "a timer reading the event",
    ours: edit([O.after, 'after: { "20ms": ({ event, to }) => to("failed", { error: `timed out: ${event.text}` }) },']),
  },
  {
    id: "M104",
    group: D,
    base: "job",
    name: "a retry as a timer's move to the same state",
    ours: edit([O.after, `after: { "20ms": ({ data, to }) => to("saving", data) },`]),
  },

  // Pure transitions.
  {
    id: "M116",
    group: P,
    base: "door",
    name: "reading the clock in a transition",
    ours: edit([O.lock, O.lock.replace("event.code", "String(Date.now())")]),
  },
  {
    id: "M117",
    group: P,
    base: "door",
    name: "randomness in a transition",
    ours: edit([O.lock, O.lock.replace("event.code", "String(Math.random())")]),
  },
  {
    id: "M119",
    group: P,
    base: "door",
    name: "an id from crypto in a transition",
    ours: edit([O.lock, O.lock.replace("event.code", "crypto.randomUUID()")]),
  },
  {
    id: "M120",
    group: P,
    base: "door",
    name: "reading a module-level `let` in a transition",
    ours: { ...edit([O.lock, O.lock.replace("event.code }", "event.code || fallback }")]), prepend: HELPERS.fallback },
  },
  {
    id: "M121",
    group: P,
    base: "door",
    name: "writing module state in a transition",
    ours: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
  },
  {
    id: "M122",
    group: P,
    base: "door",
    name: "a mutating method on module state in a transition",
    ours: { ...pushDoes("log.push(event.by)"), prepend: "const log: string[] = [];" },
  },
  {
    id: "M123",
    group: P,
    base: "door",
    name: "`delete` on module state in a transition",
    ours: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
  },
  {
    id: "M124",
    group: P,
    base: "door",
    name: "another object spread into data",
    ours: {
      ...edit([O.push, `push: ({ event, to }) => to("open", { ...defaults, by: event.by }),`]),
      prepend: `const defaults = { by: "guest" };`,
    },
  },
  {
    id: "M125",
    group: P,
    base: "door",
    name: "data from a helper, with keys its type doesn't list",
    ours: {
      ...edit([O.push, `push: ({ event, to }) => to("open", withBy(event.by)),`]),
      prepend: "function withBy(by: string): { by: string } {\n  const out = { by, at: Date.now() };\n  return out;\n}",
    },
  },
  {
    id: "M126",
    group: P,
    base: "door",
    name: "`new` in a transition",
    ours: edit([O.lock, O.lock.replace("event.code }", '[...new Set(event.code)].join("") }')]),
  },
  {
    id: "M127",
    group: P,
    base: "door",
    name: "`import.meta` in a transition",
    ours: edit([O.lock, O.lock.replace("event.code }", "import.meta.env.DOOR_CODE ?? event.code }")]),
  },
  {
    id: "M128",
    group: P,
    base: "door",
    name: "a cast that hides missing data",
    ours: edit([O.lock, `lock: ({ event, to }) => to("locked", {} as { code: string }),`]),
  },
  {
    id: "M128b",
    group: P,
    base: "job",
    name: "`error as Error` in the failure handler",
    ours: edit([O.error, `error: ({ error, to }) => to("failed", { error: (error as Error).message }),`]),
  },
  {
    id: "M129",
    group: P,
    base: "door",
    name: "a non-null assertion in a transition",
    ours: edit([O.push, `push: ({ event, to }) => to("open", { by: event.by.split(" ")[0]! }),`]),
  },
  {
    id: "M130",
    group: P,
    base: "door",
    name: "`console.log` in a transition",
    ours: pushDoes(`console.log("pushed by", event.by)`),
  },
  {
    id: "M131",
    group: P,
    base: "door",
    name: "a fetch in a transition",
    ours: pushDoes(`void fetch("/api/audit", { method: "POST", body: event.by }).catch(() => {})`),
  },
  {
    id: "M132",
    group: P,
    base: "door",
    name: "a setTimeout in a transition",
    ours: edit([
      O.lock,
      `lock: ({ event, to }) => (setTimeout(() => console.info("relock"), 1000), to("locked", { code: event.code })),`,
    ]),
  },
  {
    id: "M133",
    group: P,
    base: "door",
    name: "localStorage in a transition",
    ours: edit([O.lock, O.lock.replace("event.code }", 'localStorage.getItem("door-code") ?? event.code }')]),
  },
  {
    id: "M134",
    group: P,
    base: "door",
    name: "`process.env` in a transition",
    ours: edit([O.lock, O.lock.replace("event.code }", "process.env.DOOR_CODE ?? event.code }")]),
  },
  {
    id: "M135",
    group: P,
    base: "door",
    name: "a @ts-expect-error over a broken transition",
    ours: edit([O.push, `// @ts-expect-error\n        ${O.push.replace('"open"', '"opne"')}`]),
  },
  {
    id: "M135b",
    group: P,
    base: "door",
    name: "a @ts-ignore over a broken transition",
    ours: edit([O.push, `// @ts-ignore\n        ${O.push.replace('"open"', '"opne"')}`]),
  },
  {
    id: "M135c",
    group: P,
    base: "door",
    name: "@ts-nocheck in a file with a broken transition",
    ours: edit(
      ["// A machine of plain transitions", "// @ts-nocheck\n// A machine of plain transitions"],
      [O.push, O.push.replace('"open"', '"opne"')],
    ),
  },
  {
    id: "M136",
    group: P,
    base: "door",
    name: "a module object's method called in a transition",
    ours: {
      ...edit([O.close, `close: ({ to }) => (analytics.track("closed"), to("closed"))`]),
      prepend: HELPERS.analytics,
    },
  },
  {
    id: "M137",
    group: P,
    base: "door",
    name: "an imported function called in a transition",
    ours: {
      ...edit([O.close, `close: ({ to }) => (track("closed"), to("closed"))`]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
  },
  {
    id: "M138",
    group: P,
    base: "door",
    name: "a same-file function that reads the clock, called in a transition",
    ours: { ...edit([O.lock, O.lock.replace("event.code }", "stamp(event.code) }")]), prepend: HELPERS.stamp },
  },
  {
    id: "M139",
    group: P,
    base: "door",
    name: "an array as a condition",
    ours: edit([O.unlock, `(data.code.split(",").filter((c) => c === event.code) ? to("closed") : null)`]),
  },

  // Persistence.
  {
    id: "M259",
    group: R,
    base: "door",
    name: "a snapshot given to createActor",
    ours: append("export const again = createActor(doorMachine, { snapshot: actor.snapshot() });"),
  },
  {
    id: "M261",
    group: R,
    base: "door",
    name: "restoring an unchecked `JSON.parse`",
    ours: append(
      `import { restoreActor } from "@reactre/state";\nconst saved = JSON.stringify(actor.snapshot());\nexport const restored = restoreActor(doorMachine, JSON.parse(saved));`,
    ),
  },
  {
    id: "M265",
    group: R,
    base: "job",
    name: "persisting the live snapshot",
    ours: na("a snapshot is JSON by type: nothing live to leave out"),
  },

  // Use sites.
  {
    id: "M297",
    group: U,
    base: "door",
    name: "reading a state's data before narrowing",
    ours: append("export const len = actor.snapshot().data.by.length;"),
  },
  {
    id: "M298",
    group: U,
    base: "door",
    name: "checking for a state that doesn't exist",
    ours: append(`export const is = actor.snapshot().state === "opened";`),
  },
  {
    id: "M300",
    group: U,
    base: "door",
    name: "a misspelled machine option",
    ours: edit(["version: 2,", "verison: 2,"]),
  },
  {
    id: "M301",
    group: U,
    base: "door",
    name: "`can` given an event's name",
    ours: append(
      `import { can } from "@reactre/state/utils";\nexport const canClose = can(doorMachine, actor.snapshot(), "close");`,
    ),
  },
  {
    id: "M304",
    group: U,
    base: "door",
    name: "the machine cast to any where it's used",
    ours: edit(["createActor(doorMachine)", "createActor(doorMachine as any)"]),
  },
  {
    id: "M305",
    group: U,
    base: "door",
    name: "a cast on a snapshot's data",
    ours: append("export const by = (actor.snapshot().data as { by?: string }).by;"),
  },
  {
    id: "M305b",
    group: U,
    base: "door",
    name: "a non-null assertion on a snapshot's data",
    ours: append(`actor.subscribe((s) => {\n  if (s.state === "open") console.info(s.data.by!.toUpperCase());\n});`),
  },
  {
    id: "M307",
    group: U,
    base: "door",
    name: "a field made optional to quiet an error",
    ours: edit(
      ["locked: types<{ code: string }>()", "locked: types<{ code?: string }>()"],
      [O.lock, `lock: ({ to }) => to("locked", {}),`],
    ),
  },
  {
    id: "M308",
    group: U,
    base: "door",
    name: "a switch over the states with a default for the rest",
    ours: append(HELPERS.label("actor.snapshot", "s.state", "s.data.by")),
  },

  // Migration habits.
  { id: "M344", group: H, base: "door", name: "a string target (v4 habit)", ours: edit([O.close, `close: "closed"`]) },
  {
    id: "M345",
    group: H,
    base: "door",
    name: "a `guard` on a transition (v5 habit)",
    ours: edit([O.close, `close: { target: "closed", guard: "isOpen" }`]),
  },
  {
    id: "M345b",
    group: H,
    base: "door",
    name: "`actions` on a transition (v5 habit)",
    ours: edit([O.close, `close: { target: "closed", actions: "log" }`]),
  },
  {
    id: "M345c",
    group: H,
    base: "door",
    name: "`cond` on a transition (v4 habit)",
    ours: edit([O.close, `close: { target: "closed", cond: "isOpen" }`]),
  },
  {
    id: "M345d",
    group: H,
    base: "door",
    name: "`in` on a transition (v4 habit)",
    ours: edit([O.close, `close: { target: "closed", in: "open" }`]),
  },
  {
    id: "M346",
    group: H,
    base: "door",
    name: "a transition array (v5 habit)",
    ours: edit([O.push, `push: [{ target: "open" }, { target: "locked" }],`]),
  },
  {
    id: "M347",
    group: H,
    base: "door",
    name: 'the null event `""` (v4 habit)',
    ours: edit([O.open, `open: { on: { close: ({ to }) => to("closed"), "": ({ to }) => to("closed") } },`]),
  },
  {
    id: "M348",
    group: H,
    base: "door",
    name: "declining with `undefined` (v6 habit)",
    ours: edit([O.unlock, `(event.code === data.code ? to("closed") : undefined)`]),
  },
  {
    id: "M350",
    group: H,
    base: "door",
    name: "`initial` in the machine (XState habit)",
    ours: edit([O.start, `initial: "closed",`]),
  },
  {
    id: "M351",
    group: H,
    base: "door",
    name: "`context` in the machine (XState habit)",
    ours: edit([O.start, `context: {},\n  ${O.start}`]),
  },
  {
    id: "M352",
    group: H,
    base: "door",
    name: "`id` in the machine (XState habit)",
    ours: edit([O.start, `id: "door",\n  ${O.start}`]),
  },
  {
    id: "M353",
    group: H,
    base: "job",
    name: "a final state marked the other library's way",
    ours: edit(["saved: { final: true },", `saved: { type: "final" },`]),
  },
  {
    id: "M354",
    group: H,
    base: "door",
    name: "`invoke` on a state (XState habit)",
    ours: edit([O.open, `open: { invoke: { src: "audit" }, on: { close: ({ to }) => to("closed") } },`]),
  },
  {
    id: "M355",
    group: H,
    base: "door",
    name: "`activities` on a state (v4 habit)",
    ours: edit(["closed: {\n      on: {", `closed: {\n      activities: ["beep"],\n      on: {`]),
  },
  {
    id: "M356",
    group: H,
    base: "door",
    name: "`predictableActionArguments` (v4 habit)",
    ours: edit([O.start, `predictableActionArguments: true,\n  ${O.start}`]),
  },
  {
    id: "M357",
    group: H,
    base: "door",
    name: "`types: {} as …` in setup (v5 habit)",
    ours: edit(["version: 2,", "version: 2,\n  types: {} as { context: { by: string | null } },"]),
  },
  {
    id: "M358",
    group: H,
    base: "door",
    name: "an implementations argument to the machine (v5 habit)",
    ours: edit([O.end, `(event.code === data.code ? to("closed") : null) } },\n  },\n}, { actions: {} });`]),
  },
  {
    id: "M362",
    group: H,
    base: "door",
    name: "v5's guard combinators",
    ours: append(`import { and } from "@reactre/state";\nexport const both = and(["isAdmin", "isActive"]);`),
  },
  {
    id: "M363",
    group: H,
    base: "door",
    name: "v5's `assign`",
    ours: {
      ...edit([O.push, `push: { target: "open", actions: assign(({ event }) => ({ by: event.by })) },`]),
      prepend: `import { assign } from "@reactre/state";`,
    },
  },
  {
    id: "M364",
    group: H,
    base: "door",
    name: "v4's `interpret`",
    ours: append(`import { interpret } from "@reactre/state";\nexport const service = interpret(doorMachine);`),
  },
  {
    id: "M366",
    group: H,
    base: "job",
    name: "v5's `fromPromise`",
    ours: {
      prepend: `import { fromPromise } from "@reactre/state/logic";`,
      append: "export const saver = fromPromise(async ({ input }: { input: { text: string } }) => input.text);",
    },
  },
  {
    id: "M367",
    group: H,
    base: "door",
    name: "a hallucinated export",
    ours: append(`import { invoke } from "@reactre/state";\nexport const loader = invoke({ src: "fetchUser" });`),
  },
  { id: "M368", group: H, base: "door", name: "a string event (v4 habit)", ours: append(`actor.send("push");`) },
  { id: "M369", group: H, base: "door", name: "`start()` where it doesn't belong", ours: append("actor.start();") },
  {
    id: "M370",
    group: H,
    base: "door",
    name: "`onTransition` (v4 habit)",
    ours: append("actor.onTransition(() => {});"),
  },
  {
    id: "M371",
    group: H,
    base: "door",
    name: "`snapshot.done` (v4 habit)",
    ours: append("export const done = actor.snapshot().done;"),
  },
  {
    id: "M372",
    group: H,
    base: "door",
    name: "`snapshot.value` (XState habit)",
    ours: append("export const value = actor.snapshot().value;"),
  },
  {
    id: "M373",
    group: H,
    base: "door",
    name: "`snapshot.matches` (XState habit)",
    ours: append(`export const isOpen = actor.snapshot().matches("open");`),
  },
  {
    id: "M374",
    group: H,
    base: "door",
    name: "`machine.withConfig` (v4 habit)",
    ours: append("export const configured = doorMachine.withConfig({});"),
  },
  {
    id: "M375",
    group: H,
    base: "door",
    name: "a `context` option to createActor (v4 habit)",
    ours: append(`export const preset = createActor(doorMachine, { context: { by: "ann" } });`),
  },

  // From M404 on: the second research round (other libraries' issues, LLM TypeScript habits, app
  // workflows, statechart features and use sites). Each is silent in @reactre/state until its rule
  // in ../MISTAKES.md lands, unless the row says it is caught already.

  // Targets and data in a transition.
  {
    id: "M404",
    group: T,
    base: "door",
    name: "a step built in a block and not returned (the handler returns null; `open` can lock too)",
    ours: edit(
      [
        O.lock,
        `lock: ({ event, to }) => {\n          if (event.code !== "") to("locked", { code: event.code });\n          return null;\n        },`,
      ],
      [
        O.open,
        `open: { on: { close: ({ to }) => to("closed"), lock: ({ event, to }) => to("locked", { code: event.code }) } },`,
      ],
    ),
  },
  {
    id: "M405",
    group: T,
    base: "door",
    name: "a guard's 'no' branch that stays with the same data instead of declining",
    ours: edit([
      `locked: { on: { unlock: ({ data, event, to }) => ${O.unlock} } },`,
      `locked: { on: { unlock: ({ data, event, keep, to }) => (event.code === data.code ? to("closed") : keep("locked", data)) } },`,
    ]),
  },
  {
    id: "M406",
    group: T,
    base: "door",
    name: "a getter in the data object a transition builds",
    ours: pushTo("{\n            get by() {\n              return event.by;\n            },\n          }"),
  },
  {
    id: "M407",
    group: T,
    base: "door",
    name: "staying (`keep`) in a state other than the one the handler is in",
    ours: edit([O.open, `open: { on: { close: ({ keep }) => keep("closed") } },`]),
  },
  {
    id: "M408",
    group: T,
    base: "door",
    name: "the start handler declining (returns null)",
    ours: edit([O.start, "start: () => null,"]),
  },
  {
    id: "M409",
    group: T,
    base: "door",
    name: "the start handler reading an event (there is none at start)",
    ours: edit([O.start, `start: ({ event, to }) => (event === undefined ? to("closed") : to("closed")),`]),
  },
  {
    id: "M410",
    group: T,
    base: "door",
    name: "the old state's data object mutated with Object.assign to build the new one",
    ours: edit([O.lock, `lock: ({ data, event, to }) => to("locked", Object.assign(data, { code: event.code })),`]),
  },
  {
    id: "M411",
    group: T,
    base: "job",
    name: "a task's error handler returning an event object instead of a step",
    ours: edit([O.error, `error: ({ error }) => ({ type: "failed", error: String(error) }),`]),
  },
  {
    id: "M412",
    group: T,
    base: "door",
    name: "the same event handled twice in one state's handlers (the second wins)",
    ours: edit([O.lock, `${O.lock}\n        push: ({ event, to }) => to("open", { by: event.by.trim() }),`]),
  },
  {
    id: "M413",
    group: T,
    base: "door",
    name: "`return null` inside a forEach callback, meant to decline the event",
    ours: edit([
      O.lock,
      `lock: ({ event, to }) => {\n          event.code.split("").forEach((c) => {\n            if (c === " ") return null;\n          });\n          return to("locked", { code: event.code });\n        },`,
    ]),
  },
  {
    id: "M414",
    group: T,
    base: "door",
    name: "JSON.parse in a transition: an `any` value in the new state's data",
    ours: pushTo('{ by: JSON.parse(`"${event.by}"`) }'),
  },

  // Contracts.
  {
    id: "M416",
    group: C,
    base: "door",
    name: "an event declared with a `void` payload instead of `{}`",
    ours: edit(["close: types<{}>(),", "close: types<void>(),"]),
  },
  {
    id: "M417",
    group: C,
    base: "door",
    name: "a symbol-keyed field in a state's data (JSON drops it)",
    ours: {
      prepend: `const OPENED: unique symbol = Symbol("opened");`,
      edits: [
        [O.openType, "open: types<{ by: string; [OPENED]: boolean }>()"],
        [O.push, `push: ({ event, to }) => to("open", { by: event.by, [OPENED]: true }),`],
      ],
    },
  },
  {
    id: "M418",
    group: C,
    base: "door",
    name: "an event named after an Object.prototype member (`toString`)",
    // Beside `close`, not instead of it: the app still sends `close`, and a rename would make
    // the scenario's own send the thing a checker reports.
    ours: edit(
      ["close: types<{}>(),", "close: types<{}>(),\n    toString: types<{}>(),"],
      [
        `open: { on: { close: ({ to }) => to("closed") } }`,
        `open: { on: { close: ({ to }) => to("closed"), toString: ({ to }) => to("closed") } }`,
      ],
    ),
  },
  {
    id: "M419",
    group: C,
    base: "door",
    name: "a state with a numeric name (`2`)",
    ours: edit(
      ["locked: types<{ code: string }>()", "2: types<{ code: string }>()"],
      [O.lock, `lock: ({ event, to }) => to("2", { code: event.code }),`],
      ["    locked: { on:", "    2: { on:"],
    ),
  },
  {
    id: "M420",
    group: C,
    base: "door",
    name: "two event names that differ only by case (`close`, `Close`)",
    ours: edit(
      ["close: types<{}>(),", "close: types<{}>(),\n    Close: types<{}>(),"],
      [O.open, `open: { on: { close: ({ to }) => to("closed"), Close: ({ to }) => to("closed") } },`],
    ),
  },
  {
    id: "M421",
    group: C,
    base: "job",
    name: "one name for a sent event and a task's internal event",
    ours: edit(["retry: types<{}>() },", "retry: types<{}>(), stored: types<{ id: string }>() },"]),
  },
  {
    id: "M422",
    group: C,
    base: "door",
    name: "an event name with `*` in it",
    ours: edit(
      ["close: types<{}>(),", `close: types<{}>(),\n    "close*": types<{}>(),`],
      [
        `open: { on: { close: ({ to }) => to("closed") } }`,
        `open: { on: { close: ({ to }) => to("closed"), "close*": ({ to }) => to("closed") } }`,
      ],
    ),
  },
  {
    id: "M423",
    group: C,
    base: "job",
    name: "a field typed `never[]` (an empty array's type)",
    ours: savingWith("tags", "never[]", "[]"),
  },
  {
    id: "M424",
    group: C,
    base: "door",
    name: 'a literal union widened by its own primitive (`"ann" | string`)',
    ours: edit([O.openType, `open: types<{ by: "ann" | "bob" | string }>()`]),
  },
  {
    id: "M425",
    group: C,
    base: "door",
    name: "a data field named `constructor`",
    ours: openWith("constructor", "string", "event.by"),
  },
  {
    id: "M426",
    group: C,
    base: "door",
    name: "a TypeScript enum in a contract",
    ours: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [O.openType, "open: types<{ by: Visitor }>()"],
        [O.pushType, "push: types<{ by: Visitor }>(),"],
      ],
    },
  },
  {
    id: "M427",
    group: C,
    base: "door",
    name: "a version that isn't a whole number",
    ours: edit(["version: 2,", "version: 2.5,"]),
  },
  {
    id: "M428",
    group: C,
    base: "door",
    name: "`types<T>` without its call",
    ours: edit([O.openType, "open: types<{ by: string }>"]),
  },

  // Events and sending.
  {
    id: "M429",
    group: E,
    base: "door",
    name: "sending an event typed `any` (parsed from a message)",
    ours: append(`export const pushed = actor.send(JSON.parse('{ "type": "push", "by": "ann" }')).ok;`),
  },

  // The graph.
  {
    id: "M432",
    group: G,
    base: "job",
    name: "a state whose task can hang: no timer, no event that leaves it",
    ours: edit(
      [O.after, ""],
      [`        cancel: ({ to }) => to("idle"),\n`, ""],
      [
        `failed: { on: { retry: ({ to }) => to("idle") } },`,
        `failed: { on: { retry: ({ to }) => to("idle"), cancel: ({ to }) => to("idle") } },`,
      ],
    ),
  },
  {
    id: "M433",
    group: G,
    base: "job",
    name: "a final state with a timer",
    ours: edit(["saved: { final: true },", `saved: { final: true, after: { "1s": ({ to }) => to("idle") } },`]),
  },
  {
    id: "M434",
    group: G,
    base: "door",
    name: "a handler written beside `on` instead of inside it",
    ours: edit(["    closed: {\n      on: {", '    closed: {\n      close: ({ to }) => to("closed"),\n      on: {']),
  },

  // Tasks.
  {
    id: "M437",
    group: K,
    base: "job",
    name: "a task's run returning a step (`to`) instead of an event",
    ours: run(`async ({ data, signal, to }) => to("saved", { id: await save(data.text, signal) })`),
  },
  {
    id: "M438",
    group: K,
    base: "job",
    name: "a sleep (setTimeout) inside the task",
    ours: run(
      `async ({ data, signal }) => {\n          await new Promise((resolve) => setTimeout(resolve, 5));\n          return { type: "stored", id: await save(data.text, signal) };\n        }`,
    ),
  },
  {
    id: "M439",
    group: K,
    base: "job",
    name: "AbortSignal.timeout given to fetch instead of the task's signal",
    ours: posted(`{ method: "POST", body: data.text, signal: AbortSignal.timeout(5000) }`, "await res.text()"),
  },
  {
    id: "M440",
    group: K,
    base: "job",
    name: "fetch's options in a variable, without the task's signal",
    ours: run(
      'async ({ data }) => {\n          const init = { method: "POST", body: data.text };\n          const res = await fetch("/api/save", init);\n          if (!res.ok) throw new Error(`save failed: ${res.status}`);\n          return { type: "stored", id: await res.text() };\n        }',
    ),
  },
  {
    id: "M441",
    group: K,
    base: "job",
    name: "a helper in the same file that fetches, called without the task's signal",
    ours: {
      prepend:
        'async function post(text: string): Promise<string> {\n  const res = await fetch("/api/save", { method: "POST", body: text });\n  if (!res.ok) throw new Error(`save failed: ${res.status}`);\n  return res.text();\n}',
      ...run(`async ({ data }) => ({ type: "stored", id: await post(data.text) })`),
    },
  },
  {
    id: "M443",
    group: K,
    base: "job",
    name: '`mode: "no-cors"` on the task\'s fetch (an opaque response)',
    ours: posted(`{ method: "POST", body: data.text, signal, mode: "no-cors" }`, "await res.text()"),
  },
  {
    id: "M444",
    group: K,
    base: "job",
    name: "the response body read twice (once to log it)",
    ours: posted(
      `{ method: "POST", body: data.text, signal }`,
      "await res.text()",
      "if (!res.ok) throw new Error(`save failed: ${res.status}`);\n          console.info(await res.text());",
    ),
  },
  {
    id: "M445",
    group: K,
    base: "job",
    name: "an idempotency key made inside the task (a new one on every retry)",
    ours: posted(
      `{ method: "POST", body: data.text, signal, headers: { "Idempotency-Key": crypto.randomUUID() } }`,
      "await res.text()",
    ),
  },
  {
    id: "M446",
    group: K,
    base: "job",
    name: "a retry loop hidden inside the task",
    ours: run(
      `async ({ data, signal }) => {\n          for (let attempt = 0; attempt < 3; attempt++) {\n            try {\n              return { type: "stored", id: await save(data.text, signal) };\n            } catch (e) {\n              if (attempt === 2) throw e;\n            }\n          }\n          throw new Error("unreachable");\n        }`,
    ),
  },
  {
    id: "M447",
    group: K,
    base: "job",
    name: "an async Promise executor in the task",
    ours: run(
      `({ data, signal }) =>\n          new Promise<{ readonly type: "stored"; readonly id: string }>(async (resolve) => {\n            resolve({ type: "stored", id: await save(data.text, signal) });\n          })`,
    ),
  },
  {
    id: "M448",
    group: K,
    base: "job",
    name: "`filter(async …)` in the task (every item passes)",
    ours: run(
      `async ({ data, signal }) => {\n          const parts = data.text.split(",").filter(async (part) => (await save(part, signal)) !== "");\n          return { type: "stored", id: parts.join(",") };\n        }`,
    ),
  },
  {
    id: "M449",
    group: K,
    base: "job",
    name: "`for await` over an array of promises in the task",
    ours: run(
      `async ({ data, signal }) => {\n          const ids: string[] = [];\n          for await (const id of data.text.split(",").map((part) => save(part, signal))) ids.push(id);\n          return { type: "stored", id: ids.join(",") };\n        }`,
    ),
  },
  {
    id: "M450",
    group: K,
    base: "job",
    name: "Promise.allSettled whose failures are never read",
    ours: run(
      `async ({ data, signal }) => {\n          await Promise.allSettled(data.text.split(",").map((part) => save(part, signal)));\n          return { type: "stored", id: data.text };\n        }`,
    ),
  },
  {
    id: "M451",
    group: K,
    base: "job",
    name: "a promise rejected with a string",
    ours: run(
      `async ({ data, signal }) => {\n          if (data.text === "") await Promise.reject("empty");\n          return { type: "stored", id: await save(data.text, signal) };\n        }`,
    ),
  },
  {
    id: "M452",
    group: K,
    base: "job",
    name: "a computed string thrown in the task (`throw res.statusText`)",
    ours: posted(
      `{ method: "POST", body: data.text, signal }`,
      "await res.text()",
      "if (!res.ok) throw res.statusText;",
    ),
  },
  {
    id: "M453",
    group: K,
    base: "job",
    name: "`new Error(…)` without `throw`: the failure falls through to success",
    ours: posted(
      `{ method: "POST", body: data.text, signal }`,
      "await res.text()",
      "if (!res.ok) new Error(`save failed: ${res.status}`);",
    ),
  },
  {
    id: "M454",
    group: K,
    base: "job",
    name: "an empty catch in the task, which then reports success",
    ours: run(
      `async ({ data, signal }) => {\n          try {\n            await save(\`audit:\${data.text}\`, signal);\n          } catch {}\n          return { type: "stored", id: await save(data.text, signal) };\n        }`,
    ),
  },
  {
    id: "M455",
    group: K,
    base: "job",
    name: "`catch (e: any)` in the task",
    ours: run(
      `async ({ data, signal }) => {\n          try {\n            return { type: "stored", id: await save(data.text, signal) };\n          } catch (e: any) {\n            throw new Error(e.message);\n          }\n        }`,
    ),
  },
  {
    id: "M456",
    group: K,
    base: "job",
    name: "a `.catch` callback reading its untyped error",
    ours: run(
      `async ({ data, signal }) => ({\n          type: "stored",\n          id: await save(data.text, signal).catch((e) => {\n            throw new Error(e.message);\n          }),\n        })`,
    ),
  },
  {
    id: "M457",
    group: K,
    base: "job",
    name: "a rethrow that drops the caught error (no `cause`)",
    ours: run(
      `async ({ data, signal }) => {\n          try {\n            return { type: "stored", id: await save(data.text, signal) };\n          } catch (e) {\n            throw new Error("save failed");\n          }\n        }`,
    ),
  },
  {
    id: "M458",
    group: K,
    base: "job",
    name: "a promise returned from `try` without `await` (the catch never runs)",
    ours: {
      prepend: `async function store(text: string, signal: AbortSignal): Promise<{ readonly type: "stored"; readonly id: string }> {\n  return { type: "stored", id: await save(text, signal) };\n}`,
      ...run(
        `async ({ data, signal }) => {\n          try {\n            return store(data.text, signal);\n          } catch (e) {\n            throw new Error("save failed", { cause: e });\n          }\n        }`,
      ),
    },
  },
  {
    id: "M459",
    group: K,
    base: "job",
    name: "a `return` in `finally` (every failure becomes success)",
    ours: run(
      `async ({ data, signal }) => {\n          let id = "";\n          try {\n            id = await save(data.text, signal);\n          } finally {\n            return { type: "stored", id };\n          }\n        }`,
    ),
  },
  {
    id: "M460",
    group: K,
    base: "job",
    name: "a throw inside a callback the task schedules (outside its promise)",
    ours: run(
      `async ({ data, signal }) => {\n          const id = await save(data.text, signal);\n          queueMicrotask(() => {\n            if (id === "") throw new Error("empty id");\n          });\n          return { type: "stored", id };\n        }`,
    ),
  },
  {
    id: "M461",
    group: K,
    base: "job",
    name: "a stub task that does nothing and reports success",
    ours: run(`async () => ({ type: "stored", id: "1" })`),
  },
  {
    id: "M462",
    group: K,
    base: "job",
    name: "a test-environment branch in the task that returns a canned success",
    ours: run(
      `async ({ data, signal }) => {\n          if (process.env.NODE_ENV === "test") return { type: "stored", id: "test" };\n          return { type: "stored", id: await save(data.text, signal) };\n        }`,
    ),
  },
  {
    id: "M463",
    group: K,
    base: "job",
    name: "a live secret written into the task",
    ours: posted(
      `{ method: "POST", body: data.text, signal, headers: { Authorization: "Bearer sk_live_51HxQq2LzZ8vW1yTq" } }`,
      "await res.text()",
    ),
  },
  {
    id: "M464",
    group: K,
    base: "job",
    name: "the task writing module state that every actor shares",
    ours: {
      prepend: `let lastSaved = "";`,
      ...run(
        `async ({ data, signal }) => {\n          lastSaved = await save(data.text, signal);\n          return { type: "stored", id: lastSaved };\n        }`,
      ),
    },
  },
  {
    id: "M465",
    group: K,
    base: "job",
    name: "a generic helper that types `res.json()` as anything (`getJson<T>`)",
    ours: {
      prepend:
        "async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {\n  const res = await fetch(url, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return res.json();\n}",
      ...run(
        'async ({ data, signal }) => ({\n          type: "stored",\n          id: (await getJson<{ id: string }>(`/api/save?text=${encodeURIComponent(data.text)}`, signal)).id,\n        })',
      ),
    },
  },
  {
    id: "M466",
    group: K,
    base: "job",
    name: "an empty object cast to the event's type, then filled",
    ours: run(
      `async ({ data, signal }) => {\n          const event = {} as { type: "stored"; id: string };\n          event.type = "stored";\n          event.id = await save(data.text, signal);\n          return event;\n        }`,
    ),
  },
  {
    id: "M467",
    group: K,
    base: "job",
    name: "a date written into the task's event with Date#toString (not ISO)",
    ours: run(
      'async ({ data, signal }) => ({ type: "stored", id: `${await save(data.text, signal)}@${new Date().toString()}` })',
    ),
  },
  {
    id: "M468",
    group: K,
    base: "job",
    name: "an id made from Date.now and Math.random in the task",
    ours: run(
      `async ({ data, signal }) => {\n          await save(data.text, signal);\n          return { type: "stored", id: String(Date.now()) + Math.random().toString(36).slice(2) };\n        }`,
    ),
  },
  {
    id: "M469",
    group: K,
    base: "job",
    name: "success checked as `status === 200` (a 201 or 204 fails)",
    ours: posted(
      `{ method: "POST", body: data.text, signal }`,
      "await res.text()",
      "if (res.status !== 200) throw new Error(`save failed: ${res.status}`);",
    ),
  },
  {
    id: "M470",
    group: K,
    base: "job",
    name: "the task sending into the module's actor",
    ours: run(
      `async ({ data, signal }) => {\n          const id = await save(data.text, signal);\n          if (id === "" && !actor.send({ type: "cancel" }).ok) throw new Error("not cancelled");\n          return { type: "stored", id };\n        }`,
    ),
  },
  {
    id: "M471",
    group: K,
    base: "job",
    name: "an XMLHttpRequest in the task, never aborted",
    ours: run(
      `({ data }) =>\n          new Promise<{ readonly type: "stored"; readonly id: string }>((resolve, reject) => {\n            const xhr = new XMLHttpRequest();\n            xhr.open("POST", "/api/save");\n            xhr.onload = () => resolve({ type: "stored", id: xhr.responseText });\n            xhr.onerror = () => reject(new Error("save failed"));\n            xhr.send(data.text);\n          })`,
    ),
  },
  {
    id: "M473",
    group: K,
    base: "job",
    name: "a media stream opened in the task, not released when it's aborted",
    ours: run(
      `async ({ data, signal }) => {\n          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });\n          const id = await save(data.text, signal);\n          stream.getTracks().forEach((track) => track.stop());\n          return { type: "stored", id };\n        }`,
    ),
  },
  {
    id: "M474",
    group: K,
    base: "job",
    name: "JSON.stringify of the error in `error` (an Error is `{}`)",
    ours: edit([O.error, `error: ({ error, to }) => to("failed", { error: JSON.stringify(error) }),`]),
  },
  {
    id: "M477",
    group: K,
    base: "job",
    name: "`keep` with a new value the running task was started without",
    ours: edit([
      `cancel: ({ to }) => to("idle"),`,
      `cancel: ({ to }) => to("idle"),\n        save: ({ event, keep }) => keep("saving", { text: event.text }),`,
    ]),
  },

  // Timers.
  {
    id: "M479",
    group: D,
    base: "job",
    name: 'a negative duration (`"-20ms"`), which the type passes',
    ours: edit([O.after, O.after.replace(`"20ms"`, `"-20ms"`)]),
  },
  {
    id: "M480",
    group: D,
    base: "job",
    name: 'a duration past setTimeout\'s limit (`"720h"`)',
    ours: edit([O.after, O.after.replace(`"20ms"`, `"720h"`)]),
  },
  {
    id: "M481",
    group: D,
    base: "job",
    name: "two timers of the same length on one state",
    ours: edit([
      O.after,
      `after: { "20ms": ({ to }) => to("failed", { error: "timed out" }), "0.02s": ({ to }) => to("idle") },`,
    ]),
  },
  {
    id: "M482",
    group: D,
    base: "door",
    name: "a zero duration, meant as 'next tick'",
    ours: edit([
      O.open,
      `open: { after: { "0ms": ({ to }) => to("closed") }, on: { close: ({ to }) => to("closed") } },`,
    ]),
  },
  {
    id: "M483",
    group: D,
    base: "job",
    name: "a timer that stays with the same data, expecting to fire again",
    ours: edit([O.after, `after: { "20ms": ({ data, keep }) => keep("saving", data) },`]),
  },

  // Pure transitions.
  {
    id: "M484",
    group: P,
    base: "door",
    name: "a throw in a transition to refuse an event",
    ours: edit([
      O.push,
      `push: ({ event, to }) => {\n          if (event.by === "") throw "by is required";\n          return to("open", { by: event.by });\n        },`,
    ]),
  },
  {
    id: "M485",
    group: P,
    base: "door",
    name: "a guard function used as a condition without calling it",
    ours: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...edit([O.lock, `lock: ({ event, to }) => (validCode ? to("locked", { code: event.code }) : null),`]),
    },
  },
  {
    id: "M486",
    group: P,
    base: "door",
    name: '`||` for a default on a string (it replaces "" too)',
    ours: pushTo(`{ by: event.by || "anonymous" }`),
  },
  {
    id: "M488",
    group: P,
    base: "door",
    name: "a reversed clamp (Math.min of Math.max) that is always one bound",
    ours: openWith("tries", "number", "Math.min(Math.max(event.by.length, 10), 1)"),
  },
  {
    id: "M489",
    group: P,
    base: "door",
    name: "a locale-dependent method in a transition",
    ours: pushTo("{ by: event.by.toLocaleUpperCase() }"),
  },
  {
    id: "M490",
    group: P,
    base: "job",
    name: "`.sort()` with no compare function on numbers",
    ours: savingWith("sizes", "number[]", `event.text.split(",").map(Number).sort()`),
  },
  {
    id: "M491",
    group: P,
    base: "job",
    name: "`Array(n).map(…)` (the holes stay holes)",
    ours: savingWith("cells", "string[]", `Array(3).map(() => "")`),
  },
  {
    id: "M492",
    group: P,
    base: "job",
    name: "`delete` on an array element in a transition",
    ours: idleSave(
      `{\n          const parts = event.text.split(",");\n          delete parts[0];\n          return to("saving", { text: parts.join(",") });\n        }`,
    ),
  },
  {
    id: "M493",
    group: P,
    base: "job",
    name: "`splice` inside a forward for loop (skips elements)",
    ours: idleSave(
      `{\n          const parts = event.text.split(",");\n          for (let i = 0; i < parts.length; i++) if (parts[i] === "") parts.splice(i, 1);\n          return to("saving", { text: parts.join(",") });\n        }`,
    ),
  },
  {
    id: "M494",
    group: P,
    base: "job",
    name: "`for…in` over an array in a transition",
    ours: idleSave(
      `{\n          let text = "";\n          for (const i in event.text.split(",")) text += i;\n          return to("saving", { text });\n        }`,
    ),
  },
  {
    id: "M495",
    group: P,
    base: "door",
    name: "a module table indexed by a payload string (`constructor` finds a function)",
    ours: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushTo("{ by: NAMES[event.by] ?? event.by }"),
    },
  },
  {
    id: "M496",
    group: P,
    base: "door",
    name: "a condition that is always true (the event object itself)",
    ours: edit([O.push, `push: ({ event, to }) => (event ? to("open", { by: event.by }) : null),`]),
  },
  {
    id: "M497",
    group: P,
    base: "door",
    name: "an object interpolated into a string field (`[object Object]`)",
    ours: pushTo("{ by: `by ${event}` }"),
  },
  {
    id: "M498",
    group: P,
    base: "door",
    name: "unary minus on a string field",
    ours: openWith("offset", "number", "-event.by"),
  },
  {
    id: "M499",
    group: P,
    base: "door",
    name: "a switch over a payload's union whose `default:` declines new kinds silently",
    ours: edit(
      [O.pushType, `push: types<{ by: "ann" | "bob" }>(),`],
      [
        O.push,
        `push: ({ event, to }) => {\n          switch (event.by) {\n            case "ann":\n              return to("open", { by: "ann" });\n            default:\n              return null;\n          }\n        },`,
      ],
    ),
  },

  // Persistence.
  {
    id: "M571",
    group: R,
    base: "door",
    name: "saving to storage in a listener with no try (a full quota throws out of send)",
    ours: append(`actor.subscribe(() => {\n  localStorage.setItem("door", JSON.stringify(actor.snapshot()));\n});`),
  },
  {
    id: "M573",
    group: R,
    base: "job",
    name: "the plain snapshot saved for a machine with timers, instead of persist",
    ours: append(
      `actor.subscribe((s) => {\n  try {\n    localStorage.setItem("job", JSON.stringify(s));\n  } catch {\n    // storage full: keep running\n  }\n});`,
    ),
  },

  // Use sites.
  {
    id: "M575",
    group: U,
    base: "door",
    name: "an explicit `any` type argument to createActor",
    ours: append("export const loose = createActor<any>(doorMachine);"),
  },
  {
    id: "M576",
    group: U,
    base: "door",
    name: "a lint suppression comment in a machine",
    ours: edit([O.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n        ${O.push}`]),
  },
  {
    id: "M577",
    group: U,
    base: "door",
    name: "augmenting the library's types to make an error go away",
    ours: append(
      `import type { Shape } from "@reactre/state";\ndeclare module "@reactre/state" {\n  interface Actor<D extends Shape> {\n    retryLater(data: D): void;\n  }\n}`,
    ),
  },
  {
    id: "M578",
    group: U,
    base: "door",
    name: "a cast on the snapshot's state name",
    ours: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.snapshot().state as (typeof SHUT)[number]);`,
    ),
  },
  {
    id: "M581",
    group: U,
    base: "door",
    name: "a machine spread into a new object",
    ours: append("export const wrapped = createActor({ ...doorMachine });"),
  },
  {
    id: "M582",
    group: U,
    base: "door",
    name: "input given to a machine that takes none",
    ours: append(`export const withInput = createActor(doorMachine, { input: { by: "ann" } });`),
  },
  {
    id: "M583",
    group: U,
    base: "door",
    name: "a snapshot's data written from outside",
    ours: append(
      `export function rename(by: string): void {\n  const s = actor.snapshot();\n  if (s.state === "open") s.data.by = by;\n}`,
    ),
  },
  {
    id: "M584",
    group: U,
    base: "door",
    name: "an async listener (its writes overlap and land out of order)",
    ours: append(
      `actor.subscribe(async (s) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(s));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
  },
  {
    id: "M585",
    group: U,
    base: "door",
    name: "an actor variable reassigned without stopping the old actor",
    ours: append(
      `let current = createActor(doorMachine);\nexport function reset(): void {\n  current = createActor(doorMachine);\n}\nexport const now = (): string => current.snapshot().state;`,
    ),
  },
  {
    id: "M586",
    group: U,
    base: "job",
    name: "an actor made in an async function that returns while its task runs",
    ours: append(
      `export async function handle(text: string): Promise<boolean> {\n  const worker = createActor(jobMachine);\n  return worker.send({ type: "save", text }).ok;\n}`,
    ),
  },
  {
    id: "M587",
    group: U,
    base: "door",
    name: "one module-level actor used by a request handler (shared by every user)",
    ours: append(
      `export function POST(req: Request): Response {\n  const r = actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(r.ok ? "ok" : "refused");\n}`,
    ),
  },
  {
    id: "M588",
    group: U,
    base: "door",
    name: "toPromise on a machine with no final state (never resolves)",
    ours: append(`import { toPromise } from "@reactre/state/utils";\nexport const ended = toPromise(actor);`),
  },
  {
    id: "M589",
    group: U,
    base: "job",
    name: "a waitFor not awaited (its rejection is unhandled)",
    ours: append(`import { waitFor } from "@reactre/state/utils";\nwaitFor(actor, (s) => s.state === "saved");`),
  },
  {
    id: "M591",
    group: U,
    base: "door",
    name: "transition()'s result dropped (it is pure: nothing happens)",
    ours: append(
      `import { transition } from "@reactre/state";\ntransition(doorMachine, actor.snapshot(), { type: "push", by: "ann" });`,
    ),
  },

  // React and app code.
  {
    id: "M593",
    group: A,
    base: "door",
    name: "a send during render (in the component's body)",
    ours: append(
      `import { useActor } from "@reactre/state/react";\nexport function Door(): null {\n  const [s, ref] = useActor(doorMachine);\n  if (s.state === "closed" && !ref.send({ type: "push", by: "ann" }).ok) console.warn("refused");\n  return null;\n}`,
    ),
  },
  {
    id: "M601",
    group: A,
    base: "door",
    name: "a click handler that returns `send` instead of calling it",
    ours: append("export const buttonProps = { onClick: () => actor.send };"),
  },
  {
    id: "M603",
    group: A,
    base: "door",
    name: "subscribe called in a component's body (a new listener every render)",
    ours: append(
      `import { useActor } from "@reactre/state/react";\nexport function Log(): null {\n  const [, ref] = useActor(doorMachine);\n  ref.subscribe((s) => console.info(s.state));\n  return null;\n}`,
    ),
  },

  // Flows and modeling.
  {
    id: "M607",
    group: F,
    base: "door",
    name: "a setter event whose boolean payload picks the target",
    ours: edit(
      ["close: types<{}>(),", "close: types<{}>(),\n    setOpen: types<{ open: boolean }>(),"],
      [O.lock, `${O.lock}\n        setOpen: ({ event, to }) => (event.open ? to("open", { by: "" }) : null),`],
      [
        O.open,
        `open: { on: { close: ({ to }) => to("closed"), setOpen: ({ event, to }) => (event.open ? null : to("closed")) } },`,
      ],
    ),
  },

  // Migration habits.
  {
    id: "M612",
    group: H,
    base: "door",
    name: "`getSnapshot()` (XState's name)",
    ours: append("export const current = actor.getSnapshot();"),
  },
  {
    id: "M613",
    group: H,
    base: "door",
    name: "XState's actor options (`id`, `devTools`)",
    ours: append(`export const named = createActor(doorMachine, { id: "door", devTools: true });`),
  },
  {
    id: "M614",
    group: H,
    base: "job",
    name: "a task written as a bare function (v5's `fromPromise` habit)",
    ours: edit([TASK, `task: async ({ data, signal }) => ({ type: "stored", id: await save(data.text, signal) }),`]),
  },
  {
    id: "M615",
    group: H,
    base: "job",
    name: "`onDone` on a task (v5's invoke habit)",
    ours: edit([O.error, `${O.error}\n        onDone: ({ event, to }) => to("saved", { id: event.id }),`]),
  },
];
