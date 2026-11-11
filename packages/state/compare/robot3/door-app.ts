// test/fixtures/door-app.ts in Robot: `interpret`'s onChange is the listener.

import { interpret } from "robot3";

import { doorMachine } from "./door.ts";

export function run(): string[] {
  const seen: string[] = [];
  const service = interpret(doorMachine, (s) => seen.push(String(s.machine.current)));
  service.send({ type: "push", by: "ann" });
  service.send({ type: "close" });
  service.send({ type: "lock", code: "1" });
  service.send({ type: "unlock", code: "2" });
  service.send({ type: "unlock", code: "1" });
  return seen;
}
