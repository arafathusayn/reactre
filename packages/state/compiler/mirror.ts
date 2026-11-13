// The mirrored-states lint (M324, M325): sibling states that are one state written twice, the
// difference between them put in their names instead of their data. `approved_by_manager` and
// `approved_by_director` with the same data and the same handlers are one state, `approved`, with
// `{ by: "manager" | "director" }` in its data; `processing_priority_insured` and
// `processing_standard_uninsured` encode two flags in a name. Types see the names, not that the
// code under them is the same.
//
// The lint fires only where the states are one state twice, so it has no false positives on a
// correct machine:
//   - siblings (leaves with the same parent), not final, each with behaviour (a key besides
//     `tags`, `meta` and `description`);
//   - the same data contract, as written in setup (formatting and comments left out);
//   - names of as many words, the same but at some places, with a stem they share besides a
//     connector like `by` (words split at `_`, `-` and camel case): `vip`, `review` and `standard`
//     (a choice's targets) share no stem, so they are different states, even when written alike;
//   - the same code, with whitespace and comments left out, the names of states in it differing
//     only by those words: `to("paid_by_manager")` in one is `to("paid_by_director")` in the other.
//
// The codemod converts a user's XState machine, which may be mirrored. It doesn't merge the states
// (the app reads their names, and the converted machine must replay as XState's did), so it writes
// the fix as a TODO right above the first (`MIRROR_TODO`), and the compiler takes that note: the
// converted machine builds, with the TODO in it until the states are merged.

import type { Node, ObjectExpression, ObjectProperty } from "oxc-parser";

import { normalize } from "./hash.ts";
import { keyName, walk } from "./syntax.ts";

/** Words that join a name's stem to its flag (`approved_by_manager`): the flag's field is named after them. */
const CONNECTORS = new Set(["by", "for", "with", "via", "as", "on", "in", "from", "to", "at", "of"]);
/** Keys that only label a state: two states alike in them alone aren't alike in behaviour. */
const LABELS = new Set(["tags", "meta", "description"]);
const NEGATION = /^(un|non|not)(?=.)/;

/** A name's words: split at `_`, `-` and camel case, as written. */
function words(name: string): string[] {
  return name.split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])/).filter((w) => w !== "");
}

