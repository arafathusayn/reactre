// test/fixtures/door-app.ts in jssm.

import { close, createDoor, lock, push, unlock } from "./door.ts";

export function run(): string[] {
  const door = createDoor();
  const seen: string[] = [];
  door.on("transition", () => seen.push(door.state()));
  push(door, "ann");
  close(door);
  lock(door, "1");
  unlock(door, "2");
  unlock(door, "1");
  return seen;
}
