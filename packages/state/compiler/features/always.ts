// always's compiler: each node's `always` (a handler like a timer's, `(data, state) => step | null`)
// in `al`, and the graph that takes them (`g: always.g(...)`). Purity is the core's check on every
// handler; types see the targets.
//
// What it checks, that types can't: an `always` that goes back to where it is with the same data
// (M524). The handler is pure, so the same state and data decide the same step: once taken, it is
// taken again, forever (S50 at runtime). A step "keeps the data" when it passes the handler's `data`
// (or `{ ...data }`), or none. ./choice.ts checks its choices the same way (M527).

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { factsOf, type FileMachine, fnOf, handlerOf, lineage, type Step } from "./read.ts";

/** Whether a step passes its handler's data unchanged (or none). */
function keepsData(step: Step, data: string | undefined): boolean {
  const d = step.data;
  if (d === undefined) return true;
  if (d.type === "Identifier") return d.name === data;
  return (
    d.type === "ObjectExpression" &&
    d.properties.length === 1 &&
    d.properties[0]?.type === "SpreadElement" &&
    d.properties[0].argument.type === "Identifier" &&
    d.properties[0].argument.name === data
  );
}

/**
 * The cycles of a machine's `key` handlers (`always`, `choice`) whose steps keep the data: each a
 * list of nodes, with the step that closes it. A step to a leaf goes on at the handler of the leaf
 * or a parent of it.
 */
export function cycles(machine: FileMachine, key: string): { readonly nodes: readonly string[]; readonly at: Step }[] {
  const edges = new Map<string, { readonly to: string; readonly at: Step }[]>();
  for (const [node, config] of machine.nodes) {
    const fn = fnOf(config.get(key)?.value);
    if (fn === null) continue;
    const h = handlerOf(fn);
    const data = h.names.get("data");
    edges.set(
      node,
      h.steps.flatMap((s) => (s.state !== null && keepsData(s, data) ? [{ to: s.state, at: s }] : [])),
    );
  }
  const out: { nodes: string[]; at: Step }[] = [];
  const seen = new Set<string>();
  const visit = (path: string[]): void => {
    const node = path.at(-1) ?? "";
    for (const edge of edges.get(node) ?? [])
      for (const next of lineage(edge.to).filter((n) => edges.has(n))) {
        const i = path.indexOf(next);
        if (i === 0) {
          const id = [...path].sort().join(" ");
          if (!seen.has(id)) {
            seen.add(id);
            out.push({ nodes: path, at: edge.at });
          }
        } else if (i === -1 && path.length < 16) visit([...path, next]);
      }
  };
  for (const node of edges.keys()) visit([node]);
  return out;
}

/** The names of a cycle's nodes, for a message: `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
export function listed(nodes: readonly string[]): string {
  const quoted = nodes.map((n) => JSON.stringify(n));
  return quoted.length === 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

function checkFile({ program, report }: FileContext): void {
  for (const machine of factsOf(program).machines) {
    if (!machine.shape.uses.has("always")) continue;
    for (const { nodes, at } of cycles(machine, "always"))
      report(
        at.call,
        nodes.length === 1
          ? `the \`always\` of ${JSON.stringify(nodes[0])} goes to ${JSON.stringify(at.state)} with the same data, forever: decline with null`
          : `the \`always\` of ${listed(nodes)} go to each other with the same data, forever: decline with null in one`,
      );
  }
}

export const always: FeatureCompiler = {
  keys: ["always"],
  kinds: { always: { params: ["data", "state"], moves: true } },
  file: checkFile,
  shape: () => ({
    machine: ({ local, handler }) => {
      const found: string[] = [];
      return {
        key(state, _key, value) {
          const code = handler(value, "always");
          if (code !== null) found.push(`${JSON.stringify(state)}: ${code}`);
        },
        emit: () =>
          found.length > 0
            ? { fields: [`al: { ${found.join(", ")} }`], graph: (inner) => `${local}.g(${inner ?? ""})` }
            : {},
      };
    },
  }),
};
