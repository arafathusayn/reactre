// emit's compiler: the `emit` effect's runner joins the dispatcher (`effects.d([effects.q, emit.q])`)
// of a machine that records effects; `enq.emit` itself comes from effects's `enq` (`effects.w([emit])`,
// ./effects.ts). Setup's `emitted` is types only: the compiler drops it with the setup call. Nothing
// to check that types can't.

import type { FeatureCompiler } from "../feature.ts";
import { recorded } from "./effects.ts";

export const emit: FeatureCompiler = {
  shape: () => ({
    machine: ({ local }) => ({ emit: () => (recorded() ? { effects: [`${local}.q`] } : {}) }),
  }),
};
