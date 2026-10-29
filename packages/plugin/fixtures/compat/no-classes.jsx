// A React app for test/bundlers.test.ts, built with class support off (compat.classes: false):
// errors still carry React's component stack, and a class that renders throws a clear error.

import { Component } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

function Boom() {
  throw new Error("boom");
}

class Legacy extends Component {
  render() {
    return <p>legacy</p>;
  }
}

/** What an uncaught error in `<section><Boom /></section>` is reported with, and Legacy's error. */
export function reports(el) {
  const out = [];
  const root = createRoot(el, { onUncaughtError: (e, info) => out.push(e.message, info.componentStack) });
  flushSync(() =>
    root.render(
      <section>
        <Boom />
      </section>,
    ),
  );
  flushSync(() => root.render(<Legacy />));
  return out;
}
