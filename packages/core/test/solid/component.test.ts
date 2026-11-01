// Ports of Solid 2.0's component tests: packages/solid/test/component.spec.ts (createComponent, the
// development build's strict-read warnings, createUniqueId) and the `children` test of
// packages/web/test/element.spec.tsx, from solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported
// from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's `createComponent(Comp, props)` is what its compiler emits for `<Comp ... />`: it calls
// the component untracked with the props, a reactive one as a getter. reactre's compiler emits the
// call itself, with the same props, so the ports write the JSX. Solid's `<Show>` and `<Match>`,
// called by hand there, are compiled away in reactre, so the ports write them as JSX too. The
// warnings are those of Solid's development build; reactre's sources, which `bun test` runs, hold
// its development checks.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as owner from "../../src/features/owner.ts";
import { base, compile, gap } from "./harness.ts";

beforeEach(installFakeDocument);

const text = (n: FakeElement): string => n.textContent ?? "";

/** Run TSX module body `src` (ending in `return { ... }`) in a new root: the root, and what it returned. */
function run<T>(src: string, scope: Record<string, unknown> = {}): { root: FakeElement; api: T } {
  const root = new FakeElement("DIV");
  return { root, api: compile<T>(src, base, { root, expect, ...scope }) };
}

/** console.warn, recorded for a test, and put back after it. */
let warns: unknown[][] = [];
const originalWarn = console.warn;
beforeEach(() => {
  warns = [];
  console.warn = (...args: unknown[]) => void warns.push(args);
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("solid/test/component.spec.ts: CreateComponent", () => {
  test("create simple component", () => {
    const { root } = run(`
      import { render } from "@reactre/core";
      const Comp = (props) => \`\${props.greeting} \${props.name}\`;
      const dynamic = () => "dynamic";
      render(() => <p><Comp greeting="Hi" name={dynamic()} /></p>, root);
      return {};
    `);
    expect(text(root)).toBe("Hi dynamic");
  });

  test("null/undefined props are replaced with empty props", () => {
    const { api } = run<{ props: unknown }>(`
      let props;
      const C = (p) => ((props = p), null);
      const out = <C />;
      return { get props() { return props; } };
    `);
    expect(api.props).toEqual({});
  });

  gap(
    "dev-checks",
    "a call of a component that is not a function throws a plain TypeError",
    "non-function component throws a descriptive dev error, not a name-read crash (#3005)",
    () => {
      const call = (C: unknown) => () => run(`const C = Missing;\nconst out = <C />;\nreturn {};`, { Missing: C });
      expect(call(undefined)).toThrow(/expected a component function but got undefined.*missing or misnamed export/s);
      expect(call(null)).toThrow(/expected a component function but got null/);
      expect(call({})).toThrow(/expected a component function but got object/);
    },
  );
});

describe("solid/test/component.spec.ts: Strict Read Warning", () => {
  gap(
    "dev-checks",
    "no strict-read warning for a signal read in a component body",
    "warns on direct signal read in component body",
    () => {
      run(`
        import { signal } from "@reactre/core";
        import { createRoot } from "@reactre/core/features/owner";
        const [count] = signal(0);
        const C = () => { count(); return null; };
        createRoot(() => <C />);
        return {};
      `);
      expect(warns).toHaveLength(1);
      expect(String(warns[0]![0])).toMatch(/Reactive value read directly in/i);
    },
  );

  gap(
    "dev-checks",
    "no strict-read warning for a reactive prop read in a component body",
    "warns on props.value access backed by signal",
    () => {
      run(`
        import { signal } from "@reactre/core";
        import { createRoot } from "@reactre/core/features/owner";
        const [value] = signal(42);
        const C = (props) => { const v = props.value; return null; };
        createRoot(() => <C value={value()} />);
        return {};
      `);
      expect(warns).toHaveLength(1);
    },
  );

  gap(
    "dev-checks",
    "no strict-read warning for a store property destructured in a component body",
    "warns on store property destructuring",
    () => {
      run(`
        import { createRoot } from "@reactre/core/features/owner";
        import { createStore } from "@reactre/core/features/store";
        createRoot(() => {
          const [store] = createStore({ count: 0 });
          const C = () => { const { count } = store; return null; };
          return <C />;
        });
        return {};
      `);
      expect(warns).toHaveLength(1);
    },
  );

  test("does not warn for signal read inside createMemo", () => {
    run(`
      import { memo, signal } from "@reactre/core";
      import { createRoot } from "@reactre/core/features/owner";
      const [count] = signal(0);
      const C = () => { const doubled = memo(() => count() * 2); return null; };
      createRoot(() => <C />);
      return {};
    `);
    expect(warns).toHaveLength(0);
  });

  test("does not warn for signal read inside createEffect", () => {
    run(`
      import { signal } from "@reactre/core";
      import { createRoot } from "@reactre/core/features/owner";
      import { reaction } from "@reactre/core/features/reaction";
      const [count] = signal(0);
      const C = () => { reaction(() => count(), () => {}); return null; };
      createRoot(() => <C />);
      return {};
    `);
    expect(warns).toHaveLength(0);
  });

  test("does not warn with explicit untrack in component body", () => {
    run(`
      import { signal, untrack } from "@reactre/core";
      import { createRoot } from "@reactre/core/features/owner";
      const [count] = signal(0);
      const C = () => { untrack(() => count()); return null; };
      createRoot(() => <C />);
      return {};
    `);
    expect(warns).toHaveLength(0);
  });

  test("does not warn when keyed Show passes a store value to function children", () => {
    const { root } = run(`
      import { render, Show } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store] = createStore({ error: { type: "network" } });
      render(() => <p><Show when={store.error} keyed>{(_error) => null}</Show></p>, root);
      return {};
    `);
    expect(text(root)).toBe("");
    expect(warns).toHaveLength(0);
  });

  gap(
    "dev-checks",
    "no strict-read warning for a keyed <Show> child reading its store value as it is built",
    "warns when keyed Show children read properties from store values during setup",
    () => {
      run(`
        import { render, Show } from "@reactre/core";
        import { createStore } from "@reactre/core/features/store";
        const [store] = createStore({ error: { type: "network" } });
        render(() => <p><Show when={store.error} keyed>{(error) => error.type}</Show></p>, root);
        return {};
      `);
      expect(warns).toHaveLength(1);
      expect(String(warns[0]![0])).toMatch(/<Show>/);
    },
  );

  test("does not warn when keyed Match passes a store value to function children", () => {
    run(`
      import { Match, render, Switch } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store] = createStore({ error: { type: "network" } });
      render(() => <p><Switch><Match when={store.error} keyed>{(_error) => null}</Match></Switch></p>, root);
      return {};
    `);
    expect(warns).toHaveLength(0);
  });

  gap(
    "dev-checks",
    "no strict-read warning for a keyed <Match> child reading its store value as it is built",
    "warns when keyed Match children read properties from store values during setup",
    () => {
      run(`
        import { Match, render, Switch } from "@reactre/core";
        import { createStore } from "@reactre/core/features/store";
        const [store] = createStore({ error: { type: "network" } });
        render(() => <p><Switch><Match when={store.error} keyed>{(error) => error.type}</Match></Switch></p>, root);
        return {};
      `);
      expect(warns).toHaveLength(1);
      expect(String(warns[0]![0])).toMatch(/<Match>/);
    },
  );

  gap(
    "dev-checks",
    "no strict-read warning for a signal read in a component body",
    "nested components each warn independently",
    () => {
      run(`
        import { signal } from "@reactre/core";
        import { createRoot } from "@reactre/core/features/owner";
        const [count] = signal(0);
        const Inner = () => { count(); return null; };
        const Outer = () => { count(); const inner = <Inner />; return null; };
        createRoot(() => <Outer />);
        return {};
      `);
      expect(warns).toHaveLength(2);
    },
  );
});

describe("solid/test/component.spec.ts: createUniqueId", () => {
  gap("owner-ids", "createUniqueId is missing", "creating some", () => {
    const { createUniqueId } = owner as unknown as { createUniqueId?: () => string };
    expect(createUniqueId).toBeDefined();
    const id1 = createUniqueId!();
    const id2 = createUniqueId!();
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toEqual(id2);
  });
});

describe("web/test/element.spec.tsx", () => {
  gap("children-helper", "children() is missing", "children", () => {
    const { root } = run(`
      import { render } from "@reactre/core";
      const Comp = (props) => {
        const c = children(() => props.children);
        return <>{c.toArray().map((i) => <div>{i}</div>)}</>;
      };
      render(
        () => (
          <div>
            <Comp>
              <span>Hello</span>
            </Comp>
            <Comp>
              <span>Hello</span>
              <span>Jake</span>
            </Comp>
            <Comp />
          </div>
        ),
        root,
      );
      return {};
    `);
    expect(text(root)).toBe("HelloHelloJake");
  });
});
