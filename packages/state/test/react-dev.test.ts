// @reactre/state/react/dev: the React adapter's development warnings (M313–M316). Each hook is the
// plain one (../src/entries/react.ts) with a check that warns, once, with the fix; the actor's
// behaviour is unchanged. The renderer is the minimal one actors.test.ts uses: state slots, effects
// after the render (cleanups on unmount), and an external store that re-renders on change.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { Machine, Type } from "../src/index.ts";
import { to } from "./to.ts";

describe("react/dev", () => {
  // A minimal renderer, as React's hooks behave for one component.
  let slots: unknown[] = [];
  let at = 0;
  let effects: (() => void)[] = [];
  let cleanups: (() => void)[] = [];
  let rerender = (): void => {};
  mock.module("react", () => ({
    useState: <T>(init: () => T) => {
      const i = at++;
      if (slots[i] === undefined) slots[i] = init();
      return [slots[i] as T, (next: T) => ((slots[i] = next), rerender())];
    },
    useRef: <T>(init: T) => {
      const i = at++;
      if (slots[i] === undefined) slots[i] = { current: init };
      return slots[i];
    },
    useCallback: <F>(fn: F) => fn,
    useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
      const i = at++;
      const was = slots[i] as readonly unknown[] | undefined;
      if (was && was.every((d, j) => d === deps[j])) return;
      slots[i] = deps;
      effects.push(() => {
        const c = fn();
        if (c) cleanups.push(c);
      });
    },
    useSyncExternalStore: <T>(subscribe: (f: () => void) => () => void, get: () => T) => {
      const i = at++;
      if (!(i in slots)) slots[i] = subscribe(() => rerender());
      return get();
    },
  }));

  /** Renders `hook` until it settles; `unmount` runs the cleanups. */
  function render<T>(hook: () => T): {
    readonly current: () => T;
    readonly unmount: () => void;
  } {
    slots = [];
    effects = [];
    cleanups = [];
    let value: T;
    rerender = () => {
      at = 0;
      value = hook();
      for (const e of effects.splice(0)) e();
    };
    rerender();
    return { current: () => value, unmount: () => cleanups.splice(0).forEach((c) => c()) };
  }

  // One machine per test: a machine made in the render is a new object each render, which is M314.
  const counter = (): Machine<{ states: { at: Type<{ n: number }> }; events: { inc: Type<{}>; same: Type<{}> } }> => ({
    v: 0,
    e: { inc: 1, same: 1 },
    i: () => to("at", { n: 0 }),
    o: {
      at: {
        inc: (d) => to("at", { n: (d as { n: number }).n + 1 }),
        same: (d) => to("at", { n: (d as { n: number }).n }),
      },
    },
  });

  let warnings: string[] = [];
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    warnings = [];
    warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
  });
  // Bun's spyOn on a property already spied returns that same spy, calls and all: left installed, it
  // hands its calls to the next file's spy. Restored here, each test's spy is its own.
  afterEach(() => warn.mockRestore());

  test("M314: a different machine on a later render warns, and the first is kept", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const first = counter();
    const second = counter();
    let machine = first;
    const view = render(() => useActorRef(machine));
    const actor = view.current();
    expect(warnings).toEqual([]);
    machine = second;
    rerender();
    expect(view.current()).toBe(actor);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a different machine was passed on a later render");
    expect(warnings[0]).toContain("key");
  });

  // A machine that takes an input, so `{ input }` is typed.
  const withInput = (): Machine<{
    input: Type<{ n: number }>;
    states: { at: Type<{ n: number }> };
    events: { inc: Type<{}> };
  }> => ({
    v: 0,
    e: { inc: 1 },
    i: (input) => to("at", { n: (input as { n: number }).n }),
    o: { at: { inc: (d) => to("at", { n: (d as { n: number }).n + 1 }) } },
  });

  test("M313: a changed input on a later render warns, and the actor keeps the first", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const machine = withInput();
    let input = { n: 1 };
    const view = render(() => useActorRef(machine, { input }));
    const actor = view.current();
    expect(warnings).toEqual([]);
    // The same content in a new object is not a change.
    input = { n: 1 };
    rerender();
    expect(warnings).toEqual([]);
    input = { n: 2 };
    rerender();
    expect(view.current()).toBe(actor);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the input changed on a later render");
  });

  test("M315: a selector that builds a new object with no compare warns; a compare or a primitive doesn't", async () => {
    const { useActorRef, useSelector } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => {
      const actor = useActorRef(machine);
      const picked = useSelector(actor, (s) => ({ n: s.data.n }));
      return [actor, picked] as const;
    });
    const [actor] = view.current();
    expect(warnings).toEqual([]);
    actor.send({ type: "same" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the selector returns a new object on each notification");
    expect(warnings[0]).toContain("compare");

    // A compare: no warning.
    warnings = [];
    const comparedMachine = counter();
    const compared = render(() => {
      const a = useActorRef(comparedMachine);
      return useSelector(
        a,
        (s) => ({ n: s.data.n }),
        (x, y) => x.n === y.n,
      );
    });
    const [a2] = [compared.current()];
    void a2;
    expect(warnings).toEqual([]);

    // A primitive: no warning.
    warnings = [];
    const primitiveMachine = counter();
    const primitive = render(() => {
      const a = useActorRef(primitiveMachine);
      return useSelector(a, (s) => s.data.n);
    });
    const n = primitive.current();
    expect(n).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("M316: a send to the first actor before Strict Mode's second mount warns", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => useActorRef(machine));
    const first = view.current();
    first.send({ type: "inc" });
    expect(warnings).toEqual([]);
    // Strict mode: the cleanup stops it, then the effect runs again on the same state.
    view.unmount();
    slots[1] = undefined;
    rerender();
    expect(first.status()).toBe("stopped");
    expect(view.current()).not.toBe(first);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Strict Mode's second mount replaced the actor");
  });

  test("M316: Strict Mode re-runs the effect on the same state, and the stopped actor is replaced", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => useActorRef(machine));
    const first = view.current();
    first.send({ type: "inc" });
    // Strict Mode: the cleanup stops the actor, then the effect runs again on the same state (its
    // deps unchanged), which is the branch that replaces a stopped actor.
    view.unmount();
    expect(first.status()).toBe("stopped");
    // Clear the effect's deps slot (the third hook: ref, state, effect) so it runs again.
    slots[2] = undefined;
    rerender();
    expect(view.current()).not.toBe(first);
    expect(view.current().status()).toBe("active");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Strict Mode's second mount replaced the actor");
  });

  test("M316: a second mount with no send before it doesn't warn", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => useActorRef(machine));
    view.unmount();
    slots[1] = undefined;
    rerender();
    expect(warnings).toEqual([]);
  });

  test("the counted actor forwards snapshot, status, subscribe, stop and ~r", async () => {
    const { useActorRef } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => useActorRef(machine));
    const actor = view.current();
    // snapshot and status are the plain actor's.
    expect(actor.snapshot()).toMatchObject({ state: "at", data: { n: 0 } });
    expect(actor.status()).toBe("active");
    // subscribe forwards, and the unsubscribe works.
    const seen: number[] = [];
    const off = actor.subscribe((s) => seen.push(s.data.n));
    actor.send({ type: "inc" });
    off();
    actor.send({ type: "inc" });
    expect(seen).toEqual([1]);
    // ~r is the plain actor's (undefined for a machine with no runners).
    expect((actor as unknown as { readonly "~r": unknown })["~r"]).toBeUndefined();
    // stop forwards.
    actor.stop();
    expect(actor.status()).toBe("stopped");
  });

  test("useActor returns the whole snapshot and the actor, and re-renders on a move", async () => {
    const { useActor } = await import("../src/entries/react-dev.ts");
    const machine = counter();
    const view = render(() => useActor(machine));
    const [first, actor] = view.current();
    expect(first).toMatchObject({ state: "at", data: { n: 0 } });
    actor.send({ type: "inc" });
    expect(view.current()[0]).toMatchObject({ data: { n: 1 } });
    expect(view.current()[1]).toBe(actor);
    // The whole snapshot is not an app selector: no M315 warning for it.
    expect(warnings).toEqual([]);
  });

  test("the plain entry ships none of the warnings", async () => {
    const { useActorRef } = await import("../src/entries/react.ts");
    const machine = counter();
    const view = render(() => useActorRef(machine));
    const actor = view.current();
    actor.send({ type: "inc" });
    view.unmount();
    slots[1] = undefined;
    rerender();
    expect(warnings).toEqual([]);
  });
});
