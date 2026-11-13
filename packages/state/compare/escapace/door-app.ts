// test/fixtures/door-app.ts in @escapace/fsm.

import { createDoor } from "./door.ts";

export function run(): string[] {
  const door = createDoor();
  const seen: string[] = [];
  door.subscribe((change) => seen.push(change.state));
  door.do("push", { by: "ann" });
  door.do("close");
  door.do("lock", { code: "1" });
  door.do("unlock", { code: "2" });
  door.do("unlock", { code: "1" });
  return seen;
}
