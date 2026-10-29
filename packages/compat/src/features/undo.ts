// @reactre/compat/features/undo: React's handling of an urgent render that suspends with no
// Suspense boundary above: the screen stays as it was. Loading this module installs it into
// @reactre/compat/core; @reactre/compat loads it, and @reactre/plugin's generated entry loads it
// while the `renderUndo` key is on. Without it, compat commits what rendered.
//
// Design decisions:
//   - Before each urgent render, the subtrees of the fibers it renders are saved and their roots'
//     DOM watched: the cost follows the update, not the tree, and only builds that load this
//     module pay it.
//   - The core reaches it only on rare paths (a promise that reaches a root, the mutation phase's
//     held work) and through the beforeRender slot the flush already tests.

import { __installUndo } from "../core.ts";

__installUndo();
