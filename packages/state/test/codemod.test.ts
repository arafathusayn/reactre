// The codemod (../codemod): each XState machine in ./codemod/*.xstate.ts converts to the expected
// @reactre/state machine, with the expected report; the output compiles; and it replays the same
// sequence of states as the XState original, event by event.
//
// The nested, parallel and history cases use the core's hierarchy (dotted leaves, `parallel`,
// `back`): without `src/nested.ts`, their output and report are checked, and compiling and
// replaying them are skipped. ./codemod/graph.ts uses each expected machine, so `bun check` runs
// the type checker's graph checks on them.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./compiled.ts";

const { convert } = await import("../codemod/index.ts");
const { compile } = await import("../compiler/index.ts");
const { createActor } = await import("@reactre/state");
const xstate5 = await import("./codemod/xstate5.ts");
const { toV5 } = await import("./codemod/xstate4.ts");

type XState5 = typeof xstate5;

const here = new URL("./codemod/", import.meta.url).pathname;
const out = `${here}out/`;
mkdirSync(out, { recursive: true });

/** The opt-ins for nested states, parallel states and history have landed. */
const core = existsSync(new URL("../src/features/nested/index.ts", import.meta.url).pathname);

type Event = { readonly type: string; readonly [key: string]: unknown };
type Step = { readonly send: Event } | { readonly wait: number } | { readonly finish: string };

interface Case {
  /** The file stem: `./codemod/<name>.xstate.ts` (`.xstate.json` for a JSON export). */
  readonly name: string;
  /** The machine's export, in both files (a JSON export's is named by the codemod). */
  readonly machine: string;
  /**
   * Which XState runs the original: v6 beta, v5, a v4 machine on v5 with v4's meaning
   * (./codemod/xstate4.ts's `toV5`, as v4 isn't installed), or a JSON config on v5 with `provide`.
   */
  readonly xstate: "xstate6" | "v5" | "v4" | { readonly json: (xstate: XState5) => object };
  /** It uses API the core added with `src/nested.ts`: compiling and replaying it wait for that module. */
  readonly nested: boolean;
  /** The report, as `line: message` (TODOs as `line: TODO message`). */
  readonly report: readonly string[] | "file";
  readonly steps: readonly Step[];
  /** Parallel states, whose snapshot holds a leaf per region. */
  readonly parallel?: readonly string[];
  /** The output doesn't compile until its TODOs are fixed: the compiler's error. */
  readonly compileError?: RegExp;
}

