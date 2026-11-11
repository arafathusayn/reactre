// Every runtime entry of @reactre/state but /react (its types need the app's own @types/react), and
// a machine as its plugin compiles one: the contracts must reach a user's project through the
// declarations, so a misspelled target is still a type error there.
import * as state from "@reactre/state";
import * as always from "@reactre/state/always";
import * as children from "@reactre/state/children";
import * as childrenSaved from "@reactre/state/children/saved";
import * as choice from "@reactre/state/choice";
import * as delays from "@reactre/state/delays";
import * as delaysSaved from "@reactre/state/delays/saved";
import * as dev from "@reactre/state/dev";
import * as durable from "@reactre/state/durable";
import * as durableChildren from "@reactre/state/durable/children";
import * as effects from "@reactre/state/effects";
import * as emit from "@reactre/state/emit";
import * as graph from "@reactre/state/graph";
import * as history from "@reactre/state/history";
import * as inspect from "@reactre/state/inspect";
import * as logic from "@reactre/state/logic";
import * as nested from "@reactre/state/nested";
import * as output from "@reactre/state/output";
import * as parallel from "@reactre/state/parallel";
import * as persist from "@reactre/state/persist";
import * as provide from "@reactre/state/provide";
import * as reenter from "@reactre/state/reenter";
import * as route from "@reactre/state/route";
import * as run from "@reactre/state/run";
import * as scxml from "@reactre/state/scxml";
import * as serialize from "@reactre/state/serialize";
import * as signals from "@reactre/state/signals";
import * as spawn from "@reactre/state/spawn";
import * as spawnRestore from "@reactre/state/spawn/restore";
import * as system from "@reactre/state/system";
import * as tags from "@reactre/state/tags";
import * as tasks from "@reactre/state/tasks";
import * as modelTest from "@reactre/state/test";
import * as timeout from "@reactre/state/timeout";
import * as utils from "@reactre/state/utils";
import * as simulatedClock from "@reactre/state/utils/SimulatedClock";
import * as waitFor from "@reactre/state/utils/waitFor";
import * as validate from "@reactre/state/validate";
import * as validateDecided from "@reactre/state/validate/decided";
import * as wildcards from "@reactre/state/wildcards";

const door = state.setup({
  version: 1,
  states: { closed: state.types<{}>(), open: state.types<{ by: string }>() },
  events: { push: state.types<{ by: string }>(), close: state.types<{}>() },
});

const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    // @ts-expect-error: "opened" is not a state of the shape.
    closed: { on: { push: ({ event, to }) => to("opened", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

const actor = state.createActor(doorMachine);
actor.send({ type: "push", by: "ann" });
const snapshot = actor.snapshot();
// The snapshot narrows on its state: only "open" has `by`.
const by: string | undefined = snapshot.state === "open" ? snapshot.data.by : undefined;
const opened: Promise<unknown> = waitFor.waitFor(actor, (s) => s.state === "open");
const [current] = signals.useActor(doorMachine);
const now: string = current().state;

export const all: unknown[] = [
  state,
  always,
  children,
  childrenSaved,
  choice,
  delays,
  delaysSaved,
  dev,
  durable,
  durableChildren,
  effects,
  emit,
  graph,
  history,
  inspect,
  logic,
  nested,
  output,
  parallel,
  persist,
  provide,
  reenter,
  route,
  run,
  scxml,
  serialize,
  signals,
  spawn,
  spawnRestore,
  system,
  tags,
  tasks,
  modelTest,
  timeout,
  utils,
  simulatedClock,
  validate,
  validateDecided,
  wildcards,
  by,
  opened,
  now,
];
