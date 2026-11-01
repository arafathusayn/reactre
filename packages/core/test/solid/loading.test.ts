// Ports of Solid 2.0's tests of async data: async memos read under <Loading>, <Reveal>,
// isPending, latest, resolve, refresh and lazy, on reactre's features/async (and <Errored> from
// features/errors where a test puts one around a boundary). JSX sources are compiled as the
// plugin compiles them and run on the fake DOM. Solid's signal-level boundary
// (createLoadingBoundary) is reactre's <Loading>, so its tests are ported in JSX.
//
// Ported from packages/web/test/loading.spec.tsx, packages/web/test/latest-async.spec.tsx,
// packages/signals/tests/createLoadingBoundary.test.ts, packages/signals/tests/latest-async.test.ts,
// packages/signals/tests/resolve.test.ts, packages/signals/tests/refresh-await.test.ts,
// packages/signals/tests/loading-value.test.ts, packages/signals/tests/createRevealOrder.test.ts
// and packages/solid/test/reveal.spec.ts, of solid-js 2.0.0-rc.20 (solidjs/solid@5e68925).
//
// Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in
// ./harness.ts.
//
// The async runtime is turned on before these tests and off after them, as in ../async.test.ts.
// Solid's tests run on vitest's fake timers; these wait on real ones, of a few milliseconds.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, type FakeNode, FakeText, installFakeDocument, withStyles } from "@reactre/testdom";

import * as asyncApi from "../../src/features/async.ts";
import { __hooks, isPending, latest, memo, NotReadyError, refresh, resolve } from "../../src/features/async.ts";
import * as context from "../../src/features/context.ts";
import * as errors from "../../src/features/errors.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { effect, onCleanup, signal } from "../../src/index.ts";
import { base, compile, deferred, gap, tick } from "./harness.ts";

