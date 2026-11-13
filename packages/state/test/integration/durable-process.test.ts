// durable across a real process boundary: the run is a child process (`bun --preload ... worker.ts`),
// the journal is a file, and the "crash" is a SIGKILL to that child's own handle. ../../durable.test.ts
// proves the same scenarios in one process, with an in-memory journal and an `alive` flag; this
// proves the part that only a real process can: the journal on disk is what a second process resumes
// from, and a step committed before the kill is replayed rather than run again.
//
// Process safety: every child is a `Bun.spawn` this test created, and it is killed only through its
// own handle (`proc.kill("SIGKILL")`), in a `finally`. No `pkill`, no `killall`, no kill by PID
// number, no process-name matching: nothing outside the handles this file holds is ever signalled.
// Each test gets its own temp dir, removed in `afterAll`.
//
// Readiness is a file the worker writes when it is about to block (`<journal>.ready`), so the test
// awaits a marker rather than sleeping a fixed time. The tests run serially (bun runs one test at a
// time in a file), each on its own journal and ledger, so no two read the same files.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJournal, writeJournal } from "./fixtures/durable-process/journal.ts";
import { installApp } from "./install.ts";

const dir = mkdtempSync(join(tmpdir(), "reactre-state-durable-process-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const root = join(import.meta.dir, "..", "..", "..", "..");
const pkg = join(root, "packages", "state");
const fixtures = join(import.meta.dir, "fixtures", "durable-process");
const worker = join(fixtures, "worker.ts");
const DAY = 86_400_000;

/** Run `cmd` in `cwd`, its output returned; throw with the output when it fails. */
function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}\n${r.stderr.toString()}`);
  return out;
}

/** A child this test started: its handle, and the files it writes. */
interface Child {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly journal: string;
  readonly ledger: string;
}

/** Start the worker in `mode` on a fresh journal in `dir`, under `name`. */
function spawn(mode: string, name: string, entry = worker, cwd = import.meta.dir, preload = true): Child {
  const journal = join(dir, `${name}.json`);
  const ledger = join(dir, `${name}.ledger`);
  return spawnOn(mode, journal, ledger, entry, cwd, preload);
}

/** Start the worker in `mode` on the given journal and ledger: a test that pre-writes them. */
function spawnOn(
  mode: string,
  journal: string,
  ledger: string,
  entry = worker,
  cwd = import.meta.dir,
  preload = true,
): Child {
  // The preload compiles the fixture's machine, as an app's build does: without it the fixture's
  // `setup` throws S0 (uncompiled). A built bundle is already compiled, so it runs without one.
  const cmd = preload
    ? ["bun", "--preload", "@reactre/state/plugin/preload", entry, mode, journal, ledger]
    : ["bun", entry, mode, journal, ledger];
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { proc, journal, ledger };
}

/** Await the worker's readiness marker: it is about to block, and its journal is committed. */
async function ready(child: Child): Promise<{ at: string }> {
  const marker = `${child.journal}.ready`;
  for (let i = 0; i < 2000; i++) {
    if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8")) as { at: string };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`the worker never became ready (${marker})`);
}

/** Kill the child through its own handle, and wait for it to be gone. */
async function kill(child: Child): Promise<void> {
  child.proc.kill("SIGKILL");
  await child.proc.exited;
}

/** The charge's real executions, from the ledger the charge appends to: it survives the process. */
function charges(child: Child): number {
  return countCharges(child.ledger);
}

/** The charge's real executions in `ledger`: one line per run, appended before the work. */
function countCharges(ledger: string): number {
  if (!existsSync(ledger)) return 0;
  return readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line === "charge").length;
}

/** The worker's one JSON line: its final snapshot and what the host was asked to do. */
interface Done {
  readonly snapshot: { state: string };
  readonly status: string;
  readonly scheduled: Record<string, number>;
}

/** Await a child's exit, its one JSON line returned; throw with its output when it failed. */
async function collect(child: Child, what: string): Promise<Done> {
  const out = await new Response(child.proc.stdout as ReadableStream<Uint8Array>).text();
  const code = await child.proc.exited;
  if (code !== 0)
    throw new Error(
      `worker ${what} exited ${code}: ${out}\n${await new Response(child.proc.stderr as ReadableStream<Uint8Array>).text()}`,
    );
  return JSON.parse(out) as Done;
}

/** Run the worker to completion in `mode`, and read its one JSON line. */
async function finish(
  mode: string,
  name: string,
  entry = worker,
  cwd = import.meta.dir,
  preload = true,
): Promise<Done> {
  return finishOn(mode, join(dir, `${name}.json`), join(dir, `${name}.ledger`), entry, cwd, preload);
}

/** Run the worker to completion on the given journal and ledger, and read its one JSON line. */
async function finishOn(
  mode: string,
  journal: string,
  ledger: string,
  entry = worker,
  cwd = import.meta.dir,
  preload = true,
): Promise<Done> {
  return collect(spawnOn(mode, journal, ledger, entry, cwd, preload), mode);
}

describe("durable across a real process boundary", () => {
  test("a process killed mid-charge resumes in another process, and the charge runs exactly once", async () => {
    const first = spawn("start-charge", "mid-charge");
    try {
      // The charge is running and recorded: the process is about to block on its result.
      expect(await ready(first)).toEqual({ at: "charge" });
      expect(charges(first)).toBe(1);
      // The journal holds the pending step, and the save with the pending task and the 24h timer.
      const before = readJournal(first.journal);
      expect(before.pending).toBe("charging#1/task");
      expect(before.saves.at(-1)).toMatchObject({
        state: "charging",
        data: { amount: 5 },
        tasks: ["charging#1/task"],
        timers: { "charging#1/after/86400000": 1000 + DAY },
      });
      // A real process death: the charge's result never reaches this run.
      await kill(first);
    } finally {
      if (first.proc.exitCode === null) await kill(first);
    }
    expect(charges(first)).toBe(1);

    // The external host commits the charge's result, as a journaling host does when the work
    // finishes after the process died. The resume must replay it, not run the charge again.
    const j = readJournal(first.journal);
    j.steps["charging#1/task"] = { ok: true, value: { type: "charged", id: "ch_1" } };
    delete j.pending;
    j.clock = 2000;
    writeJournal(first.journal, j);

    const resumed = await finish("resume", "mid-charge");
    expect(resumed.snapshot).toMatchObject({ state: "paid", data: { id: "ch_1" } });
    expect(resumed.status).toBe("done");
    // The charge ran once in the first process, and not again in the second.
    expect(charges(first)).toBe(1);
  }, 30_000);

  test("a process killed in the save-before-schedule window resumes and schedules the timer", async () => {
    const first = spawn("start-save", "save-window");
    try {
      // The save that carries the 24h timer is committed, and the process dies before the runtime's
      // next call (cancel, then schedule): the timer is pending in the save, and nothing scheduled.
      expect(await ready(first)).toEqual({ at: "save" });
      const before = readJournal(first.journal);
      expect(before.saves.at(-1)).toMatchObject({
        state: "charging",
        timers: { "charging#1/after/86400000": 1000 + DAY },
      });
      // The window is genuine: the save is on disk, and the host was never asked to schedule.
      expect(before.scheduled).toEqual({});
      expect(before.scheduledEver).toEqual({});
      await kill(first);
    } finally {
      if (first.proc.exitCode === null) await kill(first);
    }

    // The resume schedules the pending timer from the save, at its saved deadline, not now + a day.
    const resumed = await finish("resume", "save-window");
    expect(resumed.snapshot).toMatchObject({ state: "charging" });
    expect(resumed.scheduled).toEqual({ "charging#1/after/86400000": 1000 + DAY });
  }, 30_000);

  test("a committed step error in one process is replayed, not re-run, and the retry charges in a second", async () => {
    // The first process: the charge fails. The failure is a committed step result on disk, and the
    // run moves to `retrying` with its 1s timer scheduled. The process exits normally.
    const journal = join(dir, "retry.json");
    const ledger = join(dir, "retry.ledger");
    const first = await finishOn("start-fail", journal, ledger);
    expect(first.snapshot).toMatchObject({ state: "retrying", data: { amount: 5, tries: 1 } });
    expect(first.status).toBe("active");
    // The charge ran once, and its failure is the journal's committed result for that step.
    expect(countCharges(ledger)).toBe(1);
    const j = readJournal(journal);
    expect(j.steps["charging#1/task"]).toMatchObject({ ok: false });
    expect(j.pending).toBeUndefined();
    // The retry's timer is pending, at the host's clock plus a second.
    expect(first.scheduled).toEqual({ "retrying#1/after/1000": 1000 + 1000 });

    // The second process, a distinct child: resume from the same journal, and the host fires the
    // retry timer. The failed step is replayed from the journal (not run again), and the retry
    // charges once more.
    const second = await finishOn("fire", journal, ledger);
    expect(second.snapshot).toMatchObject({ state: "paid", data: { id: "ch_5_1" } });
    expect(second.status).toBe("done");
    // Two real executions: the failed attempt and the retry. The replay added none.
    expect(countCharges(ledger)).toBe(2);
  }, 30_000);

  test("a version-0 snapshot on disk migrates, backfills its missing field, and resumes the typed state", async () => {
    // A snapshot an older build wrote: version 0, `charging` without `tries`, mid-charge (a pending
    // step, a 24h timer). It is on disk, not in memory, so the migration reads what a real upgrade
    // reads. The step id is the one the version-1 shape also asks for.
    const journal = join(dir, "migrate.json");
    const ledger = join(dir, "migrate.ledger");
    writeFileSync(
      `${journal}.old`,
      JSON.stringify({
        state: "charging",
        data: { amount: 5 },
        version: 0,
        entries: { charging: 1 },
        timers: { "charging#1/after/86400000": 1000 + DAY },
        tasks: ["charging#1/task"],
      }),
    );

    const migrated = await finishOn("migrate", journal, ledger);
    // The migration backfilled `tries: 0`; the run continued in the correct typed state, asked the
    // host for the pending charge, and reached `paid` with the id the charge returned.
    expect(migrated.snapshot).toMatchObject({ state: "paid", data: { id: "ch_5" } });
    expect(migrated.status).toBe("done");
    expect(countCharges(ledger)).toBe(1);
  }, 30_000);

  test("the packed, installed package runs the same crash and resume in a real subprocess", async () => {
    // The package as it ships: its build, packed, and installed outside the workspace, as a user
    // installs it (the pattern ../../ssr.test.ts uses).
    const packs = join(dir, "packs");
    const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
    run(["bun", "pm", "pack", "--quiet", "--destination", packs], pkg);
    const tarball = join(packs, `reactre-state-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);

    const app = join(dir, "app");
    cpSync(fixtures, app, { recursive: true });
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "durable-process-consumer",
          private: true,
          type: "module",
          dependencies: { "@reactre/state": `file:${tarball}` },
        },
        null,
        2,
      ),
    );
    installApp(app);

    // The installed worker, built by the installed plugin: `conditions: ["module"]` makes the
    // bundle resolve `@reactre/state` to the package's `dist/` (its built files), not its `src/`
    // (the `bun` condition Bun's runtime prefers). The bundle is the executable subprocess.
    const { default: state } = (await import(Bun.resolveSync("@reactre/state/plugin/bun", app))) as {
      default: (options?: { dev?: boolean }) => import("bun").BunPlugin;
    };
    const built = await Bun.build({
      entrypoints: [join(app, "worker.ts")],
      target: "node",
      format: "esm",
      conditions: ["module"],
      plugins: [state({ dev: false })],
      throw: false,
    });
    if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
    const [bundle] = built.outputs;
    if (bundle === undefined) throw new Error("no worker bundle");
    const text = await bundle.text();
    // The bundle is the built package: its dist chunks, not its source.
    expect(text).toMatch(/chunk-[a-z0-9]+\.js/);
    expect(text).not.toContain("src/index.ts");
    const entry = join(app, "worker.bundle.mjs");
    writeFileSync(entry, text);

    const first = spawn("start-charge", "packed", entry, app, false);
    try {
      expect(await ready(first)).toEqual({ at: "charge" });
      expect(charges(first)).toBe(1);
      await kill(first);
    } finally {
      if (first.proc.exitCode === null) await kill(first);
    }

    const j = readJournal(first.journal);
    j.steps["charging#1/task"] = { ok: true, value: { type: "charged", id: "ch_1" } };
    delete j.pending;
    j.clock = 2000;
    writeJournal(first.journal, j);

    const resumed = await finish("resume", "packed", entry, app, false);
    expect(resumed.snapshot).toMatchObject({ state: "paid", data: { id: "ch_1" } });
    expect(resumed.status).toBe("done");
    expect(charges(first)).toBe(1);
  }, 60_000);
});
