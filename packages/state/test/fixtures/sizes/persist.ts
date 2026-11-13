// What persist costs an app that uses it: a machine with a timer, persisted, and read back through
// `migrations` (the stored JSON checked, and a version-1 snapshot migrated) into restoreActor.

import { createActor, restoreActor, setup, types } from "@reactre/state";
import { migrations, persist } from "@reactre/state/persist";

const reminder = setup({
  use: [persist],
  version: 2,
  shape: "5uwhi622",
  states: { waiting: types<{ note: string }>(), due: types<{ note: string }>() },
  events: { snooze: types<{}>() },
});

export const reminderMachine = reminder.machine({
  start: ({ to }) => to("waiting", { note: "call" }),
  states: {
    waiting: {
      on: { snooze: ({ data, keep }) => keep("waiting", data) },
      after: { "1h": ({ data, to }) => to("due", data) },
    },
    due: { final: true },
  },
});

const migrate = migrations(reminderMachine).from<1, { waiting: { text: string } }>(({ data, to }) =>
  to("waiting", { note: data.text }),
);

export function run(): string[] {
  const actor = createActor(reminderMachine);
  const saved = JSON.stringify(persist(actor));
  actor.stop();
  const restored = restoreActor(reminderMachine, migrate(JSON.parse(saved)));
  restored.stop();
  return [restored.snapshot().state];
}
