// provide's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error").
//
// None: compiler/features/provide.ts reports nothing of its own. Setup's actions and guards are
// kept as written (an action runs as an effect, after the transition; a guard is called in the
// handler, whose purity the core checks), and every mistake with them is a type error
// (./mistakes.ts).

import type { Case } from "../../sources.ts";

export const cases: Case[] = [];
