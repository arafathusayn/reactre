// @xstate/store: each case in the port ../store/door.ts, written as its docs write a store
// (`createStoreConfig` with `context` and `on`, each event's reducer returning the next context).
// A store has no states: the port's context is a union tagged by `state` (each state's data), and
// a reducer that returns `undefined` refuses the event. The store has no development build (its
// few checks are for extensions the door doesn't use). No job port (no tasks it cancels, no
// timers), so every job case is n/a.
//
// A reducer is pure (docs: effects go in `enq.effect`), so the purity cases put the impure read or
// write in the reducer.

import { append, type CaseModule, edit, HELPERS, type Library, type Mutation, na, SCENARIO, settle } from "./cases.ts";

// The port's parts, as written there.
const S = {
  pushHead: "push: (door, e: { by: string }): Door | undefined =>",
  push: `door.state === "closed" ? { state: "open", by: e.by } : undefined,`,
  close: `close: (door): Door | undefined => (door.state === "open" ? { state: "closed" } : undefined),`,
  lock: `door.state === "closed" ? { state: "locked", code: e.code } : undefined,`,
  lockHead: "lock: (door, e: { code: string }): Door | undefined =>",
  unlock: `door.state === "locked" && door.code === e.code ? { state: "closed" } : undefined,`,
  openType: `| { readonly state: "open"; readonly by: string }`,
  lockedType: `| { readonly state: "locked"; readonly code: string };`,
  context: "context: start(),",
  end: `undefined,\n  },\n});`,
};
/** `push`'s reducer, head and body. */
const PUSH = `${S.pushHead}\n      ${S.push}`;

/** `push`'s body: the next context when the door is closed. */
const pushTo = (next: string): Mutation => edit([S.push, `door.state === "closed" ? ${next} : undefined,`]);
/** `lock`'s code. */
const lockCode = (code: string): Mutation => edit([S.lock, S.lock.replace("code: e.code", `code: ${code}`)]);
/** An effect in `push`'s reducer, before the context it returns. */
const pushDoes = (effect: string): Mutation => pushTo(`(${effect}, { state: "open", by: e.by })`);
/** A field added to `open`'s data, given by `push`. */
const openWith = (field: string, type: string, value: string, prepend?: string): Mutation => ({
  edits: [
    [S.openType, `| { readonly state: "open"; readonly by: string; readonly ${field}: ${type} }`],
    [S.push, `door.state === "closed" ? { state: "open", by: e.by, ${field}: ${value} } : undefined,`],
  ],
  ...(prepend === undefined ? {} : { prepend }),
});
/** `close`, replaced by this (a store's `on` is where XState's transition config would go). */
const closeAs = (config: string): Mutation => edit([S.close, `close: ${config},`]);
const opne = S.push.replace('"open"', '"opne"');
/** `lock`'s reducer, head and body. */
const LOCK = `${S.lockHead}\n      ${S.lock}`;
/** A reducer added after `close`. */
const alsoOn = (reducer: string): Mutation => edit([S.close, `${S.close}\n    ${reducer}`]);
const NO_JOB = "no job port";
/** The helpers the cases from M404 on declare. */
const OPENED = `const OPENED: unique symbol = Symbol("opened");`;
const ENUM = `enum Visitor {\n  Ann = "ann",\n  Bob = "bob",\n}`;
const VALID = "const validCode = (code: string): boolean => code.length === 1;";
const NAMES = `const NAMES: Record<string, string> = { ann: "Ann" };`;

const tail = `\nimport { createStore } from "@xstate/store";\nexport const actor = createStore(doorStore);\n`;

interface Store {
  send(event: object): void;
  getSnapshot(): { status: string; error?: unknown };
}

