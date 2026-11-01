// @reactre/core/features/async, on the unbundled runtime (the core's sources, async code in):
// async memos, <Loading>, transitions, isPending, latest, resolve, refresh, <Reveal> and lazy.
// TSX sources are compiled as the plugin compiles them.
//
// Importing the module turns the async runtime on in the one runtime instance every test file
// shares, and the runtime then batches every write and runs memos first. So this file turns it
// on before its tests and off after them (`__installAsync(false)`), and the other files run on
// the runtime as an app without the module runs on it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as asyncApi from "../src/features/async.ts";
import { __hooks, isPending, latest, memo, NotReadyError, refresh, resolve } from "../src/features/async.ts";
import * as context from "../src/features/context.ts";
import * as errors from "../src/features/errors.ts";
import { createRoot } from "../src/features/owner.ts";
import { reaction } from "../src/features/reaction.ts";
import * as core from "../src/index.ts";
import { batch, effect, signal } from "../src/index.ts";

const runtime = { ...core, ...context, ...errors, ...asyncApi };

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => core.__installAsync(false));
beforeEach(installFakeDocument);

/** Compile a TSX module body ending in `return { ... }` and run it, `root` and `api` in scope. */
function run<T>(src: string, root: FakeElement, api: Record<string, unknown> = {}): T {
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
  return new Function("rr", "root", "api", js)(runtime, root, api) as T;
}

const text = (n: FakeElement): string => n.textContent ?? "";

/** A Promise with its resolve and reject. */
function deferred<T>(): { p: Promise<T>; ok: (v: T) => void; no: (e: unknown) => void } {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
}

