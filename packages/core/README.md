# @reactre/core

A tiny, fast UI library for the web. You write components in TSX over signals.

- **Small.** About 7.5 KB minified and gzipped, with no third-party dependencies.
- **Fine-grained.** No virtual DOM and no tree diffing: components run once, and a signal's readers update.
- **Fast lists.** A keyed list reuses rows and makes the fewest DOM moves. Selecting one row out of thousands touches two.
- **Typed.** Template holes carry their value types, and the types cost nothing at runtime.
- **Runs anywhere there is a DOM.** Any modern browser, with any bundler or none.

```sh
bun add @reactre/core
```

Or with npm: `npm install @reactre/core`.

## A counter

```tsx
import { render, signal } from "@reactre/core";

const [count, setCount] = signal(0);

const Counter = () => <button onClick={() => setCount((n) => n + 1)}>Clicked {count()} times</button>;

render(Counter, document.getElementById("app")!);
```

`Counter` runs once. `{count()}` reads a signal, so that one text node updates when `count` changes. A hole that calls a function updates when what it read changes; any other hole is written once. So a hole that reads a plain variable (`let n = 0; ... <b>{n}</b>`) shows the value it had when the element was created, and changing the variable later changes nothing on the page: keep a value that changes in a signal.

## A list

```tsx
import { For, render, selector, signal } from "@reactre/core";

type Todo = { id: number; title: string };

const [todos, setTodos] = signal<Todo[]>([
  { id: 1, title: "Write the docs" },
  { id: 2, title: "Ship it" },
]);
const [selected, setSelected] = signal(0);
const isSelected = selector(selected);

const App = () => (
  <ul>
    <For each={todos()} key={(todo) => todo.id}>
      {(todo) => (
        <li class={isSelected(todo.id) ? "selected" : ""} onClick={() => setSelected(todo.id)}>
          {todo.title}
        </li>
      )}
    </For>
  </ul>
);

render(App, document.getElementById("app")!);
```

`<For>` reuses rows by key and moves the fewest nodes. `selector` makes a change of selection re-run only the two rows whose key it was or is, and row clicks go to one delegated listener.

A row can also hold components, nested `<For>` lists and JSX expressions. They belong to the row: a new item for the row's key builds them again, and they are disposed when the row leaves. A row of plain elements does none of this work.

Elements take what React's do: fragments, spread props, `style` as an object or a string, `ref` (a function or an object with `current`), SVG, `value`, `checked` and `selected` as properties, and `key`, which outside `<For>` rebuilds the element when it changes. A handler expression that reads a signal (`onClick={editing() ? save : edit}`) follows it.

TSX is compiled at build time by [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin), for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun:

```sh
bun add -d @reactre/plugin
```

```ts
// vite.config.ts
import reactre from "@reactre/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [reactre()] });
```

For TypeScript, point the JSX types at `@reactre/core`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@reactre/core",
  },
}
```

TypeScript then reads `@reactre/core/jsx-runtime`'s JSX namespace: every HTML and SVG element with its attributes, `on*` handlers typed by their event (`onClick` gets a `MouseEvent`, `onKeyDown` a `KeyboardEvent`), and `<For>`, whose rows take the type of `each`. The types follow what the compiler compiles:

- `class` (or `className`) takes a string; `style` takes a string or an object of CSS properties (a number gets no unit).
- An attribute or a child takes a value, not a function: `{count()}` updates, while `{count}` is an error, since it would be written once as text.
- `ref` takes a function or an object typed by the element, and void elements such as `<input>` take no children.
- A `key` belongs on `<For>`; on any other element it is an error.

The plugin leaves no call to a JSX runtime in the bundle. A file that reaches the bundle without it throws on its first element, naming the fix.

## Without TSX

The templates the compiler produces are a public API of their own, in [`@reactre/dom`](https://www.npmjs.com/package/@reactre/dom). Signals drive them just as well:

```sh
bun add @reactre/core @reactre/dom
```

```ts
import { effect, signal } from "@reactre/core";
import { html, on, text } from "@reactre/dom";

const [count, setCount] = signal(0);

const Counter = html`<button onclick=${on<"click">()}>Clicked ${text<number>()} times</button>`;
const view = Counter.mount([() => setCount((n) => n + 1), 0]);

effect(() => view.set(1, count()));
document.body.append(view.root);
```

The template is parsed once. `mount` clones it with values for its holes, in order, and the effect rewrites the one text node when `count` changes.

## API

| Export               | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `signal(value)`      | A getter and a setter. Reading the getter inside an effect or a hole subscribes it.             |
| `effect(fn)`         | Runs `fn` now, and again whenever a signal it read changes.                                     |
| `memo(fn)`           | A derived value, recomputed when what it reads changes.                                         |
| `batch(fn)`          | Runs `fn` and applies its writes together, so effects run once.                                 |
| `untrack(fn)`        | Reads signals without subscribing to them.                                                      |
| `selector(source)`   | `isSelected(key)`, where a change of selection re-runs only the readers of the old and new key. |
| `onCleanup(fn)`      | Runs `fn` when the effect, component or row it was called in re-runs or goes away.              |
| `<For each key>`     | A keyed list in TSX.                                                                            |
| `render(view, root)` | Mounts a TSX view into an element. Returns a function that removes it and stops its effects.    |

## Browsers and bundlers

reactre runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, with their type declarations, and its TypeScript sources, which Bun runs directly. Editors and `tsc` read the declarations, so your compiler settings never type-check reactre's sources.

## License

[Apache-2.0](LICENSE)
