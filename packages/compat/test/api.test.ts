// The API manifest @reactre/plugin builds an app's `react` from: it must name every export of the
// runtime's default object, and expand and check an app's keys as documented in src/apis.ts.

import { describe, expect, test } from "bun:test";

import { ALWAYS, enabledApis, GROUPS, KEYS, REQUIRES } from "../src/api.ts";
import React from "../src/core.ts";
import * as Core from "../src/core.ts";

describe("API manifest", () => {
  test("names the runtime's default export, each key once, all of them named exports", () => {
    expect(new Set([...ALWAYS, ...KEYS])).toEqual(new Set(Object.keys(React)));
    expect(ALWAYS.length + KEYS.length).toBe(Object.keys(React).length);
    for (const k of [...ALWAYS, ...KEYS]) expect(Core).toHaveProperty(k);
  });

  test("groups and requirements name keys", () => {
    for (const keys of Object.values(GROUPS)) for (const k of keys) expect(KEYS).toContain(k);
    for (const [k, whole] of Object.entries(REQUIRES)) expect([k, whole].every((x) => KEYS.includes(x))).toBe(true);
  });

  test('"all" is every key, less what is excluded and what is part of it', () => {
    expect(enabledApis("all", [])).toEqual(new Set(KEYS));
    const on = enabledApis("all", ["useEffect", "@classes", "useActionState"]);
    for (const k of ["useEffect", "Component", "PureComponent", "useActionState", "useFormState"])
      expect(on.has(k)).toBe(false);
    expect(on.size).toBe(KEYS.length - 5);
  });

  test("a list is those keys, groups expanded, with what each is part of", () => {
    expect(enabledApis(["createRoot", "useState", "@suspense", "PureComponent"], [])).toEqual(
      new Set(["createRoot", "useState", "Suspense", "SuspenseList", "lazy", "PureComponent", "Component"]),
    );
    expect(enabledApis(["hydrateRoot", "useFormState"], ["useState"])).toEqual(
      new Set(["hydrateRoot", "useFormState", "useActionState"]),
    );
  });

  test("an unknown key, or no root, is an error", () => {
    expect(() => enabledApis("all", ["useStat"])).toThrow('"useStat" is not an API key');
    expect(() => enabledApis(["@forms"], [])).toThrow("an app needs createRoot or hydrateRoot");
    expect(() => enabledApis("all", ["createRoot", "hydrateRoot"])).toThrow("needs createRoot or hydrateRoot");
  });
});
