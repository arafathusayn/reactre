// @reactre/core/server in a browser bundle (the "browser" export condition): code shared by the
// server and the client can read `isServer`, which is false here, and the render functions throw.
// None of the server runtime is in the bundle.

/** False: this is a browser build. On the server, @reactre/core/server's `isServer` is true. */
export const isServer: boolean = false;

const NO = "reactre: @reactre/core/server's render functions run on the server, not in a browser bundle";

/** Throws: server rendering does not run in a browser bundle. */
export function renderToString(_app: () => unknown, _options?: unknown): string {
  throw new Error(NO);
}

/** Throws: server rendering does not run in a browser bundle. */
export function renderToStream(_app: () => unknown, _options?: unknown): ReadableStream<Uint8Array> {
  throw new Error(NO);
}

/** Throws: server rendering does not run in a browser bundle. */
export function renderToStringAsync(_app: () => unknown, _options?: unknown): Promise<string> {
  throw new Error(NO);
}
