// Ports of Solid 2.0's error-boundary tests to <Errored>, effect(fn, { error }) and
// configureClientErrors (@reactre/core/features/errors): the synchronous tests of
// packages/signals/tests/createErrorBoundary.test.ts, packages/signals/tests/client-error-hook.test.ts,
// packages/web/test/errored.spec.tsx and packages/web/test/client-error-hook.spec.tsx, from
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's signals layer has `createErrorBoundary(fn, fallback)`, a memo of `fn()` or of the
// fallback; its tests read the memo. reactre has the component, <Errored>, as Solid's solid-js
// layer does: the ports render the boundary and read the page's text. A Solid fallback gets an
// accessor of the error (`err()`); reactre's gets the error, so `err()` is written `err`.
// createRenderEffect and createEffect, two halves, are `reaction` (features/reaction).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, type FakeNode, installFakeDocument } from "@reactre/testdom";

import * as context from "../../src/features/context.ts";
import * as errors from "../../src/features/errors.ts";
import { configureClientErrors } from "../../src/features/errors.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush } from "../../src/features/timing.ts";
import { signal as coreSignal } from "../../src/index.ts";
import { base, compile, gap } from "./harness.ts";

const modules = { ...base, "@reactre/core/features/context": context, "@reactre/core/features/errors": errors };

beforeEach(installFakeDocument);
afterEach(() => configureClientErrors({}));

const text = (n: FakeElement): string => n.textContent ?? "";

/** The markup of `n`'s children, elements and text (the fake DOM has no innerHTML getter). */
function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      out += `<${tag}>${html(c)}</${tag}>`;
    } else if (c.nodeType === 3) out += c.textContent ?? "";
  }
  return out;
}

/** Run TSX module body `src` (ending in `return { ... }`), with `root` and `scope`'s names in scope. */
function run<T>(src: string, root: FakeElement, scope: Record<string, unknown> = {}): T {
  return compile<T>(src, modules, { root, expect, ...scope });
}

/** A mock, whose calls a test reads. */
type Calls = ReturnType<typeof mock>;

