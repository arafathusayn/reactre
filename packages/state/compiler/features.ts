// The compiler's feature table: every feature's compiler, by the name setup's `use` lists it under
// (the name `@reactre/state/<name>` exports). Each feature writes only ./features/<feature>.ts;
// every feature is listed here already (the not-yet-built ones as stubs).
//
// The order is the order the table's step hooks compose in (`y`): each feature's `step` wraps the
// one before it. nested's is the base (it replaces the flat step), validate's checks an event before
// the step it wraps runs, and effects' records what the steps inside it record.

import type { FeatureCompiler } from "./feature.ts";
import { always } from "./features/always.ts";
import { children } from "./features/children.ts";
import { choice } from "./features/choice.ts";
import { delays } from "./features/delays.ts";
import { durable } from "./features/durable.ts";
import { effects } from "./features/effects.ts";
import { emit } from "./features/emit.ts";
import { history } from "./features/history.ts";
import { inspect } from "./features/inspect.ts";
import { logic } from "./features/logic.ts";
import { nested } from "./features/nested.ts";
import { output } from "./features/output.ts";
import { parallel } from "./features/parallel.ts";
import { persist } from "./features/persist.ts";
import { provide } from "./features/provide.ts";
import { reenter } from "./features/reenter.ts";
import { route } from "./features/route.ts";
import { spawn } from "./features/spawn.ts";
import { system } from "./features/system.ts";
import { tags } from "./features/tags.ts";
import { timeout } from "./features/timeout.ts";
import { validate } from "./features/validate.ts";
import { wildcards } from "./features/wildcards.ts";

export const FEATURES: ReadonlyMap<string, FeatureCompiler> = new Map<string, FeatureCompiler>([
  // Statecharts.
  ["nested", nested],
  ["parallel", parallel],
  ["history", history],
  ["output", output],
  ["choice", choice],
  ["route", route],
  ["always", always],
  ["reenter", reenter],
  ["wildcards", wildcards],
  ["tags", tags],
  // Data.
  ["validate", validate],
  ["persist", persist],
  ["durable", durable],
  // Effects.
  ["effects", effects],
  ["emit", emit],
  ["provide", provide],
  ["delays", delays],
  ["timeout", timeout],
  // Actors.
  ["children", children],
  ["logic", logic],
  ["spawn", spawn],
  ["system", system],
  ["inspect", inspect],
]);
