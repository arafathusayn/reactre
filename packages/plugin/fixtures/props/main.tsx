// A reactre app of several modules for test/bundlers.test.ts, which reads its whole program: the
// components live in ./parts.tsx and ./label.tsx, and only this file, the entry, exports anything
// a caller outside the build may call.

import { render, signal } from "@reactre/core";

import { Label } from "./label.tsx";
import { Count, log, Provider } from "./parts.tsx";

const [count, setCount] = signal(0);

const App = () => (
  <main>
    <Label text="static" />
    <Count n={count()} />
    <Provider>
      <Label text="inside" />
    </Provider>
    <button onClick={() => setCount((n: number) => n + 1)}>add</button>
  </main>
);

export { log };

export function mount(el: Element): void {
  render(App, el);
}
