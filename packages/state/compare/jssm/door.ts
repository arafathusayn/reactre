// test/fixtures/door.ts in jssm. The machine is FSL text, compiled once (`make`: parse, then
// compile) into a config each instance is built from with `new Machine(config)`, so creating one
// doesn't parse again (`sm` and `from` would). jssm has one data value per machine, not per state,
// so `by` and `code` are fields of it, and a payload is the next data, given with the action
// (`action(name, data)`). The guard is a pre-hook on the unlock edge, comparing the code given with
// the one held; a hook is registered per instance. Its listener is `on("transition", ...)`; an
// instance has no `stop` (the listener is removed with `off`). There is no pure transition.
//
// No job port: jssm has timed transitions (`after`), but no tasks.

import { Machine, make } from "jssm";

export interface DoorData {
  readonly by: string | null;
  readonly code: string | null;
}

const config = make<string, DoorData>(`
  closed 'push' -> open;
  open 'close' -> closed;
  closed 'lock' -> locked;
  locked 'unlock' -> closed;
`);

export function createDoor(): Machine<DoorData> {
  const door = new Machine<DoorData>({ ...config, data: { by: null, code: null } });
  door.hook_action("locked", "closed", "unlock", ({ data, next_data }) => next_data.code === data.code);
  return door;
}

export const push = (door: Machine<DoorData>, by: string): boolean => door.action("push", { by, code: null });
export const close = (door: Machine<DoorData>): boolean => door.action("close");
export const lock = (door: Machine<DoorData>, code: string): boolean => door.action("lock", { by: null, code });
export const unlock = (door: Machine<DoorData>, code: string): boolean => door.action("unlock", { by: null, code });
