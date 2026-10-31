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

The output imports only the runtime helpers a file uses, so a bundler leaves out the rest. A `<For>` row that makes two or more calls with arguments in its reactive holes (`isSelected(row.id)`, `isHovered(row.id)`) may read two selector keys, and its file imports [`@reactre/core/features/selectors`](https://www.npmjs.com/package/@reactre/core#what-an-app-ships).

A construct the compiler does not handle, such as a `<For>` outside an element or a row that is not one element, is a compile error that points at its source, never a silent fallback.

For Vite, Rollup, Rolldown, esbuild, webpack or Rspack, use [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin), which runs this compiler under Node as well as Bun.

## License

Apache-2.0
