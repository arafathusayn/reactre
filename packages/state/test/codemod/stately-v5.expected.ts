// A feedback form: `createMachine(config, implementations)`, the layout comment, `types` cast
// field by field, implementations named by string (`{ type }`, `guard`, `src`), stubbed bodies,
// descriptions, tags, a delay and a final state.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { provide } from "@reactre/state/provide";
import { tags } from "@reactre/state/tags";

// TODO(@reactre/state): guard "hasComment" is a stub in the export: write its condition in hasComment, and pass it the fields of data and the event it reads. Until then it is false, as in the export
function hasComment(): boolean {
  return false;
}

// TODO(@reactre/state): actor "sendFeedback" is a stub in the export: write the task in sendFeedback (it gets the invoke's input and an abort signal). Until then it never finishes, as in the export
function sendFeedback(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return new Promise(() => {});
}

const machineShape = setup({
  use: [effects, provide, tags],
  actions: {
    // TODO(@reactre/state): action "showError" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    showError: (_params: { message: string }) => {},
    // TODO(@reactre/state): action "focusComment" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    focusComment: () => {},
  },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (hasComment, sendFeedback) aren't written yet, so the fields each state reads aren't known
    Prompt: types<{ rating: number; comment: string }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (hasComment, sendFeedback) aren't written yet, so the fields each state reads aren't known
    Thanks: types<{ rating: number; comment: string }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (hasComment, sendFeedback) aren't written yet, so the fields each state reads aren't known
    Form: types<{ rating: number; comment: string }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (hasComment, sendFeedback) aren't written yet, so the fields each state reads aren't known
    Submitting: types<{ rating: number; comment: string }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (hasComment, sendFeedback) aren't written yet, so the fields each state reads aren't known
    Closed: types<{ rating: number; comment: string }>(),
  },
  events: {
    good: types<{}>(),
    bad: types<{}>(),
    close: types<{}>(),
    submit: types<{ comment: string }>(),
    back: types<{}>(),
  },
  internal: { sendFeedbackDone: types<{ output: Awaited<ReturnType<typeof sendFeedback>> }>() },
});

export const machine = machineShape.machine({
  start: ({ to }) => to("Prompt", { rating: 0, comment: "" }),
  states: {
    Prompt: {
      description: "Asks whether the visit went well.",
      on: {
        good: ({ data, to }) => to("Thanks", data),
        // Ask what went wrong.
        bad: ({ data, to }) => to("Form", data),
        close: ({ data, to }) => to("Closed", data),
      },
    },
    Thanks: { tags: ["done"], after: { "20ms": ({ data, to }) => to("Closed", data) } },
    Form: {
      entry: ({ actions, enq }) => enq(actions.focusComment),
      on: {
        submit: ({ data, actions, enq, to, keep }) =>
          hasComment()
            ? to("Submitting", data)
            : (enq(actions.showError, {
                message: "Write a comment first",
              }),
              keep("Form", data)),
        back: ({ data, to }) => to("Prompt", data),
      },
    },
    Submitting: {
      on: { back: ({ data, to }) => to("Form", data), sendFeedbackDone: ({ data, to }) => to("Thanks", data) },
      task: {
        run: async ({ signal }) => ({ type: "sendFeedbackDone", output: await sendFeedback({ input: {}, signal }) }),
        error: ({ data, to }) => to("Form", data),
      },
    },
    Closed: { final: true },
  },
});
