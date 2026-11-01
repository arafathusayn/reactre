// createContext and useContext (@reactre/core/features/context), on the unbundled runtime: TSX
// sources here are compiled as the plugin compiles them. A provider reads its children inside
// itself, so the sources give them to it unbuilt, as a getter (`get children()`, the form lazy
// children compile to) or as a function child.
//
// Importing the module installs it in the one runtime instance every test file shares, as
// features/selectors is installed: from then on owners take the scope they were made in, which
// changes nothing for code that does not use it.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as context from "../src/features/context.ts";
import { ContextNotFoundError, createContext, useContext } from "../src/features/context.ts";
import * as owner from "../src/features/owner.ts";
import * as core from "../src/index.ts";
import { effect, signal } from "../src/index.ts";

/** What a source's imports of @reactre/core and of its feature modules bind to. */
const runtime = { ...core, ...context, ...owner };

beforeEach(installFakeDocument);

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

describe("createContext", () => {
  test("a context is a component, with its key and its default", () => {
    const Theme = createContext("light");
    expect(typeof Theme).toBe("function");
    expect(typeof Theme.id).toBe("symbol");
    expect(Theme.defaultValue).toBe("light");
    expect(createContext<number>().defaultValue).toBeUndefined();
    expect(createContext(1).id).not.toBe(createContext(1).id);
  });

  test("its children are read inside it: a getter is read once, with the provider's value in force", () => {
    const root = new FakeElement("DIV");
    const api = run<{ reads: () => number }>(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Label = () => <b>{useContext(Theme)}</b>;
      let reads = 0;
      render(
        () => (
          <div>
            <Label />
            {Theme({ value: "dark", get children() { reads++; return <p><Label /></p>; } })}
            <Label />
          </div>
        ),
        root,
      );
      return { reads: () => reads };
    `,
      root,
    );
    expect(text(root)).toBe("lightdarklight");
    expect(api.reads()).toBe(1);
  });

  test("the nearest provider wins; a provider of undefined is none", () => {
    const root = new FakeElement("DIV");
    run(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Size = createContext(1);
      const Label = () => <b>{useContext(Theme)}{useContext(Size)}</b>;
      render(
        () =>
          Theme({
            value: "dark",
            get children() {
              return [
                <Label />,
                Size({ value: 2, get children() { return Theme({ value: "blue", get children() { return <Label />; } }); } }),
                Theme({ value: undefined, get children() { return <Label />; } }),
              ];
            },
          }),
        root,
      );
      return {};
    `,
      root,
    );
    expect(text(root)).toBe("dark1blue2light1");
  });

  test("what a slot, a row or an effect makes later finds the provider above it", () => {
    const root = new FakeElement("DIV");
    const api = run<{
      setOn: (v: boolean) => void;
      setRows: (r: number[]) => void;
      setN: (n: number) => void;
      seen: string[];
    }>(
      `
      import { effect, For, render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const Label = () => <b>{useContext(Theme)}</b>;
      const [on, setOn] = signal(false);
      const [rows, setRows] = signal([]);
      const [n, setN] = signal(0);
      const seen = [];
      function Body() {
        effect(() => seen.push(n() + useContext(Theme)));
        return (
          <section>
            {on() ? <Label /> : "-"}
            <ul><For each={rows()} key={(r) => r}>{(r) => <li><Label /></li>}</For></ul>
          </section>
        );
      }
      render(() => <main>{Theme({ value: "dark", get children() { return <Body />; } })}</main>, root);
      return { setOn, setRows, setN, seen };
    `,
      root,
    );
    expect(text(root)).toBe("-");
    api.setOn(true);
    api.setRows([1, 2]);
    expect(text(root)).toBe("darkdarkdark");
    api.setN(1);
    expect(api.seen).toEqual(["0dark", "1dark"]);
  });

  test("a function child renders as a slot under the provider, and follows what it reads", () => {
    const root = new FakeElement("DIV");
    const api = run<{ setN: (n: number) => void }>(
      `
      import { render, signal } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const [n, setN] = signal(0);
      render(() => <div><Theme value="dark">{() => useContext(Theme) + n()}</Theme></div>, root);
      return { setN };
    `,
      root,
    );
    expect(text(root)).toBe("dark0");
    api.setN(1);
    expect(text(root)).toBe("dark1");
  });

  test("createRoot under a provider, and runWithOwner with an owner kept from under it, find it", () => {
    const root = new FakeElement("DIV");
    const api = run<{ later: () => string; inRoot: string; dispose: () => void }>(
      `
      import { render } from "@reactre/core";
      import { createContext, useContext } from "@reactre/core/features/context";
      import { createRoot, getOwner, runWithOwner } from "@reactre/core/features/owner";
      const Theme = createContext("light");
      let o, inRoot, dispose;
      function Keep() {
        o = getOwner();
        [inRoot, dispose] = createRoot((d) => [useContext(Theme), d]);
        return null;
      }
      render(() => Theme({ value: "dark", get children() { return <Keep />; } }), root);
      return { later: () => runWithOwner(o, () => useContext(Theme)), inRoot, dispose };
    `,
      root,
    );
    expect(api.inRoot).toBe("dark");
    expect(api.later()).toBe("dark");
    api.dispose();
  });

  test("a provider goes with the owner it was made in: a slot that replaces it disposes what it made", () => {
    const root = new FakeElement("DIV");
    const api = run<{ setOn: (v: boolean) => void; cleaned: () => number }>(
      `
      import { onCleanup, render, signal } from "@reactre/core";
      import { createContext } from "@reactre/core/features/context";
      const Theme = createContext("light");
      const [on, setOn] = signal(true);
      let cleaned = 0;
      const Inner = () => (onCleanup(() => cleaned++), <b>in</b>);
      render(() => <div>{on() ? Theme({ value: "dark", get children() { return <Inner />; } }) : "out"}</div>, root);
      return { setOn, cleaned: () => cleaned };
    `,
      root,
    );
    expect(text(root)).toBe("in");
    api.setOn(false);
    expect(text(root)).toBe("out");
    expect(api.cleaned()).toBe(1);
  });
});

test("the core alone installs nothing: in a copy of the runtime this module never loaded into, owners take no scope", async () => {
  // A copy of its own: the test run shares one runtime across files, and this file installed
  // the module in it.
  const copy: string = "../src/index.ts?context-off";
  const off = (await import(copy)) as typeof import("../src/index.ts");
  const seen: unknown[] = [];
  off.effect(() => void seen.push(off.__owner));
  core.effect(() => void seen.push(core.__owner));
  expect(seen[0]).not.toHaveProperty("c");
  expect(seen[1]).toHaveProperty("c");
});

describe("useContext", () => {
  test("with no provider above: the default, or ContextNotFoundError for a context without one", () => {
    const Theme = createContext("light");
    const Required = createContext<string>();
    expect(useContext(Theme)).toBe("light");
    expect(() => useContext(Required)).toThrow(ContextNotFoundError);
    let err: unknown;
    // Under an owner, but no provider.
    effect(() => {
      try {
        useContext(Required);
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(ContextNotFoundError);
    expect((err as Error).name).toBe("ContextNotFoundError");
    expect((err as Error).message).toContain("no provider");
  });

  test("a context without a default, provided, is found", () => {
    const Required = createContext<{ n: () => number }>();
    const [n, setN] = signal(1);
    const seen: number[] = [];
    Required({
      value: { n },
      get children() {
        effect(() => void seen.push(useContext(Required).n()));
        return null;
      },
    });
    setN(2);
    expect(seen).toEqual([1, 2]);
  });
});
