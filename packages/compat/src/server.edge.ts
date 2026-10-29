// @reactre/compat/server.edge: @reactre/compat/server as React's edge and Bun builds
// (react-dom/server.edge, react-dom/server.bun), whose renderToString and renderToStaticMarkup are
// its browser build's and throw React's minified production codes, while their streams throw full
// messages, as its Node build does. Edge runtimes resolve @reactre/compat/server here through the
// "workerd" and "edge-light" export conditions, and Bun through "bun", as they resolve
// react-dom/server to those builds. Everything else is ./server.ts's: see its notes.

import ServerDefault, * as Server from "./server.ts";
import { __minified } from "./server.ts";

export * from "./server.ts";

export const renderToString: typeof Server.renderToString = /* @__PURE__ */ __minified(Server.renderToString);
export const renderToStaticMarkup: typeof Server.renderToStaticMarkup = /* @__PURE__ */ __minified(
  Server.renderToStaticMarkup,
);

const ReactDOMServer: Record<string, unknown> = { ...ServerDefault, renderToString, renderToStaticMarkup };
export default ReactDOMServer;
