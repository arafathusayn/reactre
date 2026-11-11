// durable's types: the opt-in marks the machine as one a journaling host runs, and `durable(machine,
// host)` (./index.ts) accepts only such a machine. The machine's types gain nothing else: its
// children, if any, run inside the durable run under its ids, with no opt-in of their own.

import type { AnyConfig, Shape, Uses } from "../../index.ts";
import type { __Kids, __Tree } from "./index.ts";

export type Name = "durable";

declare module "../../internal.ts" {
  interface __Compiled {
    /**
     * The hooks that journal a durable run's children (@reactre/state/durable/children): only a
     * machine with durable and children in use has them, so a run without children ships none.
     */
    readonly dk?: (tree: __Tree) => __Kids;
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
export type ActorOptions<_D extends Shape> = {};
/** `resume`'s fix for a snapshot typed any (`JSON.parse(row.snapshot)`). */
export type AnyResumed =
  "resume takes a value typed any (JSON.parse returns any), so its state and data go unchecked: parse the stored snapshot with migrations(machine) first, or type it as DurableSnapshot";

/** A child's `update` on a durable machine: the host doesn't run it. */
export type Problems<_D extends Shape, C extends AnyConfig> = `${{
  [S in keyof C["states"] & string]: C["states"][S] extends { readonly children: infer K }
    ? {
        [N in keyof K & string]: K[N] extends { readonly update: unknown }
          ? `state "${S}"'s child "${N}" has update, which a durable run can't replay: send the child's events to the parent with sendBack, and handle them in on`
          : never;
      }[keyof K & string]
    : never;
}[keyof C["states"] & string]}`;

/** Effects on a durable host: its handlers replay, so an effect would run again. */
export type ShapeProblems<D extends Shape> = `use lists durable and ${Extract<
  Uses<D>,
  "effects" | "emit" | "spawn"
>}: a durable run replays its handlers, so an effect would run again; make the work a task`;
export type OffProblems<_D extends Shape> = never;
