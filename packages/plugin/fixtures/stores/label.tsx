// Components whose callers, in another module, pass them a store's member and a store row's item:
// their holes are bound only because the program sees those callers.

import type { Todo } from "./state.ts";

export function Label(props: { text: string }) {
  return <b>{props.text}</b>;
}

export function Item(props: { todo: Todo }) {
  return <i>{props.todo.title}</i>;
}
