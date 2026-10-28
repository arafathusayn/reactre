# reactre

A tiny, fast UI library for the web. You write components in TSX over signals; a compiler turns each JSX tree into a template that is parsed once and cloned, and a change updates only the text, class or attribute that reads it.

- **Small.** About 6 KB minified and gzipped, with no dependencies.
- **Fine-grained.** No virtual DOM and no tree diffing: components run once, and a signal's readers update.
- **Fast lists.** A keyed list reuses rows and makes the fewest DOM moves. Selecting one row out of thousands touches two.
- **Typed.** Template holes carry their value types, and the types cost nothing at runtime.
- **Runs anywhere there is a DOM.** Any modern browser, with any bundler or none.

```sh
bun add reactre
```

Or with npm: `npm install reactre`.

## A counter

```tsx
import { render, signal } from "reactre";

const [count, setCount] = signal(0);

const Counter = () => <button onClick={() => setCount((n) => n + 1)}>Clicked {count()} times</button>;

render(Counter, document.getElementById("app")!);
```

`Counter` runs once. `{count()}` reads a signal, so that one text node updates when `count` changes. A hole that calls a function updates when what it read changes; any other hole is written once.

## A list

```tsx
import { For, render, selector, signal } from "reactre";

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

TSX is compiled at build time by `reactre-compiler`, a Bun plugin:

```sh
bun add -d reactre-compiler
```

```ts
import { reactreCompiler } from "reactre-compiler";

await Bun.build({ entrypoints: ["src/main.tsx"], outdir: "dist", plugins: [reactreCompiler()] });
```

## Without TSX

The templates the compiler produces are a public API of their own, in `reactre/dom`:

```ts
import { effect, signal } from "reactre";
import { html, on, text } from "reactre/dom";

const [count, setCount] = signal(0);

const Counter = html`<button onclick=${on<"click">()}>Clicked ${text<number>()} times</button>`;
const view = Counter.mount([() => setCount((n) => n + 1), 0]);

effect(() => view.set(1, count()));
document.body.append(view.root);
```

The template is parsed once. `mount` clones it with values for its holes, in order, and the effect rewrites the one text node when `count` changes.

A keyed list:

```ts
import { effect, signal } from "reactre";
import { html, List, text, type BlockOf } from "reactre/dom";

type Todo = { id: number; title: string };
const [todos, setTodos] = signal<Todo[]>([
  { id: 1, title: "Write the docs" },
  { id: 2, title: "Ship it" },
]);

const Item = html`<li>${text()}</li>`;
const list = new List<Todo, BlockOf<typeof Item>>(document.querySelector("ul")!, {
  key: (todo) => todo.id,
  create: (todo) => Item.mount([todo.title]),
  update: (item, todo) => item.set(0, todo.title),
});

effect(() => list.set(todos()));
setTodos((all) => [...all].reverse()); // both rows are kept; one moves
```

## API

### `reactre`

| Export               | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `signal(value)`      | A getter and a setter. Reading the getter inside an effect or a hole subscribes it.             |
| `effect(fn)`         | Runs `fn` now, and again whenever a signal it read changes.                                     |
| `memo(fn)`           | A derived value, recomputed when what it reads changes.                                         |
| `batch(fn)`          | Runs `fn` and applies its writes together, so effects run once.                                 |
| `untrack(fn)`        | Reads signals without subscribing to them.                                                      |
| `selector(source)`   | `isSelected(key)`, where a change of selection re-runs only the readers of the old and new key. |
| `<For each key>`     | A keyed list in TSX.                                                                            |
| `render(view, root)` | Mounts a TSX view into an element.                                                              |

### `reactre/dom`

| Export                        | What it does                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `html`, `svg`                 | A template, parsed once per call site, with typed holes.                                           |
| `text`, `cls`, `attr`, `prop` | Value holes: text content, the class, an attribute, a DOM property.                                |
| `on`, `slot`                  | An event handler hole, and a place to insert other content.                                        |
| `Template.mount(values)`      | Clones the template with its hole values and returns a `Block`.                                    |
| `Block.set(index, value)`     | Writes one hole, and only when the value changed.                                                  |
| `List`                        | A keyed list: reuses rows by key and keeps the longest run in place, so it moves the fewest nodes. |
| `morph(target, nodes)`        | Patches a live subtree to match freshly built nodes.                                               |

## Browsers and bundlers

reactre runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, and its TypeScript sources, which Bun uses directly and which give editors full types.

## License

[Apache-2.0](LICENSE)
