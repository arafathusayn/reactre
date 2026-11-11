// @reactre/state/serialize: machine definitions as data, on machines compiled as a build compiles
// them (./compiled.ts registers the plugin), round-tripped through JSON and run again.

import { describe, expect, test } from "bun:test";

import "./compiled.ts";

const { createActor, StateError, transition, initial } = await import("@reactre/state");
const { machineConfigToJSON, machineFromJSON, machineToJSON, serializationDiagnostics } =
  await import("@reactre/state/serialize");
const { child, children } = await import("@reactre/state/children");
const { history } = await import("@reactre/state/history");
const { nested } = await import("@reactre/state/nested");
const { parallel } = await import("@reactre/state/parallel");
const { persist } = await import("@reactre/state/persist");
const { validate } = await import("@reactre/state/validate");
const { doorMachine } = await import("./fixtures/door.ts");
const { editorMachine } = await import("./fixtures/editor.ts");
const { jobMachine } = await import("./fixtures/job.ts");
const { playerMachine } = await import("./fixtures/player.ts");
const { formMachine, pageMachine } = await import("./fixtures/uploads.ts");
const { studioMachine } = await import("./features/parallel/machines.ts");
const { object, string } = await import("./fixtures/standard-schema.ts");

/** The app's evaluator: it decides what code it trusts (here, the test's own machines). */
const evaluate = (code: string): unknown => (0, eval)(`(${code})`);
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Code as a model writes it in a definition: with the authoring arguments. */
const config = (code: string) => ({ "@code": code, "@args": "config" });

/**
 * A revived machine's child. A cast: the machine is `Machine<Shape>`, which names no children, so
 * `child` is called as its implementation is.
 */
const kid = child as unknown as (
  actor: unknown,
  name: string,
  key?: string,
) => { send: (event: { readonly type: string; readonly [key: string]: unknown }) => unknown } | undefined;

/** The snapshot a sequence of events ends in, through `transition`. */
function end(m: Parameters<typeof initial>[0], events: readonly { readonly type: string }[]): unknown {
  let s = initial(m, undefined as never);
  for (const e of events) s = transition(m, s, e as never).snapshot;
  return s;
}

/** The states a sequence of events visits, through `transition`. */
function walk(m: Parameters<typeof initial>[0], events: readonly { readonly type: string }[]): string[] {
  let s = initial(m, undefined as never);
  const seen = [s.state];
  for (const e of events) {
    s = transition(m, s, e as never).snapshot;
    seen.push(s.state);
  }
  return seen;
}

