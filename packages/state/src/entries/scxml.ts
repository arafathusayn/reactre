// @reactre/state/scxml (prototype): SCXML to a machine definition (xstate docs: scxml.md).
// `fromSCXML(xml)` returns the machine as source, `setup({ use, states, events }).machine({ ... })`,
// and a report of what it converted and what it couldn't.
//
// Design decisions:
//   - The result is source, not a running machine: a definition here is code the type checker reads
//     and the compiler compiles, so a converted machine gets the same checks as one written by hand
//     (an unreachable state, a dead end). XState's `createMachineFromSCXML` evaluates ECMAScript at
//     runtime instead; here no expression is evaluated, ever.
//   - Ids become dotted names by their place in the tree (`<state id="edit"><state id="draft">` is
//     "edit.draft"), so a compound state is a parent and a `<parallel>` a parallel node. A target is
//     resolved to the leaf it enters: a compound state's `initial` (or first child), each region's
//     for a parallel node, the default of a `<history>` (`back(parent, to(...))`, shallow with a step
//     for each child parent).
//   - Eventless transitions become `always`, `*` and `foo.*` wildcards. Every state's data and every
//     event's payload is `{}`: SCXML's datamodel is ECMAScript, which has no types. A `cond`, `<script>`,
//     `<assign>`, `<send>`, `<invoke>`, `<onentry>`, `<onexit>` or `<datamodel>` stays as a TODO comment
//     where it was, and in the report: nothing is dropped silently.
//   - SCXML's `event="foo"` also matches "foo.bar"; here it matches "foo" alone (XState's rule), and
//     the report says so when both names are used.
//   - A small XML reader of its own: no dependency. It reads elements, attributes, text, comments and
//     CDATA, which is what SCXML documents use.

/** An XML element. */
interface Element {
  readonly name: string;
  readonly attrs: { readonly [name: string]: string };
  readonly children: Element[];
}

const ENTITIES: { readonly [name: string]: string } = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e.startsWith("#x") || e.startsWith("#X")
      ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
      : e.startsWith("#")
        ? String.fromCodePoint(Number(e.slice(1)))
        : (ENTITIES[e] ?? ""),
  );

