// @stateforward/hsm: each case in the ports ../hsm/door.ts and job.ts, written as its README writes
// a model (`define`/`state`/`transition` partials, `target` paths, `effect`s writing the
// instance's fields, `guard`, `activity` for the task, `after` for the timer), run by `start` and
// sent `dispatch({ ...Event, data })`. The callbacks cast their `Instance` to the port's class, as
// the port does (the library types them as the base Instance). A throw in an operation becomes the
// library's own `hsm_error` event, which a model may handle; the ports don't, so it says nothing.
//
// An `effect` is where hsm runs a transition's side effects (it has no pure part but the guard), so
// the purity cases whose effect is the transition's own job (logging, a fire-and-forget request,
// analytics) are n/a; the ones that compute the next data from outside, or keep state or timers
// outside the machine, are made in the effect.

import * as hsm from "@stateforward/hsm";

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

// The door port's lines, as written there.
const H = {
  by: "(door as Door).by = event.data.by;",
  code: "(door as Door).code = event.data.code;",
  fields: "by: string | null = null;",
  guard: "hsm.guard((_ctx, door, event) => event.data.code === (door as Door).code),",
  open: `hsm.state("open", entered("open"), hsm.transition(hsm.on(Close), hsm.target("../closed"))),`,
  close: `hsm.transition(hsm.on(Close), hsm.target("../closed"))`,
  lock: `    hsm.transition(\n      hsm.on(Lock),\n      hsm.target("../locked"),\n      hsm.effect((_ctx, door, event) => {\n        (door as Door).code = event.data.code;\n      }),\n    ),\n`,
  lockEffect: `      hsm.effect((_ctx, door, event) => {\n        (door as Door).code = event.data.code;\n      }),\n`,
  pushEffect: `hsm.effect((_ctx, door, event) => {\n        (door as Door).by = event.data.by;\n      }),`,
  define: `hsm.define(\n  "door",`,
  initial: `hsm.initial(hsm.target("closed")),\n);`,
  pushHelper: "export const push = (by: string): hsm.Event => ({ ...Push, data: { by } });",
  start: "hsm.start(new Door(() => {}), doorModel)",
};
// The job port's.
const J = {
  text: "(job as Job).text = event.data.text;",
  fields: `text = "";`,
  save: "save((job as Job).text, abort.signal)",
  activity: "(ctx, job) =>\n        new Promise<void>",
  wire: `ctx.addEventListener("done", () => abort.abort());`,
  stored: "{ ...Stored, data: { id } }",
  failed: "{ ...Failed, data: { error: String(error) } }",
  rejected: "(error: unknown) => {\n                if (!ctx.done) void job.dispatch",
  storedTransition: `    hsm.transition(\n      hsm.on(Stored),\n      hsm.target("../saved"),\n      hsm.effect((_ctx, job, event) => {\n        (job as Job).id = event.data.id;\n      }),\n    ),\n`,
  failedTransition: `    hsm.transition(\n      hsm.on(Failed),\n      hsm.target("../failed"),\n      hsm.effect((_ctx, job, event) => {\n        (job as Job).error = event.data.error;\n      }),\n    ),\n`,
  after: "hsm.after(() => 20),",
  timedOut: `hsm.effect((_ctx, job) => {\n        (job as Job).error = "timed out";\n      }),`,
  saved: `hsm.state("saved", entered("saved")),`,
};

/** `push`'s effect, its body replaced. */
const pushSets = (body: string): Mutation => edit([H.by, body]);
/** `lock`'s code, computed in its effect. */
const lockCode = (code: string): Mutation => edit([H.code, `(door as Door).code = ${code};`]);
/** An effect in `push`'s effect, before it writes the data. */
const pushDoes = (effect: string): Mutation => pushSets(`${effect};\n        ${H.by}`);
/** A field added to the door (null at first), written by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [H.fields, `${H.fields}\n  ${field}: ${type} | null = null;`],
    [H.by, `${H.by}\n        (door as Door).${field} = ${value};`],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** A field added to the job (null at first), written by `save`. */
const savingWith = (field: string, type: string, value: string): Mutation =>
  edit(
    [J.fields, `${J.fields}\n  ${field}: ${type} | null = null;`],
    [J.text, `${J.text}\n        (job as Job).${field} = ${value};`],
  );
/** The task's promise of the id, in place of the port's `save(...)`. */
const task = (expression: string): Mutation => edit([J.save, expression]);
/** The task as an async function's body, called at once. */
const taskBody = (body: string): Mutation => task(`(async () => {\n            ${body}\n          })()`);
/** A task that posts the text and checks the response's status, then reads it. */
const fetched = (init: string, read: string): Mutation =>
  task(
    `fetch("/api/save", ${init}).then(async (res) => {\n            if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n            return ${read};\n          })`,
  );
