// A React app rendered on the server for test/bundlers.test.ts: react-dom/server resolves to
// @reactre/compat/server, and the app's host trees are compiled templates.

import { Component, Suspense, useId, useState } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";

import { Count } from "./count.tsx";

class Title extends Component {
  render() {
    return <h1 className="title">{this.props.text}</h1>;
  }
}

function App() {
  const [count] = useState(2);
  const id = useId();
  return (
    <main id={id}>
      <Title text="reactre" />
      <Suspense fallback={<p>loading</p>}>
        <Count value={count} />
      </Suspense>
      <label htmlFor={id}>
        {count} items, {"<escaped>"}
      </label>
    </main>
  );
}

export const html = () => renderToString(<App />);

export async function stream() {
  const s = await renderToReadableStream(<App />);
  await s.allReady;
  return new Response(s).text();
}
