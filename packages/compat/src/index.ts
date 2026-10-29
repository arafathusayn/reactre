// @reactre/compat: React's client API, whole. It is @reactre/compat/core with the modules that
// install what core leaves out: class components (./features/classes.ts), component stacks in
// error reports (./features/stacks.ts), React's handling of repeated keys (./features/keys.ts),
// React's retry of a render that throws (./features/retry.ts) and its transition lanes
// (./features/concurrent.ts). @reactre/plugin builds
// narrower entries from the same modules when an app's options switch some of them off.

import "./features/classes.ts";
import "./features/stacks.ts";
import "./features/keys.ts";
import "./features/retry.ts";
import "./features/concurrent.ts";

export * from "./core.ts";
export { default } from "./core.ts";
