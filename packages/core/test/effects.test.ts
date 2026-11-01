// bind, autorun and onFlush (@reactre/core/features/effects), on the unbundled runtime: when each
// runs (at once, at the flush, in a microtask), what each owns and cleans, and their misuse.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { createContext, useContext } from "../src/features/context.ts";
import * as effects from "../src/features/effects.ts";
import { autorun, bind, onFlush } from "../src/features/effects.ts";
import { createRoot, getOwner } from "../src/features/owner.ts";
import { flush } from "../src/features/timing.ts";
import * as core from "../src/index.ts";
import { batch, effect, onCleanup, signal } from "../src/index.ts";

beforeEach(installFakeDocument);
// What a test left queued for the flush runs before the next test.
afterEach(() => flush());

/** Let the microtasks queued so far, and those they queue, run. */
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "@reactre\/core(?:\/features\/effects)?";$/gm,
    (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
  );
  return new Function("rr", "root", js)({ ...core, ...effects }, root) as T;
}

/** A root inside a fake document, so the DOM under it is connected as in a page. */
const box = (): FakeElement => {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  return root;
};

describe("bind", () => {
  test("compute and apply run at once, and again on each change; apply gets the last value it was given", () => {
    const [n, setN] = signal(1);
    const log: string[] = [];
    createRoot(() =>
      bind(
        (prev: number | undefined) => (log.push(`compute ${prev}`), n() * 10),
        (v, prev) => void log.push(`apply ${v} ${prev}`),
      ),
    );
    expect(log).toEqual(["compute undefined", "apply 10 undefined"]);
    setN(2);
    expect(log.slice(2)).toEqual(["compute 10", "apply 20 10"]);
  });

  test("apply runs after each run of compute, a value equal to the last one too", () => {
    const [n, setN] = signal(1);
    const seen: number[] = [];
    createRoot(() =>
      bind(
        () => n() % 2,
        (v) => void seen.push(v),
      ),
    );
    setN(3);
    expect(seen).toEqual([1, 1]);
  });

  test("apply is untracked; compute owns what it makes, disposed before it runs again", () => {
    const [n, setN] = signal(0);
    const [other, setOther] = signal(0);
    let applies = 0,
      cleaned = 0;
    createRoot(() =>
      bind(
        () => {
          onCleanup(() => cleaned++);
          return n();
        },
        () => void (other(), applies++),
      ),
    );
    setOther(1);
    expect(applies).toBe(1);
    setN(1);
    expect([applies, cleaned]).toEqual([2, 1]);
  });

  test("a returned cleanup runs after compute's next run, before the next apply, and with the owner", () => {
    const [n, setN] = signal(0);
    const log: string[] = [];
    const dispose = createRoot((d) => {
      bind(
        () => (log.push(`compute ${n()}`), n()),
        (v) => {
          log.push(`apply ${v}`);
          return () => log.push(`cleanup ${v}`);
        },
      );
      return d;
    });
    setN(1);
    expect(log).toEqual(["compute 0", "apply 0", "compute 1", "cleanup 0", "apply 1"]);
    dispose();
    expect(log.slice(5)).toEqual(["cleanup 1"]);
    setN(2);
    expect(log).toHaveLength(6);
  });

  test("defer skips the first apply; compute tracks all the same", () => {
    const [n, setN] = signal(1);
    const log: string[] = [];
    createRoot(() =>
      bind(
        () => n(),
        (v, prev) => void log.push(`${v} ${prev}`),
        { defer: true },
      ),
    );
    expect(log).toEqual([]);
    setN(2);
    expect(log).toEqual(["2 undefined"]);
  });

  test("schedule: the first apply waits for the flush, under the owner bind was made in", async () => {
    const seen: unknown[] = [];
    let owner: unknown;
    createRoot(() => {
      owner = getOwner();
      bind(
        () => 1,
        (v) => void seen.push(v, getOwner() === owner),
        { schedule: true },
      );
    });
    expect(seen).toEqual([]);
    flush();
    expect(seen).toEqual([1, true]);
    // Outside a flush, at the next microtask.
    createRoot(() =>
      bind(
        () => 2,
        (v) => void seen.push(v),
        { schedule: true },
      ),
    );
    expect(seen).toHaveLength(2);
    await microtasks();
    expect(seen).toEqual([1, true, 2]);
  });

  test("schedule: a run of compute before the flush applies once; an owner gone first applies nothing", () => {
    const [n, setN] = signal(0);
    const seen: number[] = [];
    createRoot(() =>
      bind(
        () => n(),
        (v) => void seen.push(v),
        { schedule: true },
      ),
    );
    setN(1);
    flush();
    expect(seen).toEqual([1]);
    const dispose = createRoot((d) => {
      bind(
        () => n(),
        (v) => void seen.push(v * 100),
        { schedule: true },
      );
      return d;
    });
    dispose();
    flush();
    expect(seen).toEqual([1]);
  });

  test("schedule: later changes apply at once; with defer too, defer wins", () => {
    const [x, setX] = signal(0);
    const seen: string[] = [];
    createRoot(() => {
      bind(x, (v) => void seen.push(`s${v}`), { schedule: true });
      bind(x, (v) => void seen.push(`d${v}`), { schedule: true, defer: true });
    });
    flush();
    expect(seen).toEqual(["s0"]);
    setX(1);
    expect(seen).toEqual(["s0", "s1", "d1"]);
  });

  test("an apply that returns something other than a function or undefined throws", () => {
    expect(() =>
      createRoot(() =>
        bind(
          () => 1,
          () => "text" as unknown as void,
        ),
      ),
    ).toThrow(new TypeError("reactre: bind's function returned string, not a cleanup function or undefined"));
    expect(() =>
      createRoot(() =>
        bind(
          () => 1,
          () => null as unknown as void,
        ),
      ),
    ).toThrow("returned null");
  });
});

