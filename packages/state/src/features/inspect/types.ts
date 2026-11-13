// inspect's types (xstate docs: inspection.md, inspect-actor-systems.md): with `use: [inspect]`, an
// actor takes `inspect` (a function given every inspection event) and `logger` (a function given
// each event as a readable line). Off, neither is an option, and the table has nothing of it.

import type { OptIn } from "../../features.ts";
import type { __Effect, __Event, __Refusal, AnyConfig, Shape } from "../../index.ts";

export type Name = "inspect";

/** A snapshot as inspection reports it: any actor's, root or child. */
export interface InspectedSnapshot {
  readonly state: string;
  readonly data: unknown;
}

/**
 * What an inspector gets. `id` names the actor: "root" (or the `id` it was created with), and a
 * child's is its path, `root/upload`, `root/files:a` (keyed).
 *   - `actor`: an actor started, with its first snapshot (`parent`: its parent's id).
 *   - `event`: an event reached the actor (sent, or `internal`: a task's result, a raise), and what
 *     it did: `ok` and the snapshot, or the refusal's `reason`.
 *   - `transition`: the actor moved (from an event, a timer, a child's report), with the effects the
 *     move recorded.
 *   - `stop`: the actor stopped, or ended (`status: "done"`).
 */
export type InspectionEvent =
  | {
      readonly type: "actor";
      readonly id: string;
      readonly parent?: string;
      readonly snapshot: InspectedSnapshot;
    }
  | {
      readonly type: "event";
      readonly id: string;
      readonly event: __Event;
      readonly internal: boolean;
      readonly ok: boolean;
      readonly reason?: __Refusal;
      readonly snapshot: InspectedSnapshot;
    }
  | {
      readonly type: "transition";
      readonly id: string;
      readonly snapshot: InspectedSnapshot;
      readonly effects: readonly __Effect[];
    }
  | {
      readonly type: "stop";
      readonly id: string;
      readonly status: "done" | "stopped";
      readonly snapshot: InspectedSnapshot;
    };

/** An inspector: observes, and must not change the actor (send to it from the app, not from here). */
export type Inspector = (event: InspectionEvent) => void;

declare module "../../internal.ts" {
  interface __Options {
    /** The inspector (`use: [inspect]`). */
    readonly inspect?: Inspector | undefined;
    /** Where each inspection event goes as a readable line (`use: [inspect]`). */
    readonly logger?: ((line: string) => void) | undefined;
    /** The actor's id in inspection: "root", or a child's path. */
    readonly id?: string | undefined;
  }
}

// The registry's parts (see ../../features.ts for what each one is).

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {};
export type Keys<_D extends Shape, _N extends string> = never;
export type OffKeys = never;
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
export type Brand<_D extends Shape, _C extends AnyConfig> = {};
export type ActorOptions<_D extends Shape> = {
  /** Every inspection event of this actor and its children: see `InspectionEvent`. */
  readonly inspect?: Inspector | undefined;
  /** Each inspection event as a readable line: `logger: console.log`. */
  readonly logger?: ((line: string) => void) | undefined;
  /** The actor's id in inspection events ("root" by default). */
  readonly id?: string;
};
/**
 * Off, `inspect` and `logger` need a property named by the fix, which no function has: the error
 * says it ("Property '"inspect needs inspect: add inspect to setup's use (…)"' is missing"). Still a
 * function underneath, so the actor's options stay one type.
 */
export type OffActorOptions = {
  readonly inspect?: Inspector & { readonly [K in `inspect needs inspect: ${OptIn<"inspect">}`]: true };
  readonly logger?: ((line: string) => void) & { readonly [K in `logger needs inspect: ${OptIn<"inspect">}`]: true };
  /** XState's actor id: typed as the fix. */
  readonly id?: `createActor takes no id: the variable that holds the actor names it, and with inspect in use, id names it in inspection events (${OptIn<"inspect">})`;
};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
