// Unit tests of the plugin's own options and errors, through unplugin's raw factory (the hooks as
// written, before unplugin adapts them to a bundler). Bundling with each bundler is tested in
// ./bundlers.test.ts.

import { describe, expect, test } from "bun:test";

import { reactre, type ReactreOptions } from "../src/index.ts";

/** The plugin's transform handler for `options`, as Vite would get it. */
function transform(options: ReactreOptions) {
  const raw = reactre.raw(options, { framework: "vite" } as never);
  const t = Array.isArray(raw) ? raw[0]!.transform : raw.transform;
  return t as { handler: (code: string, id: string) => { code: string } } | undefined;
}

describe("transform", () => {
  test("core mode names the file in a compile error", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = () => <><b /></>;`, "/app/a.tsx?v=1")).toThrow(
      /^\/app\/a\.tsx: reactre: /,
    );
  });

  test("core mode refuses a key after spread props, which needs React's classic runtime", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = (p) => <b {...p} key="k" />;`, "/app/b.jsx")).toThrow(
      "reactre: /app/b.jsx: a key after {...spread} props cannot be compiled",
    );
  });

  test("errors that are not compile errors pass through unchanged", () => {
    const t = transform({})!;
    expect(() => t.handler(`export const A = () => <p>;`, "/app/c.tsx")).toThrow(/^\/app\/c\.tsx: /);
  });

  test("compat mode with compile: false only redirects react, with no transform", () => {
    expect(transform({ compat: { compile: false } })).toBeUndefined();
    expect(transform({ compat: true })!.handler(`export const A = () => <b>x</b>;`, "/app/d.jsx").code).toContain(
      "__hrTemplate",
    );
  });
});
