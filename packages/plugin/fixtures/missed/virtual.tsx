// The caller reached only through a virtual module, which the test's own plugin serves.

import * as callers from "virtual:callers";

import { type Callers, show } from "./app.tsx";

export async function mount(el: Element): Promise<(n: number) => void> {
  return show(el, callers as Callers);
}
