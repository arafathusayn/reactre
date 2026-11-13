// The compiler's rules over tests of a machine: what a model-based test drives, and the clock it
// runs on. Each type-checks, and each makes a test pass (or fail) for a reason other than the
// machine. On ./usesites.ts's context.
//   - M608: a `sut.create` that makes an actor of the machine under test: the machine against itself.
//   - M609: fake timers (or a SimulatedClock) installed after an actor: its first timers are on the real clock.
//   - M610: a SimulatedClock whose `now` reaches no actor: deadlines read Date.now while it fires timers.
//   - M611: a SimulatedClock never uninstalled: the global setTimeout stays replaced for later tests.

import type { Node } from "oxc-parser";

import { isFunction, keyName, walk } from "./syntax.ts";
import { has, libraryCall, type SiteContext } from "./usesites.ts";

/** A property of an object literal written in place, by name. */
function property(object: Node | undefined, name: string): Node | null {
  if (object?.type !== "ObjectExpression") return null;
  for (const p of object.properties) if (p.type === "Property" && keyName(p) === name) return p.value;
  return null;
}

export function checkTesting(ctx: SiteContext): void {
  const { program, report } = ctx;
  const makes = (n: Node): boolean => ["createActor", "restoreActor"].includes(libraryCall(ctx, n) ?? "");
  const clocks = new Set(
    [...ctx.imports].flatMap(([local, b]) =>
      b.imported === "SimulatedClock" && b.source.startsWith("@reactre/state") ? [local] : [],
    ),
  );
  /** `new SimulatedClock()`, or `vi.useFakeTimers()` (jest's, bun's). */
  const fakes = (n: Node): boolean =>
    (n.type === "NewExpression" && n.callee.type === "Identifier" && clocks.has(n.callee.name)) ||
    (n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.name === "useFakeTimers");

  walk(program, (node) => {
    // M608: the machine under test driven as its own implementation always agrees with itself.
    const walker = libraryCall(ctx, node);
    if ((walker === "testPaths" || walker === "propertyTest") && node.type === "CallExpression") {
      const [machine, options] = node.arguments;
      const create = property(property(options, "sut") ?? undefined, "create");
      if (machine?.type === "Identifier" && create !== null && isFunction(create))
        walk(create, (n) => {
          const first = n.type === "CallExpression" ? n.arguments[0] : undefined;
          if (makes(n) && first?.type === "Identifier" && first.name === machine.name)
            report(
              n,
              `sut.create makes an actor of ${machine.name}, the machine under test, so the test compares the machine with itself and always passes: drive the system under test (the component, the store, the API) in create`,
            );
          return true;
        });
    }

    // M609: in each list of statements, fake timers after an actor.
    const list = node.type === "Program" || node.type === "BlockStatement" ? node.body : null;
    let made = false;
    for (const statement of list ?? []) {
      if (made && has(statement, fakes, true))
        walk(statement, (n) => {
          if (fakes(n))
            report(
              n,
              "fake timers installed after the actor: its start state's timers are already on the real clock. Install them first, then create the actor",
            );
          return !isFunction(n);
        });
      made ||= has(statement, makes, true);
    }

    // M610: a SimulatedClock nothing gives its now to.
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init !== null && fakes(node.init)) {
      const clock = node.id.name;
      let reaches = false;
      walk(program, (n, parent, key) => {
        if (n.type !== "Identifier" || n.name !== clock || n === node.id) return !reaches;
        const method =
          parent?.type === "MemberExpression" &&
          key === "object" &&
          !parent.computed &&
          parent.property.type === "Identifier"
            ? parent.property.name
            : null;
        reaches = method === null || method === "now";
        return !reaches;
      });
      if (!reaches)
        report(
          node.init,
          `the SimulatedClock fires timers, but no actor reads its time: their deadlines read Date.now. Pass its now to the actor, createActor(machine, { now: ${clock}.now })`,
        );
    }
    return true;
  });

  // M611: a SimulatedClock replaces the global timers until it is uninstalled.
  const uninstalled = has(
    program,
    (n) =>
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.name === "uninstall",
  );
  if (!uninstalled)
    walk(program, (n) => {
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && clocks.has(n.callee.name))
        report(
          n,
          "the SimulatedClock replaces the global setTimeout until it is uninstalled, and nothing in this file does: later tests run on it. Call clock.uninstall() when the test ends (in an afterEach)",
        );
      return true;
    });
}
