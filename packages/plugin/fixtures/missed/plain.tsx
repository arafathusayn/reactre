// The caller reached through a plain JavaScript module that re-exports it: a script, which the
// program reads, so it sees the caller. test/missed.test.ts writes ./reexport.js beside a copy of
// this fixture.

import { type Callers, show } from "./app.tsx";
import * as callers from "./reexport.js";

export async function mount(el: Element): Promise<(n: number) => void> {
  return show(el, callers as Callers);
}
