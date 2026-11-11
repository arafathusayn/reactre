// spawn's compiler: a machine that records effects gets the machines `enq.spawn` may start (`sp`:
// setup's `children`, as written), spawn's runners in its dispatcher (`effects.d([..., spawn.q])`),
// and the lifecycle wrap that keeps the actor's options for them (`r: spawn.w(inner)`), or, with
// persist in use, the one that also restores them (`r: __reactreStateSpawnRestore(inner)`, from
// @reactre/state/spawn/restore: an app that never persists ships none of it). `enq.spawn` itself
// comes from effects's `enq` (`effects.w([spawn])`, ./effects.ts). A machine that records nothing
// gets none of it, so listing spawn costs it nothing.
//
// Names, keys, inputs and report events are typed (`EnqBy`). What types can't see is how a
// machine's calls go together: when every spawn of a name passes a key, a stop, subscribeTo or
// listen of it without one reaches none of them (M536); and in one handler, a subscribeTo or listen
// before the spawn it waits for finds no child yet (M537).

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { stringValue } from "../syntax.ts";
import { recorded } from "./effects.ts";
import { factsOf, handlersOf, optionsOf } from "./read.ts";

/** Where each method takes its key: the options' index (its `key`), or the argument's (stop's). */
const KEYED: { readonly [method: string]: { readonly index: number; readonly option: boolean } } = {
  spawn: { index: 1, option: true },
  stop: { index: 1, option: false },
  subscribeTo: { index: 1, option: true },
  listen: { index: 3, option: true },
};

/** The fix for a call of `method` without a key: `%` is the child's name. */
const BY_KEY: { readonly [method: string]: string } = {
  stop: "stop it by key, `enq.stop(%, key)`",
  subscribeTo: "subscribe by key, `enq.subscribeTo(%, { key, ... })`",
  listen: "listen by key, `enq.listen(%, type, as, { key })`",
};

function checkFile({ program, report, src }: FileContext): void {
  for (const machine of factsOf(program).machines) {
    if (!machine.shape.uses.has("spawn")) continue;
    const calls = handlersOf(machine).map(({ handler }) =>
      handler.enq.flatMap(({ method, call }) => {
        const name = stringValue(call.arguments[0]);
        const where = method === null ? undefined : KEYED[method];
        if (method === null || where === undefined || name === null) return [];
        const arg = call.arguments[where.index];
        const key = where.option ? optionsOf(call, where.index).get("key")?.value : arg;
        return [{ method, name, call, key: key === undefined ? null : src(key) }];
      }),
    );
    const all = calls.flat();
    for (const { method, name, call, key } of all) {
      const fix = BY_KEY[method];
      const spawns = all.filter((c) => c.method === "spawn" && c.name === name);
      if (fix !== undefined && key === null && spawns.length > 0 && spawns.every((c) => c.key !== null))
        report(call, `every ${JSON.stringify(name)} is spawned with a key: ${fix.replace("%", JSON.stringify(name))}`);
    }
    for (const list of calls)
      for (const [i, { method, name, call, key }] of list.entries()) {
        if (method !== "subscribeTo" && method !== "listen") continue;
        const spawned = (c: (typeof list)[number]): boolean => c.method === "spawn" && c.name === name && c.key === key;
        if (!list.slice(0, i).some(spawned) && list.slice(i + 1).some(spawned))
          report(call, `${method}(${JSON.stringify(name)}) before its spawn: spawn it first`);
      }
  }
}

export const spawn: FeatureCompiler = {
  file: checkFile,
  shape: ({ options, src }) => {
    // Setup's children, as written (children's compiler reports one that isn't an object literal).
    const value = options.get("children")?.value;
    const kids =
      value?.type === "ObjectExpression"
        ? value.properties.flatMap((p) =>
            p.type === "Property" && (p.key.type === "Identifier" || p.key.type === "Literal")
              ? [`${JSON.stringify(p.key.type === "Identifier" ? p.key.name : String(p.key.value))}: ${src(p.value)}`]
              : [],
          )
        : [];
    return {
      machine: ({ local, uses }) => ({
        emit: () => {
          if (!recorded()) return {};
          // With persist in use, the wrap that also restores spawned children (an import of its own).
          const restores = uses("persist");
          return {
            fields: [`sp: { ${kids.join(", ")} }`],
            effects: [`${local}.q`],
            // Recording effects gives the machine the general lifecycle, so `r` is there.
            wrap: (r) => `${restores ? "__reactreStateSpawnRestore" : `${local}.w`}(${r ?? "undefined"})`,
            imports: restores
              ? ['import { __restoring as __reactreStateSpawnRestore } from "@reactre/state/spawn/restore";']
              : [],
          };
        },
      }),
    };
  },
};
