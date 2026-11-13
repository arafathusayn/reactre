// Correct machines as source text, for the compiler's tests: test/compiler.test.ts and each
// feature's cases in test/features/<feature>/compiler.ts change one thing in one of them.

/** A compiler case: its name, the source, the problem's line (1 for "anywhere"), and its message. */
export type Case = readonly [name: string, source: string, line: number, message: string];

/** `base` with `from` replaced by `to` (which must be there). */
export function change(base: string, from: string, to: string): string {
  if (!base.includes(from)) throw new Error(`the source has no ${JSON.stringify(from)}`);
  return base.replace(from, to);
}

/**
 * DOOR (or another source with one `setup({` and no `use`) with `features` imported and in use.
 * A persisted machine (persist or durable in `features`) gets its shape's hash, from SHAPES.
 */
export function withUse(features: readonly string[], base: string = DOOR): string {
  const imports = features.map((f) => `import { ${f} } from "@reactre/state/${f}";\n`).join("");
  const persisted = features.includes("persist") || features.includes("durable");
  const hash = SHAPES.get(base);
  if (persisted && hash === undefined) throw new Error("a persisted base needs its shape's hash in SHAPES");
  return change(
    change(base, 'from "@reactre/state";\n', `from "@reactre/state";\n${imports}`),
    "= setup({\n",
    `= setup({\n  use: [${features.join(", ")}],\n${persisted ? `  shape: "${hash}",\n` : ""}`,
  );
}

export const DOOR = `import { createActor, setup, types } from "@reactre/state";

const door = setup({
  states: { closed: types<{}>(), open: types<{ by: string }>(), locked: types<{ code: string }>() },
  events: {
    push: types<{ by: string }>(),
    close: types<{}>(),
    lock: types<{ code: string }>(),
    unlock: types<{ code: string }>(),
  },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ data, event, to }) => (event.code === data.code ? to("closed") : null) } },
  },
});

export const actor = createActor(doorMachine);
`;

export const JOB = `import { createActor, setup, types } from "@reactre/state";

const job = setup({
  states: { idle: types<{}>(), saving: types<{ text: string }>(), saved: types<{ id: string }>(), failed: types<{ error: string }>() },
  events: { save: types<{ text: string }>(), retry: types<{}>() },
  internal: { stored: types<{ id: string }>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
      after: { "1.5s": ({ to }) => to("failed", { error: "timed out" }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});

export const actor = createActor(jobMachine);
`;

/** nested and history: a parent, and `back` to it. */
export const EDITOR = `import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const editor = setup({
  use: [nested, history],
  states: { idle: types<{}>(), "edit.draft": types<{ text: string }>(), "edit.review": types<{ text: string }>() },
  events: { open: types<{}>(), submit: types<{}>(), leave: types<{}>(), resume: types<{}>() },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })), open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("idle") } },
    "edit.draft": { on: { submit: ({ data, to }) => to("edit.review", { text: data.text }) } },
    "edit.review": {},
  },
});
`;

/** nested and parallel: a parallel node with two regions and a `done`. */
export const PLAYER = `import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";

const player = setup({
  use: [nested, parallel],
  parallel: ["on"],
  states: { off: types<{}>(), "on.a.x": types<{}>(), "on.a.y": types<{ n: number }>(), "on.b.z": types<{}>(), "on.b.w": types<{}>() },
  events: { power: types<{}>(), go: types<{}>() },
});

export const playerMachine = player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: { on: { power: ({ to }) => to("on", { a: to("on.a.x"), b: to("on.b.z") }) } },
    on: { on: { power: ({ to }) => to("off") }, done: ({ data, to }) => (data.a.state === "on.a.y" ? to("off") : to("off")) },
    "on.a.x": { on: { go: ({ to }) => to("on.a.y", { n: 1 }) } },
    "on.a.y": { final: true },
    "on.b.z": { on: { go: ({ to }) => to("on.b.w") } },
    "on.b.w": { final: true },
  },
});
`;

/** children: a keyed collection of child actors, with `done` and `update`. */
export const PAGE = `import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";

const worker = setup({
  states: { working: types<{}>(), finished: types<{ url: string }>() },
  events: { finish: types<{ url: string }>() },
});
export const childMachine = worker.machine({
  start: ({ to }) => to("working"),
  states: { working: { on: { finish: ({ event, to }) => to("finished", { url: event.url }) } }, finished: { final: true } },
});

const page = setup({
  use: [children],
  states: { idle: types<{}>(), busy: types<{ files: string[]; seen: string }>(), done: types<{ url: string }>() },
  events: { go: types<{}>() },
  children: { job: childMachine },
});
export const pageMachine = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { files: ["a"], seen: "" }) } },
    busy: {
      children: {
        job: {
          each: ({ data }) => data.files.map((f) => ({ key: f, input: undefined })),
          done: ({ output, to }) => to("done", { url: output.data.url }),
          update: ({ data, child, to }) => to("busy", { ...data, seen: child.state }),
        },
      },
    },
    done: { final: true },
  },
});
`;

/** validate: Standard Schemas for the input, an event and a state. */
export const FORM = `import { setup, types } from "@reactre/state";
import { validate } from "@reactre/state/validate";
import { object, string } from "../fixtures/standard-schema.ts";

const form = setup({
  use: [validate],
  input: object({ name: string() }),
  states: { editing: object({ name: string() }), done: types<{}>() },
  events: { rename: object({ name: string() }), finish: types<{}>() },
});
export const formMachine = form.machine({
  start: ({ input, to }) => to("editing", { name: input.name }),
  states: {
    editing: { on: { rename: ({ event, to }) => to("editing", { name: event.name }), finish: ({ to }) => to("done") } },
    done: { final: true },
  },
});
`;

/** The hash of each source's shape (version 0), which its setup takes when persisted. */
const SHAPES = new Map([
  [DOOR, "kq4c4nj6"],
  [JOB, "3020ooix"],
]);
