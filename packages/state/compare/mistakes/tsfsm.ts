// typescript-fsm: each case in the port ../tsfsm/door.ts, written as its README writes a machine
// (a `SyncStateMachine` subclass, `t(from, event, to, callback)` rows, the data in the instance's
// fields, set by the callbacks). Its logger is `console`: what it logs counts at start.
//
// The library has no job port (no tasks it cancels, no timers), so every job case is n/a. A row's
// callback is a hook that runs after the state changes, where the README does its work (logging,
// dispatching more events): there is no pure part, so the purity cases that only add an effect or
// an impure read are n/a. Data is the instance's fields; a mistake about data is made in them.

import { append, type CaseModule, edit, HELPERS, type Library, type Mutation, na, SCENARIO, settle } from "./cases.ts";

// The port's rows and its `send`, as written there.
const F = {
  push: `t("closed", "push", "open", function (this: Door, by: unknown) {\n    this.by = String(by);\n    this.listener("open");\n  }),`,
  lock: `t("closed", "lock", "locked", function (this: Door, code: unknown) {\n    this.code = String(code);\n    this.listener("locked");\n  }),`,
  open: `t("open", "close", "closed", function (this: Door) {\n    this.listener("closed");\n  }),`,
  pushFn: "function (this: Door, by: unknown) {",
  setBy: "this.by = String(by);",
  setCode: "this.code = String(code);",
  field: "  by: string | null = null;",
  sendPush: `return this.syncDispatch("push", e.by);`,
  sendLock: `return this.syncDispatch("lock", e.code);`,
  sendUnlock: `return e.code === this.code && this.syncDispatch("unlock");`,
  pushEvent: `| { readonly type: "push"; readonly by: string }`,
  names: `type Name = "push" | "close" | "lock" | "unlock";`,
  header: "// test/fixtures/door.ts in typescript-fsm",
  listener: "new Door(() => {})",
};
const opne = F.push.replace(`"push", "open"`, `"push", "opne"`);
/** `push`'s data, set another way. */
const setBy = (to: string): Mutation => edit([F.setBy, to]);
/** A field added to the instance, set by `push`'s callback. */
const openWith = (field: string, decl: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [F.field, `${F.field}\n  ${field}: ${decl};`],
    [F.setBy, `${F.setBy}\n    this.${field} = ${value};`],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});

/** A row from open on this event to closed. */
const closeOn = (event: string) =>
  `t("open", "${event}", "closed", function (this: Door) {\n    this.listener("closed");\n  }),`;
/** The helpers the cases from M404 on declare. */
const OPENED = `const OPENED: unique symbol = Symbol("opened");`;
const ENUM = `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`;
const VALID = "const validCode = (code: string): boolean => code.length === 1;";
const NAMES = `const NAMES: Record<string, string> = { ann: "Ann" };`;
const NO_TIMERS = "no timers";

const NO_JOB = "no job port: no tasks it cancels and no timers";
const HOOK = "a row's callback is the after-transition hook, where the README does its effects: no pure part";
const NO_CONFIG = "no machine config: the initial state is the constructor's argument, the graph is t() rows";
const NO_TRANSITION_OBJECT = "a row is t(from, event, to, callback): no transition object to put it on";

interface Door {
  send(event: object): unknown;
}

