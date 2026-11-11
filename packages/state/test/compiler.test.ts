// The compiler: what it outputs for correct machines, and the problem it reports, at its place, for
// each way a machine can break a contract the type checker can't see. Each case changes one thing
// in a correct machine (./sources.ts). Each feature's cases are in ./features/<feature>/compiler.ts.
// The last tests hold the compiler to its job, both ways: no case here is a type error, and no type
// case (a mistakes.ts's) is a compiler problem, so the compiler never repeats what `bun check` says.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile, type CompileOptions, StateCompileError } from "@reactre/state/compiler";
import { Glob } from "bun";
import {
  type ArrowFunctionExpression,
  type CallExpression,
  type Function as FunctionNode,
  type Node,
  parseSync,
} from "oxc-parser";

import { checkRun } from "../compiler/run.ts";
import { isFunction, keyName, walk } from "../compiler/syntax.ts";
import { CANCELS } from "./features/children/compiler.ts";
import { featureCases } from "./features/compiler.ts";
import { HANDLE } from "./features/durable/compiler.ts";
import { cancels } from "./features/effects/compiler.ts";
import { made, steps } from "./features/logic/compiler.ts";
import { store } from "./features/persist/compiler.ts";
import { POOL } from "./features/spawn/compiler.ts";
import { NAMED } from "./features/validate/compiler.ts";
import { type Case, change, DOOR, EDITOR, FORM, JOB, PAGE, PLAYER, withUse } from "./sources.ts";

/** `base` with `line` put before the machine, as a module-level declaration. */
function declare(base: string, line: string): string {
  return change(base, "export const doorMachine", `${line}\nexport const doorMachine`);
}

/**
 * Where the cases are compiled: the folder the last test writes them to for `bun check`, so a
 * relative import (`../compiler/pure.ts`) names the same file for the compiler and the type checker.
 */
const AT = join(import.meta.dir, "out", "machine.ts");

/** The problems the compiler reports for `source` (in `file`), as "line:column message". */
function problems(source: string, options: CompileOptions = {}, file = AT): string[] {
  try {
    compile(file, source, options);
  } catch (e) {
    if (e instanceof StateCompileError) return e.problems.map((p) => `${p.line}:${p.column} ${p.message}`);
    throw e;
  }
  return [];
}

describe("output", () => {
  test("a machine becomes a table: no setup, types or to is left, and no tasks module", () => {
    const code = compile("door.ts", DOOR)?.code ?? "";
    expect(code).not.toMatch(/\bsetup\(|\btypes</);
    expect(code).not.toMatch(/\bto\(/);
    expect(code).not.toContain("@reactre/state/tasks");
    expect(code).toContain('import { createActor } from "@reactre/state";');
    // Each `to` is the snapshot it makes, with the machine's version.
    expect(code).toContain('"push": (__0, event) => ({ state: "open", data: { by: event.by }, version: 0 })');
    // A state without data shares one frozen empty object.
    expect(code).toContain('"close": () => ({ state: "closed", data: __reactreStateNone, version: 0 })');
    expect(code).toContain('import { __none as __reactreStateNone } from "@reactre/state";');
    expect(code).not.toContain("@reactre/state/dev");
  });

  test("keep compiles as to does: the snapshot it makes, with or without data", () => {
    // (A run that reads no data: keep's new text would otherwise be M477's mistake.)
    const job = change(
      keeps('({ event, keep }) => keep("saving", { text: event.text })'),
      'run: async ({ data }) => ({ type: "stored", id: data.text })',
      'run: async ({ signal }) => ({ type: "stored", id: await nextId(signal) })',
    );
    const code = compile("job.ts", job)?.code ?? "";
    expect(code).toContain('"save": (__0, event) => ({ state: "saving", data: { text: event.text }, version: 0 })');
    expect(code).not.toMatch(/\bkeep\(/);
    const empty = compile(
      "job.ts",
      change(JOB, "idle: { on: { save:", 'idle: { on: { retry: ({ keep }) => keep("idle"), save:'),
    );
    expect(empty?.code).toContain('"retry": () => ({ state: "idle", data: __reactreStateNone, version: 0 })');
  });

  test("a task or timer brings the tasks module's lean lifecycle, and durations become milliseconds", () => {
    const code = compile("job.ts", JOB)?.code ?? "";
    // Every ordinary delay is a literal within setTimeout's range, so the plain timer is exact and
    // the machine ships none of `__wait`'s split.
    expect(code).toContain('import { __leanQuick as __reactreStateLeanQuick } from "@reactre/state/tasks";');
    expect(code).not.toContain("__reactreStateLean ");
    expect(code).toContain("[1500, () => ({ state: ");
    expect(code).toContain("r: __reactreStateLeanQuick");
    expect(code).not.toContain("@reactre/state/run");
  });

  test("a delay past 2^31 − 1 ms keeps the split: the lean lifecycle over __wait", () => {
    // 600h = 2,160,000,000 ms, past the limit; the grammar has no unit longer than hours.
    const code = compile("job.ts", change(JOB, '"1.5s"', '"600h"'))?.code ?? "";
    expect(code).toContain('import { __lean as __reactreStateLean } from "@reactre/state/tasks";');
    expect(code).not.toContain("Quick");
    expect(code).toContain("[2160000000, () => ({ state: ");
    expect(code).toContain("r: __reactreStateLean");
  });

  test("the limit itself is short: 2147483647 ms keeps the plain timer", () => {
    const code = compile("job.ts", change(JOB, '"1.5s"', '"2147483647ms"'))?.code ?? "";
    expect(code).toContain("r: __reactreStateLeanQuick");
    expect(code).toContain("[2147483647, () => ({ state: ");
  });

  test("a general machine's task runner is the quick one when every ordinary delay is short", () => {
    // A named delay in `after` gives delays its own runner (`l`), so the lifecycle is general and
    // the task runner is `__tasks`; the ordinary timers are still all short.
    const source = change(
      change(
        change(JOB, "const job = setup({", "const job = setup({\n  use: [delays],\n  delays: { patience: 2000 },"),
        '"1.5s"',
        "patience",
      ),
      'import { createActor, setup, types } from "@reactre/state";',
      'import { createActor, setup, types } from "@reactre/state";\nimport { delays } from "@reactre/state/delays";',
    );
    const code = compile("job.ts", source)?.code ?? "";
    expect(code).toContain('import { __tasksQuick as __reactreStateTasksQuick } from "@reactre/state/tasks";');
    expect(code).toContain("r: __reactreStateRunNested([__reactreStateTasksQuick, delays.r])");
    expect(code).not.toContain("__reactreStateTasks ");
  });

  test("a feature in use keeps its import, and the table reads its hooks from it", () => {
    const code = compile("editor.ts", EDITOR)?.code ?? "";
    expect(code).toContain('import { nested } from "@reactre/state/nested";');
    expect(code).toContain('import { history } from "@reactre/state/history";');
    expect(code).not.toContain("use:");
    // A feature imported under another name is read under that name.
    const renamed = compile(
      "editor.ts",
      change(change(EDITOR, "import { nested }", "import { nested as tree }"), "use: [nested,", "use: [tree,"),
    )?.code;
    expect(renamed).toContain("g: __reactreStateFlatGraph, h:");
    expect(renamed).toContain("y: __reactreStateFlatNested");
  });

  test("persist in use gives a machine with tasks the general lifecycle, the saving runner and the marker", () => {
    const source = change(
      change(JOB, "const job = setup({", 'const job = setup({\n  use: [persist],\n  shape: "3020ooix",'),
      'import { createActor, setup, types } from "@reactre/state";',
      'import { createActor, setup, types } from "@reactre/state";\nimport { persist } from "@reactre/state/persist";',
    );
    const code = compile("job.ts", source)?.code ?? "";
    expect(code).toContain('u: { "persist": 1 }');
    expect(code).toContain("r: __reactreStateRun([persist.t])");
    expect(code).not.toContain("__reactreStateLean");
  });

  test("dev output freezes data; an exported shape is kept as a stub", () => {
    const dev = compile("door.ts", DOOR, { dev: true })?.code ?? "";
    expect(dev).toContain("d: __reactreStateFreeze");
    expect(dev).toContain('import { __freeze as __reactreStateFreeze } from "@reactre/state/dev";');
    const code = compile("door.ts", change(DOOR, "const door = setup", "export const door = setup"))?.code ?? "";
    expect(code).toContain("export const door = __reactreStateShape();");
    expect(code).toContain('import { __shape as __reactreStateShape } from "@reactre/state";');
  });

  test("contracts may use types from other files: the type checker reads them, not the compiler", () => {
    const source = change(
      change(DOOR, "open: types<{ by: string }>()", "open: types<{ by: Person }>()"),
      'import { createActor, setup, types } from "@reactre/state";',
      'import { createActor, setup, types } from "@reactre/state";\nimport type { Person } from "./person.ts";',
    );
    expect(compile("door.ts", source)?.code).toContain("doorMachine = /* @__PURE__ */");
  });

  test("parents and back bring the hierarchy: g, y, and h for the parents back goes to", () => {
    const code = compile("editor.ts", EDITOR)?.code ?? "";
    expect(code).toContain(
      '"resume": () => ({ b: "edit", t: ({ state: "edit.draft", data: { text: "" }, version: 0 }) })',
    );
    expect(code).toContain('"edit": { "leave": () => ({ state: "idle", data: __reactreStateNone, version: 0 }) }');
    // No parallel node: the flat graph and step, without the region code.
    expect(code).toContain('g: __reactreStateFlatGraph, h: { "edit": 1 }, y: __reactreStateFlatNested');
    expect(code).not.toContain("@reactre/state/run");
    // A flat machine ships none of it.
    expect(compile("door.ts", DOOR)?.code).not.toContain("@reactre/state/nested");
  });

  test("a parallel node: its regions in p, its done in n, and a step for each region", () => {
    const code = compile("player.ts", PLAYER)?.code ?? "";
    const on = (leaf: string) => `({ state: "${leaf}", data: __reactreStateNone, version: 0 })`;
    expect(code).toContain(
      `"power": () => ({ state: "on", data: { "a": ${on("on.a.x")}, "b": ${on("on.b.z")} }, version: 0 })`,
    );
    expect(code).toContain('p: { "on": ["a","b"] }');
    expect(code).toContain(`n: { "on": (data) => (data.a.state === "on.a.y" ? ${on("off")} : ${on("off")}) }`);
    expect(code).toContain("g: nested.g, p:");
  });

  test("children: setup's machine in m, their handlers in c, and the actors runner", () => {
    const code = compile("page.ts", PAGE)?.code ?? "";
    expect(code).toContain('import { children } from "@reactre/state/children";');
    expect(code).toContain("r: __reactreStateRun([children.r])");
    expect(code).toContain('c: { "busy": { "job": { m: childMachine, k: (__d, __s) => ((data) => data.files.map(');
    expect(code).toContain(
      '.map((__c) => [__c.key, __c.input]), d: (__0, output) => ({ state: "done", data: { url: output.data.url }, version: 0 })',
    );
    expect(code).toContain('u: (data, child) => ({ state: "busy", data: { ...data, seen: child.state }, version: 0 })');
    expect(code).not.toContain("@reactre/state/tasks");
  });

  test("schemas stay as written, in a constant, with the validation module", () => {
    const code = compile("form.ts", FORM)?.code ?? "";
    expect(code).toContain(
      'const __reactreStateSchemas_form = { e: { "rename": object({ name: string() }) }, i: object({ name: string() }), d: { "editing": object({ name: string() }) } };',
    );
    expect(code).toContain('import { validate } from "@reactre/state/validate";');
    expect(code).toContain("i: validate.i(__reactreStateSchemas_form.i, (input) => ({ state: ");
    expect(code).toContain("s: __reactreStateSchemas_form, x: validate.x, z: validate.z, y: validate.v()");
    // With a hierarchy, validation wraps the hierarchy's step.
    const nested = compile(
      "editor.ts",
      change(
        change(
          change(EDITOR, "use: [nested, history]", "use: [nested, history, validate]"),
          'import { nested } from "@reactre/state/nested";',
          'import { nested } from "@reactre/state/nested";\nimport { validate } from "@reactre/state/validate";',
        ),
        "states: { idle: types<{}>(),",
        'states: { idle: { "~standard": { version: 1, vendor: "x", validate: (value: unknown) => ({ value }) } },',
      ),
    )?.code;
    expect(nested).toContain("y: validate.v(__reactreStateFlatNested)");
  });

  test("schemas of events alone check events, not start; an exported shape keeps them beside its stub", () => {
    const events = change(
      change(FORM, "  input: object({ name: string() }),\n", ""),
      "states: { editing: object({ name: string() }), done: types<{}>() }",
      "states: { editing: types<{ name: string }>(), done: types<{}>() }",
    );
    const code = compile(
      "form.ts",
      change(events, 'to("editing", { name: input.name })', 'to("editing", { name: "" })'),
    )?.code;
    expect(code).toContain('i: (input) => ({ state: "editing", data: { name: "" }, version: 0 }), o:');
    const exported = compile("form.ts", change(FORM, "const form = setup", "export const form = setup"))?.code ?? "";
    expect(exported).toContain("const __reactreStateSchemas_form = {");
    expect(exported).toContain("export const form = __reactreStateShape();");
  });

  test("meta written in place, of arrays, negative numbers and plain templates, is kept as written", () => {
    const meta = "meta: { order: [1, 2], n: -1, label: `open` }";
    const code = compile("door.ts", change(withUse(["tags"], DOOR), "open: { on:", `open: { ${meta}, on:`))?.code;
    expect(code).toContain('"open": [[], { order: [1, 2], n: -1, label: `open` }]');
  });

  test("files without a machine, or that don't parse, are left to the next step", () => {
    expect(compile("a.ts", "export const a = 1;")).toBeNull();
    expect(compile("a.ts", 'import { createActor } from "@reactre/state";')).toBeNull();
    expect(compile("a.ts", 'import { setup } from "@reactre/state"; const = ;')).toBeNull();
  });

  test("every problem in a file is reported at once, with its line and a caret", () => {
    const source = change(
      change(DOOR, "{ code: event.code }", "{ code: String(Date.now()) }"),
      "{ by: event.by }",
      "{ by: event.by as string }",
    );
    try {
      compile("machine.ts", source);
      throw new Error("no error");
    } catch (e) {
      if (!(e instanceof StateCompileError)) throw e;
      expect(e.problems.map((p) => `${p.line}:${p.column}`)).toEqual(["18:51", "19:62"]);
      expect(e.message).toMatch(/machine\.ts:19:62: Date reads the clock[^\n]*\n.*Date\.now.*\n {63}\^/);
    }
  });
});

/** JOB whose `saving` also takes `save` with `keep`: a stay that leaves its task and timer running. */
const STORED = 'on: { stored: ({ event, to }) => to("saved", { id: event.id }) },';
const keeps = (save: string): string =>
  change(JOB, STORED, `on: { stored: ({ event, to }) => to("saved", { id: event.id }), save: ${save} },`);

const keys: Case[] = [
  [
    "keep's data built elsewhere",
    change(
      keeps('({ event, keep }) => keep("saving", withText(event.text))'),
      "export const jobMachine",
      "const withText = (text: string) => ({ text });\nexport const jobMachine",
    ),
    19,
    'write state "saving"\'s data as an object literal, or pass data',
  ],
  [
    "data built elsewhere, which can carry keys its type doesn't list",
    declare(
      change(DOOR, 'to("open", { by: event.by })', 'to("open", withBy(event.by))'),
      "const withBy = (by: string) => ({ by });",
    ),
    19,
    'write state "open"\'s data as an object literal, or pass data',
  ],
  [
    "another object spread in",
    declare(change(DOOR, 'to("open", { by: event.by })', 'to("open", { ...base, by: event.by })'), "const base = {};"),
    19,
    "spread only data",
  ],
  [
    "a local object passed on before it is data, which can gain keys there",
    declare(
      change(
        DOOR,
        '({ event, to }) => to("open", { by: event.by })',
        '({ event, to }) => {\n          const next = { by: event.by };\n          Object.assign(next, EXTRA);\n          return to("open", next);\n        }',
      ),
      "const EXTRA = { at: 1 };",
    ),
    22,
    'write state "open"\'s data as an object literal, or pass data',
  ],
  [
    "a module-level object as data, shared by every actor",
    declare(change(DOOR, 'to("open", { by: event.by })', 'to("open", ANN)'), 'const ANN = { by: "ann" };'),
    19,
    'ANN is a module-level object: as state "open"\'s data it is the same object in every actor that holds it',
  ],
];

const pure: Case[] = [
  ["the clock", change(DOOR, "{ code: event.code }", "{ code: String(Date.now()) }"), 19, "Date reads the clock"],
  [
    "randomness",
    change(DOOR, "{ code: event.code }", "{ code: String(Math.random()) }"),
    19,
    "Math.random makes a transition give different results",
  ],
  [
    "a module-level let",
    declare(change(DOOR, "{ code: event.code }", "{ code: secret }"), 'let secret = "1";'),
    20,
    "module-level let secret",
  ],
  [
    "writing a module object",
    declare(
      change(DOOR, '({ to }) => to("closed") } }', '({ to }) => ((closes.n += 1), to("closed")) } }'),
      "const closes = { n: 0 };",
    ),
    23,
    "doesn't change closes outside it",
  ],
  [
    "a mutating method on a module array",
    declare(
      change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (log.push("closed"), to("closed")) } }'),
      "const log: string[] = [];",
    ),
    23,
    "push changes log, outside the transition",
  ],
  [
    "delete on module state",
    declare(
      change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (delete cache.last, to("closed")) } }'),
      "const cache: { last?: string } = {};",
    ),
    23,
    "delete changes cache, outside the transition",
  ],
  [
    "new",
    change(DOOR, "{ code: event.code }", "{ code: new String(1).valueOf() }"),
    19,
    "doesn't construct objects with new",
  ],
  ["import.meta", change(DOOR, "{ code: event.code }", "{ code: import.meta.url }"), 19, "doesn't read the module"],
  [
    "a cast",
    change(DOOR, "{ by: event.by }", "{ by: event.by as string }"),
    18,
    "a cast in a transition hides a broken contract",
  ],
  ["a non-null assertion", change(DOOR, "{ by: event.by }", "{ by: event.by! }"), 18, "a non-null assertion (!)"],
  [
    "a global",
    change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (console.log(1), to("closed")) } }'),
    22,
    "console is a global a transition may not read",
  ],
  [
    "to handed on",
    change(DOOR, '({ to }) => to("closed") } }', '({ to }) => { const go = to; return go("closed"); } } }'),
    22,
    "call to(...) directly",
  ],
  [
    "a @ts- suppression",
    change(DOOR, "export const doorMachine", "// @ts-ignore\nexport const doorMachine"),
    13,
    "a @ts- suppression in a file with machines",
  ],
  [
    "an id made with crypto",
    change(DOOR, "{ code: event.code }", "{ code: crypto.randomUUID() }"),
    19,
    "crypto is a global a transition may not read",
  ],
  [
    "network",
    change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (fetch("/log"), to("closed")) } }'),
    22,
    "fetch is a global a transition may not read",
  ],
  [
    "a guard that fetches",
    change(DOOR, "(event.code === data.code ?", '(fetch("/check") !== null && event.code === data.code ?'),
    23,
    "fetch is a global a transition may not read",
  ],
  [
    "scheduling with setTimeout",
    change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (setTimeout(() => {}, 1), to("closed")) } }'),
    22,
    "setTimeout is a global a transition may not read",
  ],
  [
    "scheduling with setInterval",
    change(DOOR, '({ to }) => to("closed") } }', '({ to }) => (setInterval(() => {}, 1000), to("closed")) } }'),
    22,
    "setInterval is a global a transition may not read",
  ],
  [
    "storage",
    change(DOOR, "{ code: event.code }", '{ code: localStorage.getItem("code") ?? "" }'),
    19,
    "localStorage is a global a transition may not read",
  ],
  [
    "the environment",
    change(DOOR, "{ code: event.code }", '{ code: process.env.CODE ?? "" }'),
    19,
    "process is a global a transition may not read",
  ],
  [
    "network in entry, outside its effect",
    change(withUse(["effects"], DOOR), "open: { on:", 'open: { entry: () => { fetch("/opened"); }, on:'),
    24,
    "fetch is a global a transition may not read",
  ],
];

