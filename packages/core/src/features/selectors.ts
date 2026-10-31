// @reactre/core/features/selectors: <For> rows that read more than one selector key (two
// selectors, or one selector with two keys). Loading this module installs it into
// @reactre/core. @reactre/compiler imports it for a row whose reactive holes make two or more
// calls with arguments; import it yourself when a row reads several keys through a function of
// its own. Without it, a row's second key throws, naming this module.
//
// Design decisions:
//   - The code stays in the core, beside the list whose rows it scans; a bundle that never loads
//     this module leaves it out, as nothing else reaches it.
//   - It installs by a call, not as a side effect of the core's own loading, so a build that
//     does not bundle (a dev server) behaves as the bundle does.

import { __installSelectors } from "@reactre/core";

__installSelectors();
