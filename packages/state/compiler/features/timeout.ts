// timeout's compiler: a state's `timeout` and `onTimeout` compile to a timer resolved at entry, in
// `l` beside delays's (./delays.ts, which it shares `late` with), run by the same runner
// (`r: __run([timeout.r])`). With timeout in use, this writes `l`: delays's timers and its own.
//
// What it checks, that types can't: the timeout is written in place (a number, a duration, a
// delay's name, or a pure function of the data), or is a module-level const or import the compiler
// can read (./delays.ts's `delayOf`, ../values.ts), so the compiler can compile it.

import type { FeatureCompiler } from "../feature.ts";
import { delayOf, late, lateField, lateRunner, timer } from "./delays.ts";

export const timeout: FeatureCompiler = {
  keys: ["timeout", "onTimeout"],
  kinds: { onTimeout: { params: ["data", "state"], moves: true, outside: "a timeout" } },
  shape: () => ({
    machine: ({ local, handler, report, uses }) => {
      // ./delays.ts's machine is made first (table order) and resets `late`.
      late.timeout = local;
      const parts = new Map<string, { delay?: string | null; code?: string | null }>();
      return {
        key: (state, key, value) => {
          const part = parts.get(state) ?? {};
          parts.set(state, part);
          if (key === "onTimeout") part.code = handler(value, "onTimeout");
          else part.delay = delayOf(value, handler, report, `state "${state}"'s timeout`);
        },
        emit: () => {
          // A timeout without onTimeout (or the other way) is a type error: it compiles to nothing.
          for (const [state, { delay, code }] of parts)
            if (delay !== undefined && delay !== null && code !== undefined && code !== null) timer(state, delay, code);
          const l = lateField();
          return l === null ? {} : { fields: [l], ...lateRunner(local, uses("persist")) };
        },
      };
    },
  }),
};
