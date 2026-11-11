// The compiler's feature API: what ./index.ts (the core) gives each feature's compiler
// (./features/<feature>.ts), and what a feature gives back. The core compiles setup, `start`, `on`,
// `task`, `after` and `final`, checks purity and the rest, and writes the table; a feature compiles
// its own options, node keys and handler arguments, and adds its fields to the table.
//
// A feature's compiler only adds what types can't check (../README.md, "The compiler"): what its
// codegen needs written in place, and purity in its handlers (the core checks every handler it is
// asked to compile). A problem the type checker reports is never repeated here: compile past it.
// test/compiler.test.ts's audit runs `bun check` on every compiler case, each feature's included
// (test/features/<feature>/compiler.ts), and fails when one is also a type error.
//
// Every feature's hooks run whether or not setup's `use` lists it, so a machine with a type error
// (a key whose feature is off) still compiles; only a feature in use emits table fields (`emit`).

import type { CallExpression, Expression, Node, ObjectExpression, ObjectProperty, Program } from "oxc-parser";

/** Reports a problem at a node (or an offset), with the fix. */
export type Report = (at: Node | number, message: string) => void;

/** What a feature's compiler gets for one `setup({...})` call. */
export interface ShapeContext {
  /** The shape's name: `const <name> = setup(...)`. */
  readonly name: string;
  /** Setup's argument, by key. */
  readonly options: ReadonlyMap<string, ObjectProperty>;
  /** Setup's states (leaves), events and internal events, by name. */
  readonly states: ReadonlyMap<string, ObjectProperty>;
  readonly events: ReadonlyMap<string, ObjectProperty>;
  readonly internal: ReadonlyMap<string, ObjectProperty>;
  /** The feature's import's local name, when setup's `use` lists it; null when it doesn't. */
  readonly local: string | null;
  readonly report: Report;
  /** A node's source text, as written. */
  readonly src: (node: Node) => string;
  /** The value is `types<T>()` (not a schema). */
  readonly isTypes: (value: Expression) => boolean;
  /** One of setup's maps (like `states`), which must be an object literal written in place. */
  readonly map: (value: Expression | undefined, what: string) => Map<string, ObjectProperty>;
}

/** What a feature's compiler gives for one shape. */
export interface FeatureShape {
  /** Code put where the setup call was (validate's schemas, as written). */
  readonly declarations?: string;
  /** For each machine of the shape. */
  readonly machine?: (ctx: MachineContext) => FeatureMachine;
}

/** What a feature's compiler gets for one `shape.machine({...})` call. */
export interface MachineContext {
  /** The feature's import's local name, when setup's `use` lists it; null when it doesn't. */
  readonly local: string | null;
  /** The shape's leaves. */
  readonly states: readonly string[];
  /** Setup's `use` lists `feature` (a feature whose output depends on another's: durable on children). */
  readonly uses: (feature: string) => boolean;
  /**
   * The build is a development one (`compile(..., { dev: true })`): a feature may emit a wrapper
   * that warns, from `@reactre/state/dev`, where a production build emits the plain value.
   */
  readonly dev: boolean;
  readonly report: Report;
  readonly src: (node: Node) => string;
  /**
   * Compiles a handler of `kind` (the core's, or one in a feature's `kinds`): checks it (purity,
   * casts, data's keys) and returns its code with positional parameters, or null.
   */
  readonly handler: (value: Expression, kind: string) => string | null;
  /** An object literal, or a problem saying it must be one, written in place. */
  readonly literal: (value: Expression, what: string) => ObjectExpression | null;
  /** An object literal's properties by name; spreads and computed keys are problems. */
  readonly properties: (object: ObjectExpression, what: string) => Map<string, ObjectProperty>;
}

/** What a feature's hooks get inside one handler. */
export interface HandlerContext {
  /** The node is a call of `to` or of a feature's move (`back`). */
  readonly isMove: (node: Node) => node is CallExpression;
  /** A move call, compiled to a step. */
  readonly compileMove: (call: CallExpression) => string;
  /**
   * The code of `to(state, data)`'s step, from `data`'s code: the snapshot it makes,
   * `({ state, data, version })`, with the machine's version (`__To`).
   */
  readonly step: (state: string, data: string) => string;
  /** Checks data's keys: an object literal, or the handler's `data`, spreading only `data`. */
  readonly checkKeys: (value: Expression, what: string) => void;
  readonly report: Report;
  readonly properties: (object: ObjectExpression, what: string) => Map<string, ObjectProperty>;
}

