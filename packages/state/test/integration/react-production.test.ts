// The React adapter's development diagnostics stay out of a production bundle: the same app, built
// twice by the package's esbuild plugin (dev: false and dev: true), as an app ships it. Production
// must carry no dev-diagnostic text — the React adapter's warnings (M313–M316), the development
// freeze, and the core's round check (S29) and dead-child warning — while development keeps them.
//
// The dev-React integration tests prove the warnings fire in a browser and the production entry
// does not warn; this test proves the bytes that carry the warnings are absent from production at
// all. Behavior is checked too: both bundles run, and the compiled machine drives closed -> open ->
// closed when the built module is evaluated, so the strings are checked on a bundle that works.
//
// React is bundled (not external): the built module is evaluated from a data URL, which can't
// resolve bare specifiers. `react-dom/client` isn't a dependency of this package, so a tiny
// resolver stub stands in for it: only `./app.tsx`'s exports and doorMachine are evaluated here.

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { createActor } from "@reactre/state";
import esbuildPlugin from "@reactre/state/plugin/esbuild";
import { build, type Plugin } from "esbuild";

import type { DoorMachine } from "./fixtures/dev-react/app.tsx";

const FIXTURE = `${import.meta.dir}/fixtures/dev-react/app.tsx`;

/** Enough of react-dom/client for the fixture to load: nothing renders here. */
const stubDom: Plugin = {
  name: "stub-react-dom-client",
  setup(b) {
    b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: "react-dom/client", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const createRoot = () => ({ render() {} });",
      loader: "js",
    }));
  },
};

/** The fixture's app, built as an app ships it, with the plugin at `dev`. */
async function bundle(dev: boolean): Promise<{ readonly code: string; readonly bytes: number }> {
  const r = await build({
    entryPoints: [FIXTURE],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    logLevel: "silent",
    jsx: "automatic",
    conditions: ["reactre-source", "module"],
    // React's own development warnings must not stand in for this package's: the bundle is
    // production React either way, and what is checked is this package's diagnostics.
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [esbuildPlugin({ dev }), stubDom],
  });
  const [file] = r.outputFiles;
  if (file === undefined) throw new Error("no bundle");
  return { code: file.text, bytes: gzipSync(file.contents).length };
}

/** Text a production bundle must not contain, each a distinct development-only diagnostic. */
const DEV_ONLY = [
  // M314's warning: a different machine on a later render.
  "a different machine was passed on a later render",
  // M316's warning: Strict Mode's second mount, and the sends lost to it.
  "Strict Mode's second mount replaced the actor",
  // M315's warning: a selector that builds a new object with no compare.
  "the selector returns a new object on each notification",
  // The warning channel itself (M313–M316 all go through it).
  "console.warn",
  // The development freeze of snapshots and data.
  "isFrozen",
  // M51's round check (S29): a listener that sends on every snapshot.
  "a listener sent an event on every snapshot",
  // M149's dead-child warning (S29): a send to a child that isn't running.
  "enq.sendTo",
  // The dev entry's specifier: a production build imports @reactre/state/react, not /react/dev.
  "react/dev",
] as const;

describe("a production bundle of the React adapter", () => {
  test("ships none of the development diagnostics, and development keeps every one", async () => {
    const [prod, dev] = [await bundle(false), await bundle(true)];
    for (const diagnostic of DEV_ONLY) {
      expect({ diagnostic, prod: prod.code.split(diagnostic).length - 1 }).toEqual({ diagnostic, prod: 0 });
      // And development really has it, so a fixture that stopped exercising one can't pass quietly.
      // The dev entry's specifier is the one exception: the bundler resolves it to the entry's
      // source, so it never appears as text in either bundle.
      if (diagnostic !== "react/dev")
        expect({ diagnostic, found: dev.code.includes(diagnostic) }).toEqual({
          diagnostic,
          found: true,
        });
    }
    // The dev bundle is larger for a reason: the diagnostics are there.
    expect(prod.bytes).toBeLessThan(dev.bytes);
  });

  test.each([
    ["production", false],
    ["development", true],
  ] as const)("the %s bundle runs: the machine moves closed -> open -> closed", async (_, dev) => {
    const { code } = await bundle(dev);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      // The emitted module erased the source's public generics, not its runtime table.
      readonly doorMachine: DoorMachine;
      readonly View: unknown;
    };
    // The adapter is in the bundle (its hooks compiled), not tree-shaken away.
    expect(typeof mod.View).toBe("function");
    const actor = createActor(mod.doorMachine);
    expect(actor.snapshot().state).toBe("closed");
    expect(actor.snapshot().state).toBe("closed");
    expect(actor.send({ type: "push", by: "ann" }).ok).toBe(true);
    expect(actor.snapshot()).toMatchObject({ state: "open", data: { by: "ann" } });
    expect(actor.send({ type: "close" }).ok).toBe(true);
    expect(actor.snapshot().state).toBe("closed");
    actor.stop();
  });
});
