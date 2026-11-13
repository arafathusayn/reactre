// Each expected output's machine, used: the type checker's graph checks (unreachable states, dead
// ends, unhandled events) show where a machine is used, so `bun check` runs them here. Never run.

import { initial } from "@reactre/state";

import { wizardMachine } from "./always.expected.ts";
import { approvalMachine } from "./approval.expected.ts";
import { clockMachine } from "./callback.expected.ts";
import { checkoutMachine } from "./checkout.expected.ts";
import { reminderMachine } from "./delays.expected.ts";
import { doorMachine } from "./door.expected.ts";
import { editorMachine } from "./editor.expected.ts";
import { playerMachine as effectsPlayer } from "./effects.expected.ts";
import { radioMachine } from "./history.expected.ts";
import { jobMachine } from "./job.expected.ts";
import { panelMachine } from "./panel.expected.ts";
import { playerMachine } from "./player.expected.ts";
import { poolMachine, workerMachine } from "./spawn.expected.ts";
import { machine as statelyAuth } from "./stately-auth.expected.ts";
import { checkoutMachine as statelyJson } from "./stately-json.expected.ts";
import { machine as statelySetup } from "./stately-setup.expected.ts";
import { machine as statelyV4 } from "./stately-v4.expected.ts";
import { machine as statelyV5 } from "./stately-v5.expected.ts";
import { callMachine } from "./timeout.expected.ts";
import { uploaderMachine, uploadMachine } from "./upload.expected.ts";
import { counterMachine } from "./v4.expected.ts";

export function check(): readonly unknown[] {
  return [
    initial(checkoutMachine, undefined),
    initial(doorMachine, undefined),
    initial(editorMachine, undefined),
    initial(radioMachine, undefined),
    initial(jobMachine, undefined),
    initial(playerMachine, undefined),
    initial(counterMachine, undefined),
    initial(panelMachine, undefined),
    initial(uploadMachine, { file: "a.png" }),
    initial(uploaderMachine, undefined),
    initial(statelyV5, undefined),
    // @ts-expect-error M432: stately's "Flashing" runs a task that only its result leaves; the codemod keeps the hang, and the check flags it.
    initial(statelySetup, undefined),
    initial(statelyV4, undefined),
    initial(statelyJson, undefined),
    // @ts-expect-error M432: stately's "Signed out.Signing in" runs a task that only its result leaves, the same.
    initial(statelyAuth, undefined),
    initial(effectsPlayer, undefined),
    initial(wizardMachine, undefined),
    initial(reminderMachine, undefined),
    initial(clockMachine, undefined),
    initial(workerMachine, undefined),
    initial(poolMachine, undefined),
    initial(callMachine, undefined),
    initial(approvalMachine, undefined),
  ];
}
