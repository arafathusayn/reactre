// `matchesState(parent, state)`: a name against a name, without a snapshot: `state` is `parent` or a
// node under it (xstate docs: utilities.md; XState compares state values, here a state is its
// dotted name). A type guard on the name.

/** `matchesState("edit", "edit.draft")` is true; `matchesState("edit", "idle")` is false. */
export function matchesState<P extends string>(parent: P, state: string): state is P | `${P}.${string}` {
  return state === parent || state.startsWith(`${parent}.`);
}
