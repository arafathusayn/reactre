// @reactre/full-compat/core: @reactre/compat/core with React's time slicing (see ./index.ts).
// @reactre/plugin builds an app's narrower entry on it, with the feature modules of what is on.

import "./slicing.ts";
import "@reactre/compat/features/timeSlicing";

export * from "@reactre/compat/core";
export { default } from "@reactre/compat/core";
