// bun apps/profiling/propagation-compare.ts <base-revision> <output.json> [--profile] [--rounds=N]
// Same fixture on each side, alternating order, fresh pages. Profiles never supply timing claims.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

import { findChrome } from "../jfb/chrome.ts";
import type { dom, exercise } from "./propagation-cases.tsx";

const base = process.argv[2] ?? "origin/main";
const output = resolve(process.argv[3] ?? "/tmp/propagation.json");
const profile = process.argv.includes("--profile");
const control = process.argv.includes("--control");
const rounds = Number(process.argv.find((s) => s.startsWith("--rounds="))?.split("=")[1] ?? 8);
const root = resolve(import.meta.dir, "../..");
const scratch = join(import.meta.dir, ".cache/propagation", base.replace(/[^a-zA-Z0-9]/g, "_"));
mkdirSync(scratch, { recursive: true });
function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: root });
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout;
}
const extracted = Bun.spawnSync(["tar", "-x", "-C", scratch], { stdin: git("archive", base, "packages") });
if (extracted.exitCode) throw new Error(extracted.stderr.toString());
const stateModules = join(scratch, "packages/state/node_modules");
if (!existsSync(stateModules)) symlinkSync(join(root, "packages/state/node_modules"), stateModules);
const bundles: Record<string, string> = {};
for (const [side, directory] of [
  ["base", scratch],
  ["head", control ? scratch : root],
] as const) {
  const { reactreCompiler } = await import(join(directory, "packages/compiler/src/index.ts"));
  const { compile } = await import(join(directory, "packages/state/compiler/index.ts"));
  const exports = JSON.parse(readFileSync(join(directory, "packages/state/package.json"), "utf8")).exports;
  const resolveSource = (spec: string, importer: string): string | null => {
    const parts = /^@reactre\/(core|dom|state)(?:\/(.*))?$/.exec(spec);
    if (parts) {
      const entry =
        parts[1] === "state"
          ? (exports[parts[2] ? `./${parts[2]}` : "."]?.["reactre-source"] ?? `./src/${parts[2]}.ts`)
          : `src/${parts[2] ?? "index"}.ts`;
      return join(directory, "packages", parts[1]!, entry);
    }
    try {
      return Bun.resolveSync(spec, dirname(importer));
    } catch {
      return null;
    }
  };
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "propagation-cases.tsx")],
    target: "browser",
    minify: { syntax: true, whitespace: false, identifiers: !profile },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "sources-and-machines",
        setup(b) {
          b.onResolve({ filter: /^@reactre\// }, ({ path, importer }) => ({ path: resolveSource(path, importer)! }));
          b.onLoad({ filter: /\.machine\.ts$/ }, async ({ path }) => ({
            contents: compile(path, await Bun.file(path).text(), { dev: false }).code,
            loader: "ts",
          }));
        },
      },
      reactreCompiler({ filter: /propagation-cases\.tsx$/, analysis: { resolve: resolveSource, strict: true } }),
    ],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundles[side] = await built.outputs[0]!.text();
  await Bun.write(`${output}.${side}.js`, bundles[side]!);
}
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1);
    return path.endsWith(".js")
      ? new Response(bundles[path.slice(0, -3)], { headers: { ...headers, "Content-Type": "text/javascript" } })
      : new Response(`<script type="module">import * as bench from '/${path}.js'; window.bench=bench;</script>`, {
          headers: { ...headers, "Content-Type": "text/html" },
        });
  },
});
interface Bench {
  exercise: typeof exercise;
  dom: typeof dom;
}
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--js-flags=--expose-gc"],
});
const results: unknown[] = [];
const profiles: unknown[] = [];
try {
  for (let iteration = 0; iteration < rounds; iteration++) {
    for (const side of iteration % 2 ? ["head", "base"] : ["base", "head"]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${server.url}${side}`);
      await page.waitForFunction("!!window.bench");
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.send("Performance.enable");
      if (profile) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      }
      for (const kind of ["micro", "dom"] as const) {
        const modes =
          kind === "micro"
            ? ([
                "signal",
                "actor",
                "subscribers",
                "bridge",
                "memo",
                "selection",
                "selected-bridge",
                "payload-bridge",
              ] as const)
            : (["signal", "bridge", "memo", "selected-bridge"] as const);
        for (const mode of modes)
          for (const workload of ["unchanged", "equal", "changed", "burst", "reentrant"] as const) {
            if (kind === "dom" && workload === "reentrant") continue;
            const count = kind === "micro" ? 50000 : 200;
            const run = async (n: number) =>
              page.evaluate(
                (kind, mode, workload, count) => {
                  const b = (globalThis as unknown as { bench: Bench }).bench;
                  return kind === "micro"
                    ? b.exercise(mode, workload, count)
                    : b.dom(mode as Parameters<typeof dom>[0], workload, count);
                },
                kind,
                mode,
                workload,
                n,
              );
            for (let warm = 0; warm < 3; warm++) await run(kind === "micro" ? 10000 : 20);
            await cdp.send("HeapProfiler.collectGarbage");
            const before = await cdp.send("Runtime.getHeapUsage");
            if (profile) {
              await cdp.send("Profiler.start");
              await cdp.send("HeapProfiler.startSampling", {
                samplingInterval: 16384,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const value = await run(count);
            const after = await cdp.send("Runtime.getHeapUsage");
            if (profile) {
              const cpu = (await cdp.send("Profiler.stop")).profile;
              const allocation = (await cdp.send("HeapProfiler.stopSampling")).profile;
              const weights = new Map<number, number>();
              cpu.samples?.forEach((id, i) => weights.set(id, (weights.get(id) ?? 0) + (cpu.timeDeltas?.[i] ?? 0)));
              profiles.push({
                iteration,
                side,
                kind,
                mode,
                workload,
                cpuProfile: cpu,
                gcSampleUs: cpu.nodes
                  .filter((n) => n.callFrame.functionName === "(garbage collector)")
                  .reduce((sum, n) => sum + (weights.get(n.id) ?? 0), 0),
                top: cpu.nodes
                  .map((n) => ({ fn: n.callFrame.functionName, us: weights.get(n.id) ?? 0 }))
                  .sort((a, b) => b.us - a.us)
                  .slice(0, 15),
                sampledAllocationBytes: allocation.samples.reduce((sum, s) => sum + s.size, 0),
                allocationHead: allocation.head,
              });
            }
            await cdp.send("HeapProfiler.collectGarbage");
            const retained = await cdp.send("Runtime.getHeapUsage");
            results.push({
              iteration,
              side,
              kind,
              mode,
              workload,
              count,
              ...value,
              usedHeapDelta: after.usedSize - before.usedSize,
              retainedHeapDelta: retained.usedSize - before.usedSize,
            });
          }
      }
      await page.close();
      console.log(`iteration ${iteration + 1}/${rounds}: ${side}`);
    }
  }
  await Bun.write(
    output,
    JSON.stringify(
      {
        environment: {
          bun: Bun.version,
          chrome: await browser.version(),
          cpu: cpus()[0]?.model,
          os: platform(),
          release: release(),
          viewport: [1280, 800],
          throttle: 1,
          rounds,
          base: git("rev-parse", base).toString().trim(),
          head: git("rev-parse", "HEAD").toString().trim(),
          dirty: git("status", "--porcelain").toString(),
          profile,
          control,
          hashes: Object.fromEntries(
            Object.entries(bundles).map(([k, v]) => [k, createHash("sha256").update(v).digest("hex")]),
          ),
        },
        results,
        profiles,
        fixture: readFileSync(join(import.meta.dir, "propagation-cases.tsx"), "utf8"),
        machine: readFileSync(join(import.meta.dir, "propagation.machine.ts"), "utf8"),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.stop(true);
}
