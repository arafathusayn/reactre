// Server HTML for the hydration scenario, rendered by React's own server renderer in the browser
// (built against React only).
//
// Every runtime hydrates the same markup, made by React, so the hydration scenario checks the
// client side only. run.ts runs this page first and passes its window.__ssr to every page.

import { renderToString } from "react-dom/server.browser";

import { HydrateApp } from "./cases.tsx";

(window as unknown as { __ssr: Record<string, string> }).__ssr = { hydrate: renderToString(<HydrateApp />) };
