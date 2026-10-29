// @reactre/compat/server.browser: @reactre/compat/server as React's browser builds
// (react-dom/server.browser and react-dom/static.browser), which throw React's minified production
// codes (`Minified React error #31; visit https://react.dev/errors/31?args[]=…`) where its Node
// build throws full messages. A bundle for the browser or a web worker resolves
// @reactre/compat/server here through the "browser" and "worker" export conditions, as it resolves
// react-dom/server to React's browser build. Everything else is ./server.ts's: see its notes.
//
// The whole API is exported, the Node stream functions included (React's browser builds have
// none), so an import that resolves through one entry resolves through every one.

import ServerDefault, * as Server from "./server.ts";
import { __minified } from "./server.ts";

export type * from "./server.ts";
export { version } from "./server.ts";

export const renderToString: typeof Server.renderToString = /* @__PURE__ */ __minified(Server.renderToString);
export const renderToStaticMarkup: typeof Server.renderToStaticMarkup = /* @__PURE__ */ __minified(
  Server.renderToStaticMarkup,
);
export const renderToReadableStream: typeof Server.renderToReadableStream = /* @__PURE__ */ __minified(
  Server.renderToReadableStream,
);
export const renderToPipeableStream: typeof Server.renderToPipeableStream = /* @__PURE__ */ __minified(
  Server.renderToPipeableStream,
);
export const resume: typeof Server.resume = /* @__PURE__ */ __minified(Server.resume);
export const resumeToPipeableStream: typeof Server.resumeToPipeableStream = /* @__PURE__ */ __minified(
  Server.resumeToPipeableStream,
);
export const prerender: typeof Server.prerender = /* @__PURE__ */ __minified(Server.prerender);
export const prerenderToNodeStream: typeof Server.prerenderToNodeStream = /* @__PURE__ */ __minified(
  Server.prerenderToNodeStream,
);
export const resumeAndPrerender: typeof Server.resumeAndPrerender = /* @__PURE__ */ __minified(
  Server.resumeAndPrerender,
);
export const resumeAndPrerenderToNodeStream: typeof Server.resumeAndPrerenderToNodeStream = /* @__PURE__ */ __minified(
  Server.resumeAndPrerenderToNodeStream,
);

const ReactDOMServer: Record<string, unknown> = {
  ...ServerDefault,
  renderToString,
  renderToStaticMarkup,
  renderToReadableStream,
  renderToPipeableStream,
  resume,
  resumeToPipeableStream,
  prerender,
  prerenderToNodeStream,
  resumeAndPrerender,
  resumeAndPrerenderToNodeStream,
};
export default ReactDOMServer;
