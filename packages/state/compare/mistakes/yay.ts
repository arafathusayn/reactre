// yay-machine: each case in the ports ../yay/door.ts and job.ts, written as its docs write a
// machine (`defineMachine` over a state union tagged by `name`, transitions as `{ to, data, when }`,
// side effects in `onEnter` with a tear-down). The job's task and timer live in `saving`'s
// `onEnter`, and its results come back as events, so a task mistake is made there.
//
// yay-machine names `onEnter`, `onExit` and `onTransition` its side effects; `data()` and `when()`
// compute the next state, so the purity cases put the impure read or write in `data()` (or `when`).

import {
  append,
  type CaseModule,
  edit,
  HELPERS,
  type Library,
  type Mutation,
  na,
  SAVE,
  SCENARIO,
  settle,
} from "./cases.ts";

// The ports' transitions and types, as written there.
const Y = {
  push: `push: { to: "open", data: ({ event }) => ({ by: event.by }) },`,
  lock: `lock: { to: "locked", data: ({ event }) => ({ code: event.code }) },`,
  open: `open: { on: { close: { to: "closed" } } },`,
  close: `close: { to: "closed" }`,
  when: "when: ({ state, event }) => event.code === state.code",
  openState: `| { readonly name: "open"; readonly by: string }`,
  pushEvent: `| { readonly type: "push"; readonly by: string }`,
  lockedState: `| { readonly name: "locked"; readonly code: string };`,
  closeEvent: `| { readonly type: "close" }`,
  initial: `initialState: { name: "closed" },`,
  end: "\n  },\n});",
  header: "// test/fixtures/door.ts in yay-machine",
  // The job.
  savingState: `| { readonly name: "saving"; readonly text: string }`,
  idleData: "data: ({ event }) => ({ text: event.text })",
  idle: `idle: { on: { save: { to: "saving", data: ({ event }) => ({ text: event.text }) } } },`,
  onEnter: "onEnter: ({ state, send }) => {",
  save: "save(state.text, abort.signal)",
  reject: `(error: unknown) => abort.signal.aborted || send({ type: "error", error: String(error) }),`,
  chain: `save(state.text, abort.signal).then(\n          (id) => abort.signal.aborted || send({ type: "stored", id }),\n          (error: unknown) => abort.signal.aborted || send({ type: "error", error: String(error) }),\n        );`,
  stored: `stored: { to: "saved", data: ({ event }) => ({ id: event.id }) },`,
  errored: `error: { to: "failed", data: ({ event }) => ({ error: event.error }) },`,
  timeout: `timeout: { to: "failed", data: () => ({ error: "timed out" }) },`,
  cancel: `cancel: { to: "idle" },`,
  failed: `failed: { on: { retry: { to: "idle" } } },`,
  lastEvent: `| { readonly type: "timeout" };`,
};
const opne = Y.push.replace('to: "open"', 'to: "opne"');

/** `push`'s data, computed another way. */
const pushData = (fn: string): Mutation => edit([Y.push, `push: { to: "open", data: ${fn} },`]);
/** `lock`'s code, computed in `data()`. */
const lockCode = (code: string): Mutation => edit([Y.lock, Y.lock.replace("code: event.code", `code: ${code}`)]);
/** An effect in `push`'s data(), before the next state's data. */
const pushDoes = (effect: string): Mutation => pushData(`({ event }) => (${effect}, { by: event.by })`);
/** A field added to `open`'s data, given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [Y.openState, `| { readonly name: "open"; readonly by: string; readonly ${field}: ${type} }`],
    [Y.push, `push: { to: "open", data: ({ event }) => ({ by: event.by, ${field}: ${value} }) },`],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** A field added to `saving`'s data, given by `save`. */
const savingWith = (field: string, type: string, value: string): Mutation =>
  edit(
    [Y.savingState, `| { readonly name: "saving"; readonly text: string; readonly ${field}: ${type} }`],
    [Y.idleData, `data: ({ event }) => ({ text: event.text, ${field}: ${value} })`],
  );
/** The task's failure, handled another way. */
const reject = (handler: string): Mutation => edit([Y.reject, `${handler},`]);
/** The task as something else than `save`, its result and failure handled as the port does. */
const task = (promise: string): Mutation => edit([Y.save, promise]);
/** A task that posts the text and checks the response's status, then reads it. */
const fetched = (init: string, read: string): Mutation =>
  task(
    `(async () => {\n          const res = await fetch("/api/save", ${init});\n          if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n          return ${read};\n        })()`,
  );
