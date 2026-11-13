// The compiler's static evaluator (compiler/values.ts), driven through `compile()`: what a machine
// may write where the compiler needs a value at build time (a state name, a version, a feature
// list), and what it refuses. Every case is a real machine: the value is read back from the table
// the compiler emits, or from the problem it reports. Nothing here reaches into the evaluator's
// internals, so a change to how it is written is free as long as the compiled result holds.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile, StateCompileError } from "@reactre/state/compiler";

import { DOOR, JOB } from "./sources.ts";

/** The problems `compile` reports for `source`, as "line:column message"; empty when it compiles. */
function problems(source: string, file = "machine.ts"): string[] {
  try {
    compile(file, source);
  } catch (e) {
    if (e instanceof StateCompileError) return e.problems.map((p) => `${p.line}:${p.column} ${p.message}`);
    throw e;
  }
  return [];
}

/** The version the table carries, or null when the machine didn't compile. */
function version(expr: string): number | null {
  const source = DOOR.replace("const door = setup({", `const V = ${expr};\nconst door = setup({\n  version: V,`);
  try {
    const code = compile("machine.ts", source)?.code ?? "";
    const found = /v: (\d+)/.exec(code);
    return found === null ? null : Number(found[1]);
  } catch {
    return null;
  }
}

/** The state `start` goes to, or null when the machine didn't compile. */
function start(expr: string, before = ""): string | null {
  const source = DOOR.replace("const door = setup({", `${before}\nconst door = setup({`).replace(
    'start: ({ to }) => to("closed")',
    `start: ({ to }) => to(${expr})`,
  );
  try {
    const code = compile("machine.ts", source)?.code ?? "";
    return /state: "([^"]*)"/.exec(code)?.[1] ?? null;
  } catch {
    return null;
  }
}

