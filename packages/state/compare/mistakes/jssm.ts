// jssm: each case in the port ../jssm/door.ts, written as jssm's README writes a machine: FSL text
// (`from 'action' -> to;`), `new Machine` from the compiled config, `action(name, data)` to send,
// and a pre-hook (`hook_action`) that returns false to refuse. jssm has one data value per
// machine, not per state, so a mistake about one state's data is made in that value; an action's
// only payload is the next data. Its types are measured as they are: an action's name is any
// string, its data the machine's data type. No job port: every job case is n/a.
//
// jssm has no transition function: the port's helpers (`push`, `lock`, ...) map the app's value to
// the next data and fire the action, so the purity cases put the impure read or write there, as the
// other libraries put it where their transition builds its data. (A hook is jssm's place for a
// transition's effects; nothing checks either.)

import {
  append,
  type CaseModule,
  type Edit,
  edit,
  type Library,
  type Mutation,
  na,
  SCENARIO,
  settle,
} from "./cases.ts";

// The port's text, as written there.
const J = {
  push: `export const push = (door: Machine<DoorData>, by: string): boolean => door.action("push", { by, code: null });`,
  close: `export const close = (door: Machine<DoorData>): boolean => door.action("close");`,
  lock: `export const lock = (door: Machine<DoorData>, code: string): boolean => door.action("lock", { by: null, code });`,
  unlock: `export const unlock = (door: Machine<DoorData>, code: string): boolean => door.action("unlock", { by: null, code });`,
  hook: `({ data, next_data }) => next_data.code === data.code`,
  data: "  readonly code: string | null;\n}",
  init: "data: { by: null, code: null }",
  create: "new Machine<DoorData>({ ...config, data: { by: null, code: null } })",
  pushFsl: "closed 'push' -> open;",
};
const JOB = "no job port: jssm has timed transitions, but no tasks";
/** The unlock hook's line, after which a case registers another hook. */
const HOOKED = `  door.hook_action("locked", "closed", "unlock", ({ data, next_data }) => next_data.code === data.code);`;
/** A pre-hook added on an edge, after the port's. */
const hookOn = (edge: string, fn: string): Edit => [HOOKED, `${HOOKED}\n  door.hook_action(${edge}, ${fn});`];
const BY = "  readonly by: string | null;";
const CLOSE_FSL = "open 'close' -> closed;";

const pushData = (data: string): Mutation => edit([J.push, J.push.replace("{ by, code: null }", data)]);
const lockData = (code: string): Mutation =>
  edit([J.lock, J.lock.replace("{ by: null, code }", `{ by: null, code: ${code} }`)]);
const hook = (fn: string): Mutation => edit([J.hook, fn]);
/** A field added to the data (null at first), given by `push` and cleared by `lock` and `unlock`. */
const withField = (field: string, type: string, value: string, pushed: string = J.push): Edit[] => [
  [J.data, `  readonly code: string | null;\n  readonly ${field}: ${type} | null;\n}`],
  [J.init, `data: { by: null, code: null, ${field}: null }`],
  [J.push, pushed.replace("{ by, code: null }", `{ by, code: null, ${field}: ${value} }`)],
  [J.lock, J.lock.replace("{ by: null, code }", `{ by: null, code, ${field}: null }`)],
  [J.unlock, J.unlock.replace("{ by: null, code }", `{ by: null, code, ${field}: null }`)],
];
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: withField(field, type, value),
  ...(prepend === undefined ? {} : { prepend }),
});
/** A DOM value the app passes to `push`, kept in the data (an action's payload is the data). */
const pushGives = (field: string, type: string): Mutation =>
  edit(...withField(field, type, field, J.push.replace("by: string)", `by: string, ${field}: ${type})`)));