/** The whole of the task's start, replaced. */
const chain = (body: string): Mutation => edit([Y.chain, body]);
/** A key added to the machine's config. */
const option = (line: string): Mutation => edit([Y.initial, `${Y.initial}\n  ${line}`]);
/** A task that posts the text, checks the response with `check`, then reads it. */
const posted = (init: string, read: string, check = "if (!res.ok) throw new Error(`save failed: ${res.status}`);") =>
  task(
    `(async () => {\n          const res = await fetch("/api/save", ${init});\n          ${check}\n          return ${read};\n        })()`,
  );
/** The task as an async function's body, called at once. */
const taskBody = (body: string): Mutation => task(`(async () => {\n          ${body}\n        })()`);
const INIT = `{ method: "POST", body: state.text, signal: abort.signal }`;
const TIMER_SET = `setTimeout(() => send({ type: "timeout" }), 20)`;
const UNLOCK = `unlock: { to: "closed", ${Y.when} }`;

const SAME_STATE = "a move to the same state re-enters it: the tear-down aborts the task, onEnter starts it again";
const TIMER = "a timer is setTimeout in onEnter: its delay is a number of milliseconds";

const tail = (machine: string) => `\nexport const actor = ${machine}.newInstance().start();\n`;

interface Instance {
  send(event: object): void;
}

