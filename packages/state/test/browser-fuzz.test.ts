// Real V8 compiler equivalence: the same independent SPEC, its original TypeScript, development
// output and production output. Each self-contained bundle runs in headless Chrome, including task
// success/failure, cancellation and timers; the model computes arrivals without the runtime.
// Bun and TypeScript only; this is not installed-package evidence.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

import { findChrome } from "../../../apps/react-compat/chrome.ts";
import state from "../plugin/esbuild.ts";
import { generate, render } from "./fuzz/generate.ts";
import {
  firstDifference,
  samples,
  showTrace,
  shrink,
  type Trace,
  traceReference,
  traceReferenceAsync,
} from "./fuzz/harness.ts";
import type { RefEvent } from "./fuzz/reference.ts";
import type { PuppeteerModule } from "./integration/puppeteer.d.ts";

const executablePath = (() => {
  try {
    return findChrome();
  } catch {
    return undefined;
  }
})();

const scratch = mkdtempSync(join(import.meta.dir, ".browser-fuzz-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The independent trace snapshots after each event, before its simulated-clock advance. */
function driver(events: string): string {
  return `
const events = ${events};
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));
const clock = new SimulatedClock(0);
try {
  const actor = createActor(machine, { now: clock.now });
  const steps = [];
  for (const event of events) {
    const result = actor.send(event);
    steps.push({ event, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }),
      state: actor.snapshot().state, data: actor.snapshot().data, version: actor.snapshot().version });
    await tick();
    clock.advance(3);
    await tick();
  }
  actor.stop();
  return { start, steps };
} finally {
  clock.uninstall();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}`;
}

declare global {
  // The bundle's own result on its fresh page, polled after its driver finishes.
  // eslint-disable-next-line no-var
  var __browserFuzz: Trace | undefined;
}

describe.skipIf(executablePath === undefined)("compiler equivalence in real Chrome", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => ({
    seed: i + 1,
    nested: i % 2 === 1,
    parallel: i >= 8,
  }));
  test.each(seeds)(
    "seed $seed: source, development and production agree with the independent model",
    async ({ seed, nested, parallel }) => {
      if (executablePath === undefined) throw new Error("no Chrome");
      // The installed package's direct entry: the isolated Bun store cannot resolve its package
      // specifier in this worktree. No dependency is downloaded or changed.
      const puppeteerDirectory = join(import.meta.dir, "../../../apps/react-compat/node_modules/puppeteer-core");
      const puppeteer = (await import(join(puppeteerDirectory, "lib/puppeteer/puppeteer-core.js")))
        .default as PuppeteerModule["default"];
      const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] as string[] });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error: unknown) =>
          errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error)),
        );
        const spec = generate(seed, { nested, parallel, async: !parallel, states: 4, events: 3 });
        const original = samples(spec, seed, 12);
        const referenceFor = (events: Parameters<typeof traceReference>[1]) =>
          parallel ? traceReference(spec, events) : traceReferenceAsync(spec, events, 3);
        // The event sequence is data in the fresh bundle, not a minified-code placeholder:
        // shrinking recompiles the same machine and variant with only the shorter walk.
        const variants = [undefined, true, false] as const;
        const source = (events: readonly RefEvent[]) =>
          `import { createActor } from "@reactre/state";\nimport { SimulatedClock } from "@reactre/state/utils";\n${render(spec)}\nconst start = machine.i(undefined);\nglobalThis.__browserFuzz = (async () => {${driver(JSON.stringify(events))}})();`;
        const bundle = async (dev: true | false | undefined, events: readonly RefEvent[]): Promise<string> => {
          const file = join(scratch, `seed-${seed}-${dev ?? "source"}.ts`);
          await Bun.write(file, source(events));
          const output = await build({
            entryPoints: [file],
            bundle: true,
            platform: "browser",
            format: "esm",
            minify: true,
            write: false,
            logLevel: "silent",
            conditions: ["reactre-source", "module"],
            plugins: [state(dev === undefined ? {} : { dev })],
          });
          const [fileOutput] = output.outputFiles;
          if (fileOutput === undefined) throw new Error(`no browser fuzz bundle: seed ${seed}`);
          return fileOutput.text;
        };
        const run = async (code: string): Promise<Trace> => {
          await page.goto(`data:text/html,${encodeURIComponent(`<script type="module">${code}<\/script>`)}`);
          await page.waitForFunction(() => globalThis.__browserFuzz !== undefined, { timeout: 5_000 });
          return (await page.evaluate(() => globalThis.__browserFuzz!)) as Trace;
        };
        const compare = async (events: readonly RefEvent[]) => {
          const reference = referenceFor(events);
          for (const dev of variants) {
            const actual = await run(await bundle(dev, events));
            const step = firstDifference(reference, actual);
            if (step !== null)
              return `seed ${seed}, ${parallel ? "parallel" : nested ? "nested" : "flat"}, variant ${dev === undefined ? "source" : dev ? "dev" : "prod"}, step ${step}\nevents ${JSON.stringify(events)}\nreference:\n${showTrace(reference)}\nactual:\n${showTrace(actual)}`;
          }
          return null;
        };
        let failure = await compare(original);
        if (failure !== null) {
          const minimal = await shrink(spec, original, async (events) => (await compare(events)) !== null);
          failure = await compare(minimal);
        }
        expect(failure).toBeNull();
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    120_000,
  );
});
