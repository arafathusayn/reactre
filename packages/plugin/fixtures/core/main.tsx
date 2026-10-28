// A reactre app for test/bundlers.test.ts: TSX over signals, compiled by the plugin.

import { render, signal } from "@reactre/core";

const [count, setCount] = signal(0);

const Counter = () => (
  <button class="counter" onClick={() => setCount((n: number) => n + 1)}>
    Clicked {count()} times
  </button>
);

export function mount(el: Element): void {
  render(Counter, el);
}
