# @reactre/core

A tiny, fast UI library for the web. You write components in TSX over signals.

- **Small.** About 6 KB minified and gzipped (7 KB with every feature), with no third-party dependencies, and an app ships only what it uses ([what an app ships](#what-an-app-ships)).
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
| `render(view, root)` | Mounts a TSX view into an element, for good.                                                    |
| `attach(view, root)` | `render`, returning a function that removes the view and stops its effects.                     |

## Feature modules

`@reactre/core` itself holds what the compiler makes free. Runtime APIs beyond it are feature modules, imported by path: an app that does not import one ships none of its code, and its updates run as before.

| Import                            | Export                     | What it does                                                                                                                                  |
| --------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@reactre/core/features/owner`    | `createRoot(fn)`           | Runs `fn(dispose)` under a new owner; `dispose` stops what it made. It goes with the owner it was made in.                                    |
|                                   | `getOwner()`               | The current owner, or null.                                                                                                                   |
|                                   | `runWithOwner(o, fn)`      | Runs `fn`, untracked, with `o` as the owner of what it makes; null makes it belong to nothing.                                                |
| `@reactre/core/features/timing`   | `onSettled(fn)`            | Runs `fn` once, untracked, when the work under way has finished and the DOM shows it ([timing](#timing)). A function it returns is a cleanup. |
|                                   | `flush(fn?)`               | `flush(fn)` runs `fn` and applies its writes before it returns, inside a batch too. `flush()` applies what the current batch has queued.      |
| `@reactre/core/features/reaction` | `reaction(compute, apply)` | An effect in two halves: `compute` is tracked, `apply(value, prev)` runs untracked when the value changes, and may return a cleanup.          |

```tsx
import { createRoot } from "@reactre/core/features/owner";
import { flush, onSettled } from "@reactre/core/features/timing";
```

`onSettled`, `flush`, `createRoot`, `getOwner` and `runWithOwner` are Solid 2.0's, and `reaction` is its `createEffect(compute, apply)`, under MobX's name. Rows with several selector keys are a feature module too (see [What an app ships](#what-an-app-ships)).

## Timing

Writes apply at once: a signal's write re-runs its readers before it returns. In a `batch` (and in a `<For>` row's handler, which is batched), they apply when the outermost batch ends, each effect once. `flush(fn)` is `batch(fn)` that applies before it returns even inside another batch, and `flush()` in a batch applies what it has queued so far.

`onSettled(fn)` runs `fn` once the work under way has finished:

- Called in a batch or a `flush(fn)`, or in an effect that their writes re-ran (a slot rendering new content), `fn` runs at the batch's end, after every effect its writes queued, before `batch` or `flush` returns.
- Called anywhere else (a component rendered by `render` or `attach`, an effect re-run by a write outside any batch), `fn` runs in a microtask: after the code that called it has returned, and before the browser paints. `flush(() => render(App, el))` runs it before `flush` returns.

In a component, the view is in the page either way. `fn` runs under the component's owner, and not at all if the owner goes first (a slot replaced the content); a function it returns runs when the owner goes.

## What an app ships

An app ships only what it uses. With a bundler that tree-shakes (all of the plugin's do), two parts of the runtime come only when the app needs them:

| Feature                         | How it comes                                                                                                                                                                                                           | Cost, gzipped | Without it                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership                       | By use: `effect`, `memo`, a slot (a JSX expression that may change, `{cond() ? <A /> : <B />}`), a fragment, a row holding components, lists or slots, or `attach`. Nothing to turn on.                                |        0.3 KB | Nothing in the app needs it: with none of those, no effect is ever made inside another's run, so there is nothing to dispose.                                                                                                      |
| Rows with several selector keys | `import "@reactre/core/features/selectors"`. The compiler adds the import itself to a file whose `<For>` row makes two or more calls with arguments in its reactive holes (`isSelected(row.id)`, `isHovered(row.id)`). |       0.16 KB | A row that reads a second selector key, or the same selector with a second key, throws an error naming the import. Only a row that reads the keys through a function of its own (`class={classes(row)}`) needs the import by hand. |

Ownership is what makes `effect` own the effects and cleanups its run makes, a slot dispose its old content, a row dispose what it holds when it leaves, and `attach` return a disposer. `onCleanup` itself costs a few bytes: called where nothing owns (at module scope, in a view given to `render`), it does nothing.

The js-framework-benchmark app (`apps/jfb/app/reactre.tsx`, a keyed list with a selector and delegated handlers) comes to 6.6 KB gzipped (6,726 bytes, app included), against 6,871 bytes for 0.0.2, which had neither feature. The whole package, with every feature, is 7.0 KB. [`sizes.json`](sizes.json) holds the budgets that `test/features.test.ts` checks.

## Browsers and bundlers

reactre runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, with their type declarations, and its TypeScript sources, which Bun runs directly. Editors and `tsc` read the declarations, so your compiler settings never type-check reactre's sources.

## License

[Apache-2.0](LICENSE)
