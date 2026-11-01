// Ports of Solid 2.0's tests of what it has around server rendering that reactre does not yet:
// hydration (claiming the server's HTML on the client), its state API, the response primitives
// httpStatus and httpHeader, the keyed server-to-client channel (takeHydrationValue,
// getHydrationWriter) and clientOnly. From solid-js 2.0.0-rc.20 (solidjs/solid@5e68925):
// packages/web/test/hydration/class.spec.tsx, hydration/hydrate-falsy-sole-child-issue-3571.spec.tsx,
// packages/solid/test/hydration-state-api.spec.ts, packages/solid/test/server/nohydration.spec.ts,
// packages/web/test/server/http-components.spec.tsx, packages/web/test/take-hydration-value.spec.ts
// and packages/web/test/client-only.spec.tsx. Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Every port here is a gap: each reads the function it needs off the module that would export it
// (@reactre/core for the client's, @reactre/core/server for the server's), which throws at once
// while reactre has none, and then does what Solid's test does. A port's view is compiled as the
// plugin compiles it, with ./harness.ts.

import { afterEach, describe, expect, mock } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

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

afterEach(() => {
  installFakeDocument();
  delete (globalThis as Record<string, unknown>)["_$HY"];
});

describe("packages/web/test/hydration/class.spec.tsx", () => {
  gap("hydration", "hydrate() is missing", "updates an object value after an in-place mutation", () => {
    const hydrate = missing<Hydrate>(core, "hydrate");
    const container = new FakeElement("DIV");
    const classes = { before: true, after: false };
    const [value, setValue] = signal(classes, { equals: false });
    container.innerHTML = '<div class="before"></div>';
    const { view } = compile<{ view: () => unknown }>(`return { view: () => <div class={value()} /> };`, base, {
      value,
    });
    const dispose = hydrate(view, container);
    const element = container.firstChild as FakeElement;
    element.setAttribute("class", "before external");
    classes.before = false;
    classes.after = true;
    setValue(classes);
    flush();
    expect(element.getAttribute("class")).toBe("external after");
    dispose();
  });
});

describe("packages/web/test/hydration/hydrate-falsy-sole-child-issue-3571.spec.tsx", () => {
  gap("hydration", "hydrate() is missing", "server 0 text node is dropped when the hole becomes an element", () => {
    const hydrate = missing<Hydrate>(core, "hydrate");
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
      base,
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
  });
});

