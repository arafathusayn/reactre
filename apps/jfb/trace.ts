// The duration of one measured click, from a Chrome trace.
//
// A port of computeResultsCPU and extractRelevantEvents in js-framework-benchmark's
// webdriver-ts/src/timeline.ts (krausest/js-framework-benchmark, ca8715d). The duration runs from
// the start of the click's event dispatch to the end of the first compositor commit after the
// last script, timer, animation frame or layout event that follows the click, all on the click's
// process.
//
// Ramda is replaced by array methods; the logic, filters and the rAF delay correction are kept.
// The port stays this close so the replica's numbers are the official runner's numbers, not an
// approximation of them: any deviation here would rank entries differently from the published
// results table.

// #region Event model

/** The event kinds the official computation looks at; every other trace event is dropped. */
type Kind =
  | "startLogicEvent"
  | "click"
  | "mousedown"
  | "pointerup"
  | "layout"
  | "functioncall"
  | "hittest"
  | "commit"
  | "paint"
  | "fireAnimationFrame"
  | "timerFire"
  | "requestAnimationFrame";

/** One relevant event, reduced to its kind, its time span (microseconds) and its process. */
interface Timing {
  type: Kind;
  ts: number;
  dur: number;
  end: number;
  pid: number;
}

/** The fields of a Chrome trace event that this computation reads. */
interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  args?: { data?: { type?: string } };
}

/**
 * The result of one measured click, with the same fields the official runner computes. Only
 * `duration` feeds the score; the rest helps explain an unusual sample.
 */
export interface Duration {
  /** Milliseconds, click dispatch start to the commit's end, less any rAF delay correction. */
  duration: number;
  /** Trace microseconds: the click's dispatch start. */
  tsStart: number;
  /** Trace microseconds: the end of the commit that closes the window. */
  tsEnd: number;
  /** Layout events on the click's process after the click. */
  layouts: number;
  /** Commit events on the click's process after the click. */
  numberCommits: number;
  /** Milliseconds from the first to the last of those commits. */
  maxDeltaBetweenCommits: number;
  /** Milliseconds subtracted from `duration` by the rAF delay correction (0 when it did not apply). */
  rafLongDelay: number;
  /** Whether a commit on another process was left out. */
  droppedNonMainProcessCommitEvents: boolean;
  /** Whether any other event on another process was left out. */
  droppedNonMainProcessOtherEvents: boolean;
}

/** Thrown when the trace holds no single click; the official runner repeats the run. */
export class NotOneClick extends Error {}

// #endregion

// #region Computation

/** An event's duration in microseconds; instant events have none. */
const durationOf = (e: TraceEvent) => +(e.dur ?? 0);

/**
 * The trace's events that the official computation uses, as `Timing`s. Most kinds need a
 * complete event (`ph` "X"), which carries a duration. TimerFire's duration is forced to 0 as the
 * official code does, so a long timer callback marks a point in time rather than a span.
 */
function relevantEvents(entries: TraceEvent[], startLogicEvent: string): Timing[] {
  const out: Timing[] = [];
  const push = (type: Kind, e: TraceEvent, dur = durationOf(e)) =>
    out.push({ type, ts: +e.ts, dur, end: +e.ts + dur, pid: e.pid });
  for (const e of entries) {
    if (e.name === "EventDispatch") {
      // A dispatch can be both the start event and a click (the default start event is "click"),
      // so the first check is not part of the else-if chain.
      const t = e.args?.data?.type;
      if (t === startLogicEvent) push("startLogicEvent", e);
      if (t === "click") push("click", e);
      else if (t === "mousedown") push("mousedown", e);
      else if (t === "pointerup") push("pointerup", e);
    } else if (e.name === "Layout" && e.ph === "X") push("layout", e);
    else if (e.name === "FunctionCall" && e.ph === "X") push("functioncall", e);
    else if (e.name === "HitTest" && e.ph === "X") push("hittest", e);
    else if (e.name === "Commit" && e.ph === "X") push("commit", e);
    else if (e.name === "Paint" && e.ph === "X") push("paint", e);
    else if (e.name === "FireAnimationFrame" && e.ph === "X") push("fireAnimationFrame", e);
    else if (e.name === "TimerFire" && e.ph === "X") push("timerFire", e, 0);
    else if (e.name === "RequestAnimationFrame") push("requestAnimationFrame", e, 0);
  }
  return out;
}