let unstyle: () => void;
beforeAll(() => {
  core.__installAsync(__hooks);
  unstyle = withStyles();
  // classList's toggle over the class attribute, as ../flow.test.ts gives the fake DOM one.
  Object.defineProperty(FakeElement.prototype, "classList", {
    configurable: true,
    get(this: FakeElement) {
      const el = this;
      const list = (): string[] => (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
      return {
        toggle(c: string, force?: boolean): boolean {
          const cs = list().filter((x) => x !== c);
          const on = force ?? !list().includes(c);
          if (on) cs.push(c);
          el.setAttribute("class", cs.join(" "));
          return on;
        },
      };
    },
  });
});
afterAll(() => {
  core.__installAsync(false);
  unstyle();
  delete (FakeElement.prototype as unknown as Record<string, unknown>)["classList"];
});
beforeEach(installFakeDocument);
// A test that ends with a flight still out leaves its transition open: the next starts clean.
afterEach(() => {
  core.__installAsync(false);
  core.__installAsync(__hooks);
});

const modules: Record<string, unknown> = {
  ...base,
  "@reactre/core/features/async": asyncApi,
  "@reactre/core/features/context": context,
  "@reactre/core/features/errors": errors,
};

/** Compile and run a TSX module body ending in `return { ... }`, with `root` and `api` in scope. */
const run = <T>(src: string, root: FakeElement, api: Record<string, unknown> = {}): T =>
  compile<T>(src, modules, { root, api });

/** The markup of `n`'s children, as innerHTML writes it (comments left out). */
function html(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${tag}${attrs}>${html(c)}</${tag}>`;
    } else if (c instanceof FakeText) out += c.data;
  }
  return out;
}

/** What Solid's `await Promise.resolve(); await Promise.resolve(); flush()` lets land. */
const settle = async (): Promise<void> => {
  await tick();
  flush();
};

type Api = Record<string, (...a: never[]) => unknown>;

describe("web/test/loading.spec.tsx", () => {
  describe("Testing Basics", () => {
    test("Children are reactive", () => {
      const div = new FakeElement("DIV");
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        let increment;
        const disposer = attach(() => {
          const [count, setCount] = signal(0);
          increment = () => setCount(count() + 1);
          return <Loading>{count()}</Loading>;
        }, root);
        return { increment: () => increment(), disposer };
      `,
        div,
      );
      expect(html(div)).toBe("0");
      api["increment"]!();
      flush();
      expect(html(div)).toBe("1");
      api["disposer"]!();
    });

    gap(
      "root-hold",
      "a hole whose read is not ready, outside any <Loading>, mounts its element empty",
      "isPending lets top-level initial async hold render",
      async () => {
        const div = new FakeElement("DIV");
        const d = deferred<string>();
        const api = run<Api>(
          `
        import { attach } from "@reactre/core";
        import { isPending, memo } from "@reactre/core/features/async";
        const disposer = attach(() => {
          const data = memo(() => api.d.p);
          return <button disabled={isPending(data)}>{data()}</button>;
        }, root);
        return { disposer };
      `,
          div,
          { d },
        );
        expect(html(div)).toBe("");
        d.ok("Ready");
        await settle();
        expect(html(div)).toBe("<button>Ready</button>");
        api["disposer"]!();
      },
    );
  });

  describe("Testing Loading", () => {
    const div = new FakeElement("DIV");
    const resolvers: ((m: unknown) => void)[] = [];
    let disposer: () => void;

    test("Create Loading control flow", () => {
      installFakeDocument();
      disposer = run<{ disposer: () => void }>(
        `
        import { attach, signal } from "@reactre/core";
        import { lazy, Loading, memo } from "@reactre/core/features/async";
        const [triggered] = signal(undefined);
        const LazyComponent = lazy(() => new Promise((r) => api.resolvers.push(r)));
        const ChildComponent = (props) => {
          const value = memo(() => (triggered(), new Promise((r) => setTimeout(() => r("Jo"), 5))));
          return <>{props.greeting} {value()}</>;
        };
        api.child(ChildComponent);
        const Component = () => (
          <Loading fallback="Loading">
            <LazyComponent greeting="Hi," />.
            <LazyComponent greeting="Hello" />
          </Loading>
        );
        return { disposer: attach(Component, root) };
      `,
        div,
        { resolvers, child: (c: unknown) => (child = c) },
      ).disposer;
      expect(html(div)).toBe("Loading");
    });

    let child: unknown;

    test("Toggle Loading control flow", async () => {
      for (const r of resolvers) r({ default: child });
      await settle();
      await tick(10);
      flush();
      expect(html(div)).toBe("Hi, Jo.Hello Jo");
    });

    test("dispose", () => {
      disposer();
      expect(html(div)).toBe("");
    });

    test("disposing the first in-flight lazy instance doesn't strand survivors (#2915)", async () => {
      const div = new FakeElement("DIV");
      let importCalls = 0;
      let resolveModule!: (m: unknown) => void;
      const api = run<Api>(
        `
        import { attach, signal, Show } from "@reactre/core";
        import { lazy, Loading } from "@reactre/core/features/async";
        const LazyComponent = lazy(() => {
          api.count();
          return new Promise((r) => api.take(r));
        });
        const [showFirst, setShowFirst] = signal(true);
        const disposer = attach(
          () => (
            <Loading fallback="loading">
              <Show when={showFirst()}>
                <LazyComponent tag="first" />
              </Show>
              <LazyComponent tag="second" />
            </Loading>
          ),
          root,
        );
        const B = (props) => <b>{props.tag}</b>;
        return { setShowFirst, disposer, B: () => B };
      `,
        div,
        { count: () => importCalls++, take: (r: (m: unknown) => void) => (resolveModule = r) },
      );
      flush();
      expect(html(div)).toBe("loading");
      api["setShowFirst"]!(false as never);
      flush();
      resolveModule({ default: api["B"]!() });
      await settle();
      expect(html(div)).toBe("<b>second</b>");
      expect(importCalls).toBe(1);
      api["setShowFirst"]!(true as never);
      flush();
      expect(html(div)).toBe("<b>first</b><b>second</b>");
      expect(importCalls).toBe(1);
      api["disposer"]!();
    });

    gap(
      "lazy-retry",
      "lazy() keeps a failed import's rejection: reset() re-throws it",
      "failed import is not cached — Errored reset() retries the download (#2999)",
      async () => {
        const div = new FakeElement("DIV");
        let importCalls = 0;
        const state = { fail: true };
        const api = run<{ reset: () => void; disposer: () => void }>(
          `
          import { attach } from "@reactre/core";
          import { lazy, Loading } from "@reactre/core/features/async";
          import { Errored } from "@reactre/core/features/errors";
          const LazyComponent = lazy(() => {
            api.count();
            return api.state.fail
              ? Promise.reject(new Error("download failed"))
              : Promise.resolve({ default: () => <b>loaded</b> });
          });
          let doReset;
          const disposer = attach(
            () => (
              <Errored fallback={(err, reset) => { doReset = reset; return String(err); }}>
                <Loading fallback="loading">
                  <LazyComponent />
                </Loading>
              </Errored>
            ),
            root,
          );
          return { reset: () => doReset(), disposer };
        `,
          div,
          { count: () => importCalls++, state },
        );
        flush();
        expect(html(div)).toBe("loading");
        await settle();
        expect(html(div)).toBe("Error: download failed");
        expect(importCalls).toBe(1);
        state.fail = false;
        api.reset();
        flush();
        await settle();
        expect(html(div)).toBe("<b>loaded</b>");
        expect(importCalls).toBe(2);
        api.disposer();
      },
    );

    gap(
      "lazy-retry",
      "lazy() keeps a failed import's rejection: preload() rejects again",
      "preload() retries after a failed import (#2999)",
      async () => {
        let importCalls = 0;
        let fail = true;
        const LazyComponent = asyncApi.lazy((): Promise<{ default: () => unknown }> => {
          importCalls++;
          return fail ? Promise.reject(new Error("preload failed")) : Promise.resolve({ default: () => "ok" });
        });
        await expect(LazyComponent.preload()).rejects.toThrow("preload failed");
        fail = false;
        await LazyComponent.preload();
        expect(importCalls).toBe(2);
        await LazyComponent.preload();
        expect(importCalls).toBe(2);
      },
    );

    test("bare async memo as direct Loading child (issue #2677)", async () => {
      const div = new FakeElement("DIV");
      const d = deferred<string>();
      const api = run<Api>(
        `
        import { attach } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        const disposer = attach(() => {
          const data = memo(() => api.d.p);
          return <Loading fallback="Loading...">{data()}</Loading>;
        }, root);
        return { disposer };
      `,
        div,
        { d },
      );
      flush();
      expect(html(div)).toBe("Loading...");
      d.ok("Bare Data");
      await settle();
      expect(html(div)).toBe("Bare Data");
      api["disposer"]!();
    });

    /** The app of the two rejected-revalidation tests: a count, and an async memo of it that throws. */
    const rejecting = (withStyle: boolean): string => `
      import { attach, signal } from "@reactre/core";
      import { isPending, Loading, memo } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      let increment;
      const disposer = attach(() => {
        const [count, setCount] = signal(0);
        increment = () => setCount((x) => x + 1);
        const fetchedString = memo(async () => {
          const value = count();
          await new Promise((resolve) => api.requests.push({ resolve }));
          throw "Fetch error for " + value;
        });
        return (
          <div${withStyle ? ` style={{ opacity: isPending(count) ? 0.5 : 1 }}` : ""}>
            <span>{count()}</span>
            <Errored fallback={(e) => String(e)}>
              <Loading fallback="loading">
                <span>{fetchedString()}</span>
              </Loading>
            </Errored>
          </div>
        );
      }, root);
      return { increment: () => increment(), disposer };
    `;

    gap(
      "error-accessor",
      "an <Errored> keeps its first error: the refetch's rejection does not replace it",
      "isPending on an upstream signal clears after async rejection (issue #2700)",
      async () => {
        const div = new FakeElement("DIV");
        const requests: { resolve: () => void }[] = [];
        const api = run<{ increment: () => void; disposer: () => void }>(rejecting(true), div, { requests });
        const style = (): string => (div.firstChild as unknown as { style: { cssText: string } }).style.cssText;
        flush();
        expect(style()).toBe("opacity: 1;");
        expect(div.textContent).toBe("0loading");
        requests[0]!.resolve();
        await settle();
        expect(style()).toBe("opacity: 1;");
        expect(div.textContent).toBe("0Fetch error for 0");
        api.increment();
        flush();
        expect(style()).toBe("opacity: 1;");
        expect(div.textContent).toBe("1Fetch error for 0");
        requests[1]!.resolve();
        await settle();
        expect(style()).toBe("opacity: 1;");
        expect(div.textContent).toBe("1Fetch error for 1");
        api.disposer();
      },
    );

    gap(
      "error-accessor",
      "an <Errored> keeps its first error: a later rejection of the same source does not replace it",
      "Errored shows the latest async error after repeated rejections (issue #2701)",
      async () => {
        const div = new FakeElement("DIV");
        const requests: { resolve: () => void }[] = [];
        const api = run<{ increment: () => void; disposer: () => void }>(rejecting(false), div, { requests });
        flush();
        expect(div.textContent).toBe("0loading");
        requests[0]!.resolve();
        await settle();
        expect(div.textContent).toBe("0Fetch error for 0");
        api.increment();
        flush();
        expect(div.textContent).toBe("1Fetch error for 0");
        requests[1]!.resolve();
        await settle();
        expect(div.textContent).toBe("1Fetch error for 1");
        api.disposer();
      },
    );

    test("on prop treats component value as the boundary key", async () => {
      const div = new FakeElement("DIV");
      const resolvers: Record<string, (v: string) => void> = {};
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        let setId;
        const disposer = attach(() => {
          const [id, _setId] = signal("a");
          setId = _setId;
          const data = memo(async () => {
            const current = id();
            return await new Promise((r) => (api.resolvers[current] = r));
          });
          return Loading({
            fallback: "loading",
            get on() { return id(); },
            get children() { return data(); },
          });
        }, root);
        return { setId: (v) => setId(v), disposer };
      `,
        div,
        { resolvers },
      );
      flush();
      expect(html(div)).toBe("loading");
      resolvers["a"]!("data-a");
      await settle();
      expect(html(div)).toBe("data-a");
      api["setId"]!("b" as never);
      flush();
      expect(html(div)).toBe("loading");
      resolvers["b"]!("data-b");
      await settle();
      expect(html(div)).toBe("data-b");
      api["disposer"]!();
    });

    test("on prop keeps stale content when the keyed value is unchanged", async () => {
      const div = new FakeElement("DIV");
      const resolvers: Record<string, (v: string) => void> = {};
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        let setId, setExtra;
        const disposer = attach(() => {
          const [id, _setId] = signal("a");
          const [extra, _setExtra] = signal(0);
          setId = _setId;
          setExtra = _setExtra;
          const data = memo(async () => {
            const current = id();
            const next = extra();
            return await new Promise((r) => (api.resolvers[current + "-" + next] = r));
          });
          return Loading({
            fallback: "loading",
            get on() { return id(); },
            get children() { return data(); },
          });
        }, root);
        return { setId: (v) => setId(v), setExtra: (v) => setExtra(v), disposer };
      `,
        div,
        { resolvers },
      );
      flush();
      resolvers["a-0"]!("data-a-0");
      await settle();
      expect(html(div)).toBe("data-a-0");
      api["setExtra"]!(1 as never);
      flush();
      expect(html(div)).toBe("data-a-0");
      resolvers["a-1"]!("data-a-1");
      await settle();
      expect(html(div)).toBe("data-a-1");
      api["setId"]!("b" as never);
      flush();
      expect(html(div)).toBe("loading");
      resolvers["b-1"]!("data-b-1");
      await settle();
      expect(html(div)).toBe("data-b-1");
      api["disposer"]!();
    });

    gap(
      "transition-scope",
      "the update's transition holds the keyed <Show>'s rebuild: the old page stays, not the new boundary's fallback",
      "new keyed Loading boundary shows fallback for previously resolved async value while it refreshes",
      async () => {
        const div = new FakeElement("DIV");
        const gate = { current: deferred<void>() };
        const api = run<Api>(
          `
        import { attach, signal, Show } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        let setPage;
        const disposer = attach(() => {
          const [page, _setPage] = signal("a");
          setPage = _setPage;
          const source = memo(async () => {
            const value = page();
            await api.gate.current.p;
            return "value-" + value;
          });
          return (
            <Show when={page()} keyed>
              {(currentPage) => <Loading fallback="loading">{"Page " + currentPage + ": " + source()}</Loading>}
            </Show>
          );
        }, root);
        return { setPage: (v) => setPage(v), disposer };
      `,
          div,
          { gate },
        );
        flush();
        expect(html(div)).toBe("loading");
        gate.current.ok();
        await settle();
        expect(html(div)).toBe("Page a: value-a");
        gate.current = deferred<void>();
        api["setPage"]!("b" as never);
        flush();
        expect(html(div)).toBe("loading");
        gate.current.ok();
        await settle();
        expect(html(div)).toBe("Page b: value-b");
        api["disposer"]!();
      },
    );

    gap(
      "transition-scope",
      "the update's transition holds the keyed <Show>'s rebuild: the old branch stays, not the new boundary's fallback",
      "isPending falls back only for newly mounted attribute branches",
      async () => {
        const div = new FakeElement("DIV");
        const gate = { current: deferred<void>() };
        const api = run<Api>(
          `
          import { attach, signal, Show } from "@reactre/core";
          import { isPending, Loading, memo } from "@reactre/core/features/async";
          let setPage, setVersion;
          const disposer = attach(() => {
            const [page, _setPage] = signal("a");
            const [version, _setVersion] = signal(0);
            setPage = _setPage;
            setVersion = _setVersion;
            const source = memo(async () => {
              const currentPage = page();
              const currentVersion = version();
              await api.gate.current.p;
              return "value-" + currentPage + "-" + currentVersion;
            });
            return (
              <Show when={page()} keyed>
                {(currentPage) => (
                  <Loading fallback={<button disabled>loading</button>}>
                    <button disabled={isPending(source)}>Page {currentPage}: {source()}</button>
                  </Loading>
                )}
              </Show>
            );
          }, root);
          return { setPage: (v) => setPage(v), setVersion: (v) => setVersion(v), disposer };
        `,
          div,
          { gate },
        );
        const button = (): FakeElement => div.childNodes.find((n) => n instanceof FakeElement) as FakeElement;
        const disabled = (): boolean => button().hasAttribute("disabled");
        flush();
        expect(button().textContent).toBe("loading");
        expect(disabled()).toBe(true);
        gate.current.ok();
        await settle();
        expect(button().textContent).toBe("Page a: value-a-0");
        expect(disabled()).toBe(false);
        gate.current = deferred<void>();
        api["setVersion"]!(1 as never);
        flush();
        expect(button().textContent).toBe("Page a: value-a-0");
        expect(disabled()).toBe(true);
        gate.current.ok();
        await settle();
        expect(button().textContent).toBe("Page a: value-a-1");
        expect(disabled()).toBe(false);
        gate.current = deferred<void>();
        api["setPage"]!("b" as never);
        flush();
        expect(button().textContent).toBe("loading");
        expect(disabled()).toBe(true);
        gate.current.ok();
        await settle();
        expect(button().textContent).toBe("Page b: value-b-1");
        expect(disabled()).toBe(false);
        api["disposer"]!();
      },
    );

    test("latest preserves sibling async text in Loading fragments", async () => {
      const div = new FakeElement("DIV");
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { latest, Loading, memo } from "@reactre/core/features/async";
        let setOg, readDirect;
        const disposer = attach(() => {
          const [og, _setOg] = signal(553);
          setOg = _setOg;
          const derived1 = memo(async () => {
            const o = og() + 1;
            await new Promise((res) => setTimeout(res, 10));
            return o;
          });
          const derived2 = memo(async () => {
            const o = derived1() + 1;
            await new Promise((res) => setTimeout(res, 10));
            return o;
          });
          readDirect = derived2;
          return <Loading fallback="Loading...">a. {derived2()} b. {latest(derived2)}</Loading>;
        }, root);
        return { setOg: (f) => setOg(f), readDirect: () => readDirect(), disposer };
      `,
        div,
      );
      flush();
      expect(div.textContent).toBe("Loading...");
      await tick(12);
      flush();
      expect(div.textContent).toBe("Loading...");
      await tick(12);
      flush();
      expect(api["readDirect"]!()).toBe(555);
      expect(div.textContent).toBe("a. 555 b. 555");
      api["setOg"]!(((x: number) => x + 1) as never);
      flush();
      expect(div.textContent).toBe("a. 555 b. 555");
      await tick(12);
      flush();
      expect(div.textContent).toBe("a. 555 b. 555");
      await tick(12);
      flush();
      expect(div.textContent).toBe("a. 556 b. 556");
      api["disposer"]!();
    });

    gap(
      "transition-scope",
      "a write whose new reader waits on a flight already out is not held with it: show() turns true at once",
      "a conditional reveal waits for an async flight from an earlier flush",
      async () => {
        const div = new FakeElement("DIV");
        const api = run<Api>(
          `
          import { attach, signal } from "@reactre/core";
          import { isPending, memo } from "@reactre/core/features/async";
          let click;
          const disposer = attach(() => {
            const [value, setValue] = signal(0);
            const [show, setShow] = signal(false);
            const details = memo(async () => {
              const v = value();
              await new Promise((r) => setTimeout(r, 30));
              return v;
            });
            click = () => {
              setValue((v) => v + 1);
              setTimeout(() => setShow(true), 10);
            };
            return (
              <div>
                <div>value(): {value()} {isPending(value) ? "pending" : null}</div>
                <div>show(): {String(show())} {isPending(show) ? "pending" : null}</div>
                <div>{show() ? details() : "hidden"}</div>
              </div>
            );
          }, root);
          return { click: () => click(), disposer };
        `,
          div,
        );
        const lines = (): string[] =>
          (div.firstChild as FakeElement).childNodes.map((el) => (el.textContent ?? "").trim());
        try {
          flush();
          expect(lines()).toEqual(["value(): 0", "show(): false", "hidden"]);
          api["click"]!();
          flush();
          expect(lines()).toEqual(["value(): 1", "show(): false", "hidden"]);
          await tick(12);
          flush();
          expect(lines()).toEqual(["value(): 1", "show(): false pending", "hidden"]);
          await tick(30);
          flush();
          expect(lines()).toEqual(["value(): 1", "show(): true", "1"]);
        } finally {
          api["disposer"]!();
        }
      },
    );

    gap(
      "transition-scope",
      "a branch change whose new content waits on fresh async reads is not held: the old branch goes at once",
      "implicit route transition stays held after lazy component is cached",
      async () => {
        const div = new FakeElement("DIV");
        const resolvers: ((v: string) => void)[] = [];
        let resolveLazy!: (m: unknown) => void;
        const api = run<Api>(
          `
          import { attach, Match, signal, Switch } from "@reactre/core";
          import { isPending, lazy, memo } from "@reactre/core/features/async";
          const nextData = () => new Promise((resolve) => api.resolvers.push(resolve));
          const Profile = (props) => (
            <>
              <h1>{props.user}'s Profile</h1>
              <p>{props.info}</p>
            </>
          );
          const LazyProfile = lazy(() => new Promise((resolve) => api.lazy(resolve)));
          const ProfileRoute = () => {
            const user = memo(() => nextData());
            const info = memo(() => {
              user();
              return nextData();
            });
            return <LazyProfile user={user()} info={info()} />;
          };
          let setRoute;
          const disposer = attach(() => {
            const [route, _setRoute] = signal("home");
            setRoute = _setRoute;
            const matches = (value) => route() === value;
            return (
              <div class={{ pending: isPending(route) }}>
                <Switch>
                  <Match when={matches("home")}>
                    <h1>Home</h1>
                  </Match>
                  <Match when={matches("profile")}>
                    <ProfileRoute />
                  </Match>
                </Switch>
              </div>
            );
          }, root);
          return { setRoute: (v) => setRoute(v), disposer, Profile: () => Profile };
        `,
          div,
          { resolvers, lazy: (r: (m: unknown) => void) => (resolveLazy = r) },
        );
        try {
          expect(html(div)).toBe("<div><h1>Home</h1></div>");
          api["setRoute"]!("profile" as never);
          flush();
          expect(html(div)).toBe('<div class="pending"><h1>Home</h1></div>');
          resolveLazy({ default: api["Profile"]!() });
          await settle();
          expect(html(div)).toBe('<div class="pending"><h1>Home</h1></div>');
          resolvers.shift()!("Jon");
          await settle();
          expect(html(div)).toBe('<div class="pending"><h1>Home</h1></div>');
          resolvers.shift()!("Knows nothing");
          await settle();
          expect(html(div)).toBe('<div class=""><h1>Jon\'s Profile</h1><p>Knows nothing</p></div>');
        } finally {
          api["disposer"]!();
        }
      },
    );
  });
});

describe("web/test/latest-async.spec.tsx", () => {
  test("latest + isPending(latest) across refreshes under Loading (#2829)", async () => {
    const div = new FakeElement("DIV");
    const gate = { current: deferred<void>() };
    const api = run<Api>(
      `
      import { attach, signal } from "@reactre/core";
      import { isPending, latest, Loading, memo } from "@reactre/core/features/async";
      const [count, setCount] = signal(0);
      const asyncValue = memo(async () => {
        const c = count();
        await api.gate.current.p;
        return "AV" + c;
      });
      const disposer = attach(
        () => (
          <Loading fallback="loading">
            <p>{latest(asyncValue)}</p>
            <i>{String(isPending(() => latest(asyncValue)))}</i>
          </Loading>
        ),
        root,
      );
      return { setCount: (v) => setCount(v), disposer };
    `,
      div,
      { gate },
    );
    flush();
    expect(html(div)).toBe("loading");
    gate.current.ok();
    await settle();
    expect(html(div)).toBe("<p>AV0</p><i>false</i>");
    gate.current = deferred<void>();
    api["setCount"]!(1 as never);
    flush();
    expect(html(div)).toBe("<p>AV0</p><i>true</i>");
    gate.current.ok();
    await settle();
    expect(html(div)).toBe("<p>AV1</p><i>false</i>");
    api["disposer"]!();
  });
});

describe("signals/tests/createLoadingBoundary.test.ts", () => {
  gap(
    "async-store",
    "createProjection takes no async function: use an async memo or createOptimisticStore",
    "shows fallback while async projection is pending",
    async () => {
      const div = new FakeElement("DIV");
      run(
        `
        import { attach } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        import { createProjection } from "@reactre/core/features/store";
        const proj = createProjection(async (draft) => {
          await Promise.resolve();
          draft.value = 1;
        }, { value: 0 });
        attach(() => <Loading fallback="loading">{proj.value}</Loading>, root);
        return {};
      `,
        div,
      );
      flush();
      expect(div.textContent).toBe("loading");
      await settle();
      expect(div.textContent).toBe("1");
    },
  );

  test("nested boundaries - inner catches async", async () => {
    const div = new FakeElement("DIV");
    const d = deferred<number>();
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const value = memo(() => api.d.p);
      attach(
        () => (
          <Loading fallback="outer-loading">
            <p>outer-content</p>
            <Loading fallback="inner-loading">{value()}</Loading>
          </Loading>
        ),
        root,
      );
      return {};
    `,
      div,
      { d },
    );
    flush();
    expect(div.textContent).toBe("outer-contentinner-loading");
    d.ok(1);
    await settle();
    expect(div.textContent).toBe("outer-content1");
  });

  test("surfaces async rejection consistently for Loading/Errored orderings", async () => {
    const div = new FakeElement("DIV");
    const d = deferred<number>();
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      const source = memo(async () => {
        await api.d.p;
        return 10;
      });
      attach(
        () => (
          <>
            <p>
              <Loading fallback="">
                <Errored fallback="error1">S: {source()}</Errored>
              </Loading>
            </p>
            <p>
              <Errored fallback="error2">
                <Loading fallback="">S: {source()}</Loading>
              </Errored>
            </p>
          </>
        ),
        root,
      );
      return {};
    `,
      div,
      { d },
    );
    flush();
    expect(html(div)).toBe("<p></p><p></p>");
    d.no(new Error("boom"));
    await settle();
    expect(html(div)).toBe("<p>error1</p><p>error2</p>");
  });

  gap(
    "async-store",
    "createProjection takes no async function: use an async memo or createOptimisticStore",
    "side effect only runs when no longer pending",
    async () => {
      const div = new FakeElement("DIV");
      const sideEffectRuns = mock(() => {});
      run(
        `
        import { attach } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        import { reaction } from "@reactre/core/features/reaction";
        import { createProjection } from "@reactre/core/features/store";
        const proj = createProjection(async (draft) => {
          await Promise.resolve();
          draft.value = 1;
        }, { value: 0 });
        const Probe = () => (reaction(() => proj.value, api.side), "");
        attach(() => <Loading fallback="loading">{proj.value}<Probe /></Loading>, root);
        return {};
      `,
        div,
        { side: sideEffectRuns },
      );
      flush();
      expect(div.textContent).toBe("loading");
      expect(sideEffectRuns).toHaveBeenCalledTimes(1);
      await settle();
      expect(div.textContent).toBe("1");
      expect(sideEffectRuns).toHaveBeenCalledTimes(2);
    },
  );

  gap(
    "async-store",
    "createProjection takes no async function: use an async memo or createOptimisticStore",
    "handles rapid signal changes while pending",
    async () => {
      const div = new FakeElement("DIV");
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        import { createProjection } from "@reactre/core/features/store";
        const [x, setX] = signal(1);
        const proj = createProjection(async (draft) => {
          const v = x();
          await Promise.resolve();
          draft.value = v * 2;
        }, { value: 0 });
        attach(() => <Loading fallback="loading">{proj.value}</Loading>, root);
        return { setX: (v) => setX(v) };
      `,
        div,
      );
      flush();
      expect(div.textContent).toBe("loading");
      api["setX"]!(2 as never);
      flush();
      expect(div.textContent).toBe("loading");
      await settle();
      expect(div.textContent).toBe("4");
    },
  );

  test("stops loading when a pending child is disposed before its promise settles", () => {
    const div = new FakeElement("DIV");
    const d = deferred<string>();
    const api = run<Api>(
      `
      import { attach, signal } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const data = memo(() => api.d.p);
      const [show, setShow] = signal(true);
      attach(() => <Loading fallback="loading">{show() ? data() : "done"}</Loading>, root);
      return { setShow: (v) => setShow(v) };
    `,
      div,
      { d },
    );
    flush();
    expect(div.textContent).toBe("loading");
    api["setShow"]!(false as never);
    flush();
    expect(div.textContent).toBe("done");
  });

  test("instantiates the fallback once per show: a second reader going pending does not rebuild it", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    let builds = 0;
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, memo } from "@reactre/core/features/async";
      const x = memo(() => api.a.p), y = memo(() => api.b.p);
      const Fallback = () => (api.built(), "loading");
      attach(() => <Loading fallback={<Fallback />}><b>{x()}</b><i>{y()}</i></Loading>, root);
      return {};
    `,
      div,
      { a, b, built: () => builds++ },
    );
    flush();
    expect(builds).toBe(1);
    a.ok("A");
    await settle();
    expect(div.textContent).toBe("loading");
    expect(builds).toBe(1);
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("AB");
    expect(builds).toBe(1);
  });
});

describe("signals/tests/latest-async.test.ts", () => {
  gap(
    "bug",
    "reaction(() => isPending(...), apply): the transition holds apply, so it never sees true",
    "latest(asyncMemo) settles to the resolved value and re-reports pending on each refresh (#2829)",
    async () => {
      const [count, setCount] = signal(0);
      const gate = { current: deferred<void>() };
      const latestLog: unknown[] = [];
      const pendingLog: boolean[] = [];
      createRoot(() => {
        const asyncValue = memo(async () => {
          const c = count();
          await gate.current.p;
          return `AV${c}`;
        });
        reaction(
          () => latest(asyncValue),
          (v) => void latestLog.push(v),
        );
        reaction(
          () => isPending(() => latest(asyncValue)),
          (v) => void pendingLog.push(v),
        );
      });
      flush();
      expect(latestLog).toEqual([]);
      gate.current.ok();
      await settle();
      expect(latestLog.at(-1)).toBe("AV0");
      expect(pendingLog.at(-1)).toBe(false);
      gate.current = deferred<void>();
      setCount(1);
      flush();
      expect(pendingLog.at(-1)).toBe(true);
      expect(latestLog.at(-1)).toBe("AV0");
      gate.current.ok();
      await settle();
      expect(latestLog.at(-1)).toBe("AV1");
      expect(pendingLog.at(-1)).toBe(false);
      expect(latestLog).not.toContain(undefined);
    },
  );
});

describe("signals/tests/resolve.test.ts", () => {
  const delay = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

  test("rejects with the original error when the async source rejects after pending", async () => {
    const boom = new Error("boom");
    await createRoot(async (dispose) => {
      const m = memo(async () => {
        await delay(5);
        throw boom;
      });
      await expect(resolve(() => m())).rejects.toBe(boom);
      dispose();
    });
  });

  test("disposes its internal root when the source rejects", async () => {
    const cleanupSpy = mock(() => {});
    await createRoot(async (dispose) => {
      const m = memo(async () => {
        await delay(5);
        throw new Error("boom");
      });
      await resolve(() => {
        onCleanup(cleanupSpy);
        return m();
      }).catch(() => {});
      expect(cleanupSpy).toHaveBeenCalled();
      dispose();
    });
  });

  test("still resolves with the settled value when the source resolves", async () => {
    await createRoot(async (dispose) => {
      const [s] = signal(7);
      const m = memo(async () => {
        await delay(5);
        return s() * 2;
      });
      await expect(resolve(() => m())).resolves.toBe(14);
      dispose();
    });
  });

  test("rejects when the expression throws synchronously", async () => {
    const boom = new Error("sync-boom");
    await createRoot(async (dispose) => {
      await expect(
        resolve(() => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      dispose();
    });
  });
});

describe("signals/tests/refresh-await.test.ts", () => {
  /**
   * An async memo whose every run waits on a gate of its own, read by an effect (Solid's
   * `createEffect(m, () => {})`), which takes no error to the page: Solid's effect logs what its
   * compute throws, where reactre's would throw it on.
   */
  function gated(): { m: () => string; gates: ReturnType<typeof deferred<string>>[]; runs: string[] } {
    const gates: ReturnType<typeof deferred<string>>[] = [];
    const runs: string[] = [];
    let m!: () => string;
    createRoot(() => {
      m = memo(() => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.p;
      });
      let last: string | undefined;
      effect(() => {
        let v: string;
        try {
          v = m();
        } catch (e) {
          if (e instanceof NotReadyError) throw e;
          return;
        }
        if (v !== last) runs.push((last = v));
      });
    });
    return { m, gates, runs };
  }

  gap(
    "refresh-promise",
    "refresh() resolves with undefined, not the target's new value",
    "sync source: resolves with the re-executed value",
    async () => {
      let runs = 0;
      let m!: () => number;
      createRoot(() => {
        m = memo(() => ++runs);
        reaction(m, () => {});
      });
      expect(m()).toBe(1);
      const p = refresh(m);
      flush();
      await expect(p).resolves.toBe(2 as never);
      expect(m()).toBe(2);
    },
  );

  gap(
    "refresh-promise",
    "refresh() resolves with undefined, not the landed value",
    "async source: resolves with the landed value; the window stays quiet",
    async () => {
      const { m, gates } = gated();
      gates[0]!.ok("v1");
      await settle();
      expect(m()).toBe("v1");
      let settled = false;
      const p = refresh(m).then((v) => ((settled = true), v));
      flush();
      await tick();
      expect(m()).toBe("v1");
      expect(isPending(m)).toBe(false);
      expect(settled).toBe(false);
      gates[1]!.ok("v2");
      await settle();
      await expect(p).resolves.toBe("v2" as never);
      expect(m()).toBe("v2");
    },
  );

  test("equal-value landing (silent to the graph) still settles the promise", async () => {
    const { m, gates, runs } = gated();
    gates[0]!.ok("same");
    await settle();
    expect(runs).toEqual(["same"]);
    const p = refresh(m);
    flush();
    await tick();
    gates[1]!.ok("same");
    await settle();
    await expect(p).resolves.toBeUndefined();
    expect(runs).toEqual(["same"]);
  });

  test("failed re-ask rejects with the error", async () => {
    const { m, gates } = gated();
    gates[0]!.ok("v1");
    await settle();
    const p = refresh(m);
    // reactre's Promise rejects as the re-ask does, before the flush Solid's waits for: its
    // outcome is taken here, so that Bun does not report it unhandled before the assertion.
    const outcome = p.then(
      () => null,
      (e: unknown) => e,
    );
    flush();
    await tick();
    gates[1]!.no(new Error("refetch failed"));
    await settle();
    expect(await outcome).toEqual(new Error("refetch failed"));
  });

  gap(
    "refresh-promise",
    "an ignored refresh() whose re-ask fails is an unhandled rejection",
    "fire-and-forget refresh with a failing re-ask surfaces no unhandled rejection",
    async () => {
      const { m, gates } = gated();
      gates[0]!.ok("v1");
      await settle();
      void refresh(m);
      flush();
      await tick();
      gates[1]!.no(new Error("nobody listening"));
      await tick();
      await tick();
      flush();
    },
  );

  test("supersession: waiters from both refreshes deliver the final landing", async () => {
    const { m, gates } = gated();
    gates[0]!.ok("v1");
    await settle();
    const p1 = refresh(m);
    flush();
    await tick();
    const p2 = refresh(m);
    flush();
    await tick();
    gates[1]!.ok("stale");
    await settle();
    gates[2]!.ok("final");
    await settle();
    await p1;
    await p2;
    expect(m()).toBe("final");
  });

  gap(
    "refresh-promise",
    "refresh() of a plain signal's read throws TypeError: it takes a memo or an optimistic store",
    "plain signal accessor: refresh is a no-op — already quiescent, resolves with the value",
    async () => {
      const [s] = signal(3);
      await expect(refresh(s)).resolves.toBe(3 as never);
    },
  );
});

describe("signals/tests/loading-value.test.ts", () => {
  /** features/async's memo, typed with Solid 2.0's loadingValue option, which it does not take. */
  const withLoading = memo as unknown as <T>(fn: () => Promise<T>, options: { loadingValue: T }) => () => T;

  gap(
    "memo-options",
    "memo takes no loadingValue: a first read is not ready",
    "serves the loading value synchronously from birth",
    () => {
      const m = withLoading(() => new Promise<number>(() => {}), { loadingValue: 0 });
      expect(m()).toBe(0);
    },
  );

  gap(
    "memo-options",
    "memo takes no loadingValue: the boundary shows its fallback",
    "does not trip a Loading boundary during the first flight",
    async () => {
      const div = new FakeElement("DIV");
      const d = deferred<number>();
      run(
        `
        import { attach } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        const m = memo(() => api.d.p, { loadingValue: 0 });
        attach(() => <Loading fallback="loading">{m()}</Loading>, root);
        return {};
      `,
        div,
        { d },
      );
      flush();
      expect(div.textContent).toBe("0");
      d.ok(1);
      await settle();
      expect(div.textContent).toBe("1");
    },
  );

  gap(
    "memo-options",
    "memo takes no loadingValue: latest() of a first flight is not ready",
    "latest() serves the loading value during the first flight",
    () => {
      const m = withLoading(() => new Promise<string>(() => {}), { loadingValue: "seed" });
      expect(latest(m)).toBe("seed");
    },
  );
});

describe("signals/tests/createRevealOrder.test.ts", () => {
  /** Two boundaries under a <Reveal order>, each waiting on its own deferred. */
  const app = (order: string): string => `
    import { attach } from "@reactre/core";
    import { Loading, memo, Reveal } from "@reactre/core/features/async";
    const a = memo(() => api.a.p), b = memo(() => api.b.p);
    attach(
      () => (
        <Reveal order="${order}">
          <Loading fallback="fa">{a()}</Loading>
          <Loading fallback="fb">{b()}</Loading>
        </Reveal>
      ),
      root,
    );
    return {};
  `;

  test("sequential mode collapses tail and cascades frontier", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app("sequential"), div, { a, b });
    flush();
    expect(div.textContent).toBe("fafb");
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("fafb");
    a.ok("A");
    await settle();
    expect(div.textContent).toBe("AB");
  });

  test("together mode keeps all fallbacks visible until all are ready", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app("together"), div, { a, b });
    flush();
    a.ok("A");
    await settle();
    expect(div.textContent).toBe("fafb");
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("AB");
  });

  test("natural mode lets inner siblings reveal independently in resolution order", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(app("natural"), div, { a, b });
    flush();
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("faB");
    a.ok("A");
    await settle();
    expect(div.textContent).toBe("AB");
  });

  test("promotes next pending slot when head slot is removed", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    const api = run<Api>(
      `
      import { attach, signal } from "@reactre/core";
      import { Loading, memo, Reveal } from "@reactre/core/features/async";
      const a = memo(() => api.a.p), b = memo(() => api.b.p);
      const [head, setHead] = signal(true);
      attach(
        () => (
          <Reveal order="sequential">
            {head() ? <Loading fallback="fa">{a()}</Loading> : null}
            <Loading fallback="fb">{b()}</Loading>
          </Reveal>
        ),
        root,
      );
      return { setHead: (v) => setHead(v) };
    `,
      div,
      { a, b },
    );
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("fafb");
    api["setHead"]!(false as never);
    flush();
    expect(div.textContent).toBe("B");
  });

  test("advances reveal order when first slot errors inside error boundary", async () => {
    const div = new FakeElement("DIV");
    const a = deferred<string>(),
      b = deferred<string>();
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, memo, Reveal } from "@reactre/core/features/async";
      import { Errored } from "@reactre/core/features/errors";
      const a = memo(() => api.a.p), b = memo(() => api.b.p);
      attach(
        () => (
          <Reveal order="sequential">
            <Errored fallback="err"><Loading fallback="fa">{a()}</Loading></Errored>
            <Loading fallback="fb">{b()}</Loading>
          </Reveal>
        ),
        root,
      );
      return {};
    `,
      div,
      { a, b },
    );
    b.ok("B");
    await settle();
    expect(div.textContent).toBe("fafb");
    a.no(new Error("x"));
    await settle();
    expect(div.textContent).toBe("errB");
  });
});

