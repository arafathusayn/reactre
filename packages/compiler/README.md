# @reactre/compiler

The Bun plugin that compiles [reactre](https://github.com/arafathusayn/reactre) TSX. Each JSX tree becomes a template, parsed once and cloned per instance, plus the code that keeps its holes up to date. Nothing is left to a JSX runtime.

```sh
bun add -d @reactre/compiler
```

```ts
import { reactreCompiler } from "@reactre/compiler";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  plugins: [reactreCompiler()],
});
```

## What it compiles

- Host elements and SVG, with holes that follow what they read, handlers, `style` as an object or a string, `value`, `checked` and `selected` as properties, `ref`, spread props, fragments, components (called once, with reactive props: see below) and `key`.
- `<For each key>`, a keyed list, with a `fallback` shown while `each` is empty. A list of element rows that is an element's child is the core's list (`__for`); a list anywhere else (a component's whole view, a fragment's child, control flow's content, a prop such as `<Errored>`'s children) or whose rows are text, fragments, arrays, components or content that may change is [`@reactre/core/features/for`](https://www.npmjs.com/package/@reactre/core#control-flow-and-elements)'s `__each`, imported only by a file that has one: its nodes, between markers of its own, as content. A row's function returns its content, compiled as control flow's children are (an expression that may change is a slot); a keyed row of two parameters gets an accessor of its index, and children that are not a function are each row's.
- `<Show when fallback keyed>` and `<Switch fallback>` of `<Match when keyed>`: a slot behind a memo of the condition (or of the matched case), so the content is rebuilt only when that changes.
- `<Repeat count from fallback>`: a keyed list over the indexes.
- `<Portal mount>`: its children inserted into another element (`document.body` by default), taken out when their owner goes.
- `<Dynamic component>`: a slot that calls the component or builds the tag's element; a tag written as a string (`component="h1"`) compiles as the element itself.
- `class` written as an object or an array literal (`class={{ active: on() }}`, `class={["btn", size(), { big: true }]}`): the classes it can see join the template, an object's other keys become `classList` toggles, and a list with an item it cannot see into is one string through a small helper, imported only by a file that has one.
- `ref={[a, b]}`, which gives the element to each ref.
- `defaultValue`, `defaultChecked`, `defaultSelected` and `defaultMuted`, set as properties.

Control flow (`Show`, `Switch`, `Match`, `Repeat`, `Portal`, `Dynamic`) is recognized by its import from `"@reactre/core"`, under any local name or through `import * as`, so a component of an app's own named `Show` or `Switch` stays a component. `<For>` is also matched by its name, as it always was. Each compiles to the slots, memos and lists compiled code already uses, so an app ships no runtime of its own for them. A file that uses none of them compiles to the same code as before they existed.

The output imports only the runtime helpers a file uses, so a bundler leaves out the rest. A `<For>` row that makes two or more calls with arguments in its reactive holes (`isSelected(row.id)`, `isHovered(row.id)`) may read two selector keys, and its file imports [`@reactre/core/features/selectors`](https://www.npmjs.com/package/@reactre/core#what-an-app-ships).

`@reactre/core` has a default build and one with the async runtime that `@reactre/core/features/async` and `/actions` need; its sources, which `Bun.build` resolves for target `"bun"`, hold both. As it reads the whole program (below), `reactreCompiler()` gives a program that imports neither module the core without that code, whichever the build resolved (target `"browser"` outside production resolves the async build): the default build, or the sources' `index.ts` stripped as that build is. A program that imports either gets the async runtime, and so does a build that reads no program (`wholeProgram: false`, or the plugin given to `Bun.plugin` for `bun run` and `bun test`, which run the sources as they are, the async code inert until a module turns it on). The `async` option (true or false) decides it, as [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin)'s does; with the default build, either module fails the build, naming the option.

## Text holes and slots

An element's child `{expr}` compiles to one of two things:

- A text hole: the template's text node, written with `expr`'s value as text (`"" + value`; null and undefined write nothing). One that calls nothing is written by the clone; one that may change is bound (`__bind`), which writes the node's text again when what it reads changes. It is the fast path, for strings and numbers: `{row.label}`, `{count()}`, `{fmt(n())}`.
- A slot: a marker where `expr`'s value is inserted (`__insert`), as nodes, arrays (flattened), components' views or text; null, undefined and booleans insert nothing. One that may change is followed (`__slot`), which inserts its new value in place of the last.

A child is a slot when the compiler can see it may hold nodes:

- JSX in it: an element, a component, control flow, a fragment, a conditional or a map of JSX.
- `{props.children}`, and a prop that some call site passes JSX (see Props); every prop of a component whose callers cannot all be seen.
- A name that holds JSX (`PropFacts.jsx`): a local made of JSX (`const el = <h1>Hi</h1>`, `const items = [<li />]`, an object or a `memo(() => <p />)` holding it), a function whose body holds JSX (`function make() { return <b />; }`, an arrow, an object's method), a local made of one of those, and in a whole program, a value or a function a package of it exports that is one (a workspace's package, which the build resolves into the program), through re-exports and namespace imports. A hole that mentions one (`{el}`, `{make()}`, `{on() ? a : b}`, `{o.render()}`) is a slot.
- An import from the app's own files, called or read, and a local made of one (`PropFacts.jsx` too): `{make()}`, `{ns.make()}`, `{obj.render()}`, `{el}`, `{ns.label}`, `{store.count}`, then `const x = make()` and `{x}`, `const mine = make` and `{mine()}`, `function fmt(n) { return t("n", n); }` and `{fmt(1)}`. The app's own files are those of a specifier that is a path or an alias of one (`./ui`, `../ui`, `/src/ui`, `~/ui`, `@/ui`, `#ui`), not a package's (`lib`, `lib/sub`, `@scope/lib`, `node:fs`, `virtual:x`), @reactre's or an asset's. A file compiled alone (a dev server, `compileSource`) cannot see what such an import holds, so the hole is a slot there; a whole program, which can, makes it a slot too, even when it holds text, so a dev server and a build render it alike. (Alone, a slot that may read a store is followed; the whole program sees which imports are stores, and inserts the rest once.) As in any slot, true, false and null from it render nothing, and a value or a function of the app's that is text (an i18n `t()`, a label) costs a slot where a hole reads it.
- A fragment's expression: `<div><>{value}</></div>` inserts `value` whatever the compiler knows of it, as a fragment that stands alone does.

Anything else is a text hole: what the compiler cannot see holds JSX is taken for text, so an app's holes of text cost no more than they did. That is a value or a function of a package that a file compiled alone imports (and that a whole program does not see hold JSX), a parameter's method. If such a hole is given nodes, it shows them as `[object HTMLElement]`, and the development build warns `NODE_AS_TEXT`; wrap it in a fragment (`<>{make()}</>`), or render it as a component (`<Make />`).

## Server mode

`compileJs(js, { server: true })` (and `compileJsWithMap`, and `reactreCompiler({ server: true })` for `Bun.build`) compiles a file for [@reactre/core/server](https://www.npmjs.com/package/@reactre/core#server-rendering). JSX builds HTML: an element tree is one string with its holes escaped in place, a component is called once with its props, `<Show>`, `<Switch>`, `<For>` (keyed, or by index with `keyed={false}`), `<Repeat>` and `<Dynamic>` are evaluated once (a list of `features/for` as its rows' content, or its fallback's, in one pair of hydration markers), and `<Portal>` renders nothing. A hole that may change is a thunk the server runs once, again only if it reads async data that has not come. The file's imports of `@reactre/core` and of `features/async` and `features/dynamic` go to their server versions, and its `effect` and `memo` to ones that do not run and that compute where they are made (with `lazy: true`, when read). Its imports of `features/actions` and `features/store` go to theirs once the file is compiled, so the compiler knows the stores they make as the client's compile does. `serverImports(code)` rewrites the imports alone, for a module that is not compiled. Without the option, the output is what it was, byte for byte.

## Hydrate mode

`compileJs(js, { hydrate: true })` (and `compileJsWithMap`, and `reactreCompiler({ hydrate: true })` for `Bun.build`) compiles a file for a browser build that [hydrates](https://www.npmjs.com/package/@reactre/core#hydration) the HTML @reactre/core/server rendered with `hydrate: true`. A template's code claims the page's element at the cursor, where it would clone the template, and a reactive hole starts as the page has it; slots, lists, fragments, `<Portal>` and `<Dynamic>` claim through `@reactre/core/features/hydrate`'s helpers, which the file imports from there; a list of `features/for` comes from `@reactre/core/hydrate/for`, which claims its rows. Its imports of `features/async` and `features/errors` go to `@reactre/core/hydrate/async` and `/hydrate/errors`, whose `<Loading>` and `<Errored>` take over what the server rendered of them. The Bun plugin with the option loads the core's feature modules with `@reactre/core/features/hydrate` for the core (`hydrateImports(code, false)`); `hydrateImports(code)` rewrites an app module's imports alone. A file that imports `hydrate` from `@reactre/core/features/hydrate` fails to compile without the option, naming it. A server build ignores it. Without the option, the output is what it was, byte for byte.

## Props

Props work as in Solid. At a call site, a prop whose expression calls a function (`<Label text={name()} />`) is passed as a getter, `Label({ get text() { return name(); } })`, and so are children that hold JSX, which are then built when the component reads `props.children`. A literal, a plain name and a function literal are passed as they are, so a call site of static props compiles as it always did. Spread props at a component call are merged by a small helper that keeps their getters. A prop that reads a prop of the component around the call (`<Theme value="dark">{props.children}</Theme>`) is a getter too, so children passed on are built inside the component they are passed to. A hole that reads a prop some call site passes JSX (`header={<h1>Hi</h1>}`, then `{props.header}`) is inserted, as `{props.children}` is, not written as text (`PropFacts.contentProps`); so is a hole that reads any prop of a component whose callers cannot all be seen (below), as it may be passed JSX. A component that destructures its props (`({ text }) =>`) reads each value once; one that makes a local of the whole object (`const p = merge({ size: "m" }, props)`) reads props through it, and its holes that use it are bound when some call site passes any prop reactively.

In the component, a hole that reads a prop (`{props.text}`, `class={props.cls}`, `<Show when={props.open}>`) is bound only if some call site may pass that prop reactively; otherwise it is written once, as any hole that calls nothing. That takes every call site:

- In `Bun.build`, `reactreCompiler()` reads the whole program from the entrypoints before it compiles (`wholeProgram: false` turns it off), resolving imports as Bun does. [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin) does the same for every bundler.
- `compileJs` and `compileSource` see one file alone. A component the file neither exports nor uses as a value has all its call sites there; any other is treated as getting every prop reactively, and as maybe getting a store or JSX in each, which is always correct, only larger and slower.
- `compileJs(js, { props })` takes the facts from elsewhere: for each component the file defines, by name, the props some call site may pass reactively, or `true` for all. `@reactre/compiler/program` finds them: `scanModule` reads a module, a `Program` links modules by their imports and exports, and `analyze(entries, host)` reads a build from its entries with the bundler's resolver.

A component whose callers cannot all be seen gets every prop reactively, and may be passed a store or JSX in any of them: one an entry exports (a library's API), one used as a value (`<Dynamic component={C}>`, `const X = C`, `[A, B]`), one called with spread props, an object's method, a function passed to a call (`const Card = wrap((props) => ...)`), and the exports of a module imported dynamically or through a namespace used as a value. A program that cannot see its whole graph (`import(expr)`, `import.meta.glob`, a virtual module) falls back to each file alone. A module that joins the program late, at its transform, and passes a prop reactively to a component already compiled without it fails the build, naming both.

## Stores

A store of [`@reactre/core/features/store`](https://www.npmjs.com/package/@reactre/core#feature-modules) is read by member, not by a call, and the compiler treats such a read as reactive. Its roots are the names a file binds stores to, `const [store, setStore] = createStore(...)` and `const p = createProjection(...)`, with the functions imported from `"@reactre/core/features/store"` under any local name or through `import * as`, and `const [todos, setTodos] = createOptimisticStore(...)`, imported so from `"@reactre/core/features/actions"`; and the stores a file imports. With a whole program, those are the stores another module of it exports, through re-exports and namespace imports (`state.store`), and whatever a package outside it exports (it may be a store). With each file alone (`compileSource`, `compileJs` without `props`, `wholeProgram: false`, a dev server), any import from outside `@reactre` may be a store and is taken for one, as an exported component there takes every prop reactively; an asset's import (styles, data, media) is not. So a dev server and a production build render the same updates; the build binds fewer holes. Then:

- A hole that mentions a store root is bound: `{store.count}`, `class={store.ui.dark ? "dark" : ""}`, `<Show when={store.user}>`, a class toggle, a handler.
- A prop that mentions one is passed as a getter, in another module too: `<Label text={store.title} />` and `<Card s={store} />` update the holes that read `props.text` and `props.s.title`.
- `<For each={store.todos}>` reads a copy of the array, `[...store.todos]`, which reads its length and every index tracked: pushes, removals and moves render, and the rows keep their items' proxies, so only new rows are built. An `each` written as an array literal is not copied again.
- In such a list's row, the item is a store root too: a hole that reads only the item (`class={t.done ? "done" : ""}`, `{t.title}`) is bound, a nested `<For each={t.tags}>` is copied, and `<Item todo={t} />` passes a getter.

What is made of a store root is one too, in a module and where another imports it:

- A local whose value mentions one: `const todos = store.todos`, `const { todos } = store`, `const box = { store }` (read `box.store.count`), a function whose body does (`const getTodos = () => store.todos`, `function useTodos() { return store; }`, whose call is then a store root's mention), an item of `for (const t of store.todos)`, and a name a store is assigned to (`box.s = store`). With each file alone, a local made of an import is one, as the import may be a store.
- A store's tuple kept whole, `const t = createStore(...)`, read as `t[0].count`.
- The parameter of a `<Show>`'s or `<Match>`'s child function whose `when` mentions one: the value of a keyed one (`{(u) => <p>{u.name}</p>}`), the accessor of the other.
- A prop that some call site passes a store root, in another module too: `<List todos={store.todos} />` makes List's `<For each={props.todos}>` read a copy and bind its rows, and the same for a local made of that prop and a name its pattern of props binds (`({ todos }) =>`). Every prop of a component whose callers cannot all be seen is one, as it may be passed a store.

A whole program (a production build) sees the callers of every component it does not export from an entry or use as a value, so only the props they pass a store or JSX cost anything: an app that passes none compiles as before, byte for byte. A file compiled alone (a dev server, `compileSource`, a library's entry) cannot see who calls what it exports, so it pays for what it cannot see: each exported component's `<For>` over a prop reads a copy and binds its rows, and each hole that reads a prop is inserted. Both render the same updates. A file that binds no store, imports only from `@reactre` (or assets) and neither exports nor uses as a value a component that reads its props compiles as before, byte for byte, and so does every list whose `each` mentions no store root and reads no prop of such a component. What the compiler cannot follow to a store is not a root, and is written once, as any member read is: a store made by a re-export of `createStore`. The store itself stays current, and so does everything that reads it in an effect or a hole that calls; only such a hole keeps the value it was written with, until the content around it is built again. Make it call something (`{String(t.title)}`) or read through a store root.

A call of `memo` or `signal` from [`@reactre/core/features/memo`](https://www.npmjs.com/package/@reactre/core#feature-modules) (under any local name, or `M.memo` through `import * as`) that passes `lazy` or `unobserved` goes to the module's reader-counting entry (`__observedMemo`, `__observedSignal`), the only code that keeps the count of readers those options need; so does a call whose options the compiler cannot read (a variable, a spread, a computed key), and a use it cannot follow to a call (`memo` passed as a value, exported, or re-exported by name). Every other call stays as it is, and a file without the import compiles as before, byte for byte. A name the file binds again (a parameter, a `const`) is not the import where it is in scope. The rewrite reads the file alone, so a dev server and a build give the same code; it applies to a file with or without JSX, and to a `.ts` file the plugin's `filter` takes, which is loaded as TypeScript.

A complete untagged template-string child is known to produce text. If its inputs
are static according to the same dependency analysis used for other text holes,
it compiles as a template text hole even when it mentions an imported value.
Same-key list updates still compare/write its content. Expressions that may react
retain their slots and per-run resource cleanup. Tagged templates and larger
expressions that can return nodes are unchanged. See the controlled measurements
in [template-content.md](../../apps/profiling/results/template-content.md).

A construct the compiler does not handle, such as a `<For>` or `<Repeat>` row that is neither a function written in place nor content (`{renderRow}`), a `<Match>` outside a `<Switch>` or a `keyed` that is not written as a boolean, is a compile error that points at its source, never a silent fallback.

For Vite, Rollup, Rolldown, esbuild, webpack or Rspack, use [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin), which runs this compiler inside each of them.

## License

Apache-2.0
