// The entry of a build to which the test's own plugin adds ./hidden/caller.tsx as a chunk of its
// own, which the program read from the entries does not hold: it joins when it is transformed.

import { render } from "@reactre/core";

import { Label } from "./label.tsx";

export function mount(el: Element): void {
  render(() => <Label text="static" />, el);
}
