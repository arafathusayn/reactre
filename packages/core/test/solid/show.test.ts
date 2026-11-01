// Ports of Solid 2.0's tests of <Show>, <Switch> and <Match>, from packages/web/test/show.spec.tsx
// and packages/web/test/switch.spec.tsx, solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from
// Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's tests share a component across the tests of a describe ("Create", then "Toggle", then
// "dispose"); the ports keep that order, and the last test of each describe disposes. Solid makes
// the component in a createRoot and keeps its <div> by ref; a port mounts it with `attach` and
// keeps the <div> by a ref function. `innerHTML` is `html()`, which the fake DOM lacks.
//
// show.spec.tsx's two isPending tests need the async runtime, which this file turns on before its
// tests and off after them, as ../async.test.ts does.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, type FakeNode, installFakeDocument } from "@reactre/testdom";

import * as asyncApi from "../../src/features/async.ts";
import { __hooks } from "../../src/features/async.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { base, compile, gap, tick } from "./harness.ts";

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => core.__installAsync(false));
beforeEach(installFakeDocument);

const modules = { ...base, "@reactre/core/features/async": asyncApi };

/** What a mounted source returns: its setters and counters, its <div>, and its disposer. */
// oxlint-disable-next-line no-explicit-any
type Api = Record<string, any> & { div(): FakeElement; dispose(): void };

/** Compile and run a source ending in `return { ... }`, with `root`, a fresh <div>, in scope. */
const mount = (src: string): Api => compile<Api>(src, modules, { root: new FakeElement("DIV") });

/** `innerHTML`: elements with their attributes, and text; comments (markers) left out. */
function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${tag}${attrs}>${html(c)}</${tag}>`;
    } else if (c.nodeType === 3) out += c.textContent;
  }
  return out;
}

// #region show.spec.tsx

describe("Testing an only child show control flow", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(`
      import { attach, Show, signal } from "@reactre/core";
      const [count, setCount] = signal(0);
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Show when={count() >= 5}>{count()}</Show>
        </div>
      );
      return { setCount, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("");
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(html(t.div())).toBe("7");
    t.setCount(5);
    flush();
    expect(html(t.div())).toBe("5");
    t.setCount(2);
    flush();
    expect(html(t.div())).toBe("");
    t.dispose();
  });
});

