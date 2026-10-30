// @reactre/full-compat: @reactre/compat with React's time slicing. A transition's render yields to
// the page every 5 ms, so events, timers and paints run between its slices, and an urgent update
// made meanwhile commits first while the transition renders again from the start, as React's
// concurrent render does. The check before each fiber costs on every render, so it lives in this
// package's builds and not in @reactre/compat's.

import "./slicing.ts";
import "@reactre/compat/features/timeSlicing";

export * from "@reactre/compat";
export { default } from "@reactre/compat";