describe("solid/test/reveal.spec.ts", () => {
  test("Reveal is exported as a function", () => {
    expect(typeof asyncApi.Reveal).toBe("function");
  });

  test("Reveal renders children", () => {
    const div = new FakeElement("DIV");
    run(
      `
      import { attach } from "@reactre/core";
      import { Reveal } from "@reactre/core/features/async";
      attach(() => <Reveal><b>child</b></Reveal>, root);
      return {};
    `,
      div,
    );
    expect(html(div)).toBe("<b>child</b>");
  });

  test("nested Reveal composes without error", () => {
    const div = new FakeElement("DIV");
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, Reveal } from "@reactre/core/features/async";
      attach(
        () => (
          <Reveal order="sequential">
            <Reveal order="together">
              <Loading fallback="a"><b>A</b></Loading>
            </Reveal>
            <Loading fallback="b"><b>B</b></Loading>
          </Reveal>
        ),
        root,
      );
      return {};
    `,
      div,
    );
    expect(html(div)).toBe("<b>A</b><b>B</b>");
  });

  test("Reveal inside Loading composes cleanly", () => {
    const div = new FakeElement("DIV");
    run(
      `
      import { attach } from "@reactre/core";
      import { Loading, Reveal } from "@reactre/core/features/async";
      attach(
        () => (
          <Loading fallback="outer">
            <Reveal order="together">
              <Loading fallback="a"><b>A</b></Loading>
            </Reveal>
          </Loading>
        ),
        root,
      );
      return {};
    `,
      div,
    );
    expect(html(div)).toBe("<b>A</b>");
  });
});

describe("held writes", () => {
  gap(
    "held-writes",
    "Solid's async boundary holds a write until flush; reactre shows it at once",
    "Children are reactive (before the flush, the old count)",
    () => {
      const div = new FakeElement("DIV");
      const api = run<Api>(
        `
        import { attach, signal } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        const [count, setCount] = signal(0);
        attach(() => <Loading>{count()}</Loading>, root);
        return { increment: () => setCount(count() + 1) };
      `,
        div,
      );
      api["increment"]!();
      expect(html(div)).toBe("0");
    },
  );
});