describe("Testing an only child show control flow with DOM children", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(`
      import { attach, Show, signal } from "@reactre/core";
      const [count, setCount] = signal(0);
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Show when={count() >= 5}>
            <span>{count()}</span>
            <span>counted</span>
          </Show>
        </div>
      );
      return { setCount, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("");
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    t.setCount(5);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    t.setCount(2);
    flush();
    expect(html(t.div())).toBe("");
    t.dispose();
  });
});

/** The source of show.spec.tsx's counting describes: `show` is the <Show> element. */
const counting = (show: string): string => `
  import { attach, Show, signal } from "@reactre/core";
  const [count, setCount] = signal(0);
  let whenExecuted = 0;
  let childrenExecuted = 0;
  let executed = 0;
  function when() {
    whenExecuted++;
    return count();
  }
  let div;
  const Component = () => <div ref={(el) => (div = el)}>${show}</div>;
  return {
    setCount,
    whenExecuted: () => whenExecuted,
    childrenExecuted: () => childrenExecuted,
    executed: () => executed,
    div: () => div,
    dispose: attach(Component, root),
  };
`;

describe("Testing nonkeyed show control flow", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      counting(`
        <Show when={when()}>
          <span>{count()}</span>
          <span>{childrenExecuted++}</span>
        </Show>`),
    );
    expect(html(t.div())).toBe("");
    expect(t.whenExecuted()).toBe(1);
    expect(t.childrenExecuted()).toBe(0);
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(t.whenExecuted()).toBe(2);
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(3);
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    expect(t.whenExecuted()).toBe(3);
    t.setCount(0);
    flush();
    expect(t.whenExecuted()).toBe(4);
    expect(html(t.div())).toBe("");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(5);
    t.dispose();
  });
});

describe("Testing keyed show control flow", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      counting(`
        <Show when={when()} keyed>
          <span>{count()}</span>
          <span>{childrenExecuted++}</span>
        </Show>`),
    );
    expect(html(t.div())).toBe("");
    expect(t.whenExecuted()).toBe(1);
    expect(t.childrenExecuted()).toBe(0);
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(t.whenExecuted()).toBe(2);
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(3);
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    expect(t.childrenExecuted()).toBe(2);
    t.setCount(5);
    expect(t.whenExecuted()).toBe(3);
    t.setCount(0);
    flush();
    expect(t.whenExecuted()).toBe(4);
    expect(html(t.div())).toBe("");
    expect(t.childrenExecuted()).toBe(2);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(5);
    t.dispose();
  });
});

describe("Testing nonkeyed function show control flow", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      counting(`
        <Show when={when()}>
          {(count) => (
            <>
              <span>{count()}</span>
              <span>{childrenExecuted++}</span>
            </>
          )}
        </Show>`),
    );
    expect(html(t.div())).toBe("");
    expect(t.whenExecuted()).toBe(1);
    expect(t.childrenExecuted()).toBe(0);
  });

  gap("bug", "with a function child, `when` runs twice per change", "Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(t.whenExecuted()).toBe(2);
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(3);
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    expect(t.whenExecuted()).toBe(3);
    t.setCount(0);
    flush();
    expect(t.whenExecuted()).toBe(4);
    expect(html(t.div())).toBe("");
    expect(t.childrenExecuted()).toBe(1);
    t.setCount(5);
    flush();
    expect(t.whenExecuted()).toBe(5);
  });
  test("dispose", () => t.dispose());
});

describe("Testing keyed function show control flow", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      counting(`
        <Show when={count()} keyed>
          {(count) => (
            <>
              <span>{count}</span>
              <span>{executed++}</span>
            </>
          )}
        </Show>`),
    );
    expect(html(t.div())).toBe("");
    expect(t.executed()).toBe(0);
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    expect(t.executed()).toBe(1);
    t.setCount(5);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    expect(t.executed()).toBe(2);
    t.setCount(0);
    flush();
    expect(html(t.div())).toBe("");
    expect(t.executed()).toBe(2);
    t.dispose();
  });
});

/** show.spec.tsx's sources over `data`, a signal of `{ count }`: `show` is the <Show> element. */
const ofData = (show: string): string => `
  import { attach, Show, signal } from "@reactre/core";
  const [data, setData] = signal(undefined);
  let div;
  const Component = () => <div ref={(el) => (div = el)}>${show}</div>;
  return { setData, div: () => div, dispose: attach(Component, root) };
`;

describe("Testing an only child show control flow with keyed function", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      ofData(`
        <Show when={data()} keyed>
          {(item) => (
            <>
              <span>{item.count}</span>
              <span>counted</span>
            </>
          )}
        </Show>`),
    );
    expect(html(t.div())).toBe("");
  });

  test("Toggle show control flow", () => {
    t.setData({ count: 7 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    t.setData({ count: 5 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    t.setData({ count: 2 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("2");
    t.dispose();
  });
});

describe("Testing an only child show control flow with non-keyed function", () => {
  let t: Api;
  test("Create show control flow", () => {
    t = mount(
      ofData(`
        <Show when={data()}>
          {(data) => (
            <>
              <span>{data().count}</span>
              <span>counted</span>
            </>
          )}
        </Show>`),
    );
    expect(html(t.div())).toBe("");
  });

  test("Toggle show control flow", () => {
    t.setData({ count: 7 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    t.setData({ count: 5 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    t.setData({ count: 2 });
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("2");
    t.dispose();
  });
});

describe("Testing an only child show control flow with DOM children and fallback", () => {
  let t: Api;
  test("Create when control flow", () => {
    t = mount(`
      import { attach, Show, signal } from "@reactre/core";
      const [count, setCount] = signal(0);
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Show when={count() >= 5} fallback={<span>Too Low</span>}>
            <span>{count()}</span>
          </Show>
        </div>
      );
      return { setCount, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("<span>Too Low</span>");
  });

  test("Toggle show control flow", () => {
    t.setCount(7);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("7");
    t.setCount(5);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("5");
    t.setCount(2);
    flush();
    expect(html(t.div().firstChild as FakeElement)).toBe("Too Low");
    t.dispose();
  });
});

