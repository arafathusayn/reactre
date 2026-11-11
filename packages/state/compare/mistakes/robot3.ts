// Robot (robot3): each case in the port ../robot3/door.ts, written as Robot's docs write a machine
// (`state`, `transition`, `reduce` for the context, `guard` to decline). Robot has one context for
// every state, so a mistake about one state's data is made in it. The tail imports `robot3/debug`,
// Robot's development mode (it throws on an unknown target and on an event no transition takes):
// its throws count. The actor is `interpret(machine, onChange)`, whose `onChange` is the one
// listener. No job port (no timers), so every job case is n/a.
//
// Reducers and guards are the pure part of a transition (docs: `action` is where effects go), so
// the purity cases put the impure read or write in `reduce`, or in the guard.

import { append, type CaseModule, edit, HELPERS, type Library, type Mutation, na, SCENARIO, settle } from "./cases.ts";

// The port's parts, as written there.
const R = {
  pushReduce: "reduce((_: DoorContext, e: { by: string }): DoorContext => ({ by: e.by, code: null })),",
  lockReduce: "reduce((_: DoorContext, e: { code: string }): DoorContext => ({ by: null, code: e.code })),",
  pushTarget: `"push",\n        "open",`,
  open: `open: state(transition("close", "closed")),`,
  close: `transition("close", "closed")`,
  guard: "guard((ctx: DoorContext, e: { code: string }) => e.code === ctx.code),",
  context: "(): DoorContext => ({ by: null, code: null }),",
  contextEnd: "  readonly code: string | null;\n}",
  pushEvent: `{ readonly type: "push"; readonly by: string }`,
  listener: "interpret(doorMachine, () => {})",
};
const lockTransition = `      transition(\n        "lock",\n        "locked",\n        ${R.lockReduce}\n      ),\n`;

/** `push`'s reducer, with this body. */
const pushReduce = (body: string): Mutation =>
  edit([R.pushReduce, `reduce((_: DoorContext, e: { by: string }): DoorContext => ${body}),`]);
/** `lock`'s code, computed in its reducer. */
const lockCode = (code: string): Mutation =>
  edit([R.lockReduce, R.lockReduce.replace("code: e.code", `code: ${code}`)]);
/** An effect in `push`'s reducer, before the context it returns. */
const pushDoes = (effect: string): Mutation => pushReduce(`(${effect}, { by: e.by, code: null })`);
/** A field added to the context (null at first), given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [R.contextEnd, `  readonly code: string | null;\n  readonly ${field}: ${type} | null;\n}`],
    [R.context, `(): DoorContext => ({ by: null, code: null, ${field}: null }),`],
    [R.pushReduce, R.pushReduce.replace("code: null }", `code: null, ${field}: ${value} }`)],
    [R.lockReduce, R.lockReduce.replace("code: e.code }", `code: e.code, ${field}: null }`)],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** Robot's targets aren't typed, so the hidden error is a payload field the event lacks. */
const broken = R.pushReduce.replace("by: e.by", "by: e.name");

/** The end of the closed state: its lock transition, then the state's close. */
const CLOSED_END = `        ${R.lockReduce}\n      ),\n    ),`;
/** A transition added to the closed state, after lock. */
const closedAlso = (transition: string): Mutation =>
  edit([CLOSED_END, `        ${R.lockReduce}\n      ),\n      ${transition},\n    ),`]);
/** `push`'s transition, with a guard before its reducer. */
const pushGuard = (fn: string): Mutation => edit([R.pushTarget, `${R.pushTarget}\n        guard(${fn}),`]);
/** `lock`'s transition, with a guard before its reducer. */
const lockGuard = (fn: string): Mutation =>
  edit([`"locked",\n        ${R.lockReduce}`, `"locked",\n        guard(${fn}),\n        ${R.lockReduce}`]);
const NO_JOB = "no job port";
/** The helpers the cases from M404 on declare. */
const OPENED = `const OPENED: unique symbol = Symbol("opened");`;
const ENUM = `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`;
const VALID = "const validCode = (code: string): boolean => code.length === 1;";
const NAMES = `const NAMES: Record<string, string> = { ann: "Ann" };`;

