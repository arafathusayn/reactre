// The caller reached only through a file of a type no bundler reads as code, which the test's
// own plugin turns into a module that re-exports it.

import { type Callers, show } from "./app.tsx";
import * as callers from "./list.callers";

export async function mount(el: Element): Promise<(n: number) => void> {
  return show(el, callers as Callers);
}