const structure: Case[] = [
  [
    "a handler that isn't destructured",
    change(DOOR, '({ to }) => to("closed") } }', '(args) => args.to("closed") } }'),
    22,
    "destructure the argument",
  ],
  [
    "a rest element",
    change(DOOR, '({ to }) => to("closed") } }', '({ to, ...rest }) => to("closed") } }'),
    22,
    "a rest element",
  ],
  [
    "a nested pattern",
    change(DOOR, '({ event, to }) => to("open", { by: event.by })', '({ event: { by }, to }) => to("open", { by })'),
    18,
    "bind event to a name",
  ],
  [
    "a shape used for something else",
    change(DOOR, "export const actor", "console.log(door);\nexport const actor"),
    27,
    "door is a shape: its only use is door.machine",
  ],
  [
    "setup not in a const",
    change(DOOR, "const door = setup", "let door = setup"),
    3,
    "setup(...) is the value of a module-level const",
  ],
  [
    "a computed timer key",
    change(
      change(JOB, '"1.5s":', "[LATE]:"),
      "export const jobMachine",
      'const LATE = "1.5s";\nexport const jobMachine',
    ),
    20,
    "after takes keys written as names",
  ],
];

/** setup's `use`: the compiler turns it into table fields, so it must see each feature's import. */
const use: Case[] = [
  [
    "a feature under another name than its import's",
    change(
      change(EDITOR, "use: [nested, history],", "use: [tree, history],"),
      "const editor = setup",
      "const tree = nested;\nconst editor = setup",
    ),
    7,
    "setup's use lists features by the names they are imported with",
  ],
];

/** `base` with `line` put after its first import. */
function imports(base: string, line: string): string {
  const end = base.indexOf("\n");
  return `${base.slice(0, end + 1)}${line}\n${base.slice(end + 1)}`;
}

const CLOSE = '({ to }) => to("closed") } }';

/**
 * A function a transition calls is held to its rules: one in this file, transitively; one imported,
 * only from a module marked pure; a module value's method, never. A migration step is a transition.
 */
const calls: Case[] = [
  [
    "M138: a function in this file that reads the clock",
    declare(
      change(DOOR, "{ code: event.code }", "{ code: stamp(event.code) }"),
      "function stamp(code: string): string {\n  return code + Date.now();\n}",
    ),
    14,
    "in stamp, which a transition calls: Date reads the clock",
  ],
  [
    "a function in this file reached through another",
    declare(
      change(DOOR, "{ code: event.code }", "{ code: outer(event.code) }"),
      "const inner = (code: string) => code + String(Math.random());\nconst outer = (code: string) => inner(code);",
    ),
    13,
    "in inner, which a transition calls: Math.random makes a transition give different results",
  ],
  [
    "functions in this file that call each other",
    declare(
      change(DOOR, "{ code: event.code }", "{ code: ping(1) }"),
      "function ping(n: number): string {\n  return n > 0 ? pong(n - 1) : String(Date.now());\n}\nfunction pong(n: number): string {\n  return ping(n);\n}",
    ),
    14,
    "in ping, which a transition calls: Date reads the clock",
  ],
  [
    "a function in this file given by name",
    declare(
      change(DOOR, "{ code: event.code }", '{ code: [event.code].map(stamp).join("") }'),
      "const stamp = (code: string) => code + Date.now();",
    ),
    13,
    "in stamp, which a transition calls: Date reads the clock",
  ],
  [
    "M137: an import from a module not marked pure",
    imports(
      change(DOOR, CLOSE, '({ to }) => (scheduleRetry("/closed"), to("closed")) } }'),
      'import { scheduleRetry } from "../compiler/effects.ts";',
    ),
    23,
    "scheduleRetry is imported from ../compiler/effects.ts, which isn't marked pure, so the compiler can't check what it does: if it only computes from its arguments, put \"use pure\"; as the first line of ../compiler/effects.ts",
  ],
  [
    "an import from a package not listed as pure",
    imports(
      change(DOOR, "{ code: event.code }", '{ code: join(event.code, "x") }'),
      'import { join } from "node:path";',
    ),
    20,
    'list it in the plugin\'s pure option: state({ pure: ["node:path"] })',
  ],
  [
    "an @reactre/state function that isn't pure",
    imports(
      change(DOOR, CLOSE, '({ to }) => (createSystem(), to("closed")) } }'),
      'import { createSystem } from "@reactre/state/system";',
    ),
    23,
    "createSystem isn't one of @reactre/state's pure functions",
  ],
  [
    "M136: a method of a module value",
    declare(
      change(DOOR, CLOSE, '({ to }) => (bus.send({ type: "closed" }), to("closed")) } }'),
      "const bus = { send: (event: { type: string }) => event };",
    ),
    23,
    "bus.send(...) calls a method of bus, a module value: a transition can't see what it does",
  ],
  [
    "a constant that isn't a function written in this file",
    declare(
      change(DOOR, "{ code: event.code }", "{ code: shout(event.code) }"),
      "const [shout] = [(text: string) => text.toUpperCase()] as const;",
    ),
    20,
    "shout isn't a function written in this file",
  ],
  [
    "M140: a migration step that reads the clock",
    change(
      change(
        change(withUse(["persist"], DOOR), '  shape: "kq4c4nj6",\n', '  version: 1,\n  shape: "c2k7czqp",\n'),
        "import { persist }",
        "import { migrations, persist }",
      ),
      "export const actor = createActor(doorMachine);",
      'export const actor = createActor(doorMachine);\nexport const migrate = migrations(doorMachine).from<0, { closed: {} }>(({ to }) => to("locked", { code: String(Date.now()) }));',
    ),
    32,
    "a migration step is a transition too: Date reads the clock",
  ],
  [
    "a module marked pure, one of whose functions reads the clock",
    '"use pure";\n\nexport function stamp(code: string): string {\n  return code + Date.now();\n}\n',
    4,
    'in stamp, in a module marked "use pure": Date reads the clock',
  ],
];

/** What else a transition can't do that types can't see. */
const transitions: Case[] = [
  [
    "M139: an array as a condition",
    change(DOOR, "(event.code === data.code ?", '(event.code !== "" && event.code.split("") ?'),
    23,
    "split(...) returns an array, and an array is always truthy: this condition always passes",
  ],
  [
    "an if on Object.keys",
    change(
      DOOR,
      '({ data, event, to }) => (event.code === data.code ? to("closed") : null)',
      '({ data, to }) => {\n        if (Object.keys(data)) return to("closed");\n        return null;\n      }',
    ),
    24,
    "keys(...) returns an array, and an array is always truthy",
  ],
  [
    "a negated array",
    change(DOOR, "(event.code === data.code ?", '(!event.code.split("") ?'),
    23,
    "split(...) returns an array, and an array is always truthy",
  ],
  [
    "M37: a module-level array as data",
    change(
      change(PAGE, 'to("busy", { files: ["a"], seen: "" })', 'to("busy", { files: NONE, seen: "" })'),
      "export const pageMachine",
      "const NONE: string[] = [];\nexport const pageMachine",
    ),
    23,
    "NONE is a module-level object: in data it is the same object in every actor that holds it",
  ],
  [
    "M157: a send from an effect",
    declare(
      change(
        withUse(["effects"], DOOR),
        'push: ({ event, to }) => to("open", { by: event.by })',
        'push: ({ event, enq, to }) => (enq(() => void other.send({ type: "x" })), to("open", { by: event.by }))',
      ),
      "const other = { send: (event: { type: string }) => event };",
    ),
    21,
    "other.send(...) in an effect sends from outside the step: record it instead, enq.sendTo(actor, event)",
  ],
  [
    "M158: an effect recorded before the handler may decline",
    change(
      withUse(["effects"], DOOR),
      '({ data, event, to }) => (event.code === data.code ? to("closed") : null)',
      '({ data, event, enq, to }) => {\n        enq.log("unlock?");\n        return event.code === data.code ? to("closed") : null;\n      }',
    ),
    26,
    "enq.log records an effect before the handler may return null: a declined step drops what it recorded",
  ],
  [
    "an effect recorded before the handler declines, in a sequence",
    change(
      withUse(["effects"], DOOR),
      "({ data, event, to }) => (event.code === data.code ?",
      '({ data, event, enq, to }) => (enq.log("unlock?"), event.code === data.code ?',
    ),
    25,
    "enq.log records an effect before the handler may return null",
  ],
];

/** nested: three steps under one parent, each with the same `cancel`. */
const WIZARD = `import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";

const wizard = setup({
  use: [nested],
  states: { idle: types<{}>(), "step.one": types<{}>(), "step.two": types<{}>(), "step.three": types<{}>() },
  events: { open: types<{}>(), next: types<{}>(), cancel: types<{}>() },
});

export const wizardMachine = wizard.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("step.one") } },
    "step.one": { on: { next: ({ to }) => to("step.two"), cancel: ({ to }) => to("idle") } },
    "step.two": { on: { next: ({ to }) => to("step.three"), cancel: ({ to }) => to("idle") } },
    "step.three": { on: { cancel: ({ to }) => to("idle") } },
  },
});
`;

/** An approval, correct: who approved is in the data of one state, `approved`. */
const APPROVAL = `import { setup, types } from "@reactre/state";

const approval = setup({
  states: {
    pending: types<{ id: string }>(),
    approved: types<{ id: string; by: "manager" | "director" }>(),
    paid: types<{ id: string }>(),
  },
  events: { manager: types<{}>(), director: types<{}>(), pay: types<{}>(), reject: types<{}>() },
});

export const approvalMachine = approval.machine({
  start: ({ to }) => to("pending", { id: "a" }),
  states: {
    pending: {
      on: {
        manager: ({ data, to }) => to("approved", { id: data.id, by: "manager" }),
        director: ({ data, to }) => to("approved", { id: data.id, by: "director" }),
      },
    },
    approved: {
      on: { pay: ({ data, to }) => to("paid", { id: data.id }), reject: ({ data, to }) => to("pending", { id: data.id }) },
    },
    paid: { final: true },
  },
});
`;

/** APPROVAL with who approved in two states' names: the first is on line 22. */
const APPROVALS = change(
  change(
    change(
      APPROVAL,
      'approved: types<{ id: string; by: "manager" | "director" }>(),',
      "approved_by_manager: types<{ id: string }>(),\n    approved_by_director: types<{ id: string }>(),",
    ),
    'manager: ({ data, to }) => to("approved", { id: data.id, by: "manager" }),\n        director: ({ data, to }) => to("approved", { id: data.id, by: "director" }),',
    'manager: ({ data, to }) => to("approved_by_manager", { id: data.id }),\n        director: ({ data, to }) => to("approved_by_director", { id: data.id }),',
  ),
  '    approved: {\n      on: { pay: ({ data, to }) => to("paid", { id: data.id }), reject: ({ data, to }) => to("pending", { id: data.id }) },\n    },',
  [
    "    approved_by_manager: {",
    '      on: { pay: ({ data, to }) => to("paid", { id: data.id }), reject: ({ data, to }) => to("pending", { id: data.id }) },',
    "    },",
    "    approved_by_director: {",
    "      // the same handlers, formatted otherwise",
    '      on: { pay: ({ data, to }) => to("paid", { id: data.id }),',
    '        reject: ({ data, to }) => to("pending", { id: data.id }) },',
    "    },",
  ].join("\n"),
);
const APPROVED_TWICE =
  '"approved_by_manager" and "approved_by_director" are the same state twice (same data, same handlers): make one state, "approved", with the difference in its data, { by: "manager" | "director" }';

/** An order whose speed and insurance are flags in its states' names (M324). */
const PROCESSING = `import { setup, types } from "@reactre/state";

const order = setup({
  states: {
    placed: types<{ id: string }>(),
    processing_priority_insured: types<{ id: string }>(),
    processing_standard_uninsured: types<{ id: string }>(),
    shipped_priority_insured: types<{ id: string }>(),
    shipped_standard_uninsured: types<{ id: string }>(),
  },
  events: { priority: types<{}>(), standard: types<{}>(), ship: types<{}>() },
});

export const orderMachine = order.machine({
  start: ({ to }) => to("placed", { id: "a" }),
  states: {
    placed: {
      on: {
        priority: ({ data, to }) => to("processing_priority_insured", { id: data.id }),
        standard: ({ data, to }) => to("processing_standard_uninsured", { id: data.id }),
      },
    },
    processing_priority_insured: { on: { ship: ({ data, to }) => to("shipped_priority_insured", { id: data.id }) } },
    processing_standard_uninsured: { on: { ship: ({ data, to }) => to("shipped_standard_uninsured", { id: data.id }) } },
    shipped_priority_insured: { final: true },
    shipped_standard_uninsured: { final: true },
  },
});
`;

/** Three approvals in camel case: the first is on line 14. */
const CAMEL = `import { setup, types } from "@reactre/state";

const approval = setup({
  states: { pending: types<{}>(), approvedByManager: types<{}>(), approvedByOwner: types<{}>(), approvedByDirector: types<{}>() },
  events: { manager: types<{}>(), owner: types<{}>(), director: types<{}>(), reject: types<{}>() },
});

export const approvalMachine = approval.machine({
  start: ({ to }) => to("pending"),
  states: {
    pending: {
      on: { manager: ({ to }) => to("approvedByManager"), owner: ({ to }) => to("approvedByOwner"), director: ({ to }) => to("approvedByDirector") },
    },
    approvedByManager: { on: { reject: ({ to }) => to("pending") } },
    approvedByOwner: { on: { reject: ({ to }) => to("pending") } },
    approvedByDirector: { on: { reject: ({ to }) => to("pending") } },
  },
});
`;

/** Nested: two fetches under a parent, each named by two flags. */
const FETCHES = `import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";

const loader = setup({
  use: [nested],
  states: { idle: types<{}>(), "load.fetch-users-fast": types<{}>(), "load.fetch-posts-slow": types<{}>() },
  events: { users: types<{}>(), posts: types<{}>(), stop: types<{}>() },
});

export const loaderMachine = loader.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { users: ({ to }) => to("load.fetch-users-fast"), posts: ({ to }) => to("load.fetch-posts-slow") } },
    "load.fetch-users-fast": { on: { stop: ({ to }) => to("idle") } },
    "load.fetch-posts-slow": { on: { stop: ({ to }) => to("idle") } },
  },
});
`;

/**
 * The duplication lints: what every leaf under a parent does the same way, the parent does; and
 * a state written twice, its difference in its names, is one state with the difference in its data.
 */
const duplicates: Case[] = [
  [
    "M326: the same handler on every leaf under a parent",
    WIZARD,
    14,
    'every state under "step" handles cancel the same way: write it once, on the parent, "step": { on: { cancel: ... } }, and remove it from its 3 states',
  ],
  ["M325: two states that differ only by who approved", APPROVALS, 22, APPROVED_TWICE],
  [
    "M324: flags as states, their targets named by the same flags",
    PROCESSING,
    23,
    '"processing_priority_insured" and "processing_standard_uninsured" are the same state twice (same data, same handlers): make one state, "processing", with the difference in its data, { kind: "priority" | "standard", insured: boolean }',
  ],
  [
    "three states alike, in camel case",
    CAMEL,
    14,
    '"approvedByManager", "approvedByOwner" and "approvedByDirector" are the same state 3 times (same data, same handlers): make one state, "approved", with the difference in its data, { by: "manager" | "owner" | "director" }',
  ],
  [
    "two states alike under a parent, by two flags",
    FETCHES,
    14,
    '"load.fetch-users-fast" and "load.fetch-posts-slow" are the same state twice (same data, same handlers): make one state, "load.fetch", with the difference in its data, { kind: "users" | "posts", kind2: "fast" | "slow" }',
  ],
  [
    "a comment that isn't the codemod's note on them",
    change(APPROVALS, "    approved_by_manager: {", "    // TODO: merge these\n    approved_by_manager: {"),
    23,
    APPROVED_TWICE,
  ],
];

/** DOOR, persisted, with its shape's hash on line 6. */
const PERSISTED = withUse(["persist"], DOOR);
const HASH = '  shape: "kq4c4nj6",\n';

const shapes: Case[] = [
  [
    "M260: a persisted machine without its shape's hash",
    change(PERSISTED, HASH, ""),
    4,
    'door is persisted, so its shape is checked: add shape: "kq4c4nj6" to setup (the build computes it; it changes when the states, events or version change)',
  ],
  [
    "M260: an event's payload changed, the version and the hash kept",
    change(PERSISTED, "close: types<{}>()", "close: types<{ reason: string | null }>()"),
    6,
    'the shape of door no longer matches its hash, so snapshots saved before may not fit it: if you changed its states, events or input, set version: 1, add a migration from 0 (migrations(machine).from<0, { ...its states before }>(...)), and set shape: "lffr8nfp"; if you already set the version for this change, set shape: "8id091tu"',
  ],
  [
    "the version bumped, the hash kept",
    change(PERSISTED, HASH, `  version: 1,\n${HASH}`),
    7,
    'set shape: "c2k7czqp", the hash of door\'s contracts at version 1',
  ],
  [
    "the hash in a constant",
    change(change(PERSISTED, HASH, "  shape: SHAPE,\n"), "const door", 'const SHAPE = "kq4c4nj6";\nconst door'),
    7,
    'shape is the hash written in place, a string: shape: "kq4c4nj6"',
  ],
  [
    "a machine not persisted may keep a hash, and it is checked too",
    change(DOOR, "const door = setup({\n", 'const door = setup({\n  shape: "00000000",\n'),
    4,
    "the shape of door no longer matches its hash",
  ],
];

const RUN = 'run: async ({ data }) => ({ type: "stored", id: data.text }),';
/** JOB with its task's `run` replaced: `body` is the function, written over lines from line 15. */
const withRun = (body: string): string => change(JOB, RUN, `run: ${body},`);
/** A run's response, fetched, and its body read: what comes between is the look at its status. */
const FETCHED = "  const res = await fetch(data.text, { signal });\n";
const READ = '  return { type: "stored", id: await res.text() };\n}';

