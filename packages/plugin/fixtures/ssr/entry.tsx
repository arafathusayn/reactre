// The server entry of the app in app.tsx: what an SSR build bundles, and the test imports.

import { isServer, renderToStream, renderToString, renderToStringAsync } from "@reactre/core/server";

import { App, ran, resolve } from "./app.tsx";
import { log } from "./state.ts";

export { isServer, log, ran, resolve };
export const html = (): string => renderToString(() => <App />);
export const stream = (): ReadableStream<Uint8Array> => renderToStream(() => <App />);
export const whole = (): Promise<string> => renderToStringAsync(() => <App />);
