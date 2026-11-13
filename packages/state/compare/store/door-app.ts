// test/fixtures/door-app.ts in @xstate/store.

import { createStore } from "@xstate/store";

import { doorStore } from "./door.ts";

export function run(): string[] {
  const store = createStore(doorStore);
  const seen: string[] = [];
  store.subscribe((s) => seen.push(s.context.state));
  store.send({ type: "push", by: "ann" });
  store.send({ type: "close" });
  store.send({ type: "lock", code: "1" });
  store.send({ type: "unlock", code: "2" });
  store.send({ type: "unlock", code: "1" });
  return seen;
}