/** A task's `run` ends with its state, and its failures reach `error`. */
const run: Case[] = [
  [
    "M73: a fetch not given the signal",
    withRun(
      'async ({ data }) => {\n          await fetch(data.text);\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "fetch without the signal keeps going after the state exits: pass run's signal, fetch(url, { signal }) (take it: run: async ({ data, signal }) => ...)",
  ],
  [
    "a fetch given options without the signal",
    withRun(
      'async ({ data, signal }) => {\n          await fetch(data.text, { method: "POST" });\n          return { type: "stored", id: String(signal.aborted) };\n        }',
    ),
    16,
    "fetch without the signal keeps going after the state exits: pass run's signal, fetch(url, { signal })",
  ],
  [
    "M74: an AbortController of its own, for a timeout",
    withRun(
      'async ({ data }) => {\n          const c = new AbortController();\n          setTimeout(() => c.abort(), 5000);\n          await fetch(data.text, { signal: c.signal });\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    'run already gets a signal, aborted when the state exits: use it (take it: run: async ({ data, signal }) => ...). A timeout is after on the state: after: { "5s"',
  ],
  [
    "M76: a catch that resolves to an event",
    withRun(
      'async ({ data, signal }) => {\n          try {\n            await fetch(data.text, { signal });\n            return { type: "stored", id: data.text };\n          } catch {\n            return { type: "stored", id: "" };\n          }\n        }',
    ),
    20,
    "a catch in run that resolves to an event turns a failure into a success: the task's error never runs",
  ],
  [
    "a .catch that resolves to an event",
    withRun(
      '({ data, signal }) =>\n          fetch(data.text, { signal })\n            .then(() => ({ type: "stored" as const, id: data.text }))\n            .catch(() => ({ type: "stored" as const, id: "" }))',
    ),
    18,
    "a .catch in run that resolves to an event turns a failure into a success",
  ],
  [
    "M79: a cast in the event run resolves to",
    withRun(
      'async ({ data, signal }) => {\n          const res = await fetch(data.text, { signal });\n          return { type: "stored", id: (await res.json()) as string };\n        }',
    ),
    17,
    "a cast in the event run resolves to takes outside data on trust: check the value",
  ],
  [
    "a non-null assertion in the event run resolves to",
    withRun('async ({ data }) => ({ type: "stored", id: data.text.split(",")[0]! })'),
    15,
    "a non-null assertion (!) in the event run resolves to takes outside data on trust",
  ],
  [
    "M81: forEach(async",
    withRun(
      'async ({ data, signal }) => {\n          data.text.split(",").forEach(async (url) => {\n            await fetch(url, { signal });\n          });\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "forEach doesn't wait for an async callback: run resolves before the work ends, and its errors are lost",
  ],
  [
    "M82: a throw of a string",
    withRun(
      'async ({ data }) => {\n          if (data.text === "") throw "empty";\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "throw an Error, not a plain value",
  ],
  [
    "M83: a socket that is never closed",
    withRun(
      '({ data }) =>\n          new Promise<{ readonly type: "stored"; readonly id: string }>((resolve) => {\n            const socket = new WebSocket(data.text);\n            socket.onmessage = () => resolve({ type: "stored", id: data.text });\n          })',
    ),
    17,
    'new WebSocket in run stays open after the state exits: close it when the signal aborts, signal.addEventListener("abort", () => socket.close())',
  ],
  [
    "a listener that is never removed",
    withRun(
      '({ data }) =>\n          new Promise<{ readonly type: "stored"; readonly id: string }>((resolve) => {\n            window.addEventListener("online", () => resolve({ type: "stored", id: data.text }));\n          })',
    ),
    17,
    "window.addEventListener in run keeps listening after the state exits: pass the signal",
  ],
  [
    "M84: a setInterval with no cleanup",
    withRun(
      'async ({ data }) => {\n          setInterval(() => void fetch(data.text), 1000);\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "setInterval in run keeps going after the state exits: clear it when the signal aborts",
  ],
  [
    "M85: a hook in run",
    change(
      withRun('async ({ data }) => ({ type: "stored", id: useStore(data.text) })'),
      "export const jobMachine",
      "const useStore = (key: string) => key;\nexport const jobMachine",
    ),
    16,
    "useStore is a hook: it runs only in a component's render",
  ],
  [
    "M77: a response's body read without checking its status",
    withRun(
      'async ({ data, signal }) => {\n          const res = await fetch(data.text, { signal });\n          return { type: "stored", id: await res.text() };\n        }',
    ),
    17,
    "a response read without checking its status takes a 404 or 500 page as a success: check res.ok first, if (!res.ok) throw new Error(`HTTP ${res.status}`), and let the task's error decide",
  ],
  [
    "M77: a body read on a nameless response",
    withRun('async ({ data, signal }) => ({ type: "stored", id: await (await fetch(data.text, { signal })).text() })'),
    15,
    "a response read without checking its status takes a 404 or 500 page as a success: name it and check it first, const res = await fetch(url, { signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`), and let the task's error decide",
  ],
  [
    "a body read in fetch's then",
    withRun(
      'async ({ data, signal }) => {\n          const id = await fetch(data.text, { signal }).then((r) => r.text());\n          return { type: "stored", id };\n        }',
    ),
    16,
    "check r.ok first, if (!r.ok) throw new Error(`HTTP ${r.status}`)",
  ],
  [
    "the status checked after the body is read",
    withRun(
      'async ({ data, signal }) => {\n          let res = await fetch(data.text, { signal });\n          res = await fetch(`${data.text}?again`, { signal });\n          const id = await res.text();\n          if (!res.ok) throw new Error(id);\n          return { type: "stored", id };\n        }',
    ),
    18,
    "check res.ok first",
  ],
  [
    "M77: the status only printed, not checked",
    // `console.info(res.status)` reads the status but has no failure path: a 404 page is still the
    // task's result. A look must be able to stop the read.
    withRun(
      'async ({ data, signal }) => {\n          const res = await fetch(data.text, { signal });\n          console.info(res.status);\n          return { type: "stored", id: await res.text() };\n        }',
    ),
    18,
    "check res.ok first",
  ],
  [
    "M77: the status checked in a callback that runs later",
    // The check is inside `forEach`'s callback, which runs after the read (or not at all), so it
    // can't gate it.
    withRun(
      'async ({ data, signal }) => {\n          const res = await fetch(data.text, { signal });\n          [1].forEach(() => { if (!res.ok) throw new Error("x"); });\n          return { type: "stored", id: await res.text() };\n        }',
    ),
    18,
    "check res.ok first",
  ],
  [
    "a response passed to a function that doesn't look at its status",
    imports(
      withRun(
        'async ({ data, signal }) => {\n          const res = await fetch(data.text, { signal });\n          passThrough(res);\n          return { type: "stored", id: await res.text() };\n        }',
      ),
      'import { passThrough } from "../compiler/http.ts";',
    ),
    19,
    "check res.ok first",
  ],
  [
    "M75: a timeout option to fetch",
    withRun(
      'async ({ data, signal }) => {\n          await fetch(data.text, { signal, timeout: 5000 });\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    'fetch has no timeout option: a browser ignores it, and Bun\'s is the socket\'s idle timer, not a deadline. The task\'s timeout is after on its state: after: { "5s": ({ to }) => to("failed", { ... }) }. For the request alone: fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })',
  ],
  [
    "M80: a promise in run not awaited",
    change(
      withRun(
        'async ({ data }) => {\n          save(data.text);\n          return { type: "stored", id: data.text };\n        }',
      ),
      "export const jobMachine",
      "let save: (text: string) => Promise<string> = async (text) => text;\nexport const jobMachine",
    ),
    17,
    "save(...) returns a promise run doesn't wait for: run resolves before it settles, and its failure never reaches error. Await it: await save(...)",
  ],
  [
    "a fetch in run not awaited",
    withRun(
      'async ({ data, signal }) => {\n          fetch(data.text, { signal });\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "fetch(...) returns a promise run doesn't wait for",
  ],
  [
    "an async function of the file, not awaited",
    change(
      withRun(
        'async ({ data }) => {\n          store(data.text);\n          return { type: "stored", id: data.text };\n        }',
      ),
      "export const jobMachine",
      "async function store(text: string): Promise<string> {\n  return text;\n}\nexport const jobMachine",
    ),
    19,
    "store(...) returns a promise run doesn't wait for",
  ],
  [
    "a function of the file typed to return a promise, not awaited",
    change(
      withRun(
        'async ({ data }) => {\n          store(data.text);\n          return { type: "stored", id: data.text };\n        }',
      ),
      "export const jobMachine",
      "const store = (text: string): Promise<string> => Promise.resolve(text);\nexport const jobMachine",
    ),
    17,
    "store(...) returns a promise run doesn't wait for",
  ],
  [
    "run's own async function, not awaited",
    withRun(
      'async ({ data }) => {\n          const write = async () => data.text;\n          write();\n          return { type: "stored", id: data.text };\n        }',
    ),
    17,
    "write(...) returns a promise run doesn't wait for",
  ],
  [
    "an imported async function, not awaited",
    imports(
      withRun(
        'async ({ data }) => {\n          store(data.text);\n          return { type: "stored", id: data.text };\n        }',
      ),
      'import { store } from "../compiler/store.ts";',
    ),
    17,
    "store(...) returns a promise run doesn't wait for",
  ],
  [
    "a .then chain in run not awaited",
    withRun(
      'async ({ data, signal }) => {\n          fetch(data.text, { signal }).then((res) => res.ok);\n          return { type: "stored", id: data.text };\n        }',
    ),
    16,
    "this .then(...) chain is a promise run doesn't wait for: run resolves before it settles, and its failure never reaches error. Await it (await ...then(...)), or return it",
  ],
  // compiler/run.ts's rules from the second round (M438–M473, M566): `task` writes run's lines
  // from line 15, `taskBeside` puts a module-level declaration before the machine first.
  [
    "M438: a sleep (setTimeout) in run",
    task(
      "async ({ data }) => {",
      "await new Promise((resolve) => setTimeout(resolve, 5));",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    'setTimeout in run outlives a cancel: wait with after on a state, after: { "5s": ({ to }) => to(...) } (or clear it on the signal\'s abort, signal.addEventListener("abort", () => clearTimeout(id)) (take it',
  ],
  [
    "M439: AbortSignal.timeout given to fetch instead of run's signal",
    task(
      "async ({ data }) => {",
      "await fetch(data.text, { signal: AbortSignal.timeout(5000) });",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "fetch's signal isn't run's, so the request goes on after the state exits: pass signal (or AbortSignal.any([signal, AbortSignal.timeout(5000)])) (take it",
  ],
  [
    "a signal in a const that isn't made from run's",
    task(
      "async ({ data, signal }) => {",
      "const deadline = AbortSignal.timeout(5000);",
      "await fetch(data.text, { signal: deadline });",
      'return { type: "stored", id: String(signal.aborted) };',
      "}",
    ),
    17,
    "fetch's signal isn't run's, so the request goes on after the state exits: pass signal (or AbortSignal.any([signal, AbortSignal.timeout(5000)]))",
  ],
  [
    "M440: fetch's options in a const, without the signal",
    task(
      "async ({ data, signal }) => {",
      'const init = { method: "POST" };',
      "await fetch(data.text, init);",
      'return { type: "stored", id: String(signal.aborted) };',
      "}",
    ),
    17,
    "the fetch's options don't hold run's signal, so the request goes on after the state exits: write { ...init, signal }",
  ],
  [
    "M441: a function of the file that fetches, called without the signal",
    taskBeside(
      'async function post(text: string): Promise<string> {\n  const res = await fetch(text, { method: "POST" });\n  return res.ok ? res.text() : "";\n}',
      'async ({ data }) => ({ type: "stored", id: await post(data.text) })',
    ),
    19,
    "post fetches without run's signal, so its request goes on after the state exits: pass signal to it, and to its fetch (take it",
  ],
  [
    "M442: a client package's request without the signal",
    taskBeside(
      "declare const axios: { post(url: string, body: unknown, config?: { signal?: AbortSignal }): Promise<{ data: string }> };",
      'async ({ data }) => ({ type: "stored", id: (await axios.post("/api/save", data.text)).data })',
    ),
    16,
    "axios.post without run's signal keeps going after the state exits: pass it in its options, { signal } (take it",
  ],
  [
    'M443: mode: "no-cors" on the fetch',
    task(
      "async ({ data, signal }) => {",
      'await fetch(data.text, { signal, mode: "no-cors" });',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    'mode: "no-cors" gives an opaque response: no status, no headers, no body, so the task can\'t tell a failure. Leave it out, and let the server allow the origin (CORS)',
  ],
  [
    "M444: the response's body read twice",
    task(
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      'if (!res.ok) throw new Error("HTTP");',
      "console.info(await res.text());",
      'return { type: "stored", id: await res.text() };',
      "}",
    ),
    19,
    "the response's body is read twice, and the second read rejects: read it once into a const, const body = await res.text(), and use the const",
  ],
  [
    "M445: an Idempotency-Key made in run",
    task(
      "async ({ data, signal }) => {",
      'const res = await fetch(data.text, { signal, headers: { "Idempotency-Key": crypto.randomUUID() } });',
      'if (!res.ok) throw new Error("HTTP");',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "the Idempotency-Key is new on each run, so a retry is a new write: make the key where the job is made, put it in the state's data, and read it from data",
  ],
  [
    "an Idempotency-Key set on Headers in run",
    task(
      "async ({ data, signal }) => {",
      "const headers = new Headers();",
      'headers.set("Idempotency-Key", String(Date.now()));',
      "await fetch(data.text, { signal, headers });",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    17,
    "the Idempotency-Key is new on each run",
  ],
  [
    "M446: a retry loop in run",
    task(
      "async ({ data, signal }) => {",
      "for (let attempt = 0; ; attempt++) {",
      "try {",
      "const res = await fetch(data.text, { signal });",
      'if (res.ok) return { type: "stored", id: await res.text() };',
      "} catch (e) {",
      "if (attempt === 2) throw e;",
      "}",
      "}",
      "}",
    ),
    16,
    "a retry loop in run: the attempts are hidden from the machine, lost on a restore, and a cancel waits out the backoff. Retries are states: a failed state, after on it, and the attempt in its data",
  ],
  [
    "M447: an async Promise executor",
    task(
      "({ data }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>(async (resolve) => {',
      'resolve({ type: "stored", id: data.text });',
      "})",
    ),
    16,
    "new Promise(async ...) drops a throw in its executor, and the task never ends: await the work in run itself, without the Promise",
  ],
  [
    "M448: filter(async ...)",
    task(
      "async ({ data }) => {",
      'const parts = data.text.split(",").filter(async (part) => part !== "");',
      'return { type: "stored", id: parts.join(",") };',
      "}",
    ),
    16,
    "filter's callback is async, so it returns a promise, which is always truthy: every item passes. Await the checks first, const ok = await Promise.all(xs.map(async (x) => ...)), then filter by them",
  ],
  [
    "M449: for await over an array of fetches",
    task(
      "async ({ data, signal }) => {",
      'const pending = data.text.split(",").map((url) => fetch(url, { signal }));',
      'for await (const res of pending) if (!res.ok) throw new Error("HTTP");',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    17,
    "for await over an array of promises starts them all at once, and one that rejects before its turn is unhandled: await Promise.all(...), then loop over the results",
  ],
  [
    "M450: allSettled's results never read",
    task(
      "async ({ data, signal }) => {",
      'await Promise.allSettled(data.text.split(",").map((url) => fetch(url, { signal })));',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "allSettled's results are unused, so a failure reads as success: read each result's status, and throw if one is \"rejected\" (or await Promise.all, which rejects)",
  ],
  [
    "allSettled's results kept, their status never read",
    task(
      "async ({ data, signal }) => {",
      'const results = await Promise.allSettled(data.text.split(",").map((url) => fetch(url, { signal })));',
      'return { type: "stored", id: String(results.length) };',
      "}",
    ),
    16,
    "allSettled's results are unused, so a failure reads as success",
  ],
  [
    "M451: Promise.reject with a string",
    task(
      "async ({ data }) => {",
      'if (data.text === "") await Promise.reject("empty");',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    'Promise.reject("empty") rejects with a plain value, not an Error: String(error) is "[object Object]" or the bare text, with no stack. Reject with an Error, Promise.reject(new Error("empty"))',
  ],
  [
    "an executor's reject given an object",
    task(
      "({ data }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>((resolve, reject) => {',
      'if (data.text === "") reject({ status: 400 });',
      'resolve({ type: "stored", id: data.text });',
      "})",
    ),
    17,
    'reject({ status: 400 }) rejects with an object, not an Error: String(error) is "[object Object]" or the bare text, with no stack. Reject with an Error, reject(new Error("..."))',
  ],
  [
    "M452: a throw of the status text",
    task(
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      "if (!res.ok) throw res.statusText;",
      'return { type: "stored", id: await res.text() };',
      "}",
    ),
    17,
    "a throw of a string drops the stack and the cause: throw new Error(res.statusText), with { cause: e } when it rethrows a caught e",
  ],
  [
    "a throw of the awaited body",
    task(
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      "if (!res.ok) throw await res.json();",
      'return { type: "stored", id: await res.text() };',
      "}",
    ),
    17,
    'a throw of an awaited value isn\'t an Error: it has no stack, and String(error) may be "[object Object]". Read it into a const, and throw new Error("...", { cause: body })',
  ],
  [
    "M453: a new Error that isn't thrown",
    task(
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      'if (!res.ok) new Error("HTTP");',
      'return { type: "stored", id: await res.text() };',
      "}",
    ),
    17,
    'new Error(…) without throw does nothing: throw it, throw new Error("HTTP")',
  ],
  [
    "M454: an empty catch",
    task(
      "async ({ data, signal }) => {",
      "try {",
      "await fetch(data.text, { signal });",
      "} catch {}",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    18,
    "an empty catch turns a failure into a success: let it throw, or say in a comment in it why the failure can be ignored",
  ],
  [
    "M455: catch (e: any)",
    task(
      "async ({ data, signal }) => {",
      "try {",
      "await fetch(data.text, { signal });",
      "} catch (e: any) {",
      "throw new Error(e.message);",
      "}",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    18,
    "catch (e: any) turns off the check that a caught value is unknown: leave the type out, and narrow it, e instanceof Error ? e.message : String(e)",
  ],
  [
    "M456: a .catch callback's untyped error, read",
    task(
      "async ({ data, signal }) => {",
      "await fetch(data.text, { signal }).catch((e) => {",
      "throw new Error(e.message);",
      "});",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "the .catch callback's e is any, so reading e.message is unchecked: write (e: unknown) and narrow it, e instanceof Error ? e.message : String(e)",
  ],
  [
    "M457: a rethrow that drops the caught error",
    task(
      "async ({ data, signal }) => {",
      "try {",
      "await fetch(data.text, { signal });",
      "} catch (e) {",
      'throw new Error("save failed");',
      "}",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    19,
    'the new Error drops the caught one, its stack and its cause: pass { cause: e }, new Error("...", { cause: e })',
  ],
  [
    "a rethrow from a catch that doesn't bind the error",
    task(
      "async ({ data, signal }) => {",
      "try {",
      "await fetch(data.text, { signal });",
      "} catch {",
      'throw new Error("save failed");',
      "}",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    19,
    "the new Error drops the caught one, its stack and its cause: catch (e), and pass { cause: e }",
  ],
  [
    "M458: a promise returned from try without await",
    taskBeside(
      'async function store(text: string): Promise<{ readonly type: "stored"; readonly id: string }> {\n  return { type: "stored", id: text };\n}',
      "async ({ data }) => {",
      "try {",
      "return store(data.text);",
      "} catch (e) {",
      'throw new Error("save failed", { cause: e });',
      "}",
      "}",
    ),
    20,
    "return store(…) in try isn't caught there: the promise is returned before it rejects, so the catch never runs. return await store(…)",
  ],
  [
    "M459: a return in finally",
    task(
      "async ({ data, signal }) => {",
      'let id = "";',
      "try {",
      "await fetch(data.text, { signal });",
      "id = data.text;",
      "} finally {",
      'return { type: "stored", id };',
      "}",
      "}",
    ),
    21,
    "a return in finally replaces the try's result or its error: move it after the try",
  ],
  [
    "M460: a throw in a callback run schedules",
    task(
      "async ({ data }) => {",
      "queueMicrotask(() => {",
      'if (data.text === "") throw new Error("empty");',
      "});",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    17,
    "a throw in a queueMicrotask callback doesn't reach run, so the task's error never runs: reject the promise run awaits, new Promise((resolve, reject) => ...), and reject(new Error(...)) there",
  ],
  [
    "a throw in an on* handler",
    task(
      "({ data, signal }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>((resolve) => {',
      "const socket = new WebSocket(data.text);",
      'signal.addEventListener("abort", () => socket.close());',
      "socket.onmessage = (message) => {",
      'if (typeof message.data !== "string") throw new Error("not text");',
      'resolve({ type: "stored", id: message.data });',
      "};",
      "})",
    ),
    20,
    "a throw in the socket.onmessage handler doesn't reach run",
  ],
  [
    "a throw in a listener",
    task(
      "({ data, signal }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>((resolve) => {',
      'window.addEventListener("message", (message) => {',
      'if (typeof message.data !== "string") throw new Error("not text");',
      'resolve({ type: "stored", id: message.data + data.text });',
      "}, { signal });",
      "})",
    ),
    18,
    "a throw in a listener doesn't reach run",
  ],
  [
    "M461: a stub that does nothing and reports success",
    withRun('async () => ({ type: "stored", id: "1" })'),
    15,
    "run does no work: it resolves to the same event every time, so the task reports a success it never earned",
  ],
  [
    "M461: a stub that takes its data and never reads it",
    change(
      withRun('async ({ data, signal }) => {\n  return { type: "stored" as const, id: `1`, tags: ["a"] };\n}'),
      "stored: types<{ id: string }>()",
      "stored: types<{ id: string; tags: readonly string[] }>()",
    ),
    15,
    "Do the work with what run is given, await fetch(url, { signal }) with the state's data",
  ],
  [
    "M462: a test-environment branch in run",
    task(
      "async ({ data }) => {",
      'if (process.env.NODE_ENV === "test") return { type: "stored", id: "test" };',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    'run checks NODE_ENV for "test": give the test a fake through provide or the module (useSave(fake)), not a branch that returns a canned success',
  ],
  [
    "M463: a live secret written in run",
    task(
      "async ({ data, signal }) => {",
      'const res = await fetch(data.text, { signal, headers: { Authorization: "Bearer sk_live_51HxQq2LzZ8vW1yTq" } });',
      'if (!res.ok) throw new Error("HTTP");',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "a secret key is written in run, so it ships in the bundle: read it on the server (a route that adds it to the request), never in the client's code",
  ],
  [
    "M464: run writes a module variable",
    taskBeside(
      'let lastSaved = "";',
      "async ({ data }) => {",
      "lastSaved = data.text;",
      'return { type: "stored", id: lastSaved };',
      "}",
    ),
    17,
    "run writes lastSaved, a module variable every actor shares: return the value in its event, and keep it in the next state's data",
  ],
  [
    "M465: a function whose type parameter is only its result's",
    taskBeside(
      'async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {\n  const res = await fetch(url, { signal });\n  if (!res.ok) throw new Error("HTTP");\n  return res.json();\n}',
      'async ({ data, signal }) => ({ type: "stored", id: (await getJson<{ id: string }>(data.text, signal)).id })',
    ),
    20,
    "getJson<T> casts its result to T: nothing checks it. Parse it with a schema (validate's, or a typeof test), and let the schema give the type",
  ],
  [
    "M466: {} cast to the event's type",
    task(
      "async ({ data }) => {",
      'const event = {} as { type: "stored"; id: string };',
      'event.type = "stored";',
      "event.id = data.text;",
      "return event;",
      "}",
    ),
    16,
    '{} as { type: "stored"; id: string } in run skips the check that every field is there: write the event as a literal, return { type: ..., ... }, with each field\'s value',
  ],
  [
    "M467: a date as local text in run's event",
    task('async ({ data }) => ({ type: "stored", id: `${data.text}@${new Date().toString()}` })'),
    15,
    "Date's toString is local, unparseable text: write new Date().toISOString(), which any clock reads back",
  ],
  [
    "M468: an id from the clock and Math.random",
    task(
      "async ({ data }) => ({",
      'type: "stored",',
      "id: String(Date.now()) + Math.random().toString(36).slice(2) + data.text,",
      "})",
    ),
    17,
    "an id from Date.now or Math.random can collide, and can be guessed: use the server's id (what the call returns), or crypto.randomUUID()",
  ],
  [
    "M469: success read as status === 200",
    task(
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      'if (res.status !== 200) throw new Error("HTTP");',
      'return { type: "stored", id: await res.text() };',
      "}",
    ),
    17,
    "res.status !== 200 fails a 201 or a 204, which are successes too: check res.ok (any 2xx)",
  ],
  [
    "M470: run sends to the actor",
    task(
      "async ({ data }) => {",
      'if (!actor.send({ type: "retry" }).ok) throw new Error("not sent");',
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "run sends to the actor: a task resolves to one event (return it), and the actor may have stopped. Send progress from a callback child",
  ],
  [
    "M471: an XMLHttpRequest never aborted",
    task(
      "({ data }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>((resolve, reject) => {',
      "const xhr = new XMLHttpRequest();",
      'xhr.open("POST", data.text);',
      'xhr.onload = () => resolve({ type: "stored", id: xhr.responseText });',
      'xhr.onerror = () => reject(new Error("save failed"));',
      "xhr.send(data.text);",
      "})",
    ),
    17,
    "the XMLHttpRequest isn't aborted on cancel: call xhr.abort() on the signal's abort, signal.addEventListener(\"abort\", () => xhr.abort()) (take it: run: async ({ data, signal }) => ...), or use fetch with the signal",
  ],
  [
    "M472: a server action called in run",
    taskBeside(
      'async function createPost(text: string): Promise<string> {\n  "use server";\n  return text;\n}',
      'async ({ data }) => ({ type: "stored", id: await createPost(data.text) })',
    ),
    19,
    'createPost is a server action, which takes no signal (and actions run one at a time): call a route with fetch and the signal, fetch(url, { method: "POST", body, signal }) (take it',
  ],
  [
    "M473: a media stream not stopped on cancel",
    task(
      "async ({ data }) => {",
      "const stream = await navigator.mediaDevices.getUserMedia({ audio: true });",
      "stream.getTracks().forEach((track) => track.stop());",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "getUserMedia's stream isn't stopped on cancel: stop its tracks on the signal's abort, signal.addEventListener(\"abort\", () => stream.getTracks().forEach((t) => t.stop())) (take it: run: async ({ data, signal }) => ...), or run it as a callback child",
  ],
  [
    "a wake lock not released on cancel",
    task(
      "async ({ data }) => {",
      'const lock = await navigator.wakeLock.request("screen");',
      "await lock.release();",
      'return { type: "stored", id: data.text };',
      "}",
    ),
    16,
    "wakeLock.request's lock isn't released on cancel: release it on the signal's abort",
  ],
  [
    "M566: a durable run started in run",
    imports(
      taskBeside(
        'const ship = setup({ use: [durable], shape: "c6qgoahc", states: { packing: types<{}>(), sent: types<{}>() }, events: { send: types<{}>() } });\nconst shipping = ship.machine({ start: ({ to }) => to("packing"), states: { packing: { on: { send: ({ to }) => to("sent") } }, sent: { final: true } } });',
        "async ({ data }) => {",
        "const shipped = durable(shipping, { now: Date.now, step: (_id, fn) => fn(), schedule: () => {}, cancel: () => {}, save: () => {} });",
        "await shipped.start();",
        'return { type: "stored", id: data.text };',
        "}",
      ),
      'import { durable } from "@reactre/state/durable";',
    ),
    19,
    "a durable run started in a task isn't stopped with it, nor journaled under this run: run it as a child, children: { shipping } in setup (use: [children]) and the state's children: { shipping: { done: ({ output, to }) => to(...) } }, so the host runs it inside this one",
  ],
];

/** JOB with its task's `run` written as `lines`, from line 15. */
function task(...lines: string[]): string {
  return withRun(lines.join("\n          "));
}

/** `task(...lines)` with `declaration` before the machine. */
function taskBeside(declaration: string, ...lines: string[]): string {
  return change(task(...lines), "export const jobMachine", `${declaration}\nexport const jobMachine`);
}

test("run's rules pass work that ends with the state and fails into error", () => {
  for (const body of [
    // A sleep that ends on the signal's abort.
    [
      "async ({ data, signal }) => {",
      "await new Promise<void>((resolve, reject) => {",
      "const id = setTimeout(resolve, 5);",
      'signal.addEventListener("abort", () => {',
      "clearTimeout(id);",
      'reject(new Error("aborted"));',
      "});",
      "});",
      'return { type: "stored", id: data.text };',
      "}",
    ],
    // Signals made from run's, options that hold it, one read of a checked body, on each branch.
    [
      "async ({ data, signal }) => {",
      "const both = AbortSignal.any([signal, AbortSignal.timeout(5000)]);",
      'const init = { method: "POST", signal };',
      "await fetch(data.text, init);",
      "const res = await fetch(data.text, { signal: both });",
      "if (!res.ok) throw new Error(await res.text());",
      'return { type: "stored", id: res.status === 201 ? await res.text() : String(await res.json()) };',
      "}",
    ],
    // Two responses under one name: each body read once.
    [
      "async ({ data, signal }) => {",
      "let res = await fetch(data.text, { signal });",
      'if (!res.ok) throw new Error("HTTP");',
      "const first = await res.text();",
      "res = await fetch(first, { signal });",
      'if (!res.ok) throw new Error("HTTP");',
      'return { type: "stored", id: await res.text() };',
      "}",
    ],
    // A look inside a `.then` callback is on the read's path: its result is the promise's.
    [
      "async ({ data, signal }) => {",
      "const id = await fetch(data.text, { signal })",
      ".then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))));",
      'return { type: "stored", id };',
      "}",
    ],
    // A non-200 success: `res.status === 201` decides, and the body is read on that branch.
    [
      "async ({ data, signal }) => {",
      "const res = await fetch(data.text, { signal });",
      'if (res.status === 201) return { type: "stored", id: await res.text() };',
      'if (!res.ok) throw new Error("HTTP");',
      'return { type: "stored", id: await res.text() };',
      "}",
    ],
    // Failures that keep their Error, a catch that says why it can be ignored, a check that throws.
    [
      "async ({ data, signal }) => {",
      "try {",
      "await fetch(`${data.text}/audit`, { signal });",
      "} catch {",
      "// The audit is best-effort: the save below is what counts.",
      "}",
      "const check = (id: string): string => {",
      'if (id === "") throw new Error("empty");',
      "return id;",
      "};",
      "try {",
      "const res = await fetch(data.text, { signal });",
      'if (!res.ok) throw new Error("HTTP " + String(res.status));',
      'return { type: "stored", id: check(await res.text()) };',
      "} catch (e) {",
      'throw new Error("save failed", { cause: e });',
      "}",
      "}",
    ],
    [
      "async ({ data, signal }) => {",
      "const id = await fetch(data.text, { signal })",
      ".then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))",
      ".catch((e: unknown) => {",
      "throw new Error(String(e), { cause: e });",
      "});",
      "let count = 0;",
      "count++;",
      'return { type: "stored", id: `${id}#${count}@${new Date().toISOString()}` };',
      "}",
    ],
    // Results whose status is read, a loop over items (not a retry), a returned await, a key from data.
    [
      "async ({ data, signal }) => {",
      'const results = await Promise.allSettled(data.text.split(",").map((url) => fetch(url, { signal })));',
      'if (results.some((r) => r.status === "rejected")) throw new Error("a save failed");',
      'for (const url of data.text.split(",")) {',
      "try {",
      'await fetch(url, { signal, headers: { "Idempotency-Key": `${data.text}:${url}` } });',
      "} catch (e) {",
      'throw new Error("a part failed", { cause: e });',
      "}",
      "}",
      'const parts = data.text.split(",").filter((part) => part !== "");',
      "const fields = {} as Record<string, string>;",
      "try {",
      'return await Promise.resolve({ type: "stored" as const, id: parts.join(",") + String(fields) });',
      "} finally {",
      'console.info("saved");',
      "}",
      "}",
    ],
    // Work released on the signal's abort: a request, a stream.
    [
      "({ data, signal }) =>",
      'new Promise<{ readonly type: "stored"; readonly id: string }>((resolve, reject) => {',
      "const xhr = new XMLHttpRequest();",
      'signal.addEventListener("abort", () => xhr.abort());',
      'xhr.open("POST", data.text);',
      'xhr.onload = () => resolve({ type: "stored", id: crypto.randomUUID() });',
      'xhr.onerror = () => reject(new Error("save failed"));',
      "xhr.send(data.text);",
      "})",
    ],
    [
      "async ({ data, signal }) => {",
      "const stream = await navigator.mediaDevices.getUserMedia({ audio: true });",
      "signal.onabort = () => stream.getTracks().forEach((track) => track.stop());",
      'return { type: "stored", id: data.text };',
      "}",
    ],
  ])
    expect(problems(task(...body))).toEqual([]);
});

/** The run of the first task in `source`, as checkRun takes it. */
function firstRun(source: string): ArrowFunctionExpression | FunctionNode {
  const { program } = parseSync(AT, source, { lang: "ts", sourceType: "module" });
  let found: ArrowFunctionExpression | FunctionNode | null = null;
  walk(program, (node) => {
    if (found === null && node.type === "Property" && keyName(node) === "run" && isFunction(node.value))
      found = node.value;
    return found === null;
  });
  if (found === null) throw new Error("no run");
  return found;
}

// The rules that read the file's imports, which checkRun gets as `at`: a client package's request
// by its import, a server action imported from a module marked "use server", and a durable run by
// its import (through any name).
test("M442, M472, M566: run's calls of what the file imports", () => {
  const source = `import { request } from "graphql-request";
import { durable as journaled } from "@reactre/state/durable";
import { createPost } from "../compiler/actions.ts";
import { label } from "../compiler/store.ts";

export const task = {
  run: async ({ data }: { data: { url: string; text: string } }) => {
    await request(data.url, "query { posts { id } }");
    await createPost(label(data.text));
    await journaled(shipping, host).start();
    return { type: "stored", id: data.text };
  },
};
`;
  const program = parseSync(AT, source, { lang: "ts", sourceType: "module" }).program;
  const found: string[] = [];
  const at = (node: Node | number): number =>
    source.slice(0, typeof node === "number" ? node : node.start).split("\n").length;
  checkRun(
    firstRun(source),
    null,
    (node, message) => found.push(`${at(node)}: ${message.slice(0, 50)}`),
    (node) => source.slice(node.start, node.end),
    () => null,
    () => false,
    { file: AT, program },
  );
  expect(found).toEqual([
    "8: request without run's signal keeps going after the",
    "9: createPost is a server action, which takes no sign",
    "10: a durable run started in a task isn't stopped with",
  ]);
});

const USE = `import { createActor } from "@reactre/state";

import { doorMachine } from "../fixtures/door.ts";

export const actor = createActor(doorMachine);
`;

/** Where a machine is used, in any file: nothing hides a broken contract, and machines are made once, in their shape's file. */
const sites: Case[] = [
  [
    "M303: a @ts- suppression over createActor, in a file without machines",
    change(USE, "export const actor", "// @ts-ignore\nexport const actor"),
    5,
    "a @ts- suppression over createActor(...) hides a broken contract from the type checker",
  ],
  [
    "@ts-nocheck in a file that uses a machine",
    `// @ts-nocheck\n${USE}`,
    1,
    "@ts-nocheck turns off the type checks of every machine this file uses",
  ],
  [
    "a cast on a line that passes a machine",
    change(USE, "createActor(doorMachine)", "createActor(doorMachine as typeof doorMachine)"),
    5,
    "a cast on a line that calls createActor(...) hides a broken contract from the type checker",
  ],
  [
    "a non-null assertion on a line that passes a machine",
    change(
      USE,
      "export const actor = createActor(doorMachine);",
      "const machines = [doorMachine];\nexport const actor = createActor(machines[0]!);",
    ),
    6,
    "a non-null assertion (!) on a line that calls createActor(...) hides a broken contract",
  ],
  [
    "M305: a cast on a snapshot's data",
    `${USE}const snapshot = actor.snapshot();\nexport const by = (snapshot.data as { by?: string }).by;\n`,
    7,
    "a cast on a snapshot's data hides a field that isn't there: narrow the snapshot by its state instead",
  ],
  [
    "a non-null assertion on a listener's snapshot's data",
    `${USE}actor.subscribe((s) => {\n  if (s.state === "open") console.log(s.data.by!);\n});\n`,
    7,
    "a non-null assertion (!) on a snapshot's data hides a field that isn't there",
  ],
  [
    "M312: a machine made inside a function",
    change(
      change(DOOR, "export const doorMachine = door.machine({", "export const makeDoor = () =>\n  door.machine({"),
      "createActor(doorMachine)",
      "createActor(makeDoor())",
    ),
    14,
    "door.machine(...) inside a function makes a new machine on each call (in a component, on every render): make it once, at module level",
  ],
  [
    "M310: a machine of a shape from another file",
    'import { lamp } from "../compiler/shape.ts";\n\nexport const lampMachine = lamp.machine({\n  start: ({ to }) => to("off"),\n  states: { off: { on: { flip: ({ to }) => to("on") } }, on: { on: { flip: ({ to }) => to("off") } } },\n});\n',
    3,
    "lamp is a shape from ../compiler/shape.ts: its machines are written in its own file, where the compiler sees them with it",
  ],
  [
    "a machine of a shape another file exports under another name",
    'import { knob } from "../compiler/shape.ts";\n\nexport const knobMachine = knob.machine({\n  start: ({ to }) => to("low"),\n  states: { low: { on: { turn: ({ to }) => to("high") } }, high: { on: { turn: ({ to }) => to("low") } } },\n});\n',
    3,
    "knob is a shape from ../compiler/shape.ts",
  ],
  [
    "M49: a send some state doesn't handle, its result dropped",
    `${DOOR}actor.send({ type: "close" });\n`,
    28,
    'actor.send({ type: "close" }) does nothing in "closed", "locked", which don\'t handle it, and its result is dropped, so nothing says so: read it, const result = actor.send(...); if (!result.ok) ... (result.reason is "unhandled"), or send it only where it is handled, if (actor.snapshot().state === "open") actor.send(...)',
  ],
  [
    "a send one state doesn't handle, in a listener",
    `${change(DOOR, "lock: ({ event, to })", 'close: ({ to }) => to("closed"),\n        lock: ({ event, to })')}actor.subscribe(() => {\n  actor.send({ type: "close" });\n});\n`,
    30,
    'actor.send({ type: "close" }) does nothing in "locked", which doesn\'t handle it',
  ],
  [
    "M50: a send after the actor stopped",
    `${DOOR}actor.stop();\nactor.send({ type: "push", by: "ann" });\n`,
    29,
    'actor.send(...) after actor.stop() is refused ("inactive"), and its result is dropped, so nothing says so: a stopped actor takes no events. Send before stopping it, or start a new actor, createActor(machine)',
  ],
  [
    "a send from a timer, after the actor stopped",
    `${USE}actor.stop();\nsetTimeout(() => actor.send({ type: "close" }), 100);\n`,
    7,
    'actor.send(...) after actor.stop() is refused ("inactive")',
  ],
  [
    "a voided send in a block, after the actor stopped",
    `${USE}export function leave(): void {\n  actor.stop();\n  if (actor.status() === "stopped") void actor.send({ type: "close" });\n}\n`,
    8,
    'actor.send(...) after actor.stop() is refused ("inactive")',
  ],
  [
    "M52: a listener that throws",
    `${USE}actor.subscribe((s) => {\n  if (s.state === "open") throw new Error("render failed");\n});\n`,
    7,
    "a listener that throws makes send throw: the other listeners still run, then actor.send(...) throws this error to whoever sent the event, after the transition is made. Handle the failure in the listener: try { ... } catch (error) { console.error(error) }",
  ],
  [
    "a listener that throws from its catch",
    `${USE}actor.subscribe((s) => {\n  try {\n    console.info(s.state);\n  } catch (error) {\n    throw new Error("render failed", { cause: error });\n  }\n});\n`,
    10,
    "a listener that throws makes send throw",
  ],
  [
    "M53: awaiting send, expecting the task to have ended",
    `${USE}export async function submit(): Promise<string> {\n  await actor.send({ type: "push", by: "ann" });\n  return actor.snapshot().state;\n}\n`,
    7,
    'await actor.send(...) waits for nothing: send returns its result at once, when the transition is made, not when the state\'s task ends. Wait for the state the task ends in: actor.send(...); await waitFor(actor, (s) => s.state === "<that state>") (import { waitFor } from "@reactre/state/utils")',
  ],
  [
    "M308: a switch over a snapshot's state with a default for the rest",
    `${USE}export function label(s: ReturnType<typeof actor.snapshot>): string {\n  switch (s.state) {\n    case "open":\n      return s.data.by;\n    default:\n      return "closed";\n  }\n}\n`,
    10,
    "a default in a switch over s.state treats every other state alike, and a state added later lands in it unseen: write a case for each state, and make the default a check that none is left, default: { const left: never = s.state; throw new Error(`unhandled state ${left}`); }",
  ],
  [
    "a switch over the actor's snapshot's state with a default",
    `${USE}export function label(): string {\n  switch (actor.snapshot().state) {\n    case "open":\n      return "open";\n    default:\n      return "shut";\n  }\n}\n`,
    10,
    "a default in a switch over actor.snapshot().state treats every other state alike",
  ],
  [
    "a switch over a listener's snapshot's state with a default",
    `${USE}actor.subscribe((s) => {\n  switch (s.state) {\n    case "locked":\n      console.info(s.data.code);\n      break;\n    default:\n      console.info(s.state);\n  }\n});\n`,
    11,
    "a default in a switch over s.state treats every other state alike",
  ],
];

/** Code the compiler refuses although it is correct, so it can compile the machine (not mistakes: see MISTAKES.md group 20). */
const restrictions: Case[] = [
  [
    "setup's states spread",
    change(
      change(DOOR, "states: { closed: types<{}>(),", "states: { ...BASE, closed: types<{}>(),"),
      "const door = setup",
      "const BASE = {};\nconst door = setup",
    ),
    5,
    "setup's states can't be spread",
  ],
  [
    "setup's argument in a variable",
    change(
      change(DOOR, "const door = setup({", "const DOOR_SHAPE = {"),
      "  },\n});\n\nexport const doorMachine",
      "  },\n};\nconst door = setup(DOOR_SHAPE);\n\nexport const doorMachine",
    ),
    12,
    "setup takes one object literal written in place",
  ],
  [
    "a state in a variable",
    change(
      change(JOB, "saved: { final: true },", "saved: SAVED,"),
      "export const jobMachine",
      "const SAVED = { final: true } as const;\nexport const jobMachine",
    ),
    22,
    'state "saved" is an object literal written in place',
  ],
  [
    "a parallel node's name in a variable",
    change(
      change(PLAYER, 'parallel: ["on"],', "parallel: [ON],"),
      "const player = setup",
      'const ON = "on";\nconst player = setup',
    ),
    8,
    "setup's parallel lists names written in place",
  ],
  [
    "a parallel node's regions given as data",
    change(
      PLAYER,
      'to("on", { a: to("on.a.x"), b: to("on.b.z") })',
      'to("on", 1 > 0 ? { a: to("on.a.x"), b: to("on.b.z") } : { a: to("on.a.x"), b: to("on.b.z") })',
    ),
    15,
    'write parallel node "on"\'s regions as an object literal',
  ],
  [
    "meta with a variable in an array",
    change(
      change(withUse(["tags"], DOOR), "open: { on:", "open: { meta: { order: [1, LIMIT] }, on:"),
      "export const doorMachine",
      "const LIMIT = 2;\nexport const doorMachine",
    ),
    25,
    `state "open"'s meta is JSON written in place`,
  ],
  [
    "spawn's children spread",
    change(
      change(
        change(PAGE, "use: [children],", "use: [children, effects, spawn],"),
        "children: { job: childMachine },",
        "children: { job: childMachine, ...MORE },",
      ),
      'import { children } from "@reactre/state/children";',
      'import { children } from "@reactre/state/children";\nimport { effects } from "@reactre/state/effects";\nimport { spawn } from "@reactre/state/spawn";\nconst MORE = {};',
    ),
    1,
    "setup's children can't be spread",
  ],
];

// #region core-A: M404–M499, M576–M578, M607 (transitions and contracts), and the rules over the
// code around machines: use sites (M430–M591), components (M592–M606) and tests (M608–M611).

const PUSH = 'push: ({ event, to }) => to("open", { by: event.by })';
const LOCK = 'lock: ({ event, to }) => to("locked", { code: event.code })';
const UNLOCK = '({ data, event, to }) => (event.code === data.code ? to("closed") : null)';
const SAVE = 'save: ({ event, to }) => to("saving", { text: event.text })';
const TIMER = '"1.5s": ({ to }) => to("failed", { error: "timed out" })';
/** DOOR with push's payload (and so open's data) of another type. */
const pushing = (type: string, push: string): string =>
  change(change(DOOR, "push: types<{ by: string }>()", `push: types<{ by: ${type} }>()`), PUSH, push);
/** JOB whose saving data has one more field, given by save. */
const saving = (field: string, type: string, value: string): string =>
  change(
    change(JOB, "saving: types<{ text: string }>()", `saving: types<{ text: string; ${field}: ${type} }>()`),
    SAVE,
    `save: ({ event, to }) => to("saving", { text: event.text, ${field}: ${value} })`,
  );
/** JOB's idle save written as a block. */
const savingIn = (block: string): string => change(JOB, SAVE, `save: ({ event, to }) => {\n${block}\n        }`);

const coreTransitions: Case[] = [
  [
    "M404: a step built in a block and dropped",
    change(
      change(
        DOOR,
        LOCK,
        `lock: ({ event, to }) => {\n          if (event.code !== "") to("locked", { code: event.code });\n          return null;\n        }`,
      ),
      'open: { on: { close: ({ to }) => to("closed") } }',
      `open: { on: { close: ({ to }) => to("closed"), ${LOCK} } }`,
    ),
    1,
    'the step to("locked", …) is built and dropped: return it',
  ],
  [
    "M405: a guard's no that stays with the same data",
    change(
      DOOR,
      UNLOCK,
      '({ data, event, keep, to }) => (event.code === data.code ? to("closed") : keep("locked", data))',
    ),
    23,
    'keep("locked", data) stays with the data unchanged, so the event counts as handled',
  ],
  [
    "M406: a getter in a step's data",
    change(
      DOOR,
      'to("open", { by: event.by })',
      'to("open", {\n          get by() {\n            return event.by;\n          },\n        })',
    ),
    1,
    `state "open"'s data has a getter, by, which JSON and spreads freeze into a value or drop`,
  ],
  [
    "M410: the old state's data mutated to build the new one",
    change(DOOR, LOCK, 'lock: ({ data, event, to }) => to("locked", Object.assign(data, { code: event.code }))'),
    19,
    'write state "locked"\'s data as an object literal, or pass data',
  ],
  [
    "M413: return null in a forEach callback, meant to decline",
    change(
      DOOR,
      LOCK,
      'lock: ({ event, to }) => {\n          event.code.split("").forEach((c) => {\n            if (c === " ") return null;\n          });\n          return to("locked", { code: event.code });\n        }',
    ),
    1,
    "return null in forEach's callback returns from the callback, not the handler",
  ],
  [
    "M413: a step returned from a map callback",
    change(
      DOOR,
      LOCK,
      'lock: ({ event, to }) => {\n          const steps = event.code.split("").map(() => {\n            return to("locked", { code: event.code });\n          });\n          return steps[0] ?? null;\n        }',
    ),
    1,
    "return to(…) in map's callback returns from the callback, not the handler",
  ],
  [
    "M415: an event's object compared by reference",
    change(
      change(DOOR, "push: types<{ by: string }>()", "push: types<{ by: string; who: { id: string } }>()"),
      PUSH,
      'push: ({ event, to }) => (event.who === WHO ? to("open", { by: event.by }) : null)',
    ).replace("export const doorMachine", 'const WHO = { id: "ann" };\nexport const doorMachine'),
    1,
    "=== compares objects by reference, and every payload (and every restored value) is a new object",
  ],
  [
    "M415: includes of an event's object",
    change(
      change(DOOR, "push: types<{ by: string }>()", "push: types<{ by: string; who: { id: string } }>()"),
      PUSH,
      'push: ({ event, to }) => ([event.who].includes(event.who) ? to("open", { by: event.by }) : null)',
    ),
    1,
    "includes compares objects by reference",
  ],
  [
    "M424: a literal union widened by string",
    change(DOOR, "open: types<{ by: string }>()", 'open: types<{ by: "ann" | "bob" | string }>()'),
    4,
    '`"ann" | "bob" | string` is string: its literals check nothing',
  ],
  [
    "M424: a literal union widened by number",
    change(DOOR, "close: types<{}>()", "close: types<{ n: 1 | 2 | number }>()"),
    1,
    "`1 | 2 | number` is number",
  ],
  [
    "M426: an enum in a contract",
    change(
      change(DOOR, "open: types<{ by: string }>()", "open: types<{ by: Visitor }>()"),
      "push: types<{ by: string }>()",
      "push: types<{ by: Visitor }>()",
    ).replace("const door = setup", 'enum Visitor {\n  Ann = "ann",\n}\n\nconst door = setup'),
    1,
    "Visitor is an enum in a contract: senders must import it and cast strings to it",
  ],
  [
    "M426: an enum read in a transition",
    declare(change(DOOR, "{ by: event.by }", "{ by: Visitor.Ann }"), 'enum Visitor {\n  Ann = "ann",\n}'),
    1,
    "Visitor is an enum: a transition reads its members as values the sender had to import",
  ],
  [
    "M427: a version that isn't a whole number",
    change(DOOR, "const door = setup({\n", "const door = setup({\n  version: 2.5,\n"),
    4,
    "version is a statically known nonnegative integer",
  ],
  [
    "M427: a negative version",
    change(DOOR, "const door = setup({\n", "const door = setup({\n  version: -1,\n"),
    4,
    "version is a statically known nonnegative integer",
  ],
  [
    "M474: JSON.stringify of a task's error",
    change(JOB, "{ error: String(error) }", "{ error: JSON.stringify(error) }"),
    1,
    'JSON.stringify of an Error is "{}"',
  ],
  [
    "M476: a task's result that re-enters its own state",
    change(
      change(
        withUse(["reenter"], JOB),
        'stored: ({ event, to }) => to("saved", { id: event.id })',
        'stored: ({ data, reenter }) => reenter("saving", data)',
      ),
      'retry: ({ to }) => to("idle")',
      'retry: ({ to }) => to("saved", { id: "" })',
    ),
    1,
    `the result of "saving"'s task, stored, goes back into "saving", which runs the task again`,
  ],
  [
    "M477: keep with a field the running task read",
    keeps('({ event, keep }) => keep("saving", { text: event.text })'),
    1,
    'keep("saving") changes `text`, which the running task read when it started',
  ],
  [
    "M481: two timers of one time",
    change(JOB, TIMER, `${TIMER}, "1500ms": ({ to }) => to("idle")`),
    1,
    'the timers "1.5s" and "1500ms" are one time (1500 ms)',
  ],
  [
    "M483: a timer that stays, expecting to fire again",
    change(JOB, TIMER, '"1.5s": ({ data, keep }) => keep("saving", data)'),
    1,
    `keep("saving") from its own timer doesn't restart the timer`,
  ],
  [
    "M484: a throw in a transition",
    change(
      DOOR,
      PUSH,
      'push: ({ event, to }) => {\n          if (event.by === "") throw "by is required";\n          return to("open", { by: event.by });\n        }',
    ),
    1,
    "a throw in a transition errors the actor, and the sender never hears why",
  ],
  [
    "M486: || for a default on a string",
    change(DOOR, "{ by: event.by }", '{ by: event.by || "anonymous" }'),
    1,
    'event.by || ... replaces "", 0 and false too, not only a missing value',
  ],
  [
    "M487: this in a handler",
    change(
      DOOR,
      'close: ({ to }) => to("closed")',
      'close({ to }) {\n          return this === undefined ? null : to("closed");\n        }',
    ),
    1,
    "this in a handler is whatever object called it",
  ],
  [
    "M488: a reversed clamp",
    change(
      change(DOOR, "open: types<{ by: string }>()", "open: types<{ by: string; tries: number }>()"),
      "{ by: event.by }",
      "{ by: event.by, tries: Math.min(Math.max(event.by.length, 10), 1) }",
    ),
    1,
    "this Math.min of Math.max always gives 1: the bounds are swapped",
  ],
  [
    "M489: a locale method without a locale",
    change(DOOR, "{ by: event.by }", "{ by: event.by.toLocaleUpperCase() }"),
    1,
    "toLocaleUpperCase depends on the environment's locale, so the step differs from machine to machine: toUpperCase()",
  ],
  [
    "M489: localeCompare without a locale",
    change(DOOR, "(event.code === data.code ?", "(event.code.localeCompare(data.code) === 0 ?"),
    1,
    "localeCompare depends on the environment's locale, so the step differs from machine to machine: pass the locale as its second argument",
  ],
  [
    "M489: Intl in a transition",
    change(DOOR, "{ by: event.by }", "{ by: Intl.DateTimeFormat().resolvedOptions().timeZone + event.by }"),
    1,
    "Intl formats by the environment's locale and time zone",
  ],
  [
    "M490: sort() of numbers with no compare function",
    saving("sizes", "number[]", 'event.text.split(",").map(Number).sort()'),
    1,
    "sort() orders numbers as text ([1, 10, 2]): sort((a, b) => a - b)",
  ],
  [
    "M491: Array(n).map",
    saving("cells", "string[]", 'Array(3).map(() => "")'),
    1,
    "Array(3) is 3 holes, which map and forEach skip",
  ],
  [
    "M492: delete of an array's element",
    savingIn(
      '          const parts = event.text.split(",");\n          delete parts[0];\n          return to("saving", { text: parts.join(",") });',
    ),
    1,
    "delete leaves a hole in parts",
  ],
  [
    "M493: splice in a forward loop",
    savingIn(
      '          const parts = event.text.split(",");\n          for (let i = 0; i < parts.length; i++) if (parts[i] === "") parts.splice(i, 1);\n          return to("saving", { text: parts.join(",") });',
    ),
    1,
    "parts.splice(i, …) in a forward loop over parts.length skips the item after each one it removes",
  ],
  [
    "M494: for…in over an array",
    savingIn(
      '          let text = "";\n          for (const i in event.text.split(",")) text += i;\n          return to("saving", { text });',
    ),
    1,
    "for…in over an array gives string keys",
  ],
  [
    "M495: a module table indexed by a payload's string",
    declare(
      change(DOOR, "{ by: event.by }", "{ by: NAMES[event.by] ?? event.by }"),
      'const NAMES: Record<string, string> = { ann: "Ann" };',
    ),
    1,
    `NAMES[event.by] reads NAMES's prototype too ("constructor" finds a function)`,
  ],
  [
    "M496: the event as a condition",
    change(DOOR, PUSH, 'push: ({ event, to }) => (event ? to("open", { by: event.by }) : null)'),
    1,
    "`event` is always truthy by its contract, so this condition always passes",
  ],
  [
    "M496: a field of literals with no falsy one as a condition",
    pushing('"ann" | "bob"', 'push: ({ event, to }) => (event.by ? to("open", { by: event.by }) : null)'),
    1,
    "`event.by` is always truthy by its contract",
  ],
  [
    "M497: the event in a template",
    change(DOOR, "{ by: event.by }", "{ by: `by ${event}` }"),
    1,
    'the template prints event as "[object Object]"',
  ],
  [
    "M498: unary minus on a string field",
    change(
      change(DOOR, "open: types<{ by: string }>()", "open: types<{ by: string; offset: number }>()"),
      "{ by: event.by }",
      "{ by: event.by, offset: -event.by }",
    ),
    1,
    "-event.by negates a string field, which gives NaN",
  ],
  [
    "M499: a default over a payload's union",
    pushing(
      '"ann" | "bob"',
      'push: ({ event, to }) => {\n          switch (event.by) {\n            case "ann":\n              return to("open", { by: "ann" });\n            default:\n              return null;\n          }\n        }',
    ),
    1,
    "a default in a switch over event.by takes a member added to its union later, unseen",
  ],
  [
    "M576: a lint suppression in a file with machines",
    change(DOOR, PUSH, `// eslint-disable-next-line no-console\n        ${PUSH}`),
    1,
    "a lint suppression in a file with machines hides a broken rule",
  ],
  [
    "M578: a cast on a snapshot's state",
    `${USE}const SHUT = ["closed", "locked"] as const;\nexport const isShut = SHUT.includes(actor.snapshot().state as (typeof SHUT)[number]);\n`,
    7,
    "a cast on actor.snapshot().state hides a state the type checker would check",
  ],
  [
    "M607: a setter event whose boolean every handler branches on",
    change(
      change(
        change(DOOR, "close: types<{}>(),", "close: types<{}>(),\n    setOpen: types<{ open: boolean }>(),"),
        `${LOCK},`,
        `${LOCK},\n        setOpen: ({ event, to }) => (event.open ? to("open", { by: "" }) : null),`,
      ),
      'open: { on: { close: ({ to }) => to("closed") } }',
      'open: { on: { close: ({ to }) => to("closed"), setOpen: ({ event, to }) => (!event.open ? to("closed") : null) } }',
    ),
    1,
    "setOpen carries one boolean, open, and every handler branches on it to pick its step",
  ],
];

/** A list the sender keeps: its event's payload is an array. */
const LIST = `import { createActor, setup, types } from "@reactre/state";

const list = setup({
  states: { idle: types<{ items: readonly string[] }>() },
  events: { set: types<{ items: readonly string[] }>() },
});

export const listMachine = list.machine({
  start: ({ to }) => to("idle", { items: [] }),
  states: { idle: { on: { set: ({ event, keep }) => keep("idle", { items: event.items }) } } },
});

export const actor = createActor(listMachine);
`;
const JOB_USE = `import { createActor } from "@reactre/state";

import { jobMachine } from "../fixtures/job.ts";
`;

const coreSites: Case[] = [
  [
    "M430: a payload mutated after the send",
    `${LIST}const items = ["a"];\nactor.send({ type: "set", items });\nitems.push("b");\n`,
    16,
    "items is sent to the actor and then changed",
  ],
  [
    "M430: a payload's field assigned after the send",
    `${LIST}const items = ["a"];\nactor.send({ type: "set", items });\nitems[0] = "b";\n`,
    16,
    "items is sent to the actor and then changed",
  ],
  [
    "M431: a message listener that sends without checking the origin",
    `${USE}window.addEventListener("message", (e) => {\n  actor.send({ type: "push", by: String(e.data) });\n});\n`,
    6,
    "a message listener sends to the actor without checking where the message came from",
  ],
  [
    "M577: the library's types augmented",
    `${USE}import type { Shape } from "@reactre/state";\ndeclare module "@reactre/state" {\n  interface Actor<D extends Shape> {\n    retryLater(data: D): void;\n  }\n}\n`,
    7,
    `declare module "@reactre/state" changes @reactre/state's types`,
  ],
  [
    "M585: an actor's variable given a new actor",
    `${USE}let current = createActor(doorMachine);\nexport function reset(): void {\n  current = createActor(doorMachine);\n}\nexport const now = (): string => current.snapshot().state;\n`,
    8,
    "the old actor in current isn't stopped, so its task and timers keep running",
  ],
  [
    "M586: an actor made in an async function that returns while it runs",
    `${JOB_USE}\nexport async function handle(text: string): Promise<boolean> {\n  const worker = createActor(jobMachine);\n  return worker.send({ type: "save", text }).ok;\n}\n`,
    6,
    "the actor made here is neither awaited nor stopped",
  ],
  [
    "M587: a module actor in a request handler",
    `${USE}export function POST(req: Request): Response {\n  const r = actor.send({ type: "push", by: req.headers.get("x-user") ?? "" });\n  return new Response(r.ok ? "ok" : "refused");\n}\n`,
    7,
    "actor is one actor at module level, so every request (every user) drives the same machine",
  ],
  [
    "M587: a module actor in a Worker's fetch",
    `${USE}export default {\n  fetch(): Response {\n    return new Response(actor.snapshot().state);\n  },\n};\n`,
    8,
    "actor is one actor at module level",
  ],
  [
    "M589: waitFor not awaited",
    `${USE}import { waitFor } from "@reactre/state/utils";\nwaitFor(actor, (s) => s.state === "open");\n`,
    7,
    "waitFor(...) isn't awaited, so its rejection (a timeout, a failed path) is unhandled",
  ],
  [
    "M591: transition's result dropped",
    `${USE}import { transition } from "@reactre/state";\ntransition(doorMachine, actor.snapshot(), { type: "push", by: "ann" });\n`,
    7,
    "transition(...)'s result is dropped: it is pure",
  ],
];

// (The repository has no @types/react: the rules read the hooks' names.)
const REACT = `import { createActor } from "@reactre/state"; import { useActor, useActorRef, useSelector } from "@reactre/state/react";
// @ts-expect-error React's types aren't installed here
import { use, useEffect, useState, useSyncExternalStore } from "react";

import { doorMachine } from "../fixtures/door.ts";
`;
const coreReact: Case[] = [
  [
    "M592: provide in a component",
    `${REACT}import { provide } from "@reactre/state/provide";\nimport { orderMachine } from "../features/effects/machines.ts";\n\nexport function Order(): null {\n  useActor(provide(orderMachine, { actions: { track: (params) => params.key.length } }));\n  return null;\n}\n`,
    10,
    "provide(...) in a component makes a new machine on every render",
  ],
  [
    "M593: a send in a component's body",
    `${REACT}\nexport function Door(): null {\n  const [s, ref] = useActor(doorMachine);\n  if (s.state === "closed") ref.send({ type: "push", by: "ann" });\n  return null;\n}\n`,
    9,
    "ref.send(...) in a component's body sends on every render",
  ],
  [
    "M594: a component that runs an actor, declared in another",
    `${REACT}\nexport function Page(): null {\n  useState(0);\n  function Wizard(): null {\n    useActor(doorMachine);\n    return null;\n  }\n  return Wizard();\n}\n`,
    9,
    "Wizard is declared in Page, so it is a new component on each render",
  ],
  [
    "M595: an effect that copies the snapshot into state",
    `${REACT}\nexport function Visitor(): string {\n  const [s] = useActor(doorMachine);\n  const [by, setBy] = useState("");\n  useEffect(() => {\n    if (s.state === "open") setBy(s.data.by);\n  }, [s]);\n  return by;\n}\n`,
    11,
    "an effect copies the snapshot into state, a render behind it: read s.data.by where you need it",
  ],
  [
    "M596: a POST in an effect on the snapshot",
    `${REACT}\nexport function Order(): null {\n  const [s] = useActor(doorMachine);\n  useEffect(() => {\n    if (s.state === "open") void fetch("/api/order", { method: "POST" });\n  }, [s.state]);\n  return null;\n}\n`,
    10,
    "a POST in an effect on the snapshot runs again whenever the effect does",
  ],
  [
    "M597: a getSnapshot that returns a new object",
    `${REACT}\nexport function State(): string {\n  const ref = useActorRef(doorMachine);\n  return useSyncExternalStore(ref.subscribe, () => ({ state: ref.snapshot().state })).state;\n}\n`,
    9,
    "getSnapshot returns a new object on each call",
  ],
  [
    "M598: createActor in useState",
    `${REACT}\nexport function Make(): string {\n  const [actor] = useState(() => createActor(doorMachine));\n  return actor.snapshot().state;\n}\n`,
    8,
    "createActor in useState makes an actor during render",
  ],
  [
    "M599: use() of a promise made in the component",
    `${REACT}import { waitFor } from "@reactre/state/utils";\n\nexport function Wait(): string {\n  return use(waitFor(createActor(doorMachine), (s) => s.state === "open")).state;\n}\n`,
    9,
    "use(waitFor(...)) makes a new promise on every render",
  ],
  [
    "M600: Vue's reactive() of a snapshot",
    `${USE}// @ts-expect-error vue isn't a dependency here: the rule reads the import's name\nimport { reactive } from "vue";\nexport const state = reactive(actor.snapshot());\n`,
    8,
    "reactive() of a snapshot proxies its data deeply",
  ],
  [
    "M601: a click handler that returns send",
    `${USE}export const buttonProps = { onClick: () => actor.send };\n`,
    6,
    "() => actor.send returns send without calling it",
  ],
  [
    "M602: an onSubmit without preventDefault",
    `${USE}export const formProps = { onSubmit: () => actor.send({ type: "close" }) };\n`,
    6,
    "an onSubmit that doesn't call preventDefault()",
  ],
  [
    "M603: subscribe in a component's body",
    `${REACT}\nexport function Log(): null {\n  const [, ref] = useActor(doorMachine);\n  ref.subscribe((s) => console.info(s.state));\n  return null;\n}\n`,
    9,
    "ref.subscribe(...) in a component's body adds a listener on every render",
  ],
  [
    "M604: useActor in a condition",
    `${REACT}\nexport function Form({ open }: { open: boolean }): null {\n  if (open) useActor(doorMachine);\n  return null;\n}\n`,
    8,
    "useActor in a condition, a loop or a callback runs in a different order from render to render",
  ],
  [
    "M604: useSelector in a callback",
    `${REACT}\nexport function Rows({ ids }: { ids: readonly string[] }): number {\n  const ref = useActorRef(doorMachine);\n  return ids.map(() => useSelector(ref, (s) => s.state)).length;\n}\n`,
    9,
    "useSelector in a condition, a loop or a callback",
  ],
  [
    "M605: a selector that sends",
    `${REACT}\nexport function Selected(): string {\n  const ref = useActorRef(doorMachine);\n  return useSelector(ref, (s) => {\n    ref.send({ type: "close" });\n    return s.state;\n  });\n}\n`,
    9,
    "a selector that sends runs during render",
  ],
  [
    "M606: the render's snapshot read after an await",
    `${REACT}\nexport function Save(): () => Promise<void> {\n  const [s, ref] = useActor(doorMachine);\n  return async () => {\n    await Promise.resolve();\n    if (s.state === "open") ref.send({ type: "close" });\n  };\n}\n`,
    11,
    "s is the snapshot of the render this function was made in: after the await it is stale",
  ],
];

const TESTS = `import { createActor } from "@reactre/state";
import { testPaths } from "@reactre/state/test";
import { SimulatedClock } from "@reactre/state/utils";

import { doorMachine } from "../fixtures/door.ts";
import { jobMachine } from "../fixtures/job.ts";
`;
const coreTests: Case[] = [
  [
    "M608: sut.create makes an actor of the machine under test",
    `${TESTS}\nexport const paths = testPaths(doorMachine, {\n  events: { push: [{ by: "ann" }], close: [{}], lock: [{ code: "1" }], unlock: [{ code: "1" }] },\n  sut: {\n    create: () => {\n      const a = createActor(doorMachine);\n      return { send: (e) => void a.send(e), read: () => a.snapshot().state };\n    },\n    project: (s) => s.state,\n  },\n});\n`,
    12,
    "sut.create makes an actor of doorMachine, the machine under test",
  ],
  [
    "M609: a SimulatedClock made after the actor",
    `${TESTS}\nexport function run(): void {\n  const actor = createActor(jobMachine);\n  const clock = new SimulatedClock();\n  actor.send({ type: "save", text: "a" });\n  console.info(clock.now());\n  clock.uninstall();\n}\n`,
    10,
    "fake timers installed after the actor",
  ],
  [
    "M609: fake timers installed after the actor",
    `${TESTS}import { jest } from "bun:test";\n\nexport function run(): void {\n  const actor = createActor(jobMachine);\n  jest.useFakeTimers();\n  actor.send({ type: "save", text: "a" });\n  console.info(doorMachine);\n}\n`,
    11,
    "fake timers installed after the actor",
  ],
  [
    "M610: a SimulatedClock no actor reads",
    `${TESTS}\nexport function run(): void {\n  const clock = new SimulatedClock();\n  createActor(jobMachine).send({ type: "save", text: "a" });\n  clock.advance(10);\n  clock.uninstall();\n  console.info(doorMachine, testPaths);\n}\n`,
    9,
    "the SimulatedClock fires timers, but no actor reads its time",
  ],
  [
    "M611: a SimulatedClock never uninstalled",
    `${TESTS}\nexport function run(): void {\n  const clock = new SimulatedClock();\n  createActor(jobMachine, { now: clock.now }).send({ type: "save", text: "a" });\n  console.info(doorMachine, testPaths);\n}\n`,
    9,
    "the SimulatedClock replaces the global setTimeout until it is uninstalled",
  ],
];

// #endregion

const groups: readonly (readonly [string, readonly Case[]])[] = [
  ["runtime keys", keys],
  ["pure transitions", pure],
  ["structure", structure],
  ["use", use],
  ["calls", calls],
  ["transitions", transitions],
  ["run", run],
  ["use sites", sites],
  ["duplicates", duplicates],
  ["shapes", shapes],
  ["restrictions", restrictions],
  ["core transitions", coreTransitions],
  ["core use sites", coreSites],
  ["core react", coreReact],
  ["core tests", coreTests],
  ...Object.entries(featureCases).map(([feature, cases]) => [`feature ${feature}`, cases] as const),
];

for (const [group, cases] of groups)
  if (cases.length > 0)
    describe(group, () => {
      test.each(cases)("%s", (_, source, line, message) => {
        const found = problems(source);
        const match = found.find((p) => p.includes(message));
        expect(match ?? found.join("\n")).toContain(message);
        if (line > 1) expect(match?.split(":")[0]).toBe(String(line));
      });
    });

test("a correct machine passes, and the compiler is quiet on what the type checker reports", () => {
  for (const correct of [DOOR, JOB, EDITOR, PLAYER, PAGE, FORM]) expect(problems(correct)).toEqual([]);
  // Type errors all: the compiler compiles past them, and `bun check` names them.
  for (const [from, to] of [
    ['to("open", { by: event.by })', 'to("opne", { by: event.by })'],
    ["{ by: event.by }", "{ by: event.by, at: 1 }"],
    ["open: { on:", "open: { entry: () => {}, on:"],
    ["close: ({ to })", "clsoe: ({ to })"],
    ['({ to }) => to("closed") } }', '"closed" } }'],
    ['({ to }) => to("closed") } }', 'async ({ to }) => to("closed") } }'],
    ["open: types<{ by: string }>()", "open: types<{ by: any }>()"],
    ['to("open", { by: event.by })', 'to("open", { ...event })'],
    // The event as data: its `type` is a field no state has.
    ['to("open", { by: event.by })', 'to("open", event)'],
    // M6: an extra field in a local object built as the data, which is that literal.
    [
      '({ event, to }) => to("open", { by: event.by })',
      '({ event, to }) => {\n          const next = { by: event.by, at: 1 };\n          return to("open", next);\n        }',
    ],
  ] as const)
    expect(problems(change(DOOR, from, to))).toEqual([]);
  expect(problems(change(JOB, '"1.5s"', '"5 sec"'))).toEqual([]);
  // M90: a timer as a bare number, whose unit the machine's problem names.
  expect(problems(change(JOB, '"1.5s":', "1500:"))).toEqual([]);
  // M304: a machine or snapshot cast to any where it's used: the call's `this` refuses it.
  expect(
    problems(`import { createActor, initial, transition } from "@reactre/state";
import { useActor, useActorRef } from "@reactre/state/react";
import { useActor as useSignal } from "@reactre/state/signals";

import { doorMachine } from "../fixtures/door.ts";

export const actor = createActor(doorMachine as any);
export const first = initial(<any>doorMachine, undefined);
export const next = transition(doorMachine, first as any, { type: "push", by: "ann" });
export const hooks = () => [useActor(doorMachine as any), useActorRef(doorMachine as any), useSignal(doorMachine as any)];
`),
  ).toEqual([]);
  // A comment that mentions a suppression in prose isn't one.
  expect(
    problems(change(DOOR, "export const doorMachine", "// a model writes @ts-ignore\nexport const doorMachine")),
  ).toEqual([]);
  // M173: back without its fallback, or with a spread one; meta that is never JSON.
  for (const back of ['back("edit")', 'back("edit", ...[to("edit.draft", { text: "" })])'])
    expect(problems(change(EDITOR, 'back("edit", to("edit.draft", { text: "" }))', back))).toEqual([]);
  for (const meta of ["() => 1", "function () {}", "class {}", "/x/", "1n", "undefined", "[1, { f() {} }]"])
    expect(problems(change(withUse(["tags"], DOOR), "open: { on:", `open: { meta: { by: ${meta} }, on:`))).toEqual([]);
  // A spread argument is a type error (it isn't a tuple): to, and reenter, compile past it.
  expect(problems(change(DOOR, 'to("open", { by: event.by })', 'to("open", ...[{ by: event.by }])'))).toEqual([]);
  expect(
    problems(
      change(
        withUse(["reenter"], JOB),
        '({ event, to }) => to("saving", { text: event.text })',
        '({ event, reenter }) => reenter("saving", ...[{ text: event.text }])',
      ),
    ),
  ).toEqual([]);
  // Code the type checker can't fault, and the compiler mustn't refuse.
  for (const [from, to, line] of [
    // A pure import, a pure library function, a module array read, a new object assigned to.
    ["{ by: event.by }", "{ by: label(event.by) }", 'import { label } from "../compiler/pure.ts";'],
    [
      "(event.code === data.code ?",
      '(matchesState("x", event.code) || !event.code ?',
      'import { matchesState } from "@reactre/state/utils";',
    ],
    ["(event.code === data.code ?", "(CODES.includes(event.code) ?", 'const CODES: readonly string[] = ["1"];'],
    ["{ by: event.by }", "{ by: Object.assign({}, { v: event.by }).v }", ""],
    // Data written in place, nested spreads of literals, and a module primitive.
    ["{ by: event.by }", "{ ...{ by: event.by } }", ""],
    ["{ by: event.by }", "{ by: NOBODY }", 'const NOBODY = "nobody";'],
    // A local object changed in place, then read.
    [
      '({ event, to }) => to("open", { by: event.by })',
      '({ event, to }) => {\n          const d = { by: "" };\n          d.by = event.by;\n          return to("open", { by: d.by });\n        }',
      "",
    ],
    // Module-level destructuring.
    ["{ by: event.by }", "{ by: FIRST }", 'const { a: [FIRST = "x", ...REST] = [], ...OTHERS } = { a: ["y"], b: 1 };'],
  ] as const)
    expect(problems(line === "" ? change(DOOR, from, to) : imports(change(DOOR, from, to), line))).toEqual([]);
  // A task's work that ends with the state.
  for (const body of [
    'async ({ data, signal }) => {\n  const id = setInterval(() => void fetch(data.text, { signal }), 1000);\n  signal.addEventListener("abort", () => clearInterval(id));\n  return { type: "stored", id: data.text };\n}',
    'async ({ data, signal }) => {\n  const socket = new WebSocket(data.text);\n  signal.onabort = () => socket.close();\n  window.addEventListener("online", () => socket.close(), { signal });\n  return { type: "stored", id: data.text };\n}',
    'async ({ data, signal }) => {\n  const options = { signal };\n  await fetch(data.text, options);\n  await fetch(data.text, { ...options, method: "POST" });\n  if (data.text === "") throw new Error("empty");\n  return { type: "stored", id: data.text };\n}',
  ])
    expect(problems(withRun(body))).toEqual([]);
  // A response's body read after a look at its status: in run, in run's own function, in one of
  // the file's (through another, by a destructured parameter), or in one a relative import exports.
  for (const [check, line] of [
    ["  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n", ""],
    ['  const { ok } = res;\n  if (!ok) throw new Error("HTTP");\n', ""],
    [
      '  const check = (r: Response): void => {\n    if (r.status >= 400) throw new Error("HTTP");\n  };\n  check(res);\n',
      "",
    ],
    ['  function check(r = new Response()): void {\n    if (!r.ok) throw new Error("HTTP");\n  }\n  check(res);\n', ""],
    [
      "  ensureOk(res);\n",
      'function ensureOk(r: Response): void {\n  ensure(r);\n}\nfunction ensure({ status }: Response): void {\n  if (status > 399) throw new Error("HTTP");\n}',
    ],
    ["  ensureOk(res);\n", 'import { ensureOk } from "../compiler/http.ts";'],
    ["  checked(res);\n", 'import { checked } from "../compiler/http.ts";'],
    ["  ensure(res);\n", 'import { ensure } from "../compiler/http.ts";'],
  ] as const) {
    const source = withRun(`async ({ data, signal }) => {\n${FETCHED}${check}${READ}`);
    const placed = line.startsWith("import")
      ? imports(source, line)
      : line === ""
        ? source
        : change(source, "export const jobMachine", `${line}\nexport const jobMachine`);
    expect(problems(placed)).toEqual([]);
  }
  expect(
    problems(
      withRun(
        '({ data, signal }) =>\n  fetch(data.text, { signal })\n    .then((r) => (r.ok ? r.text() : ""))\n    .then((id) => ({ type: "stored" as const, id }))',
      ),
    ),
  ).toEqual([]);
  // Sibling states that only look alike: no stem shared (a choice's targets), other handlers or
  // data, final, names of other lengths, a stem that is only a connector, or only labels alike.
  const MANAGER = 'approved_by_manager: {\n      on: { pay: ({ data, to }) => to("paid", { id: data.id })';
  const renamed = (s: string, manager: string, director: string): string =>
    s.replaceAll("approved_by_manager", manager).replaceAll("approved_by_director", director);
  for (const unalike of [
    renamed(APPROVALS, "vip", "standard"),
    change(APPROVALS, MANAGER, MANAGER.replace("{ id: data.id }", "{ id: `${data.id}!` }")),
    change(
      APPROVALS,
      "approved_by_director: types<{ id: string }>()",
      "approved_by_director: types<{ id: string; note: string | null }>()",
    ),
    renamed(APPROVALS, "approved_by_manager", "approved_by_the_director"),
    renamed(APPROVALS, "by_manager", "by_director"),
    change(
      change(APPROVALS, "approved_by_manager: {", "approved_by_manager: { final: true },\n    old_manager: {"),
      "approved_by_director: {",
      "approved_by_director: { final: true },\n    old_director: {",
    ),
    APPROVAL,
  ])
    expect(problems(unalike)).toEqual([]);
  // The codemod's note on them, right above the first: the converted machine builds.
  expect(
    problems(
      change(
        APPROVALS,
        "    approved_by_manager: {",
        `    // TODO(@reactre/state): ${APPROVED_TWICE}\n    approved_by_manager: {`,
      ),
    ),
  ).toEqual([]);
  // A cancel of an id a raise gives, as a string or a plain template; options in a constant where
  // nothing cancels.
  expect(problems(cancels('{ delay: 10, id: "bell" }', '"bell"'))).toEqual([]);
  expect(problems(cancels("{ delay: 10, id: `bell` }", "`bell`"))).toEqual([]);
  expect(
    problems(
      change(
        cancels("LATER", '"bell"', 'const LATER = { delay: 10, id: "bell" };'),
        'enq.cancel("bell")',
        'enq.log("closing")',
      ),
    ),
  ).toEqual([]);
  // An effect given by name, and a leaf that only declines (its parent takes the event).
  const doors = withUse(["effects"], DOOR);
  expect(
    problems(
      declare(
        change(
          doors,
          'push: ({ event, to }) => to("open", { by: event.by })',
          'push: ({ event, enq, to }) => (enq(track, event.by), to("open", { by: event.by }))',
        ),
        "function track(by: string): void {\n  console.log(by, Date.now());\n}",
      ),
    ),
  ).toEqual([]);
  expect(
    problems(
      change(
        doors,
        '({ data, event, to }) => (event.code === data.code ? to("closed") : null)',
        '({ enq }) => {\n        enq.log("declined");\n        return null;\n      }',
      ),
    ),
  ).toEqual([]);
  // A shape's hash that isn't a string.
  expect(problems(change(PERSISTED, HASH, "  shape: 1,\n"))).toEqual([]);
  // A feature used without its opt-in, or listed as a string: type errors that name the import.
  expect(problems(change(EDITOR, "use: [nested, history],", ""))).toEqual([]);
  expect(problems(change(EDITOR, "use: [nested, history],", 'use: ["nested", history],'))).toEqual([]);
});

describe("core-A: the correct forms of M404–M611's mistakes pass", () => {
  test("transitions and contracts", () => {
    for (const source of [
      // The fixes the messages name.
      change(DOOR, "{ by: event.by }", '{ by: event.by.toLocaleUpperCase("en-US") }'),
      change(DOOR, "(event.code === data.code ?", '(event.code.localeCompare(data.code, "en") === 0 ?'),
      change(DOOR, "{ by: event.by }", '{ by: event.by === "" ? "anonymous" : event.by }'),
      change(DOOR, "{ by: event.by }", "{ by: `by ${event.by}` }"),
      change(
        change(DOOR, "open: types<{ by: string }>()", "open: types<{ by: string; tries: number }>()"),
        "{ by: event.by }",
        "{ by: event.by, tries: Math.max(Math.min(event.by.length, 10), 1) + Math.min(Math.max(event.by.length, 1), 10) }",
      ),
      change(DOOR, "open: types<{ by: string }>()", 'open: types<{ by: "ann" | "bob" | (string & {}) }>()'),
      pushing(
        '"ann" | "bob"',
        'push: ({ event, to }) => {\n          switch (event.by) {\n            case "ann":\n              return to("open", { by: "ann" });\n            case "bob":\n              return to("open", { by: "bob" });\n            default: {\n              const left: never = event.by;\n              if (left) throw "unhandled";\n              return left;\n            }\n          }\n        }',
      ),
      pushing('"ann" | ""', 'push: ({ event, to }) => (event.by ? to("open", { by: event.by }) : null)'),
      pushing('"ann" | "bob"', 'push: ({ event, to }) => to("open", { by: event.by || "ann" })'),
      change(DOOR, PUSH, 'push: ({ event, to }) => (event.by.length > 0 ? to("open", { by: event.by }) : null)'),
      savingIn(
        '          const parts = event.text.split(",").filter((p) => p !== "");\n          for (let i = 0; i < parts.length; i++) if (parts[i] === "") return null;\n          for (const p of parts) if (p === " ") return null;\n          return to("saving", { text: parts.join(",") });',
      ),
      savingIn(
        '          const seen: { [k: string]: number } = { [event.text]: 1 };\n          delete seen[event.text];\n          let i = 0;\n          for (const k in seen) i += k.length;\n          return i > 0 ? null : to("saving", { text: event.text });',
      ),
      savingIn(
        '          const parts = event.text.split(",");\n          for (let i = 0; i < 3; i++) if (parts[i] === "") return null;\n          for (let i = 0; i < parts.length; i += 2) if (parts[i] === "") parts.splice(0, 1);\n          const d = { text: parts.join(",") };\n          return to("saving", { text: d.text || "" });',
      ),
      keeps('({ data, event, keep, to }) => (event.text === "" ? to("idle") : keep("saving", { ...data }))'),
      saving("sizes", "number[]", 'event.text.split(",").map(Number).sort((a, b) => a - b)'),
      saving("cells", "string[]", 'Array.from({ length: 3 }, () => "")'),
      // A stay beside a move in a state with a task or a timer (the codemod's form of XState's stay),
      // a stay with new data, and a keep from a timer that raises (effects').
      change(
        JOB,
        'retry: ({ to }) => to("idle")',
        'retry: ({ data, keep, to }) => (data.error === "" ? to("idle") : keep("failed", { error: "again" }))',
      ),
      keeps('({ data, event, keep, to }) => (event.text === "" ? to("idle") : keep("saving", data))'),
      // The task's result to another state, and a dropped step's block that returns nothing (a type error).
      change(DOOR, LOCK, 'lock: ({ event, to }) => {\n          to("locked", { code: event.code });\n        }'),
    ])
      expect(problems(source)).toEqual([]);
  });

  test("use sites, components and tests", () => {
    for (const source of [
      `${LIST}const items = ["a"];\nactor.send({ type: "set", items: [...items] });\nitems.push("b");\n`,
      `${USE}window.addEventListener("message", (e) => {\n  if (e.origin !== "https://app.example") return;\n  actor.send({ type: "push", by: String(e.data) });\n});\nwindow.addEventListener("message", ({ origin, data }) => {\n  if (origin === "https://app.example") actor.send({ type: "push", by: String(data) });\n});\n`,
      `${USE}let current = createActor(doorMachine);\nexport function reset(): void {\n  current.stop();\n  current = createActor(doorMachine);\n}\n`,
      `${JOB_USE}import { waitFor } from "@reactre/state/utils";\n\nexport async function handle(text: string): Promise<boolean> {\n  const worker = createActor(jobMachine);\n  worker.send({ type: "save", text });\n  return (await waitFor(worker, (s) => s.state === "saved")).state === "saved";\n}\nexport async function stop(): Promise<void> {\n  const worker = createActor(jobMachine);\n  worker.stop();\n}\nexport const make = async () => {\n  const worker = createActor(jobMachine);\n  return worker;\n};\n`,
      `${TESTS}\nexport const paths = testPaths(doorMachine, { events: {} });\nconsole.info(createActor, jobMachine, SimulatedClock);\n`,
      `${USE}import { transition } from "@reactre/state";\nimport { waitFor } from "@reactre/state/utils";\nexport const next = transition(doorMachine, actor.snapshot(), { type: "push", by: "ann" });\nexport const opened = async (): Promise<void> => {\n  await waitFor(actor, (s) => s.state === "open");\n};\nexport function GET(req: Request): Response {\n  return new Response(req.url);\n}\n`,
      `${USE}export const props = {\n  onClick: () => actor.send({ type: "close" }),\n  onSubmit: (e: { preventDefault(): void }) => {\n    e.preventDefault();\n    actor.send({ type: "close" });\n  },\n};\n`,
      `${REACT}\nexport function Door(): () => void {\n  const [s, ref] = useActor(doorMachine);\n  const other = useActorRef(doorMachine);\n  const state = useSelector(other, (o) => o.state);\n  useEffect(() => ref.subscribe((next) => console.info(next.state, s.state, state)), [ref]);\n  return () => ref.send({ type: "close" });\n}\nfunction Wizard(): null {\n  useActor(doorMachine);\n  return null;\n}\nexport const wizard = Wizard;\n`,
      `${TESTS}\nexport function run(): void {\n  const clock = new SimulatedClock();\n  const actor = createActor(jobMachine, { now: clock.now });\n  actor.send({ type: "save", text: "a" });\n  clock.uninstall();\n  console.info(doorMachine, testPaths);\n}\n`,
    ])
      expect(problems(source)).toEqual([]);
  });

  test("M602: a form's onSubmit in JSX that sends without preventDefault", () => {
    const form = `${USE}export const Form = () => <form onSubmit={() => actor.send({ type: "close" })} />;\nexport const Kept = () => <form onSubmit={(e) => (e.preventDefault(), actor.send({ type: "close" }))} />;\n`;
    expect(problems(form, {}, "form.tsx").map((p) => p.split(":")[0])).toEqual(["6"]);
    expect(problems(form, {}, "form.tsx")[0]).toContain("an onSubmit that doesn't call preventDefault()");
  });
});

describe("static values: an immutable binding compiles as the value it holds", () => {
  // The migration of the cases that used to be restrictions: a state's name, a version, setup's
  // states and use, and keep's state, held in an immutable module binding, now compile. Each is
  // checked both ways: the compiler accepts it, and the compiled machine runs as the source does.
  const cases: readonly (readonly [name: string, source: string, contains: readonly string[]])[] = [
    [
      "a state's name in a variable",
      declare(change(DOOR, '({ to }) => to("closed") } }', "({ to }) => to(closed) } }"), 'const closed = "closed";'),
      ['"close": () => ({ state: "closed"'],
    ],
    [
      "a version in a variable",
      change(DOOR, "const door = setup({", "const VERSION = 2;\nconst door = setup({\n  version: VERSION,"),
      ["v: 2", "version: 2"],
    ],
    [
      "setup's states in a variable",
      change(
        change(DOOR, "const door = setup({\n  states: {", "const doorStates = {"),
        "locked: types<{ code: string }>() },\n",
        "locked: types<{ code: string }>() };\nconst door = setup({\n  states: doorStates,\n",
      ),
      // The hoisted map's `types<...>()` calls are dead metadata: each becomes `{}`, and the
      // import goes (a `types()` call at runtime throws).
      ["const doorStates = { closed: {}, open: {}, locked: {} };", "import { createActor }"],
    ],
    [
      "a namespace import beside the named ones",
      change(
        DOOR,
        'import { createActor, setup, types } from "@reactre/state";',
        'import * as S from "@reactre/state";\nimport { createActor, setup, types } from "@reactre/state";',
      ),
      ['import * as S from "@reactre/state";'],
    ],
    [
      "use in a variable",
      change(
        change(EDITOR, "use: [nested, history],", "use: FEATURES,"),
        "const editor = setup",
        "const FEATURES = [nested, history] as const;\nconst editor = setup",
      ),
      ["g: __reactreStateFlatGraph", "h: {", "y: __reactreStateFlatNested"],
    ],
    [
      "keep's state in a variable",
      change(
        keeps("({ event, keep }) => keep(SAVING, { text: event.text })"),
        "export const jobMachine",
        'const SAVING = "saving";\nexport const jobMachine',
      ),
      ['"save": (__0, event) => ({ state: "saving"'],
    ],
  ];
  test.each(cases)("%s compiles to the value it holds", (_, source, contains) => {
    const code = compile("machine.ts", source)?.code ?? "";
    for (const text of contains) expect(code).toContain(text);
  });

  test("the compiled machine runs as the source does, in dev and production", async () => {
    // The baseline the parent asked for: not only that it compiles, but that the machine it makes
    // behaves as the original source's does. Each case is written as a `.ts` fixture, loaded three
    // ways (the source through the plugin, and `compile`'s dev and production output), and the same
    // events are sent to each: the snapshots must match.
    // A folder of its own per run: the fixtures are imported by path, and Bun caches a module by
    // path, so a shared folder would hand back a machine from an earlier (or a concurrent) run.
    const dir = join(import.meta.dir, "out", `static-values-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, "node_modules", "@reactre"), { recursive: true });
    symlinkSync(join(import.meta.dir, ".."), join(dir, "node_modules", "@reactre", "state"));
    const { statePreload } = await import("../plugin/runtime.ts");
    Bun.plugin(statePreload({ filter: /out\/static-values-[^/]*\/.*-src\.ts$/ }));
    Bun.plugin({
      name: "@reactre/state (static-values)",
      setup(build) {
        build.onLoad({ filter: /out\/static-values-[^/]*\/.*-(dev|prod)\.ts$/ }, async ({ path }) => {
          const text = await Bun.file(path).text();
          const out = compile(path, text, { dev: path.endsWith("-dev.ts") });
          return { contents: out?.code ?? text, loader: "ts" };
        });
      },
    });
    const events = [
      { type: "push", by: "ann" },
      { type: "close" },
      { type: "lock", code: "1" },
      { type: "unlock", code: "2" },
      { type: "unlock", code: "1" },
    ] as const;
    const { createActor } = await import("@reactre/state");
    const run = async (file: string): Promise<unknown[]> => {
      const module: { doorMachine: Parameters<typeof createActor>[0] } = await import(file);
      const actor = createActor(module.doorMachine);
      const seen: unknown[] = [actor.snapshot()];
      for (const event of events) seen.push(actor.send(event));
      actor.stop();
      return seen;
    };
    // The cases whose machine is DOOR's (the others are EDITOR's or JOB's, with their own events).
    for (const [name, source] of cases.filter(([n]) => !n.includes("use in a variable") && !n.includes("keep's"))) {
      const base = name.replaceAll(/[^a-z]+/gi, "-");
      const files = ["src", "dev", "prod"].map((variant) => {
        const file = join(dir, `${base}-${variant}.ts`);
        writeFileSync(file, source);
        return file;
      });
      const [src, dev, prod] = await Promise.all(files.map(run));
      // The same snapshots and results, in the same order: the source is the baseline.
      expect(dev, name).toEqual(src);
      expect(prod, name).toEqual(src);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a static value's hash is the same however it is written, and changes with the value", () => {
    // A persisted shape's hash is of its contracts, not of how they are spelled: a version in a
    // variable hashes as the literal does, and a different value hashes differently.
    const note = (version: string): string =>
      `import { setup, types } from "@reactre/state";\nimport { persist } from "@reactre/state/persist";\n\nconst VERSION = ${version};\nconst note = setup({\n  use: [persist],\n  version: VERSION,\n  states: { draft: types<{ text: string }>() },\n  events: { send: types<{}>() },\n});\n`;
    const hashOf = (version: string): string =>
      /add shape: "(\w+)"/.exec(problems(note(version)).join("\n"))?.[1] ?? "";
    const literal = hashOf("2");
    expect(literal).toMatch(/^\w{8}$/);
    // The same value, written as a variable or an expression: the same hash.
    expect(hashOf("2")).toBe(literal);
    expect(hashOf("1 + 1")).toBe(literal);
    // A different value: a different hash.
    expect(hashOf("3")).not.toBe(literal);
    // A template is a string, not a number: the type checker's. The compiler passes it over and
    // hashes at the default version 0, so its hash is the version-0 one, not version 2's.
    expect(hashOf("`2`")).not.toBe(literal);
    expect(hashOf("`2`")).toBe(hashOf("0"));
  });

  test("a mutable binding, an ambient name and a dynamic value still fail closed", () => {
    // A `let` may change between the build and the run: the compiler can't know its value.
    expect(
      problems(
        change(DOOR, "const door = setup({", "let VERSION = 2;\nconst door = setup({\n  version: VERSION,"),
      ).join("\n"),
    ).toContain("version is a statically known nonnegative integer");
    // A name from nowhere (an ambient global) is not a value the compiler can read.
    expect(
      problems(
        declare(
          change(DOOR, '({ to }) => to("closed") } }', "({ to }) => to(closed) } }"),
          "declare const closed: string;",
        ),
      ).join("\n"),
    ).toContain("to's first argument must resolve statically from literals and module-level const bindings");
    // A call is dynamic: its result is not known at build time.
    expect(
      problems(
        change(DOOR, "const door = setup({", 'const VERSION = Number("2");\nconst door = setup({\n  version: VERSION,'),
      ).join("\n"),
    ).toContain("version is a statically known nonnegative integer");
  });
});

describe("calls, use sites and configs outside the cases", () => {
  test("M260: a shape's hash is of its contracts, however they are formatted, and changes with them", () => {
    const note = (contracts: string): string =>
      `import { setup, types } from "@reactre/state";\nimport { persist } from "@reactre/state/persist";\n\nconst note = setup({\n  use: [persist],\n${contracts}});\n`;
    const hashOf = (contracts: string): string =>
      /add shape: "(\w+)"/.exec(problems(note(contracts)).join("\n"))?.[1] ?? "";
    const written =
      '  states: { draft: types<{ text: string; tone: "plain" | "bold" }>(), sent: types<{ to: readonly string[] }>() },\n  events: { send: types<{ to: string }>() },\n  input: types<{ id: string }>(),\n';
    const formatted =
      '  input: types<{ id: string }>(),\n  events: { send: types<{ to: string; }>(), },\n  states: {\n    // the note being written\n    sent: types<{ to: readonly string[] }>(),\n    draft: types<{\n      text: string; /* as typed */\n      tone:\n        | "plain"\n        | "bold";\n    }>(),\n  },\n';
    expect(hashOf(written)).toMatch(/^\w{8}$/);
    expect(hashOf(formatted)).toBe(hashOf(written));
    expect(hashOf(written.replace('"bold"', '"bold" | "italic"'))).not.toBe(hashOf(written));
    expect(hashOf(written.replace("input: types<{ id: string }>(),\n", ""))).not.toBe(hashOf(written));
  });

  test("a package in the pure option may be called from a transition", () => {
    const source = imports(
      change(DOOR, "{ code: event.code }", '{ code: join(event.code, "x") }'),
      'import { join } from "node:path";',
    );
    expect(problems(source, { pure: ["node:path"] })).toEqual([]);
    expect(problems(source, { pure: ["node"] })).toHaveLength(1);
  });

  test("a module marked pure, its functions pure, compiles to nothing; one that isn't fails", () => {
    const pure = join(import.meta.dir, "compiler", "pure.ts");
    expect(compile(pure, readFileSync(pure, "utf8"))).toBeNull();
    // The mark is the first statement: after another one, it marks nothing, so nothing is checked.
    expect(compile(AT, 'export const f = () => Date.now();\n"use pure";\n')).toBeNull();
  });

  test("M77: a response passed to a function the compiler can't see isn't a look at its status", () => {
    // A package's function, or a relative import that doesn't resolve.
    for (const line of ['import { ensureOk } from "http-checks";', 'import { ensureOk } from "./nowhere.ts";'])
      expect(
        problems(imports(withRun(`async ({ data, signal }) => {\n${FETCHED}  ensureOk(res);\n${READ}`), line)),
      ).toEqual([
        "19:38 a response read without checking its status takes a 404 or 500 page as a success: check res.ok first, if (!res.ok) throw new Error(`HTTP ${res.status}`), and let the task's error decide",
      ]);
  });

  test("M75, M80: a task's own promises, awaited, voided or returned, and fetch's other options, pass", () => {
    const body = (lines: string) =>
      imports(
        withRun(
          `async ({ data, signal }) => {\n${lines}\n          return { type: "stored", id: data.text };\n        }`,
        ),
        'import { label, store } from "../compiler/store.ts";',
      );
    for (const lines of [
      "          await store(data.text);",
      "          void store(data.text);",
      "          label(data.text);",
      "          track(data.text);",
      "          queueMicrotask(() => {\n            store(data.text);\n          });",
      "          const init = { signal };\n          await fetch(data.text, init);",
      '          await fetch(data.text, { signal, method: "POST" });',
    ])
      expect(
        problems(
          change(body(lines), "export const jobMachine", "const track = (_: string) => {};\nexport const jobMachine"),
        ),
      ).toEqual([]);
    expect(problems(withRun('({ data }) => store(data.text).then((id) => ({ type: "stored" as const, id }))'))).toEqual(
      [],
    );
  });

  test("M49, M50, M52, M53, M308: sends, listeners and switches that are correct pass", () => {
    const lamp = `import { createActor, setup, types } from "@reactre/state";
import { useActor, useActorRef } from "@reactre/state/react";
import { waitFor } from "@reactre/state/utils";

const lamp = setup({ states: { off: types<{}>(), on: types<{}>() }, events: { flip: types<{}>(), dim: types<{}>() } });
export const lampMachine = lamp.machine({
  start: ({ to }) => to("off"),
  states: { off: { on: { flip: ({ to }) => to("on") } }, on: { on: { flip: ({ to }) => to("off"), dim: ({ to }) => to("on") } } },
});
export const actor = createActor(lampMachine);
`;
    for (const tail of [
      // M49: every state handles it; its result read, or dropped on purpose; an event not written in place.
      'actor.send({ type: "flip" });',
      'const result = actor.send({ type: "dim" });\nif (!result.ok) console.info(result.reason);',
      'void actor.send({ type: "dim" });',
      'export const send = (type: "dim" | "flip") => {\n  actor.send({ type });\n  actor.send({ type: \'flip\' as const });\n};',
      "export function Lamp() {\n  const whole = useActor(lampMachine);\n  const [snapshot] = useActor(lampMachine);\n  return [whole, snapshot];\n}",
      // M50: a stop in a cleanup, a send before it, its result read after it, another object's stop.
      'export const cleanup = () => () => actor.stop();\nactor.send({ type: "flip" });',
      'actor.send({ type: "flip" });\nactor.stop();',
      'actor.stop();\nconsole.info(actor.send({ type: "flip" }).ok);',
      'const timer = { stop() {} };\ntimer.stop();\nactor.send({ type: "flip" });',
      "actor.stop();\nsetTimeout(console.info, 0);",
      'export function restart(): void {\n  let a = createActor(lampMachine);\n  a.stop();\n  a = createActor(lampMachine);\n  a.send({ type: "flip" });\n}',
      // M52: a listener that catches, or throws only from a function of its own; another object's subscribe.
      'actor.subscribe((s) => {\n  try {\n    if (s.state === "on") throw new Error("x");\n  } catch (error) {\n    console.error(error);\n  }\n});',
      'actor.subscribe(() => {\n  const fail = () => {\n    throw new Error("x");\n  };\n  console.info(fail);\n});',
      'const store = { subscribe: (f: () => void) => f };\nstore.subscribe(() => {\n  throw new Error("x");\n});',
      // M53: waitFor, and a send's result awaited from something that isn't an actor.
      'export async function flip(): Promise<string> {\n  actor.send({ type: "flip" });\n  return (await waitFor(actor, (s) => s.state === "on")).state;\n}',
      // M308: every state, the default a check that none is left; no default; another object's state.
      'export function label(s: ReturnType<typeof actor.snapshot>): string {\n  switch (s.state) {\n    case "on":\n      return "on";\n    case "off":\n      return "off";\n    default: {\n      const left: never = s;\n      return left;\n    }\n  }\n}',
      'export function label(s: ReturnType<typeof actor.snapshot>): string {\n  switch (s.state) {\n    case "on":\n      return "on";\n    case "off":\n      return "off";\n  }\n}',
      'const job = { state: "x" as string, count: 1 };\nswitch (job.state) {\n  default:\n    console.info(job.count);\n}\nswitch (actor.snapshot()["state"]) {\n  default:\n}',
    ])
      expect([tail, problems(`${lamp}${tail}\n`)]).toEqual([tail, []]);
    // An actor's send of an event the other state doesn't handle, by each way an actor is made.
    const component = `${lamp}export function Lamp() {\n  const [, ref] = useActor(lampMachine);\n  ref.send({ type: "dim" });\n  const other = useActorRef(lampMachine);\n  other.send({ type: "dim" });\n}\n`;
    // (A send in a component's body is a mistake of its own, M593's.)
    const sends = problems(component).filter((p) => !p.includes("in a component's body"));
    expect(sends.map((p) => p.split(" does nothing")[0])).toEqual([
      '13:3 ref.send({ type: "dim" })',
      '15:3 other.send({ type: "dim" })',
    ]);
    // A machine with a feature in use: a parent, or another feature, may handle what its leaves don't.
    expect(problems(`${withUse(["tags"], DOOR)}actor.send({ type: "close" });\n`)).toEqual([]);
    // A listener's throw from its finally.
    expect(
      problems(
        `${USE}actor.subscribe(() => {\n  try {\n    console.info(1);\n  } catch {\n    console.info(2);\n  } finally {\n    throw new Error("x");\n  }\n});\n`,
      ),
    ).toEqual([
      "12:5 a listener that throws makes send throw: the other listeners still run, then actor.send(...) throws this error to whoever sent the event, after the transition is made. Handle the failure in the listener: try { ... } catch (error) { console.error(error) }",
    ]);
  });

  test("M311: createActor in a component makes an actor on every render", () => {
    const component = `import { createActor } from "@reactre/state";
import { doorMachine } from "./door.ts";

export function Door() {
  const actor = createActor(doorMachine);
  return <button onClick={() => actor.send({ type: "close" })}>close</button>;
}

export function Kept({ make }: { make: (f: () => unknown) => unknown }) {
  make(() => createActor(doorMachine));
  return <i />;
}
`;
    expect(problems(component, {}, "door.tsx")).toEqual([
      "5:17 createActor in a component makes a new actor on every render, and nothing stops it: use useActor(machine) from @reactre/state/react, which keeps one actor and stops it on unmount",
    ]);
  });

  test("M306: a machine in a JavaScript file, or under a tsconfig that turns strict off", () => {
    const js = `import { setup, types } from "@reactre/state";
const lamp = setup({ states: { off: types(), on: types() }, events: { flip: types() } });
export const lampMachine = lamp.machine({
  start: ({ to }) => to("off"),
  states: { off: { on: { flip: ({ to }) => to("on") } }, on: { on: { flip: ({ to }) => to("off") } } },
});
`;
    for (const file of ["lamp.js", "lamp.jsx", "lamp.mjs"])
      expect(problems(js, {}, file)).toEqual([
        "1:1 a machine in a JavaScript file has no type checks, and its contracts are types: rename the file to .ts (or .tsx)",
      ]);
    expect(problems(DOOR, {}, join(import.meta.dir, "compiler", "loose", "door.ts"))).toEqual([
      '1:1 the tsconfig.json for this file turns strict off, and with it the type checks a machine\'s contracts need: set "strict": true',
    ]);
    // A file with no tsconfig.json above it is left to the type checker it runs under.
    expect(problems(DOOR, {}, "/door.ts")).toEqual([]);
  });
});

// #region core-B: the shape hash (compiler/hash.ts: M553, M554), the tsconfig's flags
// (compiler/modules.ts: M500, M579, M580), and the features' file-level checks
// (compiler/features/*.ts) quiet on the correct forms of their mistakes. The checks' cases are in
// ./features/<feature>/compiler.ts.

describe("core-B: the shape hash, the tsconfig's flags, and correct code beside the machines", () => {
  /** DOOR, persisted, without its hash: the build asks for it. */
  const UNHASHED = change(withUse(["persist"], DOOR), '  shape: "kq4c4nj6",\n', "");
  /** The hash the build asks `source` (persisted, without one) for. */
  const hashOf = (source: string): string => /add shape: "(\w+)"/.exec(problems(source).join("\n"))?.[1] ?? "none";
  /** UNHASHED with `push`'s payload a named type, `declaration` (before setup). */
  const named = (declaration: string, imports = ""): string =>
    change(
      change(
        change(UNHASHED, "push: types<{ by: string }>()", "push: types<Push>()"),
        "const door = setup(",
        `${declaration}\nconst door = setup(`,
      ),
      'import { createActor, setup, types } from "@reactre/state";\n',
      `import { createActor, setup, types } from "@reactre/state";\n${imports}`,
    );

  test("M554: a named type in a contract is followed to its declaration, in the file or a relative import", () => {
    const push = hashOf(named("type Push = { by: string };"));
    // Its declaration changed: the hash changes, and a kept hash fails the build.
    expect(hashOf(named("type Push = { by: string; force: boolean };"))).not.toBe(push);
    expect(hashOf(named("interface Push { readonly by: string }"))).not.toBe(push);
    const kept = change(
      named("type Push = { by: string; force: boolean };"),
      "  use: [persist],\n",
      `  use: [persist],\n  shape: "${push}",\n`,
    );
    expect(problems(kept).join("\n")).toContain("the shape of door no longer matches its hash");
    // Followed through a name it names, and into a relative import: the same text is the same hash.
    expect(hashOf(named("type By = string;\ntype Push = { by: By };"))).toBe(
      hashOf(named("type By = string;\ntype Push = { by: By };")),
    );
    expect(hashOf(named("type By = number;\ntype Push = { by: By };"))).not.toBe(
      hashOf(named("type By = string;\ntype Push = { by: By };")),
    );
    const issue = readFileSync(join(import.meta.dir, "fixtures", "standard-schema.ts"), "utf8");
    const declared = /export (interface Issue \{[\s\S]*?\n\})/.exec(issue)?.[1] ?? "";
    const imported = hashOf(
      named("type Push = Issue;", 'import type { Issue } from "../fixtures/standard-schema.ts";\n'),
    );
    expect(declared).not.toBe("");
    expect(imported).toBe(hashOf(named(`${declared}\ntype Push = Issue;`)));
    // A package's type can't be read, nor a file that isn't there: only the name counts.
    const unread = hashOf(named("type Push = Issue;", 'import type { Issue } from "some-package";\n'));
    expect(unread).not.toBe(imported);
    expect(hashOf(named("type Push = Issue;", 'import type { Issue } from "./missing.ts";\n'))).toBe(unread);
    // A value's type (`typeof`) is followed to the const.
    const typed = (value: string): string =>
      change(named(`const Pushed = ${value};`), "push: types<Push>()", "push: types<typeof Pushed>()");
    expect(hashOf(typed('{ by: "a" }'))).not.toBe(hashOf(typed('{ by: "a", force: true }')));
  });

  test("item 6: a literal's members in another order are the same contract, and the same hash", () => {
    const two = (members: string): string =>
      change(UNHASHED, "open: types<{ by: string }>()", `open: types<{ ${members} }>()`);
    expect(hashOf(two("by: string; at: number"))).toBe(hashOf(two("at: number; by: string")));
    expect(hashOf(named("type Push = { by: string; at?: number };"))).toBe(
      hashOf(named("type Push = {\n  at?: number;\n  by: string;\n};")),
    );
    expect(hashOf(two("by: string; at: number"))).not.toBe(hashOf(two("by: string; at: string")));
  });

  test("M553: the hash covers each node's work: its timers, its task, its children", () => {
    const job = change(JOB, "const job = setup({\n", "const job = setup({\n  use: [persist],\n");
    const persisted = change(
      job,
      'from "@reactre/state";\n',
      'from "@reactre/state";\nimport { persist } from "@reactre/state/persist";\n',
    );
    const base = hashOf(persisted);
    const timers = (after: string): string =>
      change(persisted, 'after: { "1.5s": ({ to }) => to("failed", { error: "timed out" }) },', after);
    expect(hashOf(timers(""))).not.toBe(base);
    const a = timers(
      'after: { "1.5s": ({ to }) => to("failed", { error: "timed out" }), "1h": ({ to }) => to("failed", { error: "late" }) },',
    );
    const b = timers(
      'after: { "1h": ({ to }) => to("failed", { error: "late" }), "1.5s": ({ to }) => to("failed", { error: "timed out" }) },',
    );
    expect(hashOf(a)).not.toBe(base);
    // A durable run's timer ids are their delays: the order of the keys doesn't change the work.
    expect(hashOf(a)).toBe(hashOf(b));
    // A task taken away is other work: a run saved while it ran expects it.
    expect(hashOf(change(persisted, "      task: {\n", "      tusk: {\n"))).not.toBe(base);
  });

  test("M500, M579, M580: a tsconfig without the flags a machine's checks lean on", () => {
    const at = (dir: string): string => join(import.meta.dir, "compiler", "flags", dir, "door.ts");
    expect(problems(DOOR, {}, at("fallthrough"))).toEqual([
      '1:1 the tsconfig.json for this file lacks noFallthroughCasesInSwitch: set "noFallthroughCasesInSwitch": true, a switch in a transition needs it',
    ]);
    expect(problems(DOOR, {}, at("indexed"))).toEqual([
      '1:1 the tsconfig.json for this file lacks noUncheckedIndexedAccess: set "noUncheckedIndexedAccess": true, an index read in a transition needs it',
    ]);
    expect(problems(DOOR, {}, at("catch"))).toEqual([
      "1:1 the tsconfig.json for this file turns useUnknownInCatchVariables off: remove \"useUnknownInCatchVariables\": false, the error's type in a task's catch needs it",
    ]);
    // The repository's own config has them all.
    expect(problems(DOOR)).toEqual([]);
  });

  test("the features' file-level checks pass the correct forms of their mistakes", () => {
    for (const correct of [
      HANDLE,
      store(""),
      store(`window.addEventListener("visibilitychange", () => {
  try {
    localStorage.setItem("order", JSON.stringify(persist(actor)));
  } catch {
    // storage full: keep running
  }
});
export function restore(): void {
  try {
    restoreActor(orderMachine, migrate(JSON.parse(localStorage.getItem("order") ?? "null")));
  } catch {
    // a bad value: start fresh
  }
}`),
      POOL,
      CANCELS,
      NAMED,
      steps(
        "const out: string[] = [];",
        "for (const id of ids) out.push(await enq.step(`load-${id}`, () => fetch(`/items/${id}`, { signal }).then((r) => r.text())));",
        'const at = await enq.step("clock", () => Date.now());',
        'if (at > input.at) await enq.step("charge", () => fetch("/charge", { method: "POST", signal }));',
        'await fetch("/audit", { method: "POST", signal, headers: { "Idempotency-Key": input.id } });',
        // A date from the data reads no clock.
        "await enq.step(`day-${new Date(input.at).toISOString()}`, () => input.id);",
        "return out;",
      ),
      // A catchError that falls back to another stream: no failure is turned into completion.
      made(`declare const ticks$: { pipe<T>(op: (s: Subscribable<number>) => Subscribable<T>): Subscribable<T> };
declare const cached$: Subscribable<number>;
declare function catchError<T>(f: (error: unknown) => Subscribable<T>): (s: Subscribable<number>) => Subscribable<number | T>;
export const ticks = createObservableLogic(() => ticks$.pipe(catchError(() => cached$)));`),
    ])
      expect(problems(correct)).toEqual([]);
  });
});

// #endregion

// The compiler adds what the type checker can't see; it doesn't repeat it. So every case above
// must pass `bun check`: a mistake the type checker reports belongs in a mistakes.ts.
test("no compiler case is also a type error", () => {
  const dir = join(import.meta.dir, "out");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), `{ "extends": "../tsconfig.json", "include": ["."] }\n`);
  const names = new Map<string, string>();
  for (const [group, cases] of groups)
    cases.forEach(([name, source], i) => {
      const file = `${group.replaceAll(" ", "-")}-${i}.ts`;
      names.set(file, `${group}: ${name}`);
      writeFileSync(join(dir, file), source);
    });
  const run = Bun.spawnSync(["bun", "check", "-p", join(dir, "tsconfig.json"), "--no-pretty"]);
  const said = run.stdout.toString() + run.stderr.toString();
  expect(said).toMatch(/checked \d+ files/);
  const both = new Set<string>();
  for (const line of said.split("\n")) {
    const m = /([\w-]+\.ts)\(\d+,\d+\): error (TS\d+)/.exec(line);
    // Unused names are the repo's lint, not a contract.
    if (m === null || ["TS6133", "TS6192", "TS6196", "TS6198"].includes(m[2]!)) continue;
    const name = names.get(m[1]!);
    if (name !== undefined)
      both.add(`${name} (${line.slice(line.indexOf("error ") + 6, line.indexOf("error ") + 160)})`);
  }
  rmSync(dir, { recursive: true, force: true });
  expect([...both]).toEqual([]);
});

/**
 * A mistakes.ts as an app writes it, for the compiler: its imports from ../src by their entries,
 * and each setup the value of a module-level const, with its states and events in place (the
 * compiler refuses any other shape, and then checks none of its machines). Lines stay where they are.
 */
function asApp(file: string, source: string): string {
  const text = source.replace(/"(?:\.\.\/)+src\/(?:entries\/)?([\w/]+?)(?:\/index)?\.ts"/g, (_, entry: string) =>
    entry === "index" ? '"@reactre/state"' : `"@reactre/state/${entry}"`,
  );
  const { program } = parseSync(file, text, { lang: "ts", sourceType: "module", preserveParens: false });
  // The module-level object literals, one line each, for setup's shorthand `states` and `events`.
  const objects = new Map<string, string>();
  for (const s of program.body)
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations)
        if (d.id.type === "Identifier" && d.init?.type === "ObjectExpression")
          objects.set(d.id.name, text.slice(d.init.start, d.init.end).replace(/\s+/g, " "));
  const isSetup = (n: Node): n is CallExpression =>
    n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "setup";
  const inPlace = (call: CallExpression): string => {
    let out = text.slice(call.start, call.end);
    const arg = call.arguments[0];
    if (arg?.type !== "ObjectExpression") return out;
    for (const p of [...arg.properties].reverse())
      if (p.type === "Property" && p.shorthand && p.key.type === "Identifier" && objects.has(p.key.name))
        out = `${out.slice(0, p.start - call.start)}${p.key.name}: ${objects.get(p.key.name)}${out.slice(p.end - call.start)}`;
    return out;
  };
  const edits: { start: number; end: number; text: string }[] = [];
  let shapes = 0;
  for (const top of program.body)
    walk(top, (node, parent) => {
      if (!isSetup(node)) return true;
      const statement = top.type === "ExpressionStatement" && top.expression === node;
      if (parent?.type === "VariableDeclarator" || statement) {
        if (statement) edits.push({ start: top.start, end: top.start, text: `const __shape${shapes++} = ` });
        edits.push({ start: node.start, end: node.end, text: inPlace(node) });
      } else {
        // `setup({ ... }).machine({ ... })`: the shape first, on the statement's line.
        const name = `__shape${shapes++}`;
        edits.push({ start: top.start, end: top.start, text: `const ${name} = ${inPlace(node)}; ` });
        edits.push({ start: node.start, end: node.end, text: name });
      }
      return false;
    });
  let out = "";
  let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/**
 * What the compiler is right to report in a type case's file: a separate mistake, which a case's
 * code makes beside its own, or what the build adds. Each is the file (or every file, ""), the
 * line's code, the problem, and why it isn't the type checker's.
 */
const SEPARATE: readonly (readonly [file: string, code: string, problem: string, why: string])[] = [
  [
    "mistakes.ts",
    'to("open", extraKeys)',
    "extraKeys is a module-level object",
    "case 32's variable is module-level, so the data is shared by every actor; its extra key is the type checker's",
  ],
  [
    "mistakes.ts",
    'actor.send({ type: "push"',
    'actor.send({ type: "push" }) does nothing in',
    "the cases' payloads are the type checker's (M44–M46); each send drops its result where open and locked don't handle push, a separate mistake (M49)",
  ],
  [
    "mistakes.ts",
    "(await fetch(data.id, { signal })).json()",
    "a response read without checking its status",
    "M78's task reads the body before a look at the status; the any it parses is the type checker's",
  ],
  [
    "features/provide/mistakes.ts",
    "",
    "records an effect before the handler may return null",
    "the handler records its effects, then may decline; the actions' params are the type checker's",
  ],
  [
    "features/spawn/mistakes.ts",
    'enq.subscribeTo("worker", { done: "seen" })',
    'every "worker" is spawned with a key',
    "the case's report event is the type checker's; that it subscribes without the key every spawn of worker passes is a separate mistake (M536)",
  ],
  [
    "features/durable/mistakes.ts",
    'run.resume(JSON.parse("{}"))',
    "`run.resume` isn't awaited",
    "M558's snapshot typed any is the type checker's; that the resume's promise is dropped is a separate mistake (M565)",
  ],
  [
    "features/persist/mistakes.ts",
    'processEvent(cartMachine, row.snapshot, { type: "close" }, { input: { id: "a" } })',
    "the stored value isn't migrated",
    "M559's unparsed text is the type checker's; parsed, it still isn't passed through the file's migrations, a separate mistake (M567)",
  ],
  [
    "",
    "",
    "'s result is dropped: it is pure",
    "a type case calls a pure function as a statement for its arguments' error; dropping the result is a separate mistake (M591)",
  ],
  [
    "mistakes.ts",
    'type: ({ event, keep }) => keep("loading", { q: event.q })',
    "which the running task read when it started",
    "M87's machine fixed with keep, which its message offers: keep's new query the running task never read is a separate mistake (M477)",
  ],
  [
    "",
    "",
    "is persisted, so its shape is checked: add shape",
    "a persisted shape's hash is the build's, which a file of type cases doesn't carry",
  ],
];

// The other way: a mistake the type checker reports (a `@ts-expect-error` case in a mistakes.ts)
// is its alone, so the compiler reports nothing in those files but their suppressions and what
// SEPARATE lists. The whole file counts, not only a case's line: the type checker reports a
// machine's problem where it's used (`createActor(bare)`), the compiler where it's written
// (`after: { 5000: ... }`).
test("no type case is also a compiler problem", () => {
  const files = ["mistakes.ts", ...new Glob("features/*/mistakes.ts").scanSync(import.meta.dir)].sort();
  const used = new Set<(typeof SEPARATE)[number]>();
  const both: string[] = [];
  for (const file of files) {
    const path = join(import.meta.dir, file);
    const source = asApp(path, readFileSync(path, "utf8"));
    const lines = source.split("\n");
    let found: readonly { readonly line: number; readonly message: string }[] = [];
    try {
      compile(path, source);
    } catch (e) {
      if (!(e instanceof StateCompileError)) throw e;
      found = e.problems;
    }
    for (const { line, message } of found) {
      if (message.startsWith("a @ts- suppression in a file with machines")) continue;
      const code = lines[line - 1] ?? "";
      const separate = SEPARATE.find(
        ([f, c, problem]) => (f === "" || f === file) && code.includes(c) && message.includes(problem),
      );
      if (separate !== undefined) used.add(separate);
      else both.push(`${file}:${line}: ${code.trim()}\n  ${message}`);
    }
  }
  expect(both).toEqual([]);
  // Each exception still holds: one that no longer does is removed.
  expect(SEPARATE.filter((s) => !used.has(s)).map(([f, c]) => `${f} ${c}`)).toEqual([]);
});
