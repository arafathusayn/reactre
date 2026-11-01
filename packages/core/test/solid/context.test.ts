// Ports of Solid 2.0's context tests to createContext and useContext
// (@reactre/core/features/context): packages/signals/tests/context.test.ts,
// packages/web/test/context.spec.tsx and the context tests of packages/solid/test/signals.spec.ts,
// from solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's signals layer provides a context imperatively, `setContext(ctx, v)` on the current
// owner, and reads it with `getContext(ctx)`. reactre has the component form alone, as Solid's
// solid-js layer does: a context is a provider component, and a function child is what it makes
// under its value. The ports provide with the component, and read with `useContext`.

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as contextApi from "../../src/features/context.ts";
import { ContextNotFoundError, createContext, useContext } from "../../src/features/context.ts";
import * as errors from "../../src/features/errors.ts";
import { createRoot } from "../../src/features/owner.ts";
import { base, compile, gap } from "./harness.ts";

const modules = {
  ...base,
  "@reactre/core/features/context": contextApi,
  "@reactre/core/features/errors": errors,
};

beforeEach(installFakeDocument);

const text = (n: FakeElement): string => n.textContent ?? "";
const kids = (n: FakeElement): FakeElement[] => n.childNodes as FakeElement[];

/** Solid's NoOwnerError, which reactre does not have: undefined here. */
const { NoOwnerError } = contextApi as unknown as { NoOwnerError?: new () => Error };

// The development build's messages, which the ports of Solid's (#4181) read: Solid's texts are its
// own, and reactre's say the same in its `reactre CODE: what. Fix: fix.` form. `which` is the
// context as a message names it: `a context`, or `the context "Opt"` for one named Opt.
const NULL_DEFAULT = "createContext<T | null>(null)";
const noDefault = (which: string): string =>
  `reactre CONTEXT_NOT_FOUND: useContext found no provider of ${which}, which has no default. Fix: render a provider above this read, or create the context with a default; for an optional context, use null as its empty default (${NULL_DEFAULT}), not undefined.`;
const undefinedDefault = (which: string): string =>
  `reactre CONTEXT_NOT_FOUND: useContext found no provider of ${which}, and createContext(undefined) gives it no default (undefined is "no value", for a context). Fix: render a provider above this read, or use null as its empty default (${NULL_DEFAULT}).`;
const providedUndefined = (which: string): string =>
  `reactre CONTEXT_PROVIDED_UNDEFINED: useContext read ${which}, and the provider above gave it undefined, which counts as not provided ("no value", for a context). Fix: for an empty value, create the context with a null default (${NULL_DEFAULT}) and provide null.`;
/** What a ContextNotFoundError made without a context says: the production build's message. */
const GENERIC = "reactre: useContext found no provider of a context that has no default";

/** What reading `read` in a root throws, which must be a ContextNotFoundError. */
function messageOf(read: () => unknown): string {
  try {
    createRoot(read);
  } catch (err) {
    expect(err).toBeInstanceOf(ContextNotFoundError);
    return (err as Error).message;
  }
  throw new Error("expected the read to throw");
}

