// An uploader in XState v5: it invokes a child machine (with input), and its onDone moves on.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";

const upload = setup({
  input: types<{ file: string }>(),
  states: { sending: types<{ file: string }>(), sent: types<{ file: string }>() },
  events: {},
});

export const uploadMachine = upload.machine({
  start: ({ input, to }) => to("sending", { file: input.file }),
  states: {
    sending: { after: { "10ms": ({ data, to }) => to("sent", data) } },
    sent: { final: true },
  },
});

const uploader = setup({
  use: [children],
  states: { idle: types<{ file: string; uploaded: number }>(), uploading: types<{ file: string; uploaded: number }>() },
  events: { upload: types<{ file: string }>(), cancel: types<{}>() },
  children: { upload: uploadMachine },
});

export const uploaderMachine = uploader.machine({
  start: ({ to }) => to("idle", { file: "", uploaded: 0 }),
  states: {
    idle: { on: { upload: ({ data, event, to }) => to("uploading", { ...data, file: event.file }) } },
    uploading: {
      on: { cancel: ({ data, to }) => to("idle", data) },
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file }),
          done: ({ data, to }) => to("idle", { ...data, uploaded: data.uploaded + 1 }),
        },
      },
    },
  },
});
