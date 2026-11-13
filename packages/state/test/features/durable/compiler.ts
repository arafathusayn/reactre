// durable's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). The opt-in is a marker, and children on a durable host need
// nothing compiled; what compiler/features/durable.ts checks is the file's host and its calls: a
// deadline used as a delay, a clock in seconds or not of wall time, a run's call not awaited.

import { type Case, change } from "../../sources.ts";

/** A request handler that runs ../fixtures/sizes/durable.ts's machine on a host written in place. */
export const HANDLE = `import { durable } from "@reactre/state/durable";
import { payMachine } from "../fixtures/sizes/durable.ts";

export async function handle(): Promise<Response> {
  const run = durable(payMachine, {
    now: () => Date.now(),
    step: (_id, fn) => fn(),
    schedule: (id) => {
      void run.fire(id);
    },
    cancel: () => {},
    save: () => {},
  });
  await run.start();
  await run.send({ type: "go" });
  return new Response("ok");
}
`;

export const cases: Case[] = [
  [
    "M562: a host's schedule uses the deadline as a delay",
    change(
      HANDLE,
      "schedule: (id) => {\n      void run.fire(id);\n    },",
      "schedule: (id, at) => {\n      setTimeout(() => void run.fire(id), at);\n    },",
    ),
    9,
    "`at` is a time, not a delay: `setTimeout(…, at - Date.now())`",
  ],
  [
    "M562: a host's schedule sleeps for the deadline",
    change(
      change(
        HANDLE,
        "export async function handle",
        "const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));\n\nexport async function handle",
      ),
      "schedule: (id) => {\n      void run.fire(id);\n    },",
      "schedule: (id, at) => {\n      void sleep(at).then(() => run.fire(id));\n    },",
    ),
    11,
    "`at` is a time, not a delay: `setTimeout(…, at - Date.now())`",
  ],
  [
    "M563: a host's clock in seconds",
    change(HANDLE, "now: () => Date.now(),", "now: () => Math.floor(Date.now() / 1000),"),
    6,
    "`now` gives seconds; the runtime reads milliseconds: `Date.now()`",
  ],
  [
    "M564: a host's clock from performance.now",
    change(HANDLE, "now: () => Date.now(),", "now: () => performance.now(),"),
    6,
    "performance.now isn't wall time: `Date.now`",
  ],
  [
    "M565: a run's send not awaited",
    change(HANDLE, 'await run.send({ type: "go" });', 'run.send({ type: "go" });'),
    15,
    "`run.send` isn't awaited, so the request ends before it's saved: await it",
  ],
];
