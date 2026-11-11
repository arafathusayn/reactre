// The codemod: XState v4-style, v5 and v6 machines rewritten as @reactre/state machines.
//
//   bun packages/state/codemod/index.ts <files…> [--write]
//
// Each file's machines (`createMachine(...)`, `setup(...).createMachine(...)`) become a shape
// (`setup({ states, events })`) and a machine (`shape.machine({ start, states })`). The result goes
// next to the source as `<name>.state.ts`, or in place with `--write`. A report lists what was
// converted and every TODO, with its line: what the codemod can't convert stays in the output as a
// `// TODO(@reactre/state): …` comment at its spot. Nothing is dropped silently.
//
// What maps to what:
//   - The shared context becomes each leaf's data, narrowed per state when the source proves which
//     fields a state needs (see ./analyze.ts); otherwise each state keeps the whole context.
//   - Nested states become dotted leaves; `initial` resolves to a leaf. Parallel states become
//     `parallel: [...]`, entered with `to(P, { region: to(...) })`. History becomes
//     `back(parent, to(default))`. Final states become `final: true`.
//   - Every transition form (a string, `{ target, guard | cond, actions: assign(...) }`, an array
//     of guarded ones, a v6 function returning `{ target, context }`) becomes a function returning
//     `to(...)` or `null`. A stay (a targetless transition, or one to its own state) in a state
//     with a task or timer is `keep(...)`, which leaves them running as XState did; `reenter: true`
//     to its own state is `reenter(...)`. Named guards from setup are inlined when they are pure
//     functions in the same file.
//   - `after` becomes durations ("5s"); `invoke` of `fromPromise`/`createAsyncLogic` becomes a task
//     whose result is the internal event `<id>Done` carrying `output`; `invoke` of a machine
//     becomes `children`.
//   - Effects become the opt-ins that have them, listed in setup's `use` and imported: `entry`,
//     `exit` and actions (`raise`, `sendTo`, `log`, `cancel`, inline functions) become `enq` calls
//     (effects); named actions setup's `actions` (provide); `emit` (emit); `spawnChild` and
//     `stopChild` (spawn); `always` (always); tags, meta and description (tags); a compound
//     state's `onDone` (output); computed delays (delays); `timeout` (timeout); `fromCallback`
//     (logic); `reenter: true` (reenter); `"*"` handlers (wildcards). What has no counterpart is a
//     TODO naming the closest form.
//   - Mirrored states (siblings with the same data and handlers, their names differing by a flag:
//     `approved_by_manager`, `approved_by_director`) stay as they are, so the machine replays the
//     same and the app's reads of their names still hold. Merging them is a TODO with the
//     compiler's fix, right above the first, which the compiler takes (../compiler/mirror.ts).

import { dirname, resolve } from "node:path";

import { parseSync } from "oxc-parser";
import type { Node, ObjectProperty } from "oxc-parser";

import { normalize } from "../compiler/hash.ts";
import { MIRROR_TODO, type Mirrored, mirrored } from "../compiler/mirror.ts";
import { analyze } from "./analyze.ts";
import { apply, type Edit, isReference, lineOf, prop, props, walk } from "./ast.ts";
import { emitMachine, FEATURES, freeNames, oneLine } from "./emit.ts";
import type { Todo } from "./model.ts";
import { findMachines, readMachine, readModule } from "./read.ts";

/** One line of the report. */
export interface ReportEntry {
  /** The line in the XState source. */
  readonly line: number;
  readonly message: string;
  /** Something to fix by hand: it is also a TODO comment in the output. */
  readonly todo: boolean;
}

export interface ConvertOptions {
  /** Format the output with `bun fmt` (the default). */
  readonly format?: boolean;
}

/** XState names the output no longer needs. */
const CONSUMED = new Set([
  "createMachine",
  "setup",
  "assign",
  "types",
  "fromPromise",
  "createAsyncLogic",
  "and",
  "or",
  "not",
  "stateIn",
  "raise",
  "sendTo",
  "sendParent",
  "forwardTo",
  "log",
  "emit",
  "cancel",
  "enqueueActions",
  "spawnChild",
  "stopChild",
]);

