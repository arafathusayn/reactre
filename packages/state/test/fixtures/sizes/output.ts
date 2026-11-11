// What output costs an app that uses it (with nested): an upload whose parent completes when its
// child reaches a final leaf.

import { createActor, setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { output } from "@reactre/state/output";

const upload = setup({
  use: [nested, output],
  states: {
    idle: types<{}>(),
    "upload.sending": types<{ file: string }>(),
    "upload.sent": types<{ url: string }>(),
    "upload.failed": types<{ reason: string }>(),
    uploaded: types<{ url: string }>(),
    gaveUp: types<{ reason: string }>(),
  },
  events: { send: types<{ file: string }>(), ok: types<{}>(), fail: types<{ reason: string }>() },
});

export const uploadMachine = upload.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { send: ({ event, to }) => to("upload.sending", { file: event.file }) } },
    upload: {
      done: ({ state, data, to }) =>
        state === "upload.sent"
          ? to("uploaded", { url: data.url })
          : to("gaveUp", { reason: state === "upload.failed" ? data.reason : "" }),
    },
    "upload.sending": {
      on: {
        ok: ({ data, to }) => to("upload.sent", { url: `/files/${data.file}` }),
        fail: ({ event, to }) => to("upload.failed", { reason: event.reason }),
      },
    },
    "upload.sent": { final: true },
    "upload.failed": { final: true },
    uploaded: { final: true },
    gaveUp: { final: true },
  },
});

export function run(): string {
  const actor = createActor(uploadMachine);
  actor.send({ type: "send", file: "a.txt" });
  actor.send({ type: "ok" });
  return actor.snapshot().state;
}
