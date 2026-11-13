// Three paired iterations, alternating order, over the same JSON payload. Run alone:
// bun apps/profiling/state-data.ts > /tmp/state-data.json
import { cpus, platform, release } from "node:os";

import { immutableData } from "../../packages/state/src/data.ts";
import type { DeepReadonly } from "../../packages/state/src/index.ts";

type Data = { title?: string; entries: Record<string, { label: string; tags?: string[] }> };
type Wire = null | boolean | number | string | { kind: "object" | "array"; items: Wire[] };
// The plain-JSON subset of Herdsman's web/src/state/wire.ts at 746020adc19a1367e885cdd9ba9beacf3c4de135.
function pack(value: unknown): Wire {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return { kind: "array", items: value.map(pack) };
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return { kind: "object", items: Object.entries(value).flatMap(([k, v]) => [k, pack(v)]) };
  throw new Error("benchmark accepts plain JSON only");
}
function unpack(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (!("items" in value) || !Array.isArray(value.items) || !("kind" in value)) throw new Error("invalid wire value");
  const items: unknown[] = value.items.map(unpack);
  if (value.kind === "array") return items;
  const entries: [string, unknown][] = [];
  for (let i = 0; i < items.length; i += 2) entries.push([String(items[i]), items[i + 1]]);
  return Object.fromEntries(entries);
}
function freeze(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function encoded(data: Data): { json: string; projection: unknown } {
  const json = JSON.stringify(pack(data));
  return { json, projection: freeze(unpack(JSON.parse(json))) };
}
function structural(data: Data): { value: DeepReadonly<Data> } {
  return { value: immutableData(data) };
}
const payloads: Data[] = [10, 500].map((count) => ({
  entries: Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `entry-${i}`,
      { label: `Item ${i}`, ...(i % 2 ? { tags: ["one", "two"] } : {}) },
    ]),
  ),
}));
const results: {
  count: number;
  iteration: number;
  name: string;
  loops: number;
  ms: number;
  retainedBytes: number;
  serializedBytes: number;
  retainedCount: number;
}[] = [];
for (const data of payloads) {
  const count = Object.keys(data.entries).length;
  const loops = count === 10 ? 2000 : 100;
  for (let warm = 0; warm < 100; warm++) {
    encoded(data);
    structural(data);
  }
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const name of iteration % 2 ? ["structural", "encoded"] : ["encoded", "structural"]) {
      const run = name === "encoded" ? encoded : structural;
      Bun.gc(true);
      const start = performance.now();
      let result: unknown;
      for (let i = 0; i < loops; i++) result = run(data);
      const ms = performance.now() - start;
      // Keep results live while measuring. Heap deltas are retained bytes, not total allocations.
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      const retained: unknown[] = [];
      for (let i = 0; i < 50; i++) retained.push(run(data));
      Bun.gc(true);
      const retainedBytes = process.memoryUsage().heapUsed - before;
      results.push({
        count,
        iteration: iteration + 1,
        name,
        loops,
        ms,
        retainedBytes,
        serializedBytes: JSON.stringify(result).length,
        retainedCount: retained.length,
      });
    }
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1]!;
const summary = [10, 500].flatMap((count) =>
  ["encoded", "structural"].map((name) => {
    const rows = results.filter((r) => r.count === count && r.name === name);
    const times = rows.map((r) => r.ms / r.loops);
    return {
      count,
      name,
      medianMs: median(times),
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      medianRetainedBytes: median(rows.map((r) => r.retainedBytes)),
    };
  }),
);
console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        os: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        revision: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
        dirty: Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString(),
      },
      results,
      summary,
    },
    null,
    2,
  ),
);