const POST = `method: "POST", body: (job as Job).text`;
/** A task that posts the text, checks the response with `check`, then reads it. */
const posted = (init: string, read: string, check = "if (!res.ok) throw new Error(`save failed: ${res.status}`);") =>
  task(
    `fetch("/api/save", ${init}).then(async (res) => {\n            ${check}\n            return ${read};\n          })`,
  );
const INIT = `{ ${POST}, signal: abort.signal }`;
const CANCEL = `    hsm.transition(hsm.on(Cancel), hsm.target("../idle")),\n`;
const TIMEOUT = `    hsm.transition(\n      hsm.after(() => 20),\n      hsm.target("../failed"),\n      ${J.timedOut}\n    ),\n`;
/** A guard added to `lock`'s transition. */
const lockGuard = (guard: string): Mutation => edit([H.lockEffect, `${H.lockEffect}      hsm.guard(${guard}),\n`]);
/** A guard added to `push`'s transition. */
const pushGuard = (guard: string): Mutation => edit([H.pushEffect, `${H.pushEffect}\n      hsm.guard(${guard}),`]);
/** `save`'s effect, its body replaced. */
const saveSets = (body: string): Mutation => edit([J.text, body]);
/** The door's write of `by`, broken in a way the types see (a misspelled field). */
const broken = "(door as Door).bye = event.data.by;";

const tail = (instance: string, model: string) =>
  `\nexport const actor = hsm.start(new ${instance}(() => {}), ${model});\n`;

