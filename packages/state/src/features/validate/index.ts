// @reactre/state/validate (prototype): runtime validation with Standard Schema v1
// (https://standardschema.dev): zod, valibot, arktype, or an object written by hand.
// `setup({ use: [validate], states: { editing: schema }, ... })`. The compiler keeps each schema's
// expression in `s`, and puts this value's hooks in the table (`x: validate.x`, `y: validate.v(...)`,
// `i: validate.i(...)`, `z: validate.z`), so a machine without it ships none of it.
//
// What is checked, against `xstate/validation`'s boundaries:
//   - input (S5), sent and internal events (`reason: "invalid"`; an internal one's error, S6, goes
//     to its task's `error`), restored data (S7): as XState's `input` and `event` boundaries.
//   - the data a transition makes (XState's `result` check, its `context` and `state.context`
//     boundaries): `start`'s (S23, thrown by createActor), and an event's step's (refused as
//     `invalid`, with the issues; for a task's event, its `error` gets S23). Here a state's data is
//     its input and, in a final state, its output, so this covers `state.input` and `output` too.
//   - the data a step decided outside a step makes: a timer's, a task's `error`, a timeout's, a
//     child's report. No step hook sees those (they reach the actor through the lifecycle's `go`),
//     so the compiler wraps each such handler (./decided.ts, imported only by a machine with such a
//     handler and a state's schema), which throws S23 where it ran (the
//     timer's callback, the task's promise, the child's report), and the machine doesn't move.
//     Nobody receives that step's result, so a throw is the only report there is.
//   - children (`child`): a child machine with schemas checks its own input when it starts.
//   - Every failure is a `ValidationError` (a StateError) with `boundary`, `issues`, and the state
//     or event: XState's `ActorValidationError`, read with `instanceof`.
//   - A schema that throws (XState's `schemaThrew`) is S24, with the thrown value as `cause`; one
//     that returns a Promise (`asyncValidationUnsupported`) is S8.
//   - Unknown events (`unknownEvents`) are the core's: refused as `unknown`, never thrown.
//   - Not here: emitted events (`emitted`) are the emit feature's to declare; an eventless or choice
//     step that settles inside the graph after one of those outside steps is checked by no hook
//     (the outside step's own data is).
//
// Design decisions:
//   - Synchronous only. A step is synchronous, so a schema that returns a Promise throws S8.
//   - An event's schema is its payload's: it gets the event without `type` (an object schema that
//     strips unknown keys would drop it), and the step gets the schema's value, with `type` back.
//   - Data is checked, not transformed: a transition's data and a restored snapshot's are already
//     what the state holds. XState's validator is assertion-only too.
//   - Every message lists each issue as `path: message`, its path rooted at what was checked
//     (`input.file`, `data.text`).

import { __flat, type Feature, StateError } from "../../index.ts";
import type { __Compiled, __Issue, __Leaf, __Snapshot, __Step, __StepHook, __To, __Validate } from "../../internal.ts";

/** Standard Schema v1, the part this module calls. */
interface Standard {
  readonly "~standard": { readonly validate: (value: unknown) => ReturnType<__Validate> | PromiseLike<unknown> };
}

/** Where a value was refused, as XState's validation boundaries name them. */
export type Boundary = "input" | "event" | "data" | "restored";

/**
 * A value its schema refused: an invalid input (S5), task result (S6), restored data (S7), or data a
 * transition made (S23). `issues` are the schema's; `state` and `event` say where.
 */
export class ValidationError extends StateError {
  // Declared, and set by `Object.assign` below: fewer bytes than a field each.
  declare readonly boundary: Boundary;
  declare readonly issues: readonly __Issue[];
  /** The state whose data was refused (`data`, `restored`), or the state the event arrived in (`event`). */
  declare readonly state?: string;
  /** The event refused (`event`), or whose step made the refused data (`data`). */
  declare readonly event?: string;
  constructor(code: string, message: string, where: Where) {
    super(code, message);
    Object.assign(this, where);
  }
}

/** Where a value was refused: `ValidationError`'s fields. */
interface Where {
  readonly boundary: Boundary;
  readonly issues: readonly __Issue[];
  readonly state?: string;
  readonly event?: string;
}

