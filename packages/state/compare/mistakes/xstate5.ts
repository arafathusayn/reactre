// XState v5: each case in the ports ../xstate5/door.ts and job.ts, written as v5's docs write a
// machine (`setup` with types, transitions as `{ target, actions: assign(...) }`, named guards,
// `fromPromise` for the task). v5 has no per-state context: a mistake about one state's data is
// made in the one context. Its development build runs the cases: its warnings count.
//
// v5's `assign` is the pure part of a transition (docs: actions are where effects go), so the
// purity cases put the impure read or write in `assign`, or in the guard.

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

// The port's handlers, as written there.
const V = {
  push: `push: { target: "open", actions: assign(({ event }) => ({ by: event.by, code: null })) },`,
  lock: `lock: { target: "locked", actions: assign(({ event }) => ({ by: null, code: event.code })) },`,
  open: `open: { on: { close: { target: "closed" } } },`,
  close: `close: { target: "closed" }`,
  guard: `codeMatches: ({ context, event }) => event.type === "unlock" && event.code === context.code,`,
  pushEvent: `| { readonly type: "push"; readonly by: string }`,
  context: "context: {} as { by: string | null; code: string | null },",
  initial: "context: { by: null, code: null },",
  end: `locked: { on: { unlock: { guard: "codeMatches", target: "closed" } } },\n  },\n});`,
  store: "store: fromPromise<string, { text: string }>(({ input, signal }) => save(input.text, signal)),",
  done: `onDone: { target: "saved", actions: assign(({ event }) => ({ id: event.output })) },`,
  error: `onError: { target: "failed", actions: assign(({ event }) => ({ error: String(event.error) })) },`,
  after: `after: { 20: { target: "failed", actions: assign({ error: "timed out" }) } },`,
  jobContext: "context: {} as { text: string | null; id: string | null; error: string | null },",
  jobInitial: "context: { text: null, id: null, error: null },",
  idle: `idle: { on: { save: { target: "saving", actions: assign(({ event }) => ({ text: event.text })) } } },`,
};

/** `push`'s context update, as `assign`'s function. */
const pushAssign = (fn: string): Mutation => edit([V.push, `push: { target: "open", actions: assign(${fn}) },`]);
/** `lock`'s code, computed in `assign`. */
const lockCode = (code: string): Mutation => edit([V.lock, V.lock.replace("code: event.code", `code: ${code}`)]);
/** An effect in `push`'s assign, before the context update. */
const pushDoes = (effect: string): Mutation => pushAssign(`({ event }) => (${effect}, { by: event.by, code: null })`);
/** A field added to the context (null at first), given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [V.context, `context: {} as { by: string | null; code: string | null; ${field}: ${type} | null },`],
    [V.initial, `context: { by: null, code: null, ${field}: null },`],
    [
      V.push,
      `push: { target: "open", actions: assign(({ event }) => ({ by: event.by, code: null, ${field}: ${value} })) },`,
    ],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
const savingWith = (field: string, type: string, value: string): Mutation =>
  edit(
    [
      V.jobContext,
      `context: {} as { text: string | null; id: string | null; error: string | null; ${field}: ${type} | null },`,
    ],
    [V.jobInitial, `context: { text: null, id: null, error: null, ${field}: null },`],
    [
      V.idle,
      `idle: { on: { save: { target: "saving", actions: assign(({ event }) => ({ text: event.text, ${field}: ${value} })) } } },`,
    ],
  );
const run = (body: string): Mutation => edit([V.store, `store: fromPromise<string, { text: string }>(${body}),`]);
/** A task that posts the text and checks the response's status, then reads it. */
const fetched = (args: string, init: string, read: string): Mutation =>
  run(
    `async (${args}) => {\n    const res = await fetch("/api/save", ${init});\n    if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n    return ${read};\n  }`,
  );
/** v5's targets aren't typed, so the hidden error is a payload field the event lacks. */
const broken = V.push.replace("event.by", "event.name");
/** The task's arguments, typed by fromPromise. */
const ARGS = "{ input, signal }";
/** A task that posts the text: `check` reads the response's status, then it reads the body. */
const posted = (init: string, read: string, check = "if (!res.ok) throw new Error(`save failed: ${res.status}`);") =>
  run(
    `async (${ARGS}) => {\n    const res = await fetch("/api/save", ${init});\n    ${check}\n    return ${read};\n  }`,
  );
/** The job's `save` in idle, its assign with this body. */
const idleAssign = (body: string): Mutation =>
  edit([
    V.idle,
    `idle: {\n      on: {\n        save: {\n          target: "saving",\n          actions: assign(({ event }) => ${body}),\n        },\n      },\n    },`,
  ]);