/** A state's own name, without its parents'. */
const leaf = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The codemod's note on mirrored states it converted, before the fix: `// TODO(@reactre/state): <the
 * fix>` right above the first. The compiler takes that note, and only it, as the states noted: a
 * converted machine keeps XState's states (and replays the same) until they are merged by hand.
 */
export const MIRROR_TODO = "TODO(@reactre/state): ";

/** States that are one state written more than once: where the first is, their names, and the fix. */
export interface Mirrored {
  readonly at: ObjectProperty;
  readonly states: readonly string[];
  readonly message: string;
}

/**
 * A machine's mirrored sibling leaves. `configs` are the states' configs as written (final states
 * left out), `contracts` each leaf's contract text, normalized (./hash.ts), and `names` every
 * state's name, for the targets in the code. The compiler reports each (./index.ts); the codemod
 * notes each in a TODO (../codemod/index.ts).
 */
export function mirrored(
  configs: ReadonlyMap<string, ObjectProperty>,
  contracts: ReadonlyMap<string, string>,
  names: ReadonlySet<string>,
  src: (node: Node) => string,
): Mirrored[] {
  const out: Mirrored[] = [];
  interface State {
    readonly name: string;
    readonly at: ObjectProperty;
    readonly config: ObjectExpression;
  }
  const siblings = new Map<string, State[]>();
  for (const [name, at] of configs) {
    const config = at.value;
    if (!contracts.has(name) || config.type !== "ObjectExpression") continue;
    if (!config.properties.some((q) => q.type !== "Property" || !LABELS.has(keyName(q) ?? ""))) continue;
    const parent = name.slice(0, Math.max(0, name.lastIndexOf(".")));
    siblings.set(parent, [...(siblings.get(parent) ?? []), { name, at, config }]);
  }

  /** A state's code, normalized, with the words `flags` in the names of states in it as `*`. */
  const code = (config: ObjectExpression, flags: readonly string[]): string => {
    const text = src(config);
    let out = "";
    let at = config.start;
    walk(config, (node) => {
      if (node.type !== "Literal" || typeof node.value !== "string" || !names.has(node.value)) return true;
      const masked = node.value
        .split(".")
        .map((part) =>
          words(part)
            .map((w) => (flags.some((f) => same(f, w)) ? "*" : w.toLowerCase()))
            .join("_"),
        )
        .join(".");
      out += text.slice(at - config.start, node.start - config.start) + JSON.stringify(masked);
      at = node.end;
      return true;
    });
    return normalize(out + text.slice(at - config.start));
  };

  for (const group of siblings.values()) {
    // The states each is the same as, by index: a union of the pairs found.
    const root = group.map((_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : find(root[i] ?? i));
    group.forEach((a, i) =>
      group.slice(i + 1).forEach((b, n) => {
        const wa = words(leaf(a.name));
        const wb = words(leaf(b.name));
        if (wa.length !== wb.length || contracts.get(a.name) !== contracts.get(b.name)) return;
        const differ = wa.flatMap((w, k) => (same(w, wb[k] ?? "") ? [] : [k]));
        const stem = wa.filter((w, k) => !differ.includes(k) && !CONNECTORS.has(w.toLowerCase()));
        if (differ.length === 0 || stem.length === 0) return;
        const flags = (ws: readonly string[]): string[] => differ.map((k) => ws[k] ?? "");
        if (code(a.config, flags(wa)) === code(b.config, flags(wb))) root[find(i + 1 + n)] = find(i);
      }),
    );
    const clusters = new Map<number, State[]>();
    group.forEach((s, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), s]));
    for (const [first, ...rest] of clusters.values()) {
      const states = [first, ...rest].flatMap((s) => (s === undefined ? [] : [s.name]));
      if (first !== undefined && rest.length > 0) out.push({ at: first.at, states, message: message(states) });
    }
  }
  return out;
}

/** The word of two that the other negates (`insured` of `insured` and `uninsured`), if one does. */
function negated(values: readonly string[]): string | null {
  const [x = "", y = ""] = values;
  const negates = (a: string, b: string): boolean => NEGATION.test(b) && b.replace(NEGATION, "") === a;
  return values.length !== 2 ? null : negates(x, y) ? x : negates(y, x) ? y : null;
}

/** The fix: one state, named by the stem, with a field in its data for each place the names differ. */
function message(cluster: readonly string[]): string {
  const split = cluster.map((n) => words(leaf(n)));
  const first = split[0] ?? [];
  const differ = first.flatMap((_, k) => (split.every((ws) => same(ws[k] ?? "", first[k] ?? "")) ? [] : [k]));
  // The connectors that name a field, by their place.
  const named = new Set<number>();
  let unnamed = 0;
  const fields = differ.map((k) => {
    const values = [...new Set(split.map((ws) => (ws[k] ?? "").toLowerCase()))];
    const positive = negated(values);
    if (positive !== null) return `${positive}: boolean`;
    const union = values.map((v) => JSON.stringify(v)).join(" | ");
    const before = (first[k - 1] ?? "").toLowerCase();
    if (CONNECTORS.has(before) && !differ.includes(k - 1)) {
      named.add(k - 1);
      return `${before}: ${union}`;
    }
    unnamed++;
    return `${unnamed > 1 ? `kind${unnamed}` : "kind"}: ${union}`;
  });
  const name = cluster[0] ?? "";
  const own = leaf(name);
  const stem = first.filter((_, k) => !differ.includes(k) && !named.has(k));
  // Joined as the name is: at `_` or `-`, or in camel case.
  const separator = /[_-]/.exec(own)?.[0];
  const camel = stem.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w)).join("");
  const joined = separator === undefined ? camel : stem.join(separator);
  const quoted = cluster.map((n) => `"${n}"`);
  const listed =
    cluster.length === 2
      ? `${quoted.join(" and ")} are the same state twice`
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]} are the same state ${cluster.length} times`;
  return `${listed} (same data, same handlers): make one state, "${name.slice(0, name.length - own.length)}${joined}", with the difference in its data, { ${fields.join(", ")} }`;
}
