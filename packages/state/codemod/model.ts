// What the codemod reads out of an XState machine, before it writes the @reactre/state one.

import type { Expression, Node, ObjectExpression, TSType } from "oxc-parser";

import type { Fn } from "./ast.ts";
import type { Env } from "./expr.ts";

/** Something to fix by hand: a `// TODO(@reactre/state): …` at the spot, and a report entry. */
export interface Todo {
  /** The source offset it is about. */
  readonly at: number;
  readonly message: string;
}

/**
 * How names in a piece of XState code map to the output's: which name holds the context, the
 * event, v5's whole argument object (`({ context, event })` written as `args`), v6's `guards`, and
 * names replaced by text (an inlined guard's parameters).
 */
export interface Scope {
  readonly ctx: ReadonlySet<string>;
  readonly event: ReadonlySet<string>;
  readonly args: ReadonlySet<string>;
  readonly guards: ReadonlySet<string>;
  /** Names to replace by code: an inlined guard's parameters, by the call's arguments. */
  readonly params: ReadonlyMap<string, Code>;
  /** v5 guard params (`{ type, params }`): the guard's parameter, and the params given; `params.x` becomes their `x`. */
  readonly guardParams: { readonly name: string; readonly value: Code } | null;
}

/** An expression from the source, with the scope its names are read in. */
export interface Code {
  /** An expression, or a whole function body (for what a v6 function reads). */
  readonly node: Expression | Node;
  readonly scope: Scope;
}

/**
 * One context field written by a transition, in order. A write sees the transition's first `seen`
 * writes: those of the assigns before its own. The property assigners of one `assign({...})` (or
 * one context patch) all read the context before it, as XState runs them.
 */
export interface Write {
  readonly field: string;
  readonly code: Code;
  readonly seen: number;
}

/** A condition: a guard, written as an expression. */
export type Cond =
  | { readonly kind: "code"; readonly code: Code }
  | { readonly kind: "and" | "or"; readonly items: readonly Cond[] }
  | { readonly kind: "not"; readonly item: Cond }
  | { readonly kind: "todo"; readonly at: number; readonly text: string }
  /** A call of a stub the output declares (a guard Stately exported without a body): `name(params)`. */
  | { readonly kind: "stub"; readonly name: string; readonly params: Code | null }
  /** A guard setup's `guards` declares (`provide`), called in the handler: `guards.name()`. */
  | { readonly kind: "named"; readonly name: string };

/**
 * A function the output declares for the user to write: an implementation the source names but
 * doesn't write (a Stately export's stubs, or a name it never defines). It keeps the source's
 * behaviour until it is written.
 */
export interface Stub {
  readonly kind: "guard" | "task";
  /** The source's name for it. */
  readonly source: string;
  /** Its name in the output. */
  readonly name: string;
  /** Its declaration, as written in the output. */
  readonly text: string;
  readonly todo: Todo;
}

/**
 * An argument of an effect: code from the source (rewritten where it lands), a function of it run
 * later (`() => code`: an action written inline, whose body reads the data), or text as is.
 */
export type Arg =
  | { readonly kind: "code"; readonly code: Code }
  | { readonly kind: "thunk"; readonly code: Code }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, Arg])[] };

/**
 * An effect (`effects`), run after the transition: `enq(...args)` or `enq.method(...args)`, or
 * effects under a condition (from `enqueueActions`' `check`). `seen` is how many of its
 * transition's writes come before it: XState's actions after an `assign` see the new context.
 */
export type Effect =
  | {
      readonly kind: "enq";
      readonly at: number;
      readonly method: string | null;
      readonly args: readonly Arg[];
      readonly seen: number;
    }
  | {
      readonly kind: "when";
      readonly at: number;
      readonly cond: Cond;
      readonly then: readonly Effect[];
      readonly otherwise: readonly Effect[];
      readonly seen: number;
    };

/** A named action or guard setup declares (`provide`): its implementation as written in the output. */
export interface ActionDef {
  readonly name: string;
  readonly text: string;
  /** A stub's TODO. */
  readonly todo: Todo | null;
}

/** A line of the report that isn't a TODO: what the codemod did that a reader should know. */
export interface Note {
  readonly at: number;
  readonly message: string;
}

/** A target as written: one or more state references, resolved against the node that declares it. */
export interface TargetSpec {
  readonly refs: readonly string[];
  readonly at: number;
}

