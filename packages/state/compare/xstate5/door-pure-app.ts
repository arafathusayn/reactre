// The door app, walked with XState v5's pure `transition()`: no actor. It still ships the whole
// interpreter, which `transition()` runs.

import { initialTransition, transition } from "xstate";

import { type DoorEvent, doorMachine } from "./door.ts";

export function run(): string[] {
  let [state] = initialTransition(doorMachine);
  const seen: string[] = [];
  const events: readonly DoorEvent[] = [
    { type: "push", by: "ann" },
    { type: "close" },
    { type: "lock", code: "1" },
    { type: "unlock", code: "2" },
    { type: "unlock", code: "1" },
  ];
  for (const event of events) {
    const [next] = transition(doorMachine, state, event);
    if (next.value !== state.value) seen.push(String(next.value));
    state = next;
  }
  return seen;
}