/** The document's root element. Throws on a document it can't read. */
function parse(xml: string): Element {
  const root: Element = { name: "#document", attrs: {}, children: [] };
  const open: Element[] = [root];
  const tag =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    const [, close, name, attrText, selfClosing] = m;
    if (close !== undefined) {
      if (open.length < 2 || open[open.length - 1]?.name !== close)
        throw new Error(`SCXML: </${close}> doesn't close the open element`);
      open.pop();
    } else if (name !== undefined) {
      const attrs: { [name: string]: string } = {};
      for (const a of (attrText ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        attrs[a[1] ?? ""] = decode(a[2] ?? a[3] ?? "");
      const el: Element = { name: name.replace(/^\w+:/, ""), attrs, children: [] };
      open[open.length - 1]?.children.push(el);
      if (selfClosing !== "/") open.push(el);
    }
  }
  const scxml = root.children.find((c) => c.name === "scxml");
  if (scxml === undefined) throw new Error("SCXML: the document has no <scxml> element");
  return scxml;
}

const STATES = new Set(["state", "parallel", "final", "history"]);
const IGNORED = new Set(["datamodel", "script", "onentry", "onexit", "invoke", "donedata"]);

/** A state of the document, by id, where it is in the tree. */
interface Node {
  readonly el: Element;
  readonly id: string;
  /** Its dotted name. */
  readonly path: string;
  readonly parent: Node | null;
  readonly kind: "atomic" | "compound" | "parallel" | "final" | "history";
  readonly children: Node[];
}

/** What `fromSCXML` gives: the machine's source, and what it converted and couldn't. */
export interface Converted {
  /** A module: imports, `const <name> = setup({...})`, and `export const <name>Machine = <name>.machine({...})`. */
  readonly code: string;
  /** What was converted, guessed or left as a TODO, one line each. */
  readonly report: readonly string[];
}

/**
 * Convert an SCXML document to a machine's source. `name` names the shape (`<name>`) and the
 * machine (`<name>Machine`): the document's `name`, else "machine".
 *
 * @throws Error for a document that isn't SCXML (no `<scxml>`, or a tag that doesn't close).
 */
export function fromSCXML(xml: string, options: { readonly name?: string } = {}): Converted {
  const scxml = parse(xml);
  const report: string[] = [];
  const name = (options.name ?? scxml.attrs["name"] ?? "machine").replace(/\W+(\w)?/g, (_, c: string | undefined) =>
    (c ?? "").toUpperCase(),
  );
  const byId = new Map<string, Node>();
  let anonymous = 0;

  const build = (el: Element, parent: Node | null): Node => {
    let id = el.attrs["id"] ?? `state${++anonymous}`;
    if (el.attrs["id"] === undefined) report.push(`a <${el.name}> without an id is named "${id}"`);
    if (id.includes(".")) {
      const fixed = id.replaceAll(".", "_");
      report.push(`id "${id}" has a dot, which separates a parent from its child here: it is "${fixed}"`);
      id = fixed;
    }
    const stateChildren = el.children.filter((c) => STATES.has(c.name));
    const kind: Node["kind"] =
      el.name === "parallel"
        ? "parallel"
        : el.name === "final"
          ? "final"
          : el.name === "history"
            ? "history"
            : stateChildren.some((c) => c.name !== "history")
              ? "compound"
              : "atomic";
    const node: Node = { el, id, path: parent === null ? id : `${parent.path}.${id}`, parent, kind, children: [] };
    byId.set(el.attrs["id"] ?? id, node);
    for (const c of stateChildren) node.children.push(build(c, node));
    for (const c of el.children)
      if (IGNORED.has(c.name))
        report.push(`TODO: <${c.name}> in "${node.path}" isn't converted: write it in a handler or a task`);
    return node;
  };
  const top = scxml.children.filter((c) => STATES.has(c.name)).map((c) => build(c, null));

  // A region of a parallel node that is a leaf gets a leaf under it: a region here is a parent.
  for (const node of byId.values())
    if (node.kind === "atomic" && node.parent?.kind === "parallel") {
      report.push(`region "${node.path}" has no states: it is the parent of one leaf, "${node.path}.active"`);
      Reflect.set(node, "kind", "compound");
      const el: Element = { name: "state", attrs: {}, children: [] };
      node.children.push({ el, id: "active", path: `${node.path}.active`, parent: node, kind: "atomic", children: [] });
    }

  // Every node, in document order.
  const all: Node[] = [];
  const visit = (n: Node): void => {
    all.push(n);
    n.children.forEach(visit);
  };
  top.forEach(visit);
  const leaves = all.filter((n) => n.kind === "atomic" || n.kind === "final");
  const parallels = all.filter((n) => n.kind === "parallel");
  const use = new Set<string>();
  if (leaves.some((l) => l.path.includes("."))) use.add("nested");
  if (parallels.length > 0) use.add("parallel");

  /** The `to(...)` (or `back(...)`) that enters node `n`. */
  const enter = (n: Node): string => {
    switch (n.kind) {
      case "atomic":
      case "final":
        return `to(${JSON.stringify(n.path)})`;
      case "compound": {
        const initial =
          n.el.attrs["initial"] ??
          n.el.children.find((c) => c.name === "initial")?.children.find((c) => c.name === "transition")?.attrs[
            "target"
          ];
        const first = n.children.find((c) => c.kind !== "history");
        const child = (initial === undefined ? undefined : byId.get(initial.split(/\s+/)[0] ?? "")) ?? first;
        return child === undefined ? `to(${JSON.stringify(n.path)})` : enter(child);
      }
      case "parallel":
        return `to(${JSON.stringify(n.path)}, { ${n.children
          .filter((c) => c.kind !== "history")
          .map((c) => `${JSON.stringify(c.id)}: ${enter(c)}`)
          .join(", ")} })`;
      case "history": {
        const parent = n.parent;
        const target = n.el.children.find((c) => c.name === "transition")?.attrs["target"];
        const fallback = target === undefined ? undefined : byId.get(target.split(/\s+/)[0] ?? "");
        if (parent === null) return "null";
        use.add("history");
        const fb = enter(fallback ?? parent.children.find((c) => c.kind !== "history") ?? parent);
        if (n.el.attrs["type"] === "deep") return `back(${JSON.stringify(parent.path)}, ${fb})`;
        const childParents = parent.children.filter((c) => c.kind === "compound" || c.kind === "parallel");
        return `back(${JSON.stringify(parent.path)}, ${fb}, { ${childParents.map((c) => `${JSON.stringify(c.id)}: ${enter(c)}`).join(", ")} })`;
      }
    }
  };

  const events = new Set<string>();
  /** The handler code of a transition, or null. */
  const handler = (n: Node, t: Element): string => {
    const target = t.attrs["target"]?.split(/\s+/).filter(Boolean) ?? [];
    const todo: string[] = [];
    if (t.attrs["cond"] !== undefined) {
      todo.push(`cond ${JSON.stringify(t.attrs["cond"])}`);
      report.push(
        `TODO: "${n.path}"'s transition on ${JSON.stringify(t.attrs["event"] ?? "(no event)")} has cond ${JSON.stringify(t.attrs["cond"])}, which isn't converted: write it as a condition returning null`,
      );
    }
    for (const c of t.children) {
      todo.push(`<${c.name}>`);
      report.push(`TODO: <${c.name}> in "${n.path}"'s transition isn't converted`);
    }
    if (target.length > 1)
      report.push(`TODO: "${n.path}"'s transition goes to ${target.join(" and ")}: only the first is converted`);
    const to = target[0] === undefined ? undefined : byId.get(target[0]);
    let body: string;
    if (to === undefined) {
      if (target[0] !== undefined) report.push(`"${n.path}"'s transition goes to "${target[0]}", which no state is`);
      // A targetless transition (actions only) stays where it is: a leaf's own `to`, or a parent's decline.
      body = n.kind === "atomic" ? `to(${JSON.stringify(n.path)})` : "null";
      if (target[0] === undefined) report.push(`"${n.path}" has a transition without a target: it stays`);
    } else body = enter(to);
    const moves = ["to", ...(body.includes("back(") ? ["back"] : [])].filter((m) => body.includes(`${m}(`));
    const arg = moves.length === 0 ? "()" : `({ ${moves.join(", ")} })`;
    return `${arg} => ${todo.length > 0 ? `/* TODO(@reactre/state): ${todo.join(", ")} */ ` : ""}${body}`;
  };

  const configs: string[] = [];
  for (const node of all.filter((n) => n.kind !== "history")) {
    if (node.kind === "final") {
      configs.push(`${JSON.stringify(node.path)}: { final: true }`);
      continue;
    }
    const on: string[] = [];
    let always: string | null = null;
    for (const t of node.el.children.filter((c) => c.name === "transition")) {
      const descriptors = t.attrs["event"]?.split(/\s+/).filter(Boolean) ?? [];
      if (descriptors.length === 0) {
        if (always !== null)
          report.push(`TODO: "${node.path}" has more than one eventless transition: only the first is converted`);
        else always = handler(node, t);
        continue;
      }
      for (const raw of descriptors) {
        const d = raw === "*" || raw.endsWith(".*") ? raw : raw.replace(/\.$/, "");
        if (d === "*" || d.endsWith(".*")) use.add("wildcards");
        else events.add(d);
        if (on.some((o) => o.startsWith(`${JSON.stringify(d)}:`)))
          report.push(`TODO: "${node.path}" has more than one transition on "${d}": only the first is converted`);
        else on.push(`${JSON.stringify(d)}: ${handler(node, t)}`);
      }
    }
    if (always !== null) use.add("always");
    const parts = [
      ...(on.length > 0 ? [`on: { ${on.join(", ")} }`] : []),
      ...(always === null ? [] : [`always: ${always}`]),
    ];
    // A leaf is always listed; a parent only when it has handlers.
    if (parts.length > 0 || node.kind === "atomic")
      configs.push(`${JSON.stringify(node.path)}: { ${parts.join(", ")} }`);
    if (node.kind === "atomic" && parts.length === 0)
      report.push(
        `"${node.path}" has no transition and isn't final: the type checker will ask for one, or { final: true }`,
      );
  }
  for (const e of events)
    if ([...events].some((o) => o.startsWith(`${e}.`)))
      report.push(
        `event "${e}" matches only itself here; in SCXML it also matches "${e}.<...>": add "${e}.*" for those`,
      );

  const initialId = scxml.attrs["initial"]?.split(/\s+/)[0];
  const first = (initialId === undefined ? undefined : byId.get(initialId)) ?? top.find((n) => n.kind !== "history");
  if (first === undefined) throw new Error("SCXML: the document has no state");
  const start = enter(first);
  const order = ["nested", "parallel", "history", "always", "wildcards"].filter((f) => use.has(f));
  const code = [
    'import { setup, types } from "@reactre/state";',
    ...order.map((f) => `import { ${f} } from "@reactre/state/${f}";`),
    "",
    `const ${name} = setup({`,
    ...(order.length > 0 ? [`  use: [${order.join(", ")}],`] : []),
    ...(parallels.length > 0 ? [`  parallel: [${parallels.map((p) => JSON.stringify(p.path)).join(", ")}],`] : []),
    `  states: { ${leaves.map((l) => `${JSON.stringify(l.path)}: types<{}>()`).join(", ")} },`,
    `  events: { ${[...events].map((e) => `${JSON.stringify(e)}: types<{}>()`).join(", ")} },`,
    "});",
    "",
    `export const ${name}Machine = ${name}.machine({`,
    `  start: ({ to }) => ${start},`,
    "  states: {",
    ...configs.map((c) => `    ${c},`),
    "  },",
    "});",
    "",
  ].join("\n");
  report.unshift(
    `converted ${leaves.length} states and ${events.size} events; every state's data and every event's payload is {} (SCXML's datamodel has no types)`,
  );
  return { code, report };
}
