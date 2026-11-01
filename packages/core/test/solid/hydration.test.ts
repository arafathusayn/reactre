// Ports of Solid 2.0's tests of what it has around server rendering: hydration (claiming the
// server's HTML on the client), its state API, the response primitives httpStatus and httpHeader
// (@reactre/core/server), the keyed server-to-client channel (takeHydrationValue,
// getHydrationWriter, in features/hydrate) and clientOnly (features/hydrate and the server's).
// From solid-js 2.0.0-rc.20 (solidjs/solid@5e68925):
// packages/web/test/hydration/class.spec.tsx, hydration/hydrate-falsy-sole-child-issue-3571.spec.tsx,
// packages/solid/test/hydration-state-api.spec.ts, packages/solid/test/server/nohydration.spec.ts,
// packages/web/test/server/http-components.spec.tsx, packages/web/test/take-hydration-value.spec.ts
// and packages/web/test/client-only.spec.tsx. Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// A gap's port reads the function it needs off the module that would export it, which throws at
// once while reactre has none, and then does what Solid's test does. A port's view is compiled as
// the plugin compiles it, with ./harness.ts (for hydration, with its `hydrate` option). Solid's
// response primitives write to the request event its integration provides; reactre's renders take
// the response head as their `response` option, so those ports pass it there.

import { afterEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as hydrateApi from "../../src/features/hydrate.ts";
import { signal } from "../../src/features/memo.ts";
import { createRoot } from "../../src/features/owner.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import * as serverApi from "../../src/server.ts";
import { base, compile, gap } from "./harness.ts";

/** A function an API of Solid's that reactre lacks would be: read off `mod`, throwing when it is not there. */
function missing<F>(mod: object, name: string): F {
  const f = (mod as Record<string, unknown>)[name];
  if (typeof f !== "function") throw new Error(`reactre has no ${name}`);
  return f as F;
}

/** `hydrate(view, container)`: claim the server's HTML in `container` for `view`, returning a disposer. */
type Hydrate = (view: () => unknown, container: FakeElement) => () => void;

/** What a view compiled for hydration imports: the core's modules, and features/hydrate. */
const hydrating: Record<string, unknown> = { ...base, "@reactre/core/features/hydrate": hydrateApi };

afterEach(() => {
  installFakeDocument();
  delete (globalThis as Record<string, unknown>)["$rrd"];
});

describe("packages/web/test/hydration/class.spec.tsx", () => {
  gap(
    "hydration",
    "a class object is taken apart only as JSX",
    "updates an object value after an in-place mutation",
    () => {
      const hydrate = missing<Hydrate>(hydrateApi, "hydrate");
      const container = new FakeElement("DIV");
      const classes = { before: true, after: false };
      const [value, setValue] = signal(classes, { equals: false });
      container.innerHTML = '<div class="before"></div>';
      const { view } = compile<{ view: () => unknown }>(
        `return { view: () => <div class={value()} /> };`,
        hydrating,
        { value },
        "hydrate",
      );
      const dispose = hydrate(view, container);
      const element = container.firstChild as FakeElement;
      element.setAttribute("class", "before external");
      classes.before = false;
      classes.after = true;
      setValue(classes);
      flush();
      expect(element.getAttribute("class")).toBe("external after");
      dispose();
    },
  );
});

describe("packages/web/test/hydration/hydrate-falsy-sole-child-issue-3571.spec.tsx", () => {
  gap(
    "hydration",
    "hydrate() needs the server's markers",
    "server 0 text node is dropped when the hole becomes an element",
    () => {
      const hydrate = missing<Hydrate>(hydrateApi, "hydrate");
      const container = new FakeElement("DIV");
      container.innerHTML = "<span>0</span>";
      const span = container.firstChild as FakeElement;
      const serverText = span.firstChild;
      const { view, setLoading } = compile<{ view: () => unknown; setLoading: (v: boolean) => void }>(
        `
      import { signal } from "@reactre/core";
      const [loading, setLoading] = signal(false);
      return { view: () => <span>{loading() ? <i>load</i> : 0}</span>, setLoading };
      `,
        hydrating,
        {},
        "hydrate",
      );
      const dispose = hydrate(view, container);
      // The server element and its text node were adopted, not replaced.
      expect(container.firstChild).toBe(span);
      expect(span.firstChild).toBe(serverText);
      setLoading(true);
      expect(span.innerHTML).toBe("<i>load</i>");
      setLoading(false);
      expect(span.innerHTML).toBe("0");
      expect(span.childNodes.length).toBe(1);
      dispose();
    },
  );
});

describe("packages/solid/test/hydration-state-api.spec.ts", () => {
  test("false outside hydration (client-only render)", () => {
    const isHydrating = missing<() => boolean>(hydrateApi, "isHydrating");
    let seen: boolean | undefined;
    createRoot(() => {
      seen = isHydrating();
    });
    expect(seen).toBe(false);
  });
});

describe("packages/solid/test/server/nohydration.spec.ts", () => {
  gap("hydration", "<NoHydration> is missing", "NoHydration renders children", () => {
    const NoHydration = missing<(props: { children: unknown }) => unknown>(serverApi, "NoHydration");
    const html = serverApi.renderToString(() => NoHydration({ children: "static" }));
    expect(html).toBe("static");
  });
});

/**
 * The response head of a request event, as Solid's integrations give one. reactre's renders take
 * it as their `response` option, where Solid's read it off the request event its integration
 * provides (`provideRequestEvent`).
 */
const makeEvent = (): { request: Request; response: serverApi.ResponseHead } => ({
  request: new Request("http://localhost/"),
  response: { status: 200, headers: new Headers() },
});

describe("packages/web/test/server/http-components.spec.tsx", () => {
  describe("httpStatus (server primitive)", () => {
    test("declares status and statusText on the event's response during SSR", () => {
      const event = makeEvent();
      serverApi.renderToString(
        () => {
          serverApi.httpStatus(404, "Not Found");
          return "not found";
        },
        { response: event.response },
      );
      expect(event.response.status).toBe(404);
      expect(event.response.statusText).toBe("Not Found");
    });

    test("restores the snapshotted status on disposal, not a hardcoded 200", () => {
      const event = makeEvent();
      event.response.status = 418;
      serverApi.renderToString(
        () =>
          createRoot((dispose) => {
            serverApi.httpStatus(500);
            expect(event.response.status).toBe(500);
            dispose();
            return null;
          }),
        { response: event.response },
      );
      expect(event.response.status).toBe(418);
    });
  });

  describe("httpHeader (server primitive)", () => {
    test("declares a header on the event's response during SSR", () => {
      const event = makeEvent();
      serverApi.renderToString(
        () => {
          serverApi.httpHeader("x-test", "yes");
          return "page";
        },
        { response: event.response },
      );
      expect(event.response.headers.get("x-test")).toBe("yes");
    });

    test("append adds to an existing value instead of replacing it", () => {
      const event = makeEvent();
      event.response.headers.set("vary", "accept");
      serverApi.renderToString(
        () => {
          serverApi.httpHeader("vary", "cookie", { append: true });
          return "page";
        },
        { response: event.response },
      );
      expect(event.response.headers.get("vary")).toBe("accept, cookie");
    });
  });

  describe("clientOnly (server)", () => {
    test("SSRs the fallback and never starts the import", () => {
      const importer = mock(() => Promise.resolve({ default: () => null }));
      const Widget = serverApi.clientOnly(importer);
      const html = serverApi.renderToString(() => Widget({ fallback: "placeholder" }));
      expect(html).toContain("placeholder");
      expect(importer).not.toHaveBeenCalled();
    });

    test("renders nothing without a fallback", () => {
      const Widget = serverApi.clientOnly(() => Promise.resolve({ default: () => null }));
      expect(serverApi.renderToString(() => ["before", Widget({}), "after"])).toBe("beforeafter");
    });
  });
});

describe("packages/web/test/client-only.spec.tsx", () => {
  test("starts the import eagerly by default", () => {
    const importer = mock(() => Promise.resolve({ default: () => "widget" }));
    hydrateApi.clientOnly(importer);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  test("lazy option defers the import to first render", async () => {
    const clientOnly = hydrateApi.clientOnly;
    let resolve!: () => void;
    const loaded = new Promise<{ default: () => unknown }>((r) => (resolve = () => r({ default: () => "widget" })));
    const importer = mock(() => loaded);
    const Widget = clientOnly(importer, { lazy: true });
    expect(importer).not.toHaveBeenCalled();
    const div = new FakeElement("DIV");
    const { view } = compile<{ view: () => unknown }>(
      `return { view: () => <div><Widget fallback={<i>wait</i>} /></div> };`,
      base,
      { Widget },
    );
    const dispose = core.attach(view, div as unknown as Element);
    expect(importer).toHaveBeenCalledTimes(1);
    resolve();
    await loaded;
    await Promise.resolve();
    expect(div.textContent).toContain("widget");
    dispose();
  });
});

// Solid's page registry is `_$HY.r`; reactre's is `self.$rrd`, which the server's scripts fill.
describe("packages/web/test/take-hydration-value.spec.ts", () => {
  test("seeded values: resolved, then gone (take-and-remove)", () => {
    (globalThis as Record<string, unknown>)["$rrd"] = { "lib:a": { n: 1 }, "lib:nil": null };
    expect(hydrateApi.takeHydrationValue("lib:a")).toEqual({ status: "resolved", value: { n: 1 } });
    expect(hydrateApi.takeHydrationValue("lib:a")).toBeUndefined();
    expect(hydrateApi.takeHydrationValue("lib:nil")).toEqual({ status: "resolved", value: null });
  });

  test("undefined with no registry or no entry", () => {
    expect(hydrateApi.takeHydrationValue("lib:none")).toBeUndefined();
    (globalThis as Record<string, unknown>)["$rrd"] = {};
    expect(hydrateApi.takeHydrationValue("lib:none")).toBeUndefined();
  });

  test("getHydrationWriter is undefined on the client", () => {
    expect(hydrateApi.getHydrationWriter()).toBeUndefined();
  });
});