/** Converts the XState machines in one file. The code is unchanged when there are none. */
export function convert(
  file: string,
  source: string,
  options: ConvertOptions = {},
): { readonly code: string; readonly report: readonly ReportEntry[] } {
  // Stately's JSON export is the machine's config alone: it is read as `createMachine(<the JSON>)`
  // under an import (the report's lines are the JSON's, two up), and named after its id.
  if (file.endsWith(".json")) {
    let id: unknown = null;
    try {
      const parsed: unknown = JSON.parse(source);
      id = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "id") : null;
    } catch {
      return { code: source, report: [{ line: 1, message: "doesn't parse as JSON", todo: true }] };
    }
    const words = (typeof id === "string" ? id : "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    const stem = words
      .map((w, i) => (i === 0 ? w.toLowerCase() : `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`))
      .join("");
    const name = /^[A-Za-z]/.test(stem) ? `${stem}Machine` : "machine";
    const wrapped = `import { createMachine } from "xstate";\n\nexport const ${name} = createMachine(${source.trimEnd()});\n`;
    const out = convert(file.replace(/\.json$/, ".ts"), wrapped, options);
    return { code: out.code, report: out.report.map((r) => ({ ...r, line: Math.max(1, r.line - 2) })) };
  }
  const lang = file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : file.endsWith(".js") ? "js" : "ts";
  const parsed = parseSync(file, source, { lang, sourceType: "module", preserveParens: false });
  if (parsed.errors.length > 0)
    return {
      code: source,
      report: [{ line: 1, message: `doesn't parse: ${parsed.errors[0]?.message ?? ""}`, todo: true }],
    };
  const mod = readModule(source, parsed.program);
  const todos: Todo[] = [];
  const calls = findMachines(mod, todos);
  if (calls.length === 0 && todos.length === 0) return { code: source, report: [] };
  const notes: { at: number; message: string }[] = [];

  const edits: Edit[] = [];
  /** The opt-ins the machines use: each is imported from its own entry. */
  const features = new Map<string, Set<string>>();
  const removed = new Set<Node>();
  const rewritten = new Set<Node>();
  // The shape's name is used only by its machine: no other name in the file (a parameter too) has it.
  const taken = new Set<string>([...mod.env.constants, ...mod.env.mutable]);
  walk(parsed.program, (n, parent, k) => {
    if (n.type === "Identifier" && isReference(parent, k)) taken.add(n.name);
    return true;
  });
  for (const call of calls) {
    const model = readMachine(mod, call);
    for (const s of model.stubs.values()) taken.add(s.name);
    const machineTodos: Todo[] = [...model.todos];
    const an = analyze(model, machineTodos);
    let shape =
      call.name.endsWith("Machine") && call.name.length > "Machine".length
        ? call.name.slice(0, -7)
        : `${call.name}Shape`;
    while (taken.has(shape)) shape = `${shape}Shape`;
    taken.add(shape);
    const emitted = emitMachine({ ...model, todos: machineTodos }, an, shape, machineTodos);
    // Mirrored states (../compiler/mirror.ts) stay as XState had them: each is a TODO with the fix,
    // in the report and right above the first of them.
    const noted = noteMirrored(file, emitted.text);
    for (const m of noted.mirrored) {
      const node = an.leaves.find((l) => l.name === m.states[0]);
      todos.push({ at: node?.at ?? call.call.start, message: m.message });
    }
    const out = { ...emitted, text: noted.text };
    for (const [f, names] of out.imports) {
      const set = features.get(f) ?? new Set<string>();
      for (const n of names) set.add(n);
      features.set(f, set);
    }
    edits.push({ start: call.statement.start, end: call.statement.end, text: out.text });
    if (call.setupStatement !== null && !removed.has(call.setupStatement)) {
      removed.add(call.setupStatement);
      edits.push({ start: call.setupStatement.start, end: call.setupStatement.end, text: "" });
    }
    for (const def of model.logic.values()) {
      if (rewritten.has(def.call)) continue;
      rewritten.add(def.call);
      // Actor logic kept as a call: only its callee (and type arguments) change.
      if (def.callee !== null) {
        edits.push({ start: def.callee.start, end: def.callee.end, text: def.callee.text });
        // Its TODO is in the cleanup it adds, outside the machine: only the report gets it here.
        if (def.cleanup !== null) {
          edits.push(def.cleanup);
          todos.push(def.cleanup.todo);
        }
        continue;
      }
      let fnText = source.slice(def.fn.start, def.fn.end);
      const first = def.fn.params[0];
      if (def.annotation !== null && first !== undefined) {
        const at = first.end - def.fn.start;
        fnText = `${fnText.slice(0, at)}: ${def.annotation}${fnText.slice(at)}`;
      }
      edits.push({ start: def.call.start, end: def.call.end, text: fnText });
    }
    todos.push(...machineTodos);
    const states = an.leaves.length;
    notes.push({
      at: call.call.start,
      message: `${call.name}: ${states} state${states === 1 ? "" : "s"}, ${model.events.size} event${model.events.size === 1 ? "" : "s"}${
        out.internal.length > 0 ? `, internal ${out.internal.join(", ")}` : ""
      }; ${an.whole ? "each state keeps the whole context" : "the context is narrowed to each state's data"}`,
    });
    for (const e of model.unhandled)
      notes.push({
        at: call.call.start,
        message: `event "${e}" is declared but no state handles it: left out of events (sending it is now a type error)`,
      });
    notes.push(...model.notes);
  }
  // A `// @ts-nocheck` (which a Stately export pasted into a strict project often needs, for its
  // stubs' unused parameters) goes: the compiler refuses suppressions in a file with machines.
  const nocheck = /^[ \t]*\/\/[ \t]*@ts-nocheck\b[^\n]*\n?/m.exec(source);
  if (nocheck !== null && calls.length > 0) {
    edits.push({ start: nocheck.index, end: nocheck.index + nocheck[0].length, text: "" });
    notes.push({
      at: nocheck.index,
      message:
        "// @ts-nocheck is removed: @reactre/state's compiler refuses a suppression in a file with machines, and the output type-checks",
    });
  }

  // Imports: XState's become @reactre/state's; names still used stay imported from XState.
  const [first, ...others] = mod.imports;
  if (first !== undefined) {
    for (const o of others) edits.push({ start: o.start, end: o.end, text: "" });
    edits.push({ start: first.start, end: first.end, text: "__reactreStateImports__" });
  }
  // Types only the machines used (`createMachine<Context, Event>`, `types: {} as { context: Ctx }`)
  // are gone with them: remove the ones nothing reads any more.
  const draft = apply(source, 0, source.length, edits);
  for (const top of parsed.program.body) {
    if (top.type !== "TSTypeAliasDeclaration" && top.type !== "TSInterfaceDeclaration") continue;
    const name = top.id.name;
    const declaration = source.slice(top.start, top.end);
    const count = (text: string): number => text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
    const inMachines = calls.some((c) => count(source.slice(c.statement.start, c.statement.end)) > 0);
    if (inMachines && count(draft) - count(declaration) === 0) {
      const end = /^\r?\n/.exec(source.slice(top.end)) === null ? top.end : top.end + 1;
      edits.push({ start: top.start, end, text: "" });
    }
  }
  let code = apply(source, 0, source.length, edits);
  const used = new Set<string>();
  const body = parseSync(file, code.replace("__reactreStateImports__", ""), { lang, sourceType: "module" });
  walk(body.program, (n) => {
    if (n.type === "ImportDeclaration") return false;
    if (n.type === "Identifier") used.add(n.name);
    return true;
  });
  const kept = [...mod.xstate].filter(([local, imported]) => !CONSUMED.has(imported) && used.has(local));
  const ours = ["setup", "types"].filter((n) => freeNames(code).has(n) || used.has(n));
  const lines = [
    `import { ${ours.join(", ")} } from "@reactre/state";`,
    ...FEATURES.filter((f) => features.has(f)).map(
      (f) => `import { ${[...(features.get(f) ?? [f])].join(", ")} } from "@reactre/state/${f}";`,
    ),
  ];
  if (kept.length > 0 && first !== undefined) {
    const names = kept.map(([l]) => l);
    const actorApi = names.some((n) => ["createActor", "interpret", "getNextSnapshot", "waitFor"].includes(n));
    const message = `${names.join(", ")} ${names.length === 1 ? "is" : "are"} still imported from XState, for code the codemod didn't convert: ${
      actorApi ? "use @reactre/state's createActor, transition and restoreActor, then" : "replace what uses it, then"
    } remove this import`;
    todos.push({ at: first.start, message });
    lines.push(
      `// TODO(@reactre/state): ${message}`,
      `import { ${kept.map(([l, i]) => (l === i ? l : `${i} as ${l}`)).join(", ")} } from ${JSON.stringify(first.source.value)};`,
    );
  }
  code = code.replace("__reactreStateImports__", lines.join("\n"));
  if (options.format !== false) code = format(file, code);

  const report: ReportEntry[] = [
    ...notes.map((n) => ({ line: lineOf(source, n.at), message: n.message, todo: false })),
    ...dedupe(todos).map((t) => ({ line: lineOf(source, t.at), message: oneLine(t.message), todo: true })),
  ].sort((a, b) => a.line - b.line || Number(a.todo) - Number(b.todo));
  return { code, report };
}