const cases: readonly Case[] = [
  {
    name: "door",
    machine: "doorMachine",
    xstate: "xstate6",
    nested: false,
    report: ["5: doorMachine: 3 states, 4 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "push", by: "ann" } },
      { send: { type: "close" } },
      { send: { type: "lock", code: "42" } },
      { send: { type: "unlock", code: "7" } },
      { send: { type: "unlock", code: "42" } },
    ],
  },
  {
    name: "job",
    machine: "jobMachine",
    xstate: "xstate6",
    nested: false,
    report: ["16: jobMachine: 4 states, 3 events, internal storeDone; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "save", text: "hi" } },
      { send: { type: "cancel" } },
      { send: { type: "save", text: "hi" } },
      { wait: 40 },
      { send: { type: "retry" } },
      { send: { type: "save", text: "again" } },
      { finish: "id-1" },
    ],
  },
  {
    name: "checkout",
    machine: "checkoutMachine",
    xstate: "xstate6",
    nested: false,
    report: ["6: checkoutMachine: 3 states, 5 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "pay" } },
      { send: { type: "add", price: 30 } },
      { send: { type: "apply", code: "BAD" } },
      { send: { type: "apply", code: "SAVE10" } },
      { send: { type: "pay" } },
      { send: { type: "back" } },
      { send: { type: "pay" } },
      { send: { type: "confirm" } },
    ],
  },
  {
    // M325: mirrored states stay, with the fix as a TODO the compiler takes, so the output builds.
    name: "approval",
    machine: "approvalMachine",
    xstate: "v5",
    nested: false,
    report: [
      "7: approvalMachine: 4 states, 4 events; the context is narrowed to each state's data",
      '7: events "manager", "director", "pay", "reject" have no type: guessed no payload. Add the fields they carry to setup\'s events',
      '11: TODO "approved_by_manager" and "approved_by_director" are the same state twice (same data, same handlers): make one state, "approved", with the difference in its data, { by: "manager" | "director" }',
    ],
    steps: [
      { send: { type: "manager" } },
      { send: { type: "reject" } },
      { send: { type: "director" } },
      { send: { type: "pay" } },
    ],
  },
  {
    name: "v4",
    machine: "counterMachine",
    xstate: "v4",
    nested: false,
    report: ["13: counterMachine: 3 states, 4 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "DEC" } },
      { send: { type: "INC", by: 2 } },
      { send: { type: "DEC" } },
      { send: { type: "STOP" } },
      { send: { type: "RESUME" } },
      { send: { type: "INC", by: 5 } },
      { send: { type: "STOP" } },
    ],
  },
  {
    name: "editor",
    machine: "editorMachine",
    xstate: "v5",
    nested: true,
    report: ["6: editorMachine: 4 states, 6 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "open" } },
      { send: { type: "submit", by: "bo" } },
      { send: { type: "write", text: "hi" } },
      { send: { type: "submit", by: "bo" } },
      { send: { type: "revise" } },
      { send: { type: "cancel" } },
      { send: { type: "open" } },
      { send: { type: "write", text: "again" } },
      { send: { type: "submit", by: "cy" } },
      { send: { type: "approve" } },
    ],
  },
  {
    name: "player",
    machine: "playerMachine",
    xstate: "xstate6",
    nested: true,
    parallel: ["on"],
    report: ["6: playerMachine: 5 states, 6 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "power" } },
      { send: { type: "play", track: "a" } },
      { send: { type: "mute" } },
      { send: { type: "louder" } },
      { send: { type: "unmute" } },
      { send: { type: "louder" } },
      { send: { type: "power" } },
      { send: { type: "power" } },
      { send: { type: "stop" } },
    ],
  },
  {
    name: "history",
    machine: "radioMachine",
    xstate: "v5",
    nested: true,
    report: ["5: radioMachine: 4 states, 4 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "disconnect" } },
      { send: { type: "reconnect" } },
      { send: { type: "play" } },
      { send: { type: "pause" } },
      { send: { type: "disconnect" } },
      { send: { type: "reconnect" } },
      { send: { type: "play" } },
    ],
  },
  {
    name: "upload",
    machine: "uploaderMachine",
    xstate: "v5",
    nested: true,
    report: [
      "5: uploadMachine: 2 states, 0 events; the context is narrowed to each state's data",
      "16: uploaderMachine: 2 states, 2 events; the context is narrowed to each state's data",
    ],
    steps: [
      { send: { type: "upload", file: "a.png" } },
      { wait: 40 },
      { send: { type: "upload", file: "b.png" } },
      { send: { type: "cancel" } },
    ],
  },
  {
    name: "panel",
    machine: "panelMachine",
    xstate: "v5",
    nested: false,
    report: [
      "19: panelMachine: 2 states, 3 events; each state keeps the whole context",
      '19: event "ping" is declared but no state handles it: left out of events (sending it is now a type error)',
      "25: guard \"isWeekday\" isn't pure (it constructs an object with new; it reads the clock): it is setup's guard, called in the handler, so a test can replace it with provide",
      "31: TODO narrow this state's data to the fields it uses: line 38 updates the context with a value built elsewhere",
      "35: TODO narrow this state's data to the fields it uses: line 38 updates the context with a value built elsewhere",
      "36: TODO XState's actor errored when ticker failed: say where to go",
      "38: TODO write this state's data by hand: the context update can't be read field by field",
      "39: TODO stateIn: decide by the state the event is in, or keep the fact in data",
    ],
    steps: [{ send: { type: "open" } }, { wait: 10 }],
  },
  // Each opt-in the codemod writes: effects (and provide, emit), always (with tags, output,
  // reenter, wildcards), delays, callback logic, spawn, and v6's timeout.
  {
    name: "effects",
    machine: "playerMachine",
    xstate: "v5",
    nested: false,
    report: [
      "10: playerMachine: 3 states, 7 events; the context is narrowed to each state's data",
      '41: action "announce" reads the context or the event: its body runs where it is used (enq(() => ...)). To replace it in tests, make it setup\'s action and pass it what it reads as params',
    ],
    steps: [
      { send: { type: "play", track: "a" } },
      { send: { type: "snooze" } },
      { wait: 30 },
      { send: { type: "pause" } },
      { send: { type: "stop" } },
      { send: { type: "play", track: "b" } },
      { send: { type: "stop" } },
    ],
  },
  {
    name: "always",
    machine: "wizardMachine",
    xstate: "v5",
    nested: true,
    report: ["6: wizardMachine: 3 states, 3 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "next" } },
      { send: { type: "next" } },
      { send: { type: "retry" } },
      { send: { type: "noise" } },
      { send: { type: "next" } },
    ],
  },
  {
    name: "delays",
    machine: "reminderMachine",
    xstate: "v5",
    nested: false,
    report: ["6: reminderMachine: 4 states, 2 events; the context is narrowed to each state's data"],
    // sla (20ms) moves to late at 20ms, and soon (30ms) to done at 50ms.
    steps: [{ send: { type: "start", ms: 20 } }, { wait: 10 }, { wait: 25 }, { wait: 40 }],
  },
  {
    name: "callback",
    machine: "clockMachine",
    xstate: "v5",
    nested: false,
    report: ["11: clockMachine: 2 states, 3 events; the context is narrowed to each state's data"],
    // A tick each 20ms: the third (at 60ms) goes back to idle.
    steps: [
      { send: { type: "start" } },
      { wait: 30 },
      { wait: 50 },
      { send: { type: "start" } },
      { send: { type: "stop" } },
    ],
  },
  {
    name: "spawn",
    machine: "poolMachine",
    xstate: "v5",
    nested: false,
    report: [
      "5: workerMachine: 2 states, 1 event; the context is narrowed to each state's data",
      "10: poolMachine: 2 states, 3 events; the context is narrowed to each state's data",
    ],
    steps: [
      { send: { type: "add" } },
      { send: { type: "cancel" } },
      { send: { type: "add" } },
      { send: { type: "close" } },
    ],
  },
  {
    name: "timeout",
    machine: "callMachine",
    xstate: "xstate6",
    nested: false,
    report: ["9: callMachine: 4 states, 3 events; the context is narrowed to each state's data"],
    steps: [
      { send: { type: "dial", to: "bo" } },
      { send: { type: "answer" } },
      { send: { type: "hangUp" } },
      { send: { type: "dial", to: "cy" } },
      { wait: 40 },
    ],
  },
  // Stately Studio's exports, one of each kind, and a sign-in flow drawn there.
  {
    name: "stately-v5",
    machine: "machine",
    xstate: "v5",
    nested: false,
    report: "file",
    steps: [
      { send: { type: "bad" } },
      { send: { type: "submit", comment: "slow" } },
      { send: { type: "back" } },
      { send: { type: "good" } },
      { wait: 40 },
    ],
  },
  {
    name: "stately-setup",
    machine: "machine",
    xstate: "v5",
    nested: false,
    report: "file",
    steps: [
      { send: { type: "timer" } },
      { send: { type: "timer" } },
      { send: { type: "timer" } },
      { send: { type: "emergency" } },
      { wait: 10 },
      { send: { type: "clear" } },
      { send: { type: "timer" } },
      { wait: 60 },
    ],
  },
  {
    name: "stately-v4",
    machine: "machine",
    xstate: "v4",
    nested: false,
    report: "file",
    steps: [
      { send: { type: "PICK", file: "a.png" } },
      { send: { type: "PICK", file: "a.png" } },
      { wait: 10 },
      { send: { type: "CANCEL" } },
    ],
  },
  {
    name: "stately-json",
    machine: "checkoutMachine",
    xstate: {
      json: (x) => ({
        guards: { isEmpty: () => false },
        actors: { chargeCard: x.fromPromise(async () => {}) },
      }),
    },
    nested: true,
    report: "file",
    steps: [
      { send: { type: "checkout" } },
      { send: { type: "next" } },
      { send: { type: "back" } },
      { send: { type: "cancel" } },
      { send: { type: "checkout" } },
      { send: { type: "next" } },
      { send: { type: "pay" } },
      { wait: 10 },
    ],
  },
  {
    name: "stately-auth",
    machine: "machine",
    xstate: "v5",
    nested: true,
    parallel: ["Signed in"],
    report: "file",
    steps: [
      { send: { type: "submit", email: "a@b.c", password: "pw" } },
      { wait: 10 },
      { send: { type: "verify", code: "123" } },
      { wait: 10 },
      { send: { type: "openMenu" } },
      { send: { type: "reload" } },
      { wait: 10 },
      { send: { type: "closeMenu" } },
      { send: { type: "logout" } },
      { send: { type: "submit", email: "a@b.c", password: "pw" } },
      { wait: 10 },
      { wait: 60 },
      { send: { type: "resend" } },
      { send: { type: "logout" } },
    ],
  },
];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** XState's state value as dotted leaves, sorted: `{ on: { a: "x", b: "y" } }` is `on.a.x,on.b.y`. */
function xstateLeaves(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [`${prefix}${value}`];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => xstateLeaves(v, `${prefix}${k}.`));
}

