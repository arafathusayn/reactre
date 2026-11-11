// The door as each library runs it, for bench.ts: for each case a library supports, the operation
// to time and a check that it does what it claims (push opens the door, close closes it). Each
// library is imported only when its case is set up, so a bench process loads one library alone.
//
// - actor: an actor (or service, instance) with one listener, sent push then close.
// - pure: push then close as a pure transition from the initial state, no actor.
// - create: create an actor, give it a listener, stop it (or drop it, where it has no stop).
//
// Not here: @zag-js/core. It ships the machine config and its helpers only; the interpreter that
// runs a machine is in a framework adapter (@zag-js/vanilla, /react, ...), none of them installed.

import type { Event as DoeixdEvent } from "@doeixd/machine";

import type { Door as DoeixdDoor } from "./doeixd/door.ts";

export type CaseName = "actor" | "pure" | "create";

export interface Case {
  /** How many operations each `run()` call does. */
  readonly ops: number;
  readonly run: () => void;
  /** Sends push, then close, and returns the state after each: `["open", "closed"]` if correct. */
  readonly check: () => readonly [string, string];
}

export interface Lib {
  readonly name: string;
  /** How the library is used where it lacks what a case needs. */
  readonly notes?: { readonly [C in CaseName]?: string };
  readonly cases: { readonly [C in CaseName]?: () => Promise<Case> };
}

/** Push, read the state, close, read it again. */
function walk(push: () => void, close: () => void, state: () => string): readonly [string, string] {
  push();
  const opened = state();
  close();
  return [opened, state()];
}

const PUSH = { type: "push", by: "ann" } as const;
const CLOSE = { type: "close" } as const;
const noop = (): void => {};