const library: Library = {
  name: "@stateforward/hsm",
  bases: {
    door: { port: "../hsm/door.ts", tail: tail("Door", "doorModel") },
    job: { port: "../hsm/job.ts", tail: tail("Job", "jobModel") },
  },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") (mod.useSave as (fn: typeof SAVE) => void)(SAVE);
    const actor = mod.actor as hsm.Instance;
    // The app's events: each is the event of its name, its payload as `data`.
    for (const { type, ...data } of SCENARIO[base])
      void actor.dispatch(Object.keys(data).length === 0 ? hsm.event(type) : { ...hsm.event(type), data });
    await settle();
  },
  cases: {
    // Targets and data.
    M1: edit(['hsm.target("../open")', 'hsm.target("../opne")']),
    M2: edit([H.lockEffect, ""]),
    M3: na("no per-state data: the door's fields are the instance's, in every state"),
    M4: pushSets(`${H.by}\n        (door as Door).at = 1;`),
    M5: pushSets("Object.assign(door as Door, { ...{ by: event.data.by, at: 1 } });"),
    M6: pushSets("const next = { by: event.data.by, at: 1 };\n        Object.assign(door as Door, next);"),
    M7: pushSets("(door as Door).by = event.data.by.length;"),
    M8: edit([
      H.guard,
      "hsm.guard((_ctx, door, event) => {\n        event.data.code === (door as Door).code;\n      }),",
    ]),
    M9: edit([H.guard, H.guard.replace("hsm.guard(", "hsm.guard(async ")]),
    M10: na("the data is the instance's fields, written in place by effects: that is hsm's form"),
    M12: lockCode("(door as Door).code"),
    M13: pushSets("(door as Door).by = event.data.name;"),
    M14: pushSets(`(door as Door).by = event.data.by.split(" ")[0];`),
    M15: pushSets("(door as Door).by = undefined;"),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [H.pushHelper, H.pushHelper.replace("(by: string)", "(by: Date)")],
      [H.by, "(door as Door).by = String(event.data.by);"],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: na("the data is the instance's declared fields: there's no data type to widen to an index signature"),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("a payload rides in the event's `data`, apart from its `name`: a `type` field there clashes with nothing"),
    M25: savingWith("controller", "AbortController", "new AbortController()"),
    M26: savingWith("pending", "Promise<string>", "Promise.resolve(event.data.text)"),
    M27: openWith("note", "File", 'new File([event.data.by], "note.txt")'),
    M28: openWith("visitor", "Visitor", "new Visitor(event.data.by)", HELPERS.visitor),
    M29: openWith("visits", "bigint", "BigInt(event.data.by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([event.data.by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", event.data.by]])'),
    M32: edit([
      H.pushHelper,
      "export const push = (by: string, click: MouseEvent): hsm.Event => ({ ...Push, data: { by, click } });",
    ]),
    M33: edit(
      [
        H.pushHelper,
        "export const push = (by: string, button: HTMLElement): hsm.Event => ({ ...Push, data: { by, button } });",
      ],
      [H.fields, `${H.fields}\n  button: HTMLElement | null = null;`],
      [H.by, `${H.by}\n        (door as Door).button = event.data.button;`],
    ),
    M34: openWith("note", "string | undefined", 'event.data.by === "" ? undefined : event.data.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append(`void actor.dispatch(hsm.event("kick"));`),
    M44: append("void actor.dispatch(Push);"),
    M45: append("void actor.dispatch({ ...Push, data: { by: 1 } });"),
    M46: append(`void actor.dispatch({ ...Push, data: { by: "ann", at: 1 } });`),
    M47: append(`void actor.dispatch({ ...hsm.event("stored"), data: { id: "forged" } });`),
    M48: edit(["hsm.on(Push)", `hsm.on("psuh")`]),
    M49: append("void actor.dispatch(Close);"),
    M50: append(`hsm.stop(actor);\nvoid actor.dispatch(push("ann"));`),
    M52: edit([
      H.start,
      `hsm.start(\n  new Door(() => {\n    throw new Error("render failed");\n  }),\n  doorModel,\n)`,
    ]),
    M53: append(
      `export async function submit(text: string): Promise<boolean> {\n  await actor.dispatch({ ...Save, data: { text } });\n  return actor.state() === "/job/saved";\n}`,
    ),
    M55: na("the library's own events are hsm_-prefixed (hsm_initial, hsm_error): an app's names don't clash"),

    // The graph.
    M56: na("the model's states are its definition: none is declared apart"),
    M57: na("the model's states are its definition: none is declared apart"),
    M58: edit([H.lock, ""]),
    M59: edit([H.open, `hsm.state("open", entered("open")),`]),
    M60: edit([J.saved, `hsm.final("saved", hsm.transition(hsm.on(Retry), hsm.target("../idle"))),`]),
    M62: edit([
      `export const Unlock = hsm.event("unlock");`,
      `export const Unlock = hsm.event("unlock");\nexport const Kick = hsm.event("kick");`,
    ]),
    M63: edit([
      `const Failed = hsm.event("failed");`,
      `const Failed = hsm.event("failed");\nconst Lost = hsm.event("lost");`,
    ]),
    M64: edit([`entered("idle"),`, `entered("idle"),\n${J.storedTransition}`]),

    // Tasks.
    M65: edit([J.failedTransition, ""]),
    M66: edit([J.storedTransition, ""]),
    M67: edit([J.stored, `{ ...hsm.event("done"), data: { id } }`]),
    M68: task(`${J.save}.catch((e: unknown) => {\n            console.error(e);\n          })`),
    M69: edit([J.failed, "{ ...Failed, data: { error: error.message } }"]),
    M70: edit([J.failed, "{ ...Failed, data: { error } }"]),
    M71: edit([
      J.rejected,
      `(error: unknown) => {\n                if (!ctx.done && !(error instanceof DOMException && error.name === "AbortError")) void job.dispatch`,
    ]),
    M72: edit(
      [J.activity, "(ctx, job, event) =>\n        new Promise<void>"],
      [J.save, "save(event.data.text, abort.signal)"],
    ),
    M73: fetched(`{ ${POST} }`, "res.text()"),
    M74: edit([J.wire, "setTimeout(() => abort.abort(), 5000);"]),
    M75: fetched(`{ ${POST}, signal: abort.signal, timeout: 5000 }`, "res.text()"),
    M76: task(`${J.save}.catch(() => "")`),
    M77: task(`fetch("/api/save", { ${POST}, signal: abort.signal }).then((res) => res.text())`),
    M78: fetched(`{ ${POST}, signal: abort.signal }`, "(await res.json()).id"),
    M79: fetched(`{ ${POST}, signal: abort.signal }`, "(await res.json()) as string"),
    M80: taskBody(`${J.save};\n            return (job as Job).text;`),
    M81: taskBody(
      `(job as Job).text.split(",").forEach(async (part) => {\n              await save(part, abort.signal);\n            });\n            return (job as Job).text;`,
    ),
    M82: taskBody(`if ((job as Job).text === "") throw "empty";\n            return ${J.save};`),
    M83: task(
      `new Promise<string>((resolve) => {\n            const socket = new WebSocket("ws://localhost:1/save");\n            socket.onopen = () => socket.send((job as Job).text);\n            socket.onmessage = (m) => resolve(String(m.data));\n          })`,
    ),
    M84: taskBody(`setInterval(() => void ${J.save}, 1000);\n            return (job as Job).text;`),
    M87: na("a transition to the state itself exits and re-enters it: the activity restarts, as expected"),

    // Timers.
    M88: edit([J.after, `hsm.after("20 msec"),`]),
    M89: edit([J.after, `hsm.after("1d"),`]),
    M90: edit([J.after, "hsm.after(20),"]),
    M96: edit([
      J.timedOut,
      "hsm.effect((_ctx, job, event) => {\n        (job as Job).error = `timed out: ${event.data.text}`;\n      }),",
    ]),
    M104: na("a transition to the state itself re-enters it: its timer and its activity restart, a retry"),

    // Pure transitions.
    M116: lockCode("String(Date.now())"),
    M117: lockCode("String(Math.random())"),
    M119: lockCode("crypto.randomUUID()"),
    M120: { ...lockCode("event.data.code || fallback"), prepend: HELPERS.fallback },
    M121: { ...pushDoes("pushes += 1"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(event.data.by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: {
      ...pushSets("Object.assign(door as Door, { ...defaults, by: event.data.by });"),
      prepend: `const defaults = { by: "guest" };`,
    },
    M125: {
      ...pushSets("Object.assign(door as Door, withBy(event.data.by));"),
      prepend: "function withBy(by: string): { by: string } {\n  const out = { by, at: Date.now() };\n  return out;\n}",
    },
    M126: lockCode('[...new Set(event.data.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? event.data.code"),
    M128: na(
      "a payload is `any` and the data is the instance's fields: an effect that skips a field needs no cast (M2)",
    ),
    M128b: edit([J.failed, "{ ...Failed, data: { error: (error as Error).message } }"]),
    M129: pushSets(`(door as Door).by = event.data.by.split(" ")[0]!;`),
    M130: na("an effect is where hsm runs a transition's side effects: logging there is its form"),
    M131: na("an effect is where hsm runs a transition's side effects: a fire-and-forget request there is its form"),
    M132: edit([H.code, `setTimeout(() => console.info("relock"), 1000);\n        ${H.code}`]),
    M133: lockCode('localStorage.getItem("door-code") ?? event.data.code'),
    M134: lockCode("process.env.DOOR_CODE ?? event.data.code"),
    M135: pushSets(`// @ts-expect-error\n        ${broken}`),
    M135b: pushSets(`// @ts-ignore\n        ${broken}`),
    M135c: edit(
      [
        "// test/fixtures/door.ts in @stateforward/hsm",
        "// @ts-nocheck\n// test/fixtures/door.ts in @stateforward/hsm",
      ],
      [H.by, broken],
    ),
    M136: na("an effect is where hsm runs a transition's side effects: tracking there is its form"),
    M137: na("an effect is where hsm runs a transition's side effects: an imported tracker there is its form"),
    M138: { ...lockCode("stamp(event.data.code)"), prepend: HELPERS.stamp },
    M139: edit([
      H.guard,
      `hsm.guard((_ctx, door, event) => (door as Door).code?.split(",").filter((c) => c === event.data.code)),`,
    ]),

    // Persistence.
    M259: append("export const again = hsm.start(new Door(() => {}), doorModel, { data: actor.takeSnapshot() });"),
    M261: na("no restore: a model starts at its initial state, and takeSnapshot() can't be loaded back"),
    M265: na("the instance is the live state, and takeSnapshot() the one snapshot: no live and persisted pair"),

    // Use sites.
    M297: append("export const len = actor.by.length;"),
    M298: append(`export const is = actor.state() === "/door/opened";`),
    M300: edit([H.start, H.start.replace("doorModel)", `doorModel, { naem: "door" })`)]),
    M301: na("no `can`: the snapshot lists the current state's events"),
    M304: edit([H.start, H.start.replace("doorModel)", "doorModel as any)")]),
    M305: append("export const by = actor.by as string;"),
    M305b: edit([
      `export const actor = ${H.start};`,
      `export const actor: Door = hsm.start(\n  new Door((state) => {\n    if (state === "open") console.info(actor.by!.toUpperCase());\n  }),\n  doorModel,\n);`,
    ]),
    M307: na("one set of fields, every one nullable already: nothing to loosen"),
    M308: append(
      'export function label(door: Door): string {\n  switch (door.state()) {\n    case "/door/open":\n      return `open, by ${door.by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits.
    M344: edit([H.close, `hsm.transition(hsm.on(Close), hsm.target("closed"))`]),
    M345: edit([H.close, `hsm.transition(hsm.on(Close), hsm.target("../closed"), hsm.guard("isOpen"))`]),
    M345b: edit([H.close, `hsm.transition(hsm.on(Close), hsm.target("../closed"), hsm.effect("log"))`]),
    M345c: edit([H.close, `hsm.transition(hsm.on(Close), hsm.target("../closed"), hsm.cond("isOpen"))`]),
    M345d: edit([H.close, `hsm.transition(hsm.on(Close), hsm.target("../closed"), hsm.in("open"))`]),
    M346: na("several transitions on one event, the first enabled one taken, is how hsm writes it"),
    M347: edit([H.close, `${H.close},\n    hsm.transition(hsm.on(""), hsm.target("../closed"))`]),
    M348: na("hsm declines with a guard's false: no null or undefined to return"),
    M350: edit([H.initial, `hsm.initial("closed"),\n);`]),
    M351: edit([H.define, `${H.define}\n  { context: { by: null, code: null } },`]),
    M352: na("define's first argument names the model: that is its id"),
    M353: edit([J.saved, `hsm.state("saved", entered("saved"), { type: "final" }),`]),
    M354: edit([H.open, H.open.replace(`entered("open"), `, `entered("open"), hsm.invoke({ src: "audit" }), `)]),
    M355: edit([`entered("closed"),`, `entered("closed"),\n    hsm.activity("beep"),`]),
    M356: edit([H.define, `${H.define}\n  { predictableActionArguments: true },`]),
    M357: edit([H.define, `${H.define}\n  { types: {} as { context: { by: string | null; code: string | null } } },`]),
    M358: edit([H.initial, `hsm.initial(hsm.target("closed")),\n  { actions: {} },\n);`]),
    M362: append(`export const both = hsm.and(["isAdmin", "isActive"]);`),
    M363: edit([H.pushEffect, "hsm.effect(hsm.assign(({ event }) => ({ by: event.data.by }))),"]),
    M364: append("export const service = hsm.interpret(doorModel);"),
    M366: append("export const saver = hsm.fromPromise(async ({ input }: { input: { text: string } }) => input.text);"),
    M367: append(`export const loader = hsm.invoke({ src: "fetchUser" });`),
    M368: append(`void actor.dispatch("push");`),
    M369: append("hsm.start(actor, doorModel);"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.takeSnapshot().done;"),
    M372: append("export const value = actor.takeSnapshot().value;"),
    M373: append(`export const isOpen = actor.takeSnapshot().matches("open");`),
    M374: append("export const configured = doorModel.withConfig({});"),
    M375: append(
      `export const preset = hsm.start(new Door(() => {}), doorModel, { context: { by: "ann", code: null } });`,
    ),

    // From M404 on. Targets and data.
    M404: na("a transition's target is declared (`hsm.target`): an effect builds no step to return or drop"),
    // The 'no' branch as a second transition on unlock, back into `locked` with its data.
    M405: edit([
      H.guard,
      `${H.guard}\n    ),\n    hsm.transition(\n      hsm.on(Unlock),\n      hsm.target("../locked"),`,
    ]),
    M406: na("the data is the instance's fields, assigned by effects: no data object to put a getter in"),
    M407: na("no stay step: a transition without a target stays, in its own state"),
    M408: na("the first state is `hsm.initial(hsm.target(...))`: no start handler that could decline"),
    M409: na("the first state is `hsm.initial(hsm.target(...))`: no start handler to read an event"),
    M410: na("the data is the instance's fields, written in place by effects: that is hsm's form"),
    // The task's failure handler returns the event instead of dispatching it.
    M411: edit([
      `(error: unknown) => {\n                if (!ctx.done) void job.dispatch(${J.failed});\n              },`,
      `(error: unknown) => (${J.failed}),`,
    ]),
    M412: edit([
      H.lock,
      `${H.lock}    hsm.transition(\n      hsm.on(Push),\n      hsm.target("../open"),\n      hsm.effect((_ctx, door, event) => {\n        (door as Door).by = event.data.by.trim();\n      }),\n    ),\n`,
    ]),
    M413: lockGuard(
      `(_ctx, _door, event) => {\n        event.data.code.split("").forEach((c: string) => {\n          if (c === " ") return false;\n        });\n        return true;\n      }`,
    ),
    M414: pushSets('(door as Door).by = JSON.parse(`"${event.data.by}"`);'),

    // Contracts.
    M416: na("events are typed by their name only: no payload type to declare void"),
    M417: {
      prepend: `const OPENED: unique symbol = Symbol("opened");`,
      edits: [
        [H.fields, `${H.fields}\n  [OPENED]: boolean | null = null;`],
        [H.by, `${H.by}\n        (door as Door)[OPENED] = true;`],
      ],
    },
    M418: edit(
      [
        `export const Close = hsm.event("close");`,
        `export const Close = hsm.event("close");\nexport const ToString = hsm.event("toString");`,
      ],
      [
        `hsm.transition(hsm.on(Close), hsm.target("../closed"))),`,
        `hsm.transition(hsm.on(Close), hsm.target("../closed")), hsm.transition(hsm.on(ToString), hsm.target("../closed"))),`,
      ],
    ),
    M419: edit([`\n    "locked",`, `\n    "2",`], [`hsm.target("../locked")`, `hsm.target("../2")`]),
    M420: edit(
      [
        `export const Close = hsm.event("close");`,
        `export const Close = hsm.event("close");\nexport const CloseAll = hsm.event("Close");`,
      ],
      [H.close, `${H.close}, hsm.transition(hsm.on(CloseAll), hsm.target("../closed"))`],
    ),
    M421: na("events are names, any of them dispatchable: the task's are the model's own (M47 dispatches one)"),
    M422: edit(
      [
        `export const Close = hsm.event("close");`,
        `export const Close = hsm.event("close");\nexport const CloseAll = hsm.event("close*");`,
      ],
      [
        `hsm.transition(hsm.on(Close), hsm.target("../closed"))),`,
        `hsm.transition(hsm.on(Close), hsm.target("../closed")), hsm.transition(hsm.on(CloseAll), hsm.target("../closed"))),`,
      ],
    ),
    M423: savingWith("tags", "never[]", "[]"),
    M424: edit([H.fields, `by: "ann" | "bob" | string | null = null;`]),
    M425: na(
      "the data is the instance's class fields, and a class field can't be named `constructor` (a syntax error)",
    ),
    M426: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [H.fields, "by: Visitor | null = null;"],
        [H.pushHelper, H.pushHelper.replace("(by: string)", "(by: Visitor)")],
      ],
    },
    M427: na("no version: a model has no persisted format to number"),
    M428: na("no `types<T>()`: events are typed by name, and the data is the instance's class"),

    // Events and sending.
    M429: append(`void actor.dispatch(JSON.parse('{ "name": "push", "data": { "by": "ann" } }'));`),

    // The graph.
    M432: edit(
      [CANCEL, ""],
      [TIMEOUT, ""],
      [
        `hsm.state("failed", entered("failed"), hsm.transition(hsm.on(Retry), hsm.target("../idle"))),`,
        `hsm.state(\n    "failed",\n    entered("failed"),\n    hsm.transition(hsm.on(Retry), hsm.target("../idle")),\n    hsm.transition(hsm.on(Cancel), hsm.target("../idle")),\n  ),`,
      ],
    ),
    M433: edit([J.saved, `hsm.final("saved", hsm.transition(hsm.after(() => 1000), hsm.target("../idle"))),`]),
    M434: na("a state's transitions are its partials: no `on` map to write a handler beside"),

    // Tasks.
    M437: na("the activity reports back by dispatching an event: it has no step to return"),
    M438: taskBody(`await new Promise((resolve) => setTimeout(resolve, 5));\n            return ${J.save};`),
    M439: fetched(`{ ${POST}, signal: AbortSignal.timeout(5000) }`, "res.text()"),
    M440: taskBody(
      `const init = { ${POST} };\n            const res = await fetch("/api/save", init);\n            if (!res.ok) throw new Error(\`save failed: \${res.status}\`);\n            return res.text();`,
    ),
    M441: {
      prepend:
        'async function post(text: string): Promise<string> {\n  const res = await fetch("/api/save", { method: "POST", body: text });\n  if (!res.ok) throw new Error(`save failed: ${res.status}`);\n  return res.text();\n}',
      ...task("post((job as Job).text)"),
    },
    M443: fetched(`{ ${POST}, signal: abort.signal, mode: "no-cors" }`, "res.text()"),
    M444: posted(
      INIT,
      "res.text()",
      "if (!res.ok) throw new Error(`save failed: ${res.status}`);\n            console.info(await res.text());",
    ),
    M445: fetched(
      `{ ${POST}, signal: abort.signal, headers: { "Idempotency-Key": crypto.randomUUID() } }`,
      "res.text()",
    ),
    M446: taskBody(
      `for (let attempt = 0; attempt < 3; attempt++) {\n              try {\n                return await ${J.save};\n              } catch (e) {\n                if (attempt === 2) throw e;\n              }\n            }\n            throw new Error("unreachable");`,
    ),
    M447: task(`new Promise<string>(async (resolve) => {\n            resolve(await ${J.save});\n          })`),
    M448: taskBody(
      `const parts = (job as Job).text.split(",").filter(async (part) => (await save(part, abort.signal)) !== "");\n            return parts.join(",");`,
    ),
    M449: taskBody(
      `const ids: string[] = [];\n            for await (const id of (job as Job).text.split(",").map((part) => save(part, abort.signal))) ids.push(id);\n            return ids.join(",");`,
    ),
    M450: taskBody(
      `await Promise.allSettled((job as Job).text.split(",").map((part) => save(part, abort.signal)));\n            return (job as Job).text;`,
    ),
    M451: taskBody(`if ((job as Job).text === "") await Promise.reject("empty");\n            return ${J.save};`),
    M452: posted(INIT, "res.text()", "if (!res.ok) throw res.statusText;"),
    M453: posted(INIT, "res.text()", "if (!res.ok) new Error(`save failed: ${res.status}`);"),
    M454: taskBody(
      `try {\n              await save(\`audit:\${(job as Job).text}\`, abort.signal);\n            } catch {}\n            return ${J.save};`,
    ),
    M455: taskBody(
      `try {\n              return await ${J.save};\n            } catch (e: any) {\n              throw new Error(e.message);\n            }`,
    ),
    M456: task(`${J.save}.catch((e) => {\n            throw new Error(e.message);\n          })`),
    M457: taskBody(
      `try {\n              return await ${J.save};\n            } catch (e) {\n              throw new Error("save failed");\n            }`,
    ),
    M458: {
      prepend:
        "async function store(text: string, signal: AbortSignal): Promise<string> {\n  const id = await save(text, signal);\n  return id;\n}",
      ...taskBody(
        `try {\n              return store((job as Job).text, abort.signal);\n            } catch (e) {\n              throw new Error("save failed", { cause: e });\n            }`,
      ),
    },
    M459: taskBody(
      `let id = "";\n            try {\n              id = await ${J.save};\n            } finally {\n              return id;\n            }`,
    ),
    M460: taskBody(
      `const id = await ${J.save};\n            queueMicrotask(() => {\n              if (id === "") throw new Error("empty id");\n            });\n            return id;`,
    ),
    M461: task(`Promise.resolve("1")`),
    M462: taskBody(`if (process.env.NODE_ENV === "test") return "test";\n            return ${J.save};`),
    M463: fetched(
      `{ ${POST}, signal: abort.signal, headers: { Authorization: "Bearer sk_live_51HxQq2LzZ8vW1yTq" } }`,
      "res.text()",
    ),
    M464: {
      prepend: `let lastSaved = "";`,
      ...taskBody(`lastSaved = await ${J.save};\n            return lastSaved;`),
    },
    M465: {
      prepend:
        "async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {\n  const res = await fetch(url, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return res.json();\n}",
      ...task(
        "getJson<{ id: string }>(`/api/save?text=${encodeURIComponent((job as Job).text)}`, abort.signal).then((body) => body.id)",
      ),
    },
    M466: edit([
      `if (!ctx.done) void job.dispatch(${J.stored});`,
      "if (ctx.done) return;\n                const event = {} as hsm.Event;\n                event.kind = Stored.kind;\n                event.name = Stored.name;\n                event.data = { id };\n                void job.dispatch(event);",
    ]),
    M467: edit([J.stored, "{ ...Stored, data: { id: `${id}@${new Date().toString()}` } }"]),
    M468: taskBody(`await ${J.save};\n            return String(Date.now()) + Math.random().toString(36).slice(2);`),
    M469: posted(INIT, "res.text()", "if (res.status !== 200) throw new Error(`save failed: ${res.status}`);"),
    M470: taskBody(
      `const id = await ${J.save};\n            if (id === "") void actor.dispatch(Cancel);\n            return id;`,
    ),
    M471: task(
      `new Promise<string>((resolve, reject) => {\n            const xhr = new XMLHttpRequest();\n            xhr.open("POST", "/api/save");\n            xhr.onload = () => resolve(xhr.responseText);\n            xhr.onerror = () => reject(new Error("save failed"));\n            xhr.send((job as Job).text);\n          })`,
    ),
    M473: taskBody(
      `const stream = await navigator.mediaDevices.getUserMedia({ audio: true });\n            const id = await ${J.save};\n            stream.getTracks().forEach((track) => track.stop());\n            return id;`,
    ),
    M474: edit([J.failed, "{ ...Failed, data: { error: JSON.stringify(error) } }"]),
    // A `save` in `saving` as a transition without a target: it stays, and the activity keeps the
    // text it started with.
    M477: edit([
      CANCEL,
      `${CANCEL}    hsm.transition(\n      hsm.on(Save),\n      hsm.effect((_ctx, job, event) => {\n        ${J.text}\n      }),\n    ),\n`,
    ]),

    // Timers.
    M479: edit([J.after, "hsm.after(() => -20),"]),
    M480: edit([J.after, "hsm.after(() => 720 * 60 * 60 * 1000),"]),
    M481: edit([CANCEL, `${CANCEL}    hsm.transition(hsm.after(() => 20), hsm.target("../idle")),\n`]),
    M482: edit([
      H.open,
      `hsm.state(\n    "open",\n    entered("open"),\n    ${H.close},\n    hsm.transition(hsm.after(() => 0), hsm.target("../closed")),\n  ),`,
    ]),
    // The timer's transition without a target: it stays, and its `after` isn't armed again.
    M483: edit([`hsm.after(() => 20),\n      hsm.target("../failed"),\n      ${J.timedOut}`, "hsm.after(() => 20),"]),

    // Pure transitions: in the effect.
    M484: pushSets(`if (event.data.by === "") throw "by is required";\n        ${H.by}`),
    M485: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...lockGuard("() => (validCode ? true : false)"),
    },
    M486: pushSets(`(door as Door).by = event.data.by || "anonymous";`),
    M488: openWith("tries", "number", "Math.min(Math.max(event.data.by.length, 10), 1)"),
    M489: pushSets("(door as Door).by = event.data.by.toLocaleUpperCase();"),
    M490: savingWith("sizes", "number[]", `event.data.text.split(",").map(Number).sort()`),
    M491: savingWith("cells", "string[]", `Array(3).map(() => "")`),
    M492: saveSets(
      `const parts = event.data.text.split(",");\n        delete parts[0];\n        (job as Job).text = parts.join(",");`,
    ),
    M493: saveSets(
      `const parts = event.data.text.split(",");\n        for (let i = 0; i < parts.length; i++) if (parts[i] === "") parts.splice(i, 1);\n        (job as Job).text = parts.join(",");`,
    ),
    M494: saveSets(
      `let text = "";\n        for (const i in event.data.text.split(",")) text += i;\n        (job as Job).text = text;`,
    ),
    M495: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushSets("(door as Door).by = NAMES[event.data.by] ?? event.data.by;"),
    },
    M496: pushGuard("(_ctx, _door, event) => (event ? true : false)"),
    M497: pushSets("(door as Door).by = `by ${event}`;"),
    M498: openWith("offset", "number", "-event.data.by"),
    M499: {
      edits: [
        [H.pushHelper, `export const push = (by: "ann" | "bob"): hsm.Event => ({ ...Push, data: { by } });`],
        ...pushGuard(
          `(_ctx, _door, event) => {\n        switch (event.data.by) {\n          case "ann":\n            return true;\n          default:\n            return false;\n        }\n      }`,
        ).edits!,
      ],
    },

    // Persistence.
    M571: edit([
      H.start,
      `hsm.start(\n  new Door((state) => {\n    localStorage.setItem("door", state);\n  }),\n  doorModel,\n)`,
    ]),
    M573: na("takeSnapshot() is the one snapshot, and no restore loads it back"),

    // Use sites.
    M575: append("export const loose = hsm.start<any>(new Door(() => {}), doorModel);"),
    M576: edit([H.by, `// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access\n        ${H.by}`]),
    M577: append(
      `declare module "@stateforward/hsm" {\n  interface Instance {\n    retryLater(by: string): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["/door/closed", "/door/locked"] as const;\nexport const isShut = SHUT.includes(actor.state() as (typeof SHUT)[number]);`,
    ),
    M581: append("export const wrapped = hsm.start(new Door(() => {}), { ...doorModel });"),
    M582: append(`export const withInput = hsm.start(new Door(() => {}), doorModel, { input: { by: "ann" } });`),
    M583: append(`export function rename(by: string): void {\n  if (actor.state() === "/door/open") actor.by = by;\n}`),
    M584: edit([
      H.start,
      `hsm.start(\n  new Door(async (state) => {\n    await Promise.resolve();\n    try {\n      localStorage.setItem("door", state);\n    } catch (e) {\n      console.error(e);\n    }\n  }),\n  doorModel,\n)`,
    ]),
    M585: append(
      "let current = hsm.start(new Door(() => {}), doorModel);\nexport function reset(): void {\n  current = hsm.start(new Door(() => {}), doorModel);\n}\nexport const now = (): string => current.state();",
    ),
    M586: append(
      "export async function handle(text: string): Promise<string> {\n  const worker = hsm.start(new Job(() => {}), jobModel);\n  await worker.dispatch({ ...Save, data: { text } });\n  return worker.state();\n}",
    ),
    M587: append(
      `export function POST(req: Request): Response {\n  void actor.dispatch(push(req.headers.get("x-user") ?? ""));\n  return new Response(actor.state());\n}`,
    ),
    M588: na("no toPromise: a model has no output to await (afterEntry waits for a named state)"),
    // afterEntry is hsm's wait for a state.
    M589: append(`hsm.afterEntry(actor.context(), actor, "/job/saved");`),
    M591: na("no pure transition: dispatch runs on a started instance"),

    // React and app code: no React binding, so a component reads the module's instance.
    M593: append(
      `export function DoorView(): null {\n  if (actor.state() === "/door/closed") void actor.dispatch(push("ann"));\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.dispatch };"),
    M603: na("no subscribe: an instance's one listener is given to its constructor"),

    // Flows and modeling.
    M607: edit(
      [
        `export const Unlock = hsm.event("unlock");`,
        `export const Unlock = hsm.event("unlock");\nexport const SetOpen = hsm.event("setOpen");`,
      ],
      [
        H.lock,
        `${H.lock}    hsm.transition(\n      hsm.on(SetOpen),\n      hsm.target("../open"),\n      hsm.guard((_ctx, _door, event) => event.data.open === true),\n      hsm.effect((_ctx, door) => {\n        (door as Door).by = "";\n      }),\n    ),\n`,
      ],
      [
        H.open,
        `hsm.state(\n    "open",\n    entered("open"),\n    ${H.close},\n    hsm.transition(\n      hsm.on(SetOpen),\n      hsm.target("../closed"),\n      hsm.guard((_ctx, _door, event) => event.data.open === false),\n    ),\n  ),`,
      ],
    ),

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    M613: append(`export const named = hsm.start(new Door(() => {}), doorModel, { id: "door", devTools: true });`),
    M614: na("an activity is a bare async function: that is hsm's own form"),
    M615: edit([CANCEL, `${CANCEL}    hsm.onDone(hsm.target("../saved")),\n`]),
  },
};
export default library;
