// The child process for the process-boundary child test: one durable run on a file journal whose
// "busy" node runs a "job" child with a task. A real executable subprocess (`bun --preload ...
// child-worker.ts`), so a SIGKILL is a real process death, not a flag.
//
// Modes:
//   start-charge  run.start(), send `go`, and block inside the child's task after the ledger line:
//                 the crash-mid-task window, with the child's step pending in the journal.
//   resume        resume from the journal's last save, let the pending work settle, and print the
//                 snapshot, the status, and the journal's committed steps. The child's task, whose
//                 result the test committed after the kill, is replayed from the journal, not run
//                 again: the ledger must still hold one line.
//
// Readiness is `<journal>.ready`, written atomically when the process is about to block, so the
// test awaits a marker rather than sleeping.

import { renameSync, writeFileSync } from "node:fs";

import type { Shape } from "@reactre/state";
import type { Host } from "@reactre/state/durable";

import { parentMachine, type ParentSaved, useLedger, useWork } from "./child.ts";
import { type Journal, readJournal, writeJournal } from "./journal.ts";

const [mode, journalPath, ledgerPath] = process.argv.slice(2);
if (mode === undefined || journalPath === undefined || ledgerPath === undefined)
  throw new Error("usage: child-worker.ts <start-charge|resume> <journal> <ledger>");

const { durable } = await import("@reactre/state/durable");

const j: Journal = readJournal(journalPath);
const flush = (): void => writeJournal(journalPath, j);
/** The process is about to block and the journal is committed: written atomically, never torn. */
const ready = (what: object): void => {
  const marker = `${journalPath}.ready`;
  writeFileSync(`${marker}.tmp`, JSON.stringify(what));
  renameSync(`${marker}.tmp`, marker);
};
/** Block forever: the test kills this process. */
const never = (): Promise<never> => new Promise<never>(() => {});

const host: Host<Shape> = {
  now: () => j.clock,
  async step<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const done = j.steps[id];
    // A committed result is replayed, not re-run: this is what makes the child's task run once.
    if (done !== undefined) {
      if (!done.ok) throw new Error(done.error);
      return done.value as T;
    }
    j.pending = id;
    flush();
    try {
      const value = await fn();
      j.steps[id] = { ok: true, value };
      delete j.pending;
      flush();
      return value;
    } catch (error) {
      j.steps[id] = { ok: false, error: String(error) };
      delete j.pending;
      flush();
      throw error;
    }
  },
  schedule: (id, at) => {
    j.scheduled[id] = at;
    j.scheduledEver[id] = at;
    flush();
  },
  cancel: (id) => {
    delete j.scheduled[id];
    j.cancelled.push(id);
    flush();
  },
  save: async (snapshot) => {
    j.saves.push(JSON.parse(JSON.stringify(snapshot)));
    flush();
  },
};

useLedger(ledgerPath);
// In `start-charge` the child's task waits here after the ledger line: the process is about to be
// killed, so its result never reaches this run; the test commits it after the kill.
useWork(async (id) => {
  ready({ at: "task", id });
  return never();
});

/** Let the run's queue settle: a pending task's result comes back through it. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 200 && run.status() === "active"; i++) await new Promise((r) => setTimeout(r, 5));
};

const run = durable(parentMachine, host);

if (mode === "start-charge") {
  await run.start();
  await run.send({ type: "go" });
} else if (mode === "resume") {
  const last = j.saves.at(-1);
  if (last === undefined) throw new Error("no save to resume from");
  await run.resume(last as ParentSaved);
  await settle();
  process.stdout.write(
    JSON.stringify({ snapshot: run.snapshot(), status: run.status(), steps: j.steps, scheduled: j.scheduled }),
  );
} else {
  throw new Error(`unknown mode "${mode}"`);
}
