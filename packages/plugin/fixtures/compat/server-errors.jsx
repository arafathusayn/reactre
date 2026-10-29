// A server render that throws, for test/bundlers.test.ts and test/node.mjs: which of compat's
// server entries a build resolves react-dom/server to shows in the message, React's minified code
// from the browser entry and its full text from the Node one.

import { renderToReadableStream, renderToString } from "react-dom/server";

const Bad = () => <div style="color: red" />;

/** What renderToString throws. */
export function message() {
  try {
    renderToString(<Bad />);
  } catch (e) {
    return e.message;
  }
  return "(nothing thrown)";
}

/** What renderToReadableStream rejects with. */
export function streamMessage() {
  return renderToReadableStream(<Bad />, { onError() {} }).then(
    () => "(resolved)",
    (e) => e.message,
  );
}
