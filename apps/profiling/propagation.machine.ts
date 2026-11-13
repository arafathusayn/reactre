import { setup, types } from "@reactre/state";

export interface Payload {
  value: number;
  revision: number;
}
const shape = setup({
  states: { ready: types<{ payload: Payload }>() },
  events: { replace: types<{ payload: Payload }>() },
});
export const propagationMachine = shape.machine({
  start: ({ to }) => to("ready", { payload: { value: 0, revision: 0 } }),
  states: {
    ready: { on: { replace: ({ event, to }) => to("ready", { payload: event.payload }) } },
  },
});
