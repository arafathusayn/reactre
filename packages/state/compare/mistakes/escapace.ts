// @escapace/fsm: each case in the port ../escapace/door.ts, written as the library's declarations
// write a machine (the builder's `.state`, `.action`, `.context`, `.transition(source, action,
// target, reducer)`, a guard as `[action, predicate]`, `interpret` for the service). Its context is
// a union tagged by `state`, so a mistake about one state's data is made in that state's member.
// The reducers are its pure part (a draft's commit replays them), so the purity cases put the
// impure read or write in a reducer. No job port: every job case is n/a.
//
// The port calls the builder and the service through small typed views (the library's builder
// types collapse to `never` under this repository's checker). A case's type error from those views
// is the port's; each case caught that way says so, and whether the library's own declarations
// would catch it too. The library's own types are measured where they work: `interpret`'s options,
// the definition `done()` returns, and the module's exports.

import { append, type CaseModule, edit, type Library, type Mutation, na, SCENARIO, settle } from "./cases.ts";

// The port's text, as written there.
const E = {
  push: `.transition("closed", "push", "open", (_, action) => ({ state: "open", by: action.payload.by }))`,
  lock: `.transition("closed", "lock", "locked", (_, action) => ({ state: "locked", code: action.payload.code }))`,
  close: `.transition("open", "close", "closed", () => ({ state: "closed" }))`,
  guard: `(context, action) => context.state === "locked" && context.code === action.payload.code`,
  unlockReducer: `    "closed",\n    () => ({ state: "closed" }),\n  )`,
  open: `| { readonly state: "open"; readonly by: string }`,
  locked: `| { readonly state: "locked"; readonly code: string };`,
  payload: "readonly payload: { readonly by: string; readonly code: string };",
  doPush: 'do(action: "push", payload: { by: string }): boolean;',
  service: "interpret(doorMachine) as unknown as DoorService",
};
const JOB = "no job port: the library has no tasks, effects or timers";

const pushTo = (data: string): Mutation =>
  edit([E.push, `.transition("closed", "push", "open", (_, action) => (${data}))`]);
/** A field added to `open`'s member of the context, given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [E.open, `| { readonly state: "open"; readonly by: string; readonly ${field}: ${type} }`],
    [
      E.push,
      `.transition("closed", "push", "open", (_, action) => ({ state: "open", by: action.payload.by, ${field}: ${value} }))`,
    ],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** A field added to `push`'s payload. */
const pushPayload = (field: string, type: string): Mutation =>
  edit(
    [E.payload, `readonly payload: { readonly by: string; readonly code: string; readonly ${field}: ${type} };`],
    [E.doPush, `do(action: "push", payload: { by: string; ${field}: ${type} }): boolean;`],
  );
const pushDoes = (effect: string): Mutation => pushTo(`${effect}, { state: "open", by: action.payload.by }`);
const lockCode = (code: string): Mutation =>
  edit([E.lock, E.lock.replace("code: action.payload.code", `code: ${code}`)]);
const opne = E.push.replace('"open", (_', '"opne", (_');
const NAME = `type Name = "push" | "close" | "lock" | "unlock";`;
/** `lock` with a guard, as `[action, predicate]`. */
const lockGuard = (predicate: string): Mutation =>
  edit([
    E.lock,
    `.transition(\n    "closed",\n    [\n      "lock",\n      ${predicate},\n    ],\n    "locked",\n    (_, action) => ({ state: "locked", code: action.payload.code }),\n  )`,
  ]);
/** `push` with a guard, as `[action, predicate]`. */
const pushGuard = (predicate: string): Mutation =>
  edit([
    E.push,
    `.transition(\n    "closed",\n    [\n      "push",\n      ${predicate},\n    ],\n    "open",\n    (_, action) => ({ state: "open", by: action.payload.by }),\n  )`,
  ]);

const tail = "\nexport const actor = createDoor();\n";