/** S23: `by` made data for `state` that its schema refuses. */
const made = (by: string, where: Where & { readonly state: string }): ValidationError =>
  new ValidationError(
    "S23",
    `${by} went to "${where.state}" with data its schema refuses (${list("data", where.issues)}). Build data the state's schema accepts.`,
    where,
  );

/** Each issue as `path: message`, the path rooted at `what`. */
function list(what: string, issues: readonly __Issue[]): string {
  return issues
    .map(
      (i) =>
        `${[what, ...(i.path ?? []).map((p) => (typeof p === "object" ? p.key : p))].map(String).join(".")}: ${i.message}`,
    )
    .join("; ");
}

/**
 * Internal: validates `value` against a Standard Schema, synchronously (`x` in the compiled table).
 *
 * @throws StateError S8 for a schema that returns a Promise, S24 for one that throws.
 */
export const __validate: __Validate = (schema, value) => {
  let result: ReturnType<Standard["~standard"]["validate"]>;
  try {
    // The compiler puts only Standard Schemas in `s`: setup's types accept nothing else there.
    result = (schema as Standard)["~standard"].validate(value);
  } catch (cause) {
    const error = new StateError(
      "S24",
      `a schema threw (${String(cause)}): a schema returns { issues } for a value it refuses. Fix the schema, or catch inside it.`,
    );
    error.cause = cause;
    throw error;
  }
  if ("then" in result)
    throw new StateError(
      "S8",
      "a schema returned a Promise, and validation is synchronous: a step can't wait. Use a synchronous schema (no async refinements or transforms), or validate the payload yourself before send.",
    );
  return result;
};

