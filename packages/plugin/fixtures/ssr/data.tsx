// A reactre app for test/ssr.test.ts, of what a server render sends the client that hydrates it:
// a memo with an `id`, whose value the server writes and the hydrating client takes; a library's
// value, written with the render's hydration writer and taken with `takeHydrationValue`; the
// response's status and a header; and a component only the browser renders (`clientOnly`).
// data-server.tsx renders it, and data-client.tsx hydrates that.

import { signal } from "@reactre/core";
import { Loading, memo } from "@reactre/core/features/async";
import { clientOnly, getHydrationWriter, takeHydrationValue } from "@reactre/core/features/hydrate";
import { httpHeader, httpStatus } from "@reactre/core/server";

/** What the memos computed, and where. */
export const log: string[] = [];
export const [n, setN] = signal(1);

/** A library's cache: what the server fetched goes to the client, which takes it instead of fetching. */
function cached(key: string, load: () => Promise<string>): Promise<string> {
  const got = takeHydrationValue<string>(key);
  if (got?.status === "resolved") return Promise.resolve(got.value);
  const p = load();
  getHydrationWriter()?.write(key, p);
  return p;
}

/** A component of the browser's alone (an app would import it): the server writes its fallback, and never loads it. */
const Face = (props: { n: number }) => <b>clock {props.n}</b>;
const Clock = clientOnly(() => Promise.resolve({ default: Face }));

export const App = () => {
  httpStatus(201, "Created");
  httpHeader("x-app", "data");
  const user = memo(() => (log.push("user " + n()), fetch("data:,user" + n()).then((r) => r.text())), { id: "user" });
  const greeting = memo(() => cached("lib:greeting", () => (log.push("greeting"), Promise.resolve("hi"))));
  return (
    <main>
      <Loading fallback={<i>loading</i>}>
        <p class="user">{user()}</p>
        <p class="greeting">{greeting()}</p>
      </Loading>
      <Clock n={n()} fallback={<i>no clock</i>} />
    </main>
  );
};
