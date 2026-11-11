// The door app, walked with xstate/fsm's pure transition: no actor runtime.

import { doorFsm } from "./door-fsm.ts";

export function run(): string[] {
  let state = doorFsm.initialState;
  const seen: string[] = [];
  for (const event of [
    { type: "push", by: "ann" },
    { type: "close" },
    { type: "lock", code: "1" },
    { type: "unlock", code: "2" },
    { type: "unlock", code: "1" },
  ] as const) {
    const [next] = doorFsm.transition(state, event);
    if (next !== state) seen.push(String(next.value));
    state = next;
  }
  return seen;
}
