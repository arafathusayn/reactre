// validate's compiler: a schema is a runtime value, so its expression is kept, as written, in a
// module constant where the setup call was (`__reactreStateSchemas_<shape>`), and the table's `s`
// points at it. The feature value's hooks validate input (`i`), events (`y`) and restored data (`z`),
// and each handler whose step reaches the actor outside a step (a timer's, a task's `error`, a
// timeout's, a child's report), which no step hook sees, is wrapped by @reactre/state/validate/decided
// (`__reactreStateDecided(handler, ...)`, imported only then).

//
// What it checks, that types can't: a schema runs inside the step (and in every replay), so the
// callbacks written in it (`.default(...)`, `.refine(...)`, `.transform(...)`) are held to a
// transition's rules: no clock or chance (M549), and none async, which a step can't wait for (M550).

import type { Expression, ObjectProperty } from "oxc-parser";

import type { FeatureCompiler, Report } from "../feature.ts";
import { isFunction } from "../syntax.ts";
import { chance, walkUp } from "./read.ts";

/** Checks the callbacks a schema is written with. */
function checkSchema(schema: Expression, report: Report): void {
  walkUp(schema, (node) => {
    if (node.type !== "CallExpression") return true;
    const callee = node.callee;
    const method =
      callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : "callback";
    for (const arg of node.arguments) {
      if (!isFunction(arg) || arg.body === null) continue;
      if (arg.async) report(arg, `an async ${method} in setup: check it in a task`);
      walkUp(arg.body, (n) => {
        const read = chance(n);
        if (read !== null)
          report(
            n,
            `the schema's ${method} calls ${read.what}, which a transition can't: ${read.clock ? "pass the time in the event" : read.what === "crypto.randomUUID" ? "make the id in the event" : "make the value in the event"}`,
          );
        return read === null;
      });
    }
    return true;
  });
}

export const validate: FeatureCompiler = {
  shape: ({ name, options, states, events, internal, local, isTypes, src, report }) => {
    if (local !== null)
      for (const map of [states, events, internal])
        for (const p of map.values()) if (!isTypes(p.value)) checkSchema(p.value, report);
    const given = options.get("input")?.value;
    if (local !== null && given !== undefined && !isTypes(given)) checkSchema(given, report);
    /** The schemas of one of setup's maps, as `"name": expression` entries. */
    const schemasIn = (map: ReadonlyMap<string, ObjectProperty>): string[] =>
      [...map].flatMap(([key, p]) => (isTypes(p.value) ? [] : [`${JSON.stringify(key)}: ${src(p.value)}`]));
    const inputNode = options.get("input")?.value;
    const input = inputNode === undefined || isTypes(inputNode) ? null : src(inputNode);
    const eventSchemas = [...schemasIn(events), ...schemasIn(internal)];
    const stateSchemas = schemasIn(states);
    const parts = [
      ...(eventSchemas.length > 0 ? [`e: { ${eventSchemas.join(", ")} }`] : []),
      ...(input === null ? [] : [`i: ${input}`]),
      ...(stateSchemas.length > 0 ? [`d: { ${stateSchemas.join(", ")} }`] : []),
    ];
    // Without the opt-in a schema is a type error: nothing to keep.
    if (local === null || parts.length === 0) return {};
    const constant = `__reactreStateSchemas_${name}`;
    return {
      declarations: `const ${constant} = { ${parts.join(", ")} };`,
      machine: () => {
        // A step decided outside a step (a timer's, a task's error, a child's report): its handler
        // checks the data it decides against the states' schemas, with ./decided.ts's wrapper,
        // imported only when some handler is wrapped.
        let decided = false;
        return {
          ...(stateSchemas.length > 0 && {
            outside: (code: string, what: string, state: number) => {
              decided = true;
              return `__reactreStateDecided(${code}, ${constant}.d, ${JSON.stringify(what)}, ${state})`;
            },
          }),
          emit: () => ({
            imports: decided
              ? ['import { __decided as __reactreStateDecided } from "@reactre/state/validate/decided";']
              : [],
            fields: [`s: ${constant}`, `x: ${local}.x`, ...(stateSchemas.length > 0 ? [`z: ${local}.z`] : [])],
            // Input's schema checks the input; states' schemas check the data start makes.
            start: (code) =>
              input === null && stateSchemas.length === 0
                ? code
                : `${local}.i(${input === null ? "undefined" : `${constant}.i`}, ${code}${stateSchemas.length > 0 ? `, ${constant}.d` : ""})`,
            step: (inner) => `${local}.v(${inner ?? ""})`,
          }),
        };
      },
    };
  },
};