const LOCKED = `locked: { on: { unlock: { guard: "codeMatches", target: "closed" } } },`;
const CLOSE_EVENT = `| { readonly type: "close" }`;
/** The helpers the cases from M404 on declare. */
const OPENED = `const OPENED: unique symbol = Symbol("opened");`;
const ENUM = `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`;
const VALID = "const validCode = (code: string): boolean => code.length === 1;";
const NAMES = `const NAMES: Record<string, string> = { ann: "Ann" };`;

const tail = (machine: string) =>
  `\nimport { createActor } from "xstate";\nexport const actor = createActor(${machine}).start();\n`;

interface Actor {
  send(event: object): void;
  getSnapshot(): { status: string; error?: unknown };
}

const xstate5: Library = {
  name: "XState v5",
  bases: {
    door: { port: "../xstate5/door.ts", tail: tail("doorMachine") },
    job: { port: "../xstate5/job.ts", tail: tail("jobMachine") },
  },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") (mod.useSave as (fn: typeof SAVE) => void)(SAVE);
    const actor = mod.actor as Actor;
    for (const event of SCENARIO[base]) actor.send(event);
    await settle();
    const s = actor.getSnapshot();
    if (s.status === "error") throw new Error(`the actor errors: ${String(s.error)}`);
  },
  cases: {
    // Targets and data.
    M1: edit([V.push, V.push.replace('target: "open"', 'target: "opne"')]),
    M2: edit([V.lock, `lock: { target: "locked" },`]),
    M3: na("one context for every state: a state without data has the machine's context"),
    M4: pushAssign(`({ event }) => ({ by: event.by, code: null, at: 1 })`),
    M5: pushAssign(`({ event }) => ({ ...{ by: event.by, code: null, at: 1 } })`),
    M6: pushAssign(
      `({ event }) => {\n            const next = { by: event.by, code: null, at: 1 };\n            return next;\n          }`,
    ),
    M7: pushAssign(`({ event }) => ({ by: event.by.length, code: null })`),
    M8: pushAssign(`({ event }) => { ({ by: event.by, code: null }); }`),
    M9: edit([V.guard, V.guard.replace("({ context, event })", "async ({ context, event })")]),
    M10: edit([V.push, `push: { target: "open", actions: ({ context, event }) => { context.by = event.by; } },`]),
    M12: edit([
      V.lock,
      `lock: { target: "locked", actions: assign(({ context }) => ({ by: null, code: context.code })) },`,
    ]),
    M13: edit([V.push, broken]),
    M14: pushAssign(`({ event }) => ({ by: event.by.split(" ")[0], code: null })`),
    M15: pushAssign(`{ by: undefined, code: null }`),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [V.pushEvent, `| { readonly type: "push"; readonly by: Date }`],
      [V.push, `push: { target: "open", actions: assign(({ event }) => ({ by: String(event.by), code: null })) },`],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([V.context, "context: {} as { [key: string]: string | null },"]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("an event's `type` is its name in v5's event union: a second `type` field can't be declared"),
    M25: savingWith("controller", "AbortController", "new AbortController()"),
    M26: savingWith("pending", "Promise<string>", "Promise.resolve(event.text)"),
    M27: openWith("note", "File", 'new File([event.by], "note.txt")'),
    M28: openWith("visitor", "Visitor", "new Visitor(event.by)", HELPERS.visitor),
    M29: openWith("visits", "bigint", "BigInt(event.by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([event.by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", event.by]])'),
    M32: edit([V.pushEvent, `| { readonly type: "push"; readonly by: string; readonly click: MouseEvent }`]),
    M33: edit(
      [V.pushEvent, `| { readonly type: "push"; readonly by: string; readonly button: HTMLElement }`],
      [V.context, "context: {} as { by: string | null; code: string | null; button: HTMLElement | null },"],
      [V.initial, "context: { by: null, code: null, button: null },"],
      [
        V.push,
        `push: { target: "open", actions: assign(({ event }) => ({ by: event.by, code: null, button: event.button })) },`,
      ],
    ),
    M34: openWith("note", "string | undefined", 'event.by === "" ? undefined : event.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append(`actor.send({ type: "kick" });`),
    M44: append(`actor.send({ type: "push" });`),
    M45: append(`actor.send({ type: "push", by: 1 });`),
    M46: append(`actor.send({ type: "push", by: "ann", at: 1 });`),
    M47: append(`actor.send({ type: "xstate.done.actor.0.(machine).saving", output: "forged" });`),
    M48: edit([V.push, V.push.replace("push:", "psuh:")]),
    M49: append(`actor.send({ type: "close" });`),
    M50: append(`actor.stop();\nactor.send({ type: "push", by: "ann" });`),
    M52: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
    M53: append(HELPERS.submit(`actor.getSnapshot().matches("saved")`)),
    M55: edit([`| { readonly type: "close" }`, `| { readonly type: "close" }\n  | { readonly type: "xstate.init" }`]),

    // The graph.
    M56: na("the config's keys are the states: none is declared apart"),
    M57: na("the config's keys are the states: none is declared apart"),
    M58: edit([V.lock, ""]),
    M59: edit([V.open, "open: {},"]),
    M60: edit(['saved: { type: "final" },', `saved: { type: "final", on: { retry: { target: "idle" } } },`]),
    M62: edit([`| { readonly type: "close" }`, `| { readonly type: "close" }\n  | { readonly type: "kick" }`]),
    M63: na("a task's result is its output, delivered as onDone: there are no declared result events"),
    M64: na("a task's result is onDone on the state that invokes it"),

    // Tasks.
    M65: edit([V.error, ""]),
    M66: edit([V.done, ""]),
    M67: na("a task's result is its output, delivered as onDone"),
    M68: run(
      `async ({ input, signal }) => {\n    try {\n      return await save(input.text, signal);\n    } catch (e) {\n      console.error(e);\n    }\n  }`,
    ),
    M69: edit([
      V.error,
      `onError: { target: "failed", actions: assign(({ event }) => ({ error: event.error.message })) },`,
    ]),
    M70: edit([V.error, `onError: { target: "failed", actions: assign(({ event }) => ({ error: event.error })) },`]),
    M71: edit([
      V.error,
      `onError: {\n          target: "failed",\n          guard: ({ event }) => !(event.error instanceof DOMException && event.error.name === "AbortError"),\n          actions: assign(({ event }) => ({ error: String(event.error) })),\n        },`,
    ]),
    M72: edit([
      'input: ({ context }) => ({ text: context.text ?? "" }),',
      "input: ({ event }) => ({ text: event.text }),",
    ]),
    M73: fetched("{ input }", `{ method: "POST", body: input.text }`, "res.text()"),
    M74: run(
      `({ input }) => {\n    const c = new AbortController();\n    setTimeout(() => c.abort(), 5000);\n    return save(input.text, c.signal);\n  }`,
    ),
    M75: fetched("{ input, signal }", `{ method: "POST", body: input.text, signal, timeout: 5000 }`, "res.text()"),
    M76: run(
      `async ({ input, signal }) => {\n    try {\n      return await save(input.text, signal);\n    } catch {\n      return "";\n    }\n  }`,
    ),
    M77: run(
      `async ({ input, signal }) => (await fetch("/api/save", { method: "POST", body: input.text, signal })).text()`,
    ),
    M78: fetched("{ input, signal }", `{ method: "POST", body: input.text, signal }`, "(await res.json()).id"),
    M79: fetched("{ input, signal }", `{ method: "POST", body: input.text, signal }`, "(await res.json()) as string"),
    M80: run(`async ({ input, signal }) => {\n    save(input.text, signal);\n    return input.text;\n  }`),
    M81: run(
      `async ({ input, signal }) => {\n    input.text.split(",").forEach(async (part) => {\n      await save(part, signal);\n    });\n    return input.text;\n  }`,
    ),
    M82: run(
      `async ({ input, signal }) => {\n    if (input.text === "") throw "empty";\n    return save(input.text, signal);\n  }`,
    ),
    M83: run(
      `({ input }) =>\n    new Promise<string>((resolve) => {\n      const socket = new WebSocket("ws://localhost:1/save");\n      socket.onopen = () => socket.send(input.text);\n      socket.onmessage = (m) => resolve(String(m.data));\n    })`,
    ),
    M84: run(
      `async ({ input, signal }) => {\n    setInterval(() => void save(input.text, signal), 1000);\n    return input.text;\n  }`,
    ),
    M87: edit([
      `on: { cancel: { target: "idle" } },`,
      `on: {\n        cancel: { target: "idle" },\n        save: { target: "saving", actions: assign(({ event }) => ({ text: event.text })) },\n      },`,
    ]),

    // Timers.
    M88: edit(["after: { 20:", 'after: { "20 msec":']),
    M89: edit(["after: { 20:", 'after: { "1d":']),
    M90: na("a number is milliseconds in v5"),
    M96: edit([
      V.after,
      'after: { 20: { target: "failed", actions: assign(({ event }) => ({ error: `timed out: ${event.text}` })) } },',
    ]),
    M104: edit([V.after, `after: { 20: { target: "saving" } },`]),

    // Pure transitions.
    M116: lockCode("String(Date.now())"),
    M117: lockCode("String(Math.random())"),
    M119: lockCode("crypto.randomUUID()"),
    M120: { ...lockCode("event.code || fallback"), prepend: HELPERS.fallback },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(event.by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: {
      ...pushAssign("({ event }) => ({ ...defaults, by: event.by })"),
      prepend: `const defaults = { by: "guest", code: null };`,
    },
    M125: {
      ...pushAssign("({ event }) => withBy(event.by)"),
      prepend:
        "function withBy(by: string): { by: string; code: null } {\n  const out = { by, code: null, at: Date.now() };\n  return out;\n}",
    },
    M126: lockCode('[...new Set(event.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? event.code"),
    M128: edit([
      V.lock,
      `lock: { target: "locked", actions: assign(() => ({ by: null }) as { by: null; code: string }) },`,
    ]),
    M128b: edit([
      V.error,
      `onError: { target: "failed", actions: assign(({ event }) => ({ error: (event.error as Error).message })) },`,
    ]),
    M129: pushAssign(`({ event }) => ({ by: event.by.split(" ")[0]!, code: null })`),
    M130: pushDoes(`console.log("pushed by", event.by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: event.by }).catch(() => {})`),
    M132: edit([
      V.lock,
      `lock: { target: "locked", actions: assign(({ event }) => (setTimeout(() => console.info("relock"), 1000), { by: null, code: event.code })) },`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? event.code'),
    M134: lockCode("process.env.DOOR_CODE ?? event.code"),
    M135: edit([V.push, `// @ts-expect-error\n        ${broken}`]),
    M135b: edit([V.push, `// @ts-ignore\n        ${broken}`]),
    M135c: edit(
      ["// test/fixtures/door.ts in XState v5", "// @ts-nocheck\n// test/fixtures/door.ts in XState v5"],
      [V.push, broken],
    ),
    M136: {
      ...edit([V.close, `close: { target: "closed", actions: assign(() => (analytics.track("closed"), {})) }`]),
      prepend: HELPERS.analytics,
    },
    M137: {
      ...edit([V.close, `close: { target: "closed", actions: assign(() => (track("closed"), {})) }`]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: { ...lockCode("stamp(event.code)"), prepend: HELPERS.stamp },
    M139: edit([
      V.guard,
      `codeMatches: ({ context, event }) =>\n      event.type === "unlock" && Boolean(context.code?.split(",").filter((c) => c === event.code)),`,
    ]),

    // Persistence.
    M259: na("createActor's snapshot option is how v5 restores"),
    M261: append(
      "const saved = JSON.stringify(actor.getPersistedSnapshot());\nexport const restored = createActor(doorMachine, { snapshot: JSON.parse(saved) }).start();",
    ),
    M265: append(`export let saved = "";\nactor.subscribe((s) => {\n  saved = JSON.stringify(s);\n});`),

    // Use sites.
    M297: append("export const len = actor.getSnapshot().context.by.length;"),
    M298: append(`export const is = actor.getSnapshot().matches("opened");`),
    M300: edit([`id: "door",`, `id: "door",\n  verison: "2",`]),
    M301: append(`export const canClose = actor.getSnapshot().can("close");`),
    M304: edit(["createActor(doorMachine)", "createActor(doorMachine as any)"]),
    M305: append("export const by = (actor.getSnapshot().context as { by: string }).by;"),
    M305b: append(`actor.subscribe((s) => {\n  if (s.matches("open")) console.info(s.context.by!.toUpperCase());\n});`),
    M307: na("one context, every field nullable already: nothing to loosen"),
    M308: append(HELPERS.label("actor.getSnapshot", "s.value", "s.context.by")),

    // Migration habits.
    M344: na("a string target is v5's shorthand"),
    M345: na("guard is v5's"),
    M345b: na("actions is v5's"),
    M345c: edit([V.close, `close: { target: "closed", cond: "isOpen" }`]),
    M345d: edit([V.close, `close: { target: "closed", in: "#door.open" }`]),
    M346: na("a transition array is v5's"),
    M347: edit([V.open, `open: { on: { close: { target: "closed" }, "": { target: "closed" } } },`]),
    M348: na("v5 declines with a guard"),
    M350: na("initial is how XState names the first state"),
    M351: na("context is how XState gives the data"),
    M352: na("a machine's id is XState's"),
    M353: edit(['saved: { type: "final" },', "saved: { final: true },"]),
    M354: na("invoke is how XState runs a task"),
    M355: edit(["closed: {\n      on: {", `closed: {\n      activities: ["beep"],\n      on: {`]),
    M356: edit([`id: "door",`, `id: "door",\n  predictableActionArguments: true,`]),
    M357: na("types is v5's"),
    M358: edit([
      V.end,
      `locked: { on: { unlock: { guard: "codeMatches", target: "closed" } } },\n  },\n}, { actions: {} });`,
    ]),
    M362: na("and, or, not and stateIn are v5's"),
    M363: na("assign, raise, sendTo and enqueueActions are v5's"),
    M364: na("interpret is v5's deprecated name for createActor"),
    M366: na("fromPromise is v5's"),
    M367: append(`import { invoke } from "xstate";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: append(`actor.send("push");`),
    M369: append("actor.stop();\nactor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.getSnapshot().done;"),
    M372: na("value is XState's snapshot"),
    M373: na("matches is XState's snapshot"),
    M374: append("export const configured = doorMachine.withConfig({});"),
    M375: append(`export const preset = createActor(doorMachine, { context: { by: "ann", code: null } }).start();`),

    // From M404 on. Targets and data. v5's step is a transition config: the one built and dropped
    // is an action creator called inside an action function, its return value lost.
    M404: edit(
      [
        V.lock,
        `lock: {\n          target: "locked",\n          actions: ({ event }) => {\n            if (event.code !== "") assign({ by: null, code: event.code });\n          },\n        },`,
      ],
      [
        V.open,
        `open: {\n      on: {\n        close: { target: "closed" },\n        lock: { target: "locked", actions: assign(({ event }) => ({ by: null, code: event.code })) },\n      },\n    },`,
      ],
    ),
    M405: edit([
      LOCKED,
      `locked: { on: { unlock: [{ guard: "codeMatches", target: "closed" }, { target: "locked" }] } },`,
    ]),
    M406: pushAssign(
      "({ event }) => ({\n            get by() {\n              return event.by;\n            },\n            code: null,\n          })",
    ),
    M407: na("staying is a transition without a target: it names no state, so it can't name the wrong one"),
    M408: na("the first state is `initial`, a name: nothing runs at start that could decline"),
    M409: edit([
      V.initial,
      "context: ({ event }) => (event === undefined ? { by: null, code: null } : { by: null, code: null }),",
    ]),
    M410: edit([
      V.lock,
      `lock: { target: "locked", actions: assign(({ context, event }) => Object.assign(context, { by: null, code: event.code })) },`,
    ]),
    M411: edit([V.error, `onError: { actions: ({ event }) => ({ type: "failed", error: String(event.error) }) },`]),
    M412: edit([
      V.lock,
      `${V.lock}\n        push: { target: "open", actions: assign(({ event }) => ({ by: event.by.trim(), code: null })) },`,
    ]),
    M413: edit([
      V.lock,
      `lock: {\n          target: "locked",\n          guard: ({ event }) => {\n            event.code.split("").forEach((c) => {\n              if (c === " ") return false;\n            });\n            return true;\n          },\n          actions: assign(({ event }) => ({ by: null, code: event.code })),\n        },`,
    ]),
    M414: pushAssign('({ event }) => ({ by: JSON.parse(`"${event.by}"`), code: null })'),

    // Contracts.
    M416: na("an event is a member of the events union, its fields beside `type`: no payload type to write as void"),
    M417: openWith("[OPENED]", "boolean", "true", OPENED),
    // M418 and M422: the app sends close, so the name is a second event beside it.
    M418: edit(
      [CLOSE_EVENT, `${CLOSE_EVENT}\n  | { readonly type: "toString" }`],
      [V.open, `open: { on: { close: { target: "closed" }, toString: { target: "closed" } } },`],
    ),
    M419: edit([V.lock, V.lock.replace(`"locked"`, `"2"`)], ["locked: { on: { unlock:", "2: { on: { unlock:"]),
    M420: edit(
      [CLOSE_EVENT, `${CLOSE_EVENT}\n  | { readonly type: "Close" }`],
      [V.open, `open: { on: { close: { target: "closed" }, Close: { target: "closed" } } },`],
    ),
    M421: na("a task's result is its output, delivered as onDone: it has no event of its own to share a name with"),
    M422: edit(
      [CLOSE_EVENT, `${CLOSE_EVENT}\n  | { readonly type: "close*" }`],
      [V.open, `open: { on: { close: { target: "closed" }, "close*": { target: "closed" } } },`],
    ),
    M423: savingWith("tags", "never[]", "[]"),
    M424: edit([V.context, `context: {} as { by: "ann" | "bob" | string | null; code: string | null },`]),
    M425: openWith("constructor", "string", "event.by"),
    M426: { prepend: ENUM, edits: [[V.pushEvent, `| { readonly type: "push"; readonly by: Visitor }`]] },
    M427: na(`a version is a string in XState (\`version: "1.0.0"\`): a dotted one is its form`),
    M428: na("v5 types a machine with `{} as T` in setup's types: no helper to leave uncalled"),

    // Events and sending. The push is closed again, so the app's own push finds the door closed.
    M429: append(`actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));\nactor.send({ type: "close" });`),

    // The graph.
    M432: edit(
      [`\n      ${V.after}`, ""],
      [`\n      on: { cancel: { target: "idle" } },`, ""],
      [
        `failed: { on: { retry: { target: "idle" } } },`,
        `failed: { on: { retry: { target: "idle" }, cancel: { target: "idle" } } },`,
      ],
    ),
    M433: edit(['saved: { type: "final" },', `saved: { type: "final", after: { 1000: { target: "idle" } } },`]),
    M434: edit(["closed: {\n      on: {", `closed: {\n      close: { target: "closed" },\n      on: {`]),

    // Tasks.
    M437: run(`async (${ARGS}) => ({ target: "saved", context: { id: await save(input.text, signal) } })`),
    M438: run(
      `async (${ARGS}) => {\n    await new Promise((resolve) => setTimeout(resolve, 5));\n    return save(input.text, signal);\n  }`,
    ),
    M439: posted(`{ method: "POST", body: input.text, signal: AbortSignal.timeout(5000) }`, "res.text()"),
    M440: run(
      `async (${ARGS}) => {\n    const init = { method: "POST", body: input.text };\n    const res = await fetch("/api/save", init);\n    if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n    return res.text();\n  }`,
    ),
    M441: {
      prepend:
        'async function post(text: string): Promise<string> {\n  const res = await fetch("/api/save", { method: "POST", body: text });\n  if (!res.ok) throw new Error(`save failed: ${res.status}`);\n  return res.text();\n}',
      ...run(`async (${ARGS}) => post(input.text)`),
    },
    M443: posted(`{ method: "POST", body: input.text, signal, mode: "no-cors" }`, "res.text()"),
    M444: posted(
      `{ method: "POST", body: input.text, signal }`,
      "res.text()",
      "if (!res.ok) throw new Error(`save failed: ${res.status}`);\n    console.info(await res.text());",
    ),
    M445: posted(
      `{ method: "POST", body: input.text, signal, headers: { "Idempotency-Key": crypto.randomUUID() } }`,
      "res.text()",
    ),
    M446: run(
      `async (${ARGS}) => {\n    for (let attempt = 0; attempt < 3; attempt++) {\n      try {\n        return await save(input.text, signal);\n      } catch (e) {\n        if (attempt === 2) throw e;\n      }\n    }\n    throw new Error("unreachable");\n  }`,
    ),
    M447: run(
      `(${ARGS}) =>\n    new Promise<string>(async (resolve) => {\n      resolve(await save(input.text, signal));\n    })`,
    ),
    M448: run(
      `async (${ARGS}) => {\n    const parts = input.text.split(",").filter(async (part) => (await save(part, signal)) !== "");\n    return parts.join(",");\n  }`,
    ),
    M449: run(
      `async (${ARGS}) => {\n    const ids: string[] = [];\n    for await (const id of input.text.split(",").map((part) => save(part, signal))) ids.push(id);\n    return ids.join(",");\n  }`,
    ),
    M450: run(
      `async (${ARGS}) => {\n    await Promise.allSettled(input.text.split(",").map((part) => save(part, signal)));\n    return input.text;\n  }`,
    ),
    M451: run(
      `async (${ARGS}) => {\n    if (input.text === "") await Promise.reject("empty");\n    return save(input.text, signal);\n  }`,
    ),
    M452: posted(`{ method: "POST", body: input.text, signal }`, "res.text()", "if (!res.ok) throw res.statusText;"),
    M453: posted(
      `{ method: "POST", body: input.text, signal }`,
      "res.text()",
      "if (!res.ok) new Error(`save failed: ${res.status}`);",
    ),
    M454: run(
      `async (${ARGS}) => {\n    try {\n      await save(\`audit:\${input.text}\`, signal);\n    } catch {}\n    return save(input.text, signal);\n  }`,
    ),
    M455: run(
      `async (${ARGS}) => {\n    try {\n      return await save(input.text, signal);\n    } catch (e: any) {\n      throw new Error(e.message);\n    }\n  }`,
    ),
    M456: run(`(${ARGS}) =>\n    save(input.text, signal).catch((e) => {\n      throw new Error(e.message);\n    })`),
    M457: run(
      `async (${ARGS}) => {\n    try {\n      return await save(input.text, signal);\n    } catch (e) {\n      throw new Error("save failed");\n    }\n  }`,
    ),
    M458: {
      prepend:
        "async function put(text: string, signal: AbortSignal): Promise<string> {\n  return save(text, signal);\n}",
      ...run(
        `async (${ARGS}) => {\n    try {\n      return put(input.text, signal);\n    } catch (e) {\n      throw new Error("save failed", { cause: e });\n    }\n  }`,
      ),
    },
    M459: run(
      `async (${ARGS}) => {\n    let id = "";\n    try {\n      id = await save(input.text, signal);\n    } finally {\n      return id;\n    }\n  }`,
    ),
    M460: run(
      `async (${ARGS}) => {\n    const id = await save(input.text, signal);\n    queueMicrotask(() => {\n      if (id === "") throw new Error("empty id");\n    });\n    return id;\n  }`,
    ),
    M461: run(`async () => "1"`),
    M462: run(
      `async (${ARGS}) => {\n    if (process.env.NODE_ENV === "test") return "test";\n    return save(input.text, signal);\n  }`,
    ),
    M463: posted(
      `{ method: "POST", body: input.text, signal, headers: { Authorization: "Bearer sk_live_51HxQq2LzZ8vW1yTq" } }`,
      "res.text()",
    ),
    M464: {
      prepend: `let lastSaved = "";`,
      ...run(`async (${ARGS}) => {\n    lastSaved = await save(input.text, signal);\n    return lastSaved;\n  }`),
    },
    M465: {
      prepend:
        "async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {\n  const res = await fetch(url, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return res.json();\n}",
      ...run(
        `async (${ARGS}) => (await getJson<{ id: string }>(\`/api/save?text=\${encodeURIComponent(input.text)}\`, signal)).id`,
      ),
    },
    M466: na("a task's result is its output (the id), delivered as onDone: there is no event object to build"),
    M467: run(`async (${ARGS}) => \`\${await save(input.text, signal)}@\${new Date().toString()}\``),
    M468: run(
      `async (${ARGS}) => {\n    await save(input.text, signal);\n    return String(Date.now()) + Math.random().toString(36).slice(2);\n  }`,
    ),
    M469: posted(
      `{ method: "POST", body: input.text, signal }`,
      "res.text()",
      "if (res.status !== 200) throw new Error(`save failed: ${res.status}`);",
    ),
    M470: run(
      `async (${ARGS}) => {\n    const id = await save(input.text, signal);\n    if (id === "") actor.send({ type: "cancel" });\n    return id;\n  }`,
    ),
    M471: run(
      `({ input }) =>\n    new Promise<string>((resolve, reject) => {\n      const xhr = new XMLHttpRequest();\n      xhr.open("POST", "/api/save");\n      xhr.onload = () => resolve(xhr.responseText);\n      xhr.onerror = () => reject(new Error("save failed"));\n      xhr.send(input.text);\n    })`,
    ),
    M473: run(
      `async (${ARGS}) => {\n    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });\n    const id = await save(input.text, signal);\n    stream.getTracks().forEach((track) => track.stop());\n    return id;\n  }`,
    ),
    M474: edit([V.error, V.error.replace("String(event.error)", "JSON.stringify(event.error)")]),
    M477: edit([
      `on: { cancel: { target: "idle" } },`,
      `on: {\n        cancel: { target: "idle" },\n        save: { actions: assign(({ event }) => ({ text: event.text })) },\n      },`,
    ]),

    // Timers.
    M479: edit(["after: { 20:", `after: { "-20":`]),
    M480: edit(["after: { 20:", "after: { 2592000000:"]),
    M481: edit(
      ["  actors: {", "  delays: { timeout: 20 },\n  actors: {"],
      [
        V.after,
        `after: {\n        20: { target: "failed", actions: assign({ error: "timed out" }) },\n        timeout: { target: "idle" },\n      },`,
      ],
    ),
    M482: edit([V.open, `open: { after: { 0: { target: "closed" } }, on: { close: { target: "closed" } } },`]),
    M483: edit([V.after, `after: { 20: { actions: assign(({ context }) => ({ text: context.text })) } },`]),

    // Pure transitions.
    M484: pushAssign(
      `({ event }) => {\n            if (event.by === "") throw "by is required";\n            return { by: event.by, code: null };\n          }`,
    ),
    M485: {
      prepend: VALID,
      ...edit([
        V.lock,
        `lock: {\n          target: "locked",\n          guard: ({ event }) => validCode && event.code !== "",\n          actions: assign(({ event }) => ({ by: null, code: event.code })),\n        },`,
      ]),
    },
    M486: pushAssign(`({ event }) => ({ by: event.by || "anonymous", code: null })`),
    M488: openWith("tries", "number", "Math.min(Math.max(event.by.length, 10), 1)"),
    M489: pushAssign("({ event }) => ({ by: event.by.toLocaleUpperCase(), code: null })"),
    M490: savingWith("sizes", "number[]", `event.text.split(",").map(Number).sort()`),
    M491: savingWith("cells", "string[]", `Array(3).map(() => "")`),
    M492: idleAssign(
      `{\n            const parts = event.text.split(",");\n            delete parts[0];\n            return { text: parts.join(",") };\n          }`,
    ),
    M493: idleAssign(
      `{\n            const parts = event.text.split(",");\n            for (let i = 0; i < parts.length; i++) if (parts[i] === "") parts.splice(i, 1);\n            return { text: parts.join(",") };\n          }`,
    ),
    M494: idleAssign(
      `{\n            let text = "";\n            for (const i in event.text.split(",")) text += i;\n            return { text };\n          }`,
    ),
    M495: { prepend: NAMES, ...pushAssign("({ event }) => ({ by: NAMES[event.by] ?? event.by, code: null })") },
    M496: edit([
      V.push,
      `push: { target: "open", guard: ({ event }) => Boolean(event), actions: assign(({ event }) => ({ by: event.by, code: null })) },`,
    ]),
    M497: pushAssign("({ event }) => ({ by: `by ${event}`, code: null })"),
    M498: openWith("offset", "number", "-event.by"),
    M499: edit(
      [V.pushEvent, `| { readonly type: "push"; readonly by: "ann" | "bob" }`],
      [
        V.push,
        `push: {\n          target: "open",\n          guard: ({ event }) => {\n            switch (event.by) {\n              case "ann":\n                return true;\n              default:\n                return false;\n            }\n          },\n          actions: assign(({ event }) => ({ by: event.by, code: null })),\n        },`,
      ],
    ),

    // Persistence.
    M571: append(
      `actor.subscribe(() => {\n  localStorage.setItem("door", JSON.stringify(actor.getPersistedSnapshot()));\n});`,
    ),
    M573: append(
      `actor.subscribe((s) => {\n  try {\n    localStorage.setItem("job", JSON.stringify(s));\n  } catch {\n    // storage full: keep running\n  }\n});`,
    ),

    // Use sites.
    M575: append("export const loose = createActor<any>(doorMachine);"),
    M576: edit([V.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n        ${V.push}`]),
    M577: append(
      `import type { AnyActorLogic } from "xstate";\ndeclare module "xstate" {\n  interface Actor<TLogic extends AnyActorLogic> {\n    retryLater(logic: TLogic): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.getSnapshot().value as (typeof SHUT)[number]);`,
    ),
    M581: append("export const wrapped = createActor({ ...doorMachine });"),
    M582: append(`export const withInput = createActor(doorMachine, { input: { by: "ann" } });`),
    M583: append(
      `export function rename(by: string): void {\n  const s = actor.getSnapshot();\n  if (s.matches("open")) s.context.by = by;\n}`,
    ),
    M584: append(
      `actor.subscribe(async (s) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(s));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: append(
      `let current = createActor(doorMachine).start();\nexport function reset(): void {\n  current = createActor(doorMachine).start();\n}\nexport const now = () => current.getSnapshot().value;`,
    ),
    M586: append(
      `export async function handle(text: string): Promise<boolean> {\n  const worker = createActor(jobMachine).start();\n  worker.send({ type: "save", text });\n  return worker.getSnapshot().matches("saving");\n}`,
    ),
    M587: append(
      `export function POST(req: Request): Response {\n  actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(actor.getSnapshot().matches("open") ? "ok" : "refused");\n}`,
    ),
    M588: append(`import { toPromise } from "xstate";\nexport const ended = toPromise(actor);`),
    M589: append(`import { waitFor } from "xstate";\nwaitFor(actor, (s) => s.matches("saved"));`),
    M591: append(
      `import { transition } from "xstate";\ntransition(doorMachine, actor.getSnapshot(), { type: "push", by: "ann" });`,
    ),

    // React and app code: the cases' folder resolves neither @xstate/react nor React's types, so a
    // component reads the module's actor.
    M593: append(
      `export function DoorView(): null {\n  if (actor.getSnapshot().matches("closed")) actor.send({ type: "push", by: "ann" });\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send };"),
    M603: append(`export function Log(): null {\n  actor.subscribe((s) => console.info(s.value));\n  return null;\n}`),

    // Flows and modeling.
    M607: edit(
      [CLOSE_EVENT, `${CLOSE_EVENT}\n  | { readonly type: "setOpen"; readonly open: boolean }`],
      [
        V.lock,
        `${V.lock}\n        setOpen: { guard: ({ event }) => event.open, target: "open", actions: assign({ by: "", code: null }) },`,
      ],
      [
        V.open,
        `open: { on: { close: { target: "closed" }, setOpen: { guard: ({ event }) => !event.open, target: "closed" } } },`,
      ],
    ),

    // Migration habits.
    M612: na("getSnapshot is XState's"),
    M613: append(`export const named = createActor(doorMachine, { id: "door", devTools: true });`),
    M614: edit([
      V.store,
      "store: async ({ input, signal }: { input: { text: string }; signal: AbortSignal }) => save(input.text, signal),",
    ]),
    M615: na("onDone is v5's: it is how invoke delivers a task's result"),
  },
};
export default xstate5;
