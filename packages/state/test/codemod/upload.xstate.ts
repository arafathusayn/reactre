// An uploader in XState v5: it invokes a child machine (with input), and its onDone moves on.

import { assign, setup } from "./xstate5.ts";

export const uploadMachine = setup({
  types: {} as { context: { file: string }; input: { file: string } },
}).createMachine({
  context: ({ input }) => ({ file: input.file }),
  initial: "sending",
  states: {
    sending: { after: { 10: "sent" } },
    sent: { type: "final" },
  },
});

export const uploaderMachine = setup({
  types: {} as {
    context: { file: string; uploaded: number };
    events: { type: "upload"; file: string } | { type: "cancel" };
  },
  actors: { uploadMachine },
}).createMachine({
  context: { file: "", uploaded: 0 },
  initial: "idle",
  states: {
    idle: { on: { upload: { target: "uploading", actions: assign({ file: ({ event }) => event.file }) } } },
    uploading: {
      invoke: {
        id: "upload",
        src: "uploadMachine",
        input: ({ context }) => ({ file: context.file }),
        onDone: { target: "idle", actions: assign({ uploaded: ({ context }) => context.uploaded + 1 }) },
      },
      on: { cancel: "idle" },
    },
  },
});
