// children's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. Cases 53–55, and the opt-in, 61.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { child, children } from "@reactre/state/children";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

// Setup names each child machine; a node runs it while active.
const upload = setup({
  input: types<{ file: string }>(),
  states: { sending: types<{ file: string }>(), sent: types<{ url: string }>(), failed: types<{ reason: string }>() },
  events: { ok: types<{ url: string }>(), fail: types<{ reason: string }>() },
});
const uploadMachine = upload.machine({
  start: ({ input, to }) => to("sending", { file: input.file }),
  states: {
    sending: {
      on: {
        ok: ({ event, to }) => to("sent", { url: event.url }),
        fail: ({ event, to }) => to("failed", { reason: event.reason }),
      },
    },
    sent: { final: true },
    failed: { final: true },
  },
});

// @ts-expect-error 61. setup's children without children in use: the error names the import.
setup({ states: { idle: types<{}>() }, events: {}, children: { upload: uploadMachine } });
expect<
  Equal<
    keyof ShapeCheck<{ states: { idle: Type<{}> }; events: {}; children: { upload: typeof uploadMachine } }>,
    `setup has "children": add children to setup's use (import { children } from "@reactre/state/children")`
  >
>();

const page = setup({
  use: [children],
  states: {
    idle: types<{ file: string }>(),
    uploading: types<{ file: string; progress: string }>(),
    uploaded: types<{ url: string }>(),
    failed: types<{ reason: string }>(),
  },
  events: { go: types<{}>() },
  children: { upload: uploadMachine },
});
// The correct machine: `output` is the union of the child's final states, narrowed by `state`.
export const pageOk = page.machine({
  start: ({ to }) => to("idle", { file: "a" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file, progress: "" }) } },
    uploading: {
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file }),
          done: ({ output, to }) =>
            output.state === "sent"
              ? to("uploaded", { url: output.data.url })
              : to("failed", { reason: output.data.reason }),
          update: ({ data, child, to }) => to("uploading", { ...data, progress: child.state }),
        },
      },
    },
    uploaded: { final: true },
    failed: { final: true },
  },
});
const pageActor = createActor(pageOk);
const kids = page.machine({
  start: ({ to }) => to("idle", { file: "a" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file, progress: "" }) } },
    uploading: {
      children: { upload: {}, uplod: {} },
      on: { go: ({ to }) => to("uploaded", { url: "" }) },
    },
    uploaded: { final: true },
    failed: { final: true },
  },
});
expect<
  Equal<
    typeof kids,
    MachineError<
      | 'state "failed" is unreachable: no transition goes to it. Add one, or remove the state'
      | `state "uploading" runs "uplod", which is not in setup's children: add it there, or check the name`
      | 'state "uploading" runs child "upload" without its input: add input: ({ data }) => ({ ... }), or each'
      | 'state "uploading" runs child "upload", which can end, and has no done for it: add done: ({ output, to }) => to(...)'
    >
  >
>();
// @ts-expect-error 53–55. A child setup lacks, a child without its input, and one whose end nobody handles.
createActor(kids);

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
child(pageActor, "upload")?.send({ type: "ok", url: "" });
// @ts-expect-error M224. A child used without checking it's running: it's gone once it ends.
child(pageActor, "upload").send({ type: "ok", url: "" });

// The second round's rows, by their M#.
const handsOver = page.machine({
  start: ({ to }) => to("idle", { file: "a" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file, progress: "" }) } },
    uploading: {
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file, parent: pageActor }),
          done: ({ output, to }) =>
            output.state === "sent" ? to("uploaded", { url: "" }) : to("failed", { reason: "" }),
        },
      },
    },
    uploaded: { final: true },
    failed: { final: true },
  },
});
expect<
  Equal<
    typeof handsOver,
    MachineError<`state "uploading" gives child "upload" input.parent (an object with methods: a class instance, a DOM node, an actor or a Promise, which JSON can't hold. Store plain data: an id, or the fields you need), which isn't JSON: pass what it needs as data, and send to the parent with sendBack`>
  >
>();
// @ts-expect-error M532. An actor in a child's input: it isn't JSON, and the child talks back with sendBack.
createActor(handsOver);
const registered = setup({
  use: [children, system],
  states: { idle: types<{ files: string[] }>(), done: types<{}>() },
  events: { go: types<{}>() },
  children: { upload: uploadMachine },
});
const sameKey = registered.machine({
  start: ({ to }) => to("idle", { files: [] }),
  states: {
    idle: {
      children: {
        upload: {
          each: ({ data }) => data.files.map((file) => ({ key: file, input: { file } })),
          registryKey: "upload",
          done: ({ data, keep }) => keep("idle", data),
        },
      },
      on: { go: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof sameKey,
    MachineError<`state "idle"'s child "upload" has each and registryKey: a child takes each or registryKey, not both; register each item's child by its key`>
  >
>();
// @ts-expect-error M534. each and registryKey: every item's child takes the one key.
createActor(sameKey);
const nestedPage = setup({
  use: [children, nested],
  states: { "job.a": types<{ file: string }>(), done: types<{}>() },
  events: { go: types<{}>() },
  children: { upload: uploadMachine },
});
const twoAtOnce = nestedPage.machine({
  start: ({ to }) => to("job.a", { file: "a" }),
  states: {
    job: {
      children: { upload: { input: () => ({ file: "a" }), done: ({ to }) => to("done") } },
      on: { go: ({ to }) => to("done") },
    },
    "job.a": { children: { upload: { input: ({ data }) => ({ file: data.file }), done: ({ to }) => to("done") } } },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof twoAtOnce,
    MachineError<`the child "upload" runs on "job" and on "job.a", which are active together: give one another name, or run it on one`>
  >
>();
// @ts-expect-error M535. One child name on a node and on a leaf under it: two live actors at one address.
createActor(twoAtOnce);
page.machine({
  start: ({ to }) => to("idle", { file: "a" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file, progress: "" }) } },
    uploading: {
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file }),
          done: ({ to }) => to("uploaded", { url: "" }),
          // @ts-expect-error M538. update never sees a final state ("sent" is done's): TS2367.
          update: ({ child, to }) => (child.state === "sent" ? to("uploaded", { url: "" }) : null),
        },
      },
    },
    uploaded: { final: true },
    failed: { final: true },
  },
});
import { nested } from "@reactre/state/nested";
import { system } from "@reactre/state/system";