export const LIBS = {
  ours: {
    name: "@reactre/state",
    cases: {
      actor: async () => {
        await import("./production.ts");
        const { createActor } = await import("@reactre/state");
        const { doorMachine } = await import("../test/fixtures/door.ts");
        const actor = createActor(doorMachine);
        actor.subscribe(noop);
        return {
          ops: 2,
          run: () => (actor.send(PUSH), actor.send(CLOSE)),
          check: () =>
            walk(
              () => actor.send(PUSH),
              () => actor.send(CLOSE),
              () => actor.snapshot().state,
            ),
        };
      },
      pure: async () => {
        await import("./production.ts");
        const { initial, transition } = await import("@reactre/state");
        const { doorMachine } = await import("../test/fixtures/door.ts");
        const s0 = initial(doorMachine, undefined);
        return {
          ops: 2,
          run: () => {
            const s1 = transition(doorMachine, s0, PUSH).snapshot;
            transition(doorMachine, s1, CLOSE);
          },
          check: () => {
            const s1 = transition(doorMachine, s0, PUSH).snapshot;
            return [s1.state, transition(doorMachine, s1, CLOSE).snapshot.state];
          },
        };
      },
      create: async () => {
        await import("./production.ts");
        const { createActor } = await import("@reactre/state");
        const { doorMachine } = await import("../test/fixtures/door.ts");
        return {
          ops: 1,
          run: () => {
            const a = createActor(doorMachine);
            a.subscribe(noop);
            a.stop();
          },
          check: () => {
            const a = createActor(doorMachine);
            a.subscribe(noop);
            const states = walk(
              () => a.send(PUSH),
              () => a.send(CLOSE),
              () => a.snapshot().state,
            );
            a.stop();
            return states;
          },
        };
      },
    },
  },

  xstate: {
    name: "XState v6 beta",
    notes: { pure: "xstate/fsm" },
    cases: {
      actor: async () => {
        const { createActor } = await import("xstate6");
        const { doorMachine } = await import("./xstate/door.ts");
        const actor = createActor(doorMachine).start();
        actor.subscribe(noop);
        return {
          ops: 2,
          run: () => (actor.send(PUSH), actor.send(CLOSE)),
          check: () =>
            walk(
              () => actor.send(PUSH),
              () => actor.send(CLOSE),
              () => String(actor.getSnapshot().value),
            ),
        };
      },
      pure: async () => {
        const { doorFsm } = await import("./xstate/door-fsm.ts");
        const s0 = doorFsm.initialState;
        return {
          ops: 2,
          run: () => {
            const [s1] = doorFsm.transition(s0, PUSH);
            doorFsm.transition(s1, CLOSE);
          },
          check: () => {
            const [s1] = doorFsm.transition(s0, PUSH);
            return [String(s1.value), String(doorFsm.transition(s1, CLOSE)[0].value)];
          },
        };
      },
      create: async () => {
        const { createActor } = await import("xstate6");
        const { doorMachine } = await import("./xstate/door.ts");
        return {
          ops: 1,
          run: () => {
            const a = createActor(doorMachine).start();
            a.subscribe(noop);
            a.stop();
          },
          check: () => {
            const a = createActor(doorMachine).start();
            a.subscribe(noop);
            const states = walk(
              () => a.send(PUSH),
              () => a.send(CLOSE),
              () => String(a.getSnapshot().value),
            );
            a.stop();
            return states;
          },
        };
      },
    },
  },

  xstate5: {
    name: "XState v5",
    notes: { pure: "`transition()`" },
    cases: {
      actor: async () => {
        const { createActor } = await import("xstate");
        const { doorMachine } = await import("./xstate5/door.ts");
        const actor = createActor(doorMachine).start();
        actor.subscribe(noop);
        return {
          ops: 2,
          run: () => (actor.send(PUSH), actor.send(CLOSE)),
          check: () =>
            walk(
              () => actor.send(PUSH),
              () => actor.send(CLOSE),
              () => String(actor.getSnapshot().value),
            ),
        };
      },
      pure: async () => {
        const { initialTransition, transition } = await import("xstate");
        const { doorMachine } = await import("./xstate5/door.ts");
        const [s0] = initialTransition(doorMachine);
        return {
          ops: 2,
          run: () => {
            const [s1] = transition(doorMachine, s0, PUSH);
            transition(doorMachine, s1, CLOSE);
          },
          check: () => {
            const [s1] = transition(doorMachine, s0, PUSH);
            return [String(s1.value), String(transition(doorMachine, s1, CLOSE)[0].value)];
          },
        };
      },
      create: async () => {
        const { createActor } = await import("xstate");
        const { doorMachine } = await import("./xstate5/door.ts");
        return {
          ops: 1,
          run: () => {
            const a = createActor(doorMachine).start();
            a.subscribe(noop);
            a.stop();
          },
          check: () => {
            const a = createActor(doorMachine).start();
            a.subscribe(noop);
            const states = walk(
              () => a.send(PUSH),
              () => a.send(CLOSE),
              () => String(a.getSnapshot().value),
            );
            a.stop();
            return states;
          },
        };
      },
    },
  },

  robot3: {
    name: "Robot (robot3)",
    notes: { actor: "listener: `interpret`'s onChange", create: "no stop: the service is dropped" },
    cases: {
      actor: async () => {
        const { interpret } = await import("robot3");
        const { doorMachine } = await import("./robot3/door.ts");
        const service = interpret(doorMachine, noop);
        return {
          ops: 2,
          run: () => (service.send(PUSH), service.send(CLOSE)),
          check: () =>
            walk(
              () => service.send(PUSH),
              () => service.send(CLOSE),
              () => String(service.machine.current),
            ),
        };
      },
      create: async () => {
        const { interpret } = await import("robot3");
        const { doorMachine } = await import("./robot3/door.ts");
        return {
          ops: 1,
          run: () => void interpret(doorMachine, noop),
          check: () => {
            const s = interpret(doorMachine, noop);
            return walk(
              () => s.send(PUSH),
              () => s.send(CLOSE),
              () => String(s.machine.current),
            );
          },
        };
      },
    },
  },

  store: {
    name: "@xstate/store",
    notes: { pure: "`store.transition`", create: "no stop: unsubscribes" },
    cases: {
      actor: async () => {
        const { createStore } = await import("@xstate/store");
        const { doorStore } = await import("./store/door.ts");
        const store = createStore(doorStore);
        store.subscribe(noop);
        return {
          ops: 2,
          run: () => (store.send(PUSH), store.send(CLOSE)),
          check: () =>
            walk(
              () => store.send(PUSH),
              () => store.send(CLOSE),
              () => store.getSnapshot().context.state,
            ),
        };
      },
      pure: async () => {
        const { createStore } = await import("@xstate/store");
        const { doorStore } = await import("./store/door.ts");
        const { transition, getInitialSnapshot } = createStore(doorStore);
        const s0 = getInitialSnapshot();
        return {
          ops: 2,
          run: () => {
            const [s1] = transition(s0, PUSH);
            transition(s1, CLOSE);
          },
          check: () => {
            const [s1] = transition(s0, PUSH);
            return [s1.context.state, transition(s1, CLOSE)[0].context.state];
          },
        };
      },
      create: async () => {
        const { createStore } = await import("@xstate/store");
        const { doorStore } = await import("./store/door.ts");
        return {
          ops: 1,
          run: () => createStore(doorStore).subscribe(noop).unsubscribe(),
          check: () => {
            const s = createStore(doorStore);
            const sub = s.subscribe(noop);
            const states = walk(
              () => s.send(PUSH),
              () => s.send(CLOSE),
              () => s.getSnapshot().context.state,
            );
            sub.unsubscribe();
            return states;
          },
        };
      },
    },
  },

  tsfsm: {
    name: "typescript-fsm",
    notes: {
      actor: "listener: called by each transition's callback",
      create: "no stop: the instance is dropped",
    },
    cases: {
      actor: async () => {
        const { Door } = await import("./tsfsm/door.ts");
        const door = new Door(noop);
        return {
          ops: 2,
          run: () => (door.send(PUSH), door.send(CLOSE)),
          check: () =>
            walk(
              () => door.send(PUSH),
              () => door.send(CLOSE),
              () => door.getState(),
            ),
        };
      },
      create: async () => {
        const { Door } = await import("./tsfsm/door.ts");
        return {
          ops: 1,
          run: () => void new Door(noop),
          check: () => {
            const d = new Door(noop);
            return walk(
              () => d.send(PUSH),
              () => d.send(CLOSE),
              () => d.getState(),
            );
          },
        };
      },
    },
  },

  yay: {
    name: "yay-machine",
    cases: {
      actor: async () => {
        const { doorMachine } = await import("./yay/door.ts");
        const door = doorMachine.newInstance().start();
        door.subscribe(noop);
        return {
          ops: 2,
          run: () => (door.send(PUSH), door.send(CLOSE)),
          check: () =>
            walk(
              () => door.send(PUSH),
              () => door.send(CLOSE),
              () => door.state.name,
            ),
        };
      },
      create: async () => {
        const { doorMachine } = await import("./yay/door.ts");
        return {
          ops: 1,
          run: () => {
            const d = doorMachine.newInstance().start();
            d.subscribe(noop);
            d.stop();
          },
          check: () => {
            const d = doorMachine.newInstance().start();
            d.subscribe(noop);
            const states = walk(
              () => d.send(PUSH),
              () => d.send(CLOSE),
              () => d.state.name,
            );
            d.stop();
            return states;
          },
        };
      },
    },
  },

  doeixd: {
    name: "@doeixd/machine",
    notes: { pure: "typestate methods" },
    cases: {
      actor: async () => {
        const { createActor } = await import("@doeixd/machine");
        const { closed } = await import("./doeixd/door.ts");
        const actor = createActor<DoeixdDoor>(closed);
        actor.subscribe(noop);
        const push: DoeixdEvent<DoeixdDoor> = { type: "push", args: ["ann"] };
        const close: DoeixdEvent<DoeixdDoor> = { type: "close", args: [] };
        return {
          ops: 2,
          run: () => (actor.dispatch(push), actor.dispatch(close)),
          check: () =>
            walk(
              () => actor.dispatch(push),
              () => actor.dispatch(close),
              () => actor.getSnapshot().context.state,
            ),
        };
      },
      pure: async () => {
        const { closed } = await import("./doeixd/door.ts");
        return {
          ops: 2,
          run: () => void closed.push("ann").close(),
          check: () => {
            const open = closed.push("ann");
            return [open.context.state, open.close().context.state];
          },
        };
      },
      create: async () => {
        const { createActor } = await import("@doeixd/machine");
        const { closed } = await import("./doeixd/door.ts");
        const push: DoeixdEvent<DoeixdDoor> = { type: "push", args: ["ann"] };
        const close: DoeixdEvent<DoeixdDoor> = { type: "close", args: [] };
        return {
          ops: 1,
          run: () => {
            const a = createActor<DoeixdDoor>(closed);
            a.subscribe(noop);
            a.stop();
          },
          check: () => {
            const a = createActor<DoeixdDoor>(closed);
            a.subscribe(noop);
            const states = walk(
              () => a.dispatch(push),
              () => a.dispatch(close),
              () => a.getSnapshot().context.state,
            );
            a.stop();
            return states;
          },
        };
      },
    },
  },

  hsm: {
    name: "@stateforward/hsm",
    notes: { actor: "listener: each state's `entry`" },
    cases: {
      actor: async () => {
        const hsm = await import("@stateforward/hsm");
        const { Close, Door, doorModel, push } = await import("./hsm/door.ts");
        const door = hsm.start(new Door(noop), doorModel);
        const PUSH_E = push("ann");
        const leaf = (): string => door.state().slice(door.state().lastIndexOf("/") + 1);
        return {
          ops: 2,
          run: () => (void door.dispatch(PUSH_E), void door.dispatch(Close)),
          check: () =>
            walk(
              () => void door.dispatch(PUSH_E),
              () => void door.dispatch(Close),
              leaf,
            ),
        };
      },
      create: async () => {
        const hsm = await import("@stateforward/hsm");
        const { Close, Door, doorModel, push } = await import("./hsm/door.ts");
        const PUSH_E = push("ann");
        return {
          ops: 1,
          run: () => hsm.stop(hsm.start(new Door(noop), doorModel)),
          check: () => {
            const d = hsm.start(new Door(noop), doorModel);
            const states = walk(
              () => void d.dispatch(PUSH_E),
              () => void d.dispatch(Close),
              () => d.state().slice(d.state().lastIndexOf("/") + 1),
            );
            hsm.stop(d);
            return states;
          },
        };
      },
    },
  },

  escapace: {
    name: "@escapace/fsm",
    notes: { create: "no stop: unsubscribes" },
    cases: {
      actor: async () => {
        const { createDoor } = await import("./escapace/door.ts");
        const door = createDoor();
        door.subscribe(noop);
        const by = { by: "ann" };
        return {
          ops: 2,
          run: () => (door.do("push", by), door.do("close")),
          check: () =>
            walk(
              () => door.do("push", by),
              () => door.do("close"),
              () => door.state,
            ),
        };
      },
      create: async () => {
        const { createDoor } = await import("./escapace/door.ts");
        const by = { by: "ann" };
        return {
          ops: 1,
          run: () => createDoor().subscribe(noop)(),
          check: () => {
            const d = createDoor();
            const off = d.subscribe(noop);
            const states = walk(
              () => d.do("push", by),
              () => d.do("close"),
              () => d.state,
            );
            off();
            return states;
          },
        };
      },
    },
  },

  jssm: {
    name: "jssm",
    notes: { create: "no stop: unsubscribes" },
    cases: {
      actor: async () => {
        const { createDoor } = await import("./jssm/door.ts");
        const door = createDoor();
        door.on("transition", noop);
        const data = { by: "ann", code: null };
        return {
          ops: 2,
          run: () => (door.action("push", data), door.action("close")),
          check: () =>
            walk(
              () => door.action("push", data),
              () => door.action("close"),
              () => door.state(),
            ),
        };
      },
      create: async () => {
        const { createDoor } = await import("./jssm/door.ts");
        const data = { by: "ann", code: null };
        return {
          ops: 1,
          run: () => createDoor().on("transition", noop)(),
          check: () => {
            const d = createDoor();
            const off = d.on("transition", noop);
            const states = walk(
              () => d.action("push", data),
              () => d.action("close"),
              () => d.state(),
            );
            off();
            return states;
          },
        };
      },
    },
  },
} satisfies { readonly [key: string]: Lib };

export type LibKey = keyof typeof LIBS;
