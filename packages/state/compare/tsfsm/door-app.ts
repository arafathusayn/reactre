// test/fixtures/door-app.ts in typescript-fsm: the listener is the constructor's.

import { Door } from "./door.ts";

export function run(): string[] {
  const seen: string[] = [];
  const door = new Door((s) => seen.push(s));
  door.send({ type: "push", by: "ann" });
  door.send({ type: "close" });
  door.send({ type: "lock", code: "1" });
  door.send({ type: "unlock", code: "2" });
  door.send({ type: "unlock", code: "1" });
  return seen;
}
