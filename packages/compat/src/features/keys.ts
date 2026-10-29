// @reactre/compat/features/keys: React's handling of a list whose keys repeat. Loading this module
// installs it into @reactre/compat/core; @reactre/compat loads it, and @reactre/plugin's generated
// entry loads it while the `repeatedKeys` key is on. Without it, repeated keys are reconciled by
// compat's own rules.
//
// Design decisions:
//   - The algorithm stays in the core, beside the reconciler whose internals it uses; a core
//     build that never loads this module leaves it out, as nothing else reaches it.
//   - The reconciler reaches it only where a key map holds fewer keys than old rows, which is
//     where a key repeats: lists with unique keys do no extra work.

import { __installKeys } from "../core.ts";

__installKeys();
