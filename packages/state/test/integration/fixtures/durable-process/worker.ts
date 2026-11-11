// The child process the process-boundary tests run: one durable run on a file journal, one step,
// then a line of JSON on stdout. It is a real executable subprocess (`bun --preload ... worker.ts`),
// so a SIGKILL to it is a real process death, not a flag.
//
// Modes:
//   start-save    run.start(), send `go`, and block inside the host's `save` for the snapshot that
//                 carries the 24h timer: the save-before-schedule window (the runtime saves, then
//                 cancels, then schedules), with a timer pending and nothing scheduled yet.
//   start-charge  run.start(), send `go`, and block inside the charge after it is recorded: the
//                 crash-mid-charge window.
//   start-fail    run.start(), send `go`, and let the charge fail: the error is committed as the
//                 step's result, and the run moves to `retrying` with its 1s timer scheduled.
//   resume        resume from the journal's last save, let the pending work settle, print the
//                 snapshot and the scheduled timers.
//   fire          resume, then fire the journal's pending timer (the retry's), and print the result.
//   migrate       read a version-0 snapshot from `<journal>.old`, migrate it with the v1 machine's
//                 steps, backfill the durable fields, resume, and print the snapshot.
//
// Readiness is a file (`<journal>.ready`), written when the process is about to block, so the test
// awaits a marker rather than sleeping a fixed time.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { Shape } from "@reactre/state";
import type { Host } from "@reactre/state/durable";

import type { JobV1Saved } from "./job-v1.ts";
import { jobMachine, type JobSaved, useLedger, useWait } from "./job.ts";
import { type Journal, readJournal, writeJournal } from "./journal.ts";
import { retryMachine, type RetrySaved, useCharge, useLedger as useRetryLedger } from "./retry.ts";

const [mode, journalPath, ledgerPath] = process.argv.slice(2);
if (mode === undefined || journalPath === undefined || ledgerPath === undefined)
  throw new Error("usage: worker.ts <start-save|start-charge|start-fail|resume|fire|migrate> <journal> <ledger>");

const { durable } = await import("@reactre/state/durable");

const j: Journal = readJournal(journalPath);
const flush = (): void => writeJournal(journalPath, j);
/**
 * The test is waiting for this: the process is about to block, and the journal is committed.
 * Written to a temp name and renamed, so the test never reads a half-written marker: it polls the
 * final path, which only appears once the whole file is on disk.
 */
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
    // A committed result is replayed, not re-run: this is what makes the charge run once.
    if (done !== undefined) {
      if (!done.ok) throw new Error(done.error);
      return done.value as T;
    }
    // Pending, recorded before the work runs: a kill leaves it pending, and the test commits it.
    j.pending = id;
    flush();
    try {
      const value = await fn();
      j.steps[id] = { ok: true, value };
      delete j.pending;
      flush();
      return value;
    } catch (error) {
      // A failure is a committed result too: the resume replays it, and the run takes its error
      // path (the retry), rather than running the work again.
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
    // The save-before-schedule window: this save carries the timer, and the process dies before
    // the runtime's next call (cancel, then schedule).
    if (mode === "start-save" && Object.keys(snapshot.timers).length > 0) {
      ready({ at: "save" });
      await never();
    }
  },
};

/** Let the run's queue settle: a pending task's result comes back through it. */
const settle = async (run: { status: () => string }): Promise<void> => {
  for (let i = 0; i < 200 && run.status() === "active"; i++) await new Promise((r) => setTimeout(r, 5));
};

if (mode === "start-fail" || mode === "fire") {
  // The retry machine: a charge that fails in the first process, and a host-driven retry in the
  // second. Its own fixture, so the crash tests' machine keeps its shape.
  useRetryLedger(ledgerPath);
  useCharge(async (amount, tries) => {
    if (mode === "start-fail") throw new Error("card declined");
    return `ch_${amount}_${tries}`;
  });
  const run = durable(retryMachine, host);
  if (mode === "start-fail") {
    await run.start();
    await run.send({ type: "go" });
    await settle(run);
    process.stdout.write(
      JSON.stringify({ snapshot: run.snapshot(), status: run.status(), scheduled: j.scheduled, steps: j.steps }),
    );
  } else {
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save to resume from");
    await run.resume(last as RetrySaved);
    await settle(run);
    // The retry's timer, from the journal: the host fires it, and the run charges again.
    const id = Object.keys(j.scheduled)[0];
    if (id === undefined) throw new Error("no pending timer to fire");
    const result = await run.fire(id);
    await settle(run);
    process.stdout.write(
      JSON.stringify({ fired: id, result, snapshot: run.snapshot(), status: run.status(), scheduled: j.scheduled }),
    );
  }
} else {
  useLedger(ledgerPath);
  // The charge records its real execution (in job.ts), then waits here: the test commits the result.
  useWait(async () => {
    ready({ at: "charge" });
    return never();
  });
  const run = durable(jobMachine, host);

  if (mode === "start-save" || mode === "start-charge") {
    await run.start();
    await run.send({ type: "go" });
  } else if (mode === "resume") {
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save to resume from");
    await run.resume(last as JobSaved);
    await settle(run);
    process.stdout.write(
      JSON.stringify({ snapshot: run.snapshot(), status: run.status(), scheduled: j.scheduled, steps: j.steps }),
    );
  } else if (mode === "migrate") {
    // A version-0 snapshot on disk, written by an older build: migrate it, backfill the durable
    // fields the old build didn't write, and resume the v1 machine from it.
    const { jobMachineV1, migrate, useLedger: useV1Ledger } = await import("./job-v1.ts");
    useV1Ledger(ledgerPath);
    const old = JSON.parse(readFileSync(`${journalPath}.old`, "utf8")) as {
      state: string;
      data: unknown;
      version: number;
      entries: Record<string, number>;
      timers: Record<string, number>;
      tasks: string[];
    };
    // The migration gives the typed state (it backfills `tries`); the old snapshot's durable
    // bookkeeping (its entries, its pending timer and task) carries over, so the resumed run asks
    // the host for the same step id and the charge runs.
    const migrated = migrate(old);
    const saved = { ...migrated, entries: old.entries, timers: old.timers, tasks: old.tasks };
    const v1 = durable(jobMachineV1, host);
    await v1.resume(saved as JobV1Saved);
    await settle(v1);
    process.stdout.write(JSON.stringify({ snapshot: v1.snapshot(), status: v1.status(), scheduled: j.scheduled }));
  } else {
    throw new Error(`unknown mode "${mode}"`);
  }
}
