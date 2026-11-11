// test/fixtures/door-app.ts in @stateforward/hsm: the listener is called on each state's entry,
// the initial one included.

import * as hsm from "@stateforward/hsm";

import { Close, Door, doorModel, lock, push, unlock } from "./door.ts";

export function run(): string[] {
  const seen: string[] = [];
  const door = hsm.start(new Door((s) => seen.push(s)), doorModel);
  void door.dispatch(push("ann"));
  void door.dispatch(Close);
  void door.dispatch(lock("1"));
  void door.dispatch(unlock("2"));
  void door.dispatch(unlock("1"));
  return seen;
}