/** A filter that keeps events of any of the given kinds. */
const ofType =
  (...types: string[]) =>
  (e: Timing) =>
    types.includes(e.type);

/**
 * The official duration of the one click in `entries`.
 *
 * @param entries The trace's events, as Chrome's tracing writes them.
 * @param startLogicEventName The DOM event that starts the window; the official runner uses
 *   "click" for every CPU test.
 * @throws NotOneClick when the trace holds no click or more than one, which the caller retries.
 * @throws Error for any other malformed trace, which the official runner also treats as fatal.
 */
export function computeDuration(entries: TraceEvent[], startLogicEventName = "click"): Duration {
  // Stable sort by end, as R.sortBy. Ties keep trace order, which decides which of two commits
  // ending together is "first" below.
  const events = relevantEvents(entries, startLogicEventName).sort((a, b) => a.end - b.end);

  const mousedowns = events.filter(ofType("mousedown"));
  if (mousedowns.length > 1) throw new Error("at most one mousedown event is expected");

  const clicks = events.filter(ofType("startLogicEvent"));
  if (clicks.length !== 1) throw new NotOneClick(`exactly one click event is expected, got ${clicks.length}`);
  const click = clicks[0]!;

  // Only events after the click's dispatch, on the click's process. Other processes (the GPU
  // process, other renderers) do not run the app's work; the dropped flags record that they had
  // events, as the official result does.
  const pid = click.pid;
  const during = events.filter((e) => e.ts > click.end || e.type === "click");
  const onMain = during.filter((e) => e.pid === pid);
  const dropped = events.filter((e) => e.pid !== pid);
  const droppedNonMainProcessCommitEvents = onMain.length !== during.length && dropped.some((e) => e.type === "commit");
  const droppedNonMainProcessOtherEvents = onMain.length !== during.length && dropped.some((e) => e.type !== "commit");

  // The commit after the last script, timer, rAF or layout event. That commit is when the click's
  // result reaches the screen. When no commit follows that event, the last commit stands in, as
  // the official code does.
  const startFromEvent = onMain
    .filter(ofType(startLogicEventName, "fireAnimationFrame", "timerFire", "layout", "functioncall"))
    .at(-1);
  if (!startFromEvent) throw new Error("no events after the click");
  const commits = onMain.filter(ofType("commit"));
  let commit = commits.find((e) => e.ts > startFromEvent.end);
  if (!commit) {
    if (commits.length === 0) throw new Error("no commit event after the click");
    commit = commits.at(-1)!;
  }
  const maxDeltaBetweenCommits = (commits.at(-1)!.ts - commits[0]!.ts) / 1000;
  let duration = (commit.end - click.ts) / 1000;
  const layouts = onMain.filter(ofType("layout"));

  // The official correction for a long wait between a requested and a fired animation frame.
  // An app that defers work to requestAnimationFrame can wait for the next frame through no fault
  // of its own; time beyond one 16 ms frame is subtracted, unless a layout ran before the frame
  // fired (then the wait was not idle). Several requests with one fired frame is a trace the
  // official code rejects.
  const rafsWithinClick = events.filter(
    (e) => e.type === "requestAnimationFrame" && e.ts >= click.ts && e.ts <= click.end,
  );
  const fafs = events.filter((e) => e.type === "fireAnimationFrame" && e.ts >= click.ts && e.ts < commit.ts);
  let rafLongDelay = 0;
  if (rafsWithinClick.length > 0 && fafs.length > 0) {
    const waitDelay = (fafs[0]!.ts - click.end) / 1000;
    if (rafsWithinClick.length === 1 && fafs.length === 1) {
      if (waitDelay > 16 && !layouts.some((e) => e.ts < fafs[0]!.ts)) {
        rafLongDelay = waitDelay - 16;
        duration -= rafLongDelay;
      }
    } else if (fafs.length === 1) {
      throw new Error("one fired animation frame, but inconsistent requested animation frames");
    }
  }

  return {
    duration,
    tsStart: click.ts,
    tsEnd: commit.end,
    layouts: layouts.length,
    numberCommits: commits.length,
    maxDeltaBetweenCommits,
    rafLongDelay,
    droppedNonMainProcessCommitEvents,
    droppedNonMainProcessOtherEvents,
  };
}

// #endregion