describe("Sibling Shows with isPending in a fragment (#2963)", () => {
  test("settled branch renders the same flush as the write", () => {
    const root = new FakeElement("DIV");
    const t = compile<Api>(
      `
      import { attach, Show, signal } from "@reactre/core";
      import { isPending } from "@reactre/core/features/async";
      const [state, setState] = signal({});
      const dispose = attach(
        () => (
          <>
            <Show when={isPending(state) || !!state().promise}>
              <span>submitting</span>
            </Show>
            <Show when={state().data}>{(d) => <span>result:{d()}</span>}</Show>
          </>
        ),
        root,
      );
      return { setState, dispose };
      `,
      modules,
      { root },
    );
    flush();
    expect(root.textContent).toBe("");
    t.setState({ promise: Promise.resolve("ok") });
    flush();
    expect(root.textContent).toBe("submitting");
    t.setState({ data: "ok" });
    flush();
    expect(root.textContent).toBe("result:ok");
    t.dispose();
  });
});

describe("isPending in Show `when` outside a Loading boundary (#3028)", () => {
  /** Let the async memo's promise settle. */
  const settle = async (): Promise<void> => {
    await tick();
    flush();
  };

  /** The issue's app: `when` is the <Show>'s condition, given the signal `a`. */
  function setup(when: string): Api & { container: FakeElement } {
    const container = new FakeElement("DIV");
    const t = compile<Api>(
      `
      import { attach, Show, signal } from "@reactre/core";
      import { isPending, memo } from "@reactre/core/features/async";
      const [a, setA] = signal(0);
      const resolvers = [];
      const double = memo(async () => {
        const x = a();
        await new Promise((r) => resolvers.push(r));
        return x * 2;
      });
      const when = ${when};
      const dispose = attach(
        () => (
          <div>
            Count: {a()} {double()}
            <Show when={when(a)}>...</Show>
          </div>
        ),
        container,
      );
      return { setA, resolveAll: () => resolvers.splice(0).forEach((r) => r()), dispose };
      `,
      modules,
      { container },
    );
    return Object.assign(t, { container });
  }

  gap(
    "pending-signal",
    "isPending(a) is false while the memo a feeds refetches",
    "shows the pending indicator while the async memo refetches",
    async () => {
      const t = setup("(a) => isPending(a)");
      flush();
      t.resolveAll();
      await settle();
      expect(t.container.textContent).toBe("Count: 0 0");
      t.setA(1);
      flush();
      expect(t.container.textContent).toBe("Count: 0 0...");
      t.resolveAll();
      await settle();
      expect(t.container.textContent).toBe("Count: 1 2");
      t.dispose();
    },
  );

  gap(
    "pending-signal",
    "isPending(a) is false while the memo a feeds refetches",
    "variant B from the issue: when reads a() before isPending(a)",
    async () => {
      const t = setup("(a) => { a(); return isPending(a); }");
      flush();
      t.resolveAll();
      await settle();
      expect(t.container.textContent).toBe("Count: 0 0");
      t.setA(1);
      flush();
      expect(t.container.textContent).toBe("Count: 0 0...");
      t.resolveAll();
      await settle();
      expect(t.container.textContent).toBe("Count: 1 2");
      t.dispose();
    },
  );
});

// #endregion

// #region switch.spec.tsx