describe("signals/tests/createErrorBoundary.test.ts", () => {
  test("should let errors bubble up when not handled", () => {
    const error = new Error();
    let caught: unknown;
    try {
      createRoot(() => {
        reaction(
          () => {
            throw error;
          },
          () => {},
        );
      });
      flush();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { cause?: unknown }).cause ?? caught).toBe(error);
  });

  test("should handle error", () => {
    const root = new FakeElement("DIV");
    run(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const Throws = () => { throw error; };
      render(() => <div><Errored fallback={() => "errored"}><Throws /></Errored></div>, root);
      return {};
    `,
      root,
      { error: new Error() },
    );
    expect(text(root)).toBe("errored");
  });

  test("should forward error to another handler", () => {
    const root = new FakeElement("DIV");
    const error = new Error();
    run(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const Throws = () => { throw error; };
      render(
        () => (
          <div>
            <Errored fallback={() => "errored"}>
              <Errored fallback={(e) => { expect(e).toBe(error); throw e; }}>
                <Throws />
              </Errored>
            </Errored>
          </div>
        ),
        root,
      );
      return {};
    `,
      root,
      { error },
    );
    expect(text(root)).toBe("errored");
  });

  test("should not duplicate error handler", () => {
    const root = new FakeElement("DIV");
    const error = new Error(),
      handler = mock((_: unknown) => "errored");
    const api = run<{ setX: (n: number) => void; fail: () => void }>(
      `
      import { effect, render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [x, setX] = signal(0);
      let shouldThrow = false;
      const Content = () => {
        effect(() => { x(); if (shouldThrow) throw error; });
        return null;
      };
      render(() => <div><Errored fallback={(err) => handler(err)}><Content /></Errored></div>, root);
      return { setX, fail: () => (shouldThrow = true) };
    `,
      root,
      { error, handler },
    );
    api.setX(1);
    flush();
    api.fail();
    api.setX(2);
    flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("should not trigger wrong handler", () => {
    const root = new FakeElement("DIV");
    const error = new Error(),
      rootHandler = mock((_: unknown) => "errored"),
      handler = mock((_: unknown) => "errored");
    const api = run<{ setX: (n: number) => void; fail: () => void }>(
      `
      import { render, signal } from "@reactre/core";
      import { reaction } from "@reactre/core/features/reaction";
      import { Errored } from "@reactre/core/features/errors";
      const [x, setX] = signal(0);
      let shouldThrow = false;
      const Content = () => {
        reaction(() => { x(); if (shouldThrow) throw error; }, () => {});
        return <Errored fallback={(err) => handler(err)}>{() => null}</Errored>;
      };
      render(() => <div><Errored fallback={(err) => rootHandler(err)}><Content /></Errored></div>, root);
      return { setX, fail: () => (shouldThrow = true) };
    `,
      root,
      { error, rootHandler, handler },
    );
    expect(rootHandler).toHaveBeenCalledTimes(0);
    api.fail();
    api.setX(1);
    flush();
    expect(rootHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalledWith(error);
  });

  test("should throw error if there are no handlers left", () => {
    const root = new FakeElement("DIV");
    const error = new Error(),
      handler = mock((e: unknown) => {
        throw e;
      });
    let caught: unknown;
    try {
      run(
        `
        import { render } from "@reactre/core";
        import { Errored } from "@reactre/core/features/errors";
        const Throws = () => { throw error; };
        render(
          () => <div><Errored fallback={handler}><Errored fallback={handler}><Throws /></Errored></Errored></div>,
          root,
        );
        return {};
      `,
        root,
        { error, handler },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { cause?: unknown }).cause ?? caught).toBe(error);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("should handle errors when the effect is on the outside", () => {
    const root = new FakeElement("DIV");
    const error = new Error(),
      rootHandler = mock((_: unknown) => "errored");
    const api = run<{ setX: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [x, setX] = signal(0);
      const Throws = () => { throw error; };
      render(
        () => (
          <div>
            <Errored fallback={(err) => rootHandler(err)}>
              {() => {
                if (x()) throw error;
                return <Errored fallback={(e) => { expect(e).toBe(error); return null; }}><Throws /></Errored>;
              }}
            </Errored>
          </div>
        ),
        root,
      );
      return { setX };
    `,
      root,
      { error, rootHandler },
    );
    expect(rootHandler).toHaveBeenCalledTimes(0);
    api.setX(1);
    flush();
    expect(rootHandler).toHaveBeenCalledWith(error);
    expect(rootHandler).toHaveBeenCalledTimes(1);
  });

  test("should handle errors when the effect is on the outside and memo in the middle", () => {
    const root = new FakeElement("DIV");
    const error = new Error(),
      rootHandler = mock((_: unknown) => "errored");
    run(
      `
      import { memo, render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const Content = () => {
        memo(() => { throw error; });
        return null;
      };
      render(() => <div><Errored fallback={(err) => rootHandler(err)}><Content /></Errored></div>, root);
      return {};
    `,
      root,
      { error, rootHandler },
    );
    expect(rootHandler).toHaveBeenCalledTimes(1);
  });

  /** A boundary over `content`'s component body, whose fallback calls `handler` and shows "errored". */
  function boundary(
    content: string,
    scope: Record<string, unknown>,
  ): { root: FakeElement; api: Record<string, never> } {
    const root = new FakeElement("DIV");
    const api = run<Record<string, never>>(
      `
      import { effect, memo, render, signal } from "@reactre/core";
      import { reaction } from "@reactre/core/features/reaction";
      import { Errored } from "@reactre/core/features/errors";
      const api = {};
      const Content = () => { ${content} };
      render(
        () => (
          <div>
            <Errored fallback={(err, reset) => { api.reset = reset; handler(err); return "errored"; }}>
              <Content />
            </Errored>
          </div>
        ),
        root,
      );
      return api;
    `,
      root,
      scope,
    );
    return { root, api };
  }

  test("should catch errors thrown in render effect callbacks (back half)", () => {
    const error = new Error("effect callback error");
    const handler = mock();
    boundary(`reaction(() => "value", () => { throw error; }); return "content";`, { error, handler });
    flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(error);
  });

  test("should catch errors thrown in user effect callbacks (back half)", () => {
    const error = new Error("user effect callback error");
    const handler = mock();
    const { root } = boundary(`reaction(() => "value", () => { throw error; }); return "content";`, {
      error,
      handler,
    });
    flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(error);
    expect(text(root)).toBe("errored");
  });

  test("should catch errors thrown in effect cleanup functions (#2813)", () => {
    const handler: Calls = mock();
    const { root, api } = boundary(
      `
      const [n, setN] = signal(0);
      api.setN = setN;
      reaction(n, (v) => () => { if (v === 0) throw new Error("cleanup boom"); });
      return "content";
    `,
      { handler },
    );
    flush();
    (api as unknown as { setN: (n: number) => void }).setN(1);
    flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(String(handler.mock.calls[0]![0])).toContain("cleanup boom");
    expect(text(root)).toBe("errored");
  });

  gap(
    "effect-bundle",
    "reaction takes an apply function, not an { effect, error } bundle",
    "should catch errors thrown in user effect callbacks with error handler (back half)",
    () => {
      const error = new Error("user effect bundle error");
      const handler = mock();
      const errorHandler = mock();
      const { root } = boundary(
        `reaction(() => "value", { effect: () => { throw error; }, error: errorHandler }); return "content";`,
        { error, handler, errorHandler },
      );
      flush();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(error);
      expect(text(root)).toBe("errored");
    },
  );

  test("should recover from effect callback error after reset", () => {
    const error = new Error("effect callback error");
    let shouldThrow = true;
    const { root, api } = boundary(
      `reaction(() => "value", () => { if (shouldThrow()) throw error; }); return "content";`,
      { error, handler: () => {}, shouldThrow: () => shouldThrow },
    );
    flush();
    expect(text(root)).toBe("errored");
    const { reset } = api as unknown as { reset: () => void };
    expect(reset).toBeDefined();
    shouldThrow = false;
    reset();
    flush();
    expect(text(root)).toBe("content");
  });

  test("should throw effect callback errors when no boundary exists", () => {
    const error = new Error("uncaught effect error");
    expect(() => {
      createRoot(() => {
        reaction(
          () => "value",
          () => {
            throw error;
          },
        );
      });
      flush();
    }).toThrowError(error);
  });

  gap(
    "memo-errors",
    "a memo that throws throws where it is made, at once, not to the boundary of the reader",
    "should recover when sync memo errors then dependency changes and boundary resets",
    () => {
      const root = new FakeElement("DIV");
      const api = run<{ setId: (id: string) => void; reset: () => void }>(
        `
        import { memo, render, signal } from "@reactre/core";
        import { Errored } from "@reactre/core/features/errors";
        const [id, setId] = signal("bad");
        let reset;
        render(() => {
          const data = memo(() => {
            const v = id();
            if (v !== "1") throw new Error("Item " + v + " not found");
            return "ok";
          });
          return (
            <div>
              <Errored fallback={(err, r) => { reset = r; return "error"; }}>{() => data()}</Errored>
            </div>
          );
        }, root);
        return { setId, reset: () => reset() };
      `,
        root,
      );
      flush();
      expect(text(root)).toBe("error");
      api.setId("1");
      api.reset();
      flush();
      expect(text(root)).toBe("ok");
    },
  );

  gap(
    "error-accessor",
    "the fallback gets the first error, and the children behind it are disposed",
    "instantiates the fallback once per show: a second error reaches it through the `error` accessor, not a re-render",
    () => {
      const root = new FakeElement("DIV");
      let fallbackRuns = 0;
      let shown: unknown;
      const api = run<{ setA: (n: number) => void; setB: (n: number) => void }>(
        `
        import { render, signal } from "@reactre/core";
        import { reaction } from "@reactre/core/features/reaction";
        import { Errored } from "@reactre/core/features/errors";
        const [a, setA] = signal(0);
        const [b, setB] = signal(0);
        const Content = () => {
          reaction(() => { if (a() > 0) throw new Error("a:" + a()); }, () => {});
          reaction(() => { if (b() > 0) throw new Error("b:" + b()); }, () => {});
          return "content";
        };
        render(
          () => (
            <div>
              <Errored fallback={(err) => { onFallback(err); return "fallback"; }}>
                <Content />
              </Errored>
            </div>
          ),
          root,
        );
        return { setA, setB };
      `,
        root,
        {
          onFallback: (err: Error) => {
            fallbackRuns++;
            shown = err.message;
          },
        },
      );
      flush();
      expect(fallbackRuns).toBe(0);
      api.setA(1);
      flush();
      expect(fallbackRuns).toBe(1);
      expect(shown).toBe("a:1");
      // A second reader errors while the fallback shows: it is not rebuilt; the error moves on.
      api.setB(1);
      flush();
      expect(fallbackRuns).toBe(1);
      expect(shown).toBe("b:1");
    },
  );

  test("holds user effects behind the error fallback until recovery", () => {
    const root = new FakeElement("DIV");
    const log: string[] = [];
    const api = run<{ setCount: (n: number) => void; setBad: (b: boolean) => void; reset: () => void }>(
      `
      import { render, signal } from "@reactre/core";
      import { reaction } from "@reactre/core/features/reaction";
      import { Errored } from "@reactre/core/features/errors";
      const [count, setCount] = signal(0);
      const [bad, setBad] = signal(false);
      let reset;
      const Content = () => {
        reaction(count, (v) => void log.push("user " + v));
        reaction(() => { if (bad()) throw new Error("boom"); }, () => {});
        return "content";
      };
      render(
        () => (
          <div>
            <Errored fallback={(_e, r) => { reset = r; return "fallback"; }}>
              <Content />
            </Errored>
          </div>
        ),
        root,
      );
      return { setCount, setBad, reset: () => reset() };
    `,
      root,
      { log },
    );
    flush();
    expect(text(root)).toBe("content");
    expect(log).toEqual(["user 0"]);
    api.setBad(true);
    flush();
    expect(text(root)).toBe("fallback");
    // Behind the fallback: due, not run.
    api.setCount(1);
    flush();
    expect(log).toEqual(["user 0"]);
    api.setBad(false);
    api.reset();
    flush();
    expect(text(root)).toBe("content");
    expect(log).toEqual(["user 0", "user 1"]);
  });
});

/** The components of web/test/errored.spec.tsx's first describe. */
const failing = `
  import { render } from "@reactre/core";
  import { Errored } from "@reactre/core/features/errors";
  const Component = () => {
    throw new Error("Failure");
  };
  let first = true;
  const Component2 = () => {
    if (first) {
      first = false;
      throw new Error("Failure");
    }
    return "Success";
  };
  const Component3 = () => {
    throw null;
  };
`;

describe("web/test/errored.spec.tsx: Testing Errored control flow", () => {
  /** Render `view` over the components into a root's <div>: the <div>. */
  function inDiv(view: string): { div: FakeElement; api: { reset: () => void } } {
    const root = new FakeElement("DIV");
    const api = run<{ reset: () => void }>(
      `${failing}\nlet r;\nrender(() => <div>${view}</div>, root);\nreturn { reset: () => r() };`,
      root,
    );
    return { div: root.firstChild as FakeElement, api };
  }

  test("Create an Error", () => {
    const { div } = inDiv(`<Errored fallback="Failed Miserably"><Component /></Errored>`);
    expect(text(div)).toBe("Failed Miserably");
  });

  test("Create an Error with null", () => {
    const { div } = inDiv(`<Errored fallback="Failed Miserably"><Component3 /></Errored>`);
    expect(text(div)).toBe("Failed Miserably");
  });

  test("Create an Error callback", () => {
    const { div } = inDiv(`<Errored fallback={(e) => String(e)}><Component /></Errored>`);
    expect(text(div)).toBe("Error: Failure");
  });

  test("Create an Error callback and reset", () => {
    const { div, api } = inDiv(
      `<Errored fallback={(e, reset) => { r = reset; return String(e); }}><Component2 /></Errored>`,
    );
    expect(text(div)).toBe("Error: Failure");
    flush();
    api.reset();
    flush();
    expect(text(div)).toBe("Success");
  });

  test("Create an Error in an Error Fallback", () => {
    const { div } = inDiv(
      `<Errored fallback="Failed Miserably"><Errored fallback={<Component />}><Component /></Errored></Errored>`,
    );
    expect(text(div)).toBe("Failed Miserably");
  });
});

describe("web/test/errored.spec.tsx: Errored function-valued fallback resolves inside the boundary", () => {
  const throws = `
    import { render, signal } from "@reactre/core";
    import { Errored } from "@reactre/core/features/errors";
    const Throws = () => {
      throw new Error("Failure");
    };
  `;

  /** console.error, mocked for a test, and put back by `restore`. */
  function spyError(): { calls: unknown[][]; restore: () => void } {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => void calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  gap(
    "dev-checks",
    "the dev build does not log an error that a fallback cannot see",
    "zero-arity fallback thunk renders",
    () => {
      const div = new FakeElement("DIV");
      const error = spyError();
      try {
        run(
          `${throws}\nrender(() => <Errored fallback={() => <b>fell</b>}><Throws /></Errored>, root);\nreturn {};`,
          div,
        );
        flush();
        expect(html(div)).toBe("<b>fell</b>");
        expect(error.calls.some((a) => (a[0] as Error | undefined)?.message === "Failure")).toBe(true);
      } finally {
        error.restore();
      }
    },
  );

  gap(
    "fallback-tracking",
    "the fallback runs untracked: a signal it reads does not re-render it",
    "zero-arity fallback that reads a signal re-renders when it changes",
    () => {
      const div = new FakeElement("DIV");
      const error = spyError();
      try {
        const api = run<{ setCount: (n: number) => void; runs: () => number }>(
          `${throws}
          const [count, setCount] = signal(0);
          let runs = 0;
          render(
            () => (
              <Errored fallback={() => { runs++; return count() > 0 ? <b>many {count()}</b> : <i>none</i>; }}>
                <Throws />
              </Errored>
            ),
            root,
          );
          return { setCount, runs: () => runs };`,
          div,
        );
        flush();
        expect(html(div)).toBe("<i>none</i>");
        expect(api.runs()).toBe(1);
        api.setCount(2);
        flush();
        expect(html(div)).toBe("<b>many 2</b>");
        expect(api.runs()).toBe(2);
        api.setCount(3);
        flush();
        expect(html(div)).toBe("<b>many 3</b>");
      } finally {
        error.restore();
      }
    },
  );

  test("a rest-parameter fallback (length 0) still receives the error and reset", () => {
    const div = new FakeElement("DIV");
    const error = spyError();
    try {
      const api = run<{ reset: () => void }>(
        `${throws}
        let first = true;
        const Flaky = () => {
          if (first) {
            first = false;
            throw new Error("Failure");
          }
          return <b>ok</b>;
        };
        let reset;
        render(
          () => (
            <Errored fallback={(...args) => { reset = args[1]; return <i>{String(args[0])}</i>; }}>
              <Flaky />
            </Errored>
          ),
          root,
        );
        return { reset: () => reset() };`,
        div,
      );
      flush();
      expect(html(div)).toBe("<i>Error: Failure</i>");
      api.reset();
      flush();
      expect(html(div)).toBe("<b>ok</b>");
    } finally {
      error.restore();
    }
  });

  test("two-arity fallback is unchanged: error accessor, reset, no dev error log", () => {
    const div = new FakeElement("DIV");
    const error = spyError();
    try {
      const api = run<{ reset: () => void }>(
        `${throws}
        let first = true;
        const Flaky = () => {
          if (first) {
            first = false;
            throw new Error("Failure");
          }
          return <b>ok</b>;
        };
        let reset;
        render(
          () => (
            <Errored fallback={(err, r) => { reset = r; return <i>{String(err)}</i>; }}>
              <Flaky />
            </Errored>
          ),
          root,
        );
        return { reset: () => reset() };`,
        div,
      );
      flush();
      expect(html(div)).toBe("<i>Error: Failure</i>");
      expect(error.calls).toHaveLength(0);
      api.reset();
      flush();
      expect(html(div)).toBe("<b>ok</b>");
    } finally {
      error.restore();
    }
  });
});

/** What a client error hook heard: the error, and where. */
type Call = { error: unknown; context: unknown };

/** configureClientErrors's options as Solid's take them: a hook of the error and its context. */
const configure = configureClientErrors as (o: { onError?: unknown }) => void;

/** A hook that records its calls. */
const hook =
  (calls: Call[]) =>
  (error: unknown, context?: unknown): void =>
    void calls.push({ error, context });

/** A boundary over a view that throws while `fail()` is set: the page's text, and the boundary's reset. */
function boundaryOver(fail: () => boolean, boom: () => unknown): { value: () => string; reset: () => void } {
  const root = new FakeElement("DIV");
  const api = run<{ reset: () => void }>(
    `
    import { render } from "@reactre/core";
    import { Errored } from "@reactre/core/features/errors";
    let reset;
    const check = () => { if (fail()) throw boom(); return "content"; };
    const View = () => <b>{check()}</b>;
    render(
      () => (
        <div>
          <Errored fallback={(_err, r) => { reset = r; return "fallback"; }}>
            <View />
          </Errored>
        </div>
      ),
      root,
    );
    return { reset: () => reset() };
  `,
    root,
    { fail, boom },
  );
  flush();
  return { value: () => text(root), reset: api.reset };
}

describe("signals/tests/client-error-hook.test.ts: caught", () => {
  gap(
    "client-error-hook",
    "onError hears only what no boundary caught",
    "a boundary rendering its fallback reports the error once, with what it caught",
    () => {
      const calls: Call[] = [];
      configure({ onError: hook(calls) });
      const boom = new Error("boom");
      const [fail, setFail] = coreSignal(false);
      const view = boundaryOver(fail, () => boom);
      expect(view.value()).toBe("content");
      expect(calls).toHaveLength(0);
      setFail(true);
      flush();
      expect(view.value()).toBe("fallback");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.error).toBe(boom);
      expect(calls[0]!.context).toEqual({ ownerPath: ["view"] });
    },
  );

  gap(
    "client-error-hook",
    "onError hears only what no boundary caught",
    "a reset that recomputes the same failure says nothing new; a different error is a new report",
    () => {
      const calls: Call[] = [];
      configure({ onError: hook(calls) });
      let boom: unknown = new Error("first");
      const [fail, setFail] = coreSignal(true);
      const view = boundaryOver(fail, () => boom);
      expect(view.value()).toBe("fallback");
      expect(calls).toHaveLength(1);
      view.reset();
      flush();
      expect(view.value()).toBe("fallback");
      expect(calls).toHaveLength(1);
      setFail(false);
      view.reset();
      flush();
      expect(view.value()).toBe("content");
      setFail(true);
      flush();
      expect(calls).toHaveLength(1);
      setFail(false);
      view.reset();
      flush();
      boom = new Error("second");
      setFail(true);
      flush();
      expect(calls).toHaveLength(2);
      expect((calls[1]!.error as Error).message).toBe("second");
    },
  );

  gap(
    "client-error-hook",
    "onError hears only what no boundary caught",
    "a primitive thrown has no identity and is reported per sight",
    () => {
      const calls: Call[] = [];
      configure({ onError: hook(calls) });
      const [fail] = coreSignal(true);
      const view = boundaryOver(fail, () => "token abc");
      expect(calls).toHaveLength(1);
      view.reset();
      flush();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.error).toBe("token abc");
    },
  );

  gap(
    "client-error-hook",
    "onError hears only what no boundary caught, with no owner path",
    "carries the owner path where owners are labelled",
    () => {
      const calls: Call[] = [];
      configure({ onError: hook(calls) });
      const [fail] = coreSignal(true);
      const view = boundaryOver(fail, () => new Error("boom"));
      expect(view.value()).toBe("fallback");
      expect(calls).toHaveLength(1);
      expect((calls[0]!.context as { ownerPath?: unknown }).ownerPath).toEqual(["<App>", "children"]);
      expect((calls[0]!.context as { boundaryPath?: unknown }).boundaryPath).toEqual(["<App>"]);
    },
  );
});

describe("signals/tests/client-error-hook.test.ts: two tiers", () => {
  gap(
    "client-error-hook",
    "no root-level hook (ROOT_ERROR_HOOK), and onError hears only what no boundary caught",
    "a root's own hook (under ROOT_ERROR_HOOK) wins over the ambient one for failures under it",
    () => {
      const ambient: Call[] = [];
      configure({ onError: hook(ambient) });
      const { ROOT_ERROR_HOOK } = errors as unknown as { ROOT_ERROR_HOOK?: symbol };
      expect(ROOT_ERROR_HOOK).toBeDefined();
    },
  );

  gap(
    "client-error-hook",
    "onError hears only what no boundary caught",
    "a throwing hook is reported on the console; the boundary still renders",
    () => {
      const original = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        configure({
          onError: () => {
            throw new Error("hook broke");
          },
        });
        const [fail] = coreSignal(true);
        const view = boundaryOver(fail, () => new Error("boom"));
        expect(view.value()).toBe("fallback");
        expect(logged.some((args) => String(args[0]).includes("hook broke"))).toBe(true);
      } finally {
        console.error = original;
      }
    },
  );

  gap("client-error-hook", "configureClientErrors does not check onError", "refuses a non-function", () => {
    expect(() => configure({ onError: 42 })).toThrow(TypeError);
  });
});

describe("web/test/client-error-hook.spec.tsx: render's onError", () => {
  gap(
    "client-error-hook",
    "render takes no onError, and onError hears only what no boundary caught",
    "an <Errored> fallback under the root reports once, with the component labels",
    () => {
      const calls: Call[] = [];
      configure({ onError: hook(calls) });
      const boom = new Error("boom");
      const [fail, setFail] = coreSignal(false);
      const view = boundaryOver(fail, () => boom);
      expect(view.value()).toBe("content");
      expect(calls).toHaveLength(0);
      setFail(true);
      flush();
      expect(view.value()).toBe("fallback");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.error).toBe(boom);
      expect((calls[0]!.context as { ownerPath?: unknown }).ownerPath).toEqual([
        "<App>",
        "<Errored>",
        "children",
        "<Widget>",
        "text",
      ]);
    },
  );

  gap(
    "client-error-hook",
    "render takes no onError, and onError hears only what no boundary caught",
    "the root's hook wins over the ambient one; a root without one reports ambiently",
    () => {
      const ambient: Call[] = [];
      configure({ onError: hook(ambient) });
      const [fail] = coreSignal(true);
      boundaryOver(fail, () => new Error("boom"));
      expect(ambient).toHaveLength(1);
    },
  );
});
