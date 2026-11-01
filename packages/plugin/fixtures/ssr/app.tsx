// A reactre app for test/ssr.test.ts, rendered on the server: control flow, a context, an
// <Errored> boundary, an effect (which does not run there), and a <Loading> over async data, which
// the test resolves. entry.tsx renders it with @reactre/core/server.

import { effect, For, memo, Show, signal } from "@reactre/core";
import { Loading, memo as asyncMemo } from "@reactre/core/features/async";
import { createContext, useContext } from "@reactre/core/features/context";
import { Errored } from "@reactre/core/features/errors";

import { greeting } from "./state.ts";

const Theme = createContext("light");

let settle!: (v: string) => void;
export const resolve = (v: string): void => settle(v);
const word = asyncMemo(() => new Promise<string>((ok) => (settle = ok)));

/** Effects that ran: none on the server. */
export const ran: string[] = [];

const Label = (props: { text: string }) => {
  effect(() => void ran.push(props.text));
  return <b class={useContext(Theme)}>{props.text}</b>;
};

const Broken = (): unknown => {
  throw new Error("broken");
};

export const App = () => {
  const [items] = signal(["a", "b"]);
  const upper = memo(() => items().map((s) => s.toUpperCase()));
  return (
    <main>
      <h1>{greeting()}</h1>
      <Theme value="dark">
        <Label text="themed" />
      </Theme>
      <ul>
        <For each={upper()} key={(s) => s}>
          {(s) => <li>{s}</li>}
        </For>
      </ul>
      <Show when={items().length > 1} fallback={<p>few</p>}>
        <p>many</p>
      </Show>
      <Errored fallback={(err) => <p class="error">{(err as Error).message}</p>}>
        <Broken />
      </Errored>
      <Loading fallback={<i>loading</i>}>
        <p class="word">{word()}</p>
      </Loading>
    </main>
  );
};
