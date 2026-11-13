// Runs every library's cases (./cases.ts, ./<lib>.ts), each in its own file under
// compare/.cases/<lib>/, and prints where each library catches each mistake: one Markdown table,
// cases by libraries, and the counts per library. A full run writes ../results/mistakes.json.
//
//   bun --conditions=development packages/state/compare/mistakes/run.ts [--lib=xstate,ours] [--case=M12,M13]
//
// The development condition loads each library's development build, so its warnings count.

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { type Base, type Case, CASES, type Entry, isNa, type Library, type Mutation } from "./cases.ts";

const HERE = import.meta.dir;
const COMPARE = join(HERE, "..");
const ROOT = join(HERE, "../../../..");
const OUT = join(COMPARE, ".cases");
/** The columns' order; a library's file not listed here comes after, by name. */
const ORDER = ["ours", "xstate", "xstate5", "robot3", "store", "tsfsm", "yay", "doeixd", "hsm", "escapace", "jssm"];
const NOT_LIBRARIES = new Set(["cases", "run", "start"]);

const flag = (name: string): readonly string[] | null => {
  const arg = Bun.argv.find((a) => a.startsWith(`--${name}=`));
  return arg === undefined ? null : arg.slice(name.length + 3).split(",");
};
const onlyLibs = flag("lib");
const onlyCases = flag("case");
const full = onlyLibs === null && onlyCases === null;

for (const id of onlyCases ?? []) if (!CASES.some((c) => c.id === id)) throw new Error(`no case ${id} in cases.ts`);
const cases = CASES.filter((c) => onlyCases === null || onlyCases.includes(c.id));
const seen = new Set<string>();
for (const c of CASES) {
  if (seen.has(c.id)) throw new Error(`case ${c.id} is listed twice in cases.ts`);
  seen.add(c.id);
}

const keys = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -3))
  .filter((k) => !NOT_LIBRARIES.has(k) && (onlyLibs === null || onlyLibs.includes(k)))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
function rank(key: string): number {
  const i = ORDER.indexOf(key);
  return i === -1 ? ORDER.length : i;
}
for (const k of onlyLibs ?? []) if (!keys.includes(k)) throw new Error(`no library file mistakes/${k}.ts`);
const libs = new Map<string, Library>();
for (const key of keys) libs.set(key, ((await import(`./${key}.ts`)) as { default: Library }).default);

// A library's file answers every case: unknown ids are a typo, missing ones aren't filled yet.
const missing = new Map<string, string[]>();
for (const [key, lib] of libs) {
  const unknown = Object.keys(lib.cases).filter((id) => !seen.has(id));
  if (unknown.length > 0) throw new Error(`mistakes/${key}.ts has cases cases.ts lacks: ${unknown.join(", ")}`);
  const absent = CASES.filter((c) => !(c.id in lib.cases)).map((c) => c.id);
  if (absent.length > 0) missing.set(key, absent);
}

/** A port's source, its relative imports rewritten to work from the case's folder. */
async function portSource(lib: Library, key: string, base: Base): Promise<string | null> {
  const b = lib.bases[base];
  if (b === undefined) return null;
  const path = resolve(HERE, b.port);
  const from = dirname(path);
  const to = join(OUT, key);
  const source = (await Bun.file(path).text()).replace(
    /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\2/g,
    (_, lead: string, q: string, spec: string) => {
      const rel = relative(to, resolve(from, spec));
      return `${lead}${q}${rel.startsWith(".") ? rel : `./${rel}`}${q}`;
    },
  );
  return `${source}${b.tail}`;
}

/** The end of the leading comments and imports, where `prepend` goes. */
function afterImports(source: string): number {
  let end = 0;
  let offset = 0;
  let inImport = false;
  for (const line of source.split("\n")) {
    offset += line.length + 1;
    if (inImport || /^import\s/.test(line)) {
      inImport = !/;\s*$/.test(line);
      if (!inImport) end = offset;
    } else if (line.trim() !== "" && !line.trimStart().startsWith("//")) break;
  }
  return end;
}

function mutate(key: string, c: Case, base: string, m: Mutation): string {
  let source = base;
  for (const [from, to, all] of m.edits ?? []) {
    if (!source.includes(from))
      throw new Error(`mistakes/${key}.ts ${c.id}: its ${c.base} base has no ${JSON.stringify(from)}`);
    source = all === "all" ? source.replaceAll(from, to) : source.replace(from, to);
  }
  if (m.prepend !== undefined) {
    const at = afterImports(source);
    source = `${source.slice(0, at)}${m.prepend}\n${source.slice(at)}`;
  }
  if (m.append !== undefined) source += `${m.append}\n`;
  return source;
}