describe("autorun", () => {
  test("the first run waits for the flush: flush(), or else a microtask; later runs are at once", async () => {
    const [n, setN] = signal(0);
    const seen: number[] = [];
    createRoot(() => autorun(() => void seen.push(n())));
    expect(seen).toEqual([]);
    flush();
    expect(seen).toEqual([0]);
    setN(1);
    expect(seen).toEqual([0, 1]);
    createRoot(() => autorun(() => void seen.push(n() * 10)));
    await microtasks();
    expect(seen).toEqual([0, 1, 10]);
  });

  test("in a batch, it first runs at the batch's end, after the effects the batch queued", () => {
    const [n, setN] = signal(0);
    const log: string[] = [];
    effect(() => void log.push(`effect ${n()}`));
    batch(() => {
      createRoot(() => autorun(() => void log.push(`autorun ${n()}`)));
      setN(1);
      expect(log).toEqual(["effect 0"]);
    });
    expect(log).toEqual(["effect 0", "effect 1", "autorun 1"]);
  });

  test("a bind made beside it has run by its first run", () => {
    const [x, setX] = signal(0);
    let mark = "";
    createRoot(() => {
      autorun(() => {
        x();
        mark += "b";
      });
      bind(x, () => void (mark += "a"));
    });
    flush();
    setX(1);
    expect(mark).toBe("abab");
  });

  test("a returned cleanup runs before the next run and with the owner; an owner gone first never runs it", () => {
    const [n, setN] = signal(0);
    const log: string[] = [];
    const dispose = createRoot((d) => {
      autorun(() => {
        const v = n();
        log.push(`run ${v}`);
        return () => log.push(`cleanup ${v}`);
      });
      return d;
    });
    flush();
    setN(1);
    dispose();
    setN(2);
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
    let runs = 0;
    createRoot((d) => {
      autorun(() => void runs++);
      d();
    });
    flush();
    expect(runs).toBe(0);
  });

  test("it finds the context of the owner it was made in", () => {
    const Theme = createContext("light");
    let seen = "";
    createRoot(() =>
      Theme({
        value: "dark",
        get children() {
          autorun(() => void (seen = useContext(Theme)));
          return null;
        },
      }),
    );
    flush();
    expect(seen).toBe("dark");
  });

  test("one made by another's first run runs in the same flush", () => {
    const seen: string[] = [];
    createRoot(() =>
      autorun(() => {
        seen.push("outer");
        autorun(() => void seen.push("inner"));
      }),
    );
    flush();
    expect(seen).toEqual(["outer", "inner"]);
  });

  test("a throw comes out of the flush; the runs queued after it wait for the next", () => {
    const seen: string[] = [];
    createRoot(() => {
      autorun(() => {
        throw new Error("tracked boom");
      });
      autorun(() => void seen.push("second"));
    });
    expect(() => flush()).toThrow("tracked boom");
    expect(seen).toEqual([]);
    flush();
    expect(seen).toEqual(["second"]);
  });

  test("a return that is not a function or undefined throws", () => {
    createRoot(() => autorun(() => ({}) as unknown as void));
    expect(() => flush()).toThrow("reactre: autorun's function returned object, not a cleanup function or undefined");
  });

  test("in a component, bind runs while the view is built, autorun once it is in the page", async () => {
    const root = box();
    const t = run<{ log: string[] }>(
      `
      import { bind, autorun } from "@reactre/core/features/effects";
      import { render } from "@reactre/core";
      const log = [];
      function Field() {
        const input = <input />;
        bind(() => 1, () => void log.push("bind " + input.isConnected));
        autorun(() => void log.push("autorun " + input.isConnected));
        return input;
      }
      render(() => <div><Field /></div>, root);
      return { log };
      `,
      root,
    );
    expect(t.log).toEqual(["bind false"]);
    await microtasks();
    expect(t.log).toEqual(["bind false", "autorun true"]);
  });
});

describe("onFlush", () => {
  test("runs in a microtask, after the writes made beside it", async () => {
    const [v, setV] = signal(0);
    const log: number[] = [];
    createRoot(() => bind(v, (x) => void log.push(x)));
    log.length = 0;
    onFlush(() => setV(1));
    setV(2);
    expect(log).toEqual([2]);
    await microtasks();
    expect(log).toEqual([2, 1]);
  });

  test("callbacks run in call order, in one batch; one queued by a callback waits for the next microtask", async () => {
    const [v, setV] = signal(0);
    const log: string[] = [];
    createRoot(() => bind(v, (x) => void log.push(`v ${x}`)));
    log.length = 0;
    onFlush(() => {
      setV(100);
      onFlush(() => log.push("nested"));
    });
    onFlush(() => setV(200));
    await Promise.resolve();
    expect(log).toEqual(["v 200"]);
    await microtasks();
    expect(log).toEqual(["v 200", "nested"]);
  });

  test("in a batch, it runs once the batch has applied, untracked and with no owner", async () => {
    const [v, setV] = signal(0);
    const seen: unknown[] = [];
    batch(() => {
      createRoot(() => onFlush(() => void seen.push(v(), getOwner())));
      setV(1);
    });
    await microtasks();
    expect(seen).toEqual([1, null]);
  });
});