const pushDoes = (effect: string): Mutation => pushData(`(${effect}, { by, code: null })`);
/** The hidden error: the guard reads a field the data lacks. */
const broken = hook(`({ data, next_data }) => next_data.pin === data.code`).edits![0]!;
/** The FSL text as a constant, for `deserialize`. */
const fslConst: readonly Edit[] = [
  ["const config = make<string, DoorData>(`", "const fsl = `"],
  [
    "  locked 'unlock' -> closed;\n`);",
    "  locked 'unlock' -> closed;\n`;\nconst config = make<string, DoorData>(fsl);",
  ],
];

const tail = "\nexport const actor = createDoor();\n";

const jssm: Library = {
  name: "jssm",
  bases: { door: { port: "../jssm/door.ts", tail } },
  drive: async (mod: CaseModule, base) => {
    if (base === "job") throw new Error("jssm has no job port");
    // The app's sends, through the port's helpers (as door-app.ts sends them).
    for (const { type, ...payload } of SCENARIO.door)
      (mod[type] as (door: unknown, ...values: string[]) => boolean)(mod.actor, ...Object.values(payload));
    await settle();
  },
  cases: {
    // Targets and data. FSL makes a state of any name an arrow mentions.
    M1: edit([J.pushFsl, "closed 'push' -> opne;"]),
    M2: edit([J.lock, J.lock.replace("{ by: null, code }", "{ by: null }")]),
    M3: na("one data value for every state: a state without data has the machine's data"),
    M4: pushData("{ by, code: null, at: 1 }"),
    M5: pushData("{ ...{ by, code: null, at: 1 } }"),
    M6: edit([
      J.push,
      `export const push = (door: Machine<DoorData>, by: string): boolean => {\n  const next = { by, code: null, at: 1 };\n  return door.action("push", next);\n};`,
    ]),
    M7: pushData("{ by: by.length, code: null }"),
    // jssm's own function is the hook: undefined (no return) accepts.
    M8: hook(`({ data, next_data }) => {\n    next_data.code === data.code;\n  }`),
    M9: hook(`async ({ data, next_data }) => next_data.code === data.code`),
    // The port's data type is readonly; `data()` returns a copy, so the write is lost too.
    M10: edit([
      J.push,
      `export const push = (door: Machine<DoorData>, by: string): boolean => {\n  door.data().by = by;\n  return door.action("push");\n};`,
    ]),
    M12: lockData("door.data().code"),
    M13: hook(`({ data, next_data }) => next_data.pin === data.code`),
    M14: pushData(`{ by: by.split(" ")[0], code: null }`),
    M15: pushData("{ by: undefined, code: null }"),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit([
      J.push,
      J.push.replace("by: string)", "by: Date)").replace("{ by, code: null }", "{ by: String(by), code: null }"),
    ]),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([
      "  readonly by: string | null;\n  readonly code: string | null;",
      "  readonly [key: string]: string | null;",
    ]),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"]),
    M23: edit(["code: string", "code: [string, string]", "all"]),
    M24: na("an action's name is apart from its data: a data field named `type` clashes with nothing"),
    M25: na(JOB),
    M26: na(JOB),
    M27: openWith("note", "File", 'new File([by], "note.txt")'),
    M28: openWith(
      "visitor",
      "Visitor",
      "new Visitor(by)",
      "class Visitor {\n  constructor(readonly name: string) {}\n  greet(): string {\n    return `hi ${this.name}`;\n  }\n}",
    ),
    M29: openWith("visits", "bigint", "BigInt(by.length)"),
    M30: openWith("seen", "Set<string>", "new Set([by])"),
    M31: openWith("byId", "Map<string, string>", 'new Map([["by", by]])'),
    M32: pushGives("click", "MouseEvent"),
    M33: pushGives("button", "HTMLElement"),
    M34: openWith("note", "string | undefined", 'by === "" ? undefined : by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending, with jssm's `action`.
    M43: append(`actor.action("kick");`),
    M44: append(`actor.action("push");`),
    M45: append(`actor.action("push", { by: 1, code: null });`),
    M46: append(`actor.action("push", { by: "ann", code: null, at: 1 });`),
    M47: na(JOB),
    M48: edit([J.pushFsl, "closed 'psuh' -> open;"]),
    M49: append(`actor.action("close");`),
    M50: na("an instance has no stop: nothing to send after"),
    // jssm hands a listener's throw to its "error" event, which nothing here listens to.
    M52: append(`actor.on("transition", () => {\n  throw new Error("render failed");\n});`),
    M53: na(JOB),
    M55: na("no action name is reserved"),

    // The graph.
    M56: na("a state is any name the FSL's arrows mention: none is declared apart"),
    M57: na("a state is any name the FSL's arrows mention: none is declared apart"),
    M58: edit(["  closed 'lock' -> locked;\n", ""]),
    M59: edit(["  open 'close' -> closed;\n", ""]),
    M60: na(JOB),
    M62: na("an action is any name an arrow carries: none is declared apart"),
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

    // Pure transitions: in the helper that builds the next data.
    M116: lockData("String(Date.now())"),
    M117: lockData("String(Math.random())"),
    M119: lockData("crypto.randomUUID()"),
    M120: {
      ...lockData("code || fallback"),
      prepend: `let fallback = "0000";\nexport function setFallback(code: string): void {\n  fallback = code;\n}`,
    },
    M121: { ...pushDoes("(pushes += 1)"), prepend: "let pushes = 0;" },
    M122: { ...pushDoes("log.push(by)"), prepend: "const log: string[] = [];" },
    M123: { ...pushDoes("delete cache.last"), prepend: "const cache: { last?: string } = {};" },
    M124: { ...pushData("{ ...defaults, by }"), prepend: `const defaults = { by: "guest", code: null };` },
    M125: {
      ...pushData("withBy(by)"),
      prepend:
        "function withBy(by: string): DoorData {\n  const out = { by, code: null, at: Date.now() };\n  return out;\n}",
    },
    M126: lockData('[...new Set(code)].join("")'),
    M127: lockData("import.meta.env.DOOR_CODE ?? code"),
    M128: edit([J.lock, J.lock.replace("{ by: null, code }", "{ by: null } as DoorData")]),
    M128b: na(JOB),
    M129: pushData(`{ by: by.split(" ")[0]!, code: null }`),
    M130: pushDoes(`console.log("pushed by", by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: by }).catch(() => {})`),
    M132: edit([
      J.lock,
      `export const lock = (door: Machine<DoorData>, code: string): boolean => (setTimeout(() => console.info("relock"), 1000), door.action("lock", { by: null, code }));`,
    ]),
    M133: lockData('localStorage.getItem("door-code") ?? code'),
    M134: lockData("process.env.DOOR_CODE ?? code"),
    // FSL isn't type-checked, so the hidden error is the guard's (M13's).
    M135: edit([J.hook, `\n    // @ts-expect-error\n    ${broken[1]}`]),
    M135b: edit([J.hook, `\n    // @ts-ignore\n    ${broken[1]}`]),
    M135c: edit(["// test/fixtures/door.ts in jssm.", "// @ts-nocheck\n// test/fixtures/door.ts in jssm."], broken),
    M136: {
      ...edit([J.close, J.close.replace(`door.action("close")`, `(analytics.track("closed"), door.action("close"))`)]),
      prepend:
        "const analytics = {\n  events: [] as string[],\n  track(name: string): void {\n    this.events.push(name);\n  },\n};",
    },
    M137: {
      ...edit([J.close, J.close.replace(`door.action("close")`, `(track("closed"), door.action("close"))`)]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: {
      ...lockData("stamp(code)"),
      prepend: "function stamp(code: string): string {\n  return `${code}@${Date.now()}`;\n}",
    },
    // A hook's result is a boolean (or undefined, or a result object), so the array is wrapped.
    M139: hook(`({ data, next_data }) => Boolean(data.code?.split(",").filter((c) => c === next_data.code))`),

    // Persistence. `deserialize(fsl, machine.serialize())` restores.
    M259: append("export const again = new Machine<DoorData>({ ...config, snapshot: actor.serialize() });"),
    M261: {
      edits: fslConst,
      append: `import { deserialize } from "jssm";\nconst saved = JSON.stringify(actor.serialize());\nexport const restored = deserialize<DoorData>(fsl, JSON.parse(saved));`,
    },
    M265: na(JOB),

    // Use sites.
    M297: append("export const len = actor.data().by.length;"),
    M298: append(`export const is = actor.state() === "opened";`),
    M300: edit([J.init, "dat: { by: null, code: null }"]),
    M301: na("valid_action takes the action's name: that's how jssm asks"),
    M304: edit([J.create, "new Machine<DoorData>({ ...config, data: { by: null, code: null } } as any)"]),
    M305: append("export const by = (actor.data() as { by: string }).by;"),
    M305b: append(
      `actor.on("transition", () => {\n  if (actor.state() === "open") console.info(actor.data().by!.toUpperCase());\n});`,
    ),
    M307: edit(
      ["  readonly code: string | null;", "  readonly code?: string | null;"],
      [J.lock, J.lock.replace("{ by: null, code }", "{ by: null }")],
    ),
    M308: append(
      'export function label(door: Machine<DoorData>): string {\n  switch (door.state()) {\n    case "open":\n      return `open, by ${door.data().by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits. Transitions are FSL arrows, with no transition or state objects; the
    // machine's options are the config `new Machine` takes, where XState's keys go.
    M344: na("a target is a state's name in the FSL"),
    M345: na("a transition is an FSL arrow: no object to put a guard on (a guard is a hook)"),
    M345b: na("a transition is an FSL arrow: no object to put actions on (effects are hooks)"),
    M345c: na("a transition is an FSL arrow: no object to put a guard on (a guard is a hook)"),
    M345d: na("a transition is an FSL arrow, and the machine is flat: no in"),
    M346: na("array notation is FSL's own: one arrow per member"),
    M347: na("an arrow without an action is FSL's own; there is no map of events for an empty name"),
    // jssm's hooks accept on undefined: the wrong code unlocks.
    M348: hook(`({ data, next_data }) => (next_data.code === data.code ? true : undefined)`),
    M350: edit([J.init, `initial: "closed",\n    ${J.init}`]),
    M351: edit([J.init, "context: { by: null, code: null }"]),
    M352: edit([J.init, `id: "door",\n    ${J.init}`]),
    M353: na(JOB),
    M354: na("FSL has no state config to invoke from (its state declarations are styling), and jssm no tasks"),
    M355: na("FSL has no state config for activities (its state declarations are styling)"),
    M356: edit([J.init, `predictableActionArguments: true,\n    ${J.init}`]),
    M357: edit([J.init, `types: {} as { context: DoorData },\n    ${J.init}`]),
    M358: edit([J.create, "new Machine<DoorData>({ ...config, data: { by: null, code: null } }, { actions: {} })"]),
    M362: append(`import { and } from "jssm";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([J.push, J.push.replace("{ by, code: null }", "assign(() => ({ by, code: null }))")]),
      prepend: `import { assign } from "jssm";`,
    },
    M364: append(`import { interpret } from "jssm";\nexport const service = interpret(config).start();`),
    M366: na(JOB),
    M367: append(`import { invoke } from "jssm";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: na('an action is named by a string: action("push") is jssm\'s form'),
    M369: append("actor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.done;"),
    M372: append("export const value = actor.value;"),
    M373: append(`export const isOpen = actor.matches("open");`),
    M374: append("export const configured = config.withConfig({});"),
    M375: append(`export const preset = new Machine<DoorData>({ ...config, context: { by: "ann", code: null } });`),

    // From M404 on. Targets and data: an arrow is the transition, a pre-hook its guard.
    M404: na("an action fires when it's called: no step to build and drop"),
    // A hook's result can redirect: the 'no' branch stays in `locked` with the same data.
    M405: hook(
      `({ data, next_data }) => (next_data.code === data.code ? true : { pass: true, state: "locked", next_data: data })`,
    ),
    M406: pushData("{\n    get by() {\n      return by;\n    },\n    code: null,\n  }"),
    M407: na("no stay step: an arrow names its target"),
    M408: na("the first state is the FSL's first: no start handler that could decline"),
    M409: na("the first state is the FSL's first: no start handler to read an event"),
    M410: edit([J.lock, J.lock.replace("{ by: null, code }", "Object.assign(door.data(), { by: null, code })")]),
    M411: na(JOB),
    // jssm's own check: a second arrow for the same action throws when the FSL compiles.
    M412: edit([J.pushFsl, `${J.pushFsl}\n  closed 'push' -> open;`]),
    M413: edit(
      hookOn(
        `"closed", "locked", "lock"`,
        `({ next_data }) => {\n    next_data.code?.split("").forEach((c) => {\n      if (c === " ") return false;\n    });\n    return true;\n  }`,
      ),
    ),
    M414: pushData('{ by: JSON.parse(`"${by}"`), code: null }'),

    // Contracts.
    M416: na("an action's only payload is the machine's next data: an action without one takes none"),
    M417: openWith("[OPENED]", "boolean", "true", `const OPENED: unique symbol = Symbol("opened");`),
    M418: edit([CLOSE_FSL, `${CLOSE_FSL}\nopen 'toString' -> closed;`]),
    M419: edit(
      ["closed 'lock' -> locked;", "closed 'lock' -> 2;"],
      ["locked 'unlock' -> closed;", "2 'unlock' -> closed;"],
      [`door.hook_action("locked",`, `door.hook_action("2",`],
    ),
    M420: edit([CLOSE_FSL, `${CLOSE_FSL}\n  open 'Close' -> closed;`]),
    M421: na(JOB),
    M422: edit([CLOSE_FSL, `${CLOSE_FSL}\nopen 'close*' -> closed;`]),
    M423: na(JOB),
    M424: edit([BY, `  readonly by: "ann" | "bob" | string | null;`]),
    M425: openWith("constructor", "string", "by"),
    M426: {
      prepend: `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`,
      edits: [
        [BY, "  readonly by: Visitor | null;"],
        [J.push, J.push.replace("by: string)", "by: Visitor)")],
      ],
    },
    M427: na("no persisted format to number: FSL's machine_version is a semver of the machine"),
    M428: na("no `types<T>()`: the data's type is Machine's type argument"),

    // Events and sending.
    M429: append(
      `const message = JSON.parse('{ "action": "push", "data": { "by": "ann", "code": null } }');\nactor.action(message.action, message.data);`,
    ),

    // The graph.
    M432: na(JOB),
    M433: na(JOB),
    M434: na("FSL's arrows are the transitions: no `on` map to write a handler beside"),

    // Tasks.
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

    // Timers: FSL's `after`.
    M479: na(JOB),
    M480: na(JOB),
    M481: na(JOB),
    M482: edit([CLOSE_FSL, `${CLOSE_FSL}\n  open after 0ms -> closed;`]),
    M483: na(JOB),

    // Pure transitions: in the helper that builds the next data, or a hook where it refuses.
    M484: edit(
      hookOn(
        `"closed", "open", "push"`,
        `({ next_data }) => {\n    if (next_data.by === "") throw "by is required";\n    return true;\n  }`,
      ),
    ),
    M485: {
      prepend: "const validCode = (code: string): boolean => code.length === 1;",
      ...edit(hookOn(`"closed", "locked", "lock"`, "() => (validCode ? true : false)")),
    },
    M486: pushData(`{ by: by || "anonymous", code: null }`),
    M488: openWith("tries", "number", "Math.min(Math.max(by.length, 10), 1)"),
    M489: pushData("{ by: by.toLocaleUpperCase(), code: null }"),
    M490: na(JOB),
    M491: na(JOB),
    M492: na(JOB),
    M493: na(JOB),
    M494: na(JOB),
    M495: {
      prepend: `const NAMES: Record<string, string> = { ann: "Ann" };`,
      ...pushData("{ by: NAMES[by] ?? by, code: null }"),
    },
    M496: na("no event object: a hook gets the data, and the helpers their arguments"),
    M497: na("no event object: an action's payload is the next data, built from the helpers' string arguments"),
    M498: openWith("offset", "number", "-by"),
    M499: edit(
      [BY, `  readonly by: "ann" | "bob" | null;`],
      [J.push, J.push.replace("by: string)", `by: "ann" | "bob")`)],
      hookOn(
        `"closed", "open", "push"`,
        `({ next_data }) => {\n    switch (next_data.by) {\n      case "ann":\n        return true;\n      default:\n        return false;\n    }\n  }`,
      ),
    ),

    // Persistence.
    M571: append(
      `actor.on("transition", () => {\n  localStorage.setItem("door", JSON.stringify(actor.serialize()));\n});`,
    ),
    M573: na(JOB),

    // Use sites.
    M575: append("export const loose = new Machine<any>({ ...config, data: { by: null, code: null } });"),
    M576: edit([J.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n${J.push}`]),
    M577: append(`declare module "jssm" {\n  interface Machine<mDT> {\n    retryLater(data: mDT): void;\n  }\n}`),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.state() as (typeof SHUT)[number]);`,
    ),
    M581: na("the compiled config is plain data, spread into `new Machine` by the port itself"),
    M582: append(
      `export const withInput = new Machine<DoorData>({ ...config, data: { by: null, code: null }, input: { by: "ann" } });`,
    ),
    M583: append(
      `export function rename(by: string): void {\n  if (actor.state() === "open") actor.data().by = by;\n}`,
    ),
    M584: append(
      `actor.on("transition", async () => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(actor.serialize()));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: na("an instance has no stop: dropping one is how it ends"),
    M586: na(JOB),
    M587: append(
      `export function POST(req: Request): Response {\n  const ok = push(actor, req.headers.get("x-user") ?? "");\n  return new Response(ok ? "ok" : "refused");\n}`,
    ),
    M588: na("no toPromise: an instance has no done or output to await"),
    M589: na(JOB),
    M591: na("no pure transition: action runs on the instance"),

    // React and app code: no React binding, so a component reads the module's instance.
    M593: append(
      `export function DoorView(): null {\n  if (actor.state() === "closed") push(actor, "ann");\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.action };"),
    M603: append(
      `export function Log(): null {\n  actor.on("transition", () => console.info(actor.state()));\n  return null;\n}`,
    ),

    // Flows and modeling.
    M607: edit(
      [J.data, "  readonly code: string | null;\n  readonly open?: boolean;\n}"],
      [J.pushFsl, `${J.pushFsl}\n  closed 'setOpen' -> open;\n  open 'setOpen' -> closed;`],
      [
        HOOKED,
        `${HOOKED}\n  door.hook_action("closed", "open", "setOpen", ({ next_data }) => next_data.open === true);\n  door.hook_action("open", "closed", "setOpen", ({ next_data }) => next_data.open === false);`,
      ],
      [
        J.unlock,
        `${J.unlock}\nexport const setOpen = (door: Machine<DoorData>, open: boolean): boolean =>\n  door.action("setOpen", { by: "", code: null, open });`,
      ],
    ),

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    M613: append(
      `export const named = new Machine<DoorData>({ ...config, data: { by: null, code: null }, id: "door", devTools: true });`,
    ),
    M614: na(JOB),
    M615: na(JOB),
  },
};
export default jssm;
