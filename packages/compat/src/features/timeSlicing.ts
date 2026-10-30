// @reactre/compat/features/timeSlicing: React's time slicing. A transition's render yields to the
// page every 5 ms, so timers, events and paints run between its slices, and an urgent update
// made meanwhile commits first and the transition renders again from the start, as React's
// concurrent render does. @reactre/full-compat loads it; @reactre/compat cannot, as its builds
// leave slicing out.
//
// Design decisions:
//   - Compat writes the DOM while it renders, so a slice ends by undoing what it wrote (the
//     transition's undo machinery, see attempt in core.ts) and the next one starts by making it
//     again: between slices, the page shows and holds the last commit, as React's does.
//   - The check before each fiber costs on every render, so it is compiled in only where the
//     build defines globalThis.__REACTRE_SLICING__ true (@reactre/full-compat): @reactre/compat's
//     builds compile it out, at the same minified size.

import { slicing } from "../slicing.ts";

slicing.on = true;
