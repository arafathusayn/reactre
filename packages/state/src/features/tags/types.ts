// tags' types: `tags`, `meta` and `description` on any node, final ones too. Tags label states that
// share a meaning (`hasTag(machine, snapshot, "busy")`), meta is static JSON about a node
// (`getMeta(machine, snapshot)`), and a description says what the node is for (`getStateNodes`).
// The machine's type carries the tags and the meta written, so the helpers take only those.

import type { AnyConfig, Shape } from "../../index.ts";

declare module "../../internal.ts" {
  interface __Compiled {
    /** Each node's tags, meta and description (@reactre/state/tags). */
    readonly k?: {
      readonly [node: string]: readonly [tags: readonly string[], meta?: unknown, description?: string] | undefined;
    };
  }
}

export type Name = "tags";

/** A JSON value: what meta may hold. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** The tags a machine's config writes. */
export type TagsOf<C extends AnyConfig> = {
  [S in keyof C["states"]]: C["states"][S] extends { readonly tags: readonly (infer T extends string)[] } ? T : never;
}[keyof C["states"]];

/** The meta a machine's config writes. */
export type MetaOf<C extends AnyConfig> = {
  [S in keyof C["states"]]: C["states"][S] extends { readonly meta: infer M } ? M : never;
}[keyof C["states"]];

export type Options = {};
export type Needs = never;
export type State<_D extends Shape, _N extends string> = {
  /** Labels this node shares with others of the same meaning: `hasTag(machine, snapshot, "busy")`. */
  readonly tags?: readonly string[];
  /** Static JSON about this node, written in place: `getMeta(machine, snapshot)`. */
  readonly meta?: Json;
  /** What this node is for, for people and tools (`getStateNodes`, `toDirectedGraph`). */
  readonly description?: string;
};
export type Keys<_D extends Shape, _N extends string> = "tags" | "meta" | "description";
/**
 * A final state takes tags, meta and a description too (XState's do): ../../index.ts's `Config`
 * and its check of final states. Off, each is a problem naming the import, as on any node.
 */
export type FinalTags = State<Shape, string>;
export type FinalKey = Keys<Shape, string>;
export type OffKeys = "tags" | "meta" | "description";
export type Args<_D extends Shape, _N extends string> = {};
export type Deciders<_SC> = never;
/** The tags and meta written, for `hasTag` and `getMeta`. */
export type Brand<_D extends Shape, C extends AnyConfig> = {
  readonly "~tags": TagsOf<C>;
  readonly "~meta": MetaOf<C>;
};
export type ActorOptions<_D extends Shape> = {};
export type Problems<_D extends Shape, _C extends AnyConfig> = never;
export type ShapeProblems<_D extends Shape> = never;
export type OffProblems<_D extends Shape> = never;
