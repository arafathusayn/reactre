# reactre

A tiny, fast UI library for the web. You write components in TSX over signals. No virtual DOM, no dependencies, about 6 KB gzipped.

```sh
bun add @reactre/core
```

Or with npm: `npm install @reactre/core`.

```tsx
import { render, signal } from "@reactre/core";

const [count, setCount] = signal(0);

const Counter = () => <button onClick={() => setCount((n) => n + 1)}>Clicked {count()} times</button>;

render(Counter, document.getElementById("app")!);
```

Components run once. `{count()}` reads a signal, so that one text node updates when `count` changes; nothing else re-renders.

A keyed list, where selecting a row re-runs only the two rows whose class changes:

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

TSX is compiled at build time by [`@reactre/compiler`](packages/compiler), a Bun plugin:

```sh
bun add -d @reactre/compiler
```

```ts
import { reactreCompiler } from "@reactre/compiler";

await Bun.build({ entrypoints: ["src/main.tsx"], outdir: "dist", plugins: [reactreCompiler()] });
```

## Without TSX

The templates the compiler produces are a public API of their own, in `@reactre/dom`. They need no build step:

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

**[Read the reactre docs →](packages/core)**

## Already on React?

Keep your app as it is. `@reactre/compat` is React 19's API on reactre's templates: hooks, context, Suspense, portals, transitions, controlled fields and hydration, and libraries such as React Router, TanStack Query, Radix and Recharts run on it.

```sh
bun add @reactre/compat
```

Or with npm: `npm install @reactre/compat`.

Then point `react` and `react-dom` at it when you build. With Vite:

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // react, react-dom and every subpath of them, in your code and in your dependencies.
    alias: [{ find: /^react(-dom)?(\/.*)?$/, replacement: "@reactre/compat" }],
  },
});
```

Vite compiles JSX for React's automatic runtime on its own, so no React plugin is needed. Leave `@vitejs/plugin-react` out: its Fast Refresh works through React's renderer, and with compat an edited component would stay as it was on screen. Without it, Vite reloads the page when you save.

With Bun:

```ts
import type { BunPlugin } from "bun";
import { reactreCompatCompiler } from "@reactre/compat/compiler";

const react: BunPlugin = {
  name: "react-to-reactre-compat",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({
      path: Bun.resolveSync("@reactre/compat", import.meta.dir),
    }));
  },
};

await Bun.build({
  entrypoints: ["src/main.jsx"],
  outdir: "dist",
  plugins: [reactreCompatCompiler(), react],
});
```

Your imports from `react` and `react-dom` stay as they are. If your app or a library it uses has class components, point the alias at `@reactre/compat/classes` instead. `reactreCompatCompiler()` is optional: it compiles your JSX trees into templates for extra speed, and is a Bun plugin for now.

**[Read the compat docs →](packages/compat)**

## Packages

| Package                                  | For                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@reactre/core`](packages/core)         | Signals, effects and keyed lists: the components you write.                                |
| [`@reactre/dom`](packages/dom)           | Templates and keyed lists on the DOM, with no build step. `@reactre/core` renders on it.   |
| [`@reactre/compiler`](packages/compiler) | Writing reactre as TSX: compiles each JSX tree to a template at build time (a Bun plugin). |
| [`@reactre/compat`](packages/compat)     | Running an existing React 19 app on reactre's templates, unchanged.                        |

## Performance

The speed of hand-written vanilla JavaScript, with the comfort of components.

- **No virtual DOM.** A change goes straight to the one node that shows it.
- **No re-renders.** Components run once. No dependency arrays, no memoizing, nothing to tune.
- **Lists that barely move.** Thousands of rows created, reordered, updated or cleared in the fewest possible steps.
- **Featherweight.** About 6 KB gzipped, with zero dependencies.

reactre goes head to head with the fastest entries of [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark).

## License

[Apache-2.0](LICENSE)
