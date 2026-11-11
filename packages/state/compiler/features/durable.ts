// durable's compiler: the opt-in in `u`, which `durable(machine, host)` checks at runtime. A machine
// that also runs children (children in use, and a node with `children`) gets the hooks that journal
// them, `dk`, from an import of their own (`Emitted.imports`): a durable run without children ships
// none of that code. The run reads the children themselves from the children feature's `c`.
//
// What it checks in the file, that types can't (they see a number, not what it means):
//   - A host written in place: `schedule(id, at)` gets a deadline, so `at` passed bare as the delay
//     of `setTimeout` (or of a `sleep` or `wait`) waits about 55 years (M562).
//   - A clock (`now`, of a host, `createActor`, `restoreActor` or `processEvent`) in milliseconds of
//     wall time: not divided into seconds (M563), not `performance.now` (M564).
//   - A durable run's `send`, `start`, `resume` and `fire` resolve once the step is saved: a call
//     statement that drops the promise lets the request end before (M565).

import type { CallExpression, Node } from "oxc-parser";

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { boundNames } from "../syntax.ts";
import { calleeName, factsOf, fnOf, fromState, localsOf, propsOf, walkUp } from "./read.ts";

/** Whether `node` is a division by 1000 (or contains one). */
function inSeconds(node: Node): boolean {
  let found = false;
  walkUp(node, (n) => {
    if (n.type === "BinaryExpression" && n.operator === "/" && n.right.type === "Literal" && n.right.value === 1000)
      found = true;
    return !found;
  });
  return found;
}

/** Checks a clock given as `now`: wall time, in milliseconds. */
function checkNow(value: Node, report: FileContext["report"]): void {
  const fn = fnOf(value);
  const body = fn?.body ?? null;
  const performance = (n: Node): boolean => calleeName(n) === "performance.now";
  if (
    performance(value) ||
    (body !== null && body.type !== "BlockStatement" && body.type === "CallExpression" && performance(body))
  )
    report(value, "performance.now isn't wall time: `Date.now`");
  else if (body !== null && inSeconds(body))
    report(value, "`now` gives seconds; the runtime reads milliseconds: `Date.now()`");
}

/** Checks a host written in place: its `schedule` and its `now`. */
function checkHost(host: Node, report: FileContext["report"]): void {
  const props = propsOf(host);
  const now = props.get("now")?.value;
  if (now !== undefined) checkNow(now, report);
  const schedule = fnOf(props.get("schedule")?.value);
  const at = schedule?.params[1];
  if (schedule?.body === null || schedule === null || at?.type !== "Identifier") return;
  walkUp(schedule.body, (node) => {
    if (node.type !== "CallExpression") return true;
    const name = calleeName(node) ?? "";
    const last = name.slice(name.lastIndexOf(".") + 1);
    const delays = last === "setTimeout" ? [node.arguments[1]] : /^(sleep|wait)/i.test(last) ? node.arguments : [];
    if (delays.some((d) => d?.type === "Identifier" && d.name === at.name))
      report(node, `\`${at.name}\` is a time, not a delay: \`setTimeout(…, ${at.name} - Date.now())\``);
    return true;
  });
}

const RUN = new Set(["send", "start", "resume", "fire"]);

function checkFile({ program, report }: FileContext): void {
  const file = factsOf(program);
  const durables = localsOf(file, (s) => s === "@reactre/state/durable", "durable");
  // `now` in the actor's options: createActor(m, { now }), restoreActor(m, s, { now }), processEvent(m, s, e, { now }).
  const clocks = new Map<string, number>();
  for (const [name, index] of [
    ["createActor", 1],
    ["restoreActor", 2],
    ["processEvent", 3],
  ] as const)
    for (const local of localsOf(file, fromState, name)) clocks.set(local, index);
  if (durables.size === 0 && clocks.size === 0) return;
  const isDurable = (n: Node | null | undefined): n is CallExpression =>
    n?.type === "CallExpression" && n.callee.type === "Identifier" && durables.has(n.callee.name);
  // The names a durable run is held in.
  const runs = new Set<string>();
  walkUp(program, (node) => {
    if (node.type === "VariableDeclarator" && isDurable(node.init)) for (const n of boundNames(node.id)) runs.add(n);
    return true;
  });
  walkUp(program, (node) => {
    if (isDurable(node)) {
      const host = node.arguments[1];
      const value = host?.type === "Identifier" ? file.consts.get(host.name) : host;
      if (value !== undefined && value !== null) checkHost(value, report);
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const index = clocks.get(node.callee.name);
      const now = index === undefined ? undefined : propsOf(node.arguments[index]).get("now")?.value;
      if (now !== undefined) checkNow(now, report);
    }
    if (node.type === "ExpressionStatement" && node.expression.type === "CallExpression") {
      const callee = node.expression.callee;
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        const method = callee.property.name;
        const object = callee.object;
        const held = object.type === "Identifier" && runs.has(object.name);
        if (RUN.has(method) && (held || isDurable(object))) {
          const name = object.type === "Identifier" ? object.name : "the run";
          report(node, `\`${name}.${method}\` isn't awaited, so the request ends before it's saved: await it`);
        }
      }
    }
    return true;
  });
}

export const durable: FeatureCompiler = {
  // It reads a node's `children` only to know the machine has some: the children feature compiles them.
  keys: ["children"],
  file: checkFile,
  shape: () => ({
    machine: ({ uses }) => {
      let kids = false;
      return {
        key: () => {
          kids = true;
        },
        emit: () =>
          kids && uses("children")
            ? {
                marker: true,
                fields: ["dk: __reactreStateDurableKids"],
                imports: ['import { __kids as __reactreStateDurableKids } from "@reactre/state/durable/children";'],
              }
            : { marker: true },
      };
    },
  }),
};