describe("machineToJSON", () => {
  test("structure is data, constant transitions are data, the rest is compiled code", () => {
    const def = machineToJSON(doorMachine);
    expect(def).toMatchObject({
      version: 2,
      events: ["push", "close", "lock", "unlock"],
      start: { to: "closed", data: {} },
      states: {
        closed: { on: { push: { "@args": "table" }, lock: { "@args": "table" } } },
        open: { on: { close: { to: "closed", data: {} } } },
        locked: { on: { unlock: { "@args": "table" } } },
      },
    });
    const push = def.states["closed"]?.on?.["push"];
    expect(push !== undefined && "@code" in push ? push["@code"] : "").toMatch(
      /\(\{ state: "open", data: \{ by: event\.by \}, version: \d+ \}\)/,
    );
    // JSON as it is.
    expect(json(def)).toEqual(def);
  });

  test("tasks, timers, finals, parents, history and parallel regions", () => {
    expect(machineToJSON(jobMachine)).toMatchObject({
      states: {
        saving: { task: { run: { "@args": "table" }, error: { "@args": "table" } }, after: { "20": { to: "failed" } } },
        saved: { final: true },
      },
    });
    expect(machineToJSON(editorMachine)).toMatchObject({ use: ["nested", "history"], history: ["edit"] });
    expect(machineToJSON(playerMachine)).toMatchObject({
      use: ["nested", "parallel"],
      states: { on: { regions: ["playback", "volume"] } },
    });
  });

  test("children: each child's own definition, nested, with its handlers", () => {
    expect(machineToJSON(pageMachine)).toMatchObject({
      use: ["children"],
      states: {
        uploading: {
          children: {
            upload: {
              machine: { events: ["ok", "fail"], states: { sent: { final: true }, failed: { final: true } } },
              input: { "@args": "table" },
              done: { "@args": "table" },
            },
          },
        },
      },
    });
    expect(serializationDiagnostics(pageMachine).map((n) => n.path)).toEqual([
      "/states/idle/on/go",
      "/states/uploading/children/upload/machine/states/sending/on/ok",
      "/states/uploading/children/upload/machine/states/sending/on/fail",
      "/states/uploading/children/upload/machine/start",
      "/states/uploading/children/upload/input",
      "/states/uploading/children/upload/done",
    ]);
  });

  test("a parallel node's done, and constant data with lists, are data; data JSON can't hold is code", () => {
    expect(machineToJSON(studioMachine).states["on.media.player"]).toEqual({
      on: { eject: { to: "on.media.idle", data: {} } },
      regions: ["track", "volume"],
      done: { to: "on.media.finished", data: {} },
    });
    const stamp = '() => ({ state: "idle", data: { at: [new Date(0)] }, version: 0 })';
    const def = machineToJSON(
      machineFromJSON(
        {
          version: 0,
          events: ["stamp"],
          start: { to: "idle", data: { tags: ["a", "b"] } },
          states: { idle: { on: { stamp: { "@code": stamp, "@args": "table" } } } },
        },
        { evaluate },
      ),
    );
    expect(def.start).toEqual({ to: "idle", data: { tags: ["a", "b"] } });
    expect(def.states["idle"]?.on?.["stamp"]).toEqual({ "@code": stamp, "@args": "table" });
  });

  test("diagnostics list each code expression and each omission, by JSON Pointer", () => {
    const notes = serializationDiagnostics(jobMachine);
    expect(notes.map((n) => [n.path, n.kind])).toEqual([
      ["/states/idle/on/save", "code"],
      ["/states/saving/on/stored", "code"],
      ["/states/saving/task/run", "code"],
      ["/states/saving/task/error", "code"],
    ]);
    expect(notes[2]?.message).toMatch(
      /state "saving"'s task \(the effect\) is code: machineFromJSON runs it only through sources\.evaluate/,
    );
    expect(serializationDiagnostics(formMachine).find((n) => n.kind === "omitted")).toMatchObject({
      path: "/use",
      message: expect.stringMatching(/Standard Schemas.*sources\.schemas/),
    });
    expect(serializationDiagnostics({ ...doorMachine, k: {} } as typeof doorMachine)).toEqual([
      expect.objectContaining({ path: "/states/closed/on/push", kind: "code" }),
      expect.objectContaining({ path: "/states/closed/on/lock", kind: "code" }),
      expect.objectContaining({ path: "/states/locked/on/unlock", kind: "code" }),
      expect.objectContaining({
        path: "/k",
        kind: "omitted",
        message: expect.stringMatching(/"k" is a feature's that has no JSON form/),
      }),
    ]);
  });
});

describe("machineFromJSON", () => {
  test("a definition through JSON runs as the machine did", () => {
    const door = machineFromJSON(json(machineToJSON(doorMachine)), { evaluate });
    const events = [
      { type: "push", by: "ann" },
      { type: "close" },
      { type: "lock", code: "1" },
      { type: "unlock", code: "2" },
      { type: "unlock", code: "1" },
    ];
    expect(walk(door, events)).toEqual(walk(doorMachine, events));
  });

  test("nested, history and parallel machines revive with their features", () => {
    const editor = machineFromJSON(json(machineToJSON(editorMachine)), { evaluate, use: { nested, history } });
    const events = [
      { type: "open" },
      { type: "write", text: "a" },
      { type: "leave" },
      { type: "resume" },
      { type: "submit", by: "x" },
    ];
    expect(walk(editor, events)).toEqual(walk(editorMachine, events));
    const player = machineFromJSON(json(machineToJSON(playerMachine)), { evaluate, use: { nested, parallel } });
    const play = [{ type: "power" }, { type: "play", track: "t" }, { type: "mute" }];
    expect(transition(player, initial(player, undefined), play[0] as never).snapshot).toEqual(
      transition(playerMachine, initial(playerMachine, undefined), { type: "power" }).snapshot,
    );
    expect(walk(player, play)).toEqual(walk(playerMachine, play));
  });

  test("children and a parallel node's done revive, and run as the machine did", () => {
    const page = machineFromJSON(json(machineToJSON(pageMachine)), { evaluate, use: { children } });
    const actor = createActor(page);
    actor.send({ type: "go" });
    kid(actor, "upload")?.send({ type: "ok", url: "/a.txt" });
    expect(actor.snapshot()).toEqual({ state: "uploaded", data: { url: "/a.txt" }, version: 0 });

    const studio = machineFromJSON(json(machineToJSON(studioMachine)), { evaluate, use: { nested, parallel } });
    const events = [
      { type: "power" },
      { type: "load" },
      { type: "play", title: "t" },
      { type: "end" },
      { type: "mute" },
    ];
    expect(end(studio, events)).toEqual(end(studioMachine, events));
    expect(end(studio, events)).toMatchObject({ data: { media: { state: "on.media.finished" } } });
  });

  test("a definition as a model writes it: children, each and a parallel node's done take the authoring arguments", () => {
    // A child that runs, may step, and finishes.
    const task = {
      version: 0,
      events: ["step", "finish"],
      start: config('({ input, to }) => to("running", { name: input.name })'),
      states: {
        running: {
          on: {
            step: config('({ data, to }) => to("stepped", data)'),
            finish: config('({ data, to }) => to("over", data)'),
          },
        },
        stepped: { on: { finish: config('({ data, to }) => to("over", data)') } },
        over: { final: true },
      },
    };
    // A board that runs one child for all its files, and one per file, while it is busy.
    const board = machineFromJSON(
      {
        version: 0,
        events: ["open"],
        use: ["children"],
        start: { to: "idle", data: {} },
        states: {
          idle: { on: { open: { to: "busy", data: { files: ["a", "b"], seen: [] } } } },
          busy: {
            children: {
              all: {
                machine: task,
                input: config('({ data }) => ({ name: data.files.join("+") })'),
                done: config('({ output, to }) => to("finished", { name: output.data.name })'),
              },
              file: {
                machine: task,
                each: config("({ data }) => data.files.map((f) => ({ key: f, input: { name: f } }))"),
                update: config(
                  '({ data, child, key, to }) => to("busy", { ...data, seen: [...data.seen, key + ":" + child.state] })',
                ),
              },
            },
          },
          finished: { final: true },
        },
      },
      { evaluate, use: { children } },
    );
    const actor = createActor(board);
    actor.send({ type: "open" });
    kid(actor, "file", "b")?.send({ type: "step" });
    expect(actor.snapshot()).toEqual({ state: "busy", data: { files: ["a", "b"], seen: ["b:stepped"] }, version: 0 });
    kid(actor, "all")?.send({ type: "finish" });
    expect(actor.snapshot()).toEqual({ state: "finished", data: { name: "a+b" }, version: 0 });

    const player = machineFromJSON(
      {
        version: 0,
        events: ["play", "mute"],
        use: ["nested", "parallel"],
        start: config('({ to }) => to("on", { track: to("on.track.stopped"), volume: to("on.volume.loud") })'),
        states: {
          on: {
            regions: ["track", "volume"],
            done: config('({ data, to }) => to("off", { ended: [data.track.state, data.volume.state] })'),
          },
          "on.track.stopped": { on: { play: { to: "on.track.ended", data: {} } } },
          "on.track.ended": { final: true },
          "on.volume.loud": { on: { mute: { to: "on.volume.muted", data: {} } } },
          "on.volume.muted": { final: true },
          off: { final: true },
        },
      },
      { evaluate, use: { nested, parallel } },
    );
    expect(end(player, [{ type: "play" }, { type: "mute" }])).toEqual({
      state: "off",
      data: { ended: ["on.track.ended", "on.volume.muted"] },
      version: 0,
    });

    // `back` goes to the leaf the parent held when it was last left, or to the fallback.
    const notes = machineFromJSON(
      {
        version: 0,
        events: ["open", "write", "leave", "resume"],
        use: ["nested", "history"],
        start: { to: "idle", data: {} },
        states: {
          idle: {
            on: {
              open: { to: "edit.draft", data: { text: "" } },
              resume: config('({ back, to }) => back("edit", to("edit.draft", { text: "new" }))'),
            },
          },
          "edit.draft": {
            on: {
              write: config('({ data, event, to }) => to("edit.review", { text: data.text + event.text })'),
              leave: { to: "idle", data: {} },
            },
          },
          "edit.review": { on: { leave: { to: "idle", data: {} } } },
        },
        history: ["edit"],
      },
      { evaluate, use: { nested, history } },
    );
    expect(end(notes, [{ type: "resume" }])).toMatchObject({ state: "edit.draft", data: { text: "new" } });
    expect(
      end(notes, [
        { type: "open" },
        { type: "write", text: "a" } as { type: string },
        { type: "leave" },
        { type: "resume" },
      ]),
    ).toMatchObject({ state: "edit.review", data: { text: "a" } });
  });

  test("a config's task and timers revive through the authoring arguments, and run in an actor", async () => {
    type Moves = { to: (state: string, data?: object) => unknown };
    const loader = {
      start: ({ input, to }: Moves & { input: { id: string } }) => to("loading", { id: input.id }),
      states: {
        loading: {
          task: {
            run: async ({ data }: { data: { id: string } }) => {
              if (data.id === "") throw new Error("no id");
              return { type: "loaded", name: `item ${data.id}` };
            },
            error: ({ error, to }: Moves & { error: unknown }) => to("failed", { reason: String(error) }),
          },
          on: { loaded: ({ event, to }: Moves & { event: { name: string } }) => to("ready", { name: event.name }) },
        },
        ready: { after: { "5ms": ({ data, to }: Moves & { data: object }) => to("stale", data) } },
        stale: { final: true },
        failed: { final: true },
      },
    };
    const def = machineConfigToJSON(loader, { events: [] });
    expect(def.states["loading"]?.task).toMatchObject({ run: { "@args": "config" }, error: { "@args": "config" } });
    const m = machineFromJSON(json(def), { evaluate });

    const found = createActor(m, { input: { id: "7" } } as never);
    await wait(0);
    expect(found.snapshot()).toEqual({ state: "ready", data: { name: "item 7" }, version: 0 });
    await wait(20);
    expect(found.snapshot()).toEqual({ state: "stale", data: { name: "item 7" }, version: 0 });

    const missing = createActor(m, { input: { id: "" } } as never);
    await wait(0);
    expect(missing.snapshot()).toEqual({ state: "failed", data: { reason: "Error: no id" }, version: 0 });
  });

  test("a definition that uses persist revives with it: the actor saves its timers' deadlines", () => {
    const reminder = machineFromJSON(
      {
        version: 0,
        events: ["snooze"],
        use: ["persist"],
        start: { to: "idle", data: {} },
        states: {
          idle: { on: { snooze: { to: "snoozed", data: {} } } },
          snoozed: { after: { "300000": { to: "idle", data: {} } } },
        },
      },
      { use: { persist } },
    );
    const actor = createActor(reminder, { now: () => 1000 });
    actor.send({ type: "snooze" });
    // A cast: the revived machine is `Machine<Shape>`, whose `use` doesn't name persist.
    const save = persist as unknown as (actor: unknown) => unknown;
    expect(save(actor)).toEqual({ state: "snoozed", data: {}, version: 0, run: { snoozed: { t: [301000] } } });
    actor.stop();
  });

  test("tasks and timers run in an actor; a definition with no code needs no evaluator", async () => {
    const plain = machineFromJSON({
      version: 0,
      events: ["go"],
      start: { to: "idle", data: {} },
      states: {
        idle: { on: { go: { to: "waiting", data: {} } } },
        waiting: { after: { "5": { to: "done", data: { ok: true } } } },
        done: { final: true },
      },
    });
    const actor = createActor(plain);
    actor.send({ type: "go" });
    await new Promise((r) => setTimeout(r, 20));
    expect(actor.snapshot()).toEqual({ state: "done", data: { ok: true }, version: 0 });
  });

  test("a config as written serializes with its text, and revives through the authoring arguments", () => {
    const config = {
      start: ({ to }: { to: (s: string, d?: object) => unknown }) => to("idle"),
      states: {
        idle: {
          on: {
            add: ({ event, to }: { event: { n: number }; to: (s: string, d?: object) => unknown }) =>
              to("counting", { n: event.n }),
          },
        },
        counting: {
          on: {
            add: ({
              data,
              event,
              to,
            }: {
              data: { n: number };
              event: { n: number };
              to: (s: string, d?: object) => unknown;
            }) => to("counting", { n: data.n + event.n }),
          },
          after: { "1h": ({ to }: { to: (s: string) => unknown }) => to("idle") },
        },
      },
    };
    const def = machineConfigToJSON(config, { events: ["add"], version: 1 });
    expect(def).toMatchObject({
      version: 1,
      start: { "@args": "config" },
      states: { counting: { after: { "3600000": {} } } },
    });
    const m = machineFromJSON(json(def), { evaluate });
    let s = initial(m, undefined);
    s = transition(m, s, { type: "add", n: 2 } as never).snapshot;
    s = transition(m, s, { type: "add", n: 3 } as never).snapshot;
    expect(s).toEqual({ state: "counting", data: { n: 5 }, version: 1 });
    expect(() =>
      machineConfigToJSON({ start: () => 0, states: { a: { after: { "5 sec": () => 0 } } } }, { events: [] }),
    ).toThrow(/S25\].*\/states\/a\/after\/5 sec isn't a duration/);
  });

  test("schemas come back through sources, and validate checks with them", () => {
    const def = json(machineToJSON(formMachine));
    const form = machineFromJSON(def, {
      evaluate,
      use: { validate },
      schemas: {
        input: object({ name: string() }),
        states: { editing: object({ name: string() }) },
        events: { rename: object({ name: string() }) },
      },
    });
    expect(() => createActor(form, { input: { name: 1 } } as never)).toThrow(/S5\]/);
    const actor = createActor(form, { input: { name: "a" } } as never);
    expect(actor.send({ type: "rename", name: 2 } as never)).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("what it can't revive, or isn't given, is a StateError naming the fix", () => {
    const def = json(machineToJSON(doorMachine));
    expect(() => machineFromJSON(def)).toThrow(
      /S25\].*\/start|S25\].*is code, and machineFromJSON has no sources\.evaluate/,
    );
    expect(() => machineFromJSON(json(machineToJSON(editorMachine)), { evaluate })).toThrow(
      /S11\] the machine definition uses nested: add it to machineFromJSON's sources\.use \(import \{ nested \} from "@reactre\/state\/nested"\)/,
    );
    expect(() =>
      machineFromJSON({ version: 0, events: [], use: ["effects"], start: { to: "a", data: {} }, states: { a: {} } }),
    ).toThrow(/S26\] the machine definition uses effects, which machineFromJSON can't revive yet/);
    expect(() => machineFromJSON({ version: 0, events: [], start: { to: "b", data: {} }, states: { a: {} } })).toThrow(
      /S25\] the machine definition's \/start\/to goes to "b", which isn't a state: the states are a/,
    );
    expect(() =>
      machineFromJSON({ version: 0, events: [], start: { to: "a", data: {} }, states: { a: { entry: 1 } } }),
    ).toThrow(/S25\] the machine definition's \/states\/a\/entry isn't a key of it/);
    expect(machineToJSON(machineFromJSON(json(machineToJSON(jobMachine)), { evaluate, use: { persist } }))).toEqual(
      machineToJSON(jobMachine),
    );
    expect(StateError).toBeDefined();
  });

  test("a malformed part is S25, naming its JSON path", () => {
    const def = { version: 0, events: ["go"], start: { to: "a", data: {} }, states: { a: {} } };
    const cases: readonly [unknown, RegExp][] = [
      [{ ...def, use: "nested" }, /\/use isn't a list of feature names/],
      [{ ...def, events: "go" }, /\/events isn't a list of event names/],
      [{ ...def, history: "a" }, /\/history isn't a list of parents/],
      [{ ...def, states: { a: { on: { go: "b" } } } }, /\/states\/a\/on\/go isn't code/],
      [{ ...def, states: { a: { after: { "-5": { to: "a", data: {} } } } } }, /\/states\/a\/after\/-5 isn't a number/],
      [{ ...def, states: { a: { regions: "b" } } }, /\/states\/a\/regions isn't a list of region names/],
    ];
    for (const [json, problem] of cases) expect(() => machineFromJSON(json)).toThrow(problem);
  });
});
