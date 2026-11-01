// The caller reached through Vite's `import.meta.glob`: modules chosen by a pattern.

import { type Callers, show } from "./app.tsx";

const callers = import.meta.glob<Callers>("./hidden/caller.tsx", { eager: true });

export async function mount(el: Element): Promise<(n: number) => void> {
  return show(el, Object.values(callers)[0]!);
}
