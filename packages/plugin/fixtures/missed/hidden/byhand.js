// Label called by hand, with no JSX: `text` passed reactively as a getter, from a JavaScript
// module the plugin does not compile.

import { render, signal } from "@reactre/core";

import { Label } from "../label.tsx";

const [count, setCount] = signal(0);

export function mount(el) {
  render(
    () =>
      Label({
        get text() {
          return count();
        },
      }),
    el,
  );
  return setCount;
}
