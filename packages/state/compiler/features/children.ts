// children's compiler: setup's `children` (each child machine's expression, as written, in `m`),
// and a node's `children` (their handlers, in `c`), with the feature's runner in the general
// lifecycle (`children.r`). A child spec's `on` (what a logic child sends back) is an object
// literal of handlers, like a node's; `registryKey` is kept as written (its type is a string).
//
// What it checks, that types can't: a send to a child in the step that stops it (M533). A node's
// child runs while the node is active, and stops when the node exits, before the step's effects
// run: `enq.sendTo("upload", ...)` in a handler whose every step leaves the node, or in the node's
// `exit`, reaches no child.

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { stringValue } from "../syntax.ts";
import { factsOf, handlersOf, propsOf } from "./read.ts";

function checkFile({ program, report }: FileContext): void {
  for (const machine of factsOf(program).machines) {
    if (!machine.shape.uses.has("children")) continue;
    // The node each child runs on, by name.
    const runs = new Map<string, string[]>();
    for (const [node, config] of machine.nodes)
      for (const name of propsOf(config.get("children")?.value).keys())
        runs.set(name, [...(runs.get(name) ?? []), node]);
    const inside = (state: string, node: string): boolean => state === node || state.startsWith(`${node}.`);
    for (const { node, kind, handler } of handlersOf(machine)) {
      if (node === null) continue;
      for (const { method, call } of handler.enq) {
        const name = method === "sendTo" ? stringValue(call.arguments[0]) : null;
        if (name === null) continue;
        const stops = (runs.get(name) ?? []).some((n) =>
          kind === "exit"
            ? n === node
            : inside(node, n) &&
              handler.steps.length > 0 &&
              handler.steps.every((s) => s.kind === "to" && s.state !== null && !inside(s.state, n)),
        );
        if (stops)
          report(
            call,
            `sendTo(${JSON.stringify(name)}) as ${JSON.stringify(name)} stops: send it before leaving, or in the child's own exit`,
          );
      }
    }
  }
}

export const children: FeatureCompiler = {
  file: checkFile,
  options: ["children"],
  keys: ["children"],
  kinds: {
    input: { params: ["data", "state"], moves: false },
    // A child's reports reach the parent through the lifecycle's `go`, outside a step.
    childDone: { params: ["data", "output", "state", "key"], moves: true, outside: "a child's done" },
    childError: { params: ["data", "error", "state", "key"], moves: true, outside: "a child's error" },
    childUpdate: { params: ["data", "child", "state", "key"], moves: true, outside: "a child's update" },
    childOn: { params: ["data", "event", "state", "key"], moves: true, outside: "a child's event" },
  },
  shape: ({ options, map, src }) => {
    const machines = new Map<string, string>();
    for (const [name, p] of map(options.get("children")?.value, "children")) machines.set(name, src(p.value));
    return {
      machine: ({ local, handler, literal, properties, uses }) => {
        const kids: string[] = [];
        return {
          key(state, _key, value) {
            const object = literal(value, "children");
            const entries: string[] = [];
            for (const [name, c] of object === null ? [] : properties(object, "children")) {
              const machine = machines.get(name);
              const spec = literal(c.value, `child "${name}"`);
              if (machine === undefined || spec === null) continue; // a name setup lacks is a type error
              const s = properties(spec, `child "${name}"`);
              const fields = [`m: ${machine}`];
              const compiled = (part: string, kind: string): string | null => {
                const v = s.get(part)?.value;
                return v === undefined ? null : handler(v, kind);
              };
              const input = compiled("input", "input");
              const each = compiled("each", "input");
              const done = compiled("done", "childDone");
              const error = compiled("error", "childError");
              const update = compiled("update", "childUpdate");
              if (input !== null) fields.push(`i: ${input}`);
              // `each` gives `{ key, input }`s; the runner takes `[key, input]`s.
              if (each !== null) fields.push(`k: (__d, __s) => (${each})(__d, __s).map((__c) => [__c.key, __c.input])`);
              if (done !== null) fields.push(`d: ${done}`);
              if (error !== null) fields.push(`x: ${error}`);
              if (update !== null) fields.push(`u: ${update}`);
              const on = s.get("on")?.value;
              const handlers = on === undefined ? null : literal(on, `child "${name}"'s on`);
              if (handlers !== null) {
                const list: string[] = [];
                for (const [event, h] of properties(handlers, `child "${name}"'s on`)) {
                  const code = handler(h.value, "childOn");
                  if (code !== null) list.push(`${JSON.stringify(event)}: ${code}`);
                }
                fields.push(`o: { ${list.join(", ")} }`);
              }
              const key = s.get("registryKey")?.value;
              if (key !== undefined) fields.push(`g: ${src(key)}`);
              entries.push(`${JSON.stringify(name)}: { ${fields.join(", ")} }`);
            }
            if (entries.length > 0) kids.push(`${JSON.stringify(state)}: { ${entries.join(", ")} }`);
          },
          emit: () =>
            kids.length > 0
              ? uses("persist")
                ? {
                    fields: [`c: { ${kids.join(", ")} }`],
                    runners: ["__reactreStateChildrenSaved"],
                    imports: [
                      'import { __actorsSaved as __reactreStateChildrenSaved } from "@reactre/state/children/saved";',
                    ],
                    lifecycle: "general",
                  }
                : { fields: [`c: { ${kids.join(", ")} }`], runners: [`${local}.r`], lifecycle: "general" }
              : {},
        };
      },
    };
  },
};