describe("a value the compiler reads at build time", () => {
  test("a template is a string, with or without expressions", () => {
    expect(start("`closed`")).toBe("closed");
    expect(start("`clo${'sed'}`")).toBe("closed");
    // A number in a template is its string: the version is a string, so it is not a version.
    expect(version("`2`")).toBeNull();
    expect(version("`${2}`")).toBeNull();
  });

  test("a unary operator: a sign on a number, a negation of a known value", () => {
    expect(version("-(-2)")).toBe(2);
    expect(version("+2")).toBe(2);
    expect(version("!0 ? 2 : 0")).toBe(2);
    expect(version("!1 ? 0 : 2")).toBe(2);
    expect(version("!'' ? 2 : 0")).toBe(2);
    expect(version("!null ? 2 : 0")).toBe(2);
    // `!undefined` is not a value the compiler knows: `undefined` is known, but a negation of it
    // is not a number, and the version needs one.
    expect(version("!undefined")).toBeNull();
  });

  test("arithmetic, comparison and equality on numbers", () => {
    expect(version("1 + 1")).toBe(2);
    expect(version("3 - 1")).toBe(2);
    expect(version("1 * 2")).toBe(2);
    expect(version("4 / 2")).toBe(2);
    expect(version("5 % 3")).toBe(2);
    expect(version("2 ** 1")).toBe(2);
    expect(version("1 < 2 ? 2 : 0")).toBe(2);
    expect(version("2 <= 2 ? 2 : 0")).toBe(2);
    expect(version("3 > 2 ? 2 : 0")).toBe(2);
    expect(version("2 >= 2 ? 2 : 0")).toBe(2);
    expect(version("1 === 1 ? 2 : 0")).toBe(2);
    expect(version("1 !== 2 ? 2 : 0")).toBe(2);
    expect(version("'a' === 'a' ? 2 : 0")).toBe(2);
  });

  test("a division or a remainder by zero, and a number that overflows, are not known", () => {
    expect(version("1 / 0")).toBeNull();
    expect(version("1 % 0")).toBeNull();
    expect(version("2 ** 2000")).toBeNull();
    expect(version("-1e400")).toBeNull();
  });

  test("a logical operator takes the side it would at runtime", () => {
    expect(version("1 || 2")).toBe(1);
    expect(version("0 || 2")).toBe(2);
    expect(version("1 && 2")).toBe(2);
    expect(version("0 && 2")).toBe(0);
    expect(version("null ?? 2")).toBe(2);
    expect(version("1 ?? 2")).toBe(1);
    // The right side is only read when the left doesn't decide: an unknown right is fine then.
    expect(version("1 || undefined")).toBe(1);
    // `undefined ?? 2` is not known: `undefined` is, but the operator's left is not a value.
    expect(version("undefined ?? 2")).toBeNull();
  });

  test("a conditional takes the branch its test picks", () => {
    expect(version("true ? 2 : 0")).toBe(2);
    expect(version("false ? 0 : 2")).toBe(2);
    expect(version("undefined ? 2 : 0")).toBeNull();
    expect(version("true ? undefined : 0")).toBeNull();
  });

  test("a string concatenation, on either side", () => {
    expect(start("'clo' + 'sed'")).toBe("closed");
    expect(start("'1' + 1")).toBe("11");
    expect(start("1 + '1'")).toBe("11");
    expect(start("'1' + true")).toBe("1true");
    // A number plus a boolean or null is not a string and not a number: not known.
    expect(version("1 + true")).toBeNull();
    expect(version("1 + null")).toBeNull();
    expect(start("'1' + null")).toBeNull();
    expect(start("'1' + undefined")).toBeNull();
  });

  test("a member of an object or an array literal, by name or by index", () => {
    expect(start("({ a: 'closed' }).a")).toBe("closed");
    expect(start("({ a: 'closed' })['a']")).toBe("closed");
    expect(start("['closed'][0]")).toBe("closed");
    expect(start("({ 0: 'closed' })[0]")).toBe("closed");
    expect(start("({ a: { b: 'closed' } }).a.b")).toBe("closed");
    expect(start("[['closed']][0][0]")).toBe("closed");
    expect(start("({ a: ['closed'] }).a[0]")).toBe("closed");
    // A computed key that is a known string is the same as a written one.
    expect(start("({ ['a']: 'closed' }).a")).toBe("closed");
  });

  test("a member of a member: the first read's value, then its property", () => {
    // `X.a` is a member expression, so its result keeps that node: the second read takes the value
    // the first computed, not a literal's shape.
    expect(start("X.a.b", 'const X = { a: { b: "closed" } };')).toBe("closed");
    expect(start("X.a[0]", 'const X = { a: ["closed"] };')).toBe("closed");
    expect(start("X.a.c", 'const X = { a: { b: "closed" } };')).toBeNull();
    expect(start("X.a['x']", 'const X = { a: ["closed"] };')).toBeNull();
    expect(start("X.a[5]", 'const X = { a: ["closed"] };')).toBeNull();
  });

  test("a member whose owner is itself a member: the computed value, then its property", () => {
    // The first read's owner isn't a literal (a conditional), so its result keeps the member
    // expression as its node: the second read takes the value the first computed, not a literal's
    // shape, and checks the property against that value.
    expect(start("(true ? { b: { c: 'closed' } } : {}).b.c")).toBe("closed");
    expect(start("(true ? { b: { c: 'closed' } } : {}).b.d")).toBeNull();
    expect(start("(true ? { b: ['closed'] } : {}).b[0]")).toBe("closed");
    expect(start("(true ? { b: ['closed'] } : {}).b[5]")).toBeNull();
    expect(start("(true ? { b: ['closed'] } : {}).b['x']")).toBeNull();
  });

  test("a member of a value that isn't a literal: the value's own object, then its property", () => {
    // The owner is a conditional's result, not an object literal: the evaluator reads the value it
    // computed, then the property from it.
    expect(start("(true ? { b: 'closed' } : {}).b")).toBe("closed");
    expect(start("(true ? ['closed'] : [])[0]")).toBe("closed");
    // The second read is checked as the first is: a missing key, a bad index, a missing element.
    expect(start("(true ? { b: 'closed' } : {}).c")).toBeNull();
    expect(start("(true ? ['closed'] : [])['x']")).toBeNull();
    expect(start("(true ? ['closed'] : [])[5]")).toBeNull();
  });

  test("member reads through a retained literal: arrays and objects", () => {
    // Every statically known object or array retains its defining literal, through a const,
    // conditional or another member read: a later member is selected from that expression.
    expect(start("X['a'].b[0]", 'const X = { a: { b: ["closed"] } };')).toBe("closed");
    expect(start("X['a'].b['x']", 'const X = { a: { b: ["closed"] } };')).toBeNull();
    expect(start("X['a'].b[5]", 'const X = { a: { b: ["closed"] } };')).toBeNull();
    expect(start("X['a'].b.c", 'const X = { a: { b: { c: "closed" } } };')).toBe("closed");
    expect(start("X['a'].b.d", 'const X = { a: { b: { c: "closed" } } };')).toBeNull();
    expect(start("X['a'].b.c", "const X = { a: { b: { c: undefined } } };")).toBeNull();
    // A private identifier is not a noncomputed property name the evaluator executes.
    expect(start("X.#a", 'const X = { a: "closed" };')).toBeNull();
    // A computed private property has an expression, not a statically known string key.
    expect(start("({ [X.#a]: 'closed' })", 'const X = { a: "a" };')).toBeNull();
    // An uncomputed template literal is not a static property-name form either.
    expect(start("({ `a`: 'closed' })")).toBeNull();
    expect(start("X.a.b[0]", 'const X = { a: { b: ["closed"] } };')).toBe("closed");
    // A non-index key and an element past the end are not known.
    expect(start("X.a.b['x']", 'const X = { a: { b: ["closed"] } };')).toBeNull();
    expect(start("X.a.b[5]", 'const X = { a: { b: ["closed"] } };')).toBeNull();
    expect(start("X.a.b.c", 'const X = { a: { b: { c: "closed" } } };')).toBe("closed");
    // A key the value doesn't have, and a value that is `undefined`, are not known.
    expect(start("X.a.b.d", 'const X = { a: { b: { c: "closed" } } };')).toBeNull();
    expect(start("X.a.b.c", "const X = { a: { b: { c: undefined } } };")).toBeNull();
    // An owner that is `null` is not an object to read from.
    expect(start("(true ? null : { a: 'closed' }).a")).toBeNull();
  });

  test("a member that isn't there, or isn't a value, is not known", () => {
    expect(start("({ a: 'closed' }).b")).toBeNull();
    expect(start("['closed'][5]")).toBeNull();
    expect(start("['closed']['x']")).toBeNull();
    // An index with a leading zero is not an array index.
    expect(start("['closed']['01']")).toBeNull();
    expect(start("(2).a")).toBeNull();
    expect(start("undefined.a")).toBeNull();
    expect(start("({ a: undefined }).a")).toBeNull();
    expect(start("[undefined][0]")).toBeNull();
    expect(start("({ a: 'closed' })[undefined]")).toBeNull();
  });

  test("a member named for the prototype chain is refused, not read", () => {
    expect(start("({}).__proto__")).toBeNull();
    expect(start("({}).constructor")).toBeNull();
    expect(start("({}).prototype")).toBeNull();
    expect(start("({ __proto__: 'closed' })")).toBeNull();
    expect(start("({ constructor: 'closed' })")).toBeNull();
    expect(start("({ prototype: 'closed' })")).toBeNull();
  });

  test("an object literal: written keys, computed keys, and a method", () => {
    expect(start("({ 'a': 'closed' }).a")).toBe("closed");
    expect(start("({ ['a']: 'closed' }).a")).toBe("closed");
    expect(start("({ 1: 'closed' })[1]")).toBe("closed");
    // A method has no static value: the object is known, the method's value is not.
    expect(start("({ a() { return 'closed' } }).a")).toBeNull();
    // A getter is not an `init` property: the whole object is not known.
    expect(start("({ get a() { return 'closed' } }).a")).toBeNull();
    // A computed key that isn't known leaves the object unknown.
    expect(start("({ [undefined]: 'closed' })")).toBeNull();
  });

  // An open limit, not a regression: a member read through a spread literal doesn't resolve, because
  // the evaluator keeps the literal's own shape rather than the merged value. Pinned so a change to
  // it is deliberate.
  test("a spread of a known object or array is merged; anything else is not known", () => {
    expect(start("({ ...{ a: 'closed' } }).a")).toBeNull();
    expect(start("[...['closed']][0]")).toBeNull();
    // The spread's own value is known, but a member of the spread object is not: the evaluator
    // keeps the literal's shape, not the merged value, for a member read.
    expect(start("({ ...{ a: 1 }, ...{ b: 2 } }).b")).toBeNull();
    expect(start("[...[1], ...[2]][1]")).toBeNull();
    // A spread of something that isn't an object, or isn't known, is not known.
    expect(start("({ ...2 })")).toBeNull();
    expect(start("({ ...[1] })")).toBeNull();
    expect(start("({ ...undefined })")).toBeNull();
    expect(start("[...2]")).toBeNull();
    expect(start("[...undefined]")).toBeNull();
  });

  test("an array with a hole is not known", () => {
    expect(start("[, 'closed'][1]")).toBeNull();
  });

  test("a literal that isn't JSON: a bigint, a regex", () => {
    expect(start("2n")).toBeNull();
    expect(start("/x/")).toBeNull();
  });

  test("an operator the evaluator doesn't compute is not known", () => {
    expect(start("void 0")).toBeNull();
    expect(start("typeof 1")).toBeNull();
    expect(start("1 & 1")).toBeNull();
    expect(start("'a' in {}")).toBeNull();
    expect(start("1 instanceof Object")).toBeNull();
  });

  test("a TypeScript wrapper is read through: as, satisfies, and an optional chain", () => {
    expect(version("(2 as number)")).toBe(2);
    expect(version("(2 satisfies number)")).toBe(2);
    expect(version("({ a: 2 })?.a")).toBe(2);
    // The wrapper doesn't make an unknown value known.
    expect(version("(undefined as unknown)")).toBeNull();
    expect(version("(undefined satisfies unknown)")).toBeNull();
    expect(version("undefined?.a")).toBeNull();
  });

  test("a binding is followed to its value, and a cycle stops", () => {
    expect(start("CLOSED", 'const CLOSED = "closed";')).toBe("closed");
    expect(start("A", 'const A = B;\nconst B = "closed";')).toBe("closed");
    // A binding that points at itself is not a value: the walk stops rather than looping.
    expect(start("A", "const A = A;")).toBeNull();
  });

  test("a mutable binding, an ambient name and a call are not known", () => {
    expect(start("CLOSED", 'let CLOSED = "closed";')).toBeNull();
    expect(start("closed", "declare const closed: string;")).toBeNull();
    expect(start('String("closed")')).toBeNull();
  });
});

