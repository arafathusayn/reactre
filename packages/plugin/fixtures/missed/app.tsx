// What each entry of this fixture renders: Label with a literal, beside the caller module it
// reached, however it reached it.

import { render } from "@reactre/core";

import { Label } from "./label.tsx";

/** The caller module's exports. */
export interface Callers {
  readonly Caller: () => unknown;
  readonly setCount: (n: number) => void;
}

/** Render Label and the caller into `el`; the caller's setter. */
export function show(el: Element, { Caller, setCount }: Callers): (n: number) => void {
  render(
    () => (
      <main>
        <Label text="static" />
        <Caller />
      </main>
    ),
    el,
  );
  return setCount;
}
