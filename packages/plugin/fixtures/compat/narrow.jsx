// A React app for test/bundlers.test.ts, built with APIs switched off (compat.exclude): it uses
// only what stays on, and reads a switched-off API the way no scan can see, by a computed name.

import React, { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>{`Clicked ${count}`}</button>;
}

export function mount(el) {
  const root = createRoot(el);
  flushSync(() => root.render(<Counter />));
}

/** A switched-off API, as a library that checks for it at run time would read it. */
export const offByName = (name) => React[name];
