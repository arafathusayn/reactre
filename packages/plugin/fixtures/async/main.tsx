// A reactre app for test/bundlers.test.ts that imports @reactre/core/features/async: the plugin
// gives it @reactre/core's async runtime.

import { render } from "@reactre/core";
import { Loading, memo } from "@reactre/core/features/async";

let settle!: (v: string) => void;
const word = memo(() => new Promise<string>((ok) => (settle = ok)));

export function mount(el: Element): void {
  render(
    () => (
      <p>
        <Loading fallback="wait">
          <b>{word()}</b>
        </Loading>
      </p>
    ),
    el,
  );
}

export const resolve = (v: string): void => settle(v);
