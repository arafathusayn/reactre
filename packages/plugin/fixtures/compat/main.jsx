// A React app for test/bundlers.test.ts: a class component, hooks and a TSX
// module, with react and react-dom resolved to @reactre/compat by the plugin.

import { Component, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { Count } from "./count.tsx";

class Title extends Component {
  render() {
    return <h1 className="title">{this.props.text}</h1>;
  }
}

function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <Title text="reactre" />
      <Count value={count} />
      <button onClick={() => setCount((n) => n + 1)}>add</button>
    </main>
  );
}

export function mount(el) {
  const root = createRoot(el);
  flushSync(() => root.render(<App />));
  return root;
}
