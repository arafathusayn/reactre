// @reactre/state's internal contract: what the compiler writes, what the core runtime (./index.ts)
// reads, and what the runtime modules (./run.ts, ./tasks.ts, and each feature's
// ./features/<feature>/index.ts) plug in with. Nothing here is for apps: every name starts with `__`.
//
// Each module is imported only by compiled code whose machine uses it (a feature only when setup's
// `use` lists it), so a machine without tasks, timers or features ships none of them. Changing a
// type here changes every module: change it only by adding. A feature's own table fields are
// declared in its types.ts, by augmenting `__Compiled` (see ../ARCHITECTURE.md).
//
// Terms:
//   - A leaf is a state with data: a key of setup's `states` ("idle", "edit.draft").
//   - A node is a leaf, or a parent: a proper prefix of a leaf's name ("edit"). A parent has no data
//     of its own. A parallel node ("player") has regions ("player.playback"), each with its own leaf.
//   - The snapshot is `{ state, data, version }`. For a parallel node, `state` is the node and
//     `data` is its regions: `{ playback: { state: "player.playback.playing", data }, ... }`.

/** Internal: an event as the runtime holds it. */
export interface __Event {
  readonly type: string;
}

/** Internal: a state and its data: the snapshot's part, or one region's. */
export interface __Leaf {
  readonly state: string;
  readonly data: unknown;
}

/** Internal: a snapshot as the runtime holds it. */
export interface __Snapshot extends __Leaf {
  readonly version: number;
  /**
   * For each parent the machine goes `back` to: the leaf (or a parallel node's regions) it held
   * when it was last left. Only machines that use `back` have it.
   */
  readonly history?: { readonly [parent: string]: __Leaf };
}

/**
 * Internal: a snapshot with what its running nodes saved (timers' deadlines, children's
 * snapshots), from `persist`. `restoreActor` takes it, and gives each runner its part back.
 */
export interface __Persisted extends __Snapshot {
  /** By node, then by runner id. */
  readonly run?: { readonly [node: string]: { readonly [runner: string]: unknown } };
}

/**
 * Internal: `to(state, data)` compiled, `({ state, data, version })`: the snapshot itself, so a flat
 * step allocates nothing but its snapshot. For a parallel node, `data` holds one `to` per region:
 * `{ state: "player", data: { playback: { state, data, version }, volume: ... }, version }`, which
 * the graph turns into the regions' units (`{ state, data }`, never the step: a region has no
 * `version`).
 */
export interface __To {
  readonly state: string;
  readonly data: unknown;
  readonly version: number;
}

/**
 * Internal: `back(parent, fallback, shallow?)` compiled, `{ b: parent, t: fallback, s?: shallow }`:
 * the unit the parent held when it was last left, or `fallback`. Shallow history's steps are for
 * the parent's direct children that are parents (@reactre/state/history).
 */
export interface __Back {
  readonly b: string;
  readonly t: __Step;
  readonly s?: { readonly [child: string]: __Step };
}

/** Internal: `reenter(state, data)` compiled, `{ r: to(state, data) }` (@reactre/state/reenter). */
export interface __Reenter {
  readonly r: __To;
}

/** Internal: a transition's result: a `to`, or, with the features that add them, a `back` or a `reenter`. */
export type __Step = __To | __Back | __Reenter;

/** Internal: why a step didn't move (the public `Refusal`). */
export type __Refusal = "unhandled" | "declined" | "unknown" | "invalid" | "inactive";

/** Internal: what a step returns. */
export type __Result =
  | {
      readonly ok: true;
      readonly snapshot: __Snapshot;
      /**
       * The effects the transition recorded (`enq.*` in a handler, with `effects` in use), as data:
       * the lifecycle runs them after the move (`__Dispatch`). `transition` returns them, unrun.
       */
      readonly fx?: readonly __Effect[];
    }
  | {
      readonly ok: false;
      readonly reason: __Refusal;
      readonly snapshot: __Snapshot;
      readonly issues?: readonly __Issue[];
      /**
       * For an internal event (a task's result) that its schema refused: the error the task's
       * `error` handler gets (StateError S6), built by @reactre/state/validate's step.
       */
      readonly error?: unknown;
    };

/** Internal: a validation problem, Standard Schema's issue. */
export interface __Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

