// @reactre/compat/features/concurrent: React's transition lanes. Loading this module installs them
// into @reactre/compat/core; @reactre/compat loads it, and @reactre/plugin's generated entry loads
// it while the `concurrentRendering` key is on. Without it, a transition renders at once, as any
// update: isPending never shows for one that does not await, and an update that suspends shows
// its boundary's fallback.
//
// Design decisions (plans/compat-concurrent.md):
//   - A transition's updates wait in a batch (the transitions of one event) and render in a task
//     of their own, after urgent ones, replayed in order from the state before them.
//   - A batch renders on the live tree, where it can be undone: its roots' fibers are saved, a
//     MutationObserver records its DOM changes, and the effects and cleanups it would run wait.
//     If it suspends where content showed, all of it is put back and it waits for the data.
//   - The code stays in the core, beside the render loop whose internals it uses; a state setter
//     and safely() test a variable each, and a core build that never loads this module leaves
//     the rest out.

import { __installConcurrent } from "../core.ts";

__installConcurrent();