const tail = `\nimport "robot3/debug";\nimport { interpret } from "robot3";\nexport const actor = ${R.listener};\n`;

interface Service {
  send(event: object): void;
}

const robot3: Library = {
  name: "Robot (robot3)",
  bases: { door: { port: "../robot3/door.ts", tail } },
  drive: async (mod: CaseModule) => {
    const actor = mod.actor as Service;
    for (const event of SCENARIO.door) actor.send(event);
    await settle();
  },
  cases: {
    // Targets and data.
    M1: edit([R.pushTarget, `"push",\n        "opne",`]),
    M2: edit([`"locked",\n        ${R.lockReduce}`, `"locked",`]),
    M3: na("one context for every state: a state without data has the machine's context"),
    M4: pushReduce("({ by: e.by, code: null, at: 1 })"),
    M5: pushReduce("({ ...{ by: e.by, code: null, at: 1 } })"),
    M6: pushReduce(`{\n          const next = { by: e.by, code: null, at: 1 };\n          return next;\n        }`),
    M7: pushReduce("({ by: e.by.length, code: null })"),
    M8: pushReduce("{ ({ by: e.by, code: null }); }"),
    M9: edit([R.guard, R.guard.replace("guard((", "guard(async (")]),
    M10: edit([
      R.pushReduce,
      "reduce((ctx: DoorContext, e: { by: string }): DoorContext => {\n          ctx.by = e.by;\n          return ctx;\n        }),",
    ]),
    M12: edit([R.lockReduce, "reduce((ctx: DoorContext): DoorContext => ({ by: null, code: ctx.code })),"]),
    M13: edit([R.pushReduce, broken]),
    M14: pushReduce(`({ by: e.by.split(" ")[0], code: null })`),
    M15: pushReduce("({ by: undefined, code: null })"),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [R.pushEvent, `{ readonly type: "push"; readonly by: Date }`],
      [R.pushReduce, "reduce((_: DoorContext, e: { by: Date }): DoorContext => ({ by: String(e.by), code: null })),"],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([
      "  readonly by: string | null;\n  readonly code: string | null;\n}",
      "  readonly [key: string]: string | null;\n}",
    ]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("an event's `type` is its name, read by send: a payload can't carry a second one"),
    M25: na("no job port"),
    M26: na("no job port"),
    M27: openWith("note", "File", 'new File([e.by], "note.txt")'),
    M28: openWith("visitor", "Visitor", "new Visitor(e.by)", HELPERS.visitor),
    M29: openWith("visits", "bigint", "BigInt(e.by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([e.by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", e.by]])'),
    M32: edit(
      [R.pushEvent, `{ readonly type: "push"; readonly by: string; readonly click: MouseEvent }`],
      [R.pushReduce, R.pushReduce.replace("e: { by: string }", "e: { by: string; click: MouseEvent }")],
    ),
    M33: edit(
      [R.pushEvent, `{ readonly type: "push"; readonly by: string; readonly button: HTMLElement }`],
      [R.contextEnd, "  readonly code: string | null;\n  readonly button: HTMLElement | null;\n}"],
      [R.context, "(): DoorContext => ({ by: null, code: null, button: null }),"],
      [
        R.pushReduce,
        "reduce((_: DoorContext, e: { by: string; button: HTMLElement }): DoorContext => ({ by: e.by, code: null, button: e.button })),",
      ],
      [R.lockReduce, R.lockReduce.replace("code: e.code }", "code: e.code, button: null }")],
    ),
    M34: openWith("note", "string | undefined", 'e.by === "" ? undefined : e.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append(`actor.send({ type: "kick" });`),
    // Each push is closed again, so the app's own push finds the door closed, as in the correct port.
    M44: append(`actor.send({ type: "push" });\nactor.send({ type: "close" });`),
    M45: append(`actor.send({ type: "push", by: 1 });\nactor.send({ type: "close" });`),
    M46: append(`actor.send({ type: "push", by: "ann", at: 1 });\nactor.send({ type: "close" });`),
    M47: na("no job port"),
    M48: edit([R.pushTarget, `"psuh",\n        "open",`]),
    M49: append(`actor.send({ type: "close" });`),
    M50: na("a service has no stop: it is dropped, never stopped"),
    M52: edit([R.listener, `interpret(doorMachine, () => {\n  throw new Error("render failed");\n})`]),
    M53: na("no job port"),
    M55: na("no event name is reserved outside an invoke state (done, error), and the door has none"),

    // The graph.
    M56: na("the machine's keys are the states: none is declared apart"),
    M57: na("the machine's keys are the states: none is declared apart"),
    M58: edit([lockTransition, ""]),
    M59: edit([R.open, "open: state(),"]),
    M60: na("no job port"),
    M62: na("a machine's events are its transitions' names: none is declared apart"),
    M63: na("no job port"),
    M64: na("no job port"),

    // Tasks.
    M65: na("no job port"),
    M66: na("no job port"),
    M67: na("no job port"),
    M68: na("no job port"),
    M69: na("no job port"),
    M70: na("no job port"),
    M71: na("no job port"),
    M72: na("no job port"),
    M73: na("no job port"),
    M74: na("no job port"),
    M75: na("no job port"),
    M76: na("no job port"),
    M77: na("no job port"),
    M78: na("no job port"),
    M79: na("no job port"),
    M80: na("no job port"),
    M81: na("no job port"),
    M82: na("no job port"),
    M83: na("no job port"),
    M84: na("no job port"),
    M87: na("no job port"),

    // Timers.
    M88: na("no job port"),
    M89: na("no job port"),
    M90: na("no job port"),
    M96: na("no job port"),
    M104: na("no job port"),

    // Pure transitions.
    M116: lockCode("String(Date.now())"),
    M117: lockCode("String(Math.random())"),
    M119: lockCode("crypto.randomUUID()"),
    M120: { ...lockCode("e.code || fallback"), prepend: HELPERS.fallback },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(e.by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: { ...pushReduce("({ ...defaults, by: e.by })"), prepend: `const defaults = { by: "guest", code: null };` },
    M125: {
      ...pushReduce("withBy(e.by)"),
      prepend:
        "function withBy(by: string): { by: string; code: null } {\n  const out = { by, code: null, at: Date.now() };\n  return out;\n}",
    },
    M126: lockCode('[...new Set(e.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? e.code"),
    M128: edit([R.lockReduce, "reduce((_: DoorContext): DoorContext => ({ by: null }) as DoorContext),"]),
    M128b: na("no job port"),
    M129: pushReduce(`({ by: e.by.split(" ")[0]!, code: null })`),
    M130: pushDoes(`console.log("pushed by", e.by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: e.by }).catch(() => {})`),
    M132: edit([
      R.lockReduce,
      `reduce((_: DoorContext, e: { code: string }): DoorContext => (setTimeout(() => console.info("relock"), 1000), { by: null, code: e.code })),`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? e.code'),
    M134: lockCode("process.env.DOOR_CODE ?? e.code"),
    M135: edit([R.pushReduce, `// @ts-expect-error\n        ${broken}`]),
    M135b: edit([R.pushReduce, `// @ts-ignore\n        ${broken}`]),
    M135c: edit(
      ["// test/fixtures/door.ts in Robot (robot3)", "// @ts-nocheck\n// test/fixtures/door.ts in Robot (robot3)"],
      [R.pushReduce, broken],
    ),
    M136: {
      ...edit([
        R.close,
        `transition("close", "closed", reduce((ctx: DoorContext): DoorContext => (analytics.track("closed"), ctx)))`,
      ]),
      prepend: HELPERS.analytics,
    },
    M137: {
      ...edit([
        R.close,
        `transition("close", "closed", reduce((ctx: DoorContext): DoorContext => (track("closed"), ctx)))`,
      ]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: { ...lockCode("stamp(e.code)"), prepend: HELPERS.stamp },
    M139: edit([
      R.guard,
      `guard((ctx: DoorContext, e: { code: string }) => Boolean(ctx.code?.split(",").filter((c) => c === e.code))),`,
    ]),

    // Persistence.
    M259: na("a service has no snapshot to restore from: interpret takes a machine and a context"),
    M261: append(
      "const saved = JSON.stringify(actor.context);\nexport const restored = interpret(doorMachine, () => {}, JSON.parse(saved));",
    ),
    M265: na("no job port"),

    // Use sites.
    M297: append("export const len = actor.context.by.length;"),
    M298: append(`export const is = actor.machine.current === "opened";`),
    M300: na("createMachine takes no options: a first state, the states and a context function"),
    M301: na("Robot has no can: a state's transitions are a Map by event name"),
    M304: edit([R.listener, "interpret(doorMachine as any, () => {})"]),
    M305: append("export const by = (actor.context as { by: string }).by;"),
    M305b: edit([
      R.listener,
      `interpret(doorMachine, (s) => {\n  if (s.machine.current === "open") console.info(s.context.by!.toUpperCase());\n})`,
    ]),
    M307: edit(
      [R.contextEnd, "  readonly code?: string | null;\n}"],
      [R.lockReduce, "reduce((_: DoorContext): DoorContext => ({ by: null })),"],
    ),
    M308: append(
      'export function label(s: typeof actor): string {\n  switch (s.machine.current) {\n    case "open":\n      return `open, by ${s.context.by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits.
    M344: na("a target is a string in Robot: transition(event, target)"),
    M345: na("guard(fn) on a transition is Robot's"),
    M345b: na("action(fn) on a transition is Robot's"),
    M345c: na("a transition is transition(event, target, ...guards): no transition object to give cond"),
    M345d: na("a transition is transition(event, target, ...guards): no transition object to give in"),
    M346: na("several transitions for one event, the first whose guard passes, are Robot's"),
    M347: edit([R.open, `open: state(transition("close", "closed"), transition("", "closed")),`]),
    M348: na("Robot declines with a guard"),
    M350: na("the first state is createMachine's first argument"),
    M351: edit([R.context, "{ by: null, code: null },"]),
    M352: na("createMachine takes no options: nowhere to put an id"),
    M353: na("no job port"),
    M354: na("invoke is how Robot runs a task"),
    M355: na("a state is state(...transitions): no config object to give activities"),
    M356: na("createMachine takes no options object"),
    M357: na("createMachine takes no options object: its types come from the context function and the reducers"),
    M358: edit([`${R.context}\n);`, `${R.context}\n  { actions: {} },\n);`]),
    M362: append(`import { and } from "robot3";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([R.pushReduce, R.pushReduce.replace("reduce(", "assign(")]),
      prepend: `import { assign } from "robot3";`,
    },
    M364: na("interpret is Robot's"),
    M366: na("no job port"),
    M367: append(`import { createActor } from "robot3";\nexport const loader = createActor(doorMachine);`),
    M368: na("a string event is Robot's: send takes a name or an object"),
    M369: append("actor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.machine.state.done;"),
    M372: append("export const value = actor.machine.state.value;"),
    M373: append(`export const isOpen = actor.machine.state.matches("open");`),
    M374: append("export const configured = doorMachine.withConfig({});"),
    M375: na("an initial context is interpret's third argument in Robot"),

    // From M404 on. Targets and data. Robot's step is the reducer's next context: built, dropped,
    // and the old one returned.
    M404: edit(
      [
        R.lockReduce,
        `reduce((ctx: DoorContext, e: { code: string }): DoorContext => {\n          if (e.code !== "") ({ by: null, code: e.code });\n          return ctx;\n        }),`,
      ],
      [
        R.open,
        `open: state(transition("close", "closed"), transition("lock", "locked", ${R.lockReduce.slice(0, -1)})),`,
      ],
    ),
    M405: edit([
      `        ${R.guard}\n      ),\n    ),`,
      `        ${R.guard}\n      ),\n      transition("unlock", "locked"),\n    ),`,
    ]),
    M406: pushReduce(
      "({\n          get by() {\n            return e.by;\n          },\n          code: null,\n        })",
    ),
    M407: na("a transition names its target: there is no form that stays, to name the wrong state in"),
    M408: na("the first state is createMachine's first argument, a name: nothing runs at start that could decline"),
    M409: edit([
      R.context,
      "(event?: unknown): DoorContext => (event === undefined ? { by: null, code: null } : { by: null, code: null }),",
    ]),
    M410: edit([
      R.lockReduce,
      "reduce((ctx: DoorContext, e: { code: string }): DoorContext => Object.assign(ctx, { by: null, code: e.code })),",
    ]),
    M411: na(NO_JOB),
    M412: closedAlso(
      `transition(\n        "push",\n        "open",\n        reduce((_: DoorContext, e: { by: string }): DoorContext => ({ by: e.by.trim(), code: null })),\n      )`,
    ),
    M413: lockGuard(
      `(_: DoorContext, e: { code: string }) => {\n          e.code.split("").forEach((c) => {\n            if (c === " ") return false;\n          });\n          return true;\n        }`,
    ),
    M414: pushReduce('({ by: JSON.parse(`"${e.by}"`), code: null })'),

    // Contracts.
    M416: na("an event's payload is typed where a reducer or guard reads it: nothing declares one to write as void"),
    M417: openWith("[OPENED]", "boolean", "true", OPENED),
    // M418 and M422: the app sends close, so the name is a second event beside it.
    M418: edit([R.open, `open: state(transition("close", "closed"), transition("toString", "closed")),`]),
    M419: edit([`"lock",\n        "locked",`, `"lock",\n        "2",`], ["    locked: state(", "    2: state("]),
    M420: edit([R.open, `open: state(transition("close", "closed"), transition("Close", "closed")),`]),
    M421: na(NO_JOB),
    M422: edit([R.open, `open: state(transition("close", "closed"), transition("close*", "closed")),`]),
    M423: na(NO_JOB),
    M424: edit(["  readonly by: string | null;", `  readonly by: "ann" | "bob" | string | null;`]),
    M425: openWith("constructor", "string", "e.by"),
    M426: {
      prepend: ENUM,
      edits: [
        [R.pushEvent, `{ readonly type: "push"; readonly by: Visitor }`],
        [R.pushReduce, R.pushReduce.replace("e: { by: string }", "e: { by: Visitor }")],
      ],
    },
    M427: na("createMachine takes no options: there is no version"),
    M428: na("no schema helper: a machine's types come from its context function and reducers"),

    // Events and sending. The push is closed again, so the app's own push finds the door closed.
    M429: append(`actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));\nactor.send({ type: "close" });`),

    // The graph.
    M432: na(NO_JOB),
    M433: na(NO_JOB),
    M434: na("a state is state(...transitions): no `on` to write a transition beside"),

    // Tasks.
    M437: na(NO_JOB),
    M438: na(NO_JOB),
    M439: na(NO_JOB),
    M440: na(NO_JOB),
    M441: na(NO_JOB),
    M443: na(NO_JOB),
    M444: na(NO_JOB),
    M445: na(NO_JOB),
    M446: na(NO_JOB),
    M447: na(NO_JOB),
    M448: na(NO_JOB),
    M449: na(NO_JOB),
    M450: na(NO_JOB),
    M451: na(NO_JOB),
    M452: na(NO_JOB),
    M453: na(NO_JOB),
    M454: na(NO_JOB),
    M455: na(NO_JOB),
    M456: na(NO_JOB),
    M457: na(NO_JOB),
    M458: na(NO_JOB),
    M459: na(NO_JOB),
    M460: na(NO_JOB),
    M461: na(NO_JOB),
    M462: na(NO_JOB),
    M463: na(NO_JOB),
    M464: na(NO_JOB),
    M465: na(NO_JOB),
    M466: na(NO_JOB),
    M467: na(NO_JOB),
    M468: na(NO_JOB),
    M469: na(NO_JOB),
    M470: na(NO_JOB),
    M471: na(NO_JOB),
    M473: na(NO_JOB),
    M474: na(NO_JOB),
    M477: na(NO_JOB),

    // Timers.
    M479: na(NO_JOB),
    M480: na(NO_JOB),
    M481: na(NO_JOB),
    M482: na("no timers: Robot has no delayed transitions"),
    M483: na(NO_JOB),

    // Pure transitions.
    M484: pushReduce(
      `{\n          if (e.by === "") throw "by is required";\n          return { by: e.by, code: null };\n        }`,
    ),
    M485: { prepend: VALID, ...lockGuard(`(_: DoorContext, e: { code: string }) => validCode && e.code !== ""`) },
    M486: pushReduce(`({ by: e.by || "anonymous", code: null })`),
    M488: openWith("tries", "number", "Math.min(Math.max(e.by.length, 10), 1)"),
    M489: pushReduce("({ by: e.by.toLocaleUpperCase(), code: null })"),
    M490: na(NO_JOB),
    M491: na(NO_JOB),
    M492: na(NO_JOB),
    M493: na(NO_JOB),
    M494: na(NO_JOB),
    M495: { prepend: NAMES, ...pushReduce("({ by: NAMES[e.by] ?? e.by, code: null })") },
    M496: pushGuard("(_: DoorContext, e: { by: string }) => Boolean(e)"),
    M497: pushReduce("({ by: `by ${e}`, code: null })"),
    M498: openWith("offset", "number", "-e.by"),
    M499: edit(
      [R.pushEvent, `{ readonly type: "push"; readonly by: "ann" | "bob" }`],
      [
        R.pushTarget,
        `${R.pushTarget}\n        guard((_: DoorContext, e: { by: "ann" | "bob" }) => {\n          switch (e.by) {\n            case "ann":\n              return true;\n            default:\n              return false;\n          }\n        }),`,
      ],
    ),

    // Persistence.
    M571: edit([
      R.listener,
      `interpret(doorMachine, (s) => {\n  localStorage.setItem("door", JSON.stringify(s.context));\n})`,
    ]),
    M573: na(NO_JOB),

    // Use sites.
    M575: append("export const loose = interpret<any, any>(doorMachine, () => {});"),
    M576: edit([
      R.pushReduce,
      `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n        ${R.pushReduce}`,
    ]),
    M577: append(
      `import type { Machine } from "robot3";\ndeclare module "robot3" {\n  interface Service<M extends Machine> {\n    retryLater(machine: M): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.machine.current as (typeof SHUT)[number]);`,
    ),
    M581: append("export const wrapped = interpret({ ...doorMachine }, () => {});"),
    M582: append(`export const withInput = interpret(doorMachine, () => {}, { by: "ann" });`),
    M583: append(
      `export function rename(by: string): void {\n  if (actor.machine.current === "open") actor.context.by = by;\n}`,
    ),
    M584: edit([
      R.listener,
      `interpret(doorMachine, async (s) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(s.context));\n  } catch (e) {\n    console.error(e);\n  }\n})`,
    ]),
    M585: na("a service has no stop: it is dropped, never stopped"),
    M586: na(NO_JOB),
    M587: append(
      `export function POST(req: Request): Response {\n  actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(actor.machine.current === "open" ? "ok" : "refused");\n}`,
    ),
    M588: na("Robot has no toPromise: a service's end is a final state, which onChange reports"),
    M589: na(NO_JOB),
    M591: na("no pure transition: send needs a service"),

    // React and app code: the cases' folder resolves neither react-robot nor React's types, so a
    // component reads the module's service.
    M593: append(
      `export function DoorView(): null {\n  if (actor.machine.current === "closed") actor.send({ type: "push", by: "ann" });\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send };"),
    M603: na("a service has one listener, interpret's onChange: there is no subscribe to call in a body"),

    // Flows and modeling.
    M607: {
      edits: [
        [
          `| { readonly type: "unlock"; readonly code: string };`,
          `| { readonly type: "unlock"; readonly code: string }\n  | { readonly type: "setOpen"; readonly open: boolean };`,
        ],
        ...closedAlso(
          `transition(\n        "setOpen",\n        "open",\n        guard((_: DoorContext, e: { open: boolean }) => e.open),\n        reduce((): DoorContext => ({ by: "", code: null })),\n      )`,
        ).edits!,
        [
          R.open,
          `open: state(\n      transition("close", "closed"),\n      transition("setOpen", "closed", guard((_: DoorContext, e: { open: boolean }) => !e.open)),\n    ),`,
        ],
      ],
    },

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    M613: append(`export const named = interpret(doorMachine, () => {}, { id: "door", devTools: true });`),
    M614: na(NO_JOB),
    M615: na(NO_JOB),
  },
};
export default robot3;
