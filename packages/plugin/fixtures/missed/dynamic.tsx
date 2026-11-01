// The caller reached through `import(expr)`, a path the program cannot read. Each bundler
// includes what the pattern matches (webpack in this chunk, by its comment).

import { type Callers, show } from "./app.tsx";

const name = ["call", "er"].join("");

export async function mount(el: Element): Promise<(n: number) => void> {
  const callers = (await import(/* webpackMode: "eager" */ `./hidden/${name}.tsx`)) as Callers;
  return show(el, callers);
}
