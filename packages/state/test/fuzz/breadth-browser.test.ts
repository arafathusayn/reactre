// The fuzz breadth lane in real V8: the same hand-written cases as ./breadth.test.ts, each
// self-contained bundle (the machine, then a driver that sends the walk) built three ways and run
// in headless Chrome. The expectations are the ones in ./breadth-cases.ts, computed by hand from
// the contract, so a disagreement here is the compiler or the runtime in a real JavaScript engine,
// not Bun's.
//
// What the files prove: every case's bundle actually ran (the driver's `start` is a non-empty
// snapshot, and the step count is the walk's length), so a case that silently failed to execute
// cannot pass by producing nothing. Chrome is needed; the test skips when none is found, as the
// other browser tests do.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

import { findChrome } from "../../../../apps/react-compat/chrome.ts";
import state from "../../plugin/esbuild.ts";
import type { PuppeteerModule } from "../integration/puppeteer.d.ts";
import {
  type ExpectedTrace,
  LOOP_EVENTS,
  LOOP_EXPECTED,
  LOOP_SOURCE,
  NESTED_PARALLEL_EVENTS,
  NESTED_PARALLEL_EXPECTED,
  NESTED_PARALLEL_SOURCE,
} from "./breadth-cases.ts";

const executablePath = (() => {
  try {
    return findChrome();
  } catch {
    return undefined;
  }
})();

const scratch = mkdtempSync(join(import.meta.dir, ".breadth-browser-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

declare global {
  // The bundle's own result on its fresh page, polled after its driver finishes.
  // eslint-disable-next-line no-var
  var __breadth: ExpectedTrace | undefined;
}

/** The driver: send each event to the machine, recording what it did, then publish the trace. */
function driver(events: readonly unknown[]): string {
  return `
const events = ${JSON.stringify(events)};
const actor = createActor(machine);
const start = actor.snapshot();
const steps = events.map((event) => {
  const result = actor.send(event);
  const snapshot = actor.snapshot();
  return { event, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }), state: snapshot.state, data: snapshot.data, version: snapshot.version };
});
actor.stop();
globalThis.__breadth = { start, steps };
`;
}

/** One case: its source, the walk, and the hand-computed trace it must produce. */
const CASES = [
  {
    name: "nested parent inside a parallel region",
    source: NESTED_PARALLEL_SOURCE,
    events: NESTED_PARALLEL_EVENTS,
    expected: NESTED_PARALLEL_EXPECTED,
  },
  {
    name: "counting loop with a decision beside it",
    source: LOOP_SOURCE,
    events: LOOP_EVENTS,
    expected: LOOP_EXPECTED,
  },
] as const;

describe.skipIf(executablePath === undefined)("the fuzz breadth cases in real Chrome", () => {
  for (const { name, source, events, expected } of CASES) {
    test(
      name,
      async () => {
        if (executablePath === undefined) throw new Error("no Chrome");
        // The installed package's direct entry: the isolated Bun store cannot resolve its package
        // specifier in this worktree. No dependency is downloaded or changed.
        const puppeteerDirectory = join(import.meta.dir, "../../../../apps/react-compat/node_modules/puppeteer-core");
        const puppeteer = (await import(join(puppeteerDirectory, "lib/puppeteer/puppeteer-core.js")))
          .default as PuppeteerModule["default"];
        const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] as string[] });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error: unknown) =>
            errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error)),
          );
          /** The bundle for one variant: source (no plugin), development, production. */
          const bundle = async (dev: true | false | undefined): Promise<string> => {
            const file = join(scratch, `breadth-${slug(name)}-${dev ?? "source"}.ts`);
            await Bun.write(file, `import { createActor } from "@reactre/state";\n${source}\n${driver(events)}`);
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
            if (fileOutput === undefined) throw new Error(`no breadth bundle for ${name}`);
            return fileOutput.text;
          };
          /** Runs a bundle on a fresh page and returns its trace. */
          const run = async (code: string): Promise<ExpectedTrace> => {
            await page.goto(`data:text/html,${encodeURIComponent(`<script type="module">${code}<\/script>`)}`);
            await page.waitForFunction(() => globalThis.__breadth !== undefined, { timeout: 5_000 });
            return (await page.evaluate(() => globalThis.__breadth!)) as ExpectedTrace;
          };
          const failures: string[] = [];
          for (const dev of [undefined, true, false] as const) {
            const variant = dev === undefined ? "source" : dev ? "dev" : "prod";
            let actual: ExpectedTrace;
            try {
              actual = await run(await bundle(dev));
            } catch (error) {
              failures.push(`${variant}: the bundle threw: ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
            // The case ran: a driver that never executed would publish nothing, and the wait above
            // would have timed out instead; a step count other than the walk's means events were
            // dropped. Both are pinned here, so a bundle with no machine cannot pass silently.
            if (actual.steps.length !== events.length)
              failures.push(`${variant}: ran ${actual.steps.length} of ${events.length} events`);
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              failures.push(`${variant}:\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
          }
          expect(failures).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
        }
      },
      120_000,
    );
  }
});

/** A file-name-safe slug of a case's name. */
function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
