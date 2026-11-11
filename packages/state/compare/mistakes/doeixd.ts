// @doeixd/machine: each case in the port ../doeixd/door.ts, written as its README writes typestates
// (each state its own `TypeState`, transitions as methods returning the next snapshot, made with
// `createMachine`), run by `createActor`, sent through its `send` proxy (`actor.send.push("ann")`).
// The actor warns on a transition the snapshot lacks and logs a transition's or a subscriber's
// throw: those count at start. No job port (no timers, no task a state's exit cancels): every job
// case is n/a.
//
// A transition is a pure function by the library's design rule (its README: purity is a rule, not
// enforced), so the purity cases put the read or the effect in the transition method.

import { append, type CaseModule, edit, HELPERS, type Library, type Mutation, na, SCENARIO, settle } from "./cases.ts";

// The port's lines, as written there.
const D = {
  push: `push: (by: string): Open => createMachine({ state: "open", by } as const, openTransitions),`,
  lock: `lock: (code: string): Locked => createMachine({ state: "locked", code } as const, lockedTransitions),`,
  open: "const openTransitions = { close: (): Closed => closed };",
  close: "close: (): Closed => closed",
  unlock: "return code === this.context.code ? closed : this;",
  pushSig: "push(by: string): Open;",
  closedSig: "{ push(by: string): Open; lock(code: string): Locked }",
  openContext: `{ readonly state: "open"; readonly by: string }`,
  lockedContext: `{ readonly state: "locked"; readonly code: string }`,
  closed: `export const closed: Closed = createMachine({ state: "closed" } as const, closedTransitions);`,
};

/** A field added to `open`'s context, given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [D.openContext, `{ readonly state: "open"; readonly by: string; readonly ${field}: ${type} }`],
    [
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by, ${field}: ${value} } as const, openTransitions),`,
    ],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
const pushDoes = (effect: string): Mutation =>
  edit([
    D.push,
    `push: (by: string): Open => (${effect}, createMachine({ state: "open", by } as const, openTransitions)),`,
  ]);
const lockCode = (code: string): Mutation =>
  edit([D.lock, D.lock.replace('{ state: "locked", code }', `{ state: "locked", code: ${code} }`)]);
const opne = D.push.replace('"open"', '"opne"');
const NO_JOB = na("no job port: no timers, and no task that leaving a state cancels");
/** `push`'s context, built another way. */
const pushTo = (context: string): Mutation =>
  edit([D.push, `push: (by: string): Open => createMachine(${context} as const, openTransitions),`]);
/** `lock` as a method that may decline (return `this`), its signature widened to match. */
const lockOrStay = (body: string): Mutation =>
  edit(
    [D.closedSig, "{ push(by: string): Open; lock(code: string): Locked | Closed }"],
    [D.lock, `lock(this: Closed, code: string): Locked | Closed {\n    ${body}\n  },`],
  );
const LOCKED = `createMachine({ state: "locked", code } as const, lockedTransitions)`;
const OPEN_SIG = "{ close(): Closed }";

const tail = `\nimport { createActor } from "@doeixd/machine";\nexport const actor = createActor<Door>(closed);\n`;

interface Actor {
  dispatch(event: { readonly type: string; readonly args: readonly unknown[] }): void;
}