describe("signals/tests/context.test.ts", () => {
  test("should create context", () => {
    const context = createContext(1);
    expect(context.id).toBeDefined();
    expect(context.defaultValue).toEqual(1);
    createRoot(() => {
      // setContext(context): a provider of no value, which is none.
      context({
        value: undefined as unknown as number,
        children: () => void expect(useContext(context)).toEqual(1),
      });
    });
  });

  test("should forward context across roots", () => {
    const context = createContext(1);
    let reads = 0;
    createRoot(() => {
      context({
        value: 2,
        children: () =>
          void createRoot(() => {
            expect(useContext(context)).toEqual(2);
            reads++;
            createRoot(() => {
              expect(useContext(context)).toEqual(2);
              reads++;
            });
          }),
      });
    });
    expect(reads).toBe(2);
  });

  test("should not expose context on parent when set in child", () => {
    const context = createContext(1);
    createRoot(() => {
      createRoot(() => {
        context({ value: 4, children: () => undefined });
      });
      expect(useContext(context)).toEqual(1);
    });
  });

  gap(
    "no-owner",
    "no NoOwnerError: outside an owner, useContext reads the default or throws ContextNotFoundError",
    "should throw error when trying to get context outside owner",
    () => {
      const context = createContext();
      expect(NoOwnerError).toBeDefined();
      expect(() => useContext(context)).toThrowError(NoOwnerError!);
    },
  );

  gap(
    "no-owner",
    "no NoOwnerError: a provider outside an owner makes a root of its own",
    "should throw error when trying to set context outside owner",
    () => {
      const context = createContext();
      expect(NoOwnerError).toBeDefined();
      expect(() => context({ value: undefined, children: () => undefined })).toThrowError(NoOwnerError!);
    },
  );

  test("should throw error when trying to get context without setting it first", () => {
    const context = createContext();
    expect(() => createRoot(() => useContext(context))).toThrowError(ContextNotFoundError);
  });

  describe("ContextNotFoundError dev messages (#4181)", () => {
    test("default-less, no provider: says so and suggests a null default", () => {
      const context = createContext<number>();
      expect(messageOf(() => useContext(context))).toBe(noDefault("a context"));
    });

    test("explicit undefined default: says undefined is not a default", () => {
      // Solid's signals layer takes the name as a string: so does reactre.
      const Opt = createContext<string | undefined>(undefined, "Opt");
      expect(messageOf(() => useContext(Opt))).toBe(undefinedDefault('the context "Opt"'));
    });

    test("a provider passing undefined: says it counts as not provided", () => {
      const Opt = createContext<string | undefined>(undefined, "Opt");
      expect(
        messageOf(() => {
          let message: unknown;
          Opt({
            value: undefined,
            children: () => {
              try {
                createRoot(() => useContext(Opt));
              } catch (err) {
                message = err;
              }
            },
          });
          throw message;
        }),
      ).toBe(providedUndefined('the context "Opt"'));
    });

    test("null is a value: a null default and a provided null both read back", () => {
      const OptNull = createContext<string | null>(null);
      createRoot(() => expect(useContext(OptNull)).toBeNull());
      const NoDefault = createContext<string | null>();
      let read: unknown = "unread";
      createRoot(() => {
        NoDefault({ value: null, children: () => void (read = useContext(NoDefault)) });
      });
      expect(read).toBeNull();
    });

    test("a ContextNotFoundError constructed without a context keeps the generic message", () => {
      expect(new ContextNotFoundError().message).toBe(GENERIC);
    });
  });
});

describe("solid/test/signals.spec.ts: create and use context", () => {
  test("default-less createContext throws when read outside any Provider", () => {
    const context = createContext<number>();
    expect(() => createRoot(() => useContext(context))).toThrow();
  });

  test("default-less createContext returns T (not T | undefined) — type-level contract", () => {
    type TodosCtx = readonly [number[], { add: (n: number) => void }];
    const TodosContext = createContext<TodosCtx>();
    // Compiles only if useContext is typed as TodosCtx, not TodosCtx | undefined.
    type Ctx = ReturnType<typeof useContext<TodosCtx>>;
    const typeAssertion: Ctx = [[1], { add: () => {} }];
    expect(typeAssertion[0]).toEqual([1]);
    expect(TodosContext.defaultValue).toBeUndefined();
  });

  test("createContext with default value falls back outside any Provider", () => {
    const ThemeContext = createContext<"light" | "dark">("light");
    createRoot(() => {
      expect(useContext(ThemeContext)).toBe("light");
    });
  });

  test("an explicit undefined default is no default; the dev message says so", () => {
    const Opt = createContext<string | undefined>(undefined, { name: "Opt" });
    createRoot(() => {
      expect(() => useContext(Opt)).toThrow(undefinedDefault('the context "Opt"'));
    });
  });

  test("a default-less read with no Provider suggests a null default", () => {
    const Todos = createContext<number>();
    createRoot(() => {
      expect(() => useContext(Todos)).toThrow(
        /no provider of a context, which has no default\..*\(createContext<T \| null>\(null\)\)/,
      );
    });
  });

  test("a null default is a value outside any Provider", () => {
    const OptNull = createContext<string | null>(null);
    createRoot(() => {
      expect(useContext(OptNull)).toBeNull();
    });
  });
});

