// logic's compiler: nothing of its own to compile. Actor logic is built at runtime
// (`createAsyncLogic(...)` returns a table), and a node runs it as any child: children's compiler
// compiles its spec, `error` and `on` included (./children.ts). The opt-in only types setup's
// children that are logic.
//
// What it checks, in the file's `create*Logic` calls, that types can't (what their functions do):
//   - Callback logic: no `throw` in a `receive` listener, which stops the child (M531).
//   - Observable logic: a `catchError` that drops its error for `EMPTY` or `of(...)` ends the child
//     in `done`, so its `error` never runs (M544).
//   - Step logic: `run` is a reducer, held to a transition's rules: it mutates nothing, and reads
//     no clock (M547).
//   - Async logic with steps (`enq.step(key, exec)`, journaled by key): a key repeated in a loop or
//     used twice (M539), a key from the clock (M540), and outside the steps, a clock read (M542) or
//     a write by fetch (M543), which a replay doesn't see or does again.

import type { CallExpression, Node } from "oxc-parser";

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { boundNames, isFunction, rootName, stringValue } from "../syntax.ts";
import {
  argNames,
  calleeName,
  chance,
  factsOf,
  type Fn,
  fnOf,
  fromState,
  inLoop,
  inTry,
  localsOf,
  propsOf,
  walkUp,
} from "./read.ts";

const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

/** A key written in place: a string, or a template with nothing in it. */
function constantKey(node: Node | undefined): string | null {
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return stringValue(node);
}

function checkCallback(fn: Fn, report: FileContext["report"]): void {
  const receive = argNames(fn).get("receive");
  if (receive === undefined || fn.body === null) return;
  walkUp(fn.body, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== receive)
      return true;
    const listener = fnOf(node.arguments[0]);
    if (listener?.body === null || listener === null) return true;
    const body = listener.body;
    walkUp(body, (n, ancestors) => {
      if (n !== body && isFunction(n)) return false;
      if (n.type === "ThrowStatement" && !inTry(ancestors, n))
        report(n, "a throw in `receive` stops the child: `sendBack` a failure event");
      return true;
    });
    return false;
  });
}

function checkObservable(fn: Fn, report: FileContext["report"], src: FileContext["src"]): void {
  if (fn.body === null) return;
  walkUp(fn.body, (node) => {
    if (node.type !== "CallExpression" || !(calleeName(node) ?? "").split(".").includes("catchError")) return true;
    const handler = fnOf(node.arguments[0]);
    if (handler === null || handler.body === null) return true;
    const param = handler.params[0];
    const names = param === undefined ? [] : boundNames(param);
    let used = false;
    walkUp(handler.body, (n) => {
      if (n.type === "Identifier" && names.includes(n.name)) used = true;
      return true;
    });
    if (used) return true;
    const result =
      handler.body.type === "BlockStatement"
        ? handler.body.body.find((s) => s.type === "ReturnStatement")?.argument
        : handler.body;
    const returned =
      result?.type === "Identifier" && result.name === "EMPTY"
        ? "EMPTY"
        : result?.type === "CallExpression" && result.callee.type === "Identifier" && result.callee.name === "of"
          ? `${src(result.callee)}(…)`
          : null;
    if (returned !== null)
      report(node, `catchError returns ${returned}, so the failure looks like completion: send a failure event`);
    return true;
  });
}

function checkStep(fn: Fn, report: FileContext["report"]): void {
  const context = argNames(fn).get("context");
  if (fn.body === null) return;
  let mutates: Node | null = null;
  let clock: Node | null = null;
  walkUp(fn.body, (node) => {
    if (chance(node)?.clock === true) clock ??= node;
    if (context === undefined) return true;
    // `delete` needs an optional member, which a step's context can't have: the type's.
    const target =
      node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : null;
    if (target?.type === "MemberExpression" && rootName(target) === context) mutates ??= node;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      MUTATORS.has(node.callee.property.name) &&
      rootName(node.callee.object) === context
    )
      mutates ??= node;
    return true;
  });
  if (mutates !== null && clock !== null)
    report(
      mutates,
      "step logic's run mutates `context` and reads the clock: return the new context, and pass the time in the event",
    );
  else if (mutates !== null)
    report(mutates, "step logic's run mutates `context`: return the new context, `{ ...context, field }`");
  else if (clock !== null) report(clock, "step logic's run reads the clock: pass the time in the event");
}

