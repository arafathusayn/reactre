// persist's compiler: the machine gets the general lifecycle always (so `persist(actor)` finds its
// runners, and the opt-in in `u`), with the feature's tasks runner, which saves timers' deadlines.
// Migrations need nothing in the table: a step's types are its own, and `migrations(machine)` reads
// the version (`v`) the core writes.
//
// What it checks, that types can't (they see values, not where and how the file stores them):
//   - Setup's text: a persisted state's data holds no secret, `password`, `token`... (M568).
//   - In the file: migrations it defines are passed where stored snapshots are read (M567); one
//     storage key holds one machine (M569); a save isn't only on unload (M570); a save in a
//     listener is in a `try` (M571), and so is a restore of stored data (M572); and a machine with
//     timers or children is saved with `persist(actor)`, not its plain snapshot (M573).

import type { CallExpression, Node } from "oxc-parser";

import type { FeatureCompiler, FileContext } from "../feature.ts";
import { isFunction, stringValue } from "../syntax.ts";
import { calleeName, factsOf, fromState, inTry, localsOf, walkUp } from "./read.ts";

const SECRET = /(?<![\w$])(password|cvc|cardNumber|secret|token)\??\s*:/;
const STORAGE = /^(?:window\.)?(localStorage|sessionStorage)\.setItem$/;
const UNLOAD = new Set(["beforeunload", "unload"]);

/** Whether `node` contains a call `match` accepts. */
function contains(node: Node, match: (call: CallExpression) => boolean): boolean {
  let found = false;
  walkUp(node, (n) => {
    if (n.type === "CallExpression" && match(n)) found = true;
    return !found;
  });
  return found;
}

