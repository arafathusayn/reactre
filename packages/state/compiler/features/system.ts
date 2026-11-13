// system's compiler: nothing of its own. A child's `registryKey` is children's to compile (`g`,
// ./children.ts); the opt-in only types it. A system is made by the app (`createSystem`), at runtime.

import type { FeatureCompiler } from "../feature.ts";

export const system: FeatureCompiler = {};
