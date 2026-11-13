// A panel in XState v5: effects (entry, raise), an impure named guard, a callback actor, a delay
// computed from context and `always` convert to their opt-ins; stateIn, a context update built by
// a helper and an event no state handles become TODOs at their spots.

import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";
import { children } from "@reactre/state/children";
import { delays } from "@reactre/state/delays";
import { effects } from "@reactre/state/effects";
import { createCallbackLogic, logic } from "@reactre/state/logic";
import { provide } from "@reactre/state/provide";

interface Panel {
  count: number;
  note: string;
}

export const bump = (panel: Panel): Panel => ({ ...panel, count: panel.count + 1 });

export const ticker = createCallbackLogic<never, undefined, { type: "tick" }>(({ sendBack }) => {
  const id = setInterval(() => sendBack({ type: "tick" }), 1000);
  return () => clearInterval(id);
});

const panelShape = setup({
  use: [children, logic, effects, provide, delays, always],
  guards: { isWeekday: () => new Date().getDay() % 6 !== 0 },
  delays: { idleTimeout: ({ data }: { data: { count: number } }) => data.count * 1000 },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: line 38 updates the context with a value built elsewhere
    closed: types<Panel>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: line 38 updates the context with a value built elsewhere
    opened: types<Panel>(),
  },
  events: { open: types<{}>(), close: types<{}>(), tick: types<{}>() },
  children: { ticker },
});

export const panelMachine = panelShape.machine({
  start: ({ to }) => to("closed", { count: 0, note: "" }),
  states: {
    closed: {
      entry: ({ enq }) => enq.log("closed"),
      on: {
        open: ({ data, guards, enq, to }) =>
          guards.isWeekday() ? (enq.raise({ type: "tick" }), to("opened", data)) : null,
      },
    },
    opened: {
      on: {
        // TODO(@reactre/state): write this state's data by hand: the context update can't be read field by field
        tick: ({ data, keep }) => keep("opened", data),
        // TODO(@reactre/state): stateIn: decide by the state the event is in, or keep the fact in data
        close: ({ data, to }) => (false ? to("closed", data) : null),
      },
      after: { idleTimeout: ({ data, to }) => to("closed", data) },
      always: ({ data, to }) => (data.count > 9 ? to("closed", data) : null),
      children: {
        // TODO(@reactre/state): XState's actor errored when ticker failed: say where to go
        ticker: {
          error: ({ data, keep }) => keep("opened", data),
          on: { tick: ({ data, keep }) => keep("opened", data) },
        },
      },
    },
  },
});
