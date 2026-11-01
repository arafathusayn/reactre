// Reads of ./state.ts's store through what is made of it, none of which calls anything where the
// hole reads it: a local of its array, an export of its array, a box, a function that returns it,
// a keyed <Show>'s value, a store kept as its whole tuple, and its array passed to a component of
// this file as a prop.

import { For, render, Show } from "@reactre/core";

import { box, setStore, store, type Todo, todos, tuple, useStore } from "./state.ts";

const local = store.todos;

function Titles(props: { todos: Todo[] }) {
  return (
    <i>
      {props.todos.length}
      <For each={props.todos} key={(t) => t.id}>
        {(t) => <b>{t.title}</b>}
      </For>
    </i>
  );
}

export function mount(el: Element): { setStore: typeof setStore; setTuple: (typeof tuple)[1] } {
  render(
    () => (
      <main>
        <p>{todos.length}</p>
        <p>{box.store.count}</p>
        <p>
          <For each={useStore().todos} key={(t) => t.id}>
            {(t) => <b>{t.title}</b>}
          </For>
        </p>
        <p>
          <For each={local} key={(t) => t.id}>
            {(t) => <b>{t.done ? "+" : "-"}</b>}
          </For>
        </p>
        <p>
          <Show when={store.todos[0]} keyed>
            {(t) => <b>{t.title}</b>}
          </Show>
        </p>
        <p>{tuple[0].n}</p>
        <Titles todos={store.todos} />
      </main>
    ),
    el,
  );
  return { setStore, setTuple: tuple[1] };
}
