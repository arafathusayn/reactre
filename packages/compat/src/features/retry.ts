// @reactre/compat/features/retry: React's retry of a render that throws. Loading this module
// installs it into @reactre/compat/core; @reactre/compat loads it, and @reactre/plugin's generated
// entry loads it while the `renderRetry` key is on. Without it, an error a render throws counts at
// once: it goes to the nearest error boundary or the root, and nothing is reported as recoverable.
//
// Design decisions:
//   - The code stays in the core, beside the render loop whose internals it uses (the commit
//     queues, the host being rendered, a fiber's render); a core build that never loads this
//     module leaves it out, as nothing else reaches it.
//   - The render loop reaches it only in its catch blocks: a render that does not throw does no
//     extra work.

import { __installRetry } from "../core.ts";

__installRetry();
