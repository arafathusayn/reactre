// The codemod's edges, one small XState source each: what it converts, and the TODO or note it
// reports for what it can't. ../codemod.test.ts converts whole machines and replays them; these
// check the forms a machine is written in one at a time, through `convert` and the CLI's `main`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convert, main, type ReportEntry } from "../../codemod/index.ts";

/** Every XState name the sources below use. Those a source doesn't use go with the conversion. */
const XSTATE = `import { and, assign, cancel, createActor, createMachine, emit, enqueueActions, forwardTo, fromCallback, fromEventObservable, fromObservable, fromPromise, fromTransition, log, not, or, pure, raise, sendParent, sendTo, setup, spawnChild, stateIn, stopChild, types } from "xstate";\n\n`;

interface Converted {
  readonly code: string;
  readonly report: readonly ReportEntry[];
  /** The report's TODOs' messages. */
  readonly todos: readonly string[];
  /** The report's other lines. */
  readonly notes: readonly string[];
}

/** Converts `body` (after XState's imports), unformatted. */
function run(body: string, file = "machine.ts"): Converted {
  const { code, report } = convert(file, `${XSTATE}${body}`, { format: false });
  return {
    code,
    report,
    todos: report.filter((r) => r.todo).map((r) => r.message),
    notes: report.filter((r) => !r.todo).map((r) => r.message),
  };
}