/**
 * A converted machine's mirrored states (../compiler/mirror.ts), found in the output (`setup({ states })`
 * and `shape.machine({ states })`, as the compiler reads them), and the output with the fix as a
 * TODO right above the first of each: the compiler takes that note (`MIRROR_TODO`), so the machine
 * still builds and replays as XState's did.
 */
function noteMirrored(file: string, text: string): { readonly text: string; readonly mirrored: readonly Mirrored[] } {
  const { program } = parseSync(file, text, { lang: /x$/.test(file) ? "tsx" : "ts", sourceType: "module" });
  const contracts = new Map<string, string>();
  const configs = new Map<string, ObjectProperty>();
  const src = (node: Node): string => text.slice(node.start, node.end);
  walk(program, (n) => {
    if (n.type !== "CallExpression") return true;
    const states = prop(n.arguments[0], "states");
    if (states?.type !== "ObjectExpression") return true;
    const setup = n.callee.type === "Identifier" && n.callee.name === "setup";
    for (const [name, p] of props(states))
      if (setup) contracts.set(name, normalize(src(p.value)));
      else if (p.value.type === "ObjectExpression" && !props(p.value).has("final")) configs.set(name, p);
    return true;
  });
  const found = mirrored(configs, contracts, new Set([...contracts.keys(), ...configs.keys()]), src);
  const edits = found.map((m) => {
    const line = text.lastIndexOf("\n", m.at.start - 1) + 1;
    const indent = text.slice(line, m.at.start);
    const start = indent.trim() === "" ? line : m.at.start;
    return { start, end: start, text: `${indent.trim() === "" ? indent : ""}// ${MIRROR_TODO}${m.message}\n` };
  });
  return { text: apply(text, 0, text.length, edits), mirrored: found };
}

