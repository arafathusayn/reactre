// A/B proof for one runtime or compiler change: one of our entries built from the packages at a
// base git revision and from the working tree, measured as jfb/run.ts measures (the official click
// window, warmups, throttling, forced GC), in alternating batches, each in a fresh browser, so
// drift in the machine's speed lands on both.
//
// Per test: each side's median, the difference of medians and its 95% bootstrap interval. The
// change is proven faster when the whole interval is below zero, proven slower when above, and
// unproven otherwise. A single run of run.ts cannot tell a small gain from noise; the interval
// says whether the samples support one.
//
//   bun ab.ts --base <git ref> [--entry reactre-compat] [--benchmarks 04_select1k,...]
//             [--rounds 6] [--batch 5] [--phases]
//
// --base defaults to HEAD, which measures uncommitted changes. --benchmarks replaces the six
// default tests. Each side gets rounds * batch samples per test; --phases also compares style,
// layout and paint time.
//
// Key decisions:
// - The sides alternate which goes first each round, so a slowdown that grows within a round
//   does not always land on the same side.
// - Only `packages` is taken from the base revision; the benchmark apps and tools are the working
//   tree's on both sides, so the comparison isolates the package change.

import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { buildEntry, OURS, repo } from "jfb/prepare";
import { benches, measure, serveRoot, startBrowser } from "jfb/run";

// #region Options and builds

const argv = process.argv.slice(2);
const value = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const ref = value("--base") ?? "HEAD";
const name = value("--entry") ?? "reactre-compat";
const entry = OURS[name];
if (entry === undefined) throw new Error(`unknown entry ${name}; one of ${Object.keys(OURS).join(", ")}`);
const ids = value("--benchmarks")?.split(",") ?? [
  "04_select1k",
  "03_update10th1k_x16",
  "05_swap1k",
  "02_replace1k",
  "01_run1k",
  "09_clear1k_x8",
];
const rounds = Number(value("--rounds") ?? 6);
const batch = Number(value("--batch") ?? 5);
// The window's duration and script time, and with --phases its style, layout and paint too.
const metrics = argv.includes("--phases") ? ["duration", "script", "style", "layout", "paint"] : ["duration", "script"];
/** Where the base revision's packages are unpacked; recreated on every run. */
const scratch = join(import.meta.dir, ".cache/ab");

// The base revision's packages, with a node_modules that links them as the
// workspace does, so the base build resolves only base sources.
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, "node_modules/@reactre"), { recursive: true });
const tar = Bun.spawnSync(["sh", "-c", `git -C '${repo}' archive '${ref}' packages | tar -x -C '${scratch}'`]);
if (tar.exitCode !== 0) throw new Error(`git archive ${ref}: ${tar.stderr}`);
for (const dir of ["core", "dom", "compiler", "compat"])
  symlinkSync(join(scratch, "packages", dir), join(scratch, "node_modules/@reactre", dir));

// Both sides build into the benchmark checkout as their own entries, so run.ts's `measure` loads
// them like any other entry.
await buildEntry("ab-base", entry, { packages: scratch });
await buildEntry("ab-head", entry);

// #endregion

// #region Statistics

/** The median of `xs`: the middle value, or the mean of the two middle values. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
/**
 * The 95% bootstrap interval of median(b) - median(a): 4,000 resamples of each side with
 * replacement, and the 2.5th and 97.5th percentiles of their differences. The bootstrap makes no
 * assumption about the shape of the timing distribution, which is skewed and often has outliers.
 */
function interval(a: number[], b: number[]): [number, number] {
  const pick = (xs: number[]) => Array.from(xs, () => xs[Math.floor(Math.random() * xs.length)]!);
  const d: number[] = [];
  for (let i = 0; i < 4000; i++) d.push(median(pick(b)) - median(pick(a)));
  d.sort((x, y) => x - y);
  return [d[Math.floor(d.length * 0.025)]!, d[Math.floor(d.length * 0.975)]!];
}

// #endregion

// #region Measuring and report

const server = serveRoot();
const base = `http://127.0.0.1:${server.port}`;
console.log(`A/B of ${name}: base ${ref} vs working tree, ${rounds} rounds of ${batch} samples per side\n`);
try {
  for (const b of benches.filter((x) => ids.includes(x.id))) {
    const times: Record<string, Record<string, number>[]> = { "ab-base": [], "ab-head": [] };
    for (let r = 0; r < rounds; r++) {
      // Odd rounds run head first, even rounds base first.
      for (const side of r % 2 ? ["ab-head", "ab-base"] : ["ab-base", "ab-head"]) {
        const browser = await startBrowser();
        try {
          for (let i = 0; i < batch; i++) times[side]!.push(await measure(browser, base, side, b));
        } finally {
          await browser.close();
        }
      }
    }
    for (const metric of metrics) {
      const a = times["ab-base"]!.map((x) => x[metric]!),
        h = times["ab-head"]!.map((x) => x[metric]!);
      const [lo, hi] = interval(a, h);
      const verdict = hi < 0 ? "FASTER (proven)" : lo > 0 ? "SLOWER (proven)" : "no proven difference";
      console.log(
        `${b.id.padEnd(22)} ${metric.padEnd(8)} base ${median(a).toFixed(1).padStart(7)}  head ${median(h).toFixed(1).padStart(7)}  ` +
          `diff ${(median(h) - median(a)).toFixed(1).padStart(6)} ms  95% [${lo.toFixed(1)}, ${hi.toFixed(1)}]  ${verdict}`,
      );
    }
  }
} finally {
  server.stop();
}

// #endregion
