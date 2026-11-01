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

A row can also hold components, nested `<For>` lists and JSX expressions. They belong to the row: a new item for the row's key builds them again, and they are disposed when the row leaves. A row of plain elements does none of this work.

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
- Children that hold JSX are a getter too: they are built when the component reads `props.children`, after the code it runs before that. A provider can set things up first and then return `props.children`. `{props.children}` in an element inserts them, nodes or text.
- Read props through the object: `props.text`. Destructuring (`({ text }) =>`), or `const { text } = props`, reads each value once, when the component runs, and it then stays the value it had.
- `<Child {...props} />` passes the props on, getters included.
- What it costs: a hole that reads a prop is bound (an effect that rewrites it) only if some call site of the component may pass that prop reactively. Above, `{props.text}` is bound because one call passes `name()`; if every call passed text, it would be written once, as before. @reactre/plugin and the compiler's Bun plugin read the whole program at a production build's start to know this. A component whose callers cannot all be seen is treated as getting every prop reactively: one an entry exports (a library's API), one used as a value (`<Dynamic component={Label}>`, `const C = Label`), one called with spread props, and, on a dev server or in watch mode, where each file is compiled alone, every component the file exports.

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
- `<Repeat count from>` is a row per index, from `from` (0 by default) to `from + count - 1`: a keyed `<For>` over the indexes, so a row is built once per index and kept while the count keeps it. It takes a `fallback` too.
- `<Portal mount>` puts its children at the end of `mount` (`document.body` by default, read once) and takes them out when what holds it goes away: a `<Show>` that hides it, a row that leaves, `attach`'s disposer.
- `<Dynamic component>` renders a component, called with the other props, or for a tag name, that element with them (applied as spread props, so they follow what they read); null renders nothing. A `component` that reads a signal rebuilds it when it changes, and a tag written as a string (`component="h1"`) compiles as if the element were written out. `dynamic(() => source())`, from the feature module `@reactre/core/features/dynamic`, is the same as a component of its own, to name or hand on.

`<For>` and `<Repeat>` render into their parent element, so they stand as an element's child, not directly inside a fragment, a `<Show>` or a `<Switch>` (wrap them in the element they fill). A `<Match>` stands only in a `<Switch>`. What the compiler cannot compile is a compile error that says so.

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
| `<For each key>`      | A keyed list in TSX, with a `fallback` while it is empty.                                       |
| `<Show when>`         | Its children while `when` is truthy, else `fallback`.                                           |
| `<Switch>`/`<Match>`  | The children of the first `<Match>` whose `when` is truthy, else `fallback`.                    |
| `<Repeat count>`      | A row per index, from `from` to `from + count - 1`.                                             |
| `<Portal mount>`      | Its children in another element, `document.body` by default.                                    |
| `<Dynamic component>` | A component or a tag name's element, chosen by a value.                                         |
| `render(view, root)`  | Mounts a TSX view into an element, for good.                                                    |
| `attach(view, root)`  | `render`, returning a function that removes the view and stops its effects.                     |

## Feature modules

`@reactre/core` itself holds what the compiler makes free. Runtime APIs beyond it are feature modules, imported by path: an app that does not import one ships none of its code, and its updates run as before.

| Import                            | Export                               | What it does                                                                                                                                  |
| --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@reactre/core/features/owner`    | `createRoot(fn)`                     | Runs `fn(dispose)` under a new owner; `dispose` stops what it made. It goes with the owner it was made in.                                    |
|                                   | `getOwner()`                         | The current owner, or null.                                                                                                                   |
|                                   | `runWithOwner(o, fn)`                | Runs `fn`, untracked, with `o` as the owner of what it makes; null makes it belong to nothing.                                                |
| `@reactre/core/features/timing`   | `onSettled(fn)`                      | Runs `fn` once, untracked, when the work under way has finished and the DOM shows it ([timing](#timing)). A function it returns is a cleanup. |
|                                   | `flush(fn?)`                         | `flush(fn)` runs `fn` and applies its writes before it returns, inside a batch too. `flush()` applies what the current batch has queued.      |
| `@reactre/core/features/reaction` | `reaction(compute, apply)`           | An effect in two halves: `compute` is tracked, `apply(value, prev)` runs untracked when the value changes, and may return a cleanup.          |
| `@reactre/core/features/dynamic`  | `dynamic(source)`                    | A component that renders what `source` returns, as `<Dynamic>` does.                                                                          |
| `@reactre/core/features/store`    | `createStore(value)`                 | `[store, setStore]`: a deep reactive proxy, whose reads subscribe per property (arrays by index and `length`), and a setter given a draft.    |
|                                   | `createStore(fn, seed)`              | A derived store that can be written: `fn(draft)` runs tracked; a write holds until it runs again. `{ shallow: true }` for a one-layer store.  |
|                                   | `createProjection(fn, s)`            | A read-only derived store: what `fn(draft)` returns is reconciled into it by `key` ("id" by default).                                         |
|                                   | `reconcile(value, key?)`             | A setter's function that writes only what differs, keeping items of the same key ("id"; null for by index).                                   |
|                                   | `snapshot(s)`, `deep(s)`             | A plain deep copy, untracked; `deep` subscribes to every property first.                                                                      |
|                                   | `merge(...s)`, `omit(o,…)`           | Props helpers whose properties are getters of their sources, so reactive props stay reactive. In `merge`, a later `undefined` overrides.      |
| `@reactre/core/features/memo`     | `memo(fn, { equals })`               | `memo` with `prev` and an equality of its own; `equals: false` re-runs readers each time.                                                     |
|                                   | `signal(fn)`                         | A writable derived signal: `fn(prev)` recomputes it when its sources change; a write sets it until then. `signal(v, { equals })` too.         |
| `@reactre/core/features/context`  | `createContext(default?)`            | A context, which is a component: `<Ctx value={v}>` provides `v` to what its children make, then and later.                                    |
|                                   | `useContext(ctx)`                    | The nearest provider's value, else the default; with no default, it throws `ContextNotFoundError`.                                            |
| `@reactre/core/features/errors`   | `<Errored fallback>`                 | Its children, or `fallback` (an element, or `(err, reset) => ...`) once something they made throws. `reset()` builds them again.              |
|                                   | `effect(fn, { error })`              | The core's `effect`, with a handler for what its runs throw.                                                                                  |
|                                   | `configureClientErrors({ onError })` | Gets what an effect, a slot or a row throws outside any boundary.                                                                             |

```tsx
import { createRoot } from "@reactre/core/features/owner";
import { flush, onSettled } from "@reactre/core/features/timing";
import { dynamic } from "@reactre/core/features/dynamic";
import { createStore, reconcile } from "@reactre/core/features/store";
import { memo, signal } from "@reactre/core/features/memo";
import { createContext, useContext } from "@reactre/core/features/context";
import { Errored } from "@reactre/core/features/errors";
```

`onSettled`, `flush`, `createRoot`, `getOwner` and `runWithOwner` are Solid 2.0's, and `reaction` is its `createEffect(compute, apply)`, under MobX's name. `<Dynamic>` stays in `@reactre/core`, since it is compiled away; `dynamic()` is the runtime function beside it. Rows with several selector keys are a feature module too (see [What an app ships](#what-an-app-ships)).

The store APIs are Solid 2.0's, under its names: setters are draft-first (`setStore((s) => { s.todos.push(todo) })`, with a block body, since an object the setter returns replaces the store's contents). `memo` and `signal` from `@reactre/core/features/memo` take core's arguments as core's do, plus Solid 2.0's options; its `lazy` and `unobserved` are left out, since core's signals do not count their readers. In TSX, a store read is reactive where the compiler sees a call, as a signal read is:

```tsx
<p>{store.count}</p>              // written once: the hole calls nothing
<p>{store.count.toString()}</p>   // follows store.count
<For each={[...store.todos]} key={(t) => t.id}>   {/* a new array, read tracked: follows pushes and removals */}
  {(t) => <li class={t.done ? "done" : ""}>{t.title.trim()}</li>}   {/* the title follows t.title; the class is written once */}
</For>
```

`each={store.todos}` renders the array once and then only when `store.todos` is given a new array, since a `<For>` reads the array it is given untracked and needs a new one for each render; spread it. A row's hole that reads only its item is compared when the row gets a new item, and a store's items change in place, keeping their proxies, so such a hole is written once: make it call something. A store read passed as a prop follows the same rule, since it is a member read and not a prop of the component around it: `<Label text={store.title} />` passes the value it had, and `text={store.title.trim()}` a getter that follows it.

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

Each module installs itself as it loads: context makes every owner keep the scope it was made in, and errors puts a try around every effect's run and a row's re-run. Neither is in the code of an app that does not import it: the size profiles without them are the same code as before, byte for byte with local names left unminified. With them, [`sizes.json`](sizes.json)'s `context` profile (a provider and its lookups) is 3,365 bytes gzipped, and `errors` (a boundary and its reset) 3,459: about 0.46 KB and 0.56 KB over the `slot` profile, an app with ownership alone.

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

Control flow is not a feature to turn on either: it compiles to slots, memos and lists (most of it holds a slot, so it brings ownership), and only the class-list helper is code of its own, in an app only where it uses one (`dynamic()` is a feature module, above). An app with a `<Show>`, a `<For>` fallback and a class list ([`sizes.json`](sizes.json)'s `show`) is 5,962 bytes gzipped.

Props cost only where they may change: a call site passes a getter only for a prop that may, and a component binds a hole that reads a prop only when some call site may pass it so. Spread props at a component call (`<C {...props} />`) bring the small helper that keeps their getters. An app whose components get only literals and plain names compiles to the same code as before; [`sizes.json`](sizes.json)'s `props` profile is an app that passes props reactively, spreads them and builds children lazily.

Ownership is what makes `effect` own the effects and cleanups its run makes, a slot dispose its old content, a row dispose what it holds when it leaves, and `attach` return a disposer. `onCleanup` itself costs a few bytes: called where nothing owns (at module scope, in a view given to `render`), it does nothing.

The js-framework-benchmark app (`apps/jfb/app/reactre.tsx`, a keyed list with a selector and delegated handlers) comes to 6.6 KB gzipped (6,726 bytes, app included), against 6,871 bytes for 0.0.2, which had neither feature. The whole package, with every feature, is 7.0 KB. [`sizes.json`](sizes.json) holds the budgets that `test/features.test.ts` checks.

## Browsers and bundlers

reactre runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, with their type declarations, and its TypeScript sources, which Bun runs directly. Editors and `tsc` read the declarations, so your compiler settings never type-check reactre's sources.

## License

[Apache-2.0](LICENSE)
