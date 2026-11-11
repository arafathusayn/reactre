// @ts-nocheck: below is Stately Studio's "XState v5, TypeScript" export, as the editor writes it, with its import pointed at the dev dependency; its stubs leave parameters unused, which this repository's settings refuse.
// A feedback form: `createMachine(config, implementations)`, the layout comment, `types` cast
// field by field, implementations named by string (`{ type }`, `guard`, `src`), stubbed bodies,
// descriptions, tags, a delay and a final state.

import { createMachine } from "./xstate5.ts";

export const machine = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAOgFkBXAawGJYAXAewBIAPeBtGAV2fqNAOiAXwA0IAJ6IALBwBMOAKwB2AL5qAA */
    context: {
      rating: 0,
      comment: "",
    },
    id: "Feedback",
    initial: "Prompt",
    states: {
      Prompt: {
        on: {
          good: {
            target: "Thanks",
          },
          bad: {
            target: "Form",
            description: "Ask what went wrong.",
          },
          close: {
            target: "Closed",
          },
        },
        description: "Asks whether the visit went well.",
      },
      Thanks: {
        after: {
          "20": {
            target: "Closed",
          },
        },
        tags: ["done"],
      },
      Form: {
        on: {
          submit: [
            {
              target: "Submitting",
              guard: {
                type: "hasComment",
              },
            },
            {
              target: "Form",
              actions: {
                type: "showError",
                params: {
                  message: "Write a comment first",
                },
              },
            },
          ],
          back: {
            target: "Prompt",
          },
        },
        entry: {
          type: "focusComment",
        },
      },
      Submitting: {
        invoke: {
          id: "sendFeedback",
          input: {},
          onDone: {
            target: "Thanks",
          },
          onError: {
            target: "Form",
          },
          src: "sendFeedback",
        },
        on: {
          back: {
            target: "Form",
          },
        },
      },
      Closed: {
        type: "final",
      },
    },
    types: {
      context: {} as { rating: number; comment: string },
      events: {} as
        { type: "good" } | { type: "bad" } | { type: "close" } | { type: "submit"; comment: string } | { type: "back" },
    },
  },
  {
    actions: {
      showError: ({ context, event }, params) => {},
      focusComment: ({ context, event }) => {},
    },
    actors: {
      sendFeedback: createMachine({/* ... */}),
    },
    guards: {
      hasComment: ({ context, event }, params) => {
        return false;
      },
    },
    delays: {},
  },
);
