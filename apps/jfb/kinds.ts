// Splits the official click window's main-thread time by kind (script, style, layout, paint,
// gc), from the same Chrome trace that trace.ts measures.
//
// The official runner reports one duration per click. This split shows where that time goes, so
// a change can be judged by the kind of work it saves, not only by the total.

/**
 * Main-thread time in [from, to] by kind, in milliseconds.
 *
 * Each kind's time is the union of its event spans, not their sum: trace events of one kind nest
 * (a FunctionCall inside an EventDispatch, both script), and a sum would count the nested time
 * twice. Spans are clipped to the window first. Different kinds can still overlap (a GC inside a
 * script call counts toward both), so the kinds need not add up to the window.
 *
 * @param events The trace's events; `ts` and `dur` are in microseconds.
 * @param from Window start in trace microseconds, usually the click's dispatch start.
 * @param to Window end in trace microseconds, usually the end of the measured commit.
 * @returns Milliseconds per kind; every kind is present, zero when it has no events.
 */
export function byKind(
  events: { name: string; ph: string; ts: number; dur?: number; tid: number }[],
  from: number,
  to: number,
): Record<string, number> {
  // Trace event names mapped to the kind they count toward. Names not listed are ignored.
  const KIND: Record<string, string> = {
    FunctionCall: "script",
    EventDispatch: "script",
    "v8.callFunction": "script",
    RunMicrotasks: "script",
    TimerFire: "script",
    FireAnimationFrame: "script",
    UpdateLayoutTree: "style",
    Layout: "layout",
    PrePaint: "paint",
    Paint: "paint",
    Layerize: "paint",
    Commit: "paint",
    MajorGC: "gc",
    MinorGC: "gc",
    "V8.GC_SCAVENGER": "gc",
    "BlinkGC.AtomicPhase": "gc",
  };
  // The main thread is the one that dispatched the click; compositor and worker threads run in
  // parallel and would inflate the totals.
  const main = events.find((e) => e.name === "EventDispatch")?.tid;
  const spans: Record<string, [number, number][]> = {};
  for (const e of events) {
    const k = KIND[e.name];
    if (k === undefined || e.ph !== "X" || e.tid !== main) continue;
    const a = Math.max(e.ts, from),
      b = Math.min(e.ts + (e.dur ?? 0), to);
    if (b > a) (spans[k] ??= []).push([a, b]);
  }
  const out: Record<string, number> = { script: 0, style: 0, layout: 0, paint: 0, gc: 0 };
  // Merge each kind's spans in start order; `end` is the furthest point already counted, so
  // overlapping spans add only their uncovered tail.
  for (const [k, xs] of Object.entries(spans)) {
    xs.sort((x, y) => x[0] - y[0]);
    let end = -Infinity;
    for (const [a, b] of xs) {
      if (b <= end) continue;
      out[k]! += (b - Math.max(a, end)) / 1000;
      end = b;
    }
  }
  return out;
}