/**
 * Internal: an active node, as a runner sees it. `node` is its name in the machine's states; `state`
 * and `data` are the leaf under it when it was entered (for a leaf, itself). Read `current()` for
 * what is under it now.
 */
export interface __Node extends __Leaf {
  readonly node: string;
}

/** Internal: what the core gives a runner for one active node. */
export interface __RunContext {
  /**
   * An internal event for the machine (a task's result, a child's report). Returns the step's
   * result (`reason: "invalid"` when its schema refused it), or null when dropped: the node exited.
   */
  readonly deliver: (event: __Event) => __Result | null;
  /** A transition the node decides (a timer, a task's error, a child's `done`). Dropped once the node exits. */
  readonly go: (step: __Step) => void;
  /** The actor's clock, in milliseconds: `Date.now` unless the actor was given another. */
  readonly now: () => number;
  /** The leaf under the node now: handlers of timers and errors read the current data. */
  readonly current: () => __Leaf;
  /** What this runner's `save` returned for this node, when the actor was restored from it. */
  readonly saved: unknown;
}

/** Internal: a runner's work for one active node. */
export interface __Running {
  /** The node exits (or the actor stops): abort, cancel, stop children. */
  readonly stop: () => void;
  /** The node stays active while the leaf under it moved, or its data changed. */
  readonly update?: (now: __Leaf) => void;
  /** JSON for `persist`: given back as `saved` on restore. */
  readonly save?: () => unknown;
  /** A child actor, by name, and by key in a keyed collection (`child(actor, name, key)`). */
  readonly child?: (name: string, key?: string) => unknown;
}

/**
 * Internal: what `createActor` and `restoreActor` give the lifecycle: the actor's options as the
 * app passed them, and, on restore, the persisted snapshot's `run`. A feature that takes an actor
 * option (`inspect`, say) adds it here, by augmenting this interface in its types.ts.
 */
export interface __Options {
  readonly input?: unknown;
  /** The actor's clock, in milliseconds: `Date.now` unless the actor was given another. */
  readonly now?: (() => number) | undefined;
  /** What each running node saved (`persist`), when the actor was restored. */
  readonly run?: __Persisted["run"];
}

/** Internal: a machine's runners at work for one actor. */
export interface __Lifecycle {
  /**
   * `move` applies a result (the actor's own: it enters the snapshot and tells listeners);
   * `current` is the actor's snapshot; `options` what the actor was created (or restored) with.
   */
  (
    m: __Compiled,
    move: (result: __Result) => __Result,
    current: () => __Snapshot,
    options: __Options | undefined,
  ): __Live;
}

/** Internal: what `__Lifecycle` returns, which the actor holds (`actor["~r"]`). */
export interface __Live {
  /**
   * The runners' work, by active node, outermost first: only the general lifecycle (./run.ts) has
   * it. The lean one (./tasks.ts's `__lean`, for a flat machine with tasks or timers) keeps none.
   */
  readonly works?: __Works;
  /** The machine, for app functions that check an opt-in at runtime (`persist`): ./run.ts sets it. */
  readonly m?: __Compiled;
  /**
   * The actor moved to `next` (at the start too), by `result` (the start's has no effects).
   * `active` is false once it's done.
   */
  readonly enter: (next: __Snapshot, active: boolean, result: __Result) => void;
  readonly stop: () => void;
}

/**
 * Internal: a step in place of the flat one (`__flat` in ./index.ts), for a machine with a hierarchy,
 * schemas or effects. A feature's hook may wrap another's (`validate`'s wraps `nested`'s); the
 * compiler composes them in its feature table's order. `internal` is true for an event from the
 * machine's own tasks or children (not `send`).
 */
export type __StepHook = (m: __Compiled, from: __Snapshot, event: __Event, internal: boolean) => __Result;

