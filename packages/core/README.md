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

## A counter

```tsx
import { render, signal } from "@reactre/core";

const [count, setCount] = signal(0);

const Counter = () => <button onClick={() => setCount((n) => n + 1)}>Clicked {count()} times</button>;

render(Counter, document.getElementById("app")!);
```

`Counter` runs once. `{count()}` reads a signal, so that one text node updates when `count` changes. A hole that calls a function updates when what it read changes, and so does one that reads a prop passed that way ([Props](#props)); any other hole is written once. So a hole that reads a plain variable (`let n = 0; ... <b>{n}</b>`) shows the value it had when the element was created, and changing the variable later changes nothing on the page: keep a value that changes in a signal.

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

A row can also hold components, nested `<For>` lists and JSX expressions. They belong to the row: a new item for the row's key builds them again, and they are disposed when the row leaves. A row of plain elements does none of this work. A list can stand anywhere, not only in an element, and a row can be text, a fragment or any other content (see [Control flow and elements](#control-flow-and-elements)).

Elements take what React's do: fragments, spread props, `style` as an object or a string, `ref` (a function or an object with `current`), SVG, `value`, `checked` and `selected` as properties, and `key`, which outside `<For>` rebuilds the element when it changes. A handler expression that reads a signal (`onClick={editing() ? save : edit}`) follows it.

## Props

A component runs once, and its props follow what they were given, as in Solid:

```tsx
import type { Child } from "@reactre/core/jsx-runtime";

const Label = (props: { text: string; children?: Child }) => (
  <p class={props.text.length > 10 ? "long" : ""}>
    {props.text} {props.children}
  </p>
);

const App = () => (
  <main>
    <Label text={name()}>
      <b>new</b>
    </Label>
    <Label text="fixed" />
  </main>
);
```

- A prop whose expression calls a function (`text={name()}`) is passed as a getter, so `Label` reads it where it uses it: `{props.text}` and its `class` update when `name` changes, and `Label` does not run again. A literal, a plain name and a function (`onClick={() => save()}`) are passed as they are.
- Children that hold JSX are a getter too: they are built when the component reads `props.children`, after the code it runs before that. A provider can set things up first and then return `props.children`. `{props.children}` in an element inserts them, nodes or text. So does a hole that reads another prop some call site passes JSX (`<Card header={<h1>Hi</h1>} />`, a component, a fragment, an array or a conditional of them, then `{props.header}`). A file compiled alone (a dev server, a library's entry) cannot see who calls the components it exports, so a hole that reads any of their props is inserted too, as it may be passed JSX; a production build sees the callers and inserts only the props they pass JSX.
- Read props through the object: `props.text`. Destructuring (`({ text }) =>`), or `const { text } = props`, reads each value once, when the component runs, and it then stays the value it had.
- `<Child {...props} />` passes the props on, getters included, and so does `<Child title={props.title} />`: a prop that reads a prop is passed as a getter, so children passed on (`<Theme value="dark">{props.children}</Theme>`) are built inside the component they are passed to.
- `merge` and `omit` from `@reactre/core/features/store` keep the getters too: `const p = merge({ size: "m" }, props)` gives defaults, and a hole that reads `p.size` follows the prop, as one that reads `props.size` does.
- What it costs: a hole that reads a prop is bound (an effect that rewrites it) only if some call site of the component may pass that prop reactively. Above, `{props.text}` is bound because one call passes `name()`; if every call passed text, it would be written once, as before. @reactre/plugin and the compiler's Bun plugin read the whole program at a production build's start to know this. A component whose callers cannot all be seen is treated as getting every prop reactively, and maybe a store or JSX in each: one an entry exports (a library's API), one used as a value (`<Dynamic component={Label}>`, `const C = Label`), one called with spread props, and, on a dev server or in watch mode, where each file is compiled alone, every component the file exports. That code is larger and slower than a build's, and renders the same.

## Control flow and elements

`<Show>`, `<Switch>` and `<Match>`, `<Repeat>`, `<Portal>` and `<Dynamic>` come from `@reactre/core` and are compiled away, into the slots, memos and lists the compiler already writes. An app that uses none of them ships none of them, and one that does ships no runtime of theirs. The compiler recognizes them by their import from `@reactre/core` (under any name, or through `import * as`), so a component of your own named `Switch` stays yours.

```tsx
import { Dynamic, For, Match, Portal, Repeat, Show, Switch } from "@reactre/core";

const Page = () => (
  <main>
    <Show when={user()} fallback={<a href="/login">Sign in</a>}>
      {(u) => <p>Hello, {u().name}</p>}
    </Show>
    <Switch fallback={<p>Not found</p>}>
      <Match when={route() === "home"}>
        <Home />
      </Match>
      <Match when={route() === "settings"}>
        <Settings />
      </Match>
    </Switch>
    <ul>
      <For each={todos()} key={(t) => t.id} fallback={<li>Nothing to do</li>}>
        {(t) => <li>{t.title}</li>}
      </For>
    </ul>
    <ol>
      <Repeat count={stars()}>{(i) => <li>Star {i + 1}</li>}</Repeat>
    </ol>
    <Dynamic component={big() ? "h1" : "h2"} class="title">
      Today
    </Dynamic>
    <Show when={open()}>
      <Portal>
        <div class="modal">Saved</div>
      </Portal>
    </Show>
  </main>
);
```

- `<Show when fallback>` shows its children while `when` is truthy, else `fallback`. They are built when `when` turns truthy and taken down, effects and cleanups included, when it turns falsy; a new truthy value does not rebuild them. A function child gets an accessor of the value (`u()`), which follows it. With `keyed`, every new value rebuilds the children, and a function child gets the value itself (`(u) => u.name`).
- `<Switch fallback>` shows its first `<Match when>` whose `when` is truthy, and rebuilds only when another match becomes the first. The conditions are read in order, up to the first truthy one. `<Match>` takes `keyed` and function children as `<Show>` does.
- `<For>` takes a `fallback`, shown while `each` is empty.
- `<For each={names()} keyed={false}>{(name, i) => <li>{i}: {name()}</li>}</For>` has rows by position, Solid 2.0's replacement for `<Index>`: the row at index `i` is built once, when the list first has an `i`-th item, and stays while the list is that long. It gets an accessor of its item, and a new item at its index re-runs only the holes that call it; `i` is a number, and a hole that reads only it is written once. Rows leave from the end when the list gets shorter. Its runtime is a feature module, `@reactre/core/features/index`, which the compiler imports for a file that has such a list: an app without one ships none of it, and a keyed `<For>` compiles as before ([`sizes.json`](sizes.json)'s `index` profile is 5,488 bytes gzipped). `keyed={(item) => key}` is `key`, under Solid 2.0's name, and `keyed` must be written as `false` or a function. Where it differs from Solid 2.0: the index is a number, not an accessor; `keyed={true}` (by reference) is not taken, as reactre's keyed lists need a key; and a row of a store's array over `keyed={false}` follows both its item's in-place writes and a new item at its index.
- `<Repeat count from>` is a row per index, from `from` (0 by default) to `from + count - 1`: a keyed `<For>` over the indexes, so a row is built once per index and kept while the count keeps it. It takes a `fallback` too, and children that are not a function are each row's (`<Repeat count={3}><hr /></Repeat>`).
- `<For>` and `<Repeat>` stand anywhere content does: a component's whole view, a fragment's child beside other children, the only child of a `<Show>`, a `<Switch>`, an `<Errored>`, a `<Loading>` or a context's provider, a row of another list. A row may be any content: text (`(name) => name`), a fragment, an array, nothing, a component whatever it returns, or an expression that may change, which is a slot (`(t) => (open() ? <Card t={t} /> : t.title)`). A keyed row function of two parameters gets an accessor of its index (`(t, i) => <li>{i() + 1}. {t.title}</li>`), which follows its moves. A list of element rows (`(row) => <tr>...</tr>`) as an element's child is the core's list, as above; any other is `@reactre/core/features/for`, which the compiler imports for a file that has one, so an app with none ships none of it. Its rows are built once per key and moved with their nodes, and a keyed row given an item new for its key is built again (a row of the core's list keeps its element and rewrites its holes); its row handlers are each row's own, not delegated. The module is about 1.3 KB gzipped beside the core's list, and an app whose lists are all its own ships it without the core's list.
- `<Portal mount>` puts its children at the end of `mount` (`document.body` by default, read once) and takes them out when what holds it goes away: a `<Show>` that hides it, a row that leaves, `attach`'s disposer.
- `<Dynamic component>` renders a component, called with the other props, or for a tag name, that element with them (applied as spread props, so they follow what they read); null renders nothing. A `component` that reads a signal rebuilds it when it changes, and a tag written as a string (`component="h1"`) compiles as if the element were written out. `dynamic(() => source())`, from the feature module `@reactre/core/features/dynamic`, is the same as a component of its own, to name or hand on.

A `<Match>` stands only in a `<Switch>`, and a list's row is a function written in place (`(row) => ...`) or content. What the compiler cannot compile is a compile error that says so.

Elements take a few things beyond React's:

- `class` takes an object or an array written in place: `class={{ active: on(), done: todo.done }}` toggles each key's class while its value is truthy, and `class={["btn", size(), { active: on() }]}` joins its items, leaving out what is falsy. The classes the compiler can see (`"btn"`, `{ big: true }`) join the template; an object's other keys become `classList` toggles, so classes added by other code stay; a list with an item it cannot see into (`size()`) is one string, through a small helper only that file imports. The lists are taken apart by their syntax: one held in a variable goes inside an array, `class={[classes]}`.
- `ref={[a, b]}` gives the element to each ref (a `null` one is skipped). A directive is a function that returns a ref: `ref={tooltip("Save")}`.
- `defaultValue`, `defaultChecked`, `defaultSelected` and `defaultMuted` set the property of their name: the initial value a form's reset goes back to, which the user's edits leave alone.

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

- `class` (or `className`) takes a string, or a class object or array written in place; `style` takes a string or an object of CSS properties (a number gets no unit).
- An attribute or a child takes a value, not a function: `{count()}` updates, while `{count}` is an error, since it would be written once as text.
- `ref` takes a function or an object typed by the element, or an array of them, and void elements such as `<input>` take no children.
- `<Show>`'s and `<Match>`'s function children take an accessor of `when`'s value, or with `keyed` the value, without its falsy types; `<Repeat>`'s row takes a number, and `<Dynamic>` the props of its tag or component.
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

| Export                | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `signal(value)`       | A getter and a setter. Reading the getter inside an effect or a hole subscribes it.             |
| `effect(fn)`          | Runs `fn` now, and again whenever a signal it read changes.                                     |
| `memo(fn)`            | A derived value, recomputed when what it reads changes.                                         |
| `batch(fn)`           | Runs `fn` and applies its writes together, so effects run once.                                 |
| `untrack(fn)`         | Reads signals without subscribing to them.                                                      |
| `selector(source)`    | `isSelected(key)`, where a change of selection re-runs only the readers of the old and new key. |
| `onCleanup(fn)`       | Runs `fn` when the effect, component or row it was called in re-runs or goes away.              |
| `<For each key>`      | A keyed list in TSX, with a `fallback` while it is empty; `keyed={false}`: rows by position.    |
| `<Show when>`         | Its children while `when` is truthy, else `fallback`.                                           |
| `<Switch>`/`<Match>`  | The children of the first `<Match>` whose `when` is truthy, else `fallback`.                    |
| `<Repeat count>`      | A row per index, from `from` to `from + count - 1`.                                             |
| `<Portal mount>`      | Its children in another element, `document.body` by default.                                    |
| `<Dynamic component>` | A component or a tag name's element, chosen by a value.                                         |
| `render(view, root)`  | Mounts a TSX view into an element, for good.                                                    |
| `attach(view, root)`  | `render`, returning a function that removes the view and stops its effects.                     |

## Feature modules

`@reactre/core` itself holds what the compiler makes free. Runtime APIs beyond it are feature modules, imported by path: an app that does not import one ships none of its code, and its updates run as before.

| Import                            | Export                               | What it does                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@reactre/core/features/owner`    | `createRoot(fn)`                     | Runs `fn(dispose)` under a new owner; `dispose` stops what it made. It goes with the owner it was made in.                                                                                             |
|                                   | `getOwner()`                         | The current owner, or null.                                                                                                                                                                            |
|                                   | `runWithOwner(o, fn)`                | Runs `fn`, untracked, with `o` as the owner of what it makes; null makes it belong to nothing.                                                                                                         |
| `@reactre/core/features/timing`   | `onSettled(fn)`                      | Runs `fn` once, untracked, when the work under way has finished and the DOM shows it ([timing](#timing)). A function it returns is a cleanup.                                                          |
|                                   | `flush(fn?)`                         | `flush(fn)` runs `fn` and applies its writes before it returns, inside a batch too. `flush()` applies what the current batch has queued.                                                               |
| `@reactre/core/features/reaction` | `reaction(compute, apply)`           | An effect in two halves: `compute` is tracked, `apply(value, prev)` runs untracked when the value changes, and may return a cleanup.                                                                   |
| `@reactre/core/features/effects`  | `bind(compute, apply)`               | A render effect: `compute` is tracked, and `apply(value, prev)` runs untracked after each of its runs, at once ([effects](#effects-and-list-functions)).                                               |
|                                   | `autorun(fn)`                        | A tracked effect whose first run waits for the flush: in a component, once its view is in the page. A function `fn` returns is a cleanup.                                                              |
|                                   | `onFlush(fn)`                        | Runs `fn` in a microtask, after the work under way, in a batch of its own, so its writes are an update of their own.                                                                                   |
| `@reactre/core/features/lists`    | `map(list, fn, { keyed })`           | An accessor of `list()` mapped by `fn`, a row per item, under an owner of its own, kept by the item, a key, or its position.                                                                           |
|                                   | `repeat(count, fn, { from })`        | An accessor of `fn(i)` for each index from `from` to `from + count - 1`, each under an owner of its own.                                                                                               |
| `@reactre/core/features/dynamic`  | `dynamic(source)`                    | A component that renders what `source` returns, as `<Dynamic>` does.                                                                                                                                   |
| `@reactre/core/features/store`    | `createStore(value)`                 | `[store, setStore]`: a deep reactive proxy, whose reads subscribe per property (arrays by index and `length`), and a setter given a draft.                                                             |
|                                   | `createStore(fn, seed)`              | A derived store that can be written: `fn(draft)` runs tracked; a write holds until it runs again. `{ shallow: true }` for a one-layer store.                                                           |
|                                   | `createProjection(fn, s)`            | A read-only derived store: what `fn(draft)` returns is reconciled into it by `key` ("id" by default).                                                                                                  |
|                                   | `reconcile(value, key?)`             | A setter's function that writes only what differs, keeping items of the same key ("id"; null for by index).                                                                                            |
|                                   | `path(...keys, value)`               | A setter's function that writes `value` at a path: `setStore(path("user", "name", "Ada"))`. `path.DELETE` deletes.                                                                                     |
|                                   | `snapshot(s)`, `deep(s)`             | A plain deep copy, untracked; `deep` subscribes to every property first.                                                                                                                               |
|                                   | `merge(...s)`, `omit(o,…)`           | Props helpers whose properties are getters of their sources, so reactive props stay reactive. In `merge`, a later `undefined` overrides.                                                               |
| `@reactre/core/features/memo`     | `memo(fn, { equals })`               | `memo` with `prev` and an equality of its own; `equals: false` re-runs readers each time.                                                                                                              |
|                                   | `signal(fn)`                         | A writable derived signal: `fn(prev)` recomputes it when its sources change; a write sets it until then. `signal(v, { equals })` too.                                                                  |
|                                   | `memo(fn, { lazy })`                 | A memo that runs `fn` when first read, and once nothing reads it stops following its sources, keeping its value, until it is read again.                                                               |
|                                   | `signal(v, { unobserved })`          | Calls `unobserved` once the last reader stops reading (`memo` takes it too). Only a call the plugin compiles may pass these two (see below).                                                           |
| `@reactre/core/features/context`  | `createContext(default?)`            | A context, which is a component: `<Ctx value={v}>` provides `v` to what its children make, then and later.                                                                                             |
|                                   | `useContext(ctx)`                    | The nearest provider's value, else the default; with no default, it throws `ContextNotFoundError`.                                                                                                     |
| `@reactre/core/features/errors`   | `<Errored fallback>`                 | Its children, or `fallback` (an element, or `(err, reset) => ...`) once something they made throws. `reset()` builds them again.                                                                       |
|                                   | `effect(fn, { error })`              | The core's `effect`, with a handler for what its runs throw.                                                                                                                                           |
|                                   | `configureClientErrors({ onError })` | Gets what an effect, a slot or a row throws outside any boundary.                                                                                                                                      |
| `@reactre/core/features/async`    | `memo(async () => ...)`              | `memo`, typed for an async function or an async iterable: it reads as what it resolves to, and before that is not ready.                                                                               |
|                                   | `<Loading fallback on>`              | Its children, once nothing they read is not ready; until then, `fallback`. With `on`, a change of it during an update shows `fallback` again.                                                          |
|                                   | `<Reveal order>`                     | The `<Loading>` boundaries among its children shown `"natural"` (each when ready), `"sequential"` or `"together"`.                                                                                     |
|                                   | `isPending(fn)`, `latest(fn)`        | Whether a change to what `fn` reads is in flight; `fn()`, read so that an update in flight does not hold it.                                                                                           |
|                                   | `resolve(fn)`, `refresh(target)`     | A Promise of `fn()` once it reads nothing pending; `refresh` computes a memo or an optimistic store again, quietly.                                                                                    |
|                                   | `lazy(load)`, `NotReadyError`        | A component loaded the first time it renders (`preload()` starts it); what a read that is not ready throws where nothing waits.                                                                        |
|                                   | `memo(fn, { loadingValue })`         | The value it has until the first comes: no `<Loading>` waits for it. Its other options (`id`, `ssrSource`, `deferStream`, `transparent`) are for [server rendering](#the-memos-options-on-the-server). |
|                                   | `from(source)`                       | What a subscribe function, an Observable or an async iterable sends, for `memo(() => from(source))` to read as its latest value.                                                                       |
| `@reactre/core/features/actions`  | `action(function* () {...})`         | A mutation, run in a transition: yielded values are awaited, and the page goes from its optimistic state to the confirmed one at once.                                                                 |
|                                   | `createOptimistic(v \| fn)`          | `[read, write]`: a write in an action's code shows at once and reverts when the transition ends; elsewhere it sets the value.                                                                          |
|                                   | `createOptimisticStore(v \| fn, s)`  | The same for a store, whose `fn` may be async; `refresh(store)` runs `fn` again.                                                                                                                       |
|                                   | `affects(target, key?)`              | Marks what the action changes as pending, for `isPending`.                                                                                                                                             |
|                                   | `until(fn, { timeout, signal })`     | A Promise of the first truthy value of `fn`, which reads optimistic values as their base.                                                                                                              |
| `@reactre/core/features/hydrate`  | `hydrate(view, el)`                  | Runs `view` over the HTML the server rendered into `el`, keeping its nodes ([hydration](#hydration)); returns the disposer. Needs `hydrate: true`.                                                     |
|                                   | `isHydrating()`                      | Whether the code running now claims the page.                                                                                                                                                          |
|                                   | `takeHydrationValue(key)`            | Takes what the server render wrote under `key` with its hydration writer out of the page ([hydration values](#hydration-values)).                                                                      |
|                                   | `clientOnly(load, { lazy, export })` | A component rendered only in the browser: the server writes its `fallback`, and never loads it.                                                                                                        |

```tsx
import { createRoot } from "@reactre/core/features/owner";
import { flush, onSettled } from "@reactre/core/features/timing";
import { autorun, bind, onFlush } from "@reactre/core/features/effects";
import { map, repeat } from "@reactre/core/features/lists";
import { dynamic } from "@reactre/core/features/dynamic";
import { createStore, path, reconcile } from "@reactre/core/features/store";
import { memo, signal } from "@reactre/core/features/memo";
import { createContext, useContext } from "@reactre/core/features/context";
import { Errored } from "@reactre/core/features/errors";
import { Loading, isPending } from "@reactre/core/features/async";
import { action, createOptimistic } from "@reactre/core/features/actions";
```

`onSettled`, `flush`, `createRoot`, `getOwner` and `runWithOwner` are Solid 2.0's, and `reaction` is its `createEffect(compute, apply)`, under MobX's name; `bind` is its `createRenderEffect`, `autorun` its `createTrackedEffect` (MobX's name for an effect in one function, beside `reaction`), and `map` its `mapArray`, beside `repeat` and `onFlush`, which keep Solid's names. `<Dynamic>` stays in `@reactre/core`, since it is compiled away; `dynamic()` is the runtime function beside it. Rows with several selector keys are a feature module too (see [What an app ships](#what-an-app-ships)).

The store APIs are Solid 2.0's, under its names but one: setters are draft-first (`setStore((s) => { s.todos.push(todo) })`, with a block body, since an object the setter returns replaces the store's contents). `path` is its `storePath`, for Solid 1.x's path setters: each step is a key, an array of keys, or in an array a range `{ from, to, by }` or a test `(item, index) => boolean` of its items; a function at the end gets the value there, an object is merged into the object there, and with no key into the store. `memo` and `signal` from `@reactre/core/features/memo` take core's arguments as core's do, plus Solid 2.0's `equals`, `lazy` and `unobserved`. The last two need a count of a signal's readers, which core's signals do not keep, so the compiler sends a call that passes either (or options it cannot read, such as a variable or a spread) to a reader-counting entry of the module, whose signals alone are counted; every other call stays as it was, so an app that passes neither ships the same code as before, byte for byte. A file compiled alone (a dev server) and in a whole program (a build) give the same code. The call must be one the compiler sees: in a .tsx or .jsx file the plugin compiles, with `memo` or `signal` imported from `@reactre/core/features/memo` (under any name, or through `import * as`). In code the plugin does not compile (a .ts file, a dependency), the development build throws for either option, naming the fix (add the file to the plugin's `include`); the production build has no check, so that it costs nothing. Unlike Solid 2.0, the count is taken in a microtask after the last reader left (a reader that runs again drops its reads before it reads anew), so `unobserved` is called then, and a lazy memo stops then, if no reader came back; a read outside any reader computes a lazy memo, which stops at the next microtask; and a lazy memo whose owner was disposed returns its last value. In TSX, the compiler knows a store by where it is made: a name bound by `const [store, setStore] = createStore(...)` or `const p = createProjection(...)`, with the functions imported from `@reactre/core/features/store` under any local name or through `import * as`, or by `const [todos, setTodos] = createOptimisticStore(...)` from `@reactre/core/features/actions`. A store a module imports from another is one there too. A production build that reads the whole program (`@reactre/plugin`, or the compiler's own Bun plugin) knows which imports are stores, through re-exports and namespace imports; where each file is compiled alone (a dev server, `wholeProgram: false`, `compileSource`), any import from outside `@reactre` may be a store and is taken for one, as an exported component there takes every prop reactively. So the dev server and the build render the same updates; the build only binds fewer holes. A read through a store is reactive, as a signal's call is:

```tsx
<p>{store.count}</p>                            // follows store.count
<p class={store.ui.dark ? "dark" : ""} />       // follows store.ui.dark
<Show when={store.user}>...</Show>              // follows store.user
<Label text={store.title} />                    // a getter: Label's {props.text} follows it
<For each={store.todos} key={(t) => t.id}>      {/* follows pushes, removals and moves */}
  {(t) => <li class={t.done ? "done" : ""}>{t.title}</li>}   {/* both follow their item */}
</For>
```

A `<For>` over a store's array reads a copy of it, which reads its length and every index tracked, since a list needs a new array for each render and a store's array changes in place; the items stay the same proxies, so only new rows are built. In its rows, a hole that reads only the item follows the item's in-place writes, and so do a nested `<For each={t.tags}>` and a component passed the item (`<Item todo={t} />`). An app whose files bind and import no store compiles as before, and so does each list over anything else.

What is made of a store is followed too: a local of it or of its member, an object that holds it, a function that returns it, a keyed `<Show>`'s value, and a prop a caller passes it. What the compiler cannot follow to a store is written once, as any member read is. Which reads update, the same on a dev server as in a production build:

| Pattern                                                                                          | Updates?                |
| ------------------------------------------------------------------------------------------------ | ----------------------- |
| `{store.count}`, `{ns.store.count}`, `{t.title}` in a store's row, with `store` imported or not  | yes                     |
| `<For each={store.todos}>`, `<For each={[...store.todos]}>`                                      | yes                     |
| `<Label text={store.title} />`, `<Card s={store} />`, `<Item todo={t} />`                        | yes                     |
| `{getStore().count}`, `<For each={[...getTodos()]}>`                                             | yes: it calls something |
| `const todos = store.todos` then `{todos.length}`, `<For each={todos}>`, in a module or imported | yes                     |
| `const box = { store }` then `{box.store.count}`; `const t = createStore(...)` then `{t[0].n}`   | yes                     |
| `function useTodos() { return store; }` then `<For each={useTodos().list}>`, its rows' reads     | yes                     |
| `<Show when={store.user} keyed>{(u) => <p>{u.name}</p>}</Show>`                                  | yes                     |
| `<For each={props.todos}>`, a caller passing `todos={store.todos}`, and its rows' `{t.title}`    | yes                     |

A production build sees every caller of a component it does not export from an entry or use as a value, so it is exact: only a prop some call site passes a store costs a copy and bound rows, and an app that passes none compiles as before. A file compiled alone (a dev server, a library's entry) cannot see who calls the components it exports, so it pays for what it cannot see: each `<For>` over a prop of one reads a copy and binds its rows, as the prop may be a store. The store itself is always current: a hole the compiler cannot follow (a store made by a re-export of `createStore`) keeps the value it was written with until the content around it is built again.

### Context and error boundaries

```tsx
import { createContext, useContext } from "@reactre/core/features/context";
import { Errored } from "@reactre/core/features/errors";

const Theme = createContext("light");
const Label = () => <b>{useContext(Theme)}</b>;

const App = () => (
  <Errored fallback={(err, reset) => <button onClick={reset}>{String(err)}: retry</button>}>
    <Theme value="dark">
      <Label />
    </Theme>
  </Errored>
);
```

A context is a component, as in Solid 2.0: there is no `.Provider`. What its children make finds its value then and later: a slot's next content, a `<For>`'s next row, an effect's next run, a `createRoot` or a `runWithOwner` with an owner kept from under it. `value` is read once, when the provider runs; to share something that changes, provide a signal's read function. A provider of `undefined` is no provider. A function child renders as a slot under the provider.

`<Errored>` catches what is thrown while its children are built (a component's body, an effect's first run, a row's creation) and while they update (an effect's or a slot's later run, a row's reactive holes). What the children made is disposed, and the fallback shows once the run that threw, and every run around it, has ended, before the write that caused it returns. The first error is the one shown, and what the fallback throws goes to the boundary above. Event handlers, timers and promises throw to their caller, as in Solid. A row's hole that a selector's change re-runs throws in the selector's effect, so its error goes to the boundary around the `selector()` call.

A provider and a boundary read their children inside themselves, so they need them unbuilt. The compiler passes children that hold JSX as a getter ([Props](#props)), so `<Theme value="dark"><Label /></Theme>` and `<Errored>` work as written above, and a boundary catches what its child's component body throws. Called by hand, give them a getter (`get children()`) or a function child. They read their children in a slot, as an element follows `{props.children}`, so a child that may change (`{more() ? <Label /> : null}`) is read again under them when it does.

An effect's own handler is an option of the effect, as Solid 2.0's `createEffect` has it: `effect(fn, { error })` from this module hands what a run of `fn` throws to `error` (untracked), and the effect keeps following what the run read before it threw. Without a boundary or `onError`, an error is thrown on to the write or the `render` that caused it, as without the module.

Each module installs itself as it loads: context makes every owner keep the scope it was made in, and errors puts a try around every effect's run and a row's re-run. Neither is in the code of an app that does not import it: the size profiles without them are the same code as before, byte for byte with local names left unminified. With them, [`sizes.json`](sizes.json)'s `context` profile (a provider and its lookups) is 3,368 bytes gzipped, and `errors` (a boundary and its reset) 3,462: about 0.47 KB and 0.56 KB over the `slot` profile, an app with ownership alone.

### Async data and actions

```tsx
import { Loading, isPending, memo, refresh } from "@reactre/core/features/async";
import { action, createOptimisticStore } from "@reactre/core/features/actions";

const user = memo(async () => (await fetch(`/users/${id()}`)).json());
const [todos, setTodos] = createOptimisticStore(async () => (await fetch("/todos")).json(), []);

const add = action(function* (title: string) {
  setTodos((d) => {
    d.push({ id: -1, title }); // shows at once, reverts when the action's transition ends
  });
  yield fetch("/todos", { method: "POST", body: title });
  yield refresh(todos);
});

const App = () => (
  <Loading fallback={<p>Loading...</p>}>
    <h1 class={isPending(() => user()) ? "dim" : ""}>{user().name}</h1>
    <ul>
      <For each={todos} key={(t) => t.id}>
        {(t) => <li>{t.title}</li>}
      </For>
    </ul>
  </Loading>
);
```

These are Solid 2.0's async model and actions. A memo may return a Promise or an async iterable; reading it before it has a value throws a not-ready signal, which the nearest `<Loading>` catches: its children are built at once, off the page, and go in when everything under it that waited has run again with a value. From then on it keeps them: an update that makes an async memo compute again is a transition, which holds the effects it would run, so the page keeps the old values until the new ones have come, and then shows them together. `isPending` is true meanwhile, and `latest` reads past the hold. An action is a generator run in that transition: an optimistic write in its code shows at once, and the transition ends when the action has returned and what it waits for has come. In TSX, an optimistic store is a store root, as `createStore`'s is (see the store reads above): `<For each={todos}>` follows its pushes and reverts, and `{t.title}` in its rows follows the item.

They need the core's async runtime, which is a build of its own: `@reactre/core`'s default build has none of its code, so an app that imports neither module ships what it did without them (the size profiles are the same code, byte for byte). [@reactre/plugin](https://www.npmjs.com/package/@reactre/plugin) picks the async build for a program that imports either module, and so does the compiler's Bun plugin; without them, resolve `@reactre/core` with the `"reactre-async"` export condition (`"development"` resolves the [development build](#development-build), which has it too). Imported with the default build, either module throws, naming the fix. Bun resolves the sources (the `bun` condition), which hold the async runtime: in `Bun.build`, both plugins strip it from them for a program that imports neither module, as the default build is made; `bun run` and `bun test` run them as they are, the async runtime inert until one of the modules loads. With it, [`sizes.json`](sizes.json)'s `async` profile (an async memo under a `<Loading>`, and `isPending`) is 5,315 bytes gzipped, and `actions` (an optimistic value and an action) 4,501.

Where reactre differs from Solid 2.0:

- Writes apply at once, as everywhere in reactre: a transition holds effects, not writes, so a write's new value is read at once outside an effect, and `latest` only marks the effect that reads through it as one the transition does not hold.
- One transition is open at a time: updates and actions that overlap end together.
- `isPending` is false for a plain signal that a transition holds the readers of; it is true for an async memo computing for an update (and what reads it) and for what `affects` marks.
- A slot that runs again and reads something not ready keeps its old nodes on the page, frozen, until the value has come.
- A memo made before either module loaded stays a plain memo.
- In an async generator action, code after an `await` runs outside the action: yield the Promise instead.
- An optimistic write outside an action sets the base value.
- `createStore` and `createProjection` from `@reactre/core/features/store` take no async function, since that would cost every app that uses stores: read an async memo in `fn`, or use `createOptimisticStore`. `memo` from `@reactre/core/features/memo` stays synchronous.

## Timing

Writes apply at once: a signal's write re-runs its readers before it returns. In a `batch` (and in a `<For>` row's handler, which is batched), they apply when the outermost batch ends, each effect once. `flush(fn)` is `batch(fn)` that applies before it returns even inside another batch, and `flush()` in a batch applies what it has queued so far.

`onSettled(fn)` runs `fn` once the work under way has finished:

- Called in a batch or a `flush(fn)`, or in an effect that their writes re-ran (a slot rendering new content), `fn` runs at the batch's end, after every effect its writes queued, before `batch` or `flush` returns.
- Called anywhere else (a component rendered by `render` or `attach`, an effect re-run by a write outside any batch), `fn` runs in a microtask: after the code that called it has returned, and before the browser paints. `flush(() => render(App, el))` runs it before `flush` returns.

In a component, the view is in the page either way. `fn` runs under the component's owner, and not at all if the owner goes first (a slot replaced the content); a function it returns runs when the owner goes.

### Effects and list functions

```tsx
import { autorun, bind, onFlush } from "@reactre/core/features/effects";
import { map, repeat } from "@reactre/core/features/lists";

function Field(props: { label: string; focused: boolean }) {
  const input = <input /> as HTMLInputElement;
  bind(
    () => props.label,
    (label) => input.setAttribute("aria-label", label), // at once, while the view is built
  );
  autorun(() => {
    if (!props.focused) return;
    input.focus(); // first run once the view is in the page
    const t = setInterval(() => console.log(input.value), 1000);
    return () => clearInterval(t);
  });
  return input;
}

const select = (id: string) => {
  onFlush(() => setOpen(false)); // a write of its own, after this handler's
  setRoute(id);
};

const labels = map(todos, (todo, i) => memo(() => `${i() + 1}. ${todo.title}`));
const page = repeat(() => 20, (i) => rowAt(i), { from: () => offset() });
```

These are Solid 2.0's render effects, tracked effects, `onFlush`, `mapArray` and `repeat`, under reactre's names: `bind` is `createRenderEffect`, `autorun` is `createTrackedEffect`, `map` is `mapArray`.

- `bind(compute, apply, { defer, schedule })`: `compute(prev)` is tracked and owns what it makes; `apply(value, prev)` runs untracked after each of its runs, a value equal to the last one too, with the value it was last given as `prev`. It runs at once, where it is made, so in a component while the view is built, and again when what `compute` read changes. A function `apply` returns is a cleanup, run after `compute`'s next run, before the next `apply`, and when the owner goes. `defer` skips the first `apply`; `schedule` makes it wait for the flush.
- `autorun(fn)` runs `fn` tracked and again when what it read changes, as `effect` does, but its first run waits for the flush: the end of the batch's drain it was called in, after the effects that batch queued, or else the next `flush()` or batch end, or a microtask. In a component, the view is in the page by then, and a `bind` made beside it has run. A function `fn` returns is a cleanup; it does not run at all if its owner goes first.
- `onFlush(fn)` runs `fn` in a microtask, after the batch or `flush(fn)` it was called in, untracked and with no owner. The callbacks of one microtask run in call order, in one batch. A write in `fn` is an update of its own: with features/async, one that a transition does not hold, unless what it changes reads the async value too.
- `map(list, fn, { keyed, fallback })` returns an accessor of `list()` mapped by `fn`. Each item is mapped once, untracked, under an owner of its own, which is disposed when the item leaves (and the rest with the owner `map` was made in). By default rows are kept by the item itself, and `fn(item, index)` gets an accessor of its index; `keyed: (item) => key` keeps them by key, and `fn` gets accessors of the item and the index; `keyed: false` keeps them by position, and `fn(item, i)` gets an accessor of the item at index `i`. The array is new when the rows change and the same when they do not; `fallback` is what it holds while the list is empty.
- `repeat(count, fn, { from, fallback })` is the same for indexes: `fn(i)` for each `i` from `from()` (0) to `from() + count() - 1`, kept while the range keeps it.

An update of `map` or `repeat` is staged: if `fn` throws, the rows it made are disposed and the list is as it was. A cleanup `bind` or `autorun` gets that is not a function or undefined throws, as Solid's development build does. Where reactre differs from Solid 2.0: writes apply at once, so a later run of `bind` or `autorun` is at the write, not at a flush; `reaction` (Solid's `createEffect`) applies at once too, so it is not held for a user phase after the render effects, and a `bind` made after it applies after it; as in Solid's development build, `autorun`'s function makes no memo, effect, root, slot or cleanup in the [development build](#development-build), and production does not check. On the server, `map` and `repeat` work as in the browser; a server build points the app's imports of features/effects at a server version, where `bind` computes and never applies (Solid's server render effect applies once), and `autorun` and `onFlush` never run.

Neither module is in the code of an app that does not import it, and each costs only what it is: [`sizes.json`](sizes.json)'s `effects` profile (a component with a `bind` and an `autorun`, and an `onFlush`) is 3,303 bytes gzipped, and `lists` (a `map` with an index memo per row, and a `repeat`) 3,849.

## Server rendering

```tsx
// server.tsx, built for the server
import { renderToStream, renderToString } from "@reactre/core/server";

import { App } from "./app.tsx";

const html = renderToString(() => <App />); // at once: a <Loading> that waits shows its fallback
const res = new Response(renderToStream(() => <App />), { headers: { "content-type": "text/html" } });
```

`@reactre/core/server` renders an app to HTML. The app's files are compiled for the server, where JSX builds strings: an element is its markup with its holes escaped, a component runs once, and control flow (`<Show>`, `<Switch>`, `<For>`, `<Repeat>`, `<Dynamic>`) is evaluated once. Signals, memos, stores, context and `<Errored>` work as they do in the browser (a boundary renders its fallback when its children throw); effects do not run, and a memo computes when it is first read. `<Portal>` renders nothing: its children belong to another part of the page. `isServer` is true there, and false in a browser bundle, which gets a stub of the module.

- `renderToString(app, options?)` returns the HTML at once. A `<Loading>` whose children read async data that has not come renders its fallback.
- `renderToStream(app, options?)` returns a `ReadableStream` of the HTML. The shell comes once what it reads outside every `<Loading>` is ready, with each `<Loading>` that still waits showing its fallback; then each one's content as its data comes, in a `<template>` with a small script that swaps it in for the fallback (the first such chunk defines the script, `self.$rr`). Nested and sibling boundaries stream in the order their data comes. An error while the shell renders errors the stream; a later one goes to an `<Errored>` inside the boundary, or else to `onError`, and errors the stream. Cancelling the stream stops the render.
- `renderToStringAsync(app, options?)` waits for everything and returns the whole page, with no script but the one of its [hydration values](#hydration-values), if it wrote any.

Options: `hydrate: true` writes comment markers that hydration claims the page by (below); `nonce` is set on the render's scripts (a stream's, and the hydration values'), for a Content Security Policy; `onError` gets an error thrown after the shell was sent; `response` is the head of the response the render serves, which `httpStatus` and `httpHeader` write to.

```tsx
import { httpHeader, httpStatus, renderToString, type ResponseHead } from "@reactre/core/server";

const NotFound = () => {
  httpStatus(404, "Not Found");
  httpHeader("cache-control", "no-store");
  return <h1>Not found</h1>;
};

const response: ResponseHead = { status: 200, headers: new Headers({ "content-type": "text/html" }) };
const html = renderToString(() => <App />, { response });
return new Response(html, response);
```

`httpStatus(code, text?)` and `httpHeader(name, value, { append })` declare the response's status and a header while the scope they are called in lives: when it goes (an `<Errored>` showing its fallback over the children that declared a 404, a `<Show>` branch that is no longer shown), its declaration is taken back, and the head is what the live ones make of its own, in the order they were made (`set-cookie` keeps each cookie its own entry). The head is final when the render commits it: when `renderToString` returns, when `renderToStream` sends its shell, and when `renderToStringAsync`'s Promise resolves; after that, and outside a render, they do nothing, as they do in a browser bundle. `httpHeader` throws a `TypeError` for a name or a value `Headers` refuses.

Builds: [@reactre/plugin](https://www.npmjs.com/package/@reactre/plugin) compiles for the server with its `ssr: true` option: in Vite, its SSR builds and its dev server's `ssrLoadModule` (Vite's environment says which), and in the other bundlers, a separate build for the server. Without the option every build is the browser's. The compiler's option is `compileJs(js, { server: true })`, and its Bun plugin's `reactreCompiler({ server: true })`. A server build points the app's imports of `@reactre/core` and its feature modules at the server's versions. The browser build of the same app is what it is without SSR, byte for byte, and hydrates with `hydrate: true` (in Vite, `reactre({ ssr: true, hydrate: true })` does both).

### Hydration

```tsx
// client.tsx, built with @reactre/plugin's `hydrate: true`
import { hydrate } from "@reactre/core/features/hydrate";

import { App } from "./app.tsx";

hydrate(() => <App />, document.getElementById("app")!);
```

`hydrate(view, el)` from `@reactre/core/features/hydrate` runs the view over `el`'s content, which the server rendered from the same app with `hydrate: true`: the server's nodes stay, and the view's holes, handlers, refs and effects attach to them, as `render` attaches them to nodes it builds. It returns the view's disposer, as `attach` does. `isHydrating()` is true while code runs that claims the page.

- A context's provider and its children, an `<Errored>` that showed its fallback on the server (it shows it on the client too, and `reset` builds the children), and a `<Loading>` whose children the server rendered are claimed too. The client reads its async data again: until a value comes, what reads it keeps the server's nodes, and the boundary does not show its fallback. A `<Loading>` whose fallback `renderToString` wrote is built afresh, and one a stream has not sent yet keeps the server's fallback and hydrates when its content is swapped in.
- Where the page does not match (another tag, a missing node, other text), the nearest slot, list row or streamed boundary renders afresh; outside every slot, the whole view does. The development build warns, `reactre HYDRATION_MISMATCH`.
- The app is compiled for it: @reactre/plugin's `hydrate: true` option, or the compiler's `hydrate` compile option. `hydrate` over code compiled without it throws, naming the option, and so does compiling a file that imports `hydrate` without it; a page rendered without the markers, where the view needs them, throws naming `renderToString(app, { hydrate: true })`.
- The server's errors stay out of the page in production: an `<Errored>`'s marker names the error and gives its message only from the server's development build (`dist/dev/server.js`, which the `"development"` condition resolves, as Vite's dev server's `ssrLoadModule` does; the plugins give a production build the other one). In production the client's fallback gets an `Error` saying the server's error was kept out, so a fallback that shows `err.message` should show a message of your own instead.
- An app that does not hydrate ships none of it: the browser's build without the option is what it was. Hydration adds about 1.9 KB gzipped ([`sizes.json`](sizes.json)'s `hydrate` profile, against `plain`).
- `clientOnly(() => import("./Chart.tsx"))` is a component the server never renders: it writes `props.fallback`, never loading the module, and the browser renders the module's default export (or, with `export: "Name"`, that export) with the other props once it has loaded and, hydrating, once the page has hydrated. The module starts to load when `clientOnly` is called, or with `lazy: true`, when the component first renders. It works rendering afresh too.

[plans/core-hydration.md](../../plans/core-hydration.md) is the design, with what it leaves out.

### Hydration values

```tsx
// a library's code, shared by the server and the client
import { getHydrationWriter, takeHydrationValue } from "@reactre/core/features/hydrate";

function cached(key: string, load: () => Promise<User>): Promise<User> {
  const got = takeHydrationValue<User>(key); // in the browser: what the server wrote, once
  if (got?.status === "resolved") return Promise.resolve(got.value);
  const p = load();
  getHydrationWriter()?.write(key, p); // on the server: sent to the client with the page
  return p;
}
```

A server render's hydration writer (`getHydrationWriter()`, undefined outside a render and in the browser) sends values to the client under keys: `write(key, value)` puts the value in the page, and `takeHydrationValue(key)` in the browser takes it out, as `{ status: "resolved", value }` (or undefined when there is none, or it was taken already). A shared module imports both from `@reactre/core/features/hydrate`, which a server build points at the server's. `renderToString` sends values that are ready; `renderToStream` and `renderToStringAsync` take a Promise too, sent as pending and then as what it settled to (`takeHydrationValue` gives `{ status: "pending", promise }` meanwhile, and `"rejected"` with its error), and wait for it before they end; with `{ deferStream: true }`, a stream's shell waits for it. The first write of a key wins. Prefix keys with your library's name.

The values go in the page as data, never as code: JSON in `<script>` tags with the render's `nonce`, with `<`, `>`, `&`, U+2028 and U+2029 escaped, so no value can end the script or open a comment; into `self.$rrd`, a registry of no prototype. A value is what JSON holds, or undefined, NaN, the infinities, -0, a bigint, a Date, a Map or a Set, anywhere in it; `write` throws a `TypeError` naming the key for a function, a symbol, an instance of a class, a cycle, and a key named `__proto__` (the writer's, or an object's in the value). A rejected Promise's error goes with its name and message from the server's development build only; in production the client gets an `Error` saying it was kept out.

### The memo's options on the server

```tsx
import { memo } from "@reactre/core/features/async";

const user = memo(() => fetch(`/api/users/${id()}`).then((r) => r.json()), { id: "user" });
const posts = memo(() => fetchPosts(id()), { loadingValue: [] });
const clock = memo(() => readClock(), { ssrSource: "client" }); // under a <Loading>
```

An async memo from `@reactre/core/features/async` takes Solid 2.0's options:

- `id`: in a render with `hydrate: true` that waits (`renderToStream`, `renderToStringAsync`), the server writes the memo's first value under the id, and the hydrating client takes it as its first value instead of computing it. The client runs `fn` once, with `fetch` sending no request, only to learn what it reads, and computes when that changes. A memo of `from(source)` reconnects, showing the server's value until the source sends. Without an id, nothing is sent and the client computes, as before. An id is unique on the page.
- `ssrSource`: `"server"` (the default) as above; `"hybrid"`, an async iterable the memo returns goes on in the client after the server's value (its first value, which the server sent, is dropped); `"client"`, the server never computes the memo, and what reads it waits for good: its `<Loading>` writes its fallback, which the client replaces once the page has hydrated (read outside every `<Loading>`, it throws, naming the fix). With a `loadingValue`, the server writes that instead.
- `deferStream: true`: a stream's shell waits for the memo's first value instead of showing a `<Loading>`'s fallback for it.
- `transparent: true`: hydrating, the memo takes nothing from the server and computes, for a memo the server does not make.
- `loadingValue`: the memo's value until its first comes, in the browser and on the server; no `<Loading>` waits for it, and `isPending` is false.

A call that passes none of them compiles to the memo it was before they existed, so an app that passes none ships what it did (the compiler sends it to `__memo`); a call the compiler does not see (a `.ts` file, a dependency) gets the options it passes.

## What an app ships

An app ships only what it uses. With a bundler that tree-shakes (all of the plugin's do), two parts of the runtime come only when the app needs them:

| Feature                         | How it comes                                                                                                                                                                                                           | Cost, gzipped | Without it                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership                       | By use: `effect`, `memo`, a slot (a JSX expression that may change, `{cond() ? <A /> : <B />}`), a fragment, a row holding components, lists or slots, or `attach`. Nothing to turn on.                                |        0.3 KB | Nothing in the app needs it: with none of those, no effect is ever made inside another's run, so there is nothing to dispose.                                                                                                      |
| Rows with several selector keys | `import "@reactre/core/features/selectors"`. The compiler adds the import itself to a file whose `<For>` row makes two or more calls with arguments in its reactive holes (`isSelected(row.id)`, `isHovered(row.id)`). |       0.16 KB | A row that reads a second selector key, or the same selector with a second key, throws an error naming the import. Only a row that reads the keys through a function of its own (`class={classes(row)}`) needs the import by hand. |

Control flow is not a feature to turn on either: it compiles to slots, memos and lists (most of it holds a slot, so it brings ownership), and only the class-list helper is code of its own, in an app only where it uses one (`dynamic()` is a feature module, above). An app with a `<Show>`, a `<For>` fallback and a class list ([`sizes.json`](sizes.json)'s `show`) is 5,962 bytes gzipped.

Props cost only where they may change: a call site passes a getter only for a prop that may, and a component binds a hole that reads a prop only when some call site may pass it so. Spread props at a component call (`<C {...props} />`) bring the small helper that keeps their getters. An app whose components get only literals and plain names compiles to the same code as before; [`sizes.json`](sizes.json)'s `props` profile is an app that passes props reactively, spreads them and builds children lazily.

Ownership is what makes `effect` own the effects and cleanups its run makes, a slot dispose its old content, a row dispose what it holds when it leaves, and `attach` return a disposer. `onCleanup` itself costs a few bytes: called where nothing owns (at module scope, in a view given to `render`), it does nothing.

The js-framework-benchmark app (`apps/jfb/app/reactre.tsx`, a keyed list with a selector and delegated handlers) comes to 6.6 KB gzipped (6,726 bytes, app included), against 6,871 bytes for 0.0.2, which had neither feature. The whole package, with every feature, is 7.0 KB. [`sizes.json`](sizes.json) holds the budgets that `test/features.test.ts` checks.

## Development build

On a dev server, the core checks what it runs and warns, with a code and a fix, about mistakes that render without an error:

| Code                            | What it finds                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REACTIVE_WRITE_IN_OWNED_SCOPE` | A signal written while a memo, a template hole or a `<For>` row's hole computes its value: what read it re-runs in the middle of an update. Write in a handler or an effect, or derive the value with `memo`.                          |
| `FOR_DUPLICATE_KEY`             | Two items of a `<For>` with one key: a key has one row, so one of them is not shown as its own.                                                                                                                                        |
| `FOR_UNSTABLE_KEY`              | An item of a `<For>` whose key changed since the last render (a key made anew each time, an index, a counter), so its row is built again.                                                                                              |
| `FUNCTION_AS_TEXT`              | A function rendered where text goes (`{count}` for `{count()}`), which shows its source.                                                                                                                                               |
| `ATTRIBUTE_HANDLER`             | A function in a lowercase `on*` spread prop (`{...props}` holding `onclick`, or `onclick={fn}` beside a spread), which becomes an attribute's text. Write `onClick`. An element's own `onclick={fn}` sets its property, and listens.   |
| `STRING_HANDLER`                | A string in a spread prop that is an inline handler attribute, in any case (`{ onclick: "..." }` from data), which would run as code: it is left out, in every build, and so on the server. `one` stays. Pass a function as `onClick`. |

Each is warned once per signal, list, template or prop it is found in. And a `<For>` row's hole that writes a signal it reads, which re-runs the row from inside its own run, throws `FOR_ROW_LOOP` after 100 rounds, as an effect that never settles does; the production build overflows the stack there instead.

The feature modules throw Solid 2.0's development errors for what it forbids, with a code and a fix:

| Code                           | What it finds                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIMITIVE_IN_FORBIDDEN_SCOPE` | An effect (a `bind` and an `autorun` too), a memo, a root or a slot made in an `autorun`'s function or in an `onSettled` callback that has an owner.                             |
| `CLEANUP_IN_FORBIDDEN_SCOPE`   | `onCleanup` called there: return the cleanup from the callback instead. A nested `onSettled` is allowed.                                                                         |
| `FLUSH_IN_SETTLED`             | `flush()` in an `onSettled` callback that has an owner: its writes apply in the same drain without it.                                                                           |
| `INVALID_CLEANUP`              | An `onSettled` callback or a `reaction`'s `apply` that returned something other than a function or `undefined` (an async function's Promise, mostly).                            |
| `SETTLED_CLEANUP_UNOWNED`      | An `onSettled` callback outside any owner that returned a cleanup, which nothing would run.                                                                                      |
| `CONTEXT_NOT_FOUND`            | `useContext` of a context with no default and no provider above; its message names the context by `createContext(default, { name })`, and says when the default was `undefined`. |
| `CONTEXT_PROVIDED_UNDEFINED`   | `useContext` under a provider of `undefined`, which is no provider: provide `null` for an empty value.                                                                           |

Both errors of context are `ContextNotFoundError`s, whose production message names neither case. And an `<Errored>` whose fallback is an element, or a function of no arguments, logs the error it caught with `console.error`, as Solid's development build does: the fallback does not show it.

The checks are in the core's development build, `dist/dev` (the feature modules': `dist/dev/features/{owner,context,errors,timing,reaction,effects}.js`, beside `memo` and `hydrate`), and a production build ships none of them. The builds:

| Build         | What it is                               | Resolved by                                                                                |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `dist/`       | the default: no async runtime, no checks | the `"default"` condition; @reactre/plugin, for a production build of an app without async |
| `dist/async/` | the async runtime, no checks             | `"reactre-async"`; @reactre/plugin, for a production build of an app with async            |
| `dist/dev/`   | the async runtime and the checks         | `"development"`; @reactre/plugin, on Vite's dev server                                     |

@reactre/plugin gives Vite's dev server the development build, and every build a production one, whatever the bundler's conditions resolved (a `"development"` condition holds in builds too: Bun.build's outside production, Vite's where `NODE_ENV` is not `"production"`). The compiler's Bun plugin gives a `Bun.build` a production one. `bun run` and `bun test` run the sources, which hold the checks, as they hold the async runtime. The checks sit between `// #if DEV` markers in `src/index.ts` and the feature modules, which the production builds strip as they strip the async runtime, so their code is the same as before the checks existed, byte for byte, and so is every size profile. With them, the benchmark app is [`sizes.json`](sizes.json)'s `dev` entry, 8,039 bytes gzipped (with the async runtime), a note rather than a budget anyone ships.

## Browsers and bundlers

reactre runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, with their type declarations, and its TypeScript sources, which Bun runs directly. Editors and type checkers read the declarations, so your compiler settings never type-check reactre's sources.

## License

[Apache-2.0](LICENSE)
