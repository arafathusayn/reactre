// A durable child across a real process boundary: the run is a child process (`bun --preload ...
// child-worker.ts`), the journal is a file, and the "crash" is a SIGKILL to that child's own
// handle. ./durable-process.test.ts proves the same for a childless machine; ./durable-child-cancel
// proves a child's cancel/restart in one process. This proves the part only a real process can: a
// child's task committed before the kill is replayed from the journal in a second process, not run
// again, and the saved snapshot's version is carried across unchanged.
//
// Process safety: every child is a `Bun.spawn` this test created, killed only through its own
// handle (`proc.kill("SIGKILL")`), in a `finally`. No pkill, no killall, no kill by PID number, no
// process-name matching. Each test gets its own temp dir, removed in `afterAll`. Readiness is the
// `<journal>.ready` marker (written atomically), not a sleep.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJournal, writeJournal } from "./fixtures/durable-process/journal.ts";

const dir = mkdtempSync(join(tmpdir(), "reactre-state-durable-process-child-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const worker = join(import.meta.dir, "fixtures", "durable-process", "child-worker.ts");

/** A child this test started: its handle, and the files it writes. */
interface Child {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly journal: string;
  readonly ledger: string;
}

/** Start the child worker in `mode` on a fresh journal in `dir`, under `name`. */
function spawn(mode: string, name: string): Child {
  const journal = join(dir, `${name}.json`);
  const ledger = join(dir, `${name}.ledger`);
  // The preload compiles the fixture's machine, as an app's build does: without it `setup` throws
  // S0 (uncompiled).
  const proc = Bun.spawn(["bun", "--preload", "@reactre/state/plugin/preload", worker, mode, journal, ledger], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { proc, journal, ledger };
}

/** Await the worker's readiness marker: it is about to block, and its journal is committed. */
async function ready(child: Child): Promise<{ at: string; id?: string }> {
  const marker = `${child.journal}.ready`;
  for (let i = 0; i < 2000; i++) {
    if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8")) as { at: string; id?: string };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`the worker never became ready (${marker})`);
}

/** Kill the child through its own handle, and wait for it to be gone. */
async function kill(child: Child): Promise<void> {
  child.proc.kill("SIGKILL");
  await child.proc.exited;
}

/** The child task's real executions, from the ledger it appends to: it survives the process. */
function runs(ledger: string): number {
  if (!existsSync(ledger)) return 0;
  return readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line === "charge").length;
}

/** Run the worker to completion in `mode`, and read its one JSON line. */
async function finish(
  mode: string,
  name: string,
): Promise<{
  snapshot: { state: string; version: number; children?: Record<string, { state: string }> };
  status: string;
  steps: Record<string, { ok: boolean }>;
}> {
  const child = spawn(mode, name);
  const out = await new Response(child.proc.stdout as ReadableStream<Uint8Array>).text();
  const code = await child.proc.exited;
  if (code !== 0)
    throw new Error(
      `worker ${mode} exited ${code}: ${out}\n${await new Response(child.proc.stderr as ReadableStream<Uint8Array>).text()}`,
    );
  return JSON.parse(out) as {
    snapshot: { state: string; version: number; children?: Record<string, { state: string }> };
    status: string;
    steps: Record<string, { ok: boolean }>;
  };
}

describe("a durable child across a real process boundary", () => {
  test("a process killed mid-child-task resumes in another process, and the child's task runs exactly once", async () => {
    const first = spawn("start-charge", "child");
    try {
      // The child's task is running and recorded: the process is about to block on its result.
      expect(await ready(first)).toEqual({ at: "task", id: "job-1" });
      expect(runs(first.ledger)).toBe(1);
      // The journal holds the pending child step, and the save with the child in the snapshot.
      const before = readJournal(first.journal);
      expect(before.pending).toBe("busy#1/job/working#1/task");
      const saved = before.saves.at(-1) as {
        state: string;
        version: number;
        children?: Record<string, { state: string; data: { id: string } }>;
      };
      expect(saved).toMatchObject({ state: "busy", version: 1 });
      expect(saved.children?.["busy#1/job"]).toMatchObject({ state: "working", data: { id: "job-1" } });
      // A real process death: the child's task result never reaches this run.
      await kill(first);
    } finally {
      if (first.proc.exitCode === null) await kill(first);
    }
    expect(runs(first.ledger)).toBe(1);

    // The external host commits the child's task result, as a journaling host does when the work
    // finishes after the process died. The resume must replay it, not run the task again.
    const j = readJournal(first.journal);
    j.steps["busy#1/job/working#1/task"] = { ok: true, value: { type: "started", id: "job-1" } };
    delete j.pending;
    j.clock = 2000;
    writeJournal(first.journal, j);

    const resumed = await finish("resume", "child");
    // The child's done moved the parent to its final state, and the version is the saved one.
    expect(resumed.snapshot).toMatchObject({ state: "finished", data: { n: 1 }, version: 1 });
    expect(resumed.status).toBe("done");
    // The child's task ran once in the first process, and not again in the second.
    expect(runs(first.ledger)).toBe(1);
    // The committed step is the one the first process left pending: replayed, not re-asked.
    expect(resumed.steps["busy#1/job/working#1/task"]).toMatchObject({ ok: true });
  }, 30_000);
});
