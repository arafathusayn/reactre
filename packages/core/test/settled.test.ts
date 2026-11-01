// onSettled and flush (@reactre/core/features/timing), on the unbundled runtime: TSX sources here
// are compiled as the plugin compiles them. onSettled's timing is checked in each place it can be
// called from: a render, an attach, a slot re-rendered in a batch, an effect, a batch's drain, and
// another callback.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { createRoot } from "../src/features/owner.ts";
import * as timing from "../src/features/timing.ts";
import { flush, onSettled } from "../src/features/timing.ts";
import * as core from "../src/index.ts";
import { batch, effect, signal } from "../src/index.ts";

/** What a source's imports of @reactre/core and of its timing feature bind to. */
const runtime = { ...core, ...timing };

beforeEach(installFakeDocument);

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "@reactre\/core(?:\/features\/timing)?";$/gm,
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

/** A root inside a fake document, so the DOM under it is connected as in a page. */
const box = (): FakeElement => {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  return root;
};

/** Let the microtasks queued so far run. */
const settle = (): Promise<void> => Promise.resolve();

describe("flush", () => {
  test("flush(fn) is batch(fn) outside a batch; inside one, what is queued has applied when it returns", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const seen: string[] = [];
    effect(() => void seen.push(`${a()}${b()}`));
    expect(
      flush(() => {
        setA(1);
        setB(1);
        return "r";
      }),
    ).toBe("r");
    expect(seen).toEqual(["00", "11"]);
    batch(() => {
      setA(2);
      expect(flush(() => (setB(2), 5))).toBe(5);
      // The outer batch's write too, in one run.
      expect(seen).toEqual(["00", "11", "22"]);
      setA(3);
      expect(seen.at(-1)).toBe("22");
    });
    expect(seen.at(-1)).toBe("32");
  });

  test("flush() applies what the batch has queued so far, and outside a batch does nothing", () => {
    const [a, setA] = signal(0);
    const seen: number[] = [];
    effect(() => void seen.push(a()));
    flush();
    expect(seen).toEqual([0]);
    batch(() => {
      setA(1);
      flush();
      expect(seen).toEqual([0, 1]);
      setA(2);
      setA(3);
      expect(seen).toEqual([0, 1]);
    });
    expect(seen).toEqual([0, 1, 3]);
  });
});

describe("onSettled", () => {
  test("in a view given to render: at the next microtask, once the view is in the page", async () => {
    const root = box();
    const api = run<{ log: string[] }>(
      `
      import { render } from "@reactre/core";
      import { onSettled } from "@reactre/core/features/timing";
      const log = [];
      function Child() {
        onSettled(() => void log.push("child " + root.textContent));
        return <b>c</b>;
      }
      function App() {
        onSettled(() => void log.push("app " + root.firstChild.isConnected));
        return <p>a<Child /></p>;
      }
      render(App, root);
      return { log };
    `,
      root,
    );
    expect(api.log).toEqual([]);
    await settle();
    expect(api.log).toEqual(["app true", "child ac"]);
  });

  test("render in a flush: before flush returns", () => {
    const root = box();
    const api = run<{ log: string[] }>(
      `
      import { render } from "@reactre/core";
      import { flush, onSettled } from "@reactre/core/features/timing";
      const log = [];
      function App() {
        onSettled(() => void log.push(root.textContent));
        return <p>in</p>;
      }
      flush(() => render(App, root));
      return { log };
    `,
      root,
    );
    expect(api.log).toEqual(["in"]);
  });

  test("in a slot's new content, for a write in a batch: at the batch's end; its cleanup goes with the content", () => {
    const root = box();
    const api = run<{ log: string[]; setShow: (b: boolean) => void }>(
      `
      import { render, signal } from "@reactre/core";
      import { onSettled } from "@reactre/core/features/timing";
      const log = [];
      const [show, setShow] = signal(false);
      function A() {
        onSettled(() => {
          log.push("in " + root.textContent);
          return () => log.push("gone");
        });
        return <i>A</i>;
      }
      render(() => <p>{show() ? <A /> : "none"}</p>, root);
      return { log, setShow };
    `,
      root,
    );
    batch(() => api.setShow(true));
    expect(api.log).toEqual(["in A"]);
    batch(() => api.setShow(false));
    expect(api.log).toEqual(["in A", "gone"]);
  });

  test("in attach: at the next microtask, its cleanup run by the disposer; never, if disposed first", async () => {
    const root = box();
    const api = run<{
      log: string[];
      attach: (view: () => unknown, parent: FakeElement) => () => void;
      A: () => unknown;
    }>(
      `
      import { attach } from "@reactre/core";
      import { onSettled } from "@reactre/core/features/timing";
      const log = [];
      function A() {
        onSettled(() => {
          log.push("ran");
          return () => log.push("cleanup");
        });
        return <p />;
      }
      return { log, attach, A };
    `,
      root,
    );
    const dispose = api.attach(api.A, root);
    await settle();
    expect(api.log).toEqual(["ran"]);
    dispose();
    expect(api.log).toEqual(["ran", "cleanup"]);
    api.attach(api.A, root)();
    await settle();
    expect(api.log).toEqual(["ran", "cleanup"]);
  });

  test("in an effect: untracked, and dropped when the effect re-runs before it settles", async () => {
    const [n, setN] = signal(0);
    const [other, setOther] = signal(0);
    const ran: number[] = [];
    let runs = 0;
    const stop = createRoot((stop) => {
      effect(() => {
        runs++;
        const v = n();
        onSettled(() => void ran.push(v + other()));
      });
      return stop;
    });
    setN(1);
    await settle();
    expect(ran).toEqual([1]);
    setOther(5);
    expect(runs).toBe(2);
    stop();
  });

  test("in a batch: after the effects its writes queued, those queued after it included", () => {
    const [a, setA] = signal(0);
    let view = -1,
      seen = -1;
    effect(() => void (view = a()));
    batch(() => {
      onSettled(() => void (seen = view));
      setA(1);
    });
    expect(seen).toBe(1);
  });

  test("flush() in a batch runs the callbacks queued so far; one queued by a callback runs in the same drain", () => {
    const log: number[] = [];
    batch(() => {
      onSettled(() => {
        log.push(1);
        onSettled(() => void log.push(2));
      });
      flush();
      expect(log).toEqual([1, 2]);
      onSettled(() => void log.push(3));
    });
    expect(log).toEqual([1, 2, 3]);
  });

  test("one that throws leaves the rest for the next batch's end; outside any owner its cleanup is dropped", async () => {
    const log: string[] = [];
    expect(() =>
      batch(() => {
        onSettled(() => {
          throw new Error("boom");
        });
        onSettled(() => void log.push("next"));
      }),
    ).toThrow("boom");
    expect(log).toEqual([]);
    batch(() => {});
    expect(log).toEqual(["next"]);
    onSettled(() => () => log.push("never"));
    await settle();
    expect(log).toEqual(["next"]);
  });
});