/** Our snapshot's leaves: the state, or each region's leaf in a parallel state. */
function ourLeaves(
  snapshot: { readonly state: string; readonly data: unknown },
  parallel: readonly string[],
): string[] {
  if (!parallel.includes(snapshot.state)) return [snapshot.state];
  const regions = snapshot.data;
  if (typeof regions !== "object" || regions === null) return [snapshot.state];
  return Object.values(regions).map((r: { readonly state: string }) => r.state);
}

/** Runs the steps on an actor, recording the leaves after each. */
async function replay(
  start: () => { send: (e: Event) => unknown; leaves: () => string[] },
  finish: { current: ((id: string) => void) | null },
  steps: readonly Step[],
): Promise<string[]> {
  const actor = start();
  const states = [actor.leaves().sort().join(",")];
  for (const s of steps) {
    if ("send" in s) actor.send(s.send);
    else if ("wait" in s) await tick(s.wait);
    else {
      finish.current?.(s.finish);
      await tick();
    }
    states.push(actor.leaves().sort().join(","));
  }
  return states;
}

function isMachineModule(m: unknown): m is { readonly [k: string]: unknown } {
  return typeof m === "object" && m !== null;
}

describe("the CLI", () => {
  test("writes <name>.state.ts next to the source and prints the report", async () => {
    const source = `${out}cli-door.ts`;
    await Bun.write(source, await Bun.file(`${here}door.xstate.ts`).text());
    const cli = Bun.spawnSync([process.execPath, new URL("../codemod/index.ts", import.meta.url).pathname, source]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toBe(
      `${source} -> ${out}cli-door.state.ts\n` +
        `${source}:5: doorMachine: 3 states, 4 events; the context is narrowed to each state's data\n0 TODOs\n`,
    );
    expect(await Bun.file(`${out}cli-door.state.ts`).text()).toBe(await Bun.file(`${here}door.expected.ts`).text());
  });
});

describe("the formatting", () => {
  // `bun fmt` skips a path its ignore files match and prints the code unchanged. A target in an
  // ignored folder (as ./codemod/out/ is) is still formatted. The folder is outside the home
  // folder, so no Prettier config above it changes how `bun fmt` reads ignore files.
  test("formats a target in a folder .gitignore ignores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reactre-state-codemod-fmt-"));
    try {
      // A repository root (`.git`) whose .gitignore ignores a folder: `bun fmt` reads it there.
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".gitignore"), "ignored/\n");
      mkdirSync(join(dir, "ignored"));
      const source = await Bun.file(`${here}door.xstate.ts`).text();
      const plain = convert(join(dir, "door.ts"), source).code;
      expect(convert(join(dir, "ignored", "door.ts"), source).code).toBe(plain);
      expect(plain).not.toBe(convert(join(dir, "door.ts"), source, { format: false }).code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const c of cases) {
  describe(c.name, () => {
    const json = typeof c.xstate === "object";
    const file = `${here}${c.name}.xstate.${json ? "json" : "ts"}`;
    const expectedFile = `${here}${c.name}.expected.ts`;
    const outFile = `${out}${c.name}.ts`;
    let converted: ReturnType<typeof convert> | null = null;
    const result = async () => {
      if (converted === null) converted = convert(json ? `${out}${c.name}.json` : outFile, await Bun.file(file).text());
      return converted;
    };

    test("converts to the expected output", async () => {
      const { code } = await result();
      expect(code).toBe(await Bun.file(expectedFile).text());
    });

    test("reports what it converted and what it couldn't", async () => {
      const { report } = await result();
      const expected =
        c.report === "file"
          ? (await Bun.file(`${here}${c.name}.report.txt`).text()).split("\n").filter(Boolean)
          : [...c.report];
      expect(report.map((r) => `${r.line}: ${r.todo ? "TODO " : ""}${r.message}`)).toEqual(expected);
    });

    test.skipIf(c.nested && !core)(
      c.compileError === undefined ? "compiles" : "fails to compile until its TODOs are fixed",
      async () => {
        const { code } = await result();
        if (c.compileError === undefined) expect(compile(outFile, code)).not.toBeNull();
        else expect(() => compile(outFile, code)).toThrow(c.compileError);
      },
    );

    test.skipIf((c.nested && !core) || c.compileError !== undefined)("replays the same states as XState", async () => {
      const { code } = await result();
      await Bun.write(outFile, code);
      const ours: unknown = await import(outFile);
      if (!isMachineModule(ours)) throw new Error("no module");
      const finishOurs: { current: ((id: string) => void) | null } = { current: null };
      const useSave = ours["useSave"];
      if (typeof useSave === "function") useSave(() => new Promise<string>((r) => (finishOurs.current = r)));
      const machine = ours[c.machine];
      const got = await replay(
        () => {
          // @ts-expect-error a machine loaded by path: its type isn't known here
          const actor = createActor(machine);
          return {
            send: (e: Event) => actor.send(e),
            leaves: () => ourLeaves(actor.snapshot(), c.parallel ?? []),
          };
        },
        finishOurs,
        c.steps,
      );

      const kind = c.xstate;
      const original: unknown = typeof kind === "object" ? {} : await import(file);
      if (!isMachineModule(original)) throw new Error("no module");
      const xstate: unknown = kind === "xstate6" ? await import("xstate6") : xstate5;
      if (!isMachineModule(xstate) || typeof xstate["createActor"] !== "function") throw new Error("no XState");
      const finishTheirs: { current: ((id: string) => void) | null } = { current: null };
      const useSaveTheirs = original["useSave"];
      if (typeof useSaveTheirs === "function")
        useSaveTheirs(() => new Promise<string>((r) => (finishTheirs.current = r)));
      const createXState = xstate["createActor"];
      const theirMachine = async (): Promise<unknown> => {
        if (typeof kind === "object")
          return xstate5.createMachine(await Bun.file(file).json()).provide(kind.json(xstate5));
        const m = original[c.machine];
        if (kind !== "v4") return m;
        if (
          typeof m !== "object" ||
          m === null ||
          !("config" in m) ||
          typeof m.config !== "object" ||
          m.config === null
        )
          throw new Error("not a v4 machine");
        return toV5({
          config: m.config,
          options: "options" in m && typeof m.options === "object" && m.options !== null ? m.options : undefined,
        });
      };
      const machineTheirs = await theirMachine();
      const theirs = await replay(
        () => {
          const actor = createXState(machineTheirs).start();
          return {
            send: (e: Event) => actor.send(e),
            leaves: () => xstateLeaves(actor.getSnapshot().value),
          };
        },
        finishTheirs,
        c.steps,
      );
      expect(got).toEqual(theirs);
    });
  });
}
