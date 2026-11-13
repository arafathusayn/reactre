// emit's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each to
// "no case is a type error").
//
// None: compiler/features/emit.ts reports nothing of its own. `enq.emit(event)` is an effect like
// the others, so what it can get wrong the types see (an undeclared event, a payload's shape: see
// ./mistakes.ts), and its argument's purity is effects's case (../effects/compiler.ts).

import type { Case } from "../../sources.ts";

export const cases: Case[] = [];