const doeixd: Library = {
  name: "@doeixd/machine",
  bases: { door: { port: "../doeixd/door.ts", tail } },
  drive: async (mod: CaseModule, base) => {
    const actor = mod.actor as Actor;
    // An event's payload is its transition's arguments, in order.
    for (const { type, ...payload } of SCENARIO[base]) actor.dispatch({ type, args: Object.values(payload) });
    await settle();
  },
  cases: {
    // Targets and data.
    M1: edit([D.push, opne]),
    M2: edit([
      D.lock,
      `lock: (code: string): Locked => createMachine({ state: "locked" } as const, lockedTransitions),`,
    ]),
    M3: edit([
      D.open,
      `const openTransitions = {\n  close(this: Open): Closed {\n    return createMachine({ state: "closed", by: this.context.by } as const, closedTransitions);\n  },\n};`,
    ]),
    M4: edit([
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by, at: 1 } as const, openTransitions),`,
    ]),
    M5: edit([
      D.push,
      `push: (by: string): Open => createMachine({ ...{ state: "open", by, at: 1 } } as const, openTransitions),`,
    ]),
    M6: edit([
      D.push,
      `push: (by: string): Open => {\n    const next = { state: "open", by, at: 1 } as const;\n    return createMachine(next, openTransitions);\n  },`,
    ]),
    M7: edit([
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by: by.length } as const, openTransitions),`,
    ]),
    M8: edit([
      D.push,
      `push: (by: string): Open => {\n    createMachine({ state: "open", by } as const, openTransitions);\n  },`,
    ]),
    M9: edit([
      D.push,
      `push: async (by: string): Promise<Open> => createMachine({ state: "open", by } as const, openTransitions),`,
    ]),
    M10: edit([D.unlock, "this.context.code = code;\n    return closed;"]),
    M12: edit([
      D.lock,
      `lock(this: Closed, code: string): Locked {\n    return createMachine({ state: "locked", code: this.context.code } as const, lockedTransitions);\n  },`,
    ]),
    M13: na("a payload is the transition's parameters: there's no event object to read a missing field from"),
    M14: edit([
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by: by.split(" ")[0] } as const, openTransitions),`,
    ]),
    M15: edit([
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by: undefined } as const, openTransitions),`,
    ]),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [D.pushSig, "push(by: Date): Open;"],
      [D.push, `push: (by: Date): Open => createMachine({ state: "open", by: String(by) } as const, openTransitions),`],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([D.openContext, `{ readonly state: "open"; readonly [key: string]: string }`]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("a payload is the transition's arguments, beside the event's `type`: no field can clash with it"),
    M25: NO_JOB,
    M26: NO_JOB,
    M27: openWith("note", "File", 'new File([by], "note.txt")'),
    M28: openWith("visitor", "Visitor", "new Visitor(by)", HELPERS.visitor),
    M29: openWith("visits", "bigint", "BigInt(by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", by]])'),
    M32: edit([D.pushSig, "push(by: string, click: MouseEvent): Open;"]),
    M33: edit(
      [D.pushSig, "push(by: string, button: HTMLElement): Open;"],
      [D.openContext, `{ readonly state: "open"; readonly by: string; readonly button: HTMLElement }`],
      [
        D.push,
        `push: (by: string, button: HTMLElement): Open => createMachine({ state: "open", by, button } as const, openTransitions),`,
      ],
    ),
    M34: openWith("note", "string | undefined", 'by === "" ? undefined : by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append("actor.send.kick();"),
    M44: append("actor.send.push();"),
    M45: append("actor.send.push(1);"),
    M46: append(`actor.send.push("ann", 1);`),
    M47: NO_JOB,
    M48: edit([D.push, D.push.replace("push:", "psuh:")]),
    M49: append("actor.send.close();"),
    M50: append(`actor.stop();\nactor.send.push("ann");`),
    M52: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
    M53: NO_JOB,
    M55: na("the one reserved name is `context`, a snapshot's data: no door event is named so"),

    // The graph.
    M56: edit([D.open, ""]),
    M57: edit([
      D.open,
      `${D.open}\nconst broken = createMachine({ state: "broken" } as const, { close: (): Closed => closed });`,
    ]),
    M58: edit([D.closedSig, "{ push(by: string): Open }"], [D.lock, ""]),
    M59: na("a typestate with no transitions is how a final state is written: there's no final marker"),
    M60: NO_JOB,
    M62: edit([D.closedSig, "{ push(by: string): Open; lock(code: string): Locked; kick(): Closed }"]),
    M63: NO_JOB,
    M64: NO_JOB,

    // Tasks.
    M65: NO_JOB,
    M66: NO_JOB,
    M67: NO_JOB,
    M68: NO_JOB,
    M69: NO_JOB,
    M70: NO_JOB,
    M71: NO_JOB,
    M72: NO_JOB,
    M73: NO_JOB,
    M74: NO_JOB,
    M75: NO_JOB,
    M76: NO_JOB,
    M77: NO_JOB,
    M78: NO_JOB,
    M79: NO_JOB,
    M80: NO_JOB,
    M81: NO_JOB,
    M82: NO_JOB,
    M83: NO_JOB,
    M84: NO_JOB,
    M87: NO_JOB,

    // Timers.
    M88: NO_JOB,
    M89: NO_JOB,
    M90: NO_JOB,
    M96: NO_JOB,
    M104: NO_JOB,

    // Pure transitions.
    M116: lockCode("String(Date.now())"),
    M117: lockCode("String(Math.random())"),
    M119: lockCode("crypto.randomUUID()"),
    M120: { ...lockCode("code || fallback"), prepend: HELPERS.fallback },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: {
      ...edit([
        D.push,
        `push: (by: string): Open => createMachine({ ...defaults, state: "open", by } as const, openTransitions),`,
      ]),
      prepend: `const defaults = { by: "guest" };`,
    },
    M125: {
      ...edit([D.push, "push: (by: string): Open => createMachine(withBy(by), openTransitions),"]),
      prepend: `function withBy(by: string): { readonly state: "open"; readonly by: string } {\n  const out = { state: "open" as const, by, at: Date.now() };\n  return out;\n}`,
    },
    M126: lockCode('[...new Set(code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? code"),
    M128: edit([
      D.lock,
      `lock: (code: string): Locked =>\n    createMachine({ state: "locked" } as ${D.lockedContext}, lockedTransitions),`,
    ]),
    M128b: NO_JOB,
    M129: edit([
      D.push,
      `push: (by: string): Open => createMachine({ state: "open", by: by.split(" ")[0]! } as const, openTransitions),`,
    ]),
    M130: pushDoes(`console.log("pushed by", by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: by }).catch(() => {})`),
    M132: edit([
      D.lock,
      `lock: (code: string): Locked => (setTimeout(() => console.info("relock"), 1000), createMachine({ state: "locked", code } as const, lockedTransitions)),`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? code'),
    M134: lockCode("process.env.DOOR_CODE ?? code"),
    M135: edit([D.push, `// @ts-expect-error\n  ${opne}`]),
    M135b: edit([D.push, `// @ts-ignore\n  ${opne}`]),
    M135c: edit(
      ["// test/fixtures/door.ts in @doeixd/machine", "// @ts-nocheck\n// test/fixtures/door.ts in @doeixd/machine"],
      [D.push, opne],
    ),
    M136: {
      ...edit([D.close, `close: (): Closed => (analytics.track("closed"), closed)`]),
      prepend: HELPERS.analytics,
    },
    M137: {
      ...edit([D.close, `close: (): Closed => (track("closed"), closed)`]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: { ...lockCode("stamp(code)"), prepend: HELPERS.stamp },
    M139: edit([D.unlock, `return this.context.code.split(",").filter((c) => c === code) ? closed : this;`]),

    // Persistence.
    M259: na("createActor takes a snapshot: that is how an actor starts from one"),
    M261: append(
      "const saved = JSON.stringify(actor.getSnapshot());\nexport const restored = createActor<Door>(JSON.parse(saved));",
    ),
    M265: NO_JOB,

    // Use sites.
    M297: append("export const len = actor.getSnapshot().context.by.length;"),
    M298: append(`export const is = actor.getSnapshot().context.state === "opened";`),
    M300: na("no machine options: createMachine takes a context and transitions, createActor a snapshot"),
    M301: na(`no \`can\`: a snapshot has the transition's method or doesn't ("close" in s)`),
    M304: edit(["createActor<Door>(closed)", "createActor<Door>(closed as any)"]),
    M305: append("export const by = (actor.getSnapshot().context as { by: string }).by;"),
    M305b: append(
      `actor.subscribe((s) => {\n  if (s.context.state === "open") console.info(s.context.by!.toUpperCase());\n});`,
    ),
    M307: edit(
      [D.lockedContext, `{ readonly state: "locked"; readonly code?: string }`],
      [D.lock, `lock: (code: string): Locked => createMachine({ state: "locked" } as const, lockedTransitions),`],
    ),
    M308: append(HELPERS.label("actor.getSnapshot", "s.context.state", "s.context.by")),

    // Migration habits.
    M344: edit([D.close, `close: "closed"`]),
    M345: edit([D.close, `close: { target: "closed", guard: "isOpen" }`]),
    M345b: edit([D.close, `close: { target: "closed", actions: "log" }`]),
    M345c: edit([D.close, `close: { target: "closed", cond: "isOpen" }`]),
    M345d: edit([D.close, `close: { target: "closed", in: "open" }`]),
    M346: edit([D.push, `push: [{ target: "open" }, { target: "locked" }],`]),
    M347: edit([D.open, `const openTransitions = { close: (): Closed => closed, "": (): Closed => closed };`]),
    M348: edit([D.unlock, "return code === this.context.code ? closed : undefined;"]),
    M350: na("no machine config: the first state is the snapshot given to createActor"),
    M351: na("context is how @doeixd/machine names a snapshot's data"),
    M352: na("no machine config: a machine is a snapshot and its methods, with nothing to name"),
    M353: NO_JOB,
    M354: edit([D.open, `const openTransitions = { invoke: { src: "audit" }, close: (): Closed => closed };`]),
    M355: edit([
      "const closedTransitions = {\n  push:",
      `const closedTransitions = {\n  activities: ["beep"],\n  push:`,
    ]),
    M356: na("no machine config: createMachine takes a context and transitions"),
    M357: na("no setup: a state's types are its TypeState"),
    M358: edit([D.closed, D.closed.replace("closedTransitions);", "closedTransitions, { actions: {} });")]),
    M362: append(`import { and } from "@doeixd/machine";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([D.push, `push: { target: "open", actions: assign(({ event }) => ({ by: event.by })) },`]),
      prepend: `import { assign } from "@doeixd/machine";`,
    },
    M364: append(`import { interpret } from "@doeixd/machine";\nexport const service = interpret(closed);`),
    M366: NO_JOB,
    M367: append(`import { setup } from "@doeixd/machine";\nexport const configured = setup({ actions: {} });`),
    M368: append(`actor.send("push");`),
    M369: append("actor.stop();\nactor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.getSnapshot().done;"),
    M372: append("export const value = actor.getSnapshot().value;"),
    M373: append(`export const isOpen = actor.getSnapshot().matches("open");`),
    M374: append("export const configured = closed.withConfig({});"),
    M375: append(`export const preset = createActor<Door>(closed, { context: { by: "ann" } });`),

    // From M404 on. Targets and data: a transition declines by returning `this`.
    M404: lockOrStay(`if (code !== "") ${LOCKED};\n    return this;`),
    M405: edit([
      D.unlock,
      `return code === this.context.code\n      ? closed\n      : createMachine({ state: "locked", code: this.context.code } as const, lockedTransitions);`,
    ]),
    M406: edit([
      D.push,
      `push: (by: string): Open =>\n    createMachine(\n      {\n        state: "open",\n        get by() {\n          return by;\n        },\n      } as const,\n      openTransitions,\n    ),`,
    ]),
    M407: na("no stay step: staying is returning `this`, which is the handler's own state"),
    M408: na("the first state is the snapshot given to createActor: no start handler that could decline"),
    M409: na("the first state is the snapshot given to createActor: no start handler to read an event"),
    M410: edit([
      D.lock,
      `lock(this: Closed, code: string): Locked {\n    return createMachine(Object.assign(this.context, { state: "locked" as const, code }), lockedTransitions);\n  },`,
    ]),
    M411: NO_JOB,
    M412: edit([
      D.lock,
      `${D.lock}\n  push: (by: string): Open => createMachine({ state: "open", by: by.trim() } as const, openTransitions),`,
    ]),
    M413: edit([
      D.lock,
      `lock(this: Closed, code: string): Locked {\n    code.split("").forEach((c) => {\n      if (c === " ") return this;\n    });\n    return ${LOCKED};\n  },`,
    ]),
    M414: pushTo('{ state: "open", by: JSON.parse(`"${by}"`) }'),

    // Contracts.
    M416: na("a payload is the transition's parameters: an event without one takes none, with no type to write"),
    M417: openWith("[OPENED]", "boolean", "true", `const OPENED: unique symbol = Symbol("opened");`),
    M418: edit(
      [OPEN_SIG, "{ close(): Closed; toString(): Closed }"],
      [D.open, "const openTransitions = { close: (): Closed => closed, toString: (): Closed => closed };"],
    ),
    M419: edit([`"locked"`, `"2"`, "all"]),
    M420: edit(
      [OPEN_SIG, "{ close(): Closed; Close(): Closed }"],
      [D.open, "const openTransitions = { close: (): Closed => closed, Close: (): Closed => closed };"],
    ),
    M421: NO_JOB,
    M422: edit(
      [OPEN_SIG, `{ close(): Closed; "close*"(): Closed }`],
      [D.open, `const openTransitions = { close: (): Closed => closed, "close*": (): Closed => closed };`],
    ),
    M423: NO_JOB,
    M424: edit([D.openContext, `{ readonly state: "open"; readonly by: "ann" | "bob" | string }`]),
    M425: openWith("constructor", "string", "by"),
    M426: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [D.openContext, `{ readonly state: "open"; readonly by: Visitor }`],
        [D.pushSig, "push(by: Visitor): Open;"],
        [D.push, D.push.replace("(by: string)", "(by: Visitor)")],
      ],
    },
    M427: na("no version: a machine has no persisted format to number"),
    M428: na("no `types<T>()`: a state's types are its TypeState"),

    // Events and sending.
    // In a message handler: sent at load, the push would put the door open before the app's push,
    // which the actor warns about (it warns on any transition the snapshot lacks).
    M429: append("export function onMessage(message: string): void {\n  actor.dispatch(JSON.parse(message));\n}"),

    // The graph.
    M432: NO_JOB,
    M433: NO_JOB,
    M434: na("transitions are the snapshot's methods: no `on` map to write a handler beside"),

    // Tasks.
    M437: NO_JOB,
    M438: NO_JOB,
    M439: NO_JOB,
    M440: NO_JOB,
    M441: NO_JOB,
    M443: NO_JOB,
    M444: NO_JOB,
    M445: NO_JOB,
    M446: NO_JOB,
    M447: NO_JOB,
    M448: NO_JOB,
    M449: NO_JOB,
    M450: NO_JOB,
    M451: NO_JOB,
    M452: NO_JOB,
    M453: NO_JOB,
    M454: NO_JOB,
    M455: NO_JOB,
    M456: NO_JOB,
    M457: NO_JOB,
    M458: NO_JOB,
    M459: NO_JOB,
    M460: NO_JOB,
    M461: NO_JOB,
    M462: NO_JOB,
    M463: NO_JOB,
    M464: NO_JOB,
    M465: NO_JOB,
    M466: NO_JOB,
    M467: NO_JOB,
    M468: NO_JOB,
    M469: NO_JOB,
    M470: NO_JOB,
    M471: NO_JOB,
    M473: NO_JOB,
    M474: NO_JOB,
    M477: NO_JOB,

    // Timers.
    M479: NO_JOB,
    M480: NO_JOB,
    M481: NO_JOB,
    M482: na("no timers"),
    M483: NO_JOB,

    // Pure transitions: in the transition method.
    M484: edit([
      D.push,
      `push: (by: string): Open => {\n    if (by === "") throw "by is required";\n    return createMachine({ state: "open", by } as const, openTransitions);\n  },`,
    ]),
    M485: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...lockOrStay(`return validCode ? ${LOCKED} : this;`),
    },
    M486: pushTo(`{ state: "open", by: by || "anonymous" }`),
    M488: openWith("tries", "number", "Math.min(Math.max(by.length, 10), 1)"),
    M489: pushTo(`{ state: "open", by: by.toLocaleUpperCase() }`),
    M490: NO_JOB,
    M491: NO_JOB,
    M492: NO_JOB,
    M493: NO_JOB,
    M494: NO_JOB,
    M495: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushTo(`{ state: "open", by: NAMES[by] ?? by }`),
    },
    M496: na("no event object: a transition gets its payload as its arguments"),
    M497: na("no event object: a transition gets its payload as its (string) arguments"),
    M498: openWith("offset", "number", "-by"),
    M499: edit(
      [D.pushSig, `push(by: "ann" | "bob"): Open | Closed;`],
      [
        D.push,
        `push(this: Closed, by: "ann" | "bob"): Open | Closed {\n    switch (by) {\n      case "ann":\n        return createMachine({ state: "open", by: "ann" } as const, openTransitions);\n      default:\n        return this;\n    }\n  },`,
      ],
    ),

    // Persistence.
    M571: append(`actor.subscribe((s) => {\n  localStorage.setItem("door", JSON.stringify(s.context));\n});`),
    M573: NO_JOB,

    // Use sites.
    M575: append("export const loose = createActor<any>(closed);"),
    M576: edit([D.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n  ${D.push}`]),
    M577: append(
      `import type { BaseMachine } from "@doeixd/machine";\ndeclare module "@doeixd/machine" {\n  interface Actor<M extends BaseMachine<any>> {\n    retryLater(snapshot: M): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.getSnapshot().context.state as (typeof SHUT)[number]);`,
    ),
    M581: append("export const wrapped = createActor<Door>({ ...closed });"),
    M582: append(`export const withInput = createActor<Door>(closed, { input: { by: "ann" } });`),
    M583: append(
      `export function rename(by: string): void {\n  const s = actor.getSnapshot();\n  if (s.context.state === "open") s.context.by = by;\n}`,
    ),
    M584: append(
      `actor.subscribe(async (s) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(s.context));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: append(
      "let current = createActor<Door>(closed);\nexport function reset(): void {\n  current = createActor<Door>(closed);\n}\nexport const now = (): string => current.getSnapshot().context.state;",
    ),
    M586: NO_JOB,
    M587: append(
      `export function POST(req: Request): Response {\n  actor.send.push(req.headers.get("x-user") ?? "");\n  return new Response(actor.getSnapshot().context.state);\n}`,
    ),
    M588: na("no toPromise: an actor has no done or output to await"),
    M589: NO_JOB,
    // A transition is pure: called on a snapshot, it returns the next one and changes nothing.
    M591: append(`closed.push("ann");`),

    // React and app code: @doeixd/machine/react's useActor.
    M593: append(
      `import { useActor } from "@doeixd/machine/react";\nexport function DoorView(): null {\n  const s = useActor(actor);\n  if (s.context.state === "closed") actor.send.push("ann");\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send.close };"),
    M603: append(
      "export function Log(): null {\n  actor.subscribe((s) => console.info(s.context.state));\n  return null;\n}",
    ),

    // Flows and modeling.
    M607: edit(
      [D.closedSig, "{ push(by: string): Open; lock(code: string): Locked; setOpen(open: boolean): Open | Closed }"],
      [OPEN_SIG, "{ close(): Closed; setOpen(open: boolean): Closed | Open }"],
      [
        D.lock,
        `${D.lock}\n  setOpen(this: Closed, open: boolean): Open | Closed {\n    return open ? createMachine({ state: "open", by: "" } as const, openTransitions) : this;\n  },`,
      ],
      [
        D.open,
        "const openTransitions = {\n  close: (): Closed => closed,\n  setOpen(this: Open, open: boolean): Closed | Open {\n    return open ? this : closed;\n  },\n};",
      ],
    ),

    // Migration habits.
    M612: na("getSnapshot() is @doeixd/machine's own name"),
    M613: append(`export const named = createActor<Door>(closed, { id: "door", devTools: true });`),
    M614: NO_JOB,
    M615: NO_JOB,
  },
};
export default doeixd;
