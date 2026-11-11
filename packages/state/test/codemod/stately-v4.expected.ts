// A file upload: `predictableActionArguments`, `tsTypes` from typegen, `schema` (context, events,
// services), `cond`, `services`, and the options' stubs.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { provide } from "@reactre/state/provide";

// TODO(@reactre/state): guard "isAllowedType" is a stub in the export: write its condition in isAllowedType, and pass it the fields of data and the event it reads. Until then it is false, as in the export
function isAllowedType(): boolean {
  return false;
}

// TODO(@reactre/state): actor "uploadFile" is a stub in the export: write the task in uploadFile (it gets the invoke's input and an abort signal). Until then it never finishes, as in the export
function uploadFile(_: { input?: unknown; signal: AbortSignal }): Promise<string> {
  return new Promise(() => {});
}

const machineShape = setup({
  use: [effects, provide],
  actions: {
    // TODO(@reactre/state): action "notifyUploaded" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    notifyUploaded: () => {},
  },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isAllowedType, uploadFile) aren't written yet, so the fields each state reads aren't known
    Empty: types<{ file: string | null; progress: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isAllowedType, uploadFile) aren't written yet, so the fields each state reads aren't known
    Rejected: types<{ file: string | null; progress: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isAllowedType, uploadFile) aren't written yet, so the fields each state reads aren't known
    Uploading: types<{ file: string | null; progress: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isAllowedType, uploadFile) aren't written yet, so the fields each state reads aren't known
    Failed: types<{ file: string | null; progress: number }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isAllowedType, uploadFile) aren't written yet, so the fields each state reads aren't known
    Done: types<{ file: string | null; progress: number }>(),
  },
  events: { PICK: types<{ file: string }>(), CANCEL: types<{}>(), RETRY: types<{}>() },
  internal: { uploadFileDone: types<{ output: Awaited<ReturnType<typeof uploadFile>> }>() },
});

export const machine = machineShape.machine({
  start: ({ to }) => to("Empty", { file: null, progress: 0 }),
  states: {
    Empty: { on: { PICK: ({ data, to }) => (isAllowedType() ? to("Uploading", data) : to("Rejected", data)) } },
    Rejected: { on: { PICK: ({ data, to }) => to("Uploading", data) } },
    Uploading: {
      on: {
        CANCEL: ({ data, to }) => to("Empty", data),
        uploadFileDone: ({ data, actions, enq, to }) => (enq(actions.notifyUploaded), to("Done", data)),
      },
      task: {
        run: async ({ signal }) => ({ type: "uploadFileDone", output: await uploadFile({ signal }) }),
        error: ({ data, to }) => to("Failed", data),
      },
    },
    Failed: { on: { RETRY: ({ data, to }) => to("Uploading", data), CANCEL: ({ data, to }) => to("Empty", data) } },
    Done: { final: true },
  },
});