describe("Testing a single match switch control flow", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(`
      import { attach, Match, signal, Switch } from "@reactre/core";
      const [count, setCount] = signal(0);
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Switch fallback={"fallback"}>
            <Match when={Boolean(count()) && count() < 2}>1</Match>
          </Switch>
        </div>
      );
      return { setCount, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("fallback");
  });

  test("Toggle Switch control flow", () => {
    t.setCount(1);
    flush();
    expect(html(t.div())).toBe("1");
    t.setCount(3);
    flush();
    expect(html(t.div())).toBe("fallback");
    t.dispose();
  });
});

describe("Testing an only child Switch control flow", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(`
      import { attach, Match, signal, Switch } from "@reactre/core";
      const [count, setCount] = signal(0);
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Switch fallback={"fallback"}>
            <Match when={Boolean(count()) && count() < 2}>1</Match>
            <Match when={Boolean(count()) && count() < 5}>2</Match>
            <Match when={Boolean(count()) && count() < 8}>3</Match>
          </Switch>
        </div>
      );
      return { setCount, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("fallback");
  });

  test("Toggle Switch control flow", () => {
    t.setCount(1);
    flush();
    expect(html(t.div())).toBe("1");
    t.setCount(4);
    flush();
    expect(html(t.div())).toBe("2");
    t.setCount(7);
    flush();
    expect(html(t.div())).toBe("3");
    t.setCount(9);
    flush();
    expect(html(t.div())).toBe("fallback");
  });

  test("doesn't re-render on same option", () => {
    t.setCount(4);
    flush();
    expect(html(t.div())).toBe("2");
    const c = t.div().firstChild;
    t.setCount(4);
    flush();
    expect(html(t.div())).toBe("2");
    expect(t.div().firstChild).toBe(c);
    t.dispose();
  });
});

/** switch.spec.tsx's sources over three signals: `matches` are the <Match> elements. */
const abc = (matches: string): string => `
  import { attach, Match, signal, Switch } from "@reactre/core";
  const [a, setA] = signal(0),
    [b, setB] = signal(0),
    [c, setC] = signal(0);
  let div;
  const Component = () => (
    <div ref={(el) => (div = el)}>
      <Switch fallback={"fallback"}>${matches}</Switch>
    </div>
  );
  return { setA, setB, setC, div: () => div, dispose: attach(Component, root) };
`;

/** The "Toggle" test of the three-signal describes. */
function toggleAbc(t: Api): void {
  t.setC(1);
  flush();
  expect(html(t.div())).toBe("1");
  t.setB(2);
  flush();
  expect(html(t.div())).toBe("2");
  t.setA(3);
  flush();
  expect(html(t.div())).toBe("3");
  t.setA(0);
  flush();
  expect(html(t.div())).toBe("2");
  t.dispose();
}

describe("Testing keyed Switch control flow", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(
      abc(`
        <Match when={a()} keyed>{a()}</Match>
        <Match when={b()} keyed>{b()}</Match>
        <Match when={c()} keyed>{c()}</Match>`),
    );
    expect(html(t.div())).toBe("fallback");
  });
  test("Toggle Switch control flow", () => toggleAbc(t));
});

describe("Testing keyed function handler Switch control flow", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(
      abc(`
        <Match when={a()} keyed>{(a) => a}</Match>
        <Match when={b()} keyed>{(b) => b}</Match>
        <Match when={c()} keyed>{(c) => c}</Match>`),
    );
    expect(html(t.div())).toBe("fallback");
  });
  test("Toggle Switch control flow", () => toggleAbc(t));
});

describe("Testing non-keyed function handler Switch control flow", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(
      abc(`
        <Match when={a()}>{(a) => <>{a()}</>}</Match>
        <Match when={b()}>{(b) => <>{b()}</>}</Match>
        <Match when={c()}>{(c) => <>{c()}</>}</Match>`),
    );
    expect(html(t.div())).toBe("fallback");
  });
  test("Toggle Switch control flow", () => toggleAbc(t));
});

