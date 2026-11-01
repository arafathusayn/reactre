// The app's state, a store in a module of its own: the modules that import it read it by member,
// and the whole program tells the compiler that what they import is a store.

import { createStore } from "@reactre/core/features/store";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export const [store, setStore] = createStore({ count: 0, title: "a", todos: [] as Todo[] });

// What ./aliases.tsx reads the store through: its array, a box that holds it, a function that
// returns it; and a store kept as its whole tuple, read as `tuple[0]` and written through `tuple[1]`.
export const todos = store.todos;
export const box = { store };
export function useStore(): typeof store {
  return store;
}
export const tuple = createStore({ n: 0 });
