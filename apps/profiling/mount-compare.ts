// Identical fixture and settings, alternating base/head, three iterations in fresh pages.
// bun apps/profiling/mount-compare.ts <base-revision> <output-file> [--profile]
import { mkdirSync, readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

import { findChrome } from "../jfb/chrome.ts";
const base = process.argv[2] ?? "HEAD";
const output = resolve(process.argv[3] ?? "/tmp/reactre-mount-results.json");
const profile = process.argv.includes("--profile");
const root = resolve(import.meta.dir, "../..");
const scratch = join(import.meta.dir, ".cache/mount-compare", base.replace(/[^a-zA-Z0-9]/g, "_"));
mkdirSync(scratch, { recursive: true });
const archive = Bun.spawnSync(["git", "archive", base, "packages"]);
if (archive.exitCode !== 0) throw new Error(archive.stderr.toString());
const extracted = Bun.spawnSync(["tar", "-x", "-C", scratch], { stdin: archive.stdout });
if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString());
const bundles: Record<string, string> = {};
for (const [name, directory] of [
  ["base", scratch],
  ["head", root],
] as const) {
  const { reactreCompiler } = await import(join(directory, "packages/compiler/src/index.ts"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "mount-cases.tsx")],
    target: "browser",
    minify: { syntax: true, whitespace: true, identifiers: !profile },
    plugins: [
      reactreCompiler(),
      {
        name: "sources",
        setup(b) {
          b.onResolve({ filter: /^@reactre\/(core|dom)(\/.*)?$/ }, ({ path }) => {
            const parts = path.split("/");
            return {
              path: join(directory, "packages", parts[1]!, "src", (parts.slice(2).join("/") || "index") + ".ts"),
            };
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  bundles[name] = await result.outputs[0]!.text();
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1);
    return path.endsWith(".js")
      ? new Response(bundles[path.slice(0, -3)], { headers: { "Content-Type": "text/javascript" } })
      : new Response(
          `<script type="module">import { exercise } from '/${path}.js'; window.exercise = exercise;</script>`,
          { headers: { "Content-Type": "text/html" } },
        );
  },
});
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--js-flags=--expose-gc"],
});
const results: { iteration: number; side: string; mode: string; operation: string; cycles: number; ms: number }[] = [];
const profiles: unknown[] = [];
try {
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const side of iteration % 2 ? ["head", "base"] : ["base", "head"]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${server.url}${side}`);
      await page.waitForFunction("typeof window.exercise === 'function'");
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      if (profile) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      }
      for (const mode of ["plain", "nested", "text"])
        for (const operation of ["mount-dispose", "switch", "update", "signal"]) {
          await page.evaluate(
            `window.exercise(${JSON.stringify(mode)}, ${JSON.stringify(operation)}, 20); window.gc();`,
          );
          if (profile) await cdp.send("Profiler.start");
          const cycles = 100;
          const ms: unknown = await page.evaluate(
            `window.exercise(${JSON.stringify(mode)}, ${JSON.stringify(operation)}, ${cycles})`,
          );
          if (typeof ms !== "number") throw new Error("invalid measurement");
          results.push({ iteration: iteration + 1, side, mode, operation, cycles, ms });
          if (profile) {
            const { profile: data } = await cdp.send("Profiler.stop");
            const weights = new Map<number, number>();
            data.samples?.forEach((id, i) => weights.set(id, (weights.get(id) ?? 0) + (data.timeDeltas?.[i] ?? 0)));
            profiles.push({
              iteration: iteration + 1,
              side,
              mode,
              operation,
              top: data.nodes
                .map((n) => ({ fn: n.callFrame.functionName, us: weights.get(n.id) ?? 0 }))
                .sort((a, b) => b.us - a.us)
                .slice(0, 12),
            });
          }
        }
      await page.close();
    }
  }
  const summary = ["plain", "nested", "text"].flatMap((mode) =>
    ["mount-dispose", "switch", "update", "signal"].flatMap((operation) =>
      ["base", "head"].map((side) => {
        const times = results
          .filter((r) => r.mode === mode && r.operation === operation && r.side === side)
          .map((r) => r.ms)
          .sort((a, b) => a - b);
        return { mode, operation, side, medianMs: times[1], minMs: times[0], maxMs: times[2] };
      }),
    ),
  );
  await Bun.write(
    output,
    JSON.stringify(
      {
        environment: {
          bun: Bun.version,
          chrome: await browser.version(),
          os: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          throttle: 1,
          viewport: [1280, 800],
          rows: 500,
          warmups: 20,
          base,
          head: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
          dirty: Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString(),
          profiled: profile,
        },
        results,
        summary,
        profiles,
        fixture: readFileSync(join(import.meta.dir, "mount-cases.tsx"), "utf8"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