describe("a value from another module", () => {
  // The evaluator reads a relative import's module, so a state name or a version may live beside
  // the machine. The folder is the compiler's own `test/out`, where a relative import names the
  // same file for the compiler and for `bun check`.
  const dir = join(import.meta.dir, "out", `static-evaluator-${process.pid}-${Date.now()}`);
  const at = join(dir, "machine.ts");
  const write = (name: string, text: string): void => writeFileSync(join(dir, name), text);

  test("a named export, a renamed one, a default, and a re-export", () => {
    mkdirSync(dir, { recursive: true });
    try {
      write(
        "names.ts",
        'const CLOSED = "closed";\nconst OPEN = "open";\nexport { CLOSED };\nexport { OPEN as OPENED };\nexport default "closed";\n',
      );
      write("more.ts", 'const L = "locked";\nexport { L as LOCKED };\n');
      write("from.ts", 'export { LOCKED } from "./more.ts";\n');
      const machine = (importLine: string, use: string): string =>
        DOOR.replace(
          'import { createActor, setup, types } from "@reactre/state";',
          `import { createActor, setup, types } from "@reactre/state";\n${importLine}`,
        ).replace('start: ({ to }) => to("closed")', `start: ({ to }) => to(${use})`);
      const state = (importLine: string, use: string): string | null => {
        try {
          const code = compile(at, machine(importLine, use))?.code ?? "";
          return /state: "([^"]*)"/.exec(code)?.[1] ?? null;
        } catch {
          return null;
        }
      };
      // A renamed export and a same-name export both resolve: the export and its local const are
      // different bindings, so a shared name isn't a circular definition.
      expect(state('import { OPENED } from "./names.ts";', "OPENED")).toBe("open");
      expect(state('import { CLOSED } from "./names.ts";', "CLOSED")).toBe("closed");
      expect(state('import D from "./names.ts";', "D")).toBe("closed");
      expect(state('import { LOCKED } from "./from.ts";', "LOCKED")).toBe("locked");
      // `export * from "./more.ts"` is followed too.
      write("star.ts", 'export * from "./more.ts";\n');
      expect(state('import { LOCKED } from "./star.ts";', "LOCKED")).toBe("locked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module that isn't there, a name it doesn't export, and a bare specifier are not known", () => {
    mkdirSync(dir, { recursive: true });
    try {
      write("names.ts", 'export const CLOSED = "closed";\n');
      const machine = (importLine: string, use: string): string =>
        DOOR.replace(
          'import { createActor, setup, types } from "@reactre/state";',
          `import { createActor, setup, types } from "@reactre/state";\n${importLine}`,
        ).replace('start: ({ to }) => to("closed")', `start: ({ to }) => to(${use})`);
      const state = (importLine: string, use: string): string | null => {
        try {
          const code = compile(at, machine(importLine, use))?.code ?? "";
          return /state: "([^"]*)"/.exec(code)?.[1] ?? null;
        } catch {
          return null;
        }
      };
      expect(state('import { NOPE } from "./names.ts";', "NOPE")).toBeNull();
      expect(state('import { X } from "./none.ts";', "X")).toBeNull();
      expect(state('import { X } from "@reactre/state";', "X")).toBeNull();
      // A namespace import's immutable exported value resolves like a named import.
      expect(state('import * as N from "./names.ts";', "N.CLOSED")).toBe("closed");
      // A string-named import is read (the specifier's name is the string), but a string-named
      // export isn't registered, so it doesn't resolve: a limit (not a regression), pinned so a
      // change is deliberate.
      write("strname.ts", 'const C = "closed";\nexport { C as "closed" };\n');
      expect(state('import { "closed" as C } from "./strname.ts";', "C")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the problem a value that isn't known gets", () => {
  test("a state name says how to write it", () => {
    const said = problems(DOOR.replace('start: ({ to }) => to("closed")', "start: ({ to }) => to(closed)")).join("\n");
    expect(said).toContain(
      'to\'s first argument must resolve statically from literals and module-level const bindings: to("loading", ...)',
    );
  });

  test("a version says what it must be", () => {
    const said = problems(
      DOOR.replace("const door = setup({", "const V = 1.5;\nconst door = setup({\n  version: V,"),
    ).join("\n");
    expect(said).toContain("version is a statically known nonnegative integer");
  });

  test("setup's states and use say they must be written in place", () => {
    const states = problems(
      DOOR.replace(
        "states: { closed: types<{}>(), open: types<{ by: string }>(), locked: types<{ code: string }>() },",
        "states: 1,",
      ),
    ).join("\n");
    expect(states).toContain("setup's states is an object literal or an immutable binding to one");
    const use = problems(
      DOOR.replace("const door = setup({", "const USE = 1;\nconst door = setup({\n  use: USE,"),
    ).join("\n");
    expect(use).toContain("setup's use is an array of features, or an immutable binding to one");
  });

  test("a default import of @reactre/state says to import by name", () => {
    const said = problems(
      DOOR.replace(
        'import { createActor, setup, types } from "@reactre/state";',
        'import setup from "@reactre/state";\nimport { createActor, types } from "@reactre/state";',
      ),
    ).join("\n");
    expect(said).toContain("import @reactre/state's functions by name");
  });
});

describe("a task's read of a response", () => {
  // compiler/run.ts's status check: which places a `res.ok` read counts as a look. Each case is a
  // task's `run`, compiled: a look that gates the read compiles, one that doesn't is reported.
  const withRun = (body: string): string =>
    JOB.replace(
      'run: async ({ data }) => ({ type: "stored", id: data.text }),',
      `run: async ({ data, signal }) => { ${body} },`,
    );
  const compiles = (body: string): boolean => problems(withRun(body)).length === 0;

  test("a look in a condition, a throw, a negation, a logical or a comparison counts", () => {
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (!res.ok) throw new Error("bad"); return { type: "stored", id: "" };',
      ),
    ).toBe(true);
    expect(
      compiles('const res = await fetch("/x", { signal }); return { type: "stored", id: res.ok ? "a" : "b" };'),
    ).toBe(true);
    expect(
      compiles('const res = await fetch("/x", { signal }); while (!res.ok) break; return { type: "stored", id: "" };'),
    ).toBe(true);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); do { if (!res.ok) break; } while (false); return { type: "stored", id: "" };',
      ),
    ).toBe(true);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); for (; !res.ok; ) break; return { type: "stored", id: "" };',
      ),
    ).toBe(true);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (res.status === 500) throw new Error("bad"); return { type: "stored", id: "" };',
      ),
    ).toBe(true);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (res.ok && data.text) return { type: "stored", id: data.text }; return { type: "stored", id: "" };',
      ),
    ).toBe(true);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); const { ok } = res; if (!ok) throw new Error("bad"); return { type: "stored", id: "" };',
      ),
    ).toBe(true);
  });

  test("a look in a `.then` callback counts: it is the read's own path", () => {
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (!res.ok) throw new Error("bad"); return res.json().then((body) => { if (!res.ok) throw new Error("bad"); return { type: "stored", id: String(body) }; });',
      ),
    ).toBe(true);
  });

  test("a look through a function the compiler sees, and through its `.then` callback", () => {
    // The check is in another module: the compiler reads it, and a look in its `.then` callback
    // counts (the callback is the read's path), while one in a `forEach` doesn't.
    const dir = join(import.meta.dir, "out", `static-evaluator-helper-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "helper.ts"),
        'export function ensureOk(res: Response): void {\n  if (!res.ok) throw new Error("bad");\n}\nexport function ensureOkThen(res: Response): void {\n  void Promise.resolve().then(() => {\n    if (!res.ok) throw new Error("bad");\n  });\n}\nexport function ensureOkLater(res: Response): void {\n  [1].forEach(() => {\n    if (!res.ok) throw new Error("bad");\n  });\n}\n',
      );
      const at = join(dir, "machine.ts");
      const withHelper = (call: string): string =>
        JOB.replace(
          'import { createActor, setup, types } from "@reactre/state";',
          'import { createActor, setup, types } from "@reactre/state";\nimport { ensureOk, ensureOkThen, ensureOkLater } from "./helper.ts";',
        ).replace(
          'run: async ({ data }) => ({ type: "stored", id: data.text }),',
          `run: async ({ data, signal }) => { const res = await fetch("/x", { signal }); ${call}(res); const body = await res.json(); return { type: "stored", id: String(body) }; },`,
        );
      const ok = (call: string): boolean => problems(withHelper(call), at).length === 0;
      expect(ok("ensureOk")).toBe(true);
      expect(ok("ensureOkThen")).toBe(true);
      expect(ok("ensureOkLater")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a look in a callback that runs later, or not at all, doesn't count", () => {
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); [1].forEach(() => { if (!res.ok) throw new Error("bad"); }); const body = await res.json(); return { type: "stored", id: String(body) };',
      ),
    ).toBe(false);
  });

  test("a read that only prints the status, or adds to it, doesn't count", () => {
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); console.info(res.status); const body = await res.json(); return { type: "stored", id: String(body) };',
      ),
    ).toBe(false);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); const n = res.status + 1; const body = await res.json(); return { type: "stored", id: String(n) + String(body) };',
      ),
    ).toBe(false);
  });

  test("a computed member, or a property that isn't a status, doesn't count", () => {
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (!res["ok"]) throw new Error("bad"); const body = await res.json(); return { type: "stored", id: String(body) };',
      ),
    ).toBe(false);
    expect(
      compiles(
        'const res = await fetch("/x", { signal }); if (!res.body) throw new Error("bad"); const body = await res.json(); return { type: "stored", id: String(body) };',
      ),
    ).toBe(false);
  });
});