const tsfsm: Library = {
  name: "typescript-fsm",
  bases: { door: { port: "../tsfsm/door.ts", tail: `\nexport const actor = ${F.listener};\n` } },
  drive: async (mod: CaseModule) => {
    const actor = mod.actor as Door;
    for (const event of SCENARIO.door) actor.send(event);
    await settle();
  },
  cases: {
    // Targets and data.
    M1: edit([F.push, opne]),
    M2: edit([`${F.setCode}\n    `, ""]),
    M3: na("no per-state data: the fields are the instance's, kept in every state"),
    M4: setBy(`${F.setBy}\n    this.at = 1;`),
    M5: setBy("Object.assign(this, { ...{ by: String(by), at: 1 } });"),
    M6: setBy("const next = { by: String(by), at: 1 };\n    Object.assign(this, next);"),
    M7: setBy("this.by = String(by).length;"),
    M8: na("a callback returns nothing: the target is t()'s argument"),
    M9: edit([F.pushFn, `async ${F.pushFn}`]),
    M10: na("the instance's fields are the data, and callbacks assign them: mutation is the library's form"),
    M12: edit([F.setCode, "this.code = String(this.code);"]),
    M13: edit([F.sendPush, `return this.syncDispatch("push", e.name);`]),
    M14: setBy(`this.by = String(by).split(" ")[0];`),
    M15: setBy("this.by = undefined;"),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"], [F.setBy, "this.by = by as Date;"]),
    M17: edit([F.pushEvent, `| { readonly type: "push"; readonly by: Date }`]),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: na("the data is the class's fields, declared one by one: no data type to widen to an index signature"),
    M21: edit(["by: string", "by: {}", "all"]),
    M22: edit(["by: string", "by: object", "all"], [F.setBy, "this.by = by as object;"]),
    M23: edit(["code: string", "code: [string, string]", "all"], [F.setCode, "this.code = code as [string, string];"]),
    M24: na("a payload is syncDispatch's positional arguments: no field names to collide with `type`"),
    M25: na(NO_JOB),
    M26: na(NO_JOB),
    M27: openWith("note", "File | null = null", 'new File([String(by)], "note.txt")'),
    M28: openWith("visitor", "Visitor | null = null", "new Visitor(String(by))", HELPERS.visitor),
    M29: openWith("visits", "bigint | null = null", "BigInt(String(by).length)"),
    M30: openWith("seen", "Set<string> | null = null", "new Set([String(by)])"),
    M31: openWith("byId", "Map<string, string> | null = null", 'new Map([["by", String(by)]])'),
    M32: edit([F.pushEvent, `| { readonly type: "push"; readonly by: string; readonly click: MouseEvent }`]),
    M33: edit(
      [F.pushEvent, `| { readonly type: "push"; readonly by: string; readonly button: HTMLElement }`],
      [F.sendPush, `return this.syncDispatch("push", e.by, e.button);`],
      [F.field, `${F.field}\n  button: HTMLElement | null = null;`],
      [
        `${F.pushFn}\n    ${F.setBy}`,
        `function (this: Door, by: unknown, button: unknown) {\n    ${F.setBy}\n    this.button = button as HTMLElement;`,
      ],
    ),
    M34: openWith("note", "string | undefined", 'String(by) === "" ? undefined : String(by)'),
    M41: openWith("isOpen", "boolean = false", "true"),

    // Events and sending.
    M43: append(`actor.send({ type: "kick" });`),
    M44: append(`actor.send({ type: "push" });`),
    M45: append(`actor.send({ type: "push", by: 1 });`),
    M46: append(`actor.send({ type: "push", by: "ann", at: 1 });`),
    M47: na(NO_JOB),
    M48: edit([F.push, F.push.replace(`"push", "open"`, `"psuh", "open"`)]),
    M49: append(`actor.send({ type: "close" });`),
    M50: na("no stop: an instance is dropped, not stopped"),
    M52: edit([F.listener, `new Door(() => {\n  throw new Error("render failed");\n})`]),
    M53: na(NO_JOB),
    M55: na("no event name is reserved"),

    // The graph.
    M56: edit([F.open, ""]),
    M57: edit([
      F.open,
      `${F.open}\n  t("broken", "close", "closed", function (this: Door) {\n    this.listener("closed");\n  }),`,
    ]),
    M58: edit([F.lock, ""]),
    M59: edit([F.open, ""]),
    M60: na(NO_JOB),
    M62: edit([F.names, `type Name = "push" | "close" | "lock" | "unlock" | "kick";`]),
    M63: na(NO_JOB),
    M64: na(NO_JOB),

    // Tasks.
    M65: na(NO_JOB),
    M66: na(NO_JOB),
    M67: na(NO_JOB),
    M68: na(NO_JOB),
    M69: na(NO_JOB),
    M70: na(NO_JOB),
    M71: na(NO_JOB),
    M72: na(NO_JOB),
    M73: na(NO_JOB),
    M74: na(NO_JOB),
    M75: na(NO_JOB),
    M76: na(NO_JOB),
    M77: na(NO_JOB),
    M78: na(NO_JOB),
    M79: na(NO_JOB),
    M80: na(NO_JOB),
    M81: na(NO_JOB),
    M82: na(NO_JOB),
    M83: na(NO_JOB),
    M84: na(NO_JOB),
    M87: na(NO_JOB),

    // Timers.
    M88: na(NO_JOB),
    M89: na(NO_JOB),
    M90: na(NO_JOB),
    M96: na(NO_JOB),
    M104: na(NO_JOB),

    // Pure transitions.
    M116: na(HOOK),
    M117: na(HOOK),
    M119: na(HOOK),
    M120: na(HOOK),
    M121: na(HOOK),
    M122: na(HOOK),
    M123: na(HOOK),
    M124: {
      ...setBy("Object.assign(this, { ...defaults, by: String(by) });"),
      prepend: `const defaults = { by: "guest" };`,
    },
    M125: {
      ...setBy("Object.assign(this, withBy(String(by)));"),
      prepend: "function withBy(by: string): { by: string } {\n  const out = { by, at: Date.now() };\n  return out;\n}",
    },
    M126: na(HOOK),
    M127: na(HOOK),
    M128: edit([F.sendLock, `return this.syncDispatch("lock");`], [F.setCode, "this.code = code as string;"]),
    M128b: na(NO_JOB),
    M129: setBy(`this.by = String(by).split(" ")[0]!;`),
    M130: na(HOOK),
    M131: na(HOOK),
    M132: na(HOOK),
    M133: na(HOOK),
    M134: na(HOOK),
    M135: edit([F.push, `// @ts-expect-error\n  ${opne}`]),
    M135b: edit([F.push, `// @ts-ignore\n  ${opne}`]),
    M135c: edit([F.header, `// @ts-nocheck\n${F.header}`], [F.push, opne]),
    M136: na(HOOK),
    M137: na(HOOK),
    M138: na(HOOK),
    M139: edit([
      F.sendUnlock,
      `return (this.code ?? "").split(",").filter((c) => c === e.code) ? this.syncDispatch("unlock") : false;`,
    ]),

    // Persistence.
    M259: na("no snapshot or restore: the current state is protected, and the constructor starts at init"),
    M261: na("no snapshot or restore: the current state is protected, and the constructor starts at init"),
    M265: na(NO_JOB),

    // Use sites.
    M297: append("export const len = actor.by.length;"),
    M298: append(`export const is = actor.getState() === "opened";`),
    M300: na("the constructor's options are positional: init, transitions, logger"),
    M301: na("can(event) takes the event's name in typescript-fsm"),
    M304: edit([F.listener, "new (Door as any)(() => {})"]),
    M305: append("export const by = actor.by as string;"),
    M305b: edit([F.listener, `new Door((s) => {\n  if (s === "open") console.info(actor.by!.toUpperCase());\n})`]),
    M307: na("every field is nullable already: the instance's fields outlive their states"),
    M308: append(
      'export function label(door: Door): string {\n  switch (door.getState()) {\n    case "open":\n      return `open, by ${door.by}`;\n    default:\n      return "closed";\n  }\n}',
    ),

    // Migration habits.
    M344: na("a target is t()'s string argument already"),
    M345: na(NO_TRANSITION_OBJECT),
    M345b: na(NO_TRANSITION_OBJECT),
    M345c: na(NO_TRANSITION_OBJECT),
    M345d: na(NO_TRANSITION_OBJECT),
    M346: na(NO_TRANSITION_OBJECT),
    M347: edit([
      F.open,
      `${F.open}\n  t("open", "", "closed", function (this: Door) {\n    this.listener("closed");\n  }),`,
    ]),
    M348: na("no transition function to decline from: the guard is a check before syncDispatch"),
    M350: na(NO_CONFIG),
    M351: na(NO_CONFIG),
    M352: na(NO_CONFIG),
    M353: na(NO_JOB),
    M354: na("no state config: a state is a name in t() rows"),
    M355: na("no state config: a state is a name in t() rows"),
    M356: na(NO_CONFIG),
    M357: na(NO_CONFIG),
    M358: na(NO_CONFIG),
    M362: append(`import { and } from "typescript-fsm";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([F.push, `t("closed", "push", "open", assign(({ event }) => ({ by: event.by }))),`]),
      prepend: `import { assign } from "typescript-fsm";`,
    },
    M364: append(`import { interpret } from "typescript-fsm";\nexport const service = interpret(Door);`),
    M366: na(NO_JOB),
    M367: append(`import { invoke } from "typescript-fsm";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: na(`a string event is typescript-fsm's own form: syncDispatch("push")`),
    M369: append("actor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.done;"),
    M372: append("export const value = actor.value;"),
    M373: append(`export const isOpen = actor.matches("open");`),
    M374: append("export const configured = Door.withConfig({});"),
    M375: append(`export const preset = new Door(() => {}, { context: { by: "ann" } });`),

    // From M404 on. Targets and data.
    M404: na("a callback returns nothing and can't decline: the target is t()'s argument"),
    M405: edit([F.sendUnlock, `return e.code === this.code ? this.syncDispatch("unlock") : true;`]),
    M406: na("the data is the instance's fields, set by assignment: no data object to put a getter in"),
    M407: na("a row names its target: there is no form that stays, to name the wrong state in"),
    M408: na("the first state is the constructor's argument: nothing runs at start that could decline"),
    M409: na("the first state is the constructor's argument: no handler runs at start"),
    M410: na("the instance's fields are the data, and callbacks assign them: mutation is the library's form"),
    M411: na(NO_JOB),
    M412: edit([
      F.lock,
      `${F.lock}\n  t("closed", "push", "open", function (this: Door, by: unknown) {\n    this.by = String(by).trim();\n    this.listener("open");\n  }),`,
    ]),
    M413: edit([
      F.sendLock,
      `e.code.split("").forEach((c) => {\n          if (c === " ") return false;\n        });\n        ${F.sendLock}`,
    ]),
    M414: setBy('this.by = JSON.parse(`"${String(by)}"`);'),

    // Contracts.
    M416: na("a payload is syncDispatch's arguments: no payload type to write as void"),
    M417: {
      prepend: OPENED,
      edits: [
        [F.field, `${F.field}\n  [OPENED]: boolean = false;`],
        [F.setBy, `${F.setBy}\n    this[OPENED] = true;`],
      ],
    },
    // M418 and M422: the app sends close, so the name is a second event beside it.
    M418: edit(
      [F.names, `type Name = "push" | "close" | "toString" | "lock" | "unlock";`],
      [F.open, `${F.open}\n  ${closeOn("toString")}`],
    ),
    M419: edit([`"locked"`, "2", "all"]),
    M420: edit(
      [F.names, `type Name = "push" | "close" | "Close" | "lock" | "unlock";`],
      [F.open, `${F.open}\n  ${closeOn("Close")}`],
    ),
    M421: na(NO_JOB),
    M422: edit(
      [F.names, `type Name = "push" | "close" | "close*" | "lock" | "unlock";`],
      [F.open, `${F.open}\n  ${closeOn("close*")}`],
    ),
    M423: na(NO_JOB),
    M424: edit([F.field, `  by: "ann" | "bob" | string | null = null;`]),
    M425: na("the data is the class's fields, and a class can't declare a field named constructor"),
    M426: { prepend: ENUM, edits: [[F.pushEvent, `| { readonly type: "push"; readonly by: Visitor }`]] },
    M427: na("no version: the constructor takes the first state, the rows and a logger"),
    M428: na("no schema helper: the states and events are type parameters"),

    // Events and sending. The push is closed again, so the app's own push finds the door closed.
    M429: append(`actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));\nactor.send({ type: "close" });`),

    // The graph.
    M432: na(NO_JOB),
    M433: na(NO_JOB),
    M434: na(NO_TRANSITION_OBJECT),

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
    M482: na(NO_TIMERS),
    M483: na(NO_JOB),

    // Pure transitions: the checks before a dispatch are in `send`.
    M484: edit([F.sendPush, `if (e.by === "") throw "by is required";\n        ${F.sendPush}`]),
    M485: { prepend: VALID, ...edit([F.sendLock, `return validCode ? this.syncDispatch("lock", e.code) : false;`]) },
    M486: setBy(`this.by = String(by) || "anonymous";`),
    M488: openWith("tries", "number | null = null", "Math.min(Math.max(String(by).length, 10), 1)"),
    M489: setBy("this.by = String(by).toLocaleUpperCase();"),
    M490: na(NO_JOB),
    M491: na(NO_JOB),
    M492: na(NO_JOB),
    M493: na(NO_JOB),
    M494: na(NO_JOB),
    M495: { prepend: NAMES, ...setBy("this.by = NAMES[String(by)] ?? String(by);") },
    M496: edit([F.sendPush, `return e ? this.syncDispatch("push", e.by) : false;`]),
    M497: edit([F.sendPush, 'return this.syncDispatch("push", `by ${e}`);']),
    M498: openWith("offset", "number | null = null", "-String(by)"),
    M499: edit(
      [F.pushEvent, `| { readonly type: "push"; readonly by: "ann" | "bob" }`],
      [
        F.sendPush,
        `switch (e.by) {\n          case "ann":\n            return this.syncDispatch("push", e.by);\n          default:\n            return false;\n        }`,
      ],
    ),

    // Persistence.
    M571: edit([
      F.listener,
      `new Door(() => {\n  localStorage.setItem("door", JSON.stringify({ state: actor.getState(), by: actor.by, code: actor.code }));\n})`,
    ]),
    M573: na(NO_JOB),

    // Use sites.
    M575: na("an actor is new Door(listener): the subclass takes no type arguments"),
    M576: edit([F.push, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n  ${F.push}`]),
    M577: append(
      `declare module "typescript-fsm" {\n  interface SyncStateMachine<\n    STATE extends string | number | symbol,\n    EVENT extends string | number | symbol,\n    CALLBACK extends Record<EVENT, SyncCallback> = Record<EVENT, SyncCallback>,\n  > {\n    retryLater(state: STATE): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.getState() as (typeof SHUT)[number]);`,
    ),
    M581: na("the machine is the Door class and its rows: there is no machine object to spread"),
    M582: append(`export const withInput = new Door(() => {}, { by: "ann" });`),
    M583: append(`export function rename(by: string): void {\n  if (actor.getState() === "open") actor.by = by;\n}`),
    M584: edit([
      F.listener,
      `new Door(async (state) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", state);\n  } catch (e) {\n    console.error(e);\n  }\n})`,
    ]),
    M585: na("no stop: an instance is dropped, not stopped"),
    M586: na(NO_JOB),
    M587: append(
      `export function POST(req: Request): Response {\n  const ok = actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(ok ? "ok" : "refused");\n}`,
    ),
    M588: na("no toPromise: a machine reports its states through its listener"),
    M589: na(NO_JOB),
    M591: na("no pure transition: syncDispatch changes the instance"),

    // React and app code: no binding, and the cases' folder doesn't resolve React's types, so a
    // component reads the module's instance.
    M593: append(
      `export function DoorView(): null {\n  if (actor.getState() === "closed" && !actor.send({ type: "push", by: "ann" })) console.warn("refused");\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send };"),
    M603: na("no subscribe: the one listener is the constructor's"),

    // Flows and modeling.
    M607: edit(
      [F.names, `type Name = "push" | "close" | "lock" | "unlock" | "setOpen";`],
      [
        `| { readonly type: "unlock"; readonly code: string };`,
        `| { readonly type: "unlock"; readonly code: string }\n  | { readonly type: "setOpen"; readonly open: boolean };`,
      ],
      [
        F.sendUnlock,
        `${F.sendUnlock}\n      case "setOpen":\n        return e.open === (this.getState() === "closed") && this.syncDispatch("setOpen");`,
      ],
      [
        F.open,
        `${F.open}\n  t("closed", "setOpen", "open", function (this: Door) {\n    this.by = "";\n    this.listener("open");\n  }),\n  t("open", "setOpen", "closed", function (this: Door) {\n    this.listener("closed");\n  }),`,
      ],
    ),

    // Migration habits.
    M612: append("export const current = actor.getSnapshot();"),
    M613: append(`export const named = new Door(() => {}, { id: "door", devTools: true });`),
    M614: na(NO_JOB),
    M615: na(NO_JOB),
  },
};
export default tsfsm;
