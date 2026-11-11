// parallel's compiler: setup's `parallel` (the regions, in `p`), a parallel node's `done` (in `n`),
// and `to(P, { region: to(...) })`, whose region steps must be written in place to compile.

import type { FeatureCompiler } from "../feature.ts";

export const parallel: FeatureCompiler = {
  options: ["parallel"],
  keys: ["done"],
  kinds: { done: { params: ["data"], moves: true } },
  shape: ({ options, states, report }) => {
    // Parallel nodes, and each one's regions: the second part of its leaves' names.
    const regions = new Map<string, string[]>();
    const value = options.get("parallel")?.value;
    if (value !== undefined) {
      if (value.type !== "ArrayExpression")
        report(value, 'setup\'s parallel is an array of names written in place: parallel: ["player"]');
      else
        for (const item of value.elements) {
          const p = item?.type === "Literal" && typeof item.value === "string" ? item.value : null;
          if (p === null) {
            report(item ?? value, 'setup\'s parallel lists names written in place: parallel: ["player"]');
            continue;
          }
          const list: string[] = [];
          for (const leaf of states.keys()) {
            const region = leaf.startsWith(`${p}.`) ? leaf.slice(p.length + 1).split(".")[0] : undefined;
            if (region !== undefined && !list.includes(region)) list.push(region);
          }
          regions.set(p, list);
        }
    }
    return {
      machine: ({ handler }) => {
        const dones: string[] = [];
        return {
          key(state, _key, v) {
            // `done` outside a parallel node is a type error: it compiles to nothing.
            if (!regions.has(state)) return;
            const code = handler(v, "done");
            if (code !== null) dones.push(`${JSON.stringify(state)}: ${code}`);
          },
          to(state, data, { isMove, compileMove, step, report: problem, properties }) {
            if (!regions.has(state)) return null;
            // The regions: a to(...) for each, written in place, so each compiles to a step.
            if (data.type !== "ObjectExpression") {
              problem(
                data,
                `write parallel node "${state}"'s regions as an object literal: to("${state}", { region: to(...), ... })`,
              );
              return "null";
            }
            const steps = [...properties(data, `parallel node "${state}"'s regions`)].map(([region, p]) => {
              if (isMove(p.value)) return `${JSON.stringify(region)}: ${compileMove(p.value)}`;
              problem(
                p.value,
                `write region "${region}"'s step as to(...) in place: to("${state}", { ${region}: to(...) })`,
              );
              return "";
            });
            return step(state, `{ ${steps.join(", ")} }`);
          },
          emit: () => ({
            fields: [
              ...(regions.size > 0
                ? [`p: { ${[...regions].map(([p, r]) => `${JSON.stringify(p)}: ${JSON.stringify(r)}`).join(", ")} }`]
                : []),
              ...(dones.length > 0 ? [`n: { ${dones.join(", ")} }`] : []),
            ],
          }),
        };
      },
    };
  },
};
