// The component test/refresh.test.ts edits while Vite's dev server runs: it rewrites the text, then
// the hook, and checks the page in Chrome after each edit.

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button id="count" onClick={() => setCount((n) => n + 1)}>
      before: {count}
    </button>
  );
}