const dir = mkdtempSync(join(tmpdir(), "reactre-plugin-state-codemod-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the CLI", () => {
  test("prints its usage, and fails, without files", async () => {
    const err: string[] = [];
    expect(
      await main(
        [],
        () => {},
        (line) => err.push(line),
      ),
    ).toBe(1);
    expect(err).toEqual(["usage: bun packages/state/codemod/index.ts <files…> [--write]"]);
  });

  test("rewrites a file in place with --write, and names a JSON export's output <name>.state.ts", async () => {
    const here = new URL("./", import.meta.url).pathname;
    const door = join(dir, "door.ts");
    const json = join(dir, "checkout.json");
    const plain = join(dir, "plain.ts");
    await Bun.write(door, await Bun.file(`${here}door.xstate.ts`).text());
    await Bun.write(json, await Bun.file(`${here}stately-json.xstate.json`).text());
    await Bun.write(plain, "export const answer = 42;\n");
    // Formatted with the settings where the file is: what convert writes for it there.
    const doorOut = convert(door, await Bun.file(door).text()).code;
    const jsonOut = convert(json, await Bun.file(json).text()).code;
    const out: string[] = [];
    expect(await main([door, "--write", json, plain], (line) => out.push(line))).toBe(0);
    expect(await Bun.file(door).text()).toBe(doorOut);
    expect(doorOut).toContain("export const doorMachine = door.machine({");
    expect(await Bun.file(join(dir, "checkout.state.ts")).text()).toBe(jsonOut);
    expect(jsonOut).toContain("export const checkoutMachine = checkout.machine({");
    expect(out[0]).toBe(`${door} -> ${door}`);
    expect(out).toContain(`${json} -> ${join(dir, "checkout.state.ts")}`);
    expect(out).toContain(`${plain}: no XState machine`);
    expect(out.at(-1)).toMatch(/^\d+ TODOs$/);
  });

  test("writes <name>.state.ts next to a source without --write, and counts one TODO", async () => {
    const file = join(dir, "lone.ts");
    await Bun.write(
      file,
      `${XSTATE}export const loneMachine = createMachine({ initial: "a", states: { a: { on: { go: "nowhere" } } } });\n`,
    );
    const out: string[] = [];
    expect(await main([file], (line) => out.push(line))).toBe(0);
    expect(out[0]).toBe(`${file} -> ${join(dir, "lone.state.ts")}`);
    expect(out[1]?.split("\n")).toContain(`${file}:3: TODO target "nowhere" isn't a state the codemod can find`);
    expect(out.at(-1)).toBe("1 TODO");
    expect(await Bun.file(join(dir, "lone.state.ts")).exists()).toBe(true);
  });
});

describe("files the codemod can't read", () => {
  test("a JSON export that doesn't parse stays as is", () => {
    expect(convert("machine.json", "{ not json", { format: false })).toEqual({
      code: "{ not json",
      report: [{ line: 1, message: "doesn't parse as JSON", todo: true }],
    });
  });

  test("a module that doesn't parse stays as is", () => {
    const { code, report } = convert("machine.ts", "const = ;", { format: false });
    expect(code).toBe("const = ;");
    expect(report).toHaveLength(1);
    expect(report[0]?.message).toStartWith("doesn't parse: ");
  });

  test("machines that aren't module-level consts of an object literal", () => {
    const { todos } = run(`const config = { initial: "a", states: { a: {} } };
export const pair = createMachine({ initial: "x", states: { x: {} } }), other = 1;
export const fromConfig = createMachine(config);
const factory = makeFactory();
export const made = factory.createMachine({ initial: "x", states: { x: {} } });
export function make() {
  return createMachine({ initial: "x", states: { x: {} } });
}
`);
    expect(todos).toEqual([
      "declare each machine as its own `const name = createMachine(...)`",
      "the machine's config isn't an object literal written in place",
      "a machine that isn't a module-level const: move it to `const name = ...`",
    ]);
  });
});

describe("the module around the machine", () => {
  test("setup declared on its own goes, logic's types move to its function, and names still used stay imported", () => {
    const { code, todos } = run(`const [first, ...others] = [1, 2];
const { a = 1, ...rest } = { a: 2 };
function scan(list: number[]) {
  outer: for (const x of list) if (x > first) break outer;
}

const store = fromPromise<string, { text: string }>(async ({ input }) => input.text);
const app = setup({ actors: { store } });
export const saveMachine = app.createMachine({
  initial: "idle",
  states: {
    idle: { on: { save: "saving" } },
    saving: { invoke: { src: "store", input: { text: "hi" }, onDone: "idle", onError: "idle" } },
  },
});
export const actor = createActor(saveMachine);
`);
    expect(code).not.toContain("const app = setup");
    expect(code).toContain("const store = async ({ input }: { input: { text: string } }) => input.text;");
    expect(code).toContain('import { createActor } from "xstate";');
    expect(todos).toContain(
      "createActor is still imported from XState, for code the codemod didn't convert: use @reactre/state's createActor, transition and restoreActor, then remove this import",
    );
  });
});

describe("the state tree", () => {
  test("initial states and targets the codemod can't find", () => {
    const { todos } =
      run(`export const noInitialMachine = createMachine({ states: { a: { on: { go: "b" } }, b: { on: { go: "a" } } } });
export const badInitialMachine = createMachine({ initial: "zzz", states: { a: { on: { go: "a" } } } });
export const menuMachine = createMachine({
  initial: "menu",
  states: {
    menu: { states: { x: { on: { go: "y" } }, y: { on: { go: "x" } } } },
  },
});
export const lostMachine = createMachine({
  initial: "a",
  states: {
    a: { on: { go: "nowhere", both: { target: ["a", "b"] } } },
    b: { on: { go: "a" } },
  },
});
`);
    expect(todos).toEqual([
      "the machine has no initial state: write start by hand",
      'initial state "zzz" isn\'t a state the codemod can find',
      'state "menu" has no initial state the codemod can find: name the leaf to go to',
      'target "nowhere" isn\'t a state the codemod can find',
      "several targets that aren't regions of one parallel state: pick one",
    ]);
  });

  test("history: shallow over nested states, and inside a parallel state", () => {
    const { todos } = run(`export const deskMachine = createMachine({
  initial: "idle",
  states: {
    idle: { on: { resume: "work.hist", open: "panes.hist" } },
    work: {
      initial: "edit",
      states: { edit: { initial: "draft", states: { draft: { on: { stop: "#desk.idle" } } } }, hist: { type: "history" } },
    },
    panes: {
      type: "parallel",
      states: {
        left: { initial: "a", states: { a: { on: { close: "#desk.idle" } } } },
        hist: { type: "history" },
      },
    },
  },
  id: "desk",
});
`);
    expect(todos).toContain(
      "shallow history: @reactre/state's back is deep (it restores the last leaf, with its data)",
    );
    expect(todos).toContain("history inside a parallel state isn't supported: go back to the parallel state itself");
  });

  test("several targets: one per region of a parallel state", () => {
    const { code, todos } = run(`type Ctx = { count: number };
export const panesMachine = createMachine({
  types: {} as { context: Ctx },
  context: { count: 0 },
  initial: "idle",
  states: {
    idle: { on: { open: { target: ["panes.left.b", "panes.right.d"] }, side: { target: ["panes.right.d"] } } },
    panes: {
      id: "panes",
      type: "parallel",
      states: {
        left: {
          initial: "a",
          states: {
            a: { on: { flip: { target: "b", guard: ({ context }) => context.count > 0 } } },
            b: { entry: ({ context }) => console.log(context.count), on: { both: { target: ["#panes.left.a", "#panes.right.c"] } } },
          },
        },
        right: {
          initial: "c",
          states: {
            c: { on: { bump: { target: "d", actions: assign({ count: ({ context }) => context.count + 1 }) } } },
            d: { on: { back: "c" } },
          },
        },
      },
    },
  },
});
`);
    expect(code).toContain('to("panes", { left: to("panes.left.b"');
    expect(todos).toContain(
      "several targets inside the parallel state: this enters it again, with the other regions at their start",
    );
    expect(todos).toContain(
      'regions "left" and "right" share context field count: each region has its own data. Keep count in one region, or send it in the events',
    );
    expect(todos).toContain(
      'regions "left" and "right" both need context field count: each region has its own data. Keep count in one region, or send it in the events',
    );
  });
});

describe("the context", () => {
  test("a type that isn't in this file: each state keeps the whole context", () => {
    const { code, todos } = run(`import type { External } from "./types";
export const outsideMachine = setup({
  types: {} as { context: External },
  delays: { wait: ({ context }) => context.ms },
}).createMachine({
  context: { ms: 10 },
  initial: "a",
  states: { a: { after: { wait: "b" } }, b: { on: { go: "a" } } },
});
`);
    expect(code).toContain("a: types<External>()");
    expect(code).toContain("wait: ({ data }: { data: External }) => data.ms");
    expect(todos).toContain(
      "narrow this state's data to the fields it uses: the context's type isn't written in this file, so its fields are unknown",
    );
  });

  test("a guard that reads the context whole: each state keeps it, and a write spreads it", () => {
    const { code, todos } = run(`type Ctx = { n: number };
export const wholeMachine = createMachine({
  types: {} as { context: Ctx },
  context: { n: 0 },
  initial: "a",
  states: {
    a: { on: { go: { target: "b", guard: ({ context }) => isReady(context), actions: assign({ n: ({ context }) => context.n + 1 }) } } },
    b: { on: { go: "a" } },
  },
});
`);
    expect(code).toContain('to("b", { ...data, n: data.n + 1 })');
    expect(todos.some((t) => t.endsWith("uses the context whole"))).toBe(true);
  });

  test("what each written value is: null, never null, or either", () => {
    const { code } = run(`type Ctx = {
  a: string | null; b: number | null; c: string[] | null; d: string | null; e: number | null; f: string | null;
  g: string | null; h: string | null; i: number | null; j: number | null; k: string | null; l: number | null;
  m: string | null; n: string | null; o: object | null; p: number | null; q: number | null;
  r: number | null; s: string | null; t: object | null; u: string | null;
};
const START = 1;
type Ev = { type: "go"; by: string; maybe?: string; tag: string | null };
export const kindsMachine = createMachine({
  types: {} as { context: Ctx; events: Ev },
  context: { a: \`x\`, b: -1, c: [], d: null, e: null, f: null, g: null, h: null, i: null, j: null, k: null, l: null, m: null, n: null, o: {}, p: 1 + 1, q: null, r: null, s: null, t: null, u: null },
  initial: "idle",
  states: {
    idle: {
      on: {
        go: {
          target: "done",
          actions: assign({
            a: ({ event }) => event.by,
            b: ({ context }) => context.b,
            c: ({ context }) => context.c ?? [],
            d: ({ event }) => event.maybe,
            e: ({ context }) => (context.p ? 1 : 2),
            f: (args) => args.context.f,
            g: (args) => args.event.by,
            h: ({ event }) => String(event.by),
            i: () => Math.max(1, 2),
            j: ({ event }) => event.by.length,
            k: ({ event }) => event.by.trim(),
            l: () => undefined as unknown as number,
            m: ({ context }) => context.m && "x",
            n: ({ context }) => context.n!,
            o: ({ event }) => ({ by: event.by }),
            p: ({ context }) => context.p ?? context.q,
            q: ({ context }) => context.q,
            r: () => START,
            s: ({ event }) => format(event.by),
            t: () => new Set(),
            u: ({ event }) => event.tag,
          }),
        },
      },
    },
    done: { type: "final" },
  },
});
`);
    expect(code).toContain(
      // f, l, n and q are null for sure there: they go.
      "done: types<{ a: string; b: number; c: string[]; d: string | null; e: number; g: string; h: string; i: number; j: number; k: string; m: string | null; o: object; p: number | null; r: number | null; s: string | null; t: object | null; u: string | null }>()",
    );
  });
});

describe("guards", () => {
  test("v5's named guards: params, combinators, and the ones that can't be inlined", () => {
    const { code, todos, notes } = run(`let threshold = 3;
type Ctx = { count: number; items: string[] };
type Ev = { type: "go" } | { type: "stop" };
export const gateMachine = setup({
  types: {} as { context: Ctx; events: Ev },
  guards: {
    hasA: ({ context }) =>
      context.items.some((x) => {
        const y = x;
        return y === "a";
      }),
    isBig: ({ context }, params: { min: number }) => context.count > params.min,
    isTagged: ({ context }, params) => check(params),
    isLarge: (args) => args.context.count > 10 && args.event.type === "go",
    hasCount: ({ context }) => context["count"] > 0,
    above: ({ context }) => context.count > threshold,
    lucky: () => Math.random() > 0.5,
    block: ({ context }) => {
      const x = context.count;
      return x > 0;
    },
    external: externalGuard,
    counted: ({ context }) => (context.count = 1) > 0,
    wide: ({ context }) => context.count > window.innerWidth,
  },
}).createMachine({
  context: { count: 0, items: [] },
  initial: "idle",
  states: {
    idle: {
      on: {
        go: [
          { target: "busy", guard: "hasA" },
          { target: "busy", guard: { type: "isBig", params: { min: 3 } } },
          { target: "busy", guard: { type: "isTagged", params: { tag: "x" } } },
          { target: "busy", guard: and(["isLarge", or(["hasCount", not("above")])]) },
          { target: "busy", guard: "lucky" },
          { target: "busy", guard: "block" },
          { target: "busy", guard: "external" },
          { target: "busy", guard: "counted" },
          { target: "busy", guard: "wide" },
          {
            target: "busy",
            guard: ({ context }) => {
              const y = 1;
              return context.count > y;
            },
          },
          { target: "busy", guard: someGuardValue },
        ],
      },
    },
    busy: { on: { stop: "idle" } },
  },
});
`);
    expect(code).toContain("data.count > 3 ? to(");
    expect(code).toContain('check(({ tag: "x" })) ? to(');
    expect(code).toContain(
      '(data.count > 10 && event.type === "go") && ((data.count > 0) || (!(data.count > threshold))) ? to(',
    );
    expect(code).toContain("guards.lucky() ? to(");
    expect(code).toContain("guards: { lucky: () => Math.random() > 0.5 }");
    expect(notes).toContain(
      "guard \"lucky\" isn't pure (it calls Math.random): it is setup's guard, called in the handler, so a test can replace it with provide",
    );
    expect(todos).toEqual(
      expect.arrayContaining([
        'guard "isTagged" isn\'t pure (it reads the global check): a transition reads only its data and the event. Put the value in the event',
        'guard "above" isn\'t pure (it reads module-level let threshold): a transition reads only its data and the event. Put the value in the event',
        'guard "block" has a block body: write it as one expression here',
        'guard "external" is externalGuard, defined elsewhere: write its condition here, and keep it pure',
        'guard "counted" isn\'t pure (it changes something outside itself): a transition reads only its data and the event. Put the value in the event',
        'guard "wide" isn\'t pure (it reads the global window): a transition reads only its data and the event. Put the value in the event',
        "a guard with a block body: write it as one expression",
        "a guard the codemod can't read: someGuardValue",
      ]),
    );
  });

  test("guards that read the context whole", () => {
    const { todos } = run(`type Ctx = { count: number; items: string[] };
const key = "count";
export const wholeGuardsMachine = createMachine({
  types: {} as { context: Ctx },
  context: { count: 0, items: [] },
  initial: "a",
  states: {
    a: {
      on: {
        go: [
          { target: "b", guard: (args) => args.context["it" + "ems"].length > 0 },
          { target: "b", guard: ({ context }) => context[key] > 0 },
          { target: "b", guard: (args) => check(args.context) },
        ],
      },
    },
    b: { on: { go: "a" } },
  },
});
`);
    expect(todos.filter((t) => t.endsWith("uses the context whole"))).toHaveLength(2);
  });

  test("v6's guards, inlined where they are pure functions written in setup", () => {
    const { code, todos } = run(`export const checkMachine = setup({
  guards: {
    isBig: (n: number) => n > 3,
    viaRef: refGuard,
    viaCall: makeGuard(),
    block: (n: number) => {
      const m = n;
      return m > 1;
    },
    late: (t: number) => t > Date.now(),
  },
}).createMachine({
  context: { n: 0 },
  initial: "a",
  states: {
    a: {
      on: {
        big: ({ context, guards }) => (guards.isBig(context.n) ? { target: "b" } : undefined),
        ref: ({ context, guards }) => (guards.viaRef(context.n) ? { target: "b" } : undefined),
        call: ({ context, guards }) => (guards.viaCall(context.n) ? { target: "b" } : undefined),
        block: ({ context, guards }) => (guards.block(context.n) ? { target: "b" } : undefined),
        late: ({ context, guards }) => (guards.late(context.n) ? { target: "b" } : undefined),
        missing: ({ context, guards }) => (guards.missing(...context.list) ? { target: "b" } : undefined),
      },
    },
    b: { on: { back: { target: "a" } } },
  },
});
`);
    expect(code).toContain('big: ({ data, to }) => ((data.n > 3) ? to("b", data) : null)');
    expect(code).toContain('missing: ({ data, to }) => (missing(undefined) ? to("b", data) : null)');
    expect(todos).toEqual(
      expect.arrayContaining([
        'guard "viaRef" is refGuard, defined elsewhere: inline it, or make sure it is pure (it reads only its arguments)',
        'guard "viaCall" isn\'t a function written in place: write its condition here',
        'guard "block" has a body the codemod can\'t inline: write its condition here',
        'guard "late" isn\'t pure (it reads the clock): a transition reads only its data and the event',
        "guard \"missing\" isn't in setup's guards here: write its condition in place",
      ]),
    );
  });
});

describe("the data each handler writes", () => {
  test("a compound state's done, a field some of its states hold, and a start without a field", () => {
    const { code, todos } = run(`type Ctx = { note: string | null; result: string | null };
type Ev = { type: "finish" } | { type: "next" } | { type: "save"; text: string };
const defaults = { note: null };
export const flowMachine = createMachine({
  types: {} as { context: Ctx; events: Ev },
  context: { ...defaults, result: null },
  initial: "form",
  states: {
    form: {
      initial: "edit",
      states: {
        edit: {
          on: {
            finish: { target: "done", actions: assign({ result: "ok" }) },
            next: { target: "review", guard: ({ context }) => context.note !== null },
          },
        },
        review: { on: { next: "edit" } },
        done: { type: "final" },
      },
      onDone: { target: "shown", guard: ({ context }) => context.result !== null },
    },
    shown: { on: { save: { actions: assign({ note: ({ event }) => event.text }) } } },
  },
});
`);
    expect(code).toContain('start: ({ to }) => to("form.edit", { note: null })');
    expect(code).toContain('state === "form.edit" ? to("form.edit"');
    expect(todos).toEqual(
      expect.arrayContaining([
        "a context property the codemod can't read: write it in start's data",
        "field result is in some of form's states only: read it with a check of state, or narrow by hand",
        "XState did nothing when no guard passed; this must go somewhere, so it stays",
      ]),
    );
  });

  test("a compound state that ends without a done, and a done that reads the event", () => {
    const { todos } = run(`export const stepsMachine = createMachine({
  context: { result: null as string | null },
  initial: "one",
  states: {
    one: { initial: "x", states: { x: { on: { go: "y" } }, y: { type: "final" } }, on: { skip: "two" } },
    two: {
      initial: "x",
      states: { x: { on: { go: "y" } }, y: { type: "final" } },
      onDone: { target: "one", actions: assign({ result: ({ event }) => event.output }) },
    },
  },
});
`);
    expect(todos).toContain(
      "in XState, reaching one.y finished one (with no onDone, nothing happened); here a final state ends the machine",
    );
    expect(todos).toContain("XState's onDone event (its output): here done gets the final leaf's state and data");
  });

  test("a parallel state's own handlers: a targetless update, and reentering it", () => {
    const { code, todos } = run(`type Ctx = { n: number };
export const gridMachine = createMachine({
  types: {} as { context: Ctx },
  context: { n: 0 },
  initial: "grid",
  states: {
    grid: {
      type: "parallel",
      on: { bump: { actions: assign({ n: 1 }) }, again: { target: "grid", reenter: true } },
      states: {
        a: { initial: "x", states: { x: { on: { go: "y" } }, y: { on: { go: "x" } } } },
        b: { initial: "x", states: { x: { on: { go: "y" } }, y: { on: { go: "x" } } } },
      },
    },
  },
});
`);
    expect(code).toContain("bump: ({  }) => null");
    // The TODO's advice names reenter: the output doesn't call it, so it doesn't use the opt-in.
    expect(code).toContain("use: [nested, parallel],");
    expect(todos).toContain("a context update on a parallel state: update the region that holds the field instead");
    expect(todos).toContain(
      "reenter into a parallel state or through history: re-enter its leaf with reenter(leaf, data) by hand",
    );
  });

  test("a v6 function on a state and a handler of the same event on the machine", () => {
    const { todos } = run(`export const mixMachine = createMachine({
  context: { n: 0 },
  initial: "a",
  on: { reset: ({ context }) => ({ target: ".a" }) },
  states: {
    a: {
      on: { reset: "b" },
      after: { 100: ({ context }) => (context.n > 0 ? { target: "b" } : undefined) },
    },
    b: { on: { reset: "a" } },
  },
});
`);
    expect(todos).toContain("this transition function and another handler for the same event: merge them by hand");
    expect(todos).toContain("XState did nothing here; this must go somewhere, so it stays");
  });
});

describe("children", () => {
  test("machines and callback logic: ids, output, errors and done", () => {
    const { code, todos } =
      run(`const childMachine = createMachine({ initial: "run", states: { run: { on: { end: "over" } }, over: { type: "final" } } });
const otherMachine = createMachine({ initial: "x", states: { x: { on: { end: "y" } }, y: { type: "final" } } });
const ticker = fromCallback(({ sendBack }) => {
  const t = setInterval(() => sendBack({ type: "tick" }), 10);
  return () => clearInterval(t);
});
const pinger = fromCallback(({ sendBack }) => {
  sendBack({ type: "tick" });
});
type Ctx = { result: string | null };
type Ev = { type: "tick" } | { type: "next" };
export const parentMachine = createMachine({
  types: {} as { context: Ctx; events: Ev },
  context: { result: null },
  initial: "a",
  states: {
    a: {
      invoke: {
        id: "kid",
        src: childMachine,
        onDone: { target: "b", actions: assign({ result: ({ event }) => event.output }) },
        onError: "b",
      },
    },
    b: { invoke: { id: "kid", src: otherMachine, onDone: "c" } },
    c: { invoke: { id: "clock", src: ticker, onDone: "d", onError: "d" }, on: { tick: "d" } },
    d: { invoke: { id: "clock", src: pinger, onError: "a" }, on: { tick: "a" } },
  },
});
`);
    expect(code).toContain("children: { kid: childMachine, clock: ticker }");
    expect(todos).toEqual(
      expect.arrayContaining([
        'child "kid" runs childMachine elsewhere: give this one another id',
        'child "clock" runs ticker elsewhere: give this one another id',
        "XState's onDone output is the child's output; here output is its final { state, data }: read output.data",
        "a child's onError: a child machine reports failure by ending in a final state",
        "clock is callback logic, which never finishes: its onDone never runs",
      ]),
    );
  });
});

describe("timers and schemas", () => {
  test("a v6 timeout computed from the data", () => {
    const { code } = run(`type Ctx = { ms: number };
export const waitMachine = createMachine({
  types: {} as { context: Ctx },
  context: { ms: 10 },
  initial: "a",
  states: { a: { timeout: ({ context }) => context.ms, onTimeout: "b" }, b: { on: { go: "a" } } },
});
`);
    expect(code).toContain("timeout: ({ data }) => data.ms");
  });

  test("schemas that aren't types<>(): the shape validates", () => {
    const { code } = run(`export const formMachine = setup({
  schemas: {
    context: z.object({ name: z.string() }),
    events: { submit: z.object({ name: z.string() }), reset: types<{}>() },
    input: z.object({ name: z.string() }),
  },
}).createMachine({
  context: { name: "" },
  initial: "a",
  states: { a: { on: { submit: "b" } }, b: { on: { reset: "a" } } },
});
export const typedInputMachine = setup({
  schemas: { input: types<{ n: number }>() },
}).createMachine({ initial: "a", states: { a: { on: { go: "a" } } } });
`);
    expect(code).toContain("use: [validate]");
    expect(code).toContain("input: z.object({ name: z.string() })");
    expect(code).toContain("a: z.object({ name: z.string() })");
    expect(code).toContain("input: types<{ n: number }>()");
  });
});

describe("effects in entry and exit", () => {
  test("what reads the event there, which an entry has none of", () => {
    const { code, todos } =
      run(`const workerMachine = createMachine({ initial: "x", states: { x: { on: { go: "x" } } } });
type Ctx = { count: number };
export const enterMachine = setup({
  types: {} as { context: Ctx },
  actors: { workerMachine },
  actions: { track: ({ context }, p) => console.log(context.count, p) },
  guards: { isB: ({ context }, params) => context.count > params.n, isBig: (n: number) => n > 3 },
}).createMachine({
  context: { count: 0 },
  initial: "a",
  states: {
    a: {
      entry: [
        log(({ event }) => event.type),
        spawnChild("workerMachine", { input: ({ context }) => context.count }),
        enqueueActions(({ context, enqueue, check }) => {
          if (check(and(["isA", or([not({ type: "isB", params: { n: 1 } })])]))) enqueue(raise({ type: "next" }));
          if (context.count > 0) enqueue(raise({ type: "next" }));
        }),
        ({ context, guards }) => guards.isBig(context.count) && console.log("big"),
        { type: "track", params: { n: 1 } },
        ({ context }) => console.log(context),
      ],
      on: { next: "a" },
    },
  },
});
`);
    expect(code).toContain('enq.spawn("workerMachine", { input: data.count })');
    expect(todos).toContain(
      "this effect reads the event, and an entry or exit has none: keep what it reads in the data",
    );
  });
});

describe("types", () => {
  test("an intersection of context types, an event type it can't read, and a version that isn't a number", () => {
    const { code, todos } = run(`type A = { a: string };
type B = { b: number | null };
type Ctx = A & B;
type Ev = { type: "go"; n: number } | { type: "stop" } | Unknown;
export const typedMachine = createMachine({
  types: {} as { context: Ctx; events: Ev },
  context: { a: "", b: null },
  initial: "x",
  states: { x: { on: { go: "y" } }, y: { on: { stop: "x" } } },
  version: "next",
});
`);
    expect(code).toContain("events: { go: types<{ n: number }>(), stop: types<{}>() }");
    expect(code).toContain("x: types<{ a: string }>()");
    expect(todos).toEqual(
      expect.arrayContaining([
        "an event type the codemod can't read: write it in setup's events",
        "version is a whole number in @reactre/state: bump it when a state's data changes",
      ]),
    );
  });

  test("types that aren't `{} as Type`, and a context type that isn't an object", () => {
    const { todos } = run(`type Ctx = { a: string };
export const castsMachine = createMachine({
  types: { context: {} as Ctx, events: eventsDef },
  context: { a: "" },
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
export const madeMachine = createMachine({
  types: makeTypes(),
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
export const unionMachine = createMachine({
  types: {} as { context: { a: 1 } | { b: 2 } },
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
`);
    expect(todos).toEqual(
      expect.arrayContaining([
        "types.events isn't `{} as Type`: write its type in setup by hand",
        "types isn't `{} as { context, events }` with a type written in this file: write setup's states and events by hand",
        "narrow this state's data to the fields it uses: the context's type isn't written in this file, so its fields are unknown",
      ]),
    );
  });

  test("a context function: its argument, and what it returns", () => {
    const { todos } = run(`export const inputMachine = createMachine({
  context: (args) => ({ n: args.input.n }),
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
export const builtMachine = createMachine({
  context: () => makeContext(),
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
`);
    expect(todos).toEqual(
      expect.arrayContaining([
        "destructure the context function's argument (`({ input })`): start reads `input` from it",
        "the context function doesn't return an object literal: write start's data by hand",
      ]),
    );
  });

  test("an untyped context: each field's type guessed from its initial value", () => {
    const { todos, notes } = run(`export const guessMachine = createMachine({
  context: { big: 10n, mixed: [1, "a"] },
  initial: "x",
  states: { x: { on: { go: "x" } } },
});
`);
    expect(todos).toContain("context field big has no type: write it in setup's states");
    expect(notes).toContain("context field mixed has no type: guessed (number | string)[] from its initial value");
  });
});

describe("actions and transitions", () => {
  test("assigners, named actions and transition forms the codemod can't convert", () => {
    const { todos } = run(`const DYNAMIC = "dyn";
type Ctx = { n: number };
export const actsMachine = setup({
  types: {} as { context: Ctx },
  actions: {
    inc: assign({ n: ({ context }) => context.n + 1 }),
    say: sayImpl,
    pick: ({ context }, { item }) => console.log(context.n, item),
  },
}).createMachine({
  context: { n: 0 },
  initial: "a",
  states: {
    a: {
      on: {
        e1: {
          actions: assign({
            n: ({ context }) => {
              const m = context.n;
              return m + 1;
            },
          }),
        },
        e2: { actions: assign(({ context }) => ({ n: context.n + 1 })) },
        e3: { actions: assign(updater) },
        e4: { actions: assign((args) => ({ ...args.context, n: 1 })) },
        e5: { actions: assign(({ context }) => ({ ...other, n: 1 })) },
        e6: { actions: [{ type: "inc", params: { by: 1 } }] },
        e7: {
          actions: {
            type: "pick",
            params: () => {
              const item = "x";
              return { item };
            },
          },
        },
        e8: { actions: { type: "notWritten", params: ({ context }) => context.n } },
        e9: { actions: "say" },
        e10: { actions: "pick" },
        e11: { actions: (_, params) => console.log(params) },
        e12: { actions: someAction },
        e13: undefined,
        e14: 42,
        e15: { target: someTarget },
        e16: { target: "b", context: { n: 1 } },
        e17: { target: "b", context: ({ context }) => ({ n: context.n + 1 }) },
        e18: { target: "b", context: ({ context }) => makeCtx(context) },
        e19: { target: "b", context: nextCtx },
        e20: { reenter: true },
        e21: { target: "b", meta: { x: 1 } },
        e22: { target: "b", in: "#x" },
        "": "b",
        "xstate.done.actor.x": "b",
        [DYNAMIC]: "b",
      },
    },
    b: { on: { back: "a" } },
  },
});
`);
    expect(todos).toEqual(
      expect.arrayContaining([
        "the assigner of n has a block body: write it as one expression",
        'action "inc" takes params: inline them where it is used',
        'action "pick"\'s params are built in a block: return them as one expression',
        'action "say" is sayImpl, defined elsewhere: write it in setup\'s actions, as a function of its params',
        'action "pick" destructures its params: name them, (args, params) => ...',
        "an inline action that reads params: write the values in place",
        "an action the codemod can't read: someAction",
        "a forbidden transition (undefined): leave the event unhandled here, and handle it only where it applies",
        "a transition the codemod can't read: 42",
        'a target that isn\'t a string written in place: write to("state", data)',
        "reenter on a transition without a target does nothing in XState: it is dropped",
        "this transition's meta { x: 1 } isn't converted: keep it beside the machine",
        'transition option "in" isn\'t converted',
        'an eventless transition ("") is v4\'s always: write it as always',
        "\"xstate.done.actor.x\" transitions aren't converted: XState's own events have no counterpart here",
      ]),
    );
  });

  test("XState's action creators, with arguments the codemod can't convert", () => {
    const { code, todos } = run(`const server = createMachine({ initial: "x", states: { x: { on: { ping: "x" } } } });
const workerMachine = createMachine({ initial: "x", states: { x: { on: { go: "x" } } } });
const worker = createMachine({ initial: "y", states: { y: { on: { go: "y" } } } });
type Ctx = { n: number };
type Ev = { type: "go"; by: string } | { type: "x" };
export const fxMachine = setup({
  types: {} as { context: Ctx; events: Ev },
  actors: { worker: workerMachine },
  delays: { short: 100, later: ({ context }) => context.n },
}).createMachine({
  context: { n: 0 },
  initial: "a",
  states: {
    a: {
      on: {
        go: {
          actions: [
            raise({ type: "x" }, opts),
            raise({ type: "x" }, { delay: "short", id: "t" }),
            raise({ type: "x" }, { delay: "later" }),
            raise({ type: "x" }, { delay: 5, to: "y" }),
            raise(...events),
            raise(() => {
              const type = "x";
              return { type };
            }),
            sendTo("kid", { type: "ping" }),
            sendTo(server, { type: "ping" }),
            sendTo(({ context }) => context.ref, { type: "x" }),
            sendTo("kid", () => {
              const type = "x";
              return { type };
            }),
            sendTo("kid", { type: "x" }, opts),
            log(),
            log(() => {
              const v = 1;
              return v;
            }),
            log("x", label),
            emit(() => {
              const type = "x";
              return { type };
            }),
            emit(evt),
            emit(({ context, event }) => ({ type: "changed", count: context.n, by: event.by, other: makeIt() })),
            emit((args) => ({ type: "moved", n: args.context.n, by: args.event.by })),
            emit(({ context }) => ({ type: "spread", ...context })),
            cancel(someId),
            spawnChild(makeName()),
            spawnChild("worker", options),
            spawnChild("worker", {
              id: "w",
              input: () => {
                const v = 1;
                return v;
              },
            }),
            spawnChild("worker", { systemId: "x" }),
            spawnChild("worker", { id: "w1" }),
            spawnChild(worker),
            stopChild(someRef),
            enqueueActions(handlerRef),
            sendParent({ type: "x" }),
            forwardTo("kid"),
            pure(() => []),
          ],
        },
      },
    },
  },
});
`);
    expect(code).toContain('enq.raise({ type: "x" }, { delay: 100, id: "t" })');
    expect(code).toContain('enq.sendTo("kid", { type: "ping" })');
    expect(code).toContain('enq.sendTo(server, { type: "ping" })');
    expect(code).toContain(
      "emitted: { changed: types<{ count: number; by: string; other: null }>(), moved: types<{ n: number; by: string }>() }",
    );
    expect(todos).toEqual(
      expect.arrayContaining([
        "options opts that aren't an object written in place",
        "the delay \"later\" isn't a number written in setup's delays: write it in milliseconds",
        'the option to: "y" isn\'t converted',
        "raise(...) with a spread argument isn't converted",
        "raise with an event built in a block: return the event as one expression",
        "sendTo ({ context }) => context.ref: send to a child by its name, or to an actor written at the module's top level",
        "sendTo with an event built in a block: return the event as one expression",
        "log() logs XState's whole context and event: log the fields you need, enq.log(data.x)",
        "log with a value built in a block: return it as one expression",
        "log's label label isn't a string written in place",
        "emit with an event built in a block: return it as one expression",
        "emit evt: write the event as an object with its type written in place",
        "the emitted field other has no type the codemod can tell: write it in setup's emitted",
        'emit ({ context }) => ({ type: "spread", ...context }): write the event as an object with its fields written in place',
        "cancel someId: cancel by an id written in place",
        "spawnChild makeName(): only a machine declared at the module's top level is spawned here",
        "spawnChild's options options aren't an object written in place",
        "spawnChild's input is built in a block: return it as one expression",
        "spawnChild's systemId isn't converted",
        'spawnChild "worker" runs workerMachine elsewhere: give this one another name',
        "stopChild someRef: stop a spawned child by the id it was spawned with, written in place (an invoked child stops when its state exits)",
        "enqueueActions with a function that isn't written in place",
        "sendParent: a child tells its parent through its final state (the parent's children.done), or with an emitted event the parent listens to",
        "forwardTo: send the event to the child with enq.sendTo(name, event)",
        "pure(...) isn't converted: run it with enq(() => ...)",
      ]),
    );
  });

  test("enqueueActions: what it enqueues, and what it can't", () => {
    const { code, todos } =
      run(`const workerMachine = createMachine({ initial: "x", states: { x: { on: { go: "x" } } } });
type Ctx = { n: number };
export const queueMachine = setup({
  types: {} as { context: Ctx },
  actors: { worker: workerMachine },
}).createMachine({
  context: { n: 0 },
  initial: "a",
  states: {
    a: {
      on: {
        go: {
          actions: [
            enqueueActions(({ context, enqueue, self }) => {
              {
                enqueue.raise({ type: "go" });
              }
              if (context.n > 0) enqueue(raise({ type: "go" }));
              else enqueue.spawnChild("worker", { id: "w1" });
              enqueue(assign({ n: 1 }));
              enqueue.assign({ n: 2 });
              enqueue.stopChild("w1");
              const x = 1;
            }),
            enqueueActions(() => doIt()),
          ],
        },
      },
    },
  },
});
`);
    expect(code).toContain('enq.raise({ type: "go" })');
    expect(code).toContain('enq.stop("worker", "w1")');
    expect(todos).toEqual(
      expect.arrayContaining([
        "enqueueActions' \"self\" isn't converted",
        "an assign inside enqueueActions: write the data in the transition, with a ternary over the check",
        "enqueueActions: const x = 1; isn't converted",
        "enqueueActions: doIt() isn't converted",
      ]),
    );
  });

  test("v6 transition functions: what they destructure and return, and their enq", () => {
    const { code, todos } = run(`export const v6Machine = createMachine({
  context: { n: 0, list: [] as number[] },
  initial: "a",
  entry: () => {},
  tags: ["root"],
  states: {
    a: {
      entry: [assign({ n: 1 })],
      on: {
        f1: ({ context, self }) => ({ target: "b" }),
        f2: () => ({ target: someVar }),
        f3: () => ({ target: "b", actions: [] }),
        f4: ({ context }) => next(context),
        f5: (_, { raise }) => {
          raise({ type: "x" });
          return { target: "b" };
        },
        f6: (_, enq) => {
          enq.emit({ type: "x" });
          helper(enq);
          return { target: "b" };
        },
        f7: ({ context }) => {
          {
            return { target: "b" };
          }
        },
        f8: ({ context }) => {
          for (const x of context.list) return { target: "b" };
        },
        f9: ({ context }) => {
          if (context.n > 0) {
            return { target: "b" };
          } else return undefined;
        },
      },
    },
    b: { type: "final", exit: () => {} },
  },
});
`);
    expect(code).toContain("return null;");
    expect(todos).toEqual(
      expect.arrayContaining([
        '"self" isn\'t available in a transition: depend on data and the event',
        'a target that isn\'t a string written in place: write to("state", data)',
        "\"actions\" in a transition's result isn't converted",
        'a transition result the codemod can\'t read: return to("state", data) or null',
        "a destructured enq: name it, (args, enq) => ..., to keep its effects",
        "enq.emit isn't converted: @reactre/state's enq has enq(fn, ...args), raise, cancel, log, sendTo (and emit, spawn with their opt-ins)",
        "enq isn't converted: @reactre/state's enq has enq(fn, ...args), raise, cancel, log, sendTo (and emit, spawn with their opt-ins)",
        "entry's assign: write the data in the transitions into a, as an entry here runs after the move",
        "exit on a final state: the machine ends there, so it never runs",
        "entry on the machine itself: put it on its top-level states",
        "tags on the machine itself: put them on its top-level states",
      ]),
    );
  });
});

describe("timers", () => {
  test("after: delays by name, ISO durations and units, and the ones it can't read", () => {
    const { code, todos } = run(`const DELAY = 10;
export const timersMachine = setup({
  delays: {
    block: ({ context }) => {
      const m = context.ms;
      return m;
    },
    byEvent: ({ event }) => event.ms,
    soon: "5s",
    odd: makeDelay(),
  },
}).createMachine({
  context: { ms: 10 },
  initial: "a",
  states: {
    a: {
      after: {
        block: "b",
        byEvent: "b",
        soon: "b",
        odd: "b",
        missing: "b",
        PT1M30S: "b",
        3600000: "b",
        120000: "b",
        1500: "b",
        [DELAY]: "b",
      },
    },
    b: { on: { go: "a" } },
  },
});
`);
    expect(code).toContain('"5s": ');
    expect(code).toContain('"90s": ');
    expect(code).toContain('"1h": ');
    expect(code).toContain('"2m": ');
    expect(code).toContain('"1500ms": ');
    expect(todos).toEqual(
      expect.arrayContaining([
        'the delay "block" has a block body: write it as one expression',
        'the delay "byEvent" reads the event: here a delay reads the state\'s data. Keep what it reads in the data',
        "timer \"odd\" is left out: its delay isn't a number or a function of the context the codemod can read. Write it in setup's delays",
        'timer "missing" is left out: its delay isn\'t written in this file. Add it to after as "500ms", "5s", "2m" or "1h"',
        "a delay the codemod can't read",
      ]),
    );
  });

  test("v6's timeout: by a delay's name, a function, and the forms it can't read", () => {
    const { code, todos } = run(`export const timeoutMachine = setup({
  delays: { short: 100, later: ({ context }) => context.ms },
}).createMachine({
  context: { ms: 10 },
  initial: "t2",
  states: {
    t1: { onTimeout: "b" },
    t2: { timeout: "short", onTimeout: "t3" },
    t3: { timeout: "later", onTimeout: "t4" },
    t4: { timeout: "nope", onTimeout: "b" },
    t5: { timeout: ({ event }) => event.ms, onTimeout: "b" },
    t6: { timeout: someValue, onTimeout: "b" },
    t7: { timeout: 100 },
    b: { on: { go: "t1" } },
  },
});
`);
    expect(code).toContain("timeout: 100,");
    expect(code).toContain('timeout: "later",');
    expect(todos).toEqual(
      expect.arrayContaining([
        "onTimeout without a timeout: it never runs",
        "timeout \"nope\" isn't one of setup's delays: write it in milliseconds",
        "a timeout function that reads the event or has a block body: compute it from the data, as one expression",
        "timeout someValue isn't a number, a delay's name or a function written in place",
        "a timeout without onTimeout: say where to go when it expires",
      ]),
    );
  });
});

describe("invokes", () => {
  test("actor logic the codemod converts, and the kinds it can't", () => {
    const { todos } = run(`import { loadThing } from "./api";
const remote = fromObservable(() => interval(10));
const stream = fromEventObservable(() => events$);
const stepper = fromTransition((s) => s, 0);
const loader = fromPromise(async (args) => args.input);
const extra = fromPromise(async ({ input, self }, more) => input);
const untyped = fromPromise(async ({ input }) => input);
const custom = makeLogic();
const cb1 = fromCallback((args) => {});
const cb2 = fromCallback(({ sendBack, self }) => {
  sendBack(ev);
});
const cb3 = fromCallback(({ input }) => {});
const cb4 = fromCallback(({ sendBack }) => {
  sendBack({ type: "unknownEvent" });
});
export const invokesMachine = setup({
  actors: { loader, extra, untyped, stub1: fromCallback(() => {}), stub2: fromTransition(() => {}, 0) },
}).createMachine({
  initial: "i1",
  states: {
    i1: { invoke: someInvoke, on: { go: "i2" } },
    i2: { invoke: { id: "x" }, on: { go: "i3" } },
    i3: { invoke: { src: loadThing }, on: { go: "i4" } },
    i4: { invoke: { src: "loader", timeout: 100, onDone: "i5" }, on: { go: "i5" } },
    i5: { invoke: { src: createMachine({ initial: "x", states: { x: {} } }) }, on: { go: "i6" } },
    i6: { invoke: [{ src: remote }, { src: stream }, { src: stepper }], on: { go: "i7" } },
    i7: { invoke: { src: fromPromise(async () => 1) }, on: { go: "i8" } },
    i8: { invoke: { src: custom }, on: { go: "i9" } },
    i9: { invoke: { src: fromCallback(({ sendBack }) => {}) }, on: { go: "i10" } },
    i10: { invoke: [{ src: "extra", input: () => { const v = 1; return v; } }, { src: "untyped", input: { a: 1 } }], on: { go: "i11" } },
    i11: { invoke: [{ src: cb1 }, { src: cb2 }, { src: cb3, input: { a: 1 } }, { src: cb4 }], on: { go: "i12" } },
    i12: { invoke: [{ id: "s1", src: "stub1" }, { src: "stub2" }], on: { go: "i1" } },
  },
});
`);
    expect(todos).toEqual(
      expect.arrayContaining([
        "an invoke that isn't an object literal: write a task or children by hand",
        "invoke's src isn't defined in this file: write a task or children by hand",
        "invoke's src loadThing isn't defined in this file: write a task or children by hand",
        "invoke's \"timeout\" isn't converted: give the logic its timeout (createAsyncLogic's timeout), and handle the TimeoutError in error",
        "an inline child machine: declare it as a module-level const, so it converts on its own",
        "invoke of fromObservable: write it as createObservableLogic from @reactre/state/logic: its values are the child's snapshots, and handle it in the state's children",
        "invoke of fromEventObservable: write it as createEventObservableLogic<Events> from @reactre/state/logic: the events it sends back can't be read from the observable, and handle it in the state's children",
        "invoke of fromTransition: write it as createStepLogic from @reactre/state/logic, whose step gets the state and the event, and handle it in the state's children",
        "inline async logic: declare it as a module-level const",
        "invoke of custom: only fromPromise, createAsyncLogic, fromCallback and machines convert. Write a task or children by hand",
        "inline callback logic: declare it as a module-level const, so it converts on its own",
        "an input function with a block body: write it as one expression",
        'the task gets "self" in XState; @reactre/state\'s run gets its data and a signal',
        "the task's enq: effects of a task run in its run function directly",
        "the task's function has no parameter type: annotate its input",
        "a state runs one task: merge these into one, or move one to a child state",
        "destructure the callback's argument (({ input, sendBack, receive }) => ...)",
        "the callback's \"self\" isn't converted: callback logic gets input, sendBack and receive",
        "the callback sends back an event that isn't an object with its type written in place: add it to Sends",
        "the callback's input has no type: write it in createCallbackLogic's second type argument",
      ]),
    );
  });
});

describe("state nodes", () => {
  test("keys and values the codemod can't convert", () => {
    const { todos } = run(`export const nodesMachine = createMachine({
  initial: "a",
  states: {
    a: {
      tags: [tagName],
      description: desc,
      output: { x: 1 },
      foo: 1,
      context: { n: 1 },
      on: { go: "h" },
    },
    c: someState,
    h: { type: "history", target: someVar },
  },
});
export const contextRefMachine = createMachine({
  context: someContext,
  initial: "a",
  states: { a: { entry: [makers["log"]()], on: { go: "a" } } },
});
`);
    expect(todos).toEqual(
      expect.arrayContaining([
        "tags [tagName] that aren't strings written in place",
        "a description that isn't a string written in place: desc",
        "output { x: 1 }: here a final state's data is its output. Write what it computes into the data the transitions into it give",
        '"foo" isn\'t converted',
        '"context" isn\'t converted',
        'state "c" isn\'t an object literal written in place',
        "a history target that isn't a string: write back(parent, to(...)) by hand",
        "the context isn't an object literal: write start's data by hand",
        'an action the codemod can\'t read: makers["log"]()',
      ]),
    );
  });
});

describe("events", () => {
  test("wildcards handle the declared events they match", () => {
    const { code, report } =
      run(`type Ev = { type: "ui.click" } | { type: "ui.key"; key: string } | { type: "other" } | { type: "unused" };
export const uiMachine = createMachine({
  types: {} as { events: Ev },
  initial: "a",
  states: {
    a: { on: { "ui.*": "b" } },
    b: { on: { "*": "a" } },
  },
});
export const narrowMachine = createMachine({
  types: {} as { events: Ev },
  initial: "a",
  states: { a: { on: { "ui.*": "a" } } },
});
`);
    expect(code).toContain(
      'events: { "ui.click": types<{}>(), "ui.key": types<{ key: string }>(), other: types<{}>(), unused: types<{}>() }',
    );
    expect(report.map((r) => r.message)).toContain(
      'event "other" is declared but no state handles it: left out of events (sending it is now a type error)',
    );
  });

  test("callback logic sends back the machine's events, with their fields", () => {
    const { code } = run(`type Ev = { type: "tick"; at: number; note?: string };
const clock = fromCallback(({ sendBack }) => {
  sendBack({ type: "tick", at: 1 });
});
export const clockMachine = createMachine({
  types: {} as { events: Ev },
  initial: "a",
  states: { a: { invoke: { src: clock, onError: "a" }, on: { tick: "a" } } },
});
`);
    expect(code).toContain(
      'const clock = createCallbackLogic<never, undefined, { type: "tick"; at: number; note?: string }>(',
    );
  });

  test("a callback without a cleanup gets a no-op one, with a TODO; one with a cleanup keeps it", () => {
    const { code, report } = run(`type Ev = { type: "tick" };
const ping = fromCallback(({ sendBack }) => {
  const send = () => {
    return sendBack({ type: "tick" });
  };
  setInterval(send, 10);
});
const clock = fromCallback(({ sendBack }) => {
  const id = setInterval(() => sendBack({ type: "tick" }), 10);
  return () => clearInterval(id);
});
export const pingMachine = createMachine({
  types: {} as { events: Ev },
  initial: "a",
  states: {
    a: { invoke: { src: ping, onError: "b" }, on: { tick: "b" } },
    b: { invoke: { src: clock, onError: "a" }, on: { tick: "a" } },
  },
});
`);
    const message =
      "the callback returned no cleanup, and callback logic returns one: release what it sets up (an interval, a listener) in this function";
    expect(code).toContain(`  setInterval(send, 10);\n\n// TODO(@reactre/state): ${message}\nreturn () => {};\n});`);
    expect(code).toContain("  return () => clearInterval(id);\n});");
    expect(code.split(message)).toHaveLength(2);
    expect(report.filter((r) => r.message === message)).toEqual([{ line: 4, message, todo: true }]);
  });
});

describe("staying in a state", () => {
  test("in a state with a timer, a stay is keep (its timers keep running), and reenter: true restarts them", () => {
    const { code } = run(`type Ctx = { n: number };
export const pollMachine = createMachine({
  types: {} as { context: Ctx },
  context: { n: 0 },
  initial: "polling",
  states: {
    polling: {
      after: { 1000: "done" },
      on: {
        bump: { actions: assign({ n: ({ context }) => context.n + 1 }) },
        same: "polling",
        restart: { target: "polling", reenter: true },
        leave: { target: "idle", reenter: true },
      },
    },
    idle: { on: { same: "idle", start: "polling" } },
    done: { type: "final" },
  },
});
`);
    expect(code).toContain('bump: ({ data, keep }) => keep("polling", { n: data.n + 1 })');
    expect(code).toContain('same: ({ data, keep }) => keep("polling", data)');
    expect(code).toContain('restart: ({ data, reenter }) => reenter("polling", data)');
    // reenter: true to another state is a plain move; a stay without a timer is a plain to.
    expect(code).toContain('leave: ({ data, to }) => to("idle", data)');
    expect(code).toContain('idle: { on: { same: ({ data, to }) => to("idle", data)');
    expect(code).toContain("use: [reenter]");
  });

  test("reenter: true from a parent state to a state under it", () => {
    const { code } = run(`export const retryMachine = createMachine({
  initial: "job",
  states: {
    job: {
      initial: "running",
      on: { retry: { target: ".running", reenter: true } },
      states: { running: { after: { 1000: "failed" } }, failed: { on: { give: "#retry.over" } } },
    },
    over: { type: "final" },
  },
  id: "retry",
});
`);
    expect(code).toContain('retry: ({ reenter }) => reenter("job.running")');
  });
});

describe("assign", () => {
  test("one assign's property assigners all read the context before it; a later assign reads theirs", () => {
    const { code } = run(`type Ctx = { a: number; b: number; c: number };
export const sumMachine = createMachine({
  types: {} as { context: Ctx },
  context: { a: 0, b: 0, c: 0 },
  initial: "x",
  states: {
    x: {
      on: {
        go: {
          target: "y",
          actions: [
            assign({ a: ({ context }) => context.a + 1, b: ({ context }) => context.a }),
            assign({ c: ({ context }) => context.a + context.b }),
          ],
        },
      },
    },
    y: { on: { back: "x" } },
  },
});
`);
    expect(code).toContain('to("y", { a: data.a + 1, b: data.a, c: (data.a + 1) + data.a })');
  });
});
