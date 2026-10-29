// The API manifest @reactre/plugin builds an app's `react` from: it must name every export of the
// runtime's default object, and expand and check an app's keys as documented in src/apis.ts.

import { describe, expect, test } from "bun:test";

import { ALWAYS, BEHAVIOURS, enabledApis, GROUPS, KEYS, MODULES, REQUIRES } from "../src/api.ts";
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
    const keys = [...KEYS, ...BEHAVIOURS];
    for (const [k, whole] of Object.entries(REQUIRES)) expect([k, whole].every((x) => keys.includes(x))).toBe(true);
  });

  test('"all" is every key, less what is excluded and what is part of it', () => {
    expect(enabledApis("all", [])).toEqual(new Set([...KEYS, ...BEHAVIOURS]));
    const on = enabledApis("all", ["useEffect", "@classes", "useActionState", "componentStack"]);
    for (const k of ["useEffect", "Component", "PureComponent", "useActionState", "useFormState", "componentStack"])
      expect(on.has(k)).toBe(false);
    expect(on.size).toBe(KEYS.length + BEHAVIOURS.length - 6);
  });

  test("a list is those keys, groups expanded, with what each is part of, and every behaviour", () => {
    expect(enabledApis(["createRoot", "useState", "@suspense", "PureComponent"], [])).toEqual(
      new Set(["createRoot", "useState", "Suspense", "lazy", "PureComponent", "Component", ...BEHAVIOURS]),
    );
    expect(enabledApis(["hydrateRoot", "useFormState"], ["useState", "repeatedKeys"])).toEqual(
      new Set([
        "hydrateRoot",
        "useFormState",
        "useActionState",
        "componentStack",
        "renderRetry",
        "concurrentRendering",
        "viewTransitions",
      ]),
    );
  });

  test("each module key's module is an export of the package that installs its feature", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      exports: Record<string, Record<string, string>>;
      sideEffects: string[];
    };
    expect(Object.keys(MODULES).sort()).toEqual(["Component", ...BEHAVIOURS].sort());
    expect(pkg.exports["./features/*"]).toEqual({
      types: "./src/features/*.ts",
      bun: "./src/features/*.ts",
      default: "./dist/features/*.js",
    });
    expect(pkg.sideEffects).toEqual(expect.arrayContaining(["./src/features/*.ts", "./dist/features/*.js"]));
    for (const m of Object.values(MODULES)) {
      expect(m).toStartWith("@reactre/compat/features/");
      expect(await Bun.file(new URL(`../src/features/${m.slice(25)}.ts`, import.meta.url)).exists()).toBe(true);
    }
  });

  test("an unknown key, or no root, is an error", () => {
    expect(() => enabledApis("all", ["useStat"])).toThrow('"useStat" is not an API key');
    expect(() => enabledApis("all", ["useStat"])).toThrow(
      "the behaviours componentStack, repeatedKeys, renderRetry, concurrentRendering, viewTransitions and the groups",
    );
    expect(() => enabledApis(["@forms"], [])).toThrow("an app needs createRoot or hydrateRoot");
    expect(() => enabledApis("all", ["createRoot", "hydrateRoot"])).toThrow("needs createRoot or hydrateRoot");
  });

  test("SuspenseList is not exported, as React 19.3.1's stable react does not export it", async () => {
    // Through a variable, so the type check does not look for React's types.
    const specifier = "react";
    // React's production build, as the files that render with React load it: whichever file
    // loads react first in the process sets the build every later file gets.
    const prevEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    const R = (await import(specifier)) as Record<string, unknown>;
    if (prevEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = prevEnv;
    for (const k of ["SuspenseList", "unstable_SuspenseList"]) {
      expect(k in R).toBe(false);
      expect(k in Core).toBe(false);
      expect(k in React).toBe(false);
    }
    // ViewTransition and addTransitionType are stable exports of 19.3.1.
    for (const k of ["ViewTransition", "addTransitionType"])
      expect([k in R, k in Core, k in React]).toEqual([true, true, true]);
  });

  test("view transitions need the transition lanes: excluding these leaves both out", () => {
    expect(enabledApis("all", ["concurrentRendering"]).has("viewTransitions")).toBe(false);
    const on = enabledApis("all", ["viewTransitions"]);
    expect([on.has("viewTransitions"), on.has("concurrentRendering")]).toEqual([false, true]);
  });
});