/** What a feature's compiler does for one machine. */
export interface FeatureMachine {
  /** Shallow history recorded while compiling this machine; set by the compiler before emit. */
  shallow?: boolean;
  /** A key of node `state` that this feature owns (one of its `keys`). */
  readonly key?: (state: string, key: string, value: Expression) => void;
  /** A call of one of this feature's `moves` (`back(...)`): the step it compiles to. */
  readonly move?: (call: CallExpression, ctx: HandlerContext) => string;
  /**
   * `to(state, data)`: the step (built with `ctx.step`), when `state` is this feature's to compile
   * (a parallel node); else null.
   */
  readonly to?: (state: string, data: Expression, ctx: HandlerContext) => string | null;
  /** A reference to one of this feature's `values` (`enq`): the expression it compiles to. */
  readonly value?: (name: string) => string;
  /** A call of a method of one of this feature's `values` (`enq.cancel("bell")`), in any handler. */
  readonly call?: (method: string, call: CallExpression) => void;
  /**
   * Once the whole machine is compiled, when the feature is in use: checks across its handlers
   * (effects's: each `enq.cancel` takes an id a raise or send of the machine uses).
   */
  readonly done?: () => void;
  /**
   * A handler of a kind whose step reaches the actor outside a step (`Kind.outside`: a timer's, a
   * task's `error`, a child's report), compiled: the code to put in its place. `what` names it in
   * messages ("a timer"), and `state` is the position of its `state` parameter. Called only when the
   * feature is in use: validate checks the data such a handler decides.
   */
  readonly outside?: (code: string, what: string, state: number) => string;
  /** The machine's table fields, once every node is compiled. Called only when the feature is in use. */
  readonly emit?: () => Emitted;
}

/** What a feature adds to a machine's table. */
export interface Emitted {
  /** Table fields, `"key: value"` (each feature has its own keys: ../ARCHITECTURE.md). */
  readonly fields?: readonly string[];
  /** Wraps `start`'s compiled code (`i`). */
  readonly start?: (code: string) => string;
  /** The step hook (`y`): given the hook of the features before it in the table (null: none). */
  readonly step?: (inner: string | null) => string;
  // wave1-statecharts: the node graph composes like the step, so a feature that acts after every
  // move (always, choice, a parent's done, reenter) wraps nested's graph, or stands alone on a flat machine.
  /** The node graph (`g`): given the graph of the features before it in the table (null: none). */
  readonly graph?: (inner: string | null) => string;
  // wave1-statecharts: an event the feature lets callers send (route's `{ type: "route", to }`).
  /** Events callers may send besides setup's (in `e`). */
  readonly events?: readonly string[];
  /** Node runners (`__Runner` expressions) for the general lifecycle. */
  readonly runners?: readonly string[];
  /** A tasks runner in place of the core's (persist's saves deadlines). */
  readonly tasks?: string;
  /**
   * "general": tasks and timers run in the general lifecycle, not the lean one (a hierarchy).
   * "always": the machine has the general lifecycle even without tasks (persist reads it).
   */
  readonly lifecycle?: "general" | "always";
  /** App functions check this opt-in at runtime: `u: { <name>: 1 }`. */
  readonly marker?: boolean;
  /** Effect runner maps (`__EffectRunners` expressions), for the effect registry. */
  readonly effects?: readonly string[];
  /** Builds the dispatcher from the effect runner maps (the effects feature). */
  readonly dispatch?: (maps: readonly string[]) => string;
  // wave1-actors: a feature that needs the actor's options or every move (inspect, spawn's restore)
  // wraps the lifecycle, in table order like the step.
  /** Wraps the lifecycle (`r`): given the lifecycle's code (null: the machine has none). */
  readonly wrap?: (r: string | null) => string;
  /**
   * Import declarations its fields need, beside the feature's own import: code only some machines
   * need, kept out of the feature's value so a bundle holds it only then (durable's children,
   * spawn's restore, delays's saved deadlines). The file gets each once.
   */
  readonly imports?: readonly string[];
}

/**
 * What a feature's compiler gets for the whole file, once, whether or not setup's `use` lists it
 * (a file may only use the feature's functions: `persist(actor)`, `durable(machine, host)`): the
 * file's own code around its machines, which the type checker can't hold to a rule of order or
 * place (a save outside a `try`, a step's key read from the clock).
 */
export interface FileContext {
  readonly file: string;
  readonly program: Program;
  readonly src: (node: Node) => string;
  readonly report: Report;
}

/** A handler kind a feature adds: its destructured names in positional order, and whether it moves. */
export interface Kind {
  readonly params: readonly string[];
  /** It decides a transition: it gets `to` (and the features' moves and values). */
  readonly moves: boolean;
  /**
   * Its step reaches the actor outside a step (through the lifecycle's `go`, with no step hook):
   * what it is, in messages ("a timer"). Features in use may wrap it (`FeatureMachine.outside`).
   */
  readonly outside?: string;
}

/** A feature's compiler: ./features.ts lists every feature's. */
export interface FeatureCompiler {
  /** Setup options it reads (`parallel`, `children`). */
  readonly options?: readonly string[];
  /** Node config keys it compiles (`children`, `done`). */
  readonly keys?: readonly string[];
  /** Handler arguments that compile to a step (`back`). */
  readonly moves?: readonly string[];
  /** Handler arguments that compile to an expression (`enq`). */
  readonly values?: readonly string[];
  /** Handler kinds it adds (a child's `done`). */
  readonly kinds?: { readonly [kind: string]: Kind };
  /** For each setup call. */
  readonly shape?: (ctx: ShapeContext) => FeatureShape;
  /** For the whole file, once, after its use sites are checked (../index.ts). */
  readonly file?: (ctx: FileContext) => void;
}