function checkFile({ program, report, src }: FileContext): void {
  const file = factsOf(program);
  const one = (name: string, from: (s: string) => boolean = fromState): ReadonlySet<string> =>
    localsOf(file, from, name);
  const persists = one("persist", (s) => s === "@reactre/state/persist");
  const migrationsOf = one("migrations", (s) => s === "@reactre/state/persist");
  const processes = one("processEvent", (s) => s === "@reactre/state/persist");
  const restores = one("restoreActor");
  const creates = one("createActor");
  const named = (call: Node, names: ReadonlySet<string>): call is CallExpression =>
    call.type === "CallExpression" && call.callee.type === "Identifier" && names.has(call.callee.name);
  // Every declarator's value, by the name it binds (in any scope: the checks follow one name).
  const values = new Map<string, Node>();
  walkUp(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init !== null)
      values.set(node.id.name, node.init);
    return true;
  });
  // The migrations the file defines: `const migrate = migrations(m).from(...)`, by machine.
  const migrates = new Map<string, string>();
  for (const [name, value] of values) {
    let root: Node = value;
    while (root.type === "CallExpression" && root.callee.type === "MemberExpression") root = root.callee.object;
    if (named(root, migrationsOf) && root.arguments[0]?.type === "Identifier")
      migrates.set(root.arguments[0].name, name);
  }
  const migrateNames = new Set(migrates.values());
  /**
   * A value is migrated (or persisted): `migrate(x)`, `migrations(m)…(x)` in place (whose machine
   * is the type's, M574), `persist(actor)`, or a name holding one.
   */
  const migrated = (node: Node | undefined): boolean => {
    const v = node?.type === "Identifier" ? (values.get(node.name) ?? node) : node;
    if (v === undefined) return false;
    let root: Node = v.type === "CallExpression" ? v.callee : v;
    while (root.type === "CallExpression" && root.callee.type === "MemberExpression") root = root.callee.object;
    return named(v, migrateNames) || named(v, persists) || named(root, migrationsOf);
  };
  /**
   * A value read from storage: `getItem`, `JSON.parse` (of anything but text the file just made with
   * `JSON.stringify`), or a name holding one.
   */
  const stored = (node: Node | undefined): boolean => {
    const v = node?.type === "Identifier" ? (values.get(node.name) ?? node) : node;
    return (
      v !== undefined &&
      contains(v, (c) => {
        const n = calleeName(c) ?? "";
        const text = c.arguments[0];
        const made = text?.type === "Identifier" ? values.get(text.name) : undefined;
        const fresh = made?.type === "CallExpression" && calleeName(made) === "JSON.stringify";
        return (n === "JSON.parse" && !fresh) || n.endsWith(".getItem");
      })
    );
  };
  // The actors' machines: `const actor = createActor(machine)` (or restoreActor).
  const machineOf = new Map<string, string>();
  for (const [name, value] of values)
    if ((named(value, creates) || named(value, restores)) && value.arguments[0]?.type === "Identifier")
      machineOf.set(name, value.arguments[0].name);
  const timed = new Set(
    file.machines.flatMap((m) =>
      m.name !== null && [...m.nodes.values()].some((c) => c.has("after") || c.has("timeout") || c.has("children"))
        ? [m.name]
        : [],
    ),
  );
  /** The actor `node` is a snapshot of: `actor.snapshot()`, or a subscribe listener's parameter. */
  const listened = new Map<string, string>();
  walkUp(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return true;
    const { object, property } = node.callee;
    const fn = node.arguments[0];
    if (
      property.type === "Identifier" &&
      property.name === "subscribe" &&
      object.type === "Identifier" &&
      fn !== undefined
    )
      if (isFunction(fn) && fn.params[0]?.type === "Identifier") listened.set(fn.params[0].name, object.name);
    return true;
  });
  const snapshotOf = (node: Node | undefined): string | null => {
    if (node?.type === "Identifier") return listened.get(node.name) ?? null;
    if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") return null;
    const { object, property } = node.callee;
    const method = property.type === "Identifier" ? property.name : "";
    return object.type === "Identifier" && (method === "snapshot" || method === "getSnapshot") ? object.name : null;
  };

  const keys = new Map<string, string>();
  const saves: { readonly call: CallExpression; readonly unload: boolean }[] = [];
  walkUp(program, (node, ancestors) => {
    if (node.type !== "CallExpression") return true;
    const name = calleeName(node) ?? "";
    const machine = node.arguments[0]?.type === "Identifier" ? node.arguments[0].name : null;
    // M567: a stored snapshot read without the migrations the file defines for its machine.
    const migrate = machine === null ? undefined : migrates.get(machine);
    if (migrate !== undefined && named(node, processes)) {
      const options = node.arguments[3];
      const given =
        options?.type === "ObjectExpression" &&
        options.properties.some(
          (p) => p.type === "SpreadElement" || (p.type === "Property" && src(p.key) === "migrate"),
        );
      const none =
        node.arguments[1] === undefined || src(node.arguments[1]) === "undefined" || src(node.arguments[1]) === "null";
      if (!given && !none && !migrated(node.arguments[1]) && options?.type !== "Identifier")
        report(
          node,
          `the stored value isn't migrated: \`processEvent(${machine}, ${src(node.arguments[1] ?? node)}, ${src(node.arguments[2] ?? node)}, { migrate: ${migrate} })\``,
        );
    }
    if (migrate !== undefined && named(node, restores) && !migrated(node.arguments[1]))
      report(
        node,
        `the stored value isn't migrated: \`restoreActor(${machine}, ${migrate}(${src(node.arguments[1] ?? node)}))\``,
      );
    // M572: a restore of stored data, outside a try: `restoreActor(m, migrate(JSON.parse(...)))`.
    // Stored data given to restoreActor bare is `any`, which its type refuses (M261).
    const callee = node.callee.type === "Identifier" ? node.callee.name : "";
    const restore = restores.has(callee);
    if ((restore || migrateNames.has(callee)) && !inTry(ancestors, node)) {
      const value = restore ? node.arguments[1] : node.arguments[0];
      const through = value?.type === "CallExpression" && named(value, migrateNames) ? value.arguments[0] : undefined;
      if (restore ? stored(through) : stored(value)) {
        report(node, "restoring stored data outside try: a bad value stops the app; catch it and start fresh");
        return false;
      }
    }
    if (!STORAGE.test(name)) return true;
    const [key, value] = node.arguments;
    const storage = name.replace(/^window\./, "");
    // M571: a save in a subscribe listener, outside a try.
    const listener = ancestors.findLastIndex((a, i) => {
      const up = ancestors[i - 1];
      return isFunction(a) && up?.type === "CallExpression" && (calleeName(up) ?? "").endsWith(".subscribe");
    });
    if (listener !== -1 && !inTry(ancestors.slice(listener), node))
      report(node, `${storage} throws when full or blocked: wrap it in try`);
    // M573: the plain snapshot of a machine with timers or children.
    if (value !== undefined)
      walkUp(value, (n) => {
        if (n.type !== "CallExpression" || calleeName(n) !== "JSON.stringify") return true;
        const actor = snapshotOf(n.arguments[0]);
        const of = actor === null ? undefined : machineOf.get(actor);
        if (actor !== null && of !== undefined && timed.has(of))
          report(n, `a stored snapshot of a machine with timers or children: \`persist(${actor})\``);
        return false;
      });
    // M569: one key, two machines' snapshots.
    const k = stringValue(key);
    let saved: string | null = null;
    if (value !== undefined)
      walkUp(value, (n) => {
        if (named(n, persists) && n.arguments[0] !== undefined) saved ??= src(n.arguments[0]);
        return saved === null;
      });
    if (k !== null && saved !== null) {
      const before = keys.get(k);
      if (before !== undefined && before !== saved)
        report(node, `the key ${JSON.stringify(k)} stores two machines: one key each`);
      keys.set(k, saved);
    }
    if (saved !== null) {
      // M570: inside an unload listener: `addEventListener("beforeunload", ...)` or `onbeforeunload = ...`.
      const unload = ancestors.some((a, i) => {
        const up = ancestors[i - 1];
        if (!isFunction(a) || up === undefined) return false;
        if (up.type === "CallExpression")
          return (calleeName(up) ?? "").endsWith("addEventListener") && UNLOAD.has(stringValue(up.arguments[0]) ?? "");
        return up.type === "AssignmentExpression" && /onbeforeunload|onunload/.test(src(up.left));
      });
      saves.push({ call: node, unload });
    }
    return true;
  });
  if (saves.length > 0 && saves.every((s) => s.unload))
    for (const { call } of saves) report(call, "beforeunload doesn't fire on mobile: save on visibilitychange");
}

export const persist: FeatureCompiler = {
  file: checkFile,
  shape: ({ states, local, src, report }) => {
    // M568: a secret in a persisted state's data, as setup writes it.
    if (local !== null)
      for (const p of states.values()) {
        const secret = SECRET.exec(src(p.value))?.[1];
        if (secret !== undefined)
          report(p, `the persisted data holds \`${secret}\`: keep it out of data, or don't persist the state`);
      }
    return {
      machine: ({ local: name }) => ({
        emit: () => ({ tasks: `${name}.t`, lifecycle: "always", marker: true }),
      }),
    };
  },
};
