// Every feature's compiler cases, by feature, for test/compiler.test.ts. Each feature owns its
// ./<feature>/compiler.ts; this list names them all already, so adding a case edits only that file.

import type { Case } from "../sources.ts";
import { cases as always } from "./always/compiler.ts";
import { cases as children } from "./children/compiler.ts";
import { cases as choice } from "./choice/compiler.ts";
import { cases as delays } from "./delays/compiler.ts";
import { cases as durable } from "./durable/compiler.ts";
import { cases as effects } from "./effects/compiler.ts";
import { cases as emit } from "./emit/compiler.ts";
import { cases as history } from "./history/compiler.ts";
import { cases as inspect } from "./inspect/compiler.ts";
import { cases as logic } from "./logic/compiler.ts";
import { cases as nested } from "./nested/compiler.ts";
import { cases as output } from "./output/compiler.ts";
import { cases as parallel } from "./parallel/compiler.ts";
import { cases as persist } from "./persist/compiler.ts";
import { cases as provide } from "./provide/compiler.ts";
import { cases as reenter } from "./reenter/compiler.ts";
import { cases as route } from "./route/compiler.ts";
import { cases as spawn } from "./spawn/compiler.ts";
import { cases as system } from "./system/compiler.ts";
import { cases as tags } from "./tags/compiler.ts";
import { cases as timeout } from "./timeout/compiler.ts";
import { cases as validate } from "./validate/compiler.ts";
import { cases as wildcards } from "./wildcards/compiler.ts";

export const featureCases: { readonly [feature: string]: readonly Case[] } = {
  always,
  children,
  choice,
  delays,
  durable,
  effects,
  emit,
  history,
  inspect,
  logic,
  nested,
  output,
  parallel,
  persist,
  provide,
  reenter,
  route,
  spawn,
  system,
  tags,
  timeout,
  validate,
  wildcards,
};