// #region The effect registry (for `effects` and `spawn`; wave 1 implements them)
//
// Effects are data. A handler records them during its pure transition (with `effects` in use, a
// handler's argument has `enq`; `enq.raise(...)`, `enq.log(...)` each push a descriptor), and the
// step returns them on its result's `fx`. Nothing runs during the transition: `transition()` returns
// them unrun, so a test can assert them. An actor's lifecycle runs them after the move, through the
// dispatcher the compiler puts in `r` (`__run(runners, dispatch)`).
//
// How `enq` reaches a handler: the compiler compiles every reference to a destructured `enq` into
// the effects feature value's recorder (`<effects import>.enq`). The effects feature's step hook
// (`y`) opens a recording before it calls the inner step, and closes it after, putting what was
// recorded on the result's `fx`. A handler stays a pure function of its arguments: what it records
// goes on its own result and nowhere else.
//
// Runners are registered per effect type by the feature that defines the type, as data: each
// feature value carries a `__EffectRunners` map (`effects`: raise, cancel, log, sendTo, emit, effect;
// `spawn`: spawn, stop, listen, subscribeTo), the compiler lists the maps of the features in use,
// and the effects feature's `__Dispatch` builder merges them. No module registers anything at
// import time, so a bundle drops every runner whose feature isn't in use.

/** Internal: an effect, recorded as data during a pure transition. `type` names its runner. */
export interface __Effect {
  readonly type: string;
}

/** Internal: what an effect's runner gets: the actor's moves, its clock, and where it is now. */
export interface __EffectContext {
  /** An internal event for the machine (`enq.raise`): the step's result, or null once stopped. */
  readonly deliver: (event: __Event) => __Result | null;
  /** A transition decided outside a handler (a delayed raise's target, say). */
  readonly go: (step: __Step) => void;
  readonly now: () => number;
  /** The snapshot after the transition that recorded the effect. */
  readonly snapshot: __Snapshot;
  /** The actor's runners at work: a spawned child lives here, so `persist` and `child` find it. */
  readonly live: __Live;
}

/** Internal: runs one type of effect. */
export type __EffectRunner = (effect: __Effect, ctx: __EffectContext) => void;

/** Internal: a feature's effect runners, by effect type. */
export type __EffectRunners = { readonly [type: string]: __EffectRunner | undefined };

/**
 * Internal: runs a transition's effects, in order, after the move: the effects feature's builder
 * makes it from the runner maps of the features in use. An effect with no runner is a feature
 * missing from `use`: throw a StateError naming its import.
 */
export type __Dispatch = (effects: readonly __Effect[], ctx: __EffectContext) => void;

// #endregion

/**
 * Internal: the hierarchy of a machine with parents, parallel nodes or `back`
 * (@reactre/state/nested). The core and the runners ask it; a flat machine has none.
 */
export interface __Graph {
  /** The active nodes of a snapshot, outermost first. */
  readonly nodes: (m: __Compiled, s: __Leaf) => __Node[];
  /** A step's snapshot from `from`: regions, history. */
  readonly snap: (m: __Compiled, step: __Step, from?: __Snapshot) => __Snapshot;
}

/**
 * Internal: what a move does to the active nodes (run.ts's `__changes`): exit (innermost first),
 * enter (outermost first), and stay (only the nodes whose leaf changed: their runners get `update`).
 */
export interface __Changes {
  readonly exit: readonly __Node[];
  readonly enter: readonly __Node[];
  readonly stay: readonly __Node[];
}

export type __Works = Map<string, { readonly id: string; readonly work: __Running }[]>;

/**
 * Internal: runs one kind of node behaviour (tasks and timers, children). The compiler lists the
 * ones a machine uses in `r` (`__run([...runners])`), which starts each for every node it enters.
 */
export interface __Runner {
  /** Its key in a persisted snapshot's `run`. */
  readonly id: string;
  /** Start the node's work; returns null when this runner has nothing for the node. */
  readonly start: (m: __Compiled, node: __Node, ctx: __RunContext) => __Running | null;
}

/** Internal: a handler compiled: `(data, event, state) => step | null`. */
export type __Handler = (data: unknown, event: __Event, state: string) => __Step | null;

/** Internal: a child actor of a node, compiled. */
export interface __Child {
  /** The child's machine. */
  readonly m: __Compiled;
  /** Its input, from the leaf under the node at entry. */
  readonly i?: (data: unknown, state: string) => unknown;
  /**
   * The child ended in a final state: `output` is its last snapshot's `{ state, data }`. `key` is
   * the child's key in a keyed collection (`k`).
   */
  readonly d?: (data: unknown, output: __Leaf, state: string, key?: string) => __Step | null;
  /** The child moved: `child` is its new `{ state, data }`. `key` as for `d`. */
  readonly u?: (data: unknown, child: __Leaf, state: string, key?: string) => __Step | null;
  /**
   * A keyed collection instead of one child: the children the node's data asks for now, as
   * `[key, input]`. Reconciled on entry and on each `update`: new keys start, missing keys stop.
   */
  readonly k?: (data: unknown, state: string) => readonly (readonly [key: string, input: unknown])[];
}

