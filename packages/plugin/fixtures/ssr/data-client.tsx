// The browser's entry of the app in data.tsx, built with the plugin's `hydrate: true`: it hydrates
// the HTML that data-server.tsx renders, with the values the page's scripts put in it.

import { hydrate } from "@reactre/core/features/hydrate";

import { App, log, setN } from "./data.tsx";

export { log, setN };
export const start = (root: Element): (() => void) => hydrate(() => <App />, root);
