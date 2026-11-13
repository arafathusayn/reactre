// delays's compiler: `after` keys the core leaves (ISO 8601 durations, setup's delays' names) compile
// to `l` (`{ node: [[delay, handler], ...] }`, a delay being milliseconds or a name), setup's delays
// used by a machine to `w` (milliseconds, or a function of the data, compiled as a handler is), and
// the runner that resolves them at entry (`r: __run([delays.r])`). The core compiles `"5s"`-style keys
// into `a` as before. ./timeout.ts puts a state's `timeout` in `l` too (it shares `late`).
//
// What it checks, that types can't: a delay is written in place (a number, a duration, or a function
// whose body is pure), or is a module-level const or import the compiler can read (../values.ts), so
// the compiler can compile it.

import type { Expression, ObjectProperty, Program } from "oxc-parser";

import type { Emitted, FeatureCompiler, Report } from "../feature.ts";
import { staticValue } from "../values.ts";

// The grammar of a duration, the same the core reads (../index.ts) and the type holds keys to
// (`Duration`'s reading in ../../src/index.ts): digits, an optional fraction, a unit. A key it can't
// read ("-5s", "1e3ms", " 5s", ".5s") is neither a duration nor a delay's name, so it is the type
// checker's to report; read by any other grammar, it would be skipped with no error.
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT: { readonly [unit: string]: number } = { ms: 1, s: 1e3, m: 6e4, h: 36e5 };
const ISO =
  /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const ISO_UNITS = [6048e5, 864e5, 36e5, 6e4, 1e3];

/** A duration's milliseconds: "500ms", "5s", "2m", "1h", or ISO 8601 ("PT1M30S", "P1D"); else null. */
export function duration(text: string): number | null {
  const d = DURATION.exec(text);
  if (d !== null) return Number(d[1]) * (UNIT[d[2] ?? ""] ?? 0);
  const iso = ISO.exec(text);
  if (iso === null || iso.slice(1).every((g) => g === undefined) || text.endsWith("T")) return null;
  return iso.slice(1).reduce((ms, g, i) => ms + Number(g ?? 0) * (ISO_UNITS[i] ?? 0), 0);
}

/**
 * The machine being compiled: its timers resolved at entry, by node (delays' and timeout's), the
 * names of setup's delays they use, and timeout's import when it is in use: then timeout writes `l`.
 */
export const late: { timers: Map<string, string[]>; names: Set<string>; timeout: string | null } = {
  timers: new Map(),
  names: new Set(),
  timeout: null,
};

/** Adds a timer to node `state`'s in `l`. */
export function timer(state: string, delay: string, handler: string): void {
  late.timers.set(state, [...(late.timers.get(state) ?? []), `[${delay}, ${handler}]`]);
}

/** `l`, when some node has a timer resolved at entry. */
export function lateField(): string | null {
  return late.timers.size > 0
    ? `l: { ${[...late.timers].map(([s, list]) => `${JSON.stringify(s)}: [${list.join(", ")}]`).join(", ")} }`
    : null;
}

/**
 * The runner of `l`: the feature's own (`<local>.r`), or with persist in use the one that saves the
 * deadlines, from an import of its own, so an app that never persists ships none of that code.
 */
export function lateRunner(local: string | null, persisted: boolean): Pick<Emitted, "runners" | "imports"> {
  return persisted
    ? {
        runners: ["__reactreStateLateSaved"],
        imports: ['import { __lateSaved as __reactreStateLateSaved } from "@reactre/state/delays/saved";'],
      }
    : { runners: [`${local}.r`] };
}

/**
 * The file being compiled, for the static evaluator (../values.ts): set by the `file` hook, which
 * runs before any machine's, so a delay written as a module-level const or import resolves.
 */
let source: { readonly file: string; readonly program: Program } | null = null;

/** A delay's milliseconds or name, from a number or a string; null when it is neither. */
function delayText(value: number | string): string | null {
  if (typeof value === "number") return String(value);
  const ms = duration(value);
  if (ms !== null) return String(ms);
  late.names.add(value);
  return JSON.stringify(value);
}

/**
 * A delay (setup's, or a timeout): milliseconds, a name (as a string), a module-level const or
 * import holding one, or a function compiled as a `delay` handler. Anything else can't be compiled:
 * a problem saying to write it in place.
 */
export function delayOf(
  value: Expression,
  handler: (value: Expression, kind: string) => string | null,
  report: Report,
  what: string,
): string | null {
  if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") return handler(value, "delay");
  if (value.type === "Literal" && (typeof value.value === "number" || typeof value.value === "string"))
    return delayText(value.value);
  // A const or an import the compiler can read: the same number or string, resolved statically.
  const resolved = source === null ? undefined : staticValue(source.file, source.program, value);
  if (typeof resolved === "number" || typeof resolved === "string") return delayText(resolved);
  report(
    value,
    `${what} is written in place: a number of milliseconds, a duration ("5s", "PT1M30S"), a delay's name, ({ data }) => milliseconds, or a module-level const or import holding one, so the compiler can compile it`,
  );
  return null;
}

/** A property's name, written as a name or a string. */
function nameOf(p: ObjectProperty): string | null {
  if (p.key.type === "Identifier" && !p.computed) return p.key.name;
  return p.key.type === "Literal" && typeof p.key.value === "string" ? p.key.value : null;
}

export const delays: FeatureCompiler = {
  // The core compiles `after`; this compiles the keys it leaves.
  keys: ["after"],
  // The file, for a delay written as a module-level const or import (../values.ts). Runs before
  // any machine's hooks, so `delayOf` has it.
  file: ({ file, program }) => {
    source = { file, program };
  },
  kinds: { delay: { params: ["data", "state"], moves: false } },
  shape: ({ options, local, map }) => {
    // Without the opt-in, setup's delays is a type error: nothing to read.
    const declared = local === null ? new Map<string, ObjectProperty>() : map(options.get("delays")?.value, "delays");
    return {
      machine: ({ handler, report, uses }) => {
        late.timers = new Map();
        late.names = new Set();
        late.timeout = null;
        return {
          key: (state, _key, value) => {
            if (value.type !== "ObjectExpression") return; // the core reports it
            for (const p of value.properties) {
              if (p.type !== "Property") continue;
              const name = nameOf(p);
              if (name === null || DURATION.test(name)) continue;
              const ms = duration(name);
              // Neither a duration nor a delay's name: the type checker reports it.
              if (ms === null && !declared.has(name)) continue;
              const code = handler(p.value, "after");
              if (code === null) continue;
              if (ms === null) late.names.add(name);
              timer(state, ms === null ? JSON.stringify(name) : String(ms), code);
            }
          },
          emit: () => {
            const w = [...late.names].flatMap((name) => {
              const p = declared.get(name);
              const code = p === undefined ? null : delayOf(p.value, handler, report, `delay "${name}"`);
              return code === null ? [] : [`${JSON.stringify(name)}: ${code}`];
            });
            // With timeout in use, it writes `l` (its timers and these) and adds the runner.
            const l = late.timeout === null ? lateField() : null;
            return {
              fields: [...(l === null ? [] : [l]), ...(w.length > 0 ? [`w: { ${w.join(", ")} }`] : [])],
              ...(l !== null && lateRunner(local, uses("persist"))),
            };
          },
        };
      },
    };
  },
};