/** The components of web/test/context.spec.tsx, and the view `app` renders with them. */
const components = `
  import { render, Show } from "@reactre/core";
  import { createContext, useContext } from "@reactre/core/features/context";
  const ThemeContext = createContext("light");
  const Component = () => {
    const theme = useContext(ThemeContext);
    return <div>{theme}</div>;
  };
  const CondComponent = () => {
    const theme = useContext(ThemeContext);
    return (
      <Show when={true}>
        <div>{theme}</div>
      </Show>
    );
  };
`;

/** Render `view`, a TSX expression over `components`, into a new root. */
function app(view: string): FakeElement {
  const root = new FakeElement("DIV");
  compile(`${components}\nrender(() => ${view}, root);\nreturn {};`, modules, { root });
  return root;
}

describe("web/test/context.spec.tsx: Testing Context", () => {
  test("should create context properly", () => {
    const { ThemeContext } = compile<{ ThemeContext: contextApi.Context<string> }>(
      `${components}\nreturn { ThemeContext };`,
      modules,
    );
    expect(ThemeContext.id).toBeDefined();
    expect(ThemeContext.defaultValue).toBe("light");
  });

  test("should work with single provider child", () => {
    const div = app(`(
      <ThemeContext value="dark">
        <Component />
      </ThemeContext>
    )`);
    expect(text(kids(div)[0]!)).toBe("dark");
  });

  test("should work with single conditional provider child", () => {
    const div = app(`(
      <ThemeContext value="dark">
        <CondComponent />
      </ThemeContext>
    )`);
    expect(text(kids(div)[0]!)).toBe("dark");
  });

  test("should work with multi provider child", () => {
    const div = app(`(
      <ThemeContext value="dark">
        <div>Hi</div>
        <Component />
      </ThemeContext>
    )`);
    expect(text(kids(div)[1]!)).toBe("dark");
  });

  test("should work with multi conditional provider child", () => {
    const div = app(`(
      <ThemeContext value="dark">
        <div>Hi</div>
        <CondComponent />
      </ThemeContext>
    )`);
    expect(text(kids(div)[1]!)).toBe("dark");
  });

  test("should work with dynamic multi provider child", () => {
    const div = app(`(() => {
      const child = () => <Component />;
      return (
        <ThemeContext value="dark">
          <div>Hi</div>
          {child()}
        </ThemeContext>
      );
    })()`);
    expect(text(kids(div)[1]!)).toBe("dark");
  });

  test("should work with dynamic multi conditional provider child", () => {
    const div = app(`(() => {
      const child = () => <CondComponent />;
      return (
        <ThemeContext value="dark">
          <div>Hi</div>
          {child()}
        </ThemeContext>
      );
    })()`);
    expect(text(kids(div)[1]!)).toBe("dark");
  });
});

describe("web/test/context.spec.tsx: Context provided as undefined (#4181)", () => {
  const optional = `
    import { render } from "@reactre/core";
    import { createContext, useContext } from "@reactre/core/features/context";
    import { Errored } from "@reactre/core/features/errors";
    const Opt = createContext(undefined, { name: "Opt" });
    const Reader = () => <span>{String(useContext(Opt))}</span>;
  `;

  test("a Provider passing undefined counts as not provided", () => {
    const div = new FakeElement("DIV");
    compile(
      `${optional}
      render(
        () => (
          <Errored fallback={(err) => <p>{err.message}</p>}>
            <Opt value={undefined}>
              <Reader />
            </Opt>
          </Errored>
        ),
        root,
      );
      return {};`,
      modules,
      { root: div },
    );
    expect(text(div)).toBe(providedUndefined('the context "Opt"'));
  });

  test("a Provider passing null provides null", () => {
    const div = new FakeElement("DIV");
    compile(
      `${optional}
      render(
        () => (
          <Opt value={null}>
            <Reader />
          </Opt>
        ),
        root,
      );
      return {};`,
      modules,
      { root: div },
    );
    expect(text(div)).toBe("null");
  });
});