describe("packages/solid/test/hydration-state-api.spec.ts", () => {
  gap("hydration", "isHydrating() is missing", "false outside hydration (client-only render)", () => {
    const isHydrating = missing<() => boolean>(core, "isHydrating");
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

/** The response head of a request event, as Solid's integrations give one. */
interface ResponseStub {
  status: number;
  statusText?: string;
  headers: Headers;
}

/** Run `fn` with `event` as the request being rendered (Solid's provideRequestEvent). */
type Provide = <T>(event: { request: Request; response: ResponseStub }, fn: () => T) => T;

const makeEvent = (): { request: Request; response: ResponseStub } => ({
  request: new Request("http://localhost/"),
  response: { status: 200, headers: new Headers() },
});

describe("packages/web/test/server/http-components.spec.tsx", () => {
  describe("httpStatus (server primitive)", () => {
    gap(
      "ssr-helpers",
      "httpStatus() is missing",
      "declares status and statusText on the event's response during SSR",
      () => {
        const httpStatus = missing<(code: number, text?: string) => void>(serverApi, "httpStatus");
        const provide = missing<Provide>(serverApi, "provideRequestEvent");
        const event = makeEvent();
        provide(event, () =>
          serverApi.renderToString(() => {
            httpStatus(404, "Not Found");
            return "not found";
          }),
        );
        expect(event.response.status).toBe(404);
        expect(event.response.statusText).toBe("Not Found");
      },
    );

    gap(
      "ssr-helpers",
      "httpStatus() is missing",
      "restores the snapshotted status on disposal, not a hardcoded 200",
      () => {
        const httpStatus = missing<(code: number, text?: string) => void>(serverApi, "httpStatus");
        const provide = missing<Provide>(serverApi, "provideRequestEvent");
        const event = makeEvent();
        event.response.status = 418;
        provide(event, () =>
          createRoot((dispose) => {
            httpStatus(500);
            expect(event.response.status).toBe(500);
            dispose();
          }),
        );
        expect(event.response.status).toBe(418);
      },
    );
  });

  describe("httpHeader (server primitive)", () => {
    gap("ssr-helpers", "httpHeader() is missing", "declares a header on the event's response during SSR", () => {
      const httpHeader = missing<(name: string, value: string, options?: { append?: boolean }) => void>(
        serverApi,
        "httpHeader",
      );
      const provide = missing<Provide>(serverApi, "provideRequestEvent");
      const event = makeEvent();
      provide(event, () =>
        serverApi.renderToString(() => {
          httpHeader("x-test", "yes");
          return "page";
        }),
      );
      expect(event.response.headers.get("x-test")).toBe("yes");
    });

    gap("ssr-helpers", "httpHeader() is missing", "append adds to an existing value instead of replacing it", () => {
      const httpHeader = missing<(name: string, value: string, options?: { append?: boolean }) => void>(
        serverApi,
        "httpHeader",
      );
      const provide = missing<Provide>(serverApi, "provideRequestEvent");
      const event = makeEvent();
      event.response.headers.set("vary", "accept");
      provide(event, () =>
        serverApi.renderToString(() => {
          httpHeader("vary", "cookie", { append: true });
          return "page";
        }),
      );
      expect(event.response.headers.get("vary")).toBe("accept, cookie");
    });
  });

  describe("clientOnly (server)", () => {
    gap("client-only", "clientOnly() is missing", "SSRs the fallback and never starts the import", () => {
      const clientOnly = missing<(load: () => Promise<{ default: () => unknown }>) => (props: object) => unknown>(
        serverApi,
        "clientOnly",
      );
      const importer = mock(() => Promise.resolve({ default: () => null }));
      const Widget = clientOnly(importer);
      const html = serverApi.renderToString(() => Widget({ fallback: "placeholder" }));
      expect(html).toContain("placeholder");
      expect(importer).not.toHaveBeenCalled();
    });

    gap("client-only", "clientOnly() is missing", "renders nothing without a fallback", () => {
      const clientOnly = missing<(load: () => Promise<{ default: () => unknown }>) => (props: object) => unknown>(
        serverApi,
        "clientOnly",
      );
      const Widget = clientOnly(() => Promise.resolve({ default: () => null }));
      expect(serverApi.renderToString(() => ["before", Widget({}), "after"])).toBe("beforeafter");
    });
  });
});

describe("packages/web/test/client-only.spec.tsx", () => {
  type ClientOnly = (
    load: () => Promise<{ default: () => unknown }>,
    options?: { lazy?: boolean },
  ) => (props: { fallback?: unknown }) => unknown;

  gap("client-only", "clientOnly() is missing", "starts the import eagerly by default", () => {
    const clientOnly = missing<ClientOnly>(core, "clientOnly");
    const importer = mock(() => Promise.resolve({ default: () => "widget" }));
    clientOnly(importer);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  gap("client-only", "clientOnly() is missing", "lazy option defers the import to first render", async () => {
    const clientOnly = missing<ClientOnly>(core, "clientOnly");
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

describe("packages/web/test/take-hydration-value.spec.ts", () => {
  type Take = (key: string) => { status: string; value?: unknown } | undefined;

  gap("ssr-helpers", "takeHydrationValue() is missing", "seeded values: resolved, then gone (take-and-remove)", () => {
    const takeHydrationValue = missing<Take>(core, "takeHydrationValue");
    (globalThis as Record<string, unknown>)["_$HY"] = { r: { "lib:a": { n: 1 }, "lib:nil": null } };
    expect(takeHydrationValue("lib:a")).toEqual({ status: "resolved", value: { n: 1 } });
    expect(takeHydrationValue("lib:a")).toBeUndefined();
    expect(takeHydrationValue("lib:nil")).toEqual({ status: "resolved", value: null });
  });

  gap("ssr-helpers", "takeHydrationValue() is missing", "undefined with no registry or no entry", () => {
    const takeHydrationValue = missing<Take>(core, "takeHydrationValue");
    expect(takeHydrationValue("lib:none")).toBeUndefined();
    (globalThis as Record<string, unknown>)["_$HY"] = { r: {} };
    expect(takeHydrationValue("lib:none")).toBeUndefined();
  });

  gap("ssr-helpers", "getHydrationWriter() is missing", "getHydrationWriter is undefined on the client", () => {
    const getHydrationWriter = missing<() => unknown>(core, "getHydrationWriter");
    expect(getHydrationWriter()).toBeUndefined();
  });
});