/** One branch of an object or array transition. */
export interface Branch {
  readonly at: number;
  readonly guard: Cond | null;
  /** null: targetless, the state stays. */
  readonly target: TargetSpec | null;
  /** In order, or "opaque" when they can't be read field by field. */
  readonly writes: readonly Write[] | "opaque";
  readonly todos: readonly Todo[];
  /** Its `description`, kept as a comment. */
  readonly description: string | null;
  /** Its actions' effects, in order. */
  readonly effects: readonly Effect[];
  /** `reenter: true`: the move to its own leaf exits and enters it again (`reenter`). */
  readonly reenter: boolean;
}

/** One `return` of a v6 transition function (or one result of its expression body). */
export interface Site {
  /** The returned expression (an object literal), or the return statement / expression to replace. */
  readonly node: Node;
  /** The text range to replace in the function. */
  readonly start: number;
  readonly end: number;
  /** "null": no transition (`undefined`, no value). */
  readonly kind: "to" | "null";
  readonly target: TargetSpec | null;
  readonly writes: readonly Write[] | "opaque";
  /** A bare `return;`: it becomes `return null;`. */
  readonly statement: boolean;
  /** `reenter: true` (`reenter`). */
  readonly reenter: boolean;
}

/** A transition: branches (string, object, array forms), or a v6 function. */
export type Handler =
  | { readonly kind: "branches"; readonly at: number; readonly end: number; readonly branches: readonly Branch[] }
  | {
      readonly kind: "fn";
      readonly at: number;
      readonly end: number;
      readonly fn: Fn;
      readonly scope: Scope;
      readonly sites: readonly Site[];
      /** The body can end without a return: `return null` is added. */
      readonly fallsThrough: boolean;
      readonly todos: readonly Todo[];
      /** v6's `enq` (the second parameter), when its calls are @reactre/state's (`effects`): its name. */
      readonly enq: string | null;
    };

/** A v6 `entry` or `exit` function: `({ context }, enq) => { ... }`, rewritten in place (`effects`). */
export interface FnEffects {
  readonly fn: Fn;
  readonly scope: Scope;
  readonly enq: string | null;
}

export interface Timer {
  readonly at: number;
  readonly end: number;
  /** The duration as @reactre/state writes it ("5s"), or null when it can't be read. */
  readonly duration: string | null;
  readonly handler: Handler;
  /** A delay setup's `delays` computes from the data (`delays`): the key is its name. */
  readonly named: boolean;
}

/** A delay computed from the context (`delays`): setup's `delays: { name: ({ data }) => ... }`. */
export interface DelayDef {
  readonly name: string;
  readonly code: Code;
}

export interface Invoke {
  readonly at: number;
  readonly end: number;
  /** The internal event's name prefix and the child's name. */
  readonly id: string;
  /** A task, a child machine, or a child of actor logic (`logic`: a callback, an observable). */
  readonly kind: "task" | "child" | "logic";
  /** The function the task calls (a module-level name), or the child machine's or logic's name. */
  readonly logic: string;
  /** A logic's events sent back to its parent: they are handled in the child's `on`. */
  readonly sendsBack: readonly string[];
  /** The parameters the logic's function destructures: `input`, `signal`. */
  readonly logicParams: readonly string[];
  readonly input: Code | null;
  readonly onDone: Handler | null;
  readonly onError: Handler | null;
}

export type NodeType = "atomic" | "compound" | "parallel" | "final" | "history";

/** A state node of the machine. The root has no key and an empty name. */
export interface SNode {
  readonly key: string;
  /** Dotted, from the root: "edit.draft". */
  readonly name: string;
  readonly parent: SNode | null;
  readonly at: number;
  readonly end: number;
  type: NodeType;
  id: string | null;
  initial: TargetSpec | null;
  readonly children: SNode[];
  readonly on: Map<string, Handler>;
  readonly after: Timer[];
  readonly invokes: Invoke[];
  onDone: Handler | null;
  /** A history node's default target and depth. */
  history: { readonly deep: boolean; readonly target: TargetSpec | null } | null;
  readonly todos: Todo[];
  /** v6 typestates: this state's own context type, from setup's `states`. */
  typestate: ReadonlyMap<string, Field> | null;
  /** Its `description` (`tags`). */
  description: string | null;
  /** `tags` and `meta`, as written (`tags`). */
  tags: string | null;
  meta: string | null;
  /** `entry` and `exit` (`effects`): actions, or a v6 function. */
  entry: readonly Effect[] | FnEffects;
  exit: readonly Effect[] | FnEffects;
  /** `always` (`always`). */
  always: Handler | null;
  /** `timeout` (a number, a delay's name, or a function of the data), with `onTimeout` (`timeout`). */
  timeout: {
    readonly at: number;
    readonly value: Arg;
    /** A delay setup computes from the data, by name. */
    readonly delay: string | null;
    readonly handler: Handler;
  } | null;
}

