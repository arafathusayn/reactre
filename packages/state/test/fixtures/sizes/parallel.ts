// What nested and parallel cost an app that uses them: the player (two regions at once).

import { createActor } from "@reactre/state";

import { playerMachine } from "../player.ts";

export function run(): string[] {
  const actor = createActor(playerMachine);
  const seen: string[] = [];
  actor.subscribe((s) => seen.push(s.state));
  actor.send({ type: "power" });
  actor.send({ type: "play", track: "a" });
  actor.send({ type: "mute" });
  actor.send({ type: "power" });
  return seen;
}