const store: Library = {
  name: "@xstate/store",
  bases: { door: { port: "../store/door.ts", tail } },
  drive: async (mod: CaseModule) => {
    const actor = mod.actor as Store;
    for (const event of SCENARIO.door) actor.send(event);
    await settle();
    const s = actor.getSnapshot();
    if (s.status === "error") throw new Error(`the store errors: ${String(s.error)}`);
  },
  cases: {
    // Targets and data.
    M1: edit([S.push, opne]),
    M2: edit([S.lock, `door.state === "closed" ? { state: "locked" } : undefined,`]),
    M3: edit([S.close, S.close.replace(`{ state: "closed" }`, `{ ...door, state: "closed" }`)]),
    M4: pushTo(`{ state: "open", by: e.by, at: 1 }`),
    M5: pushTo(`{ ...{ state: "open", by: e.by, at: 1 } }`),
    M6: edit([
      PUSH,
      `${S.pushHead} {\n      const next = { state: "open" as const, by: e.by, at: 1 };\n      return door.state === "closed" ? next : undefined;\n    },`,
    ]),
    M7: pushTo(`{ state: "open", by: e.by.length }`),
    M8: edit([PUSH, `${S.pushHead} {\n      ${S.push.replace(/,$/, ";")}\n    },`]),
    M9: edit([S.pushHead, S.pushHead.replace("push: (", "push: async (")]),
    M10: edit([S.unlock, `door.state === "locked" ? ((door.code = e.code), { state: "closed" }) : undefined,`]),
    M12: edit([S.lock, `door.state === "closed" ? { state: "locked", code: door.code } : undefined,`]),
    M13: pushTo(`{ state: "open", by: e.name }`),
    M14: pushTo(`{ state: "open", by: e.by.split(" ")[0] }`),
    M15: pushTo(`{ state: "open", by: undefined }`),

    // Contracts.
    M16: edit(["by: string", "by: Date", "all"]),
    M17: edit(
      [S.pushHead, S.pushHead.replace("e: { by: string }", "e: { by: Date }")],
      [S.push, `door.state === "closed" ? { state: "open", by: String(e.by) } : undefined,`],
    ),
    M18: edit(["by: string", "by: any", "all"]),
    M19: edit(["code: string", "code: unknown", "all"]),
    M20: edit([S.openType, `| { readonly state: "open"; readonly [key: string]: string }`]),
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
    M32: edit([S.pushHead, S.pushHead.replace("e: { by: string }", "e: { by: string; click: MouseEvent }")]),
    M33: edit(
      [S.pushHead, S.pushHead.replace("e: { by: string }", "e: { by: string; button: HTMLElement }")],
      [S.openType, `| { readonly state: "open"; readonly by: string; readonly button: HTMLElement }`],
      [S.push, `door.state === "closed" ? { state: "open", by: e.by, button: e.button } : undefined,`],
    ),
    M34: openWith("note", "string | undefined", 'e.by === "" ? undefined : e.by'),
    M41: openWith("isOpen", "boolean", "true"),

    // Events and sending.
    M43: append(`actor.send({ type: "kick" });`),
    M44: append(`actor.send({ type: "push" });`),
    M45: append(`actor.send({ type: "push", by: 1 });`),
    M46: append(`actor.send({ type: "push", by: "ann", at: 1 });`),
    M47: na("no job port"),
    M48: edit([S.pushHead, S.pushHead.replace("push:", "psuh:")]),
    M49: append(`actor.send({ type: "close" });`),
    M50: na("a store has no stop: it is dropped, never stopped"),
    M52: append(`actor.subscribe(() => {\n  throw new Error("render failed");\n});`),
    M53: na("no job port"),
    M55: na("no event name is reserved without an extension (undo, reset), and the door uses none"),

    // The graph.
    M56: na("a store has no state config: the context's union is the only place a state is"),
    M57: na("a store has no state config: the context's union is the only place a state is"),
    M58: edit([`    ${S.lockHead}\n      ${S.lock}\n`, ""]),
    M59: edit([`    ${S.close}\n`, ""]),
    M60: na("no job port"),
    M62: na("a store's events are the keys of `on`, each with its reducer: none is declared apart"),
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
    M124: { ...pushTo(`{ ...defaults, state: "open", by: e.by }`), prepend: `const defaults = { by: "guest" };` },
    M125: {
      ...pushTo("withBy(e.by)"),
      prepend:
        'function withBy(by: string): { state: "open"; by: string } {\n  const out = { state: "open" as const, by, at: Date.now() };\n  return out;\n}',
    },
    M126: lockCode('[...new Set(e.code)].join("")'),
    M127: lockCode("import.meta.env.DOOR_CODE ?? e.code"),
    M128: edit([S.lock, `door.state === "closed" ? ({ state: "locked" } as Door) : undefined,`]),
    M128b: na("no job port"),
    M129: pushTo(`{ state: "open", by: e.by.split(" ")[0]! }`),
    M130: pushDoes(`console.log("pushed by", e.by)`),
    M131: pushDoes(`void fetch("/api/audit", { method: "POST", body: e.by }).catch(() => {})`),
    M132: edit([
      S.lock,
      `door.state === "closed"\n        ? (setTimeout(() => console.info("relock"), 1000), { state: "locked", code: e.code })\n        : undefined,`,
    ]),
    M133: lockCode('localStorage.getItem("door-code") ?? e.code'),
    M134: lockCode("process.env.DOOR_CODE ?? e.code"),
    M135: edit([S.push, `// @ts-expect-error\n      ${opne}`]),
    M135b: edit([S.push, `// @ts-ignore\n      ${opne}`]),
    M135c: edit(
      ["// test/fixtures/door.ts in @xstate/store.", "// @ts-nocheck\n// test/fixtures/door.ts in @xstate/store."],
      [S.push, opne],
    ),
    M136: {
      ...edit([
        S.close,
        S.close.replace(`? { state: "closed" }`, `? (analytics.track("closed"), { state: "closed" })`),
      ]),
      prepend: HELPERS.analytics,
    },
    M137: {
      ...edit([S.close, S.close.replace(`? { state: "closed" }`, `? (track("closed"), { state: "closed" })`)]),
      prepend: `import { track } from "./telemetry.ts";`,
    },
    M138: { ...lockCode("stamp(e.code)"), prepend: HELPERS.stamp },
    M139: edit([
      S.unlock,
      `door.state === "locked" && door.code.split(",").filter((c) => c === e.code) ? { state: "closed" } : undefined,`,
    ]),

    // Persistence.
    M259: append("export const again = createStore(doorStore, { snapshot: actor.getSnapshot() });"),
    M261: append(
      "const saved = JSON.stringify(actor.getSnapshot().context);\nexport const restored = createStore({ ...doorStore, context: JSON.parse(saved) });",
    ),
    M265: na("no job port"),

    // Use sites.
    M297: append("export const len = actor.getSnapshot().context.by.length;"),
    M298: append(`export const is = actor.getSnapshot().context.state === "opened";`),
    M300: edit([S.context, "contxt: start(),"]),
    M301: append(`export const canClose = actor.can("close");`),
    M304: edit(["createStore(doorStore)", "createStore(doorStore as any)"]),
    M305: append("export const by = (actor.getSnapshot().context as { by: string }).by;"),
    M305b: append(
      `actor.subscribe((s) => {\n  if (s.context.state === "open") console.info(s.context.by!.toUpperCase());\n});`,
    ),
    M307: edit(
      [S.lockedType, `| { readonly state: "locked"; readonly code?: string };`],
      [S.lock, `door.state === "closed" ? { state: "locked" } : undefined,`],
    ),
    M308: append(HELPERS.label("actor.getSnapshot", "s.context.state", "s.context.by")),

    // Migration habits.
    M344: closeAs(`"closed"`),
    M345: closeAs(`{ target: "closed", guard: "isOpen" }`),
    M345b: closeAs(`{ target: "closed", actions: "log" }`),
    M345c: closeAs(`{ target: "closed", cond: "isOpen" }`),
    M345d: closeAs(`{ target: "closed", in: "open" }`),
    M346: edit([PUSH, `push: [{ target: "open" }, { target: "locked" }],`]),
    M347: edit([
      S.close,
      `${S.close}\n    "": (door): Door | undefined => (door.state === "open" ? { state: "closed" } : undefined),`,
    ]),
    M348: na("undefined is how a store's reducer declines"),
    M350: edit([S.context, `initial: "closed",\n  ${S.context}`]),
    M351: na("context is how a store gives its data"),
    M352: edit([S.context, `id: "door",\n  ${S.context}`]),
    M353: na("no job port"),
    M354: na("a store has no state nodes to invoke on"),
    M355: na("a store has no state nodes to give activities"),
    M356: edit([S.context, `predictableActionArguments: true,\n  ${S.context}`]),
    M357: edit([S.context, `types: {} as { context: Door },\n  ${S.context}`]),
    M358: edit([S.end, `undefined,\n  },\n}, { actions: {} });`]),
    M362: append(`import { and } from "@xstate/store";\nexport const both = and(["isAdmin", "isActive"]);`),
    M363: {
      ...edit([PUSH, `push: { target: "open", actions: assign(({ event }) => ({ by: event.by })) },`]),
      prepend: `import { assign } from "@xstate/store";`,
    },
    M364: append(`import { interpret } from "@xstate/store";\nexport const service = interpret(doorStore);`),
    M366: na("no job port"),
    M367: append(`import { invoke } from "@xstate/store";\nexport const loader = invoke({ src: "fetchUser" });`),
    M368: append(`actor.send("push");`),
    M369: append("actor.start();"),
    M370: append("actor.onTransition(() => {});"),
    M371: append("export const done = actor.getSnapshot().done;"),
    M372: append("export const value = actor.getSnapshot().value;"),
    M373: append(`export const isOpen = actor.getSnapshot().matches("open");`),
    M374: append("export const configured = doorStore.withConfig({});"),
    M375: append(`export const preset = createStore(doorStore, { context: { state: "closed" } });`),

    // From M404 on. Targets and data. A store's step is the reducer's next context: built and
    // dropped, the reducer returning undefined (the refusal).
    M404: edit([
      LOCK,
      `${S.lockHead} {\n      if (door.state === "closed" && e.code !== "") ({ state: "locked", code: e.code });\n      return undefined;\n    },`,
    ]),
    M405: edit([S.unlock, `door.state === "locked" && door.code === e.code ? { state: "closed" } : door,`]),
    M406: pushTo(
      `{\n          state: "open",\n          get by() {\n            return e.by;\n          },\n        }`,
    ),
    M407: na("a store has no states to stay in: a reducer returns the next context"),
    M408: na("the first context is a value (`context: start()`): nothing runs at start that could decline"),
    M409: na("the first context is a value (`context: start()`): no handler runs at start with an event"),
    M410: edit([
      S.lock,
      `door.state === "closed" ? Object.assign(door, { state: "locked", code: e.code }) : undefined,`,
    ]),
    M411: na(NO_JOB),
    M412: alsoOn(
      `push: (door, e: { by: string }): Door | undefined =>\n      door.state === "closed" ? { state: "open", by: e.by.trim() } : undefined,`,
    ),
    M413: edit([
      LOCK,
      `${S.lockHead} {\n      e.code.split("").forEach((c) => {\n        if (c === " ") return undefined;\n      });\n      return ${S.lock.replace(/,$/, ";")}\n    },`,
    ]),
    M414: pushTo('{ state: "open", by: JSON.parse(`"${e.by}"`) }'),

    // Contracts.
    M416: edit([S.close, S.close.replace("(door)", "(door, _: void)")]),
    M417: openWith("[OPENED]", "boolean", "true", OPENED),
    // M418 and M422: the app sends close, so the name is a second event beside it.
    M418: alsoOn(S.close.replace("close:", "toString:")),
    M419: edit([`"locked"`, `"2"`, "all"]),
    M420: alsoOn(S.close.replace("close:", "Close:")),
    M421: na(NO_JOB),
    M422: alsoOn(S.close.replace("close:", `"close*":`)),
    M423: na(NO_JOB),
    M424: edit([S.openType, `| { readonly state: "open"; readonly by: "ann" | "bob" | string }`]),
    M425: openWith("constructor", "string", "e.by"),
    M426: {
      prepend: ENUM,
      edits: [
        [S.pushHead, S.pushHead.replace("e: { by: string }", "e: { by: Visitor }")],
        [S.openType, `| { readonly state: "open"; readonly by: Visitor }`],
      ],
    },
    M427: na("a store has no version"),
    M428: na("a store's types come from its context and its reducers' parameters: no schema helper to leave uncalled"),

    // Events and sending.
    M429: append(`actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));\nactor.send({ type: "close" });`),

    // The graph.
    M432: na(NO_JOB),
    M433: na(NO_JOB),
    M434: edit([`    ${S.close}\n`, ""], [S.context, `${S.context}\n  ${S.close}`]),

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
    M482: na("no timers: a store has no delayed transitions"),
    M483: na(NO_JOB),

    // Pure transitions.
    M484: edit([
      PUSH,
      `${S.pushHead} {\n      if (e.by === "") throw "by is required";\n      return ${S.push.replace(/,$/, ";")}\n    },`,
    ]),
    M485: {
      prepend: VALID,
      ...edit([S.lock, `door.state === "closed" && validCode ? { state: "locked", code: e.code } : undefined,`]),
    },
    M486: pushTo(`{ state: "open", by: e.by || "anonymous" }`),
    M488: openWith("tries", "number", "Math.min(Math.max(e.by.length, 10), 1)"),
    M489: pushTo(`{ state: "open", by: e.by.toLocaleUpperCase() }`),
    M490: na(NO_JOB),
    M491: na(NO_JOB),
    M492: na(NO_JOB),
    M493: na(NO_JOB),
    M494: na(NO_JOB),
    M495: { prepend: NAMES, ...pushTo(`{ state: "open", by: NAMES[e.by] ?? e.by }`) },
    M496: edit([S.push, `door.state === "closed" && e ? { state: "open", by: e.by } : undefined,`]),
    M497: pushTo('{ state: "open", by: `by ${e}` }'),
    M498: openWith("offset", "number", "-e.by"),
    M499: edit([
      PUSH,
      `push: (door, e: { by: "ann" | "bob" }): Door | undefined => {\n      if (door.state !== "closed") return undefined;\n      switch (e.by) {\n        case "ann":\n          return { state: "open", by: "ann" };\n        default:\n          return undefined;\n      }\n    },`,
    ]),

    // Persistence.
    M571: append(`actor.subscribe(() => {\n  localStorage.setItem("door", JSON.stringify(actor.getSnapshot()));\n});`),
    M573: na(NO_JOB),

    // Use sites.
    M575: append("export const loose = createStore<any, any>(doorStore);"),
    M576: edit([S.pushHead, `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment\n    ${S.pushHead}`]),
    M577: append(
      `import type { EventObject, EventPayloadMap, StoreContext } from "@xstate/store";\ndeclare module "@xstate/store" {\n  interface Store<TContext extends StoreContext, TEventPayloadMap extends EventPayloadMap, TEmitted extends EventObject> {\n    retryLater(context: TContext): void;\n  }\n}`,
    ),
    M578: append(
      `const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.getSnapshot().context.state as (typeof SHUT)[number]);`,
    ),
    M581: na(
      "a store's config is a plain object (createStoreConfig returns it as given): a spread copy is the same config",
    ),
    M582: append(`export const withInput = createStore(doorStore, { input: { by: "ann" } });`),
    M583: append(
      `export function rename(by: string): void {\n  const s = actor.getSnapshot();\n  if (s.context.state === "open") s.context.by = by;\n}`,
    ),
    M584: append(
      `actor.subscribe(async (s) => {\n  await Promise.resolve();\n  try {\n    localStorage.setItem("door", JSON.stringify(s));\n  } catch (e) {\n    console.error(e);\n  }\n});`,
    ),
    M585: na("a store has no stop: it is dropped, never stopped"),
    M586: na(NO_JOB),
    M587: append(
      `export function POST(req: Request): Response {\n  actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(actor.getSnapshot().context.state === "open" ? "ok" : "refused");\n}`,
    ),
    M588: na("a store has no toPromise: it never ends"),
    M589: na(NO_JOB),
    M591: append(`actor.transition(actor.getSnapshot(), { type: "push", by: "ann" });`),

    // React and app code: the cases' folder resolves neither a store binding nor React's types, so a
    // component reads the module's store.
    M593: append(
      `export function DoorView(): null {\n  if (actor.getSnapshot().context.state === "closed") actor.send({ type: "push", by: "ann" });\n  return null;\n}`,
    ),
    M601: append("export const buttonProps = { onClick: () => actor.send };"),
    M603: append(
      `export function Log(): null {\n  actor.subscribe((s) => console.info(s.context.state));\n  return null;\n}`,
    ),

    // Flows and modeling.
    M607: alsoOn(
      `setOpen: (door, e: { open: boolean }): Door | undefined =>\n      door.state === "closed" && e.open\n        ? { state: "open", by: "" }\n        : door.state === "open" && !e.open\n          ? { state: "closed" }\n          : undefined,`,
    ),

    // Migration habits.
    M612: na("getSnapshot is the store's"),
    M613: append(`export const named = createStore(doorStore, { id: "door", devTools: true });`),
    M614: na(NO_JOB),
    M615: na(NO_JOB),
  },
};
export default store;