/** A context field or an event payload field. */
export interface Field {
  readonly name: string;
  /** The type as written. */
  readonly type: string;
  readonly node: TSType | null;
  readonly optional: boolean;
}

/** An event the shape declares. */
export interface EventInfo {
  readonly name: string;
  /** What setup's `events` gets: `types<{ … }>()`, or a schema expression as written. */
  readonly value: string;
  /** Its fields, when known. */
  readonly fields: ReadonlyMap<string, Field> | null;
}

/** The machine's context: its fields (when known) and its type as written. */
export interface ContextInfo {
  readonly fields: ReadonlyMap<string, Field> | null;
  /** The whole type, for states that keep it: a type's text, or a schema expression. */
  readonly whole: string | null;
  /** `whole` is a schema expression (used as is in setup's states), not a type. */
  readonly schema: boolean;
  /** The initial context: an object literal, or a function of the input. */
  readonly initial: ObjectExpression | null;
  readonly initialScope: Scope | null;
  /** The input parameter's name in a context function. */
  readonly inputName: string | null;
}

/** A machine, read. */
export interface MachineModel {
  /** The variable it is assigned to. */
  readonly name: string;
  readonly exported: boolean;
  /** The statement to replace. */
  readonly statement: Node;
  readonly at: number;
  readonly root: SNode;
  readonly context: ContextInfo;
  readonly events: Map<string, EventInfo>;
  /** Events the source declared and no state handles. */
  readonly unhandled: string[];
  readonly input: string | null;
  readonly version: number | null;
  readonly todos: Todo[];
  /** `setup(...)` declared as its own statement, to remove. */
  readonly setupStatement: Node | null;
  /** Module-level `createAsyncLogic` / `fromPromise` definitions to rewrite as plain functions. */
  readonly logic: Map<string, LogicDef>;
  /** The module, with this machine's named guards. */
  readonly env: Env;
  /** Functions the output declares for the user to write, by the source's name. */
  readonly stubs: ReadonlyMap<string, Stub>;
  /** Report lines that aren't TODOs. */
  readonly notes: readonly Note[];
  /** Setup's named actions (`provide`), by name. */
  readonly actions: ReadonlyMap<string, ActionDef>;
  /** Setup's named guards (`provide`): the ones that can't be inlined, as they aren't pure. */
  readonly guards: ReadonlyMap<string, ActionDef>;
  /** Setup's delays computed from the data (`delays`), by name. */
  readonly delays: ReadonlyMap<string, DelayDef>;
  /** Setup's `emitted` events (`emit`): each one's payload type. */
  readonly emitted: ReadonlyMap<string, string>;
  /** Machines a handler spawns (`spawn`), by name: setup's `children`. */
  readonly spawned: ReadonlyMap<string, string>;
  /** The opt-ins what was read needs, beyond the tree's own (nested, parallel, history, children). */
  readonly uses: ReadonlySet<string>;
  /** Names imported from a feature's entry besides the feature: entry to names. */
  readonly imports: ReadonlyMap<string, ReadonlySet<string>>;
}

/** An async logic definition: `const store = createAsyncLogic({ run })`, rewritten to `const store = run`. */
export interface LogicDef {
  readonly name: string;
  /** The call to replace. */
  readonly call: Expression;
  readonly fn: Fn;
  /** A parameter type to add, from `fromPromise<Output, Input>`. */
  readonly annotation: string | null;
  readonly params: readonly string[];
  /**
   * Actor logic that stays logic (`fromCallback(fn)` becomes `createCallbackLogic<...>(fn)`): the
   * callee and its type arguments are replaced by this text, and the call is kept.
   */
  readonly callee: { readonly start: number; readonly end: number; readonly text: string } | null;
  /**
   * A callback that returns no cleanup (callback logic's `run` returns one): the no-op cleanup
   * written into its body (`text` replaces `[start, end)`), and its TODO, for the report.
   */
  readonly cleanup: { readonly start: number; readonly end: number; readonly text: string; readonly todo: Todo } | null;
}
