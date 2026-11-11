// What children cost an app that uses them: a page that runs an upload child.

import { createActor, setup, types } from "@reactre/state";
import { child, children } from "@reactre/state/children";

const upload = setup({
  input: types<{ file: string }>(),
  states: { sending: types<{ file: string }>(), sent: types<{ url: string }>() },
  events: { ok: types<{ url: string }>() },
});

export const uploadMachine = upload.machine({
  start: ({ input, to }) => to("sending", { file: input.file }),
  states: { sending: { on: { ok: ({ event, to }) => to("sent", { url: event.url }) } }, sent: { final: true } },
});

const page = setup({
  use: [children],
  states: { idle: types<{ file: string }>(), uploading: types<{ file: string }>(), uploaded: types<{ url: string }>() },
  events: { go: types<{}>() },
  children: { upload: uploadMachine },
});

export const pageMachine = page.machine({
  start: ({ to }) => to("idle", { file: "a.txt" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file }) } },
    uploading: {
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file }),
          done: ({ output, to }) => to("uploaded", { url: output.data.url }),
        },
      },
    },
    uploaded: { final: true },
  },
});

export function run(): string[] {
  const actor = createActor(pageMachine);
  actor.send({ type: "go" });
  child(actor, "upload")?.send({ type: "ok", url: "/a" });
  return [actor.snapshot().state];
}
