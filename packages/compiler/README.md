# @reactre/compiler

The Bun plugin that compiles [reactre](https://github.com/arafathusayn/reactre) TSX. Each JSX tree becomes a template, parsed once and cloned per instance, plus the code that keeps its holes up to date. Nothing is left to a JSX runtime.

```sh
bun add -d @reactre/compiler
```

Or with npm: `npm install -D @reactre/compiler`.

```ts
import { reactreCompiler } from "@reactre/compiler";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  plugins: [reactreCompiler()],
});
```

## What it compiles

- Host elements and SVG, with holes that follow what they read, handlers, `style` as an object or a string, `value`, `checked` and `selected` as properties, `ref`, spread props, fragments, components (called once) and `key`.
- `<For each key>`, a keyed list, with a `fallback` shown while `each` is empty.
- `<Show when fallback keyed>` and `<Switch fallback>` of `<Match when keyed>`: a slot behind a memo of the condition (or of the matched case), so the content is rebuilt only when that changes.
- `<Repeat count from fallback>`: a keyed list over the indexes.
- `<Portal mount>`: its children inserted into another element (`document.body` by default), taken out when their owner goes.
- `<Dynamic component>`: a slot that calls the component or builds the tag's element; a tag written as a string (`component="h1"`) compiles as the element itself.
- `class` written as an object or an array literal (`class={{ active: on() }}`, `class={["btn", size(), { big: true }]}`): the classes it can see join the template, an object's other keys become `classList` toggles, and a list with an item it cannot see into is one string through a small helper, imported only by a file that has one.
- `ref={[a, b]}`, which gives the element to each ref.
- `defaultValue`, `defaultChecked`, `defaultSelected` and `defaultMuted`, set as properties.

Control flow (`Show`, `Switch`, `Match`, `Repeat`, `Portal`, `Dynamic`) is recognized by its import from `"@reactre/core"`, under any local name or through `import * as`, so a component of an app's own named `Show` or `Switch` stays a component. `<For>` is also matched by its name, as it always was. Each compiles to the slots, memos and lists compiled code already uses, so an app ships no runtime of its own for them. A file that uses none of them compiles to the same code as before they existed.

The output imports only the runtime helpers a file uses, so a bundler leaves out the rest. A `<For>` row that makes two or more calls with arguments in its reactive holes (`isSelected(row.id)`, `isHovered(row.id)`) may read two selector keys, and its file imports [`@reactre/core/features/selectors`](https://www.npmjs.com/package/@reactre/core#what-an-app-ships).

A construct the compiler does not handle, such as a `<For>` or `<Repeat>` outside an element, a row that is not one element, a `<Match>` outside a `<Switch>` or a `keyed` that is not written as a boolean, is a compile error that points at its source, never a silent fallback.

For Vite, Rollup, Rolldown, esbuild, webpack or Rspack, use [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin), which runs this compiler under Node as well as Bun.

## License

Apache-2.0
