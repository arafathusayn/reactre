// The journal a durable run writes to a file, so it outlives the process that wrote it. The
// in-memory journal in ../../durable.test.ts is a JS object: a "crash" there is a flag, and the
// object is still reachable. Here every write goes to disk, atomically (a temp file renamed over
// the journal), so a SIGKILL mid-write cannot leave a torn file, and a second process reads exactly
// what the first committed.
//
// What is kept is what the host's four callbacks give: each step's committed result by id, every
// save, the scheduled timers, the cancelled ones, and the clock. A step's result is written only
// when the step's promise settles, so a process killed while the step is still running leaves no
// result: the resume must ask the host again, and the host (the test, acting as the external
// journal) supplies the committed result.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** A step's committed result: its value, or its error, as the host recorded it. */
export interface StepResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** What outlives a process: the same four things the in-memory journal keeps, on disk. */
export interface Journal {
  readonly steps: Record<string, StepResult>;
  readonly saves: unknown[];
  /** The timers pending now: a cancel removes one. */
  readonly scheduled: Record<string, number>;
  /** Every timer ever scheduled, at its deadline: a cancel does not remove it, so a test can prove
   * a timer was recovered from a save even after the node exited and cancelled it. */
  readonly scheduledEver: Record<string, number>;
  readonly cancelled: string[];
  /** The step asked for and not yet committed: a kill here leaves it pending, for the test to commit. */
  pending?: string;
  clock: number;
}

/** A journal with nothing in it, at the clock the tests start from. */
export const emptyJournal = (): Journal => ({
  steps: {},
  saves: [],
  scheduled: {},
  scheduledEver: {},
  cancelled: [],
  clock: 1000,
});

/** The journal at `path`, or an empty one when the file isn't there yet. */
export function readJournal(path: string): Journal {
  if (!existsSync(path)) return emptyJournal();
  return JSON.parse(readFileSync(path, "utf8")) as Journal;
}

/** Write `j` to `path` atomically: a temp file renamed over it, so a kill mid-write leaves the old one. */
export function writeJournal(path: string, j: Journal): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(j));
  renameSync(tmp, path);
}
