// @reactre/state/system (prototype): actor systems (xstate docs: systems.md, system-transitions.md).
//
//   - `createSystem({ registry })`: a registry of actors by key. `system.createActor(machine,
//     { registryKey })` runs a root actor in it, and its children (at any depth) belong to it too;
//     a child spec's `registryKey` (with `use: [system]`) puts that child in the registry while it
//     runs. `system.get(key)` reaches one, typed by the declared registry.
//   - `initialSystem`, `systemTransition` and `advanceSystemTime`: pure transitions of a whole
//     system of machines, as JSON snapshots, with virtual time (./pure.ts).
//
// Design decisions:
//   - A system is made by the app and passed in, not found from inside a transition: a handler is a
//     pure function of its state's data and the event, so it never holds an actor. Sending to a
//     registered actor is the app's (`system.get("x")?.send(...)`), or a child's by name
//     (`enq.sendTo`, the effects feature's).
//   - The opt-in only types a child spec's `registryKey`: it adds nothing to the table, and the
//     children runner registers what has a key.
//   - Keys are unique in a system: registering a second live actor under a key throws S32.

import {
  type __Actor,
  type Actor,
  type ActorInput,
  type ActorOptions,
  type AnyMachine,
  createActor,
  type Feature,
  type Given,
  type Machine,
  type MachineInfo,
  type NotAny,
  type Shape,
  StateError,
  type Status,
} from "../../index.ts";
import type { __Compiled, __Options } from "../../internal.ts";
import type { __System } from "./types.ts";

export {
  advanceSystemTime,
  initialSystem,
  rootOf,
  runSystemTask,
  type SystemActor,
  type SystemEffect,
  type SystemSnapshot,
  type SystemTimer,
  systemTransition,
} from "./pure.ts";
export type { __System } from "./types.ts";

/** The system opt-in: `setup({ use: [system] })` lets a child spec take `registryKey`. */
export interface SystemFeature extends Feature<"system"> {}

/** The system opt-in. It adds nothing to the table. */
export const system: SystemFeature = {};

/** A registry's declaration: keys, and the machine (or actor logic) each one runs. */
export type Registry = { readonly [key: string]: __Compiled };

/** The actor a machine of the registry runs. */
type ActorOf<M> = Actor<MachineInfo<M>["shape"]>;

/** An actor under a key the registry doesn't declare: read it, or narrow it before sending. */
export interface AnyActor {
  readonly snapshot: () => { readonly state: string; readonly data: unknown };
  readonly status: () => Status;
  readonly send: (event: never) => unknown;
  readonly stop: () => void;
}

/** A key of the registry: any string when it declares none. */
type Key<R extends Registry> = [keyof R] extends [never] ? string : keyof R & string;

/** What `system.createActor` takes: `createActor`'s options, and the key to register the root under. */
export type SystemArgs<D extends Shape, R extends Registry> = [ActorInput<D>] extends [undefined]
  ? [options?: ActorOptions<D> & { readonly registryKey?: Key<R> }]
  : [options: ActorOptions<D> & { readonly registryKey?: Key<R> }];

/** A system: its registry, and the root actors it runs. */
export interface System<R extends Registry> {
  /**
   * Runs a machine in this system: it, and its children, belong to it. A machine typed `any` is
   * refused, as the core's `createActor` refuses it.
   */
  readonly createActor: <D extends Shape, M = unknown>(
    this: NotAny<M, AnyMachine>,
    machine: Given<M> & Machine<D>,
    ...options: SystemArgs<D, R>
  ) => Actor<D>;
  /** The actor registered under `key`, while it runs. */
  readonly get: <K extends Key<R>>(key: K) => (K extends keyof R ? ActorOf<R[K]> : AnyActor) | undefined;
  /** Every registered actor, by key. */
  readonly getAll: () => { readonly [K in Key<R>]?: K extends keyof R ? ActorOf<R[K]> : AnyActor };
}

// `createActor`'s overloads type a machine by its shape, which these tables' types don't carry.
const create = createActor as unknown as (m: __Compiled, options: __Options) => __Actor;

/**
 * A system: `createSystem({ registry: { notifier: notifierMachine } })` types `system.get("notifier")`
 * and the `registryKey` its root actors take. Without a registry, keys are any string.
 */
export function createSystem<R extends Registry = {}>(_options?: { readonly registry?: R }): System<R> {
  // The registry's declaration is for the types: at runtime, keys are strings.
  // The cast: `System<R>` types by shape what the runtime holds as tables and actors.
  return make() as unknown as System<R>;
}

function make(): __System & {
  readonly createActor: (m: __Compiled, options?: __Options) => __Actor;
  readonly get: (key: string) => __Actor | undefined;
  readonly getAll: () => { readonly [key: string]: __Actor };
} {
  const registry = new Map<string, __Actor>();
  const sys = {
    "~add"(key: string, actor: __Actor): void {
      const was = registry.get(key);
      if (was !== undefined && was !== actor && was.status() === "active")
        throw new StateError(
          "S32",
          `registryKey "${key}" is taken by another running actor of this system: give each actor its own key, or stop the other first.`,
        );
      registry.set(key, actor);
    },
    "~del"(key: string, actor: __Actor): void {
      if (registry.get(key) === actor) registry.delete(key);
    },
    get: (key: string) => registry.get(key),
    getAll: () => Object.fromEntries(registry),
    createActor(m: __Compiled, options?: __Options): __Actor {
      const actor = create(m, { ...options, system: sys });
      const key = options?.registryKey;
      if (key === undefined) return actor;
      // The root leaves the registry when it stops: its stop, then the key's.
      const root: __Actor = {
        ...actor,
        stop() {
          actor.stop();
          sys["~del"](key, root);
        },
      };
      sys["~add"](key, root);
      return root;
    },
  };
  return sys;
}
