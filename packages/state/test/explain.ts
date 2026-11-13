// Prints what `bun check` says for each mistake in ./mistakes.ts and each feature's
// ./features/<feature>/mistakes.ts, as a model reading the output sees it: each file is checked
// without its expect-error lines, and each error is listed under the case on or above its line.

import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const files = ["mistakes.ts", ...[...new Bun.Glob("features/*/mistakes.ts").scanSync({ cwd: dir })].sort()];

interface Probe {
  readonly file: string;
  readonly probe: string;
  readonly cases: { line: number; title: string }[];
}

const probes: Probe[] = [];
for (const file of files) {
  const lines = (await Bun.file(join(dir, file)).text()).split("\n");
  const cases: { line: number; title: string }[] = [];
  const kept = lines.map((text, i) => {
    const match = /\/\/ @ts-expect-error (.*)$/.exec(text);
    if (match === null) return text;
    cases.push({ line: i + 1, title: match[1] ?? "" });
    return "";
  });
  const probe = file.replace(/mistakes\.ts$/, "mistakes.explained.ts");
  await Bun.write(join(dir, probe), kept.join("\n"));
  probes.push({ file, probe, cases });
}
try {
  const run = Bun.spawnSync(["bun", "check", "-p", join(dir, "tsconfig.json"), "--no-pretty"], { cwd: dir });
  const output = run.stdout.toString() + run.stderr.toString();
  const errors = [
    ...output.matchAll(/([\w/.-]*mistakes\.explained\.ts)\((\d+),\d+\): error (TS\d+): ([^\n]*(?:\n {2}[^\n]*)*)/g),
  ];
  for (const { file, probe, cases } of probes) {
    if (cases.length > 0) console.log(`\n# ${file}`);
    const own = errors.filter((e) => (e[1] ?? "").endsWith(probe));
    for (const { line, title } of cases) {
      const next = cases.find((c) => c.line > line)?.line ?? Infinity;
      const mine = own.filter((e) => Number(e[2]) > line && Number(e[2]) < next && Number(e[2]) <= line + 12);
      console.log(`\n## ${title}`);
      for (const e of mine.slice(0, 1)) console.log(`${e[3]}: ${(e[4] ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
      if (mine.length === 0) console.log("(no error: a regression)");
    }
  }
} finally {
  for (const { probe } of probes) rmSync(join(dir, probe));
}
