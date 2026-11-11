// @ts-nocheck: below is Stately Studio's "XState v4, TypeScript" export, as the editor wrote it, with its import pointed at ./xstate4.ts (v4 isn't installed); its stubs leave parameters unused, which this repository's settings refuse.
// A file upload: `predictableActionArguments`, `tsTypes` from typegen, `schema` (context, events,
// services), `cond`, `services`, and the options' stubs.

import { createMachine } from "./xstate4.ts";

export const machine = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QBsD2BDCBhAFgSwDsYA6AYgEEARAJQEkBNAZQEkBZAQQBCoAlHAG2xTkAXgBUAvgF8lNNYlpA */
    id: "Upload",
    tsTypes: {} as import("./stately-v4.xstate.typegen").Typegen0,
    schema: {
      context: {} as { file: string | null; progress: number },
      events: {} as { type: "PICK"; file: string } | { type: "CANCEL" } | { type: "RETRY" },
      services: {} as {
        uploadFile: {
          data: string;
        };
      },
    },
    context: {
      file: null,
      progress: 0,
    },
    predictableActionArguments: true,
    preserveActionOrder: true,
    initial: "Empty",
    states: {
      Empty: {
        on: {
          PICK: [
            {
              target: "Uploading",
              cond: "isAllowedType",
            },
            {
              target: "Rejected",
            },
          ],
        },
      },
      Rejected: {
        on: {
          PICK: {
            target: "Uploading",
          },
        },
      },
      Uploading: {
        invoke: {
          src: "uploadFile",
          id: "uploadFile",
          onDone: [
            {
              target: "Done",
              actions: "notifyUploaded",
            },
          ],
          onError: [
            {
              target: "Failed",
            },
          ],
        },
        on: {
          CANCEL: {
            target: "Empty",
          },
        },
      },
      Failed: {
        on: {
          RETRY: {
            target: "Uploading",
          },
          CANCEL: {
            target: "Empty",
          },
        },
      },
      Done: {
        type: "final",
      },
    },
  },
  {
    actions: {
      notifyUploaded: (context, event) => {},
    },
    services: {
      uploadFile: (context, event) => {},
    },
    guards: {
      isAllowedType: (context, event) => false,
    },
    delays: {},
  },
);
