// The browser's entry of the app in app.tsx, built with the plugin's `hydrate: true`: it hydrates
// the HTML that entry.tsx's `hydratable` renders, keeping the server's nodes.

import { hydrate } from "@reactre/core/features/hydrate";

import { App, ran, resolve } from "./app.tsx";

export { ran, resolve };
export const start = (root: Element): (() => void) => hydrate(() => <App />, root);
