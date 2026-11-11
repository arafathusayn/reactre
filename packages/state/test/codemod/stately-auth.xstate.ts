// @ts-nocheck: below is Stately Studio's "XState v5, TypeScript" export in its `setup` form, as the editor writes it, with its import pointed at the dev dependency; its stubs leave parameters unused, which this repository's settings refuse.
// A sign-in flow, the kind of machine people draw in Stately: nested states, `#id` targets, a
// parallel state with two regions, invokes with onDone and onError (one guarded), a named delay,
// guards with and without params, descriptions, and actions by name.

import { createMachine, fromPromise, setup } from "./xstate5.ts";

export const machine = setup({
  types: {
    context: {} as { email: string; attempts: number; token: string | null },
    events: {} as
      | { type: "submit"; email: string; password: string }
      | { type: "retry" }
      | { type: "verify"; code: string }
      | { type: "resend" }
      | { type: "logout" }
      | { type: "openMenu" }
      | { type: "closeMenu" }
      | { type: "reload" },
  },
  actions: {
    track: function ({ context, event }, params) {
      // Add your action code here
      // ...
    },
    clearSession: function ({ context, event }, params) {
      // Add your action code here
      // ...
    },
  },
  actors: {
    signIn: fromPromise(async ({ input }) => {
      // Add your actor code here
      // ...
    }),
    loadProfile: fromPromise(async ({ input }) => {
      // Add your actor code here
      // ...
    }),
    watchSession: createMachine({/* ... */}),
  },
  guards: {
    needsTwoFactor: function ({ context, event }, params) {
      // Add your guard condition here
      return true;
    },
    tooManyAttempts: function ({ context, event }, params) {
      // Add your guard condition here
      return false;
    },
  },
  delays: {
    codeExpiry: ({ context, event }) => {
      return 40;
    },
  },
}).createMachine({
  context: {
    email: "",
    attempts: 0,
    token: null,
  },
  id: "Auth",
  initial: "Signed out",
  states: {
    "Signed out": {
      initial: "Idle",
      states: {
        Idle: {
          on: {
            submit: {
              target: "Signing in",
            },
          },
        },
        "Signing in": {
          invoke: {
            id: "signIn",
            input: {},
            onDone: [
              {
                target: "#Auth.Two factor",
                guard: {
                  type: "needsTwoFactor",
                },
              },
              {
                target: "#Auth.Signed in",
              },
            ],
            onError: {
              target: "Failed",
            },
            src: "signIn",
          },
        },
        Failed: {
          on: {
            retry: [
              {
                target: "Locked",
                guard: {
                  type: "tooManyAttempts",
                  params: {
                    max: 3,
                  },
                },
              },
              {
                target: "Idle",
              },
            ],
          },
        },
        Locked: {
          description: "Too many attempts: wait for support.",
        },
      },
      description: "No session yet.",
    },
    "Two factor": {
      initial: "Waiting",
      states: {
        Waiting: {
          on: {
            verify: {
              target: "#Auth.Signed in",
              actions: {
                type: "track",
                params: {
                  name: "verified",
                },
              },
            },
            resend: {
              target: "Waiting",
            },
          },
          after: {
            codeExpiry: {
              target: "Expired",
            },
          },
        },
        Expired: {
          on: {
            resend: {
              target: "Waiting",
            },
          },
        },
      },
      on: {
        logout: {
          target: "Signed out",
        },
      },
    },
    "Signed in": {
      type: "parallel",
      states: {
        Profile: {
          initial: "Loading",
          states: {
            Loading: {
              invoke: {
                id: "loadProfile",
                input: {},
                onDone: {
                  target: "Ready",
                },
                onError: {
                  target: "Unavailable",
                },
                src: "loadProfile",
              },
            },
            Ready: {
              on: {
                reload: {
                  target: "Loading",
                },
              },
            },
            Unavailable: {
              on: {
                reload: {
                  target: "Loading",
                },
              },
            },
          },
        },
        Menu: {
          initial: "Closed",
          states: {
            Closed: {
              on: {
                openMenu: {
                  target: "Open",
                },
              },
            },
            Open: {
              invoke: {
                id: "watchSession",
                input: {},
                src: "watchSession",
              },
              on: {
                closeMenu: {
                  target: "Closed",
                },
              },
            },
          },
        },
      },
      on: {
        logout: {
          target: "Signed out",
          actions: {
            type: "clearSession",
          },
          description: "Ends the session everywhere.",
        },
      },
      description: "A session: the profile loads while the menu works.",
    },
  },
});
