// inspect's compiler: a machine of a shape with `use: [inspect]` gets the step that reports events
// (`y: inspect.y(inner)`, outermost, so it reports what the whole step did) and the lifecycle that
// reports moves (`r: inspect.w(inner)`), around whatever lifecycle it has (none: a plain machine).
//
// Nothing to check that types can't: `inspect` and `logger` are actor options, typed by
// `ActorOptions` (../../src/features/inspect/types.ts).

import type { FeatureCompiler } from "../feature.ts";

export const inspect: FeatureCompiler = {
  shape: () => ({
    machine: ({ local }) => ({
      emit: () => ({
        step: (inner) => `${local}.y(${inner ?? ""})`,
        wrap: (r) => `${local}.w(${r ?? ""})`,
      }),
    }),
  }),
};
