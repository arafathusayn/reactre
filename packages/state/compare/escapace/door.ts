// test/fixtures/door.ts in @escapace/fsm: its builder declares states, then actions, then a
// context, then transitions (`[action, predicate]` for the guard, and a reducer for the target's
// context). Its context may be a union tagged by `state`, which its types narrow per state:
// per-state data, as here. `interpret` makes the service (`do`, `subscribe`, `state`, `context`);
// a service has no `stop`, and there is no pure transition (drafts are speculative copies of a
// service, not a transition function).
//
// Its builder's types don't survive this repository's checker: each `.state(...)` after the first
// takes `never` (the model's reducer collapses to the general identifier type), so the builder and
// the service are used through the small typed views below. The runtime calls are the library's.
//
// No job port: the library has no tasks, effects or timers.

import { interpret, stateMachine, type StateMachineInterface } from "@escapace/fsm";

export type DoorContext =
  | { readonly state: "closed" }
  | { readonly state: "open"; readonly by: string }
  | { readonly state: "locked"; readonly code: string };
type Name = "push" | "close" | "lock" | "unlock";
interface Action {
  readonly type: Name;
  readonly payload: { readonly by: string; readonly code: string };
}
type Reducer = (context: DoorContext, action: Action) => DoorContext;

/** The builder's methods, as the door calls them (the package ships no README; this follows its
 * declarations). */
interface Builder {
  state(state: DoorContext["state"]): Builder;
  initial(state: DoorContext["state"]): Builder;
  action(action: Name): Builder;
  context(context: () => DoorContext): Builder;
  transition(
    source: DoorContext["state"],
    action: Name | [Name, (context: DoorContext, action: Action) => boolean],
    target: DoorContext["state"],
    reducer: Reducer,
  ): Builder;
  done(): StateMachineInterface;
}

/** The service, as the door uses it. */
export interface DoorService {
  readonly state: DoorContext["state"];
  readonly context: DoorContext;
  do(action: "push", payload: { by: string }): boolean;
  do(action: "close"): boolean;
  do(action: "lock" | "unlock", payload: { code: string }): boolean;
  subscribe(subscription: (change: { readonly state: DoorContext["state"] }) => void): () => void;
}

const builder = stateMachine as unknown as () => Builder;

export const doorMachine = builder()
  .state("closed")
  .state("open")
  .state("locked")
  .initial("closed")
  .action("push")
  .action("close")
  .action("lock")
  .action("unlock")
  .context(() => ({ state: "closed" }))
  .transition("closed", "push", "open", (_, action) => ({ state: "open", by: action.payload.by }))
  .transition("closed", "lock", "locked", (_, action) => ({ state: "locked", code: action.payload.code }))
  .transition("open", "close", "closed", () => ({ state: "closed" }))
  .transition(
    "locked",
    ["unlock", (context, action) => context.state === "locked" && context.code === action.payload.code],
    "closed",
    () => ({ state: "closed" }),
  )
  .done();

export const createDoor = (): DoorService => interpret(doorMachine) as unknown as DoorService;