/** A module of the app's own effects, which a case may import (an import not known to be pure). */
const TELEMETRY = `// The app's analytics: a module of effects, as an app's own.\n\nexport const tracked: string[] = [];\n\nexport function track(name: string): void {\n  tracked.push(name);\n}\n`;

interface Written {
  readonly key: string;
  readonly id: string;
  readonly base: Base;
  readonly path: string;
  /** As written, then as formatted. */
  source: string;
}
const written: Written[] = [];
const bases: Written[] = [];
for (const [key, lib] of libs) {
  const dir = join(OUT, key);
  mkdirSync(dir, { recursive: true });
  // Stale cases go, one file at a time (a removed case's file would still be type-checked).
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) unlinkSync(join(dir, f));
  await Bun.write(
    join(dir, "tsconfig.json"),
    `{ "extends": "${relative(dir, join(ROOT, "tsconfig.json"))}", "include": ["*.ts"] }\n`,
  );
  await Bun.write(join(dir, "telemetry.ts"), TELEMETRY);
  const sources = new Map<Base, string>();
  for (const base of ["door", "job"] as const) {
    const s = await portSource(lib, key, base);
    if (s === null) continue;
    sources.set(base, s);
    const w = { key, id: `base-${base}`, base, path: join(dir, `base-${base}.ts`), source: s };
    bases.push(w);
    await Bun.write(w.path, s);
  }
  for (const c of cases) {
    const entry: Entry | undefined = lib.cases[c.id];
    if (entry === undefined || isNa(entry)) continue;
    const base = sources.get(c.base);
    if (base === undefined)
      throw new Error(`mistakes/${key}.ts ${c.id}: a ${c.base} case, and the library has no ${c.base} port: na(...)`);
    const w = { key, id: c.id, base: c.base, path: join(dir, `${c.id}.ts`), source: mutate(key, c, base, entry) };
    written.push(w);
    await Bun.write(w.path, w.source);
  }
}

// The written cases, formatted as the repository's files are (`bun fmt --check` covers the folder).
const fmt = Bun.spawnSync(["bun", "fmt", ...[...libs.keys()].map((k) => join(OUT, k))], { cwd: ROOT });
if (fmt.exitCode !== 0)
  console.warn(`bun fmt couldn't format the cases:\n${fmt.stdout.toString()}${fmt.stderr.toString()}`);
for (const w of [...bases, ...written]) w.source = await Bun.file(w.path).text();