/** The first leaf of `snapshot` (each region's, for a parallel node) whose data its schema refuses. */
function refused(
  m: __Compiled,
  { state, data }: __Leaf,
): { readonly state: string; readonly issues: readonly __Issue[] } | undefined {
  const regions = m.p?.[state];
  if (regions !== undefined) {
    // A parallel node's data is its regions' leaves: the snapshot's contract (../../internal.ts).
    const leaves = data as { readonly [region: string]: __Leaf | undefined };
    for (const region of regions) {
      const leaf = leaves[region];
      const found = leaf === undefined ? undefined : refused(m, leaf);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const schema = m.s?.d?.[state];
  const result = schema === undefined ? undefined : __validate(schema, data);
  return result?.issues === undefined ? undefined : { state, issues: result.issues };
}

/**
 * Internal: the step of a machine with schemas (`y`): an event whose type has a schema in `s.e`
 * (sent or internal) is validated first, and refused as `invalid` with its issues. Then `inner`
 * (the hierarchy's step, `__validated(__nested)`) or the flat step runs on the schema's value, and
 * the data it made is checked against its state's schema (`s.d`).
 */
export function __validated(inner?: __StepHook): __StepHook {
  return (m, from, event, internal) => {
    const schema = m.s?.e?.[event.type];
    const { type } = event;
    if (schema !== undefined) {
      const { type: _, ...payload } = event;
      const result = __validate(schema, payload);
      if (result.issues !== undefined)
        return {
          ok: false,
          reason: "invalid",
          snapshot: from,
          issues: result.issues,
          // An internal event (a task's result): the error its task's `error` handler gets.
          ...(internal && {
            error: new ValidationError(
              "S6",
              `a task in state "${from.state}" resolved to an invalid "${type}" event (${list("event", result.issues)}). Resolve to what setup's internal "${type}" declares.`,
              { boundary: "event", issues: result.issues, state: from.state, event: type },
            ),
          }),
        };
      event = Object.assign({}, result.value, { type });
    }
    const r = inner === undefined ? __flat(m, from, event) : inner(m, from, event, internal);
    const bad = r.ok && m.s?.d !== undefined ? refused(m, r.snapshot) : undefined;
    return bad === undefined
      ? r
      : {
          ok: false,
          reason: "invalid",
          snapshot: from,
          issues: bad.issues,
          error: made(`the "${type}" handler in state "${from.state}"`, { boundary: "data", ...bad, event: type }),
        };
  };
}

/** The leaves a step goes to (each region's, for a parallel node; the fallback, for `back`). */
function* goes(step: __Step): Generator<__Leaf> {
  // A back step is `{ b, t: fallback, s? }`; a reenter step is `{ r: to }`, a plain move.
  if ("b" in step) return yield* goes(step.t);
  const { state, data } = "r" in step ? step.r : step;
  yield { state, data };
  // A parallel node's data is a step (a `to`, with its version) per region, whose state is under
  // the node. The cast: data is `unknown`; a value without a version is no region's step.
  if (typeof data === "object" && data !== null)
    for (const region of Object.values(data) as (Partial<__To> | null)[])
      if (region?.version !== undefined && String(region.state).startsWith(`${state}.`)) yield* goes(region as __To);
}

/**
 * Internal: `start` (`i`) for a machine with schemas: `i: validate.i(schemas.i, start, schemas.d)`.
 * `start` gets the input schema's value, and the data it makes is checked against its state's.
 *
 * @throws ValidationError S5 for an invalid input, S23 for data start makes that its schema refuses.
 */
export function __validInput(
  schema: unknown,
  start: (input: unknown) => __Step,
  data?: { readonly [leaf: string]: unknown },
): __ValidStart {
  // `start` stays reachable, for @reactre/state/serialize: the wrapper's text is this module's.
  return Object.assign(
    (input: unknown): __Step => {
      let value = input;
      if (schema !== undefined) {
        const result = __validate(schema, input);
        if (result.issues !== undefined)
          throw new ValidationError(
            "S5",
            `the input doesn't match its schema: ${list("input", result.issues)}. Give createActor an input the schema accepts.`,
            { boundary: "input", issues: result.issues },
          );
        value = result.value;
      }
      const step = start(value);
      if (data !== undefined) __check("start", step, data);
      return step;
    },
    { start },
  );
}

/**
 * Internal: throws S23 for the first leaf `step` goes to whose data its state's schema refuses
 * (`start`'s, and ./decided.ts's).
 */
export function __check(by: string, step: __Step, data: { readonly [leaf: string]: unknown }): void {
  for (const { state, data: d } of goes(step)) {
    const issues = data[state] === undefined ? undefined : __validate(data[state], d).issues;
    if (issues !== undefined) throw made(by, { boundary: "data", issues, state });
  }
}

/** Internal: a start wrapped by `__validInput`, with the start it wraps. */
export interface __ValidStart {
  (input: unknown): __Step;
  readonly start: (input: unknown) => __Step;
}

/**
 * Internal: checks a snapshot from outside the build against the states' schemas (`s.d`): its
 * leaf, each region of a parallel node, and each leaf in `history`. For `restoreActor`.
 *
 * @throws ValidationError S7, naming the state and listing the issues.
 */
export function __restored(m: __Compiled, snapshot: __Snapshot): void {
  for (const leaf of [snapshot, ...Object.values(snapshot.history ?? {})]) {
    const bad = refused(m, leaf);
    if (bad !== undefined)
      throw new ValidationError(
        "S7",
        `the saved data of state "${bad.state}" doesn't match its schema: ${list("data", bad.issues)}. Migrate the saved data to the state's schema (and bump setup's version when a shape changes), then restore it.`,
        { boundary: "restored", issues: bad.issues, state: bad.state },
      );
  }
}

/**
 * The validate opt-in: a Standard Schema in setup is checked at runtime (sent events, task results,
 * input, the data transitions make, restored data). `setup({ use: [validate], events: { rename: z.object({ name: z.string() }) } })`.
 */
export const validate: Validate = { x: __validate, v: __validated, i: __validInput, z: __restored };

/** The validate opt-in's type: an interface, so a type error names it `Validate`, not its hooks. */
export interface Validate extends Feature<"validate"> {
  /** Internal: validates a value against a schema (`x` in the table). */
  readonly x: __Validate;
  /** Internal: the validating step (`y: validate.v(inner)`). */
  readonly v: typeof __validated;
  /** Internal: the validating start (`i: validate.i(schema, start, data)`). */
  readonly i: typeof __validInput;
  /** Internal: checks a restored snapshot (`z`). */
  readonly z: typeof __restored;
}
