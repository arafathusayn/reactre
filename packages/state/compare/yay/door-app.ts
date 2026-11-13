// test/fixtures/door-app.ts in yay-machine. Its subscriber is also called once with the initial
// state, on subscribe.

import { doorMachine } from "./door.ts";

export function run(): string[] {
  const door = doorMachine.newInstance().start();
  const seen: string[] = [];
  door.subscribe(({ state }) => seen.push(state.name));
  door.send({ type: "push", by: "ann" });
  door.send({ type: "close" });
  door.send({ type: "lock", code: "1" });
  door.send({ type: "unlock", code: "2" });
  door.send({ type: "unlock", code: "1" });
  return seen;
}