/** Let promise callbacks run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("async memos", () => {
  test("a read before the value comes is not ready; an effect waits for it and runs with it", async () => {
    const d = deferred<number>();
    const m = memo(() => d.p);
    expect(() => m()).toThrow(NotReadyError);
    expect(() => m()).toThrow("read it in an effect or in JSX, under a <Loading>");
    const log: unknown[] = [];
    effect(() => {
      log.push("before");
      log.push(m());
    });
    expect(log).toEqual(["before"]);
    d.ok(1);
    await tick();
    expect(log).toEqual(["before", "before", 1]);
    expect(m()).toBe(1);
  });

  test("a sync memo of an async one is not ready with it, then follows it", async () => {
    const d = deferred<number>();
    const a = memo(() => d.p);
    const b = memo(() => a() * 2);
    expect(() => b()).toThrow(NotReadyError);
    d.ok(2);
    await tick();
    expect(b()).toBe(4);
  });

  test("a later run supersedes an earlier one: only the last run's value is taken", async () => {
    const [id, setId] = signal(1);
    const ds = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const m = memo(() => ds[id() - 1]!.p);
    ds[0]!.ok("one");
    await tick();
    expect(m()).toBe("one");
    setId(2);
    setId(3);
    ds[1]!.ok("two");
    await tick();
    expect(m()).toBe("one");
    ds[2]!.ok("three");
    await tick();
    expect(m()).toBe("three");
    // A rejection of a superseded run is dropped too.
    setId(4);
    setId(5);
    ds[3]!.no(new Error("late"));
    await tick();
    expect(m()).toBe("three");
    ds[4]!.ok("five");
    await tick();
    expect(m()).toBe("five");
  });

  test("a rejection is thrown to its readers, until a run gives a value", async () => {
    const [n, setN] = signal(0);
    const m = memo(() => (n() === 0 ? Promise.reject(new Error("no")) : n()));
    await tick();
    expect(() => m()).toThrow("no");
    setN(5);
    expect(m()).toBe(5);
  });

  test("an AsyncIterable gives each of its values; a new run stops the old iterator", async () => {
    const [src, setSrc] = signal("a");
    const gates: (() => void)[] = [];
    let stopped = 0;
    async function* gen(s: string): AsyncGenerator<string> {
      try {
        for (let i = 1; i <= 3; i++) {
          await new Promise<void>((r) => gates.push(r));
          yield s + i;
        }
      } finally {
        stopped++;
      }
    }
    const m = memo(() => gen(src()));
    const seen: string[] = [];
    effect(() => void seen.push(m()));
    gates.shift()!();
    await tick();
    gates.shift()!();
    await tick();
    expect(seen).toEqual(["a1", "a2"]);
    setSrc("b");
    gates.shift()!();
    await tick();
    gates.shift()!();
    await tick();
    expect(seen).toEqual(["a1", "a2", "b1"]);
    // b runs to its end.
    gates.shift()!();
    await tick();
    gates.shift()!();
    await tick();
    expect(seen).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(stopped).toBe(2);
  });

  test("an iterator that throws fails its readers", async () => {
    async function* bad(): AsyncGenerator<number> {
      yield 1;
      throw new Error("broke");
    }
    const m = memo(() => bad());
    await tick();
    await tick();
    expect(() => m()).toThrow("broke");
  });

  test("a sync result while pending ends the wait for it", async () => {
    const [n, setN] = signal(0);
    const d = deferred<number>();
    const m = memo(() => (n() === 1 ? d.p : n()));
    const seen: number[] = [];
    effect(() => void seen.push(m()));
    setN(1);
    expect(isPending(() => m())).toBe(true);
    setN(2);
    expect(isPending(() => m())).toBe(false);
    expect(seen).toEqual([0, 2]);
  });
});

type Api = Record<string, (...a: never[]) => unknown>;

describe("<Loading>", () => {
  test("its fallback until what its children read has come, then its children, built once", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<{ name: string }>(),
      e = deferred<number>();
    const api = run<{ log: string[] }>(
      `
      import { render } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const user = memo(() => api.d.p), count = memo(() => api.e.p);
      const log = [];
      function Name() {
        log.push("Name");
        return <b>{user().name}</b>;
      }
      render(() => <div><Loading fallback={<i>wait</i>}><Name /><p>{count()}</p></Loading></div>, root);
      return { log };
    `,
      root,
      { d, e },
    );
    expect(text(root)).toBe("wait");
    d.ok({ name: "ann" });
    await tick();
    expect(text(root)).toBe("wait");
    e.ok(3);
    await tick();
    expect(text(root)).toBe("ann3");
    expect(api.log).toEqual(["Name"]);
  });

  test("children that are ready show at once, with no fallback built", () => {
    const root = new FakeElement("DIV");
    run(
      `
      import { render } from "@reactre/core";
      import { Loading } from "@reactre/core/features/async";
      const Fallback = () => { throw new Error("built"); };
      render(() => <div><Loading fallback={<Fallback />}><b>now</b></Loading></div>, root);
      return {};
    `,
      root,
    );
    expect(text(root)).toBe("now");
  });

  test("a component body that reads a value not ready waits in the children's slot", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<string>();
    run(
      `
      import { render } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const word = memo(() => api.d.p);
      function Word() {
        const w = word();
        return <b>{w}</b>;
      }
      render(() => <div><Loading fallback="..."><Word /></Loading></div>, root);
      return {};
    `,
      root,
      { d },
    );
    expect(text(root)).toBe("...");
    d.ok("hi");
    await tick();
    expect(text(root)).toBe("hi");
  });

  test("the nearest boundary waits; an inner one shows its own fallback", async () => {
    const root = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(
      `
      import { render } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const x = memo(() => api.a.p), y = memo(() => api.b.p);
      render(
        () => (
          <div>
            <Loading fallback="outer">
              <b>{x()}</b>
              <Loading fallback="inner"><i>{y()}</i></Loading>
            </Loading>
          </div>
        ),
        root,
      );
      return {};
    `,
      root,
      { a, b },
    );
    expect(text(root)).toBe("outer");
    a.ok("X");
    await tick();
    expect(text(root)).toBe("Xinner");
    b.ok("Y");
    await tick();
    expect(text(root)).toBe("XY");
  });

  test("a fallback that follows a signal, and a boundary taken down while it waits", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<string>();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const v = memo(() => api.d.p);
      const [msg, setMsg] = signal("wait");
      const [on, setOn] = signal(true);
      render(
        () => <div>{on() ? <Loading fallback={<i>{msg()}</i>}><b>{v()}</b></Loading> : "gone"}</div>,
        root,
      );
      return { setMsg, setOn };
    `,
      root,
      { d },
    );
    expect(text(root)).toBe("wait");
    api.setMsg!("still" as never);
    expect(text(root)).toBe("still");
    api.setOn!(false as never);
    expect(text(root)).toBe("gone");
    // "gone" and the slot's anchor: nothing of the boundary is left.
    expect((root.firstChild as FakeElement).childNodes.length).toBe(2);
    d.ok("late");
    await tick();
    expect(text(root)).toBe("gone");
    // And one taken down after it has shown its children.
    api.setOn!(true as never);
    expect(text(root)).toBe("late");
    api.setOn!(false as never);
    expect(text(root)).toBe("gone");
    expect((root.firstChild as FakeElement).childNodes.length).toBe(2);
  });

  test("<For> rows that read a value not ready: the boundary waits for them; a row that leaves stops waiting", async () => {
    const root = new FakeElement("DIV");
    const ds: Record<number, ReturnType<typeof deferred<string>>> = { 1: deferred(), 2: deferred(), 3: deferred() };
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const names = { 1: memo(() => api.ds[1].p), 2: memo(() => api.ds[2].p), 3: memo(() => api.ds[3].p) };
      const [rows, setRows] = signal([1, 2]);
      render(
        () => (
          <div>
            <Loading fallback="...">
              <ul><For each={rows()} key={(r) => r}>{(r) => <li>{names[r]().trim()}</li>}</For></ul>
            </Loading>
          </div>
        ),
        root,
      );
      return { setRows };
    `,
      root,
      { ds },
    );
    expect(text(root)).toBe("...");
    ds[1]!.ok(" a ");
    await tick();
    expect(text(root)).toBe("...");
    api.setRows!([1] as never);
    expect(text(root)).toBe("a");
    // A row made later, under a boundary that has shown: the row waits, empty.
    api.setRows!([1, 3] as never);
    expect(text(root)).toBe("a");
    ds[3]!.ok("c");
    await tick();
    expect(text(root)).toBe("ac");
    // A row that leaves while it waits.
    api.setRows!([1, 2] as never);
    api.setRows!([1] as never);
    ds[2]!.ok("b");
    await tick();
    expect(text(root)).toBe("a");
  });

  test("a read not ready outside any boundary waits on its own", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<string>();
    run(
      `
      import { render } from "@reactre/core";
      import { memo } from "@reactre/core/features/async";
      const v = memo(() => api.d.p);
      render(() => <p>[{v()}]</p>, root);
      return {};
    `,
      root,
      { d },
    );
    expect(text(root)).toBe("[]");
    d.ok("x");
    await tick();
    expect(text(root)).toBe("[x]");
  });

  test("a rejection goes to an <Errored> around the reader", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<string>();
    run(
      `
      import { render } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      const v = memo(() => api.d.p);
      render(
        () => <div><Errored fallback={(e) => "error: " + e.message}><Loading fallback="..."><b>{v()}</b></Loading></Errored></div>,
        root,
      );
      return {};
    `,
      root,
      { d },
    );
    expect(text(root)).toBe("...");
    d.no(new Error("down"));
    await tick();
    expect(text(root)).toBe("error: down");
  });
});

describe("transitions", () => {
  test("an update that makes an async read pending keeps the old UI, whole, until it settles", async () => {
    const root = new FakeElement("DIV");
    const ds = [deferred<string>(), deferred<string>()];
    const api = run<Api & { log: string[] }>(
      `
      import { render, signal } from "@reactre/core";
      import { isPending, latest, Loading, memo } from "@reactre/core/features/async";
      const [id, setId] = signal(1);
      const user = memo(() => api.ds[id() - 1].p);
      const log = [];
      render(
        () => (
          <div>
            <Loading fallback="...">
              <h1>{id()}</h1>
              <p>{user()}</p>
              <i>{latest(() => id())}</i>
              <s>{isPending(() => user()) ? "pending" : "idle"}</s>
            </Loading>
          </div>
        ),
        root,
      );
      return { setId, log };
    `,
      root,
      { ds },
    );
    ds[0]!.ok("ann");
    await tick();
    expect(text(root)).toBe("1ann1idle");
    api.setId!(2 as never);
    // The held parts keep the old values; latest and isPending show the update.
    expect(text(root)).toBe("1ann2pending");
    ds[1]!.ok("bob");
    await tick();
    expect(text(root)).toBe("2bob2idle");
  });

  test("a transition waits for every memo it made pending; a memo that comes first is held with it", async () => {
    const [n, setN] = signal(0);
    const a = [deferred<string>(), deferred<string>()],
      b = [deferred<string>(), deferred<string>()];
    const x = memo(() => a[n()]!.p),
      y = memo(() => b[n()]!.p);
    const seen: string[] = [];
    effect(() => void seen.push(x() + y()));
    a[0]!.ok("a");
    b[0]!.ok("b");
    await tick();
    expect(seen).toEqual(["ab"]);
    setN(1);
    a[1]!.ok("A");
    await tick();
    expect(seen).toEqual(["ab"]);
    expect(x()).toBe("A");
    b[1]!.ok("B");
    await tick();
    expect(seen).toEqual(["ab", "AB"]);
  });

  test("a write unrelated to the transition is not held", async () => {
    const [n, setN] = signal(0);
    const [other, setOther] = signal("o");
    const ds = [deferred<string>(), deferred<string>()];
    const m = memo(() => ds[n()]!.p);
    const seen: string[] = [];
    effect(() => void seen.push(m()));
    effect(() => void seen.push(other()));
    ds[0]!.ok("a");
    await tick();
    setN(1);
    setOther("p");
    expect(seen).toEqual(["o", "a", "p"]);
    ds[1]!.ok("b");
    await tick();
    expect(seen).toEqual(["o", "a", "p", "b"]);
  });

  test("an effect held while its row leaves, or while it is disposed, does not run", async () => {
    const root = new FakeElement("DIV");
    const ds = [deferred<string>(), deferred<string>()];
    const api = run<Api>(
      `
      import { For, render, signal } from "@reactre/core";
      import { memo } from "@reactre/core/features/async";
      const [n, setN] = signal(0);
      const [rows, setRows] = signal([1]);
      const [show, setShow] = signal(true);
      const v = memo(() => api.ds[n()].p);
      render(
        () => (
          <div>
            <ul><For each={rows()} key={(r) => r}>{(r) => <li>{n() + v()}</li>}</For></ul>
            {show() ? <b>{n() + v()}</b> : null}
          </div>
        ),
        root,
      );
      return { setN, setRows, setShow };
    `,
      root,
      { ds },
    );
    ds[0]!.ok("a");
    await tick();
    expect(text(root)).toBe("0a0a");
    api.setN!(1 as never);
    expect(text(root)).toBe("0a0a");
    api.setRows!([] as never);
    api.setShow!(false as never);
    ds[1]!.ok("b");
    await tick();
    expect(text(root)).toBe("");
  });

  test("an effect that writes what it reads, in a batch's drain, runs again after its run, and a cycle throws", () => {
    const [n, setN] = signal(0);
    const [go, setGo] = signal(0);
    const seen: number[] = [];
    effect(() => {
      go();
      const v = n();
      seen.push(v);
      if (v < 3) setN(v + 1);
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    setGo(1);
    expect(seen).toEqual([0, 1, 2, 3, 3]);
    const [c, setC] = signal(0);
    const [start, setStart] = signal(false);
    effect(() => {
      if (start()) setC(c() + 1);
    });
    expect(() => setStart(true)).toThrow("never settles");
    expect(c()).toBeGreaterThan(50);
  });

  test("batches and memos run in order: memos first, then effects", () => {
    const [a, setA] = signal(1);
    const log: string[] = [];
    effect(() => void log.push("effect " + a()));
    const m = memo(() => (log.push("memo"), a() * 2));
    effect(() => void log.push("double " + m()));
    log.length = 0;
    batch(() => setA(2));
    expect(log).toEqual(["memo", "effect 2", "double 4"]);
  });
});

describe("isPending, latest, resolve, refresh", () => {
  test("isPending is false while a value has never come, and for an expression with no async read", async () => {
    const d = deferred<number>();
    const m = memo(() => d.p);
    expect(isPending(() => m())).toBe(false);
    expect(isPending(() => 1)).toBe(false);
    expect(() =>
      isPending(() => {
        throw new Error("x");
      }),
    ).toThrow("x");
    d.ok(1);
    await tick();
    expect(isPending(() => m())).toBe(false);
  });

  test("latest marks its reader live even when its read is not ready", () => {
    const d = deferred<number>();
    const m = memo(() => d.p);
    expect(() => latest(() => m())).toThrow(NotReadyError);
  });

  test("a reaction whose compute reads through latest or isPending is not held; one that does not is", async () => {
    const [s, setS] = signal(1);
    const [on, setOn] = signal(false);
    const ds = [deferred<number>(), deferred<number>(), deferred<number>()];
    const a = memo(() => ds[s() - 1]!.p);
    effect(() => void a());
    const log: string[] = [];
    reaction(
      () => latest(s),
      (v) => void log.push(`latest ${v}`),
    );
    reaction(
      () => isPending(() => a()),
      (v) => void log.push(`pending ${v}`),
    );
    reaction(
      () => s(),
      (v) => void log.push(`held ${v}`),
    );
    // Live from the run in which its compute first reads through latest, in a transition too.
    reaction(
      () => (on() ? latest(s) : 0),
      (v) => void log.push(`later ${v}`),
    );
    ds[0]!.ok(1);
    await tick();
    log.length = 0;
    setS(2);
    expect(log).toEqual(["latest 2", "pending true"]);
    ds[1]!.ok(2);
    await tick();
    expect(log.sort()).toEqual(["held 2", "latest 2", "pending false", "pending true"]);
    log.length = 0;
    batch(() => {
      setOn(true);
      setS(3);
    });
    expect(log.sort()).toEqual(["later 3", "latest 3", "pending true"]);
    ds[2]!.ok(3);
    await tick();
    expect(log.sort()).toEqual(["held 3", "later 3", "latest 3", "pending false", "pending true"]);
  });

  test("resolve: the first value read with nothing pending; a failure rejects", async () => {
    const [n, setN] = signal(0);
    const ds = [deferred<string>(), deferred<string>()];
    const m = memo(() => ds[n()]!.p);
    const first = resolve(() => m() + "!");
    ds[0]!.ok("a");
    expect(await first).toBe("a!");
    setN(1);
    const second = resolve(() => m());
    ds[1]!.ok("b");
    expect(await second).toBe("b");
    expect(await resolve(() => 7)).toBe(7);
    await expect(
      resolve(() => {
        throw new Error("bad");
      }),
    ).rejects.toThrow("bad");
  });

  test("refresh runs a memo again, quietly: the old value stays, and isPending stays false", async () => {
    let calls = 0;
    const ds = [deferred<string>(), deferred<string>()];
    const m = memo(() => ds[calls++]!.p);
    const seen: string[] = [];
    effect(() => void seen.push(isPending(() => m()) + ":" + m()));
    ds[0]!.ok("a");
    await tick();
    const done = refresh(m);
    expect(seen).toEqual(["false:a"]);
    ds[1]!.ok("b");
    await done;
    expect(seen).toEqual(["false:a", "false:b"]);
    // A sync memo's refresh has its value at once.
    const [x] = signal(1);
    const s = memo(() => x() + 1);
    await refresh(s);
    expect(() => refresh({})).toThrow("refresh takes a memo");
  });

  test("a refresh that fails rejects", async () => {
    let calls = 0;
    const m = memo(() => (calls++ === 0 ? Promise.resolve(1) : Promise.reject(new Error("gone"))));
    await tick();
    expect(m()).toBe(1);
    await expect(refresh(m)).rejects.toThrow("gone");
  });
});

describe("<Loading on>", () => {
  test("a change of `on` while an update is pending shows the fallback until it settles", async () => {
    const root = new FakeElement("DIV");
    const ds = [deferred<string>(), deferred<string>(), deferred<string>()];
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const [id, setId] = signal(0);
      const [other, setOther] = signal(0);
      const v = memo(() => api.ds[id()].p);
      render(() => <div><Loading on={id() + other()} fallback="..."><b>{v()}</b></Loading></div>, root);
      return { setId, setOther };
    `,
      root,
      { ds },
    );
    expect(text(root)).toBe("...");
    ds[0]!.ok("a");
    await tick();
    expect(text(root)).toBe("a");
    // No update pending: a change of `on` keeps the children.
    api.setOther!(1 as never);
    expect(text(root)).toBe("a");
    api.setId!(1 as never);
    expect(text(root)).toBe("...");
    ds[1]!.ok("b");
    await tick();
    expect(text(root)).toBe("b");
  });
});

describe("<Reveal>", () => {
  const app = (order: string): string => `
    import { render } from "@reactre/core";
    import { Loading, memo, Reveal } from "@reactre/core/features/async";
    const a = memo(() => api.a.p), b = memo(() => api.b.p);
    render(
      () => (
        <div>
          <Reveal${order === "" ? "" : ` order="${order}"`}>
            <Loading fallback="1"><b>{a()}</b></Loading>
            <Loading fallback="2"><b>{b()}</b></Loading>
          </Reveal>
        </div>
      ),
      root,
    );
    return {};
  `;

  test("natural: each as it is ready", async () => {
    const root = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app(""), root, { a, b });
    b.ok("B");
    await tick();
    expect(text(root)).toBe("1B");
    a.ok("A");
    await tick();
    expect(text(root)).toBe("AB");
  });

  test("sequential: each once the ones before it have shown", async () => {
    const root = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app("sequential"), root, { a, b });
    b.ok("B");
    await tick();
    expect(text(root)).toBe("12");
    a.ok("A");
    await tick();
    expect(text(root)).toBe("AB");
  });

  test("together: all when all are ready", async () => {
    const root = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app("together"), root, { a, b });
    a.ok("A");
    await tick();
    expect(text(root)).toBe("12");
    b.ok("B");
    await tick();
    expect(text(root)).toBe("AB");
  });

  test("a boundary taken out leaves its <Reveal>", async () => {
    const root = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    const api = run<Api>(
      `
      import { render, signal } from "@reactre/core";
      import { Loading, memo, Reveal } from "@reactre/core/features/async";
      const a = memo(() => api.a.p), b = memo(() => api.b.p);
      const [first, setFirst] = signal(true);
      render(
        () => (
          <div>
            <Reveal order="sequential">
              {first() ? <Loading fallback="1"><b>{a()}</b></Loading> : null}
              <Loading fallback="2"><b>{b()}</b></Loading>
            </Reveal>
          </div>
        ),
        root,
      );
      return { setFirst };
    `,
      root,
      { a, b },
    );
    b.ok("B");
    await tick();
    expect(text(root)).toBe("12");
    api.setFirst!(false as never);
    expect(text(root)).toBe("B");
    a.ok("A");
  });
});

describe("lazy", () => {
  test("a component loaded the first time it renders, under a <Loading>", async () => {
    const root = new FakeElement("DIV");
    const d = deferred<{ default: (p: { name: string }) => unknown }>();
    let loads = 0;
    run(
      `
      import { render } from "@reactre/core";
      import { lazy, Loading } from "@reactre/core/features/async";
      const Hello = lazy(() => (api.loads(), api.d.p));
      render(() => <div><Loading fallback="..."><Hello name="ann" /><Hello name="bob" /></Loading></div>, root);
      return {};
    `,
      root,
      { d, loads: () => loads++ },
    );
    expect(text(root)).toBe("...");
    d.ok({ default: (p) => "hi " + p.name + ";" });
    await tick();
    expect(text(root)).toBe("hi ann;hi bob;");
    expect(loads).toBe(1);
  });

  test("preload starts loading before a render", async () => {
    let loads = 0;
    const L = asyncApi.lazy(async () => (loads++, { default: () => "x" }));
    expect(await L.preload()).toBeInstanceOf(Function);
    expect(loads).toBe(1);
  });
});

describe("the memo's options and from", () => {
  const settle = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));

  test("loadingValue: the memo's value until its first comes, and never pending; an error is still thrown", async () => {
    let ok!: (v: string) => void;
    const m = memo(() => new Promise<string>((r) => (ok = r)), { loadingValue: "…" });
    expect([m(), isPending(m)]).toEqual(["…", false]);
    ok("done");
    await settle();
    expect(m()).toBe("done");
    const bad = memo((): Promise<string> => Promise.reject(new Error("bad")), { loadingValue: "…" });
    await settle();
    expect(() => bad()).toThrow("bad");
    // refresh reaches the memo through what reads it.
    let n = 0;
    const r = memo(() => Promise.resolve(++n), { loadingValue: 0 });
    await settle();
    expect(r()).toBe(1);
    await refresh(r);
    expect(r()).toBe(2);
    // In the browser, rendering afresh, the server's and hydration's options change nothing.
    expect(memo(() => 1, { id: "x", ssrSource: "client", deferStream: true, transparent: true })()).toBe(1);
  });

  test("from: a subscription's values, its error and its end, read through an iterator; it is stopped once", async () => {
    const log: string[] = [];
    let emit!: { next: (v: number) => void; error: (e: unknown) => void; complete: () => void };
    const it = asyncApi
      .from<number>((next, error, complete) => {
        emit = { next, error, complete };
        return { unsubscribe: () => log.push("unsubscribe") };
      })
      [Symbol.asyncIterator]();
    const first = it.next();
    emit.next(1);
    expect(await first).toEqual({ value: 1, done: false });
    const failed = it.next();
    emit.error(new Error("source"));
    expect(failed).rejects.toThrow("source");
    await settle();
    expect(await it.next()).toEqual({ value: undefined, done: true });
    emit.next(2);
    emit.error(new Error("again"));
    emit.complete();
    expect(await it.return!()).toEqual({ value: undefined, done: true });
    expect(log).toEqual(["unsubscribe"]);
    // An end while a read waits ends it; an error sent while subscribing is the first read's.
    let end!: () => void;
    const ending = asyncApi.from<number>((_n, _e, c) => ((end = c), undefined))[Symbol.asyncIterator]();
    const waiting = ending.next();
    end();
    expect(await waiting).toEqual({ value: undefined, done: true });
    const early = asyncApi
      .from<number>((_n, e) => {
        e(new Error("early"));
        return () => log.push("released");
      })
      [Symbol.asyncIterator]();
    expect(early.next()).rejects.toThrow("early");
    expect(log).toEqual(["unsubscribe", "released"]);
    // A teardown that throws does not stop what stops it.
    const throwing = asyncApi
      .from<number>(() => () => {
        throw new Error("teardown");
      })
      [Symbol.asyncIterator]();
    expect(await throwing.return!()).toEqual({ value: undefined, done: true });
  });

  test("from: an Observable through @@observable; an AsyncIterable, stopped with its memo; anything else is refused", async () => {
    const obs = {
      subscribe(o: { next(v: string): void }) {
        o.next("observed");
        return { unsubscribe() {} };
      },
    };
    const interop = { "@@observable": () => obs };
    let read!: () => string;
    createRoot(() => (read = memo(() => asyncApi.from<string>(interop as never))));
    expect(read()).toBe("observed");
    const log: string[] = [];
    let n = 0;
    const iterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => (n++ === 0 ? Promise.resolve({ value: "a", done: false }) : new Promise(() => {})),
        return: () => (log.push("return"), Promise.resolve({ value: undefined, done: true })),
      }),
    };
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      read = memo(() => asyncApi.from(iterable));
    });
    await settle();
    expect(read()).toBe("a");
    dispose();
    expect(log).toEqual(["return"]);
    for (const bad of [null, 1, {}, { subscribe: 1 }])
      expect(() => asyncApi.from(bad as never)).toThrow(
        "reactre: from takes a subscribe function, an Observable or an AsyncIterable",
      );
  });
});

describe("turning it off", () => {
  test("off, a memo is the core's: a Promise is its value", () => {
    core.__installAsync(false);
    try {
      const p = Promise.resolve(1);
      expect(core.memo(() => p)()).toBe(p);
    } finally {
      core.__installAsync(__hooks);
    }
  });
});