interface Service {
  do(action: string, payload?: object): boolean;
}

const escapace: Library = {
  name: "@escapace/fsm",
  bases: { door: { port: "../escapace/door.ts", tail } },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") throw new Error("@escapace/fsm has no job port");
    const door = mod.actor as Service;
    for (const { type, ...payload } of SCENARIO.door)
      door.do(type, Object.keys(payload).length === 0 ? undefined : payload);
    await settle();
  },
  cases: {
    // Targets and data. The typed view's targets are the context's tags, as the library's own
    // `.transition` takes only declared states; its builder throws StateNotDeclared too.
    M1: edit([E.push, opne]),
    // The typed view's reducer returns the context union: a member's fields are required in both
    // it and the library's own reducer type (the target's member).
    M2: edit([E.lock, `.transition("closed", "lock", "locked", () => ({ state: "locked" }))`]),
    // The typed view's union, as the library's own reducer type (the target's member).
    M3: edit([E.close, `.transition("open", "close", "closed", () => ({ state: "closed", by: null }))`]),
    M4: pushTo(`{ state: "open", by: action.payload.by, at: 1 }`),
    M5: pushTo(`{ state: "open", ...{ by: action.payload.by, at: 1 } }`),
    M6: edit([
      E.push,
      `.transition("closed", "push", "open", (_, action) => {\n    const next = { state: "open" as const, by: action.payload.by, at: 1 };\n    return next;\n  })`,
    ]),
    M7: pushTo(`{ state: "open", by: action.payload.by.length }`),
    // The typed view's reducer type, as the library's own: a reducer returns the next context.
    M8: edit([
      E.push,
      `.transition("closed", "push", "open", (_, action) => { ({ state: "open", by: action.payload.by }); })`,
    ]),
    M9: edit([E.push, E.push.replace("(_, action) =>", "async (_, action) =>")]),
    // The port's context type is readonly, as the library's own reducer would see it (the user's type).
    M10: edit([
      E.unlockReducer,
      `    "closed",\n    (context, action) => {\n      if (context.state === "locked") context.code = action.payload.code;\n      return { state: "closed" };\n    },\n  )`,
    ]),
    // The typed view's reducer gets the union; the library's own gets the source's member (closed).
    M12: edit([
      E.lock,
      `.transition("closed", "lock", "locked", (context) => ({ state: "locked", code: context.code }))`,
    ]),
    // The typed view's payload type, as the library's own (the action's declared payload).
    M13: edit([E.push, E.push.replace("action.payload.by", "action.payload.name")]),
    M14: pushTo(`{ state: "open", by: action.payload.by.split(" ")[0] }`),
    M15: pushTo(`{ state: "open", by: undefined }`),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [E.payload, "readonly payload: { readonly by: Date; readonly code: string };"],
      [E.doPush, `do(action: "push", payload: { by: Date }): boolean;`],
      [E.push, E.push.replace("by: action.payload.by", "by: String(action.payload.by)")],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([E.open, `| { readonly state: "open"; readonly [key: string]: string }`]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("an action's name is do's first argument, apart from its payload: a payload's `type` clashes with nothing"),
    M25: na(JOB),
    M26: na(JOB),
    M27: openWith("note", "File", 'new File([action.payload.by], "note.txt")'),
    M28: openWith(
      "visitor",
      "Visitor",
      "new Visitor(action.payload.by)",
      "class Visitor {\n  constructor(readonly name: string) {}\n  greet(): string {\n    return `hi ${this.name}`;\n  }\n}",
    ),
    M29: openWith("visits", "bigint", "BigInt(action.payload.by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([action.payload.by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", action.payload.by]])'),
    M32: pushPayload("click", "MouseEvent"),
    M33: {
      edits: [
        ...pushPayload("button", "HTMLElement").edits!,
        [E.open, `| { readonly state: "open"; readonly by: string; readonly button: HTMLElement }`],
        [
          E.push,
          `.transition("closed", "push", "open", (_, action) => ({ state: "open", by: action.payload.by, button: action.payload.button }))`,
        ],
      ],
    },
    M34: openWith("note", "string | undefined", 'action.payload.by === "" ? undefined : action.payload.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending. The typed view's `do` overloads, as the library's own `do` (declared
    // actions, each with its payload); its runtime throws ActionNotDeclared for M43 too.
    M43: append(`actor.do("kick");`),
    M44: append(`actor.do("push");`),
    M45: append(`actor.do("push", { by: 1 });`),
    M46: append(`actor.do("push", { by: "ann", at: 1 });`),
    M47: na(JOB),
    // The typed view's action names, as the library's own; its builder throws ActionNotDeclared too.
    M48: edit([E.push, E.push.replace('"push"', '"psuh"')]),
    M49: append(`actor.do("close");`),
    M50: na("a service has no stop: nothing to send after"),
    M52: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
    M53: na(JOB),
    M55: na("no action name is reserved"),

    // The graph.
    M56: edit(['  .state("open")\n', ""]),
    // Only the typed view catches it (its states are the context's tags): the library's own
    // `.state` takes any new name, and its context isn't tied to the declared states.
    M57: edit(
      ['  .state("locked")\n', '  .state("locked")\n  .state("broken")\n'],
      [E.close, `${E.close}\n  .transition("broken", "close", "closed", () => ({ state: "closed" }))`],
    ),
    M58: edit([`  ${E.lock}\n`, ""]),
    M59: edit([`  ${E.close}\n`, ""]),
    M60: na(JOB),
    M62: edit(
      [
        `type Name = "push" | "close" | "lock" | "unlock";`,
        `type Name = "push" | "close" | "lock" | "unlock" | "kick";`,
      ],
      ['  .action("unlock")\n', '  .action("unlock")\n  .action("kick")\n'],
    ),
    M63: na(JOB),
    M64: na(JOB),

    // Tasks and timers.
    M65: na(JOB),
    M66: na(JOB),
    M67: na(JOB),
    M68: na(JOB),
    M69: na(JOB),
    M70: na(JOB),
    M71: na(JOB),
    M72: na(JOB),
    M73: na(JOB),
    M74: na(JOB),
    M75: na(JOB),
    M76: na(JOB),
    M77: na(JOB),
    M78: na(JOB),
    M79: na(JOB),
    M80: na(JOB),
    M81: na(JOB),
    M82: na(JOB),
    M83: na(JOB),
    M84: na(JOB),
    M87: na(JOB),
    M88: na(JOB),
    M89: na(JOB),
    M90: na(JOB),
    M96: na(JOB),
    M104: na(JOB),

    // Pure transitions: in a reducer.
    M116: lockCode("String(Date.now())"),
    M117: lockCode("String(Math.random())"),
    M119: lockCode("crypto.randomUUID()"),
    M120: {
      ...lockCode("action.payload.code || fallback"),
      prepend: `let fallback = "0000";\nexport function setFallback(code: string): void {\n  fallback = code;\n}`,
    },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(action.payload.by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: {
      ...pushTo(`{ state: "open", ...defaults, by: action.payload.by }`),
      prepend: `const defaults = { by: "guest" };`,
    },
    M125: {
      ...edit([E.push, `.transition("closed", "push", "open", (_, action) => withBy(action.payload.by))`]),
      prepend:
        'function withBy(by: string): { state: "open"; by: string } {\n  const out = { state: "open" as const, by, at: Date.now() };\n  return out;\n}',
    },
    M126: lockCode('[...new Set(action.payload.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? action.payload.code"),
    M128: edit([E.lock, `.transition("closed", "lock", "locked", () => ({ state: "locked" }) as DoorContext)`]),
    M128b: na(JOB),
    M129: pushTo(`{ state: "open", by: action.payload.by.split(" ")[0]! }`),
    M130: pushDoes(`console.log("pushed by", action.payload.by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: action.payload.by }).catch(() => {})`),
    M132: edit([
      E.lock,
      `.transition("closed", "lock", "locked", (_, action) => (setTimeout(() => console.info("relock"), 1000), { state: "locked", code: action.payload.code }))`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? action.payload.code'),
    M134: lockCode("process.env.DOOR_CODE ?? action.payload.code"),
    M135: edit([E.push, `// @ts-expect-error\n  ${opne}`]),
    M135b: edit([E.push, `// @ts-ignore\n  ${opne}`]),
    M135c: edit(
      ["// test/fixtures/door.ts in @escapace/fsm", "// @ts-nocheck\n// test/fixtures/door.ts in @escapace/fsm"],
      [E.push, opne],
    ),
    M136: {
      ...edit([
        E.close,
        `.transition("open", "close", "closed", () => (analytics.track("closed"), { state: "closed" }))`,
      ]),
      prepend:
        "const analytics = {\n  events: [] as string[],\n  track(name: string): void {\n    this.events.push(name);\n  },\n};",
    },
    M137: {
      ...edit([E.close, `.transition("open", "close", "closed", () => (track("closed"), { state: "closed" }))`]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: {
      ...lockCode("stamp(action.payload.code)"),
      prepend: "function stamp(code: string): string {\n  return `${code}@${Date.now()}`;\n}",
    },
    // A predicate returns a boolean (the typed view's and the library's own), so the array is wrapped.
    M139: edit([
      E.guard,
      `(context, action) =>\n        context.state === "locked" && Boolean(context.code.split(",").filter((c) => c === action.payload.code))`,
    ]),

    // Persistence. `interpret(machine, { hydrate: { state, context } })` restores.
    // The library's own `interpret` options (hydrate only).
    M259: append(
      "export const again = interpret(doorMachine, { snapshot: { state: actor.state, context: actor.context } });",
    ),
    M261: append(
      "const saved = JSON.stringify({ state: actor.state, context: actor.context });\nexport const restored = interpret(doorMachine, { hydrate: JSON.parse(saved) });",
    ),
    M265: na(JOB),

    // Use sites. The typed view's service: its `context` is the union and its `state` the tags, as
    // the library's own service would type them.
    M297: append("export const len = actor.context.by.length;"),
    M298: append(`export const is = actor.state === "opened";`),
    // A misspelled builder method (the builder's methods are its options): the typed view's builder,
    // as the library's own; its runtime throws a TypeError too.
    M300: edit(['.initial("closed")', '.intial("closed")']),
    M301: na("no can: a draft's do answers whether an action applies, given its name and payload"),
    M304: edit([E.service, "interpret(doorMachine as any) as unknown as DoorService"]),
    M305: append("export const by = (actor.context as { by?: string }).by;"),
    M305b: append(
      `actor.subscribe(() => {\n  const c = actor.context;\n  if (c.state === "open") console.info(c.by!.toUpperCase());\n});`,
    ),
    M307: edit(
      [E.locked, `| { readonly state: "locked"; readonly code?: string };`],
      [E.lock, `.transition("closed", "lock", "locked", () => ({ state: "locked" }))`],
    ),
    M308: append(
      'export function label(c: DoorContext): string {\n  switch (c.state) {\n    case "open":\n      return `open, by ${c.by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits. A builder has no config object: XState's machine and state keys have
    // nowhere to go.
    M344: na("a transition's target is a state's name in the builder"),
    M345: na("a transition is positional (source, action, target, reducer): a guard is a predicate after the action"),
    M345b: na("a transition is positional (source, action, target, reducer): no actions to name, and no effects"),
    M345c: na("a transition is positional (source, action, target, reducer): a guard is a predicate after the action"),
    M345d: na("a transition is positional (source, action, target, reducer), and the machine is flat: no in"),
    M346: na("an array of targets is the builder's own: one transition per target, the first that passes is taken"),
    M347: na("no eventless transitions and no map of events: an action is declared by name and sent by do"),
    // The typed view's reducer type, as the library's own; its runtime throws a TypeError too.
    M348: edit(
      [`["unlock", ${E.guard}]`, `"unlock"`],
      [
        E.unlockReducer,
        `    "closed",\n    (context, action) =>\n      context.state === "locked" && context.code === action.payload.code ? { state: "closed" } : undefined,\n  )`,
      ],
    ),
    M350: na("initial is the builder's own name for the first state"),
    M351: na("context is the builder's own name for the data"),
    M352: na("a builder has no config object, and a machine no id"),
    M353: na(JOB),
    M354: na("a builder has no state config, and the library no tasks"),
    M355: na("a builder has no state config, and the library no effects"),
    M356: na("a builder has no machine config to put the flag in"),
    M357: na("a builder has no config object: its types are the builder's type arguments"),
    M358: na("a builder has no config object, and the library no implementations"),
    // The library's own module declarations.
    M362: append(`import { and } from "@escapace/fsm";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([E.push, `.transition("closed", "push", "open", assign(({ event }) => ({ by: event.by })))`]),
      prepend: `import { assign } from "@escapace/fsm";`,
    },
    M364: na("interpret is how the library makes a service"),
    M366: na(JOB),
    M367: append(`import { invoke } from "@escapace/fsm";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: na('an action is sent by its name: do("push", payload) is the library\'s form'),
    // The library's own service type (interpret's).
    M369: edit([E.service, "interpret(doorMachine).start() as unknown as DoorService"]),
    // M370 to M373: the typed view's service; the library's own service type lacks them too.
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.done;"),
    M372: append("export const value = actor.value;"),
    M373: append(`export const isOpen = actor.matches("open");`),
    // The library's own definition type (done's).
    M374: append("export const configured = doorMachine.withConfig({});"),
    // The library's own `interpret` options.
    M375: append(`export const preset = interpret(doorMachine, { context: { state: "open", by: "ann" } });`),

    // From M404 on. Targets and data: a reducer builds the target's context, a guard declines.
    M404: na(
      "a reducer only builds the target's context, and declining is the guard's: no step to build and drop (a reducer that drops its value is M8)",
    ),
    // The 'no' branch as a second unlock transition, after the guarded one, back into `locked`.
    M405: edit([
      E.unlockReducer,
      `${E.unlockReducer}\n  .transition("locked", "unlock", "locked", (context) => context)`,
    ]),
    M406: pushTo(`{\n    state: "open",\n    get by() {\n      return action.payload.by;\n    },\n  }`),
    M407: na("no stay step: a transition names its target, and staying is a transition back to its source"),
    M408: na("the first state is named (`.initial`): no start handler that could decline"),
    M409: na(
      "the first state is named (`.initial`) and its context made from nothing: no start handler to read an event",
    ),
    M410: edit([
      E.lock,
      `.transition("closed", "lock", "locked", (context, action) =>\n    Object.assign(context, { state: "locked" as const, code: action.payload.code }),\n  )`,
    ]),
    M411: na(JOB),
    M412: edit([
      E.lock,
      `${E.lock}\n  .transition("closed", "push", "open", (_, action) => ({ state: "open", by: action.payload.by.trim() }))`,
    ]),
    M413: lockGuard(
      `(_, action) => {\n        action.payload.code.split("").forEach((c) => {\n          if (c === " ") return false;\n        });\n        return true;\n      }`,
    ),
    M414: pushTo('{ state: "open", by: JSON.parse(`"${action.payload.by}"`) }'),

    // Contracts.
    M416: na("an action's payload is do's second argument: an action without one omits it, with no type to write"),
    M417: openWith("[OPENED]", "boolean", "true", `const OPENED: unique symbol = Symbol("opened");`),
    M418: edit(
      [NAME, `type Name = "push" | "close" | "toString" | "lock" | "unlock";`],
      ['  .action("close")\n', '  .action("close")\n  .action("toString")\n'],
      [E.close, `${E.close}\n  .transition("open", "toString", "closed", () => ({ state: "closed" }))`],
      [`do(action: "close"): boolean;`, `do(action: "close" | "toString"): boolean;`],
    ),
    M419: edit([`"locked"`, `"2"`, "all"]),
    M420: edit(
      [NAME, `type Name = "push" | "close" | "Close" | "lock" | "unlock";`],
      ['  .action("close")\n', '  .action("close")\n  .action("Close")\n'],
      [E.close, `${E.close}\n  .transition("open", "Close", "closed", () => ({ state: "closed" }))`],
      [`do(action: "close"): boolean;`, `do(action: "close" | "Close"): boolean;`],
    ),
    M421: na(JOB),
    M422: edit(
      [NAME, `type Name = "push" | "close" | "close*" | "lock" | "unlock";`],
      ['  .action("close")\n', '  .action("close")\n  .action("close*")\n'],
      [E.close, `${E.close}\n  .transition("open", "close*", "closed", () => ({ state: "closed" }))`],
      [`do(action: "close"): boolean;`, `do(action: "close" | "close*"): boolean;`],
    ),
    M423: na(JOB),
    M424: edit([E.open, `| { readonly state: "open"; readonly by: "ann" | "bob" | string }`]),
    M425: openWith("constructor", "string", "action.payload.by"),
    M426: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [E.open, `| { readonly state: "open"; readonly by: Visitor }`],
        [E.payload, "readonly payload: { readonly by: Visitor; readonly code: string };"],
        [E.doPush, `do(action: "push", payload: { by: Visitor }): boolean;`],
      ],
    },
    M427: na("no version: a machine has no persisted format to number"),
    M428: na("no `types<T>()`: the context and actions are typed by the builder"),

    // Events and sending.
    M429: append(`const message = JSON.parse('{ "type": "push", "by": "ann" }');\nactor.do(message.type, message);`),

    // The graph.
    M432: na(JOB),
    M433: na(JOB),
    M434: na("a builder has no state config: no `on` map to write a handler beside"),

    // Tasks and timers.
    M437: na(JOB),
    M438: na(JOB),
    M439: na(JOB),
    M440: na(JOB),
    M441: na(JOB),
    M443: na(JOB),
    M444: na(JOB),
    M445: na(JOB),
    M446: na(JOB),
    M447: na(JOB),
    M448: na(JOB),
    M449: na(JOB),
    M450: na(JOB),
    M451: na(JOB),
    M452: na(JOB),
    M453: na(JOB),
    M454: na(JOB),
    M455: na(JOB),
    M456: na(JOB),
    M457: na(JOB),
    M458: na(JOB),
    M459: na(JOB),
    M460: na(JOB),
    M461: na(JOB),
    M462: na(JOB),
    M463: na(JOB),
    M464: na(JOB),
    M465: na(JOB),
    M466: na(JOB),
    M467: na(JOB),
    M468: na(JOB),
    M469: na(JOB),
    M470: na(JOB),
    M471: na(JOB),
    M473: na(JOB),
    M474: na(JOB),
    M477: na(JOB),
    M479: na(JOB),
    M480: na(JOB),
    M481: na(JOB),
    M482: na("no timers"),
    M483: na(JOB),

    // Pure transitions: in a reducer, or a guard where the case is a condition.
    M484: edit([
      E.push,
      `.transition("closed", "push", "open", (_, action) => {\n    if (action.payload.by === "") throw "by is required";\n    return { state: "open", by: action.payload.by };\n  })`,
    ]),
    M485: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...lockGuard("() => (validCode ? true : false)"),
    },
    M486: pushTo(`{ state: "open", by: action.payload.by || "anonymous" }`),
    M488: openWith("tries", "number", "Math.min(Math.max(action.payload.by.length, 10), 1)"),
    M489: pushTo(`{ state: "open", by: action.payload.by.toLocaleUpperCase() }`),
    M490: na(JOB),
    M491: na(JOB),
    M492: na(JOB),
    M493: na(JOB),
    M494: na(JOB),
    M495: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushTo(`{ state: "open", by: NAMES[action.payload.by] ?? action.payload.by }`),
    },
    M496: pushGuard("(_, action) => (action ? true : false)"),
    M497: pushTo('{ state: "open", by: `by ${action}` }'),
    M498: openWith("offset", "number", "-action.payload.by"),
    M499: {
      edits: [
        [E.payload, `readonly payload: { readonly by: "ann" | "bob"; readonly code: string };`],
        [E.doPush, `do(action: "push", payload: { by: "ann" | "bob" }): boolean;`],
        ...pushGuard(
          `(_, action) => {\n        switch (action.payload.by) {\n          case "ann":\n            return true;\n          default:\n            return false;\n        }\n      }`,
        ).edits!,
      ],
    },

    // Persistence.
    M571: append(
      `actor.subscribe(() => {\n  localStorage.setItem("door", JSON.stringify({ state: actor.state, context: actor.context }));\n});`,
    ),
    M573: na(JOB),

    // Use sites.
    // The library's own `interpret`.
    M575: append("export const loose = interpret<any>(doorMachine);"),
    M576: edit([E.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access\n  ${E.push}`]),
    // The library's own service type.
    M577: append(
      `import type { StateMachineBuilderModel } from "@escapace/fsm";\ndeclare module "@escapace/fsm" {\n  interface StateMachineService<T extends StateMachineBuilderModel = StateMachineBuilderModel> {\n    retryLater(by: string): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.state as (typeof SHUT)[number]);`,
    ),
    // The library's own `interpret`.
    M581: append("export const wrapped = interpret({ ...doorMachine });"),
    M582: append(`export const withInput = interpret(doorMachine, { input: { by: "ann" } });`),
    M583: append(
      `export function rename(by: string): void {\n  const c = actor.context;\n  if (c.state === "open") c.by = by;\n}`,
    ),
    M584: append(
      `actor.subscribe(async () => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(actor.context));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: na("a service has no stop: dropping one is how it ends"),
    M586: na(JOB),
    M587: append(
      `export function POST(req: Request): Response {\n  const ok = actor.do("push", { by: req.headers.get("x-user") ?? "" });\n  return new Response(ok ? "ok" : "refused");\n}`,
    ),
    M588: na("no toPromise: a service has no done or output to await"),
    M589: na(JOB),
    M591: na("no pure transition: a draft is a speculative copy of a service, not a transition function"),

    // React and app code: no React binding, so a component reads the module's service.
    M593: append(
      `export function DoorView(): null {\n  if (actor.state === "closed") actor.do("push", { by: "ann" });\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.do };"),
    M603: append(
      "export function Log(): null {\n  actor.subscribe((change) => console.info(change.state));\n  return null;\n}",
    ),

    // Flows and modeling.
    M607: edit(
      [NAME, `type Name = "push" | "close" | "lock" | "unlock" | "setOpen";`],
      ['  .action("unlock")\n', '  .action("unlock")\n  .action("setOpen")\n'],
      [E.payload, "readonly payload: { readonly by: string; readonly code: string; readonly open: boolean };"],
      [E.doPush, `${E.doPush}\n  do(action: "setOpen", payload: { open: boolean }): boolean;`],
      [
        E.close,
        `${E.close}\n  .transition("closed", ["setOpen", (_, action) => action.payload.open], "open", () => ({ state: "open", by: "" }))\n  .transition("open", ["setOpen", (_, action) => !action.payload.open], "closed", () => ({ state: "closed" }))`,
      ],
    ),

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    // The library's own `interpret` options.
    M613: append(`export const named = interpret(doorMachine, { id: "door", devTools: true });`),
    M614: na(JOB),
    M615: na(JOB),
  },
};
export default escapace;
