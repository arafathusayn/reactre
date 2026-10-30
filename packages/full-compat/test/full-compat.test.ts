// @reactre/full-compat's entries, run from their sources as Bun runs them (the `bun` export
// condition). What time slicing does is tested against React in
// packages/compat/test/concurrent.test.ts; here, that the package is @reactre/compat with it on.

import { afterAll, expect, test } from "bun:test";

import * as Compat from "@reactre/compat";
import * as CompatCore from "@reactre/compat/core";
import * as CompatBrowserServer from "@reactre/compat/server.browser";
import * as CompatEdgeServer from "@reactre/compat/server.edge";
import * as CompatServer from "@reactre/compat/server.node";

import { slicing } from "../../compat/src/slicing.ts";
import * as Core from "../src/core.ts";
import "../src/features/classes.ts";
import "../src/features/concurrent.ts";
import "../src/features/keys.ts";
import "../src/features/retry.ts";
import "../src/features/stacks.ts";
import "../src/features/undo.ts";
import "../src/features/viewTransitions.ts";
import * as Full from "../src/index.ts";
import * as BrowserServer from "../src/server.browser.ts";
import * as EdgeServer from "../src/server.edge.ts";
import * as Server from "../src/server.ts";

// What loading the entries did, before the other files' tests run on a core that does not slice.
const on = slicing.on;
slicing.on = false;
afterAll(() => void (slicing.on = false));

test("its entries turn time slicing on and compile it in", () => {
  expect(on).toBe(true);
  expect(globalThis.__REACTRE_SLICING__).toBe(true);
});

test("its client entries are @reactre/compat's", () => {
  expect(Object.keys(Full).sort()).toEqual(Object.keys(Compat).sort());
  expect(Full.default).toBe(Compat.default);
  expect(Full.useTransition).toBe(Compat.useTransition);
  expect(Object.keys(Core).sort()).toEqual(Object.keys(CompatCore).sort());
  expect(Core.default).toBe(CompatCore.default);
});

test("its server entries are @reactre/compat's, as they are", () => {
  for (const [full, compat] of [
    [Server, CompatServer],
    [BrowserServer, CompatBrowserServer],
    [EdgeServer, CompatEdgeServer],
  ] as const) {
    expect(Object.keys(full).sort()).toEqual(Object.keys(compat).sort());
    expect(full.default).toBe(compat.default);
    expect(full.renderToString).toBe(compat.renderToString);
  }
});
