// <Errored>, effect(fn, { error }) and configureClientErrors (@reactre/core/features/errors), on
// the unbundled runtime: TSX sources here are compiled as the plugin compiles them. A boundary
// reads its children inside its try, so the sources give them to it unbuilt, as a getter (`get
// children()`, the form lazy children compile to) or as a function child.
//
// Importing the module installs it in the one runtime instance every test file shares, as
// features/selectors is installed: from then on effects and rows are guarded, and with no
// boundary and no `onError` what they throw is thrown on, as before. Each test that sets
// `onError` clears it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as context from "../src/features/context.ts";
import * as errors from "../src/features/errors.ts";
import { configureClientErrors, effect } from "../src/features/errors.ts";
import * as core from "../src/index.ts";
import { signal } from "../src/index.ts";

/** What a source's imports of @reactre/core and of its feature modules bind to. */
const runtime = { ...core, ...context, ...errors };

beforeEach(installFakeDocument);
afterEach(() => configureClientErrors({}));

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "@reactre\/core(?:\/features\/\w+)?";$/gm,
    (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
  );
  return new Function("rr", "root", js)(runtime, root) as T;
}

const text = (n: FakeElement): string => n.textContent ?? "";

type Api = Record<string, (...a: never[]) => unknown> & { log: string[] };

describe("<Errored>", () => {
  test("a component that throws while the children are built: the fallback, and what they made is gone", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { effect, onCleanup, render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const log = [];
      const [n, setN] = signal(0);
      function Good() {
        effect(() => log.push("run " + n()));
        onCleanup(() => log.push("cleanup"));
        return <b>good</b>;
      }
      function Bad() {
        throw new Error("bad");
      }
      render(
        () => (
          <div>
            {Errored({ fallback: <i>static</i>, get children() { return [<Good />, <Bad />]; } })}
            {Errored({ fallback: (e) => <i>{e.message}</i>, get children() { return <Bad />; } })}
          </div>
        ),
        root,
      );
      return { log, setN };
    `,
      root,
    );
    expect(text(root)).toBe("staticbad");
    expect(api.log).toEqual(["run 0", "cleanup"]);
    api.setN!(1 as never);
    expect(api.log).toEqual(["run 0", "cleanup"]);
  });

  test("an effect that throws on an update: the fallback, once its run has ended; reset builds the children again", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      const check = (v) => { if (v === 1) throw new Error("one"); return v; };
      const Count = () => <b>{check(n())}</b>;
      let retry;
      render(
        () => (
          <div>
            {Errored({
              fallback: (err, reset) => ((retry = reset), <i>{err.message}</i>),
              get children() { return <Count />; },
            })}
          </div>
        ),
        root,
      );
      return { setN, retry: () => retry(), log: [] };
    `,
      root,
    );
    expect(text(root)).toBe("0");
    api.setN!(1 as never);
    expect(text(root)).toBe("one");
    api.setN!(2 as never);
    expect(text(root)).toBe("one");
    api.retry!();
    expect(text(root)).toBe("2");
    // A reset while the children show does nothing.
    api.retry!();
    expect(text(root)).toBe("2");
  });

  test("an effect's first run that throws while the children are built; the first error is the one shown", () => {
    const root = new FakeElement("DIV");
    run(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const boom = (m) => { throw new Error(m); };
      const Two = () => <p><b>{boom("first")}</b><b>{boom("second")}</b></p>;
      // A hole's first run throws (caught by its effect), then the body throws (caught by the
      // children's slot).
      const Late = () => {
        const p = <p><b>{boom("in a hole")}</b></p>;
        boom("in the body");
        return p;
      };
      render(
        () => (
          <div>
            {Errored({ fallback: (e) => e.message, get children() { return <Two />; } })}
            {Errored({ fallback: (e) => " " + e.message, get children() { return <Late />; } })}
          </div>
        ),
        root,
      );
      return {};
    `,
      root,
    );
    expect(text(root)).toBe("first in a hole");
  });

  test("a row's reactive hole that throws when a signal re-runs it, or when the row is made", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      const [rows, setRows] = signal([1]);
      const check = (r, v) => { if (v === r) throw new Error("row " + r); return v; };
      render(
        () => (
          <div>
            {Errored({
              fallback: (e) => e.message,
              get children() { return <ul><For each={rows()} key={(r) => r}>{(r) => <li>{check(r, n())}</li>}</For></ul>; },
            })}
          </div>
        ),
        root,
      );
      return { setN, setRows, log: [] };
    `,
      root,
    );
    expect(text(root)).toBe("0");
    api.setN!(1 as never);
    expect(text(root)).toBe("row 1");

    const root2 = new FakeElement("DIV");
    const api2 = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [rows, setRows] = signal([1]);
      const check = (r) => { if (r === 2) throw new Error("made " + r); return r; };
      render(
        () => (
          <div>
            {Errored({
              fallback: (e) => e.message,
              get children() { return <ul><For each={rows()} key={(r) => r}>{(r) => <li>{check(r)}</li>}</For></ul>; },
            })}
          </div>
        ),
        root,
      );
      return { setRows, log: [] };
    `,
      root2,
    );
    expect(text(root2)).toBe("1");
    api2.setRows!([1, 2] as never);
    expect(text(root2)).toBe("made 2");
  });

  test("a function child is a slot inside the boundary: what its later runs throw is caught", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      render(
        () => <div><Errored fallback="caught">{() => { if (n()) throw new Error("x"); return "fine"; }}</Errored></div>,
        root,
      );
      return { setN, log: [] };
    `,
      root,
    );
    expect(text(root)).toBe("fine");
    api.setN!(1 as never);
    expect(text(root)).toBe("caught");
  });

  test("children whose getter reads a signal are read again when it changes; what that throws is caught", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [n, setN] = signal(0);
      const Bad = () => { throw new Error("bad " + n()); };
      let retry;
      render(
        () => (
          <div>
            {Errored({
              fallback: (e, reset) => ((retry = reset), e.message),
              get children() { return n() === 1 ? <Bad /> : <b>{n()}</b>; },
            })}
          </div>
        ),
        root,
      );
      return { setN, retry: () => retry(), log: [] };
    `,
      root,
    );
    expect(text(root)).toBe("0");
    api.setN!(1 as never);
    expect(text(root)).toBe("bad 1");
    api.setN!(2 as never);
    api.retry!();
    expect(text(root)).toBe("2");
  });

  test("what the fallback throws goes to the boundary above; a boundary in a slot waits for the slot's run", () => {
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      const [on, setOn] = signal(false);
      const boom = (m) => { throw new Error(m); };
      const Bad = () => <b>{boom("inner")}</b>;
      render(
        () => (
          <div>
            {on()
              ? Errored({
                  fallback: (e) => "outer got " + e.message,
                  get children() {
                    return Errored({ fallback: (e) => boom("fallback of " + e.message), get children() { return <Bad />; } });
                  },
                })
              : "off"}
          </div>
        ),
        root,
      );
      return { setOn, log: [] };
    `,
      root,
    );
    expect(text(root)).toBe("off");
    api.setOn!(true as never);
    expect(text(root)).toBe("outer got fallback of inner");
  });
});

