// Reads of a store imported from ./state.ts: a text hole, a prop, and a <For> over its array whose
// rows read their item, none of which calls anything.

import { For, render } from "@reactre/core";

import { Item, Label } from "./label.tsx";
import { setStore, store } from "./state.ts";

export function mount(el: Element): typeof setStore {
  render(
    () => (
      <main>
        <p>{store.count}</p>
        <Label text={store.title} />
        <ul>
          <For each={store.todos} key={(t) => t.id}>
            {(t) => (
              <li class={t.done ? "done" : "open"}>
                <q>
                  <Item todo={t} />
                </q>
              </li>
            )}
          </For>
        </ul>
      </main>
    ),
    el,
  );
  return setStore;
}