describe("Testing Switch conditions evaluation counts", () => {
  let t: Api;
  test("Create Switch control flow", () => {
    t = mount(`
      import { attach, Match, signal, Switch } from "@reactre/core";
      function makeCondition() {
        const [get, set] = signal(0);
        const result = {
          get,
          set,
          evalCount: 0,
          getAndCount: () => {
            result.evalCount++;
            return get();
          },
        };
        return result;
      }
      const a = makeCondition(),
        b = makeCondition(),
        c = makeCondition();
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Switch fallback={"fallback"}>
            <Match when={a.getAndCount()}>a={a.get()}</Match>
            <Match when={b.getAndCount()}>{(b) => <>b={b()}</>}</Match>
            <Match when={c.getAndCount()} keyed>
              {(c) => <>c={c}</>}
            </Match>
          </Switch>
        </div>
      );
      return { a, b, c, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("fallback");
    expect(t.a.evalCount).toBe(1);
    expect(t.b.evalCount).toBe(1);
    expect(t.c.evalCount).toBe(1);
  });

  gap("switch-reads", "a change to c re-reads a's and b's conditions", "Toggle conditions", () => {
    const { a, b, c } = t;
    const step = (set: () => void, out: string, counts: [number, number, number]): void => {
      set();
      flush();
      expect(html(t.div())).toBe(out);
      expect([a.evalCount, b.evalCount, c.evalCount]).toEqual(counts);
    };
    step(() => c.set(5), "c=5", [1, 1, 2]);
    step(() => a.set(1), "a=1", [2, 1, 2]);
    step(() => b.set(3), "a=1", [2, 1, 2]); // b did not evaluate
    step(() => b.set(2), "a=1", [2, 1, 2]); // b did not evaluate
    step(() => a.set(0), "b=2", [3, 2, 2]); // b evaluated now
    step(() => b.set(3), "b=3", [3, 3, 2]);
    step(() => c.set(3), "b=3", [3, 3, 2]); // c did not evaluate
    step(() => a.set(1), "a=1", [4, 3, 2]);
    step(() => b.set(1), "a=1", [4, 3, 2]); // b did not evaluate
    step(() => b.set(0), "a=1", [4, 3, 2]); // b did not evaluate
    // b evaluated now, as b changed since its last evaluation; c evaluated now.
    step(() => a.set(0), "c=3", [5, 4, 3]);
    step(() => c.set(0), "fallback", [5, 4, 4]);
  });
  test("dispose", () => t.dispose());
});

describe("Testing non-keyed function handler Switch control flow with dangling callback", () => {
  let t: Api;
  gap(
    "stale-accessor",
    "reading a <Match>'s accessor after its branch went does not throw",
    "Create Switch control flow",
    async () => {
      t = mount(`
        import { attach, Match, signal, Switch } from "@reactre/core";
        const [a, setA] = signal(0),
          [b] = signal(2);
        let read;
        let div;
        const Component = () => (
          <div ref={(el) => (div = el)}>
            <Switch fallback={"fallback"}>
              <Match when={a()}>{(a) => <>{a()}</>}</Match>
              <Match when={b()}>
                {(b) => {
                  read = b;
                  return <>{b()}</>;
                }}
              </Match>
            </Switch>
          </div>
        );
        return { setA, read: () => read(), div: () => div, dispose: attach(Component, root) };
      `);
      t.setA(1);
      flush();
      expect(html(t.div())).toBe("1");
      // Solid reads the stale accessor in a timeout: it throws, and nothing is read.
      await tick();
      let delayed: unknown;
      expect(() => (delayed = t.read())).toThrow();
      expect(delayed).toBeUndefined();
    },
  );
  test("dispose", () => t.dispose());
});

describe("Testing a For in a Switch control flow", () => {
  let t: Api;
  gap("match-placement", "<Switch> refuses a <For> of <Match>es", "Create Switch control flow", () => {
    t = mount(`
      import { attach, For, Match, Switch } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [state, setState] = createStore({
        users: [
          { firstName: "Jerry", certified: false },
          { firstName: "Janice", certified: false },
        ],
      });
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Switch fallback={"fallback"}>
            <For each={state.users} key={(u) => u.firstName}>
              {(user) => <Match when={user.certified}>{user.firstName}</Match>}
            </For>
          </Switch>
        </div>
      );
      return { setState, div: () => div, dispose: attach(Component, root) };
    `);
    expect(html(t.div())).toBe("fallback");
  });

  gap("match-placement", "<Switch> refuses a <For> of <Match>es", "Toggle Switch control flow", () => {
    t.setState((s: { users: { certified: boolean }[] }) => {
      s.users[1]!.certified = true;
    });
    flush();
    expect(html(t.div())).toBe("Janice");
    t.setState((s: { users: { certified: boolean }[] }) => {
      s.users[0]!.certified = true;
    });
    flush();
    expect(html(t.div())).toBe("Jerry");
    t.setState((s: { users: { firstName: string; certified: boolean }[] }) => {
      s.users.unshift({ firstName: "Gordy", certified: true });
    });
    flush();
    expect(html(t.div())).toBe("Gordy");
    t.dispose();
  });
});

describe("Conditionally included Match children (#2911)", () => {
  let t: Api;
  gap(
    "match-placement",
    "<Switch> refuses a <Show> around a <Match>",
    "mounts with the gate off (nullish child slot)",
    () => {
      t = mount(`
      import { attach, Match, Show, signal, Switch } from "@reactre/core";
      const [extra, setExtra] = signal(false);
      const [route, setRoute] = signal("b");
      let div;
      const Component = () => (
        <div ref={(el) => (div = el)}>
          <Switch fallback={<span>none</span>}>
            <Show when={extra()}>
              <Match when={route() === "b"}>
                <span>EXTRA-B</span>
              </Match>
            </Show>
            <Match when={route() === "a"}>
              <span>A</span>
            </Match>
            <Match when={route() === "b"}>
              <span>B</span>
            </Match>
          </Switch>
        </div>
      );
      return { setExtra, setRoute, div: () => div, dispose: attach(Component, root) };
    `);
      expect(html(t.div())).toBe("<span>B</span>");
    },
  );

  gap(
    "match-placement",
    "<Switch> refuses a <Show> around a <Match>",
    "gate on: gated Match participates in selection order",
    () => {
      t.setExtra(true);
      flush();
      expect(html(t.div())).toBe("<span>EXTRA-B</span>");
    },
  );

  gap(
    "match-placement",
    "<Switch> refuses a <Show> around a <Match>",
    "gate back off: selection falls through to later matches",
    () => {
      t.setExtra(false);
      flush();
      expect(html(t.div())).toBe("<span>B</span>");
      t.setRoute("a");
      flush();
      expect(html(t.div())).toBe("<span>A</span>");
      t.setRoute("x");
      flush();
      expect(html(t.div())).toBe("<span>none</span>");
      t.dispose();
    },
  );
});

describe("Test top level switch control flow", () => {
  test("Create switch control flow", () => {
    const div = new FakeElement("DIV");
    const t = compile<Api>(
      `
      import { attach, Match, signal, Switch } from "@reactre/core";
      const [count, setCount] = signal(0);
      const Component = () => (
        <Switch fallback={"fallback"}>
          <Match when={Boolean(count()) && count() < 2}>1</Match>
        </Switch>
      );
      return { setCount, dispose: attach(Component, div) };
      `,
      modules,
      { div },
    );
    expect(html(div)).toBe("fallback");
    t.setCount(1);
    flush();
    expect(html(div)).toBe("1");
    t.dispose();
    expect(html(div)).toBe("");
  });
});

// #endregion
