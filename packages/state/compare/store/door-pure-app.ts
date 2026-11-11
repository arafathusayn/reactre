// The door app, walked with @xstate/store's pure `store.transition`: the store is only made to
// get its transition (the package exports no standalone one).

import { createStore } from "@xstate/store";

import { doorStore } from "./door.ts";

export function run(): string[] {
  const { transition, getInitialSnapshot } = createStore(doorStore);
  let state = getInitialSnapshot();
  const seen: string[] = [];
  for (const event of [
    { type: "push", by: "ann" },
    { type: "close" },
    { type: "lock", code: "1" },
    { type: "unlock", code: "2" },
    { type: "unlock", code: "1" },
  ] as const) {
    const [next] = transition(state, event);
    if (next !== state) seen.push(next.context.state);
    state = next;
  }
  return seen;
}
