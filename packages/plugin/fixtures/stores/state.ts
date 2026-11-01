// The app's state, a store in a module of its own: the modules that import it read it by member,
// and the whole program tells the compiler that what they import is a store.

import { createStore } from "@reactre/core/features/store";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export const [store, setStore] = createStore({ count: 0, title: "a", todos: [] as Todo[] });
