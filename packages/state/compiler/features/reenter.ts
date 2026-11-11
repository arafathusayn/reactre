// reenter's compiler: `reenter(state, data)` becomes `({ r: <to(state, data)'s step> })`, with the
// graph that marks such a move (`g: reenter.g(...)`) and the lifecycle's question
// (`re: reenter.re`). The state must be written in place to compile, and the data's keys are
// checked as `to`'s are.
//
// What it checks across a node, that types can't: an event of a leaf whose task writes (a fetch
// that isn't a GET) reentering that leaf restarts the write: the request already sent is aborted,
// and another is sent (M478). Decline the event there, or keep the running task.

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { stringValue } from "../syntax.ts";
import { argNames, calleeName, factsOf, fnOf, propsOf, walkUp } from "./read.ts";

/** The method of the first fetch a task's run sends that isn't a GET, or null. */
function writes(run: ReturnType<typeof fnOf>): string | null {
  let method: string | null = null;
  if (run?.body !== null && run !== null)
    walkUp(run.body, (node) => {
      if (method !== null || node.type !== "CallExpression" || calleeName(node) !== "fetch") return method === null;
      const m = stringValue(propsOf(node.arguments[1]).get("method")?.value)?.toUpperCase();
      if (m !== undefined && m !== "GET" && m !== "HEAD") method = m;
      return true;
    });
  return method;
}

function checkFile({ program, report }: FileContext): void {
  for (const machine of factsOf(program).machines) {
    if (!machine.shape.uses.has("reenter")) continue;
    for (const [node, config] of machine.nodes) {
      const method = writes(fnOf(propsOf(config.get("task")?.value).get("run")?.value));
      if (method === null) continue;
      for (const [event, p] of propsOf(config.get("on")?.value)) {
        const fn = fnOf(p.value);
        const reenterName = fn === null ? undefined : argNames(fn).get("reenter");
        if (fn?.body === null || fn === null || reenterName === undefined) continue;
        walkUp(fn.body, (n) => {
          if (
            n.type === "CallExpression" &&
            n.callee.type === "Identifier" &&
            n.callee.name === reenterName &&
            stringValue(n.arguments[0]) === node
          )
            report(
              n,
              `\`${event}\` restarts the ${method} in ${JSON.stringify(node)}: decline it there (or keep the running one)`,
            );
          return true;
        });
      }
    }
  }
}

export const reenter: FeatureCompiler = {
  moves: ["reenter"],
  file: checkFile,
  shape: () => ({
    machine: ({ local, src }) => {
      let used = false;
      return {
        move(call, { checkKeys, report, step }) {
          const [stateArg, dataArg] = call.arguments;
          const state = stateArg?.type === "Literal" && typeof stateArg.value === "string" ? stateArg.value : null;
          if (state === null) {
            report(
              stateArg ?? call,
              "reenter's first argument is a state's name written in place: reenter(\"loading\", ...)",
            );
            return "null";
          }
          used = true;
          // In parentheses: an arrow's body that starts with `{` would be a block.
          if (dataArg === undefined) return `({ r: ${step(state, "{}")} })`;
          if (dataArg.type === "SpreadElement") return "null"; // a type error: a spread argument isn't a tuple
          checkKeys(dataArg, `state "${state}"'s data`);
          return `({ r: ${step(state, src(dataArg))} })`;
        },
        emit: () =>
          used
            ? { fields: [`re: ${local}.re`], graph: (inner) => `${local}.g(${inner ?? ""})`, lifecycle: "general" }
            : {},
      };
    },
  }),
};
