// @reactre/core/server in a browser bundle (the "browser" export condition): code shared by the
// server and the client can read `isServer`, which is false here, call `httpStatus` and
// `httpHeader`, which do nothing here (the response went long ago), and ask for the hydration
// writer, which is undefined here; the render functions throw. None of the server runtime is in
// the bundle.

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

/** Does nothing in a browser bundle: the response's status was sent by the server. */
export function httpStatus(_code: number, _text?: string): void {}

/** Does nothing in a browser bundle: the response's headers were sent by the server. */
export function httpHeader(_name: string, _value: string, _options?: { readonly append?: boolean }): void {}

/** Undefined in a browser bundle: only a server render writes hydration values. */
export function getHydrationWriter(): undefined {
  return undefined;
}
