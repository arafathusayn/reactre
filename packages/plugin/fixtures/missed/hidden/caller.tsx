// Label's one reactive caller: it passes `text={count()}`.

import { render, signal } from "@reactre/core";

import { Label } from "../label.tsx";

const [count, setCount] = signal(0);

export { setCount };

export const Caller = () => <Label text={count()} />;

/** Render the caller alone, for a build where it is an entry of its own. */
export function mount(el: Element): (n: number) => void {
  render(
    () => (
      <main>
        <Caller />
      </main>
    ),
    el,
  );
  return setCount;
}