/**
 * Internal: validates a value against a Standard Schema, synchronously. Returns the value to use
 * (a schema may transform it) or the issues.
 */
export type __Validate = (
  schema: unknown,
  value: unknown,
) => { readonly value: unknown; readonly issues?: undefined } | { readonly issues: readonly __Issue[] };

/** Internal: a compiled machine. */
export interface __Compiled {
  /** The shape's version. */
  readonly v: number;
  /** The events callers may send. */
  readonly e: { readonly [event: string]: 1 | undefined };
  /** start. */
  readonly i: (input: unknown) => __Step;
  /**
   * Every node with handlers (leaves and parents), by event. A leaf without handlers is here
   * with `{}`, so its name is known.
   */
  readonly o: { readonly [node: string]: { readonly [event: string]: __Handler | undefined } | undefined };
  /** The final leaves. */
  readonly f?: { readonly [leaf: string]: 1 | undefined };
  /** The parallel nodes, with their regions' names. */
  readonly p?: { readonly [node: string]: readonly string[] | undefined };
  /** A parallel node's `done`: every region is in a final leaf. Gets the regions. */
  readonly n?: { readonly [node: string]: ((regions: unknown) => __Step) | undefined };
  /** The parents `back` goes to: their last leaf is kept in the snapshot's `history`. */
  readonly h?: { readonly [parent: string]: 1 | undefined };
  /** Each node's task: run, and error. */
  readonly t?: {
    readonly [node: string]:
      | readonly [
          run: (data: unknown, signal: AbortSignal, state: string) => Promise<__Event>,
          error: (data: unknown, error: unknown, state: string) => __Step,
        ]
      | undefined;
  };
  /** Each node's timers: milliseconds and handler. */
  readonly a?: {
    readonly [node: string]:
      readonly (readonly [ms: number, handler: (data: unknown, state: string) => __Step])[] | undefined;
  };
  /** Each node's children, by name. */
  readonly c?: { readonly [node: string]: { readonly [name: string]: __Child } | undefined };
  /** Schemas, for runtime validation: events' (sent and internal), input's, and each leaf's data. */
  readonly s?: {
    readonly e?: { readonly [event: string]: unknown };
    readonly i?: unknown;
    readonly d?: { readonly [leaf: string]: unknown };
  };
  /** The validator, when there are schemas (@reactre/state/validate). */
  readonly x?: __Validate;
  /**
   * Checks a restored snapshot's data against the states' schemas (throws StateError S7):
   * @reactre/state/validate's `__restored`, only when some state has a schema. `restoreActor` calls
   * it after its own checks.
   */
  readonly z?: (m: __Compiled, snapshot: __Snapshot) => void;
  /** The step, when the flat one isn't enough: a hierarchy, schemas (see `__StepHook`). */
  readonly y?: __StepHook;
  /**
   * The lifecycle of the runners this machine needs. A flat machine with tasks or timers only gets
   * the lean one, `__lean` (@reactre/state/tasks). Anything more gets the general one,
   * `__run([__tasks, children.r, ...], dispatch?)` (@reactre/state/run).
   */
  readonly r?: __Lifecycle;
  /**
   * The opt-ins an app function checks at runtime, by feature name (`persist`, `durable`): code the
   * type checker can't see (a machine from an untyped definition) gets a StateError naming the import.
   */
  readonly u?: { readonly [feature: string]: 1 | undefined };
  /** The node graph, for a machine with parents, parallel nodes or `back` (@reactre/state/nested). */
  readonly g?: __Graph;
  /** Development freezes data and bounds listener notification rounds; omitted in production. */
  readonly d?: ((data: unknown) => unknown) & {
    /** M51: the actor's round check, made once (`d.round()`), called with `0` at a root move and `1` per further round. */
    readonly round?: () => (told: 0 | 1) => void;
  };
}
