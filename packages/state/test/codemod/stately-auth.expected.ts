// A sign-in flow, the kind of machine people draw in Stately: nested states, `#id` targets, a
// parallel state with two regions, invokes with onDone and onError (one guarded), a named delay,
// guards with and without params, descriptions, and actions by name.

import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";
import { provide } from "@reactre/state/provide";
import { tags } from "@reactre/state/tags";

// TODO(@reactre/state): guard "needsTwoFactor" is a stub in the export: write its condition in needsTwoFactor, and pass it the fields of data and the event it reads. Until then it is true, as in the export
function needsTwoFactor(): boolean {
  return true;
}

// TODO(@reactre/state): actor "signIn" is a stub in the export: write the task in signIn (it gets the invoke's input and an abort signal). Until then it finishes at once (its output is null), as in the export
async function signIn(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return null;
}

// TODO(@reactre/state): guard "tooManyAttempts" is a stub in the export: write its condition in tooManyAttempts, and pass it the fields of data and the event it reads. Until then it is false, as in the export
function tooManyAttempts(_params: { max: number }): boolean {
  return false;
}

// TODO(@reactre/state): actor "loadProfile" is a stub in the export: write the task in loadProfile (it gets the invoke's input and an abort signal). Until then it finishes at once (its output is null), as in the export
async function loadProfile(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return null;
}

// TODO(@reactre/state): actor "watchSession" is a stub in the export: write the task in watchSession (it gets the invoke's input and an abort signal). Until then it never finishes, as in the export
function watchSession(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return new Promise(() => {});
}

const machineShape = setup({
  use: [nested, parallel, effects, provide, tags],
  parallel: ["Signed in"],
  actions: {
    // TODO(@reactre/state): action "track" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    track: (_params: { name: string }) => {},
    // TODO(@reactre/state): action "clearSession" is a stub in the export: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing, as in the export
    clearSession: () => {},
  },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed out.Idle": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed out.Signing in": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed out.Failed": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed out.Locked": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Two factor.Waiting": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Two factor.Expired": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed in.Profile.Loading": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed in.Profile.Ready": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed in.Profile.Unavailable": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed in.Menu.Closed": types<{ email: string; attempts: number; token: string | null }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (needsTwoFactor, signIn, tooManyAttempts, loadProfile, watchSession) aren't written yet, so the fields each state reads aren't known
    "Signed in.Menu.Open": types<{ email: string; attempts: number; token: string | null }>(),
  },
  events: {
    submit: types<{ email: string; password: string }>(),
    retry: types<{}>(),
    verify: types<{ code: string }>(),
    resend: types<{}>(),
    logout: types<{}>(),
    openMenu: types<{}>(),
    closeMenu: types<{}>(),
    reload: types<{}>(),
  },
  internal: {
    signInDone: types<{ output: Awaited<ReturnType<typeof signIn>> }>(),
    loadProfileDone: types<{ output: Awaited<ReturnType<typeof loadProfile>> }>(),
    watchSessionDone: types<{ output: Awaited<ReturnType<typeof watchSession>> }>(),
  },
});

export const machine = machineShape.machine({
  start: ({ to }) => to("Signed out.Idle", { email: "", attempts: 0, token: null }),
  states: {
    "Signed out": { description: "No session yet." },
    "Signed out.Idle": { on: { submit: ({ data, to }) => to("Signed out.Signing in", data) } },
    "Signed out.Signing in": {
      on: {
        signInDone: ({ data, to }) =>
          needsTwoFactor()
            ? to("Two factor.Waiting", data)
            : to("Signed in", {
                Profile: to("Signed in.Profile.Loading", data),
                Menu: to("Signed in.Menu.Closed", data),
              }),
      },
      task: {
        run: async ({ signal }) => ({ type: "signInDone", output: await signIn({ input: {}, signal }) }),
        error: ({ data, to }) => to("Signed out.Failed", data),
      },
    },
    "Signed out.Failed": {
      on: {
        retry: ({ data, to }) =>
          tooManyAttempts({
            max: 3,
          })
            ? to("Signed out.Locked", data)
            : to("Signed out.Idle", data),
      },
    },
    // TODO(@reactre/state): no transition leaves Signed out.Locked, so it is final here: XState's actor stayed in it without finishing. Add a transition if it should
    "Signed out.Locked": { description: "Too many attempts: wait for support.", final: true },
    "Two factor": { on: { logout: ({ data, to }) => to("Signed out.Idle", data) } },
    "Two factor.Waiting": {
      on: {
        verify: ({ data, actions, enq, to }) => (
          enq(actions.track, {
            name: "verified",
          }),
          to("Signed in", { Profile: to("Signed in.Profile.Loading", data), Menu: to("Signed in.Menu.Closed", data) })
        ),
        resend: ({ data, keep }) => keep("Two factor.Waiting", data),
      },
      after: { "40ms": ({ data, to }) => to("Two factor.Expired", data) },
    },
    "Two factor.Expired": { on: { resend: ({ data, to }) => to("Two factor.Waiting", data) } },
    // TODO(@reactre/state): each region of Signed in keeps its own copy of the context: a change in one region isn't seen by the others, and leaving Signed in takes the first region's
    "Signed in": {
      description: "A session: the profile loads while the menu works.",
      on: {
        // Ends the session everywhere.
        logout: ({ data, actions, enq, to }) => (
          enq(actions.clearSession),
          to("Signed out.Idle", {
            email: data.Profile.data.email,
            attempts: data.Profile.data.attempts,
            token: data.Profile.data.token,
          })
        ),
      },
    },
    "Signed in.Profile.Loading": {
      on: { loadProfileDone: ({ data, to }) => to("Signed in.Profile.Ready", data) },
      task: {
        run: async ({ signal }) => ({ type: "loadProfileDone", output: await loadProfile({ input: {}, signal }) }),
        error: ({ data, to }) => to("Signed in.Profile.Unavailable", data),
      },
    },
    "Signed in.Profile.Ready": { on: { reload: ({ data, to }) => to("Signed in.Profile.Loading", data) } },
    "Signed in.Profile.Unavailable": { on: { reload: ({ data, to }) => to("Signed in.Profile.Loading", data) } },
    "Signed in.Menu.Closed": { on: { openMenu: ({ data, to }) => to("Signed in.Menu.Open", data) } },
    "Signed in.Menu.Open": {
      on: {
        closeMenu: ({ data, to }) => to("Signed in.Menu.Closed", data),
        watchSessionDone: ({ data, keep }) => keep("Signed in.Menu.Open", data),
      },
      // TODO(@reactre/state): XState ignored watchSession's result: here the task's event must be handled, so the state stays
      // TODO(@reactre/state): XState's actor errored when watchSession failed: say where to go
      task: {
        run: async ({ signal }) => ({ type: "watchSessionDone", output: await watchSession({ input: {}, signal }) }),
        error: ({ data, keep }) => keep("Signed in.Menu.Open", data),
      },
    },
  },
});
