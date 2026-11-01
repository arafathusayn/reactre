// A server render that throws, for test/bundlers.test.ts and test/dist.ts: which of compat's
// server entries a build resolves react-dom/server to shows in the message, React's minified code
// from the browser entry and its full text from the server one.

import { renderToReadableStream, renderToString } from "react-dom/server";

// A string where React takes a style object: the mistake whose error is checked.
const Bad = () => <div style="color: red" />;

/** What renderToString throws. */
export function message(): string {
  try {
    renderToString(<Bad />);
  } catch (e) {
    return (e as Error).message;
  }
  return "(nothing thrown)";
}

/** What renderToReadableStream rejects with. */
export function streamMessage(): Promise<string> {
  return renderToReadableStream(<Bad />, { onError() {} }).then(
    () => "(resolved)",
    (e: Error) => e.message,
  );
}
