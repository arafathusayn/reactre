// The native cost of clearing an entry's rows, apart from its JavaScript: in each entry's own
// page, after the clear benchmark's warmups (five runs of create and clear, then create), the
// benchmark's 4x throttling and its last-resort GC, `tbody.textContent = ""` is timed directly.
// Entries whose rows carry JavaScript state on their elements (an expando, a WeakMap entry) show
// it here; see README.md.
//
// The clear test's score mixes the runtime's own work with the browser's cost of removing the
// rows. Timing the same native removal on every entry's DOM isolates the second part, so a gap
// between entries there comes from what their rows hold, not from their code.
//
//   bun native-clear.ts [entries] [samples]     (run from apps/profiling)
//
// entries: comma-separated (default vanillajs,reactre-dom); samples per entry (default 40),
// taken in alternation, a new page each. Alternating spreads drift in the machine's speed over
// all entries alike.

import { serveRoot, startBrowser } from "jfb/run";
import type { Page } from "puppeteer-core";

const entries = (process.argv[2] ?? "vanillajs,reactre-dom").split(",");
const samples = Number(process.argv[3] ?? 40);

const server = serveRoot();
const browser = await startBrowser();
const times: Record<string, number[]> = {};

/** Waits until the table has at least `n` rows. */
async function rowsThere(p: Page, n: number): Promise<void> {
  await p.waitForSelector(`tbody>tr:nth-of-type(${n})`, { timeout: 20000 });
}

try {
  for (let r = 0; r < samples; r++) {
    for (const e of entries) {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.port}/frameworks/keyed/${e}/index.html`, { waitUntil: "load" });
        await page.waitForSelector("#run");
        for (let i = 0; i < 5; i++) {
          await page.click("#run");
          await rowsThere(page, 1000);
          await page.click("#clear");
          await page.waitForFunction(() => !document.querySelector("tbody>tr"));
        }
        await page.click("#run");
        await rowsThere(page, 1000);
        // Let the create's frame finish before throttling, so no leftover work runs slowed.
        await new Promise((ok) => setTimeout(ok, 200));
        await page.emulateCPUThrottling(4);
        // The GC and the timed clear run in one evaluate, so nothing runs between them, and the
        // clear's time holds no garbage left by the warmups.
        const t = await page.evaluate(() => {
          (window as unknown as { gc(o: unknown): void }).gc({
            type: "major",
            execution: "sync",
            flavor: "last-resort",
          });
          const tbody = document.querySelector("tbody")!;
          const t0 = performance.now();
          tbody.textContent = "";
          return performance.now() - t0;
        });
        (times[e] ??= []).push(t);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}

/** The median of `xs`: the middle value, or the mean of the two middle values. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
for (const e of entries)
  console.log(
    `${e.padEnd(18)} native clear of 1,000 rows at 4x: median ${median(times[e]!).toFixed(1)} ms (${samples} samples)`,
  );
