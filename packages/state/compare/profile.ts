// Runs one case of bench.ts in a hot loop for a few seconds, so a CPU profiler sees where its time
// goes. It times nothing itself.
//
// Run: bun --cpu-prof-md --cpu-prof-dir=packages/state/compare/out packages/state/compare/profile.ts actor
//      (the case is actor, pure or create; the profile is written on exit)

export {};

await import("./production.ts");
const { createActor, initial, transition } = await import("@reactre/state");
const { doorMachine } = await import("../test/fixtures/door.ts");

const PUSH = { type: "push", by: "ann" } as const;
const CLOSE = { type: "close" } as const;
const which = process.argv[2] ?? "actor";
const SECONDS = Number(process.argv[3] ?? 4);

function loop(run: () => void): void {
  const end = performance.now() + SECONDS * 1000;
  while (performance.now() < end) for (let i = 0; i < 100_000; i++) run();
}

if (which === "actor") {
  const actor = createActor(doorMachine);
  actor.subscribe(() => {});
  loop(() => (actor.send(PUSH), actor.send(CLOSE)));
} else if (which === "pure") {
  const s0 = initial(doorMachine, undefined);
  loop(() => {
    const s1 = transition(doorMachine, s0, PUSH).snapshot;
    transition(doorMachine, s1, CLOSE);
  });
} else {
  loop(() => {
    const a = createActor(doorMachine);
    a.subscribe(() => {});
    a.stop();
  });
}