const yay: Library = {
  name: "yay-machine",
  bases: {
    door: { port: "../yay/door.ts", tail: tail("doorMachine") },
    job: { port: "../yay/job.ts", tail: tail("jobMachine") },
  },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") (mod.useSave as (fn: typeof SAVE) => void)(SAVE);
    const actor = mod.actor as Instance;
    for (const event of SCENARIO[base]) actor.send(event);
    await settle();
  },
  cases: {
    // Targets and data.
    M1: edit([Y.push, opne]),
    M2: edit([Y.lock, `lock: { to: "locked", data: () => ({}) },`]),
    M3: edit([Y.close, `close: { to: "closed", data: () => ({}) }`]),
    M4: pushData("({ event }) => ({ by: event.by, at: 1 })"),
    M5: pushData("({ event }) => ({ ...{ by: event.by, at: 1 } })"),
    M6: pushData(
      "({ event }) => {\n            const next = { by: event.by, at: 1 };\n            return next;\n          }",
    ),
    M7: pushData("({ event }) => ({ by: event.by.length })"),
    M8: pushData("({ event }) => { ({ by: event.by }); }"),
    M9: pushData("async ({ event }) => ({ by: event.by })"),
    M10: edit([Y.when, "when: ({ state, event }) => ((state.code = event.code), true)"]),
    M12: edit([Y.lock, `lock: { to: "locked", data: ({ state }) => ({ code: state.code }) },`]),
    M13: edit([Y.push, Y.push.replace("event.by", "event.name")]),
    M14: pushData(`({ event }) => ({ by: event.by.split(" ")[0] })`),
    M15: pushData("() => ({ by: undefined })"),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [Y.pushEvent, `| { readonly type: "push"; readonly by: Date }`],
      [Y.push, `push: { to: "open", data: ({ event }) => ({ by: String(event.by) }) },`],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([Y.openState, `| { readonly name: "open"; readonly [key: string]: string }`]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("an event is `{ type, ...payload }`: `type` is its tag, so no payload field can take the name"),
    M25: savingWith("controller", "AbortController", "new AbortController()"),
    M26: savingWith("pending", "Promise<string>", "Promise.resolve(event.text)"),
    M27: openWith("note", "File", 'new File([event.by], "note.txt")'),
    M28: openWith("visitor", "Visitor", "new Visitor(event.by)", HELPERS.visitor),
    M29: openWith("visits", "bigint", "BigInt(event.by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([event.by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", event.by]])'),
    M32: edit([Y.pushEvent, `| { readonly type: "push"; readonly by: string; readonly click: MouseEvent }`]),
    M33: edit(
      [Y.pushEvent, `| { readonly type: "push"; readonly by: string; readonly button: HTMLElement }`],
      [Y.openState, `| { readonly name: "open"; readonly by: string; readonly button: HTMLElement }`],
      [Y.push, `push: { to: "open", data: ({ event }) => ({ by: event.by, button: event.button }) },`],
    ),
    M34: openWith("note", "string | undefined", 'event.by === "" ? undefined : event.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append(`actor.send({ type: "kick" });`),
    M44: append(`actor.send({ type: "push" });`),
    M45: append(`actor.send({ type: "push", by: 1 });`),
    M46: append(`actor.send({ type: "push", by: "ann", at: 1 });`),
    M47: append(`actor.send({ type: "stored", id: "forged" });`),
    M48: edit([Y.push, Y.push.replace("push:", "psuh:")]),
    M49: append(`actor.send({ type: "close" });`),
    M50: append(`actor.stop();\nactor.send({ type: "push", by: "ann" });`),
    M52: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
    M53: append(HELPERS.submit(`actor.state.name === "saved"`)),
    M55: na("no event name is reserved"),

    // The graph.
    M56: edit([Y.open, ""]),
    M57: edit([Y.open, `${Y.open}\n    broken: { on: { close: { to: "closed" } } },`]),
    M58: edit([Y.lock, ""]),
    M59: edit([Y.open, "open: {},"]),
    M60: na("no final marker: a state with no transitions is final, and one with handlers isn't"),
    M62: edit([Y.closeEvent, `${Y.closeEvent}\n  | { readonly type: "kick" }`]),
    M63: edit([Y.lastEvent, `| { readonly type: "timeout" }\n  | { readonly type: "lost" };`]),
    M64: edit([
      Y.idle,
      `idle: {\n      on: {\n        save: { to: "saving", data: ({ event }) => ({ text: event.text }) },\n        stored: { to: "saved", data: ({ event }) => ({ id: event.id }) },\n      },\n    },`,
    ]),

    // Tasks.
    M65: edit([`\n          ${Y.reject}`, ""]),
    M66: edit([Y.stored, ""]),
    M67: edit([`send({ type: "stored", id })`, `send({ type: "done", id })`]),
    M68: reject("(error: unknown) => console.error(error)"),
    M69: reject(`(error: unknown) => abort.signal.aborted || send({ type: "error", error: error.message })`),
    M70: reject(`(error: unknown) => abort.signal.aborted || send({ type: "error", error })`),
    M71: reject(
      `(error: unknown) =>\n            abort.signal.aborted ||\n            (error instanceof DOMException && error.name === "AbortError") ||\n            send({ type: "error", error: String(error) })`,
    ),
    M72: edit([Y.onEnter, "onEnter: ({ event, send }) => {"], [Y.save, "save(event.text, abort.signal)"]),
    M73: fetched(`{ method: "POST", body: state.text }`, "await res.text()"),
    M74: chain(
      `const c = new AbortController();\n        setTimeout(() => c.abort(), 5000);\n        ${Y.chain.replace(Y.save, "save(state.text, c.signal)")}`,
    ),
    M75: fetched(`{ method: "POST", body: state.text, signal: abort.signal, timeout: 5000 }`, "await res.text()"),
    M76: reject(`(error: unknown) => abort.signal.aborted || send({ type: "stored", id: "" })`),
    M77: task(
      `fetch("/api/save", { method: "POST", body: state.text, signal: abort.signal }).then((res) => res.text())`,
    ),
    M78: fetched(`{ method: "POST", body: state.text, signal: abort.signal }`, "(await res.json()).id"),
    M79: fetched(`{ method: "POST", body: state.text, signal: abort.signal }`, "(await res.json()) as string"),
    M80: chain(`save(state.text, abort.signal);\n        send({ type: "stored", id: state.text });`),
    M81: chain(
      `state.text.split(",").forEach(async (part) => {\n          await save(part, abort.signal);\n        });\n        send({ type: "stored", id: state.text });`,
    ),
    M82: task(
      `(async () => {\n          if (state.text === "") throw "empty";\n          return save(state.text, abort.signal);\n        })()`,
    ),
    M83: chain(
      `const socket = new WebSocket("ws://localhost:1/save");\n        socket.onopen = () => socket.send(state.text);\n        socket.onmessage = (m) => abort.signal.aborted || send({ type: "stored", id: String(m.data) });`,
    ),
    M84: chain(`setInterval(() => void save(state.text, abort.signal), 1000);\n        ${Y.chain}`),
    M87: na(SAME_STATE),

    // Timers.
    M88: na(TIMER),
    M89: na(TIMER),
    M90: na("a number of milliseconds is setTimeout's own form"),
    M96: edit([Y.timeout, 'timeout: { to: "failed", data: ({ event }) => ({ error: `timed out: ${event.text}` }) },']),
    M104: na(SAME_STATE),

    // Pure transitions.
    M116: lockCode("String(Date.now())"),
    M117: na("the README's own example draws Math.random() in data()"),
    M119: lockCode("crypto.randomUUID()"),
    M120: { ...lockCode("event.code || fallback"), prepend: HELPERS.fallback },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(event.by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: {
      ...pushData("({ event }) => ({ ...defaults, by: event.by })"),
      prepend: `const defaults = { by: "guest" };`,
    },
    M125: {
      ...pushData("({ event }) => withBy(event.by)"),
      prepend: "function withBy(by: string): { by: string } {\n  const out = { by, at: Date.now() };\n  return out;\n}",
    },
    M126: lockCode('[...new Set(event.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? event.code"),
    M128: edit([Y.lock, `lock: { to: "locked", data: () => ({}) as { code: string } },`]),
    M128b: reject(
      `(error: unknown) => abort.signal.aborted || send({ type: "error", error: (error as Error).message })`,
    ),
    M129: pushData(`({ event }) => ({ by: event.by.split(" ")[0]! })`),
    M130: pushDoes(`console.log("pushed by", event.by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: event.by }).catch(() => {})`),
    M132: edit([
      Y.lock,
      `lock: { to: "locked", data: ({ event }) => (setTimeout(() => console.info("relock"), 1000), { code: event.code }) },`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? event.code'),
    M134: lockCode("process.env.DOOR_CODE ?? event.code"),
    M135: edit([Y.push, `// @ts-expect-error\n        ${opne}`]),
    M135b: edit([Y.push, `// @ts-ignore\n        ${opne}`]),
    M135c: edit([Y.header, `// @ts-nocheck\n${Y.header}`], [Y.push, opne]),
    // `close` has no data() (`closed` has none), so the call goes in `push`'s.
    M136: { ...pushDoes(`analytics.track("opened")`), prepend: HELPERS.analytics },
    M137: { ...pushDoes(`track("opened")`), prepend: `import { track } from "./telemetry.ts";` },
    M138: { ...lockCode("stamp(event.code)"), prepend: HELPERS.stamp },
    M139: edit([Y.when, `when: ({ state, event }) => state.code.split(",").filter((c) => c === event.code)`]),

    // Persistence.
    M259: na("newInstance({ initialState }) is how yay-machine restores"),
    M261: append(
      "const saved = JSON.stringify(actor.state);\nexport const restored = doorMachine.newInstance({ initialState: JSON.parse(saved) }).start();",
    ),
    M265: na("the state is the app's own plain data: nothing live to leave out"),

    // Use sites.
    M297: append("export const len = actor.state.by.length;"),
    M298: append(`export const is = actor.state.name === "opened";`),
    M300: edit([Y.initial, `intialState: { name: "closed" },`]),
    M301: na("no can: an instance has state, send, subscribe, start and stop"),
    M304: edit(["doorMachine.newInstance()", "(doorMachine as any).newInstance()"]),
    M305: append("export const by = (actor.state as { by: string }).by;"),
    M305b: append(
      `actor.subscribe(({ state }) => {\n  if (state.name === "open") console.info(state.by!.toUpperCase());\n});`,
    ),
    M307: edit(
      [Y.lockedState, `| { readonly name: "locked"; readonly code?: string };`],
      [Y.lock, `lock: { to: "locked", data: () => ({}) },`],
    ),
    M308: append(
      'export function label(s: typeof actor.state): string {\n  switch (s.name) {\n    case "open":\n      return `open, by ${s.by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits.
    M344: edit([Y.close, `close: "closed"`]),
    M345: edit([Y.close, `close: { to: "closed", guard: "isOpen" }`]),
    M345b: edit([Y.close, `close: { to: "closed", actions: "log" }`]),
    M345c: edit([Y.close, `close: { to: "closed", cond: "isOpen" }`]),
    M345d: edit([Y.close, `close: { to: "closed", in: "open" }`]),
    M346: na("an array of transitions, tried in order, is yay-machine's own form"),
    M347: edit([Y.open, `open: { on: { close: { to: "closed" }, "": { to: "closed" } } },`]),
    M348: na("a guard is `when`, a boolean: no transition function whose return declines"),
    M350: edit([Y.initial, `initial: "closed",`]),
    M351: option("context: {},"),
    M352: option(`id: "door",`),
    M353: edit([Y.failed, `saved: { type: "final" },\n    ${Y.failed}`]),
    M354: edit([Y.open, `open: { invoke: { src: "audit" }, on: { close: { to: "closed" } } },`]),
    M355: edit(["closed: {\n      on: {", `closed: {\n      activities: ["beep"],\n      on: {`]),
    M356: option("predictableActionArguments: true,"),
    M357: option("types: {} as { context: { by: string | null } },"),
    M358: edit([Y.end, "\n  },\n}, { actions: {} });"]),
    M362: append(`import { and } from "yay-machine";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([Y.push, `push: { target: "open", actions: assign(({ event }) => ({ by: event.by })) },`]),
      prepend: `import { assign } from "yay-machine";`,
    },
    M364: append(`import { interpret } from "yay-machine";\nexport const service = interpret(doorMachine).start();`),
    M366: {
      prepend: `import { fromPromise } from "yay-machine";`,
      append: "export const saver = fromPromise(async ({ input }: { input: { text: string } }) => input.text);",
    },
    M367: append(`import { invoke } from "yay-machine";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: append(`actor.send("push");`),
    M369: append("actor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.state.done;"),
    M372: append("export const value = actor.state.value;"),
    M373: append(`export const isOpen = actor.state.matches("open");`),
    M374: append("export const configured = doorMachine.withConfig({});"),
    M375: append(`export const preset = doorMachine.newInstance({ context: { by: "ann" } });`),

    // From M404 on. Targets and data.
    M404: na(
      "a transition is a `{ to, data, when }` object: no step a handler builds and could drop (a data() that drops its value is M8)",
    ),
    // The 'no' branch as a second transition that stays, with the same data.
    M405: edit([
      UNLOCK,
      `unlock: [\n          { to: "closed", ${Y.when} },\n          { to: "locked", data: ({ state }) => ({ code: state.code }) },\n        ]`,
    ]),
    M406: pushData(
      "({ event }) => ({\n            get by() {\n              return event.by;\n            },\n          })",
    ),
    // Staying is `reenter: false`, which only a move to the same state takes.
    M407: edit([Y.open, `open: { on: { close: { to: "closed", reenter: false } } },`]),
    M408: na("the first state is a value (`initialState`), not a handler that could decline"),
    M409: na("the first state is a value (`initialState`): no start handler to read an event"),
    M410: edit([
      Y.lock,
      `lock: { to: "locked", data: ({ state, event }) => Object.assign(state, { code: event.code }) },`,
    ]),
    // The task's failure handler returns the event instead of sending it.
    M411: reject(`(error: unknown) => ({ type: "error", error: String(error) })`),
    M412: edit([Y.lock, `${Y.lock}\n        push: { to: "open", data: ({ event }) => ({ by: event.by.trim() }) },`]),
    M413: edit([
      Y.lock,
      `lock: {\n          to: "locked",\n          data: ({ event }) => ({ code: event.code }),\n          when: ({ event }) => {\n            event.code.split("").forEach((c) => {\n              if (c === " ") return false;\n            });\n            return true;\n          },\n        },`,
    ]),
    M414: pushData('({ event }) => ({ by: JSON.parse(`"${event.by}"`) })'),

    // Contracts.
    M416: na("an event is `{ type, ...payload }`: one without a payload is its `type` alone, with no payload type"),
    M417: openWith("[OPENED]", "boolean", "true", `const OPENED: unique symbol = Symbol("opened");`),
    M418: edit(
      [Y.closeEvent, `${Y.closeEvent}\n  | { readonly type: "toString" }`],
      [Y.open, `open: { on: { close: { to: "closed" }, toString: { to: "closed" } } },`],
    ),
    M419: edit([`"locked"`, `"2"`, "all"], ["    locked: { on:", "    2: { on:"]),
    M420: edit(
      [Y.closeEvent, `${Y.closeEvent}\n  | { readonly type: "Close" }`],
      [Y.open, `open: { on: { close: { to: "closed" }, Close: { to: "closed" } } },`],
    ),
    M422: edit(
      [Y.closeEvent, `${Y.closeEvent}\n  | { readonly type: "close*" }`],
      [Y.open, `open: { on: { close: { to: "closed" }, "close*": { to: "closed" } } },`],
    ),
    M421: na("every event can be sent: the task's results are events of the machine's one union (M47 sends one)"),
    M423: savingWith("tags", "never[]", "[]"),
    M424: edit([Y.openState, `| { readonly name: "open"; readonly by: "ann" | "bob" | string }`]),
    M425: openWith("constructor", "string", "event.by"),
    M426: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [Y.openState, `| { readonly name: "open"; readonly by: Visitor }`],
        [Y.pushEvent, `| { readonly type: "push"; readonly by: Visitor }`],
      ],
    },
    M427: na("no version: a machine has no persisted format to number"),
    M428: na("no `types<T>()`: a machine's types are defineMachine's type arguments"),

    // Events and sending.
    M429: append(`actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));`),

    // The graph.
    M432: edit(
      [`\n        const timer = ${TIMER_SET};`, ""],
      ["\n          clearTimeout(timer);", ""],
      [`\n        ${Y.timeout}`, ""],
      [`\n        ${Y.cancel}`, ""],
      [Y.failed, `failed: { on: { retry: { to: "idle" }, cancel: { to: "idle" } } },`],
    ),
    M433: na("a state is final when it has no transitions: a timer's event needs one, so the state isn't final"),
    M434: edit(["    closed: {\n      on: {", `    closed: {\n      close: { to: "closed" },\n      on: {`]),

    // Tasks.
    M437: na("the task reports back with send(event): onEnter has no step to return"),
    M438: taskBody(
      "await new Promise((resolve) => setTimeout(resolve, 5));\n          return save(state.text, abort.signal);",
    ),
    M439: fetched(`{ method: "POST", body: state.text, signal: AbortSignal.timeout(5000) }`, "await res.text()"),
    M440: taskBody(
      'const init = { method: "POST", body: state.text };\n          const res = await fetch("/api/save", init);\n          if (!res.ok) throw new Error(`save failed: ${res.status}`);\n          return res.text();',
    ),
    M441: {
      prepend:
        'async function post(text: string): Promise<string> {\n  const res = await fetch("/api/save", { method: "POST", body: text });\n  if (!res.ok) throw new Error(`save failed: ${res.status}`);\n  return res.text();\n}',
      ...task("post(state.text)"),
    },
    M443: fetched(`{ method: "POST", body: state.text, signal: abort.signal, mode: "no-cors" }`, "await res.text()"),
    M444: posted(
      INIT,
      "await res.text()",
      "if (!res.ok) throw new Error(`save failed: ${res.status}`);\n          console.info(await res.text());",
    ),
    M445: fetched(
      `{ method: "POST", body: state.text, signal: abort.signal, headers: { "Idempotency-Key": crypto.randomUUID() } }`,
      "await res.text()",
    ),
    M446: taskBody(
      `for (let attempt = 0; attempt < 3; attempt++) {\n            try {\n              return await save(state.text, abort.signal);\n            } catch (e) {\n              if (attempt === 2) throw e;\n            }\n          }\n          throw new Error("unreachable");`,
    ),
    M447: task(
      "new Promise<string>(async (resolve) => {\n          resolve(await save(state.text, abort.signal));\n        })",
    ),
    M448: taskBody(
      `const parts = state.text.split(",").filter(async (part) => (await save(part, abort.signal)) !== "");\n          return parts.join(",");`,
    ),
    M449: taskBody(
      `const ids: string[] = [];\n          for await (const id of state.text.split(",").map((part) => save(part, abort.signal))) ids.push(id);\n          return ids.join(",");`,
    ),
    M450: taskBody(
      `await Promise.allSettled(state.text.split(",").map((part) => save(part, abort.signal)));\n          return state.text;`,
    ),
    M451: taskBody(
      `if (state.text === "") await Promise.reject("empty");\n          return save(state.text, abort.signal);`,
    ),
    M452: posted(INIT, "await res.text()", "if (!res.ok) throw res.statusText;"),
    M453: posted(INIT, "await res.text()", "if (!res.ok) new Error(`save failed: ${res.status}`);"),
    M454: taskBody(
      "try {\n            await save(`audit:${state.text}`, abort.signal);\n          } catch {}\n          return save(state.text, abort.signal);",
    ),
    M455: taskBody(
      "try {\n            return await save(state.text, abort.signal);\n          } catch (e: any) {\n            throw new Error(e.message);\n          }",
    ),
    M456: task("save(state.text, abort.signal).catch((e) => {\n          throw new Error(e.message);\n        })"),
    M457: taskBody(
      `try {\n            return await save(state.text, abort.signal);\n          } catch (e) {\n            throw new Error("save failed");\n          }`,
    ),
    M458: {
      prepend:
        "async function store(text: string, signal: AbortSignal): Promise<string> {\n  const id = await save(text, signal);\n  return id;\n}",
      ...taskBody(
        `try {\n            return store(state.text, abort.signal);\n          } catch (e) {\n            throw new Error("save failed", { cause: e });\n          }`,
      ),
    },
    M459: taskBody(
      `let id = "";\n          try {\n            id = await save(state.text, abort.signal);\n          } finally {\n            return id;\n          }`,
    ),
    M460: taskBody(
      `const id = await save(state.text, abort.signal);\n          queueMicrotask(() => {\n            if (id === "") throw new Error("empty id");\n          });\n          return id;`,
    ),
    M461: task(`Promise.resolve("1")`),
    M462: taskBody(
      `if (process.env.NODE_ENV === "test") return "test";\n          return save(state.text, abort.signal);`,
    ),
    M463: fetched(
      `{ method: "POST", body: state.text, signal: abort.signal, headers: { Authorization: "Bearer sk_live_51HxQq2LzZ8vW1yTq" } }`,
      "await res.text()",
    ),
    M464: {
      prepend: `let lastSaved = "";`,
      ...taskBody("lastSaved = await save(state.text, abort.signal);\n          return lastSaved;"),
    },
    M465: {
      prepend:
        "async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {\n  const res = await fetch(url, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return res.json();\n}",
      ...task(
        "getJson<{ id: string }>(`/api/save?text=${encodeURIComponent(state.text)}`, abort.signal).then((body) => body.id)",
      ),
    },
    M466: edit([
      `(id) => abort.signal.aborted || send({ type: "stored", id }),`,
      `(id) => {\n            const event = {} as { type: "stored"; id: string };\n            event.type = "stored";\n            event.id = id;\n            if (!abort.signal.aborted) send(event);\n          },`,
    ]),
    M467: edit([`send({ type: "stored", id })`, 'send({ type: "stored", id: `${id}@${new Date().toString()}` })']),
    M468: taskBody(
      "await save(state.text, abort.signal);\n          return String(Date.now()) + Math.random().toString(36).slice(2);",
    ),
    M469: posted(INIT, "await res.text()", "if (res.status !== 200) throw new Error(`save failed: ${res.status}`);"),
    M470: taskBody(
      `const id = await save(state.text, abort.signal);\n          if (id === "") actor.send({ type: "cancel" });\n          return id;`,
    ),
    M471: task(
      `new Promise<string>((resolve, reject) => {\n          const xhr = new XMLHttpRequest();\n          xhr.open("POST", "/api/save");\n          xhr.onload = () => resolve(xhr.responseText);\n          xhr.onerror = () => reject(new Error("save failed"));\n          xhr.send(state.text);\n        })`,
    ),
    M473: taskBody(
      "const stream = await navigator.mediaDevices.getUserMedia({ audio: true });\n          const id = await save(state.text, abort.signal);\n          stream.getTracks().forEach((track) => track.stop());\n          return id;",
    ),
    M474: reject(`(error: unknown) => abort.signal.aborted || send({ type: "error", error: JSON.stringify(error) })`),
    // A `save` that stays in `saving` without re-entering it: the task keeps the text it started with.
    M477: edit([
      Y.cancel,
      `${Y.cancel}\n        save: { to: "saving", data: ({ event }) => ({ text: event.text }), reenter: false },`,
    ]),

    // Timers: setTimeout in onEnter, a number of milliseconds.
    M479: edit([TIMER_SET, `setTimeout(() => send({ type: "timeout" }), -20)`]),
    M480: edit([TIMER_SET, `setTimeout(() => send({ type: "timeout" }), 720 * 60 * 60 * 1000)`]),
    M481: edit(
      [
        `const timer = ${TIMER_SET};`,
        `const timer = ${TIMER_SET};\n        const idle = setTimeout(() => send({ type: "cancel" }), 20);`,
      ],
      ["clearTimeout(timer);", "clearTimeout(timer);\n          clearTimeout(idle);"],
    ),
    M482: edit([
      Y.open,
      `open: {\n      onEnter: ({ send }) => {\n        const timer = setTimeout(() => send({ type: "close" }), 0);\n        return () => clearTimeout(timer);\n      },\n      on: { close: { to: "closed" } },\n    },`,
    ]),
    // The timeout stays without re-entering `saving`, so onEnter's timer isn't set again.
    M483: edit([Y.timeout, `timeout: { to: "saving", reenter: false },`]),

    // Pure transitions.
    M484: pushData(
      `({ event }) => {\n            if (event.by === "") throw "by is required";\n            return { by: event.by };\n          }`,
    ),
    M485: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...edit([
        Y.lock,
        `lock: { to: "locked", data: ({ event }) => ({ code: event.code }), when: () => (validCode ? true : false) },`,
      ]),
    },
    M486: pushData(`({ event }) => ({ by: event.by || "anonymous" })`),
    M488: openWith("tries", "number", "Math.min(Math.max(event.by.length, 10), 1)"),
    M489: pushData("({ event }) => ({ by: event.by.toLocaleUpperCase() })"),
    M490: savingWith("sizes", "number[]", `event.text.split(",").map(Number).sort()`),
    M491: savingWith("cells", "string[]", `Array(3).map(() => "")`),
    M492: edit([
      Y.idleData,
      `data: ({ event }) => {\n            const parts = event.text.split(",");\n            delete parts[0];\n            return { text: parts.join(",") };\n          }`,
    ]),
    M493: edit([
      Y.idleData,
      `data: ({ event }) => {\n            const parts = event.text.split(",");\n            for (let i = 0; i < parts.length; i++) if (parts[i] === "") parts.splice(i, 1);\n            return { text: parts.join(",") };\n          }`,
    ]),
    M494: edit([
      Y.idleData,
      `data: ({ event }) => {\n            let text = "";\n            for (const i in event.text.split(",")) text += i;\n            return { text };\n          }`,
    ]),
    M495: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushData("({ event }) => ({ by: NAMES[event.by] ?? event.by })"),
    },
    M496: edit([
      Y.push,
      `push: { to: "open", data: ({ event }) => ({ by: event.by }), when: ({ event }) => (event ? true : false) },`,
    ]),
    M497: pushData("({ event }) => ({ by: `by ${event}` })"),
    M498: openWith("offset", "number", "-event.by"),
    M499: edit(
      [Y.pushEvent, `| { readonly type: "push"; readonly by: "ann" | "bob" }`],
      [
        Y.push,
        `push: {\n          to: "open",\n          data: ({ event }) => ({ by: event.by }),\n          when: ({ event }) => {\n            switch (event.by) {\n              case "ann":\n                return true;\n              default:\n                return false;\n            }\n          },\n        },`,
      ],
    ),

    // Persistence.
    M571: append(`actor.subscribe(({ state }) => {\n  localStorage.setItem("door", JSON.stringify(state));\n});`),
    M573: na("no persist: the state is the app's plain data, and newInstance({ initialState }) its one restore"),

    // Use sites.
    M575: na("newInstance takes no type arguments: an instance's types are its definition's"),
    M576: edit([Y.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n        ${Y.push}`]),
    M577: append(
      `import type { MachineEvent, MachineState } from "yay-machine";\ndeclare module "yay-machine" {\n  interface MachineInstance<StateType extends MachineState, EventType extends MachineEvent> {\n    retryLater(state: StateType): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.state.name as (typeof SHUT)[number]);`,
    ),
    M581: append("export const wrapped = { ...doorMachine }.newInstance().start();"),
    M582: append(`export const withInput = doorMachine.newInstance({ input: { by: "ann" } });`),
    M583: append(
      `export function rename(by: string): void {\n  const s = actor.state;\n  if (s.name === "open") s.by = by;\n}`,
    ),
    M584: append(
      `actor.subscribe(async ({ state }) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(state));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: append(
      "let current = doorMachine.newInstance().start();\nexport function reset(): void {\n  current = doorMachine.newInstance().start();\n}\nexport const now = (): string => current.state.name;",
    ),
    M586: append(
      `export async function handle(text: string): Promise<string> {\n  const worker = jobMachine.newInstance().start();\n  worker.send({ type: "save", text });\n  return worker.state.name;\n}`,
    ),
    M587: append(
      `export function POST(req: Request): Response {\n  actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(actor.state.name);\n}`,
    ),
    M588: na("no toPromise and no done: an instance has state, send, subscribe, start and stop"),
    M589: na("no waitFor: an instance has state, send, subscribe, start and stop"),
    M591: na("no pure transition: send runs on a started instance"),

    // React and app code: no React binding, so a component reads the module's instance.
    M593: append(
      `export function Door(): null {\n  if (actor.state.name === "closed") actor.send({ type: "push", by: "ann" });\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send };"),
    M603: append(
      "export function Log(): null {\n  actor.subscribe(({ state }) => console.info(state.name));\n  return null;\n}",
    ),

    // Flows and modeling.
    M607: edit(
      [Y.closeEvent, `${Y.closeEvent}\n  | { readonly type: "setOpen"; readonly open: boolean }`],
      [
        Y.lock,
        `${Y.lock}\n        setOpen: { to: "open", data: () => ({ by: "" }), when: ({ event }) => event.open },`,
      ],
      [
        Y.open,
        `open: { on: { close: { to: "closed" }, setOpen: { to: "closed", when: ({ event }) => !event.open } } },`,
      ],
    ),

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    M613: append(`export const named = doorMachine.newInstance({ id: "door", devTools: true });`),
    M614: na("a task is code in onEnter: no task config for v5's bare-function habit to change"),
    M615: edit([Y.onEnter, `onDone: { to: "saved" },\n      ${Y.onEnter}`]),
  },
};
export default yay;