describe("with no boundary", () => {
  test("what an effect or a row throws is thrown on to the write, as without the module", () => {
    const [n, setN] = signal(0);
    effect(() => {
      if (n() === 1) throw new Error("effect");
    });
    expect(() => setN(1)).toThrow("effect");
    const root = new FakeElement("DIV");
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      const [n, setN] = signal(0);
      const check = (v) => { if (v === 1) throw new Error("row"); return v; };
      render(() => <ul><For each={[1]} key={(r) => r}>{(r) => <li>{check(n())}</li>}</For></ul>, root);
      return { setN, log: [] };
    `,
      root,
    );
    expect(() => api.setN!(1 as never)).toThrow("row");
  });

  test("configureClientErrors: onError gets them, and they go no further; without it they are thrown again", () => {
    const got: unknown[] = [];
    configureClientErrors({ onError: (e) => got.push((e as Error).message) });
    const [n, setN] = signal(0);
    effect(() => {
      if (n() > 0) throw new Error("n " + n());
    });
    setN(1);
    expect(got).toEqual(["n 1"]);
    configureClientErrors({});
    expect(() => setN(2)).toThrow("n 2");
  });
});

describe("effect(fn, { error })", () => {
  test("error gets what a run throws, untracked; the effect still follows what it read before", () => {
    const [n, setN] = signal(0);
    const [other, setOther] = signal(0);
    const got: string[] = [];
    effect(
      () => {
        if (n() % 2) throw new Error("odd " + n());
        got.push("even " + n());
      },
      {
        error: (e) => {
          other();
          got.push((e as Error).message);
        },
      },
    );
    setN(1);
    setOther(1);
    setN(2);
    expect(got).toEqual(["even 0", "odd 1", "even 2"]);
  });

  test("without error it is the core's effect; what error throws goes on to the boundary, or the write", () => {
    const [n, setN] = signal(0);
    const seen: number[] = [];
    effect(() => void seen.push(n()));
    effect(() => void seen.push(n() * 10), {});
    effect(
      () => {
        if (n() === 2) throw new Error("again");
      },
      {
        error: (e) => {
          throw e;
        },
      },
    );
    setN(1);
    expect(seen).toEqual([0, 0, 1, 10]);
    expect(() => setN(2)).toThrow("again");
  });
});