function checkAsync(fn: Fn, report: FileContext["report"], src: FileContext["src"]): void {
  const second = fn.params[1];
  const enq = second?.type === "Identifier" ? second.name : null;
  const body = fn.body;
  if (enq === null || body === null) return;
  const steps: { readonly call: CallExpression; readonly loop: boolean }[] = [];
  walkUp(body, (node, ancestors) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === enq &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "step"
    )
      steps.push({ call: node, loop: inLoop(ancestors, body) });
    return true;
  });
  if (steps.length === 0) return;
  const keys = new Map<string, number>();
  const execs = new Set<Node>();
  for (const { call, loop } of steps) {
    const keyNode = call.arguments[0];
    const exec = call.arguments[1];
    if (exec !== undefined) execs.add(exec);
    if (keyNode !== undefined) execs.add(keyNode);
    const key = constantKey(keyNode);
    if (key !== null && loop)
      report(
        call,
        `the step key ${JSON.stringify(key)} repeats in the loop, so the journal replays the first result: put the id in the key`,
      );
    else if (key !== null && keys.has(key))
      report(
        call,
        `the step key ${JSON.stringify(key)} is used twice, so the second replays the first's result: give each step its own key`,
      );
    if (key !== null) keys.set(key, (keys.get(key) ?? 0) + 1);
    if (keyNode !== undefined && key === null)
      walkUp(keyNode, (node) => {
        const read = chance(node);
        if (read !== null) report(node, `a step's key from ${read.what} changes on replay: derive it from data`);
        return read === null;
      });
  }
  // The names the steps read (in their keys and execs): a value from outside that feeds a step.
  const fed = new Set<string>();
  for (const e of execs)
    walkUp(e, (node) => {
      if (node.type === "Identifier") fed.add(node.name);
      return true;
    });
  // A read decides a branch (it is in a condition's test) or feeds a step (a const a step reads).
  const matters = (ancestors: readonly Node[], node: Node): boolean =>
    [...ancestors, node].some((a, i, chain) => {
      const next = chain[i + 1];
      if (next === undefined) return false;
      if (a.type === "IfStatement" || a.type === "ConditionalExpression" || a.type === "WhileStatement")
        return a.test === next;
      return a.type === "VariableDeclarator" && a.init === next && boundNames(a.id).some((n) => fed.has(n));
    });
  // Outside the steps (their keys and execs): what a replay reads again, or does again.
  walkUp(body, (node, ancestors) => {
    if (execs.has(node)) return false;
    const read = chance(node);
    if (read !== null && matters(ancestors, node)) {
      report(
        node,
        read.clock
          ? "a clock read outside a step changes on replay: read it in `enq.step`"
          : `${read.what} outside a step changes on replay: call it in \`enq.step\``,
      );
      return false;
    }
    if (node.type === "CallExpression" && calleeName(node) === "fetch") {
      const options = propsOf(node.arguments[1]);
      const method = stringValue(options.get("method")?.value)?.toUpperCase();
      const keyed = /idempotency-key/i.test(src(options.get("headers")?.value ?? node));
      if (method !== undefined && method !== "GET" && method !== "HEAD" && !keyed)
        report(node, `a ${method} outside \`enq.step\` runs again on replay: put it in a step`);
    }
    return true;
  });
}

function checkFile({ program, report, src }: FileContext): void {
  const file = factsOf(program);
  const from = (s: string): boolean => fromState(s);
  const kinds = new Map<string, string>();
  for (const kind of [
    "createCallbackLogic",
    "createObservableLogic",
    "createEventObservableLogic",
    "createStepLogic",
    "createAsyncLogic",
  ])
    for (const local of localsOf(file, from, kind)) kinds.set(local, kind);
  if (kinds.size === 0) return;
  walkUp(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return true;
    const kind = kinds.get(node.callee.name);
    const arg = node.arguments[0];
    if (kind === "createCallbackLogic" || kind === "createObservableLogic" || kind === "createEventObservableLogic") {
      const fn = fnOf(arg);
      if (fn !== null) kind === "createCallbackLogic" ? checkCallback(fn, report) : checkObservable(fn, report, src);
    }
    const run = fnOf(propsOf(arg).get("run")?.value);
    if (kind === "createStepLogic" && run !== null) checkStep(run, report);
    if (kind === "createAsyncLogic" && run !== null) checkAsync(run, report, src);
    return true;
  });
}

export const logic: FeatureCompiler = { file: checkFile };
