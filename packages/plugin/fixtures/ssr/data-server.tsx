// The server entry of the app in data.tsx: the page, with the values it sends the client, and the
// response head it declared.

import { renderToStringAsync, type ResponseHead } from "@reactre/core/server";

import { App, log } from "./data.tsx";

export { log };
export async function render(): Promise<{ html: string; response: ResponseHead }> {
  const response: ResponseHead = { status: 200, headers: new Headers() };
  const html = await renderToStringAsync(() => <App />, { hydrate: true, response, nonce: "r4nd" });
  return { html, response };
}
