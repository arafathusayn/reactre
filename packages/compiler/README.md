# reactre-compiler

The Bun plugin that compiles [reactre](https://github.com/arafathusayn/reactre/tree/main/packages/reactre) TSX. Each JSX tree becomes a template, parsed once and cloned per instance, plus the code that keeps its holes up to date. Nothing is left to a JSX runtime.

```sh
bun add -d reactre-compiler
```

Or with npm: `npm install -D reactre-compiler`.

```ts
import { reactreCompiler } from "reactre-compiler";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  plugins: [reactreCompiler()],
});
```

A construct the compiler does not handle yet, such as a fragment or spread props, is a compile error that points at its source, never a silent fallback.

## License

Apache-2.0