// type: one `bun check` per library folder, at once. The first error in each file.
const typeErrors = new Map<string, string>();
const allTypeErrors = new Map<string, string[]>();
await Promise.all(
  [...libs.keys()].map(async (key) => {
    const proc = Bun.spawn(["bun", "check", "-p", join(OUT, key, "tsconfig.json"), "--no-pretty", "--all"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const said = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    // A syntax error in one case stops the type check of the whole folder: every type catch in
    // the library would turn silent, so the run stops instead.
    if (
      !/checked \d+ files|No type errors in \d+ files/.test(said) ||
      /TS18003|Stopped before type checking/.test(said)
    )
      throw new Error(`bun check didn't check .cases/${key}:\n${said}`);
    for (const line of said.split("\n")) {
      const m = /^(.+?\.ts)\(\d+,\d+\): error (TS\d+: .*)$/.exec(line);
      if (m === null) continue;
      const path = resolve(ROOT, m[1]!);
      const list = allTypeErrors.get(path) ?? [];
      list.push(m[2]!);
      allTypeErrors.set(path, list);
      // An unused variable (a case that stops reading `event`) is the repository's lint, not the library's catch.
      if (/^TS61(33|96|98)/.test(m[2]!)) continue;
      if (!typeErrors.has(path)) typeErrors.set(path, m[2]!);
    }
  }),
);

// The correct ports must pass, or every "caught" below means nothing.
for (const b of bases) {
  const errors = allTypeErrors.get(b.path);
  if (errors !== undefined) throw new Error(`${b.key}'s correct ${b.base} port fails bun check:\n${errors.join("\n")}`);
  const problem = libs.get(b.key)!.build?.(b.path, b.source) ?? null;
  if (problem !== null) throw new Error(`${b.key}'s correct ${b.base} port fails its build: ${problem}`);
}

// start: each file in its own process, a few at once.
interface Started {
  readonly said: readonly string[];
  readonly note?: string;
}
async function start(w: Written): Promise<Started> {
  const proc = Bun.spawn(["bun", "--conditions=development", join(HERE, "start.ts"), w.key, w.path, w.base], {
    cwd: COMPARE,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  const code = await proc.exited;
  const marked = out.split("\n").findLast((l) => l.startsWith("@@said "));
  if (marked !== undefined) return { said: JSON.parse(marked.slice(7)) as string[] };
  if (proc.signalCode !== null) return { said: [], note: "hangs: killed after 20s" };
  return { said: [`crashes (exit ${code}): ${(err.trim().split("\n").at(-1) ?? "").slice(0, 200)}`] };
}
async function pool<T, R>(items: readonly T[], f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(2, navigator.hardwareConcurrency - 2) }, worker));
  return out;
}
const baseline = new Map<string, readonly string[]>();
const baseRuns = await pool(bases, start);
bases.forEach((b, i) => {
  if (baseRuns[i]!.note !== undefined) throw new Error(`${b.key}'s correct ${b.base} port ${baseRuns[i]!.note}`);
  baseline.set(`${b.key}/${b.base}`, baseRuns[i]!.said);
});
const runs = await pool(written, start);

type Verdict = "type" | "build" | "start" | "silent" | "n/a" | "?";
interface Result {
  readonly verdict: Verdict;
  readonly type?: string;
  readonly build?: string;
  readonly start?: string;
  readonly note?: string;
  readonly na?: string;
}
const results = new Map<string, Result>(); // `${key}/${id}`
for (const [key, lib] of libs)
  for (const c of cases) {
    const entry = lib.cases[c.id];
    if (entry === undefined) results.set(`${key}/${c.id}`, { verdict: "?" });
    else if (isNa(entry)) results.set(`${key}/${c.id}`, { verdict: "n/a", na: entry.na });
  }
written.forEach((w, i) => {
  const type = typeErrors.get(w.path) ?? null;
  const build = libs.get(w.key)!.build?.(w.path, w.source) ?? null;
  const own = baseline.get(`${w.key}/${w.base}`)!;
  const said = runs[i]!.said.filter((s) => !own.includes(s));
  const startSaid = said.length === 0 ? null : said[0]!.replace(/\s+/g, " ").slice(0, 300);
  const verdict: Verdict = type !== null ? "type" : build !== null ? "build" : startSaid !== null ? "start" : "silent";
  results.set(`${w.key}/${w.id}`, {
    verdict,
    ...(type === null ? {} : { type }),
    ...(build === null ? {} : { build }),
    ...(startSaid === null ? {} : { start: startSaid }),
    ...(runs[i]!.note === undefined ? {} : { note: runs[i]!.note }),
  });
});

// The table.
const cols = [...libs].map(([key, lib]) => ({ key, name: lib.name }));
const lines: string[] = [];
lines.push(`| M# | Mistake | ${cols.map((c) => c.name).join(" | ")} |`);
lines.push(`| --- | --- | ${cols.map(() => "---").join(" | ")} |`);
for (const c of cases)
  lines.push(
    `| ${c.id} | ${c.name.replaceAll("|", "\\|")} | ${cols.map((l) => results.get(`${l.key}/${c.id}`)!.verdict).join(" | ")} |`,
  );

interface Counts {
  readonly type: number;
  readonly build: number;
  readonly before: number;
  readonly start: number;
  readonly silent: number;
  readonly na: number;
  readonly unfilled: number;
}
const counts = new Map<string, Counts>();
for (const l of cols) {
  const v = cases.map((c) => results.get(`${l.key}/${c.id}`)!.verdict);
  const n = (x: Verdict) => v.filter((y) => y === x).length;
  counts.set(l.key, {
    type: n("type"),
    build: n("build"),
    before: n("type") + n("build"),
    start: n("start"),
    silent: n("silent"),
    na: n("n/a"),
    unfilled: n("?"),
  });
}
const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`);
const totals: string[] = [];
totals.push(
  "| Library | Caught before running (type + build) | Of the cases it can express | At start | Silent | n/a |",
);
totals.push("| --- | --- | --- | --- | --- | --- |");
for (const l of cols) {
  const k = counts.get(l.key)!;
  const unfilled = k.unfilled > 0 ? ` (${k.unfilled} not filled)` : "";
  const can = cases.length - k.na - k.unfilled;
  totals.push(
    `| ${l.name}${unfilled} | ${k.before} (${k.type} + ${k.build}) | ${k.before}/${can}, ${percent(k.before, can)} | ${k.start} | ${k.silent} | ${k.na} |`,
  );
}
// The cases every library can express: the same mistakes, made in each.
const common = cases.filter((c) => cols.every((l) => !["n/a", "?"].includes(results.get(`${l.key}/${c.id}`)!.verdict)));
totals.push("");
totals.push(`The ${common.length} cases every library can express:`);
totals.push("");
totals.push("| Library | Caught before running | At start | Silent |");
totals.push("| --- | --- | --- | --- |");
for (const l of cols) {
  const v = common.map((c) => results.get(`${l.key}/${c.id}`)!.verdict);
  const n = (...x: Verdict[]) => v.filter((y) => x.includes(y)).length;
  totals.push(`| ${l.name} | ${n("type", "build")} | ${n("start")} | ${n("silent")} |`);
}
lines.push("", ...totals);
console.log(lines.join("\n"));

for (const [key, ids] of missing) console.log(`\nmistakes/${key}.ts doesn't fill: ${ids.join(", ")}`);

// One case: every check's message, for each library.
if (onlyCases !== null)
  for (const c of cases)
    for (const l of cols) {
      const r = results.get(`${l.key}/${c.id}`)!;
      console.log(`\n${c.id} in ${l.name}: ${r.verdict}${r.na === undefined ? "" : ` (${r.na})`}`);
      if (r.verdict === "n/a" || r.verdict === "?") continue;
      console.log(`  file:  ${relative(ROOT, join(OUT, l.key, `${c.id}.ts`))}`);
      console.log(`  type:  ${allTypeErrors.get(join(OUT, l.key, `${c.id}.ts`))?.join("\n         ") ?? "-"}`);
      console.log(`  build: ${r.build ?? "-"}`);
      console.log(`  start: ${r.start ?? "-"}${r.note === undefined ? "" : ` (${r.note})`}`);
    }

// @reactre/state against its catalog: a pinned row's case must be caught where the row says.
const catalog = new Map<string, { readonly catch: string; readonly status: string }>();
for (const line of (await Bun.file(join(COMPARE, "MISTAKES.md")).text()).split("\n")) {
  const cells = line.split(/(?<!\\)\|/).map((s) => s.trim());
  if (/^M\d+$/.test(cells[1] ?? "") && cells.length >= 8)
    catalog.set(cells[1]!, { catch: cells[5]!, status: cells[6]! });
}
const mismatches: string[] = [];
const ahead: string[] = [];
const twice: string[] = [];
if (libs.has("ours"))
  for (const c of cases) {
    const row = catalog.get(c.id.replace(/[a-z]$/, ""));
    const r = results.get(`ours/${c.id}`)!;
    if (r.type !== undefined && r.build !== undefined) twice.push(c.id);
    if (row === undefined) {
      mismatches.push(`${c.id}: no row in MISTAKES.md`);
      continue;
    }
    const pinned = row.status.startsWith("pinned:") && (row.catch === "type" || row.catch === "build");
    if (pinned && r.verdict !== row.catch)
      mismatches.push(`${c.id} (${c.name}): MISTAKES.md pins ${row.catch}, the case is ${r.verdict}`);
    if (!pinned && (r.verdict === "type" || r.verdict === "build"))
      ahead.push(
        `${c.id} (${c.name}): the case is ${r.verdict}; MISTAKES.md says ${row.catch}, "${row.status.slice(0, 60)}…"`,
      );
  }
if (libs.has("ours")) {
  console.log(
    mismatches.length === 0
      ? "\n@reactre/state matches MISTAKES.md on every pinned row."
      : `\n@reactre/state against MISTAKES.md:\n- ${mismatches.join("\n- ")}`,
  );
  if (ahead.length > 0) console.log(`\ncaught, where MISTAKES.md doesn't pin it:\n- ${ahead.join("\n- ")}`);
  // The compiler is only for what types can't check: a case both report is a compiler rule to drop.
  if (twice.length > 0) console.log(`\nreported by both bun check and the compiler: ${twice.join(", ")}`);
}

if (full) {
  const json = {
    libraries: cols,
    cases: CASES.map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group,
      base: c.base,
      results: Object.fromEntries(cols.map((l) => [l.key, results.get(`${l.key}/${c.id}`)])),
    })),
    counts: Object.fromEntries(counts),
  };
  await Bun.write(join(COMPARE, "results", "mistakes.json"), `${JSON.stringify(json, null, 2)}\n`);
  // The same, to read: the counts, then every case in every library, formatted as the repo's docs are.
  const md = join(COMPARE, "results", "mistakes.md");
  await Bun.write(
    md,
    `# Mistakes, made in every library\n\nWritten by \`bun --conditions=development packages/state/compare/mistakes.ts\`; the cases and the checks are in [\`../mistakes/cases.ts\`](../mistakes/cases.ts), and the comparison in [\`../README.md\`](../README.md#1-mistakes-where-each-is-caught).\n\n${totals.join("\n")}\n\n${lines.slice(0, cases.length + 2).join("\n")}\n`,
  );
  Bun.spawnSync([process.execPath, "fmt", md], { stdio: ["ignore", "ignore", "inherit"] });
}