function dedupe(todos: readonly Todo[]): Todo[] {
  const seen = new Set<string>();
  return todos.filter((t) => {
    const k = `${t.at}:${t.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The code as `bun fmt` writes it, with the repository's settings; unchanged if that fails. */
function format(file: string, code: string): string {
  const path = resolve(file);
  const result = Bun.spawnSync([process.execPath, "fmt", "--stdin-filepath", path], {
    stdin: new TextEncoder().encode(code),
    cwd: dirname(path),
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : code;
}

/** The report as the CLI prints it. */
export function printReport(file: string, report: readonly ReportEntry[]): string {
  return report.map((r) => `${file}:${r.line}: ${r.todo ? "TODO " : ""}${r.message}`).join("\n");
}

/**
 * The CLI, with its arguments (`<files…> [--write]`): converts each file, writes the output and
 * prints the reports to `out`, a usage line to `err`. Returns the exit code.
 */
export async function main(
  args: readonly string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const write = args.includes("--write");
  const files = args.filter((a) => a !== "--write");
  if (files.length === 0) {
    err("usage: bun packages/state/codemod/index.ts <files…> [--write]");
    return 1;
  }
  let todos = 0;
  for (const file of files) {
    const source = await Bun.file(file).text();
    const { code, report } = convert(file, source);
    todos += report.filter((r) => r.todo).length;
    if (code !== source) {
      // A JSON export becomes TypeScript: `<name>.state.ts`, also with --write.
      const target = file.endsWith(".json")
        ? file.replace(/\.json$/, ".state.ts")
        : write
          ? file
          : file.replace(/(\.[cm]?[jt]sx?)$/, ".state$1");
      await Bun.write(target, code);
      out(`${file} -> ${target}`);
    } else out(`${file}: no XState machine`);
    if (report.length > 0) out(printReport(file, report));
  }
  out(`${todos} TODO${todos === 1 ? "" : "s"}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
