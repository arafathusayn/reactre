# @reactre/preact

Preact's API and behaviour, with a JSX compiler that turns your HTML element trees into templates. `@reactre/preact/core` is `preact` plus `preact/hooks`, and `@reactre/preact/compat` is `preact/compat`: the renderer is Preact 11.1.0's, ported, so an app sees what it sees on Preact. That covers DOM properties and attributes, native events, debounced rendering, error boundaries, keyed children and hydration.

```sh
bun add @reactre/preact
```

## Modules

| Module                        | Stands in for            | What it is                                                                 |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `@reactre/preact/core`        | `preact`, `preact/hooks` | The renderer, components, context, refs and hooks                          |
| `@reactre/preact/compat`      | `preact/compat`, `react` | Preact's React layer: React's prop names, memo, forwardRef, Suspense, lazy |
| `@reactre/preact/jsx-runtime` | `preact/jsx-runtime`     | The automatic JSX runtime                                                  |
| `@reactre/preact/compiler`    | (none)                   | A Bun plugin that compiles JSX element trees into templates                |

Alias the modules you use at build time. With Bun:

```ts
// build.ts
import { reactrePreactCompiler } from "@reactre/preact/compiler";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  minify: true,
  plugins: [
    // "react" for an app written against React (aliased to compat), "preact" for a Preact app.
    reactrePreactCompiler({ source: "react" }),
    {
      name: "alias",
      setup(build) {
        build.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({
          path: Bun.resolveSync("@reactre/preact/jsx-runtime", import.meta.dir),
        }));
        build.onResolve({ filter: /^react(-dom)?(\/client)?$/ }, () => ({
          path: Bun.resolveSync("@reactre/preact/compat", import.meta.dir),
        }));
      },
    },
  ],
});
```

## The compiler

The compiler is optional: without it, JSX renders through `jsx()` calls as on Preact.

With it, each tree of HTML elements becomes a template, built once and cloned per use. On each render only its dynamic parts are written:

- **Props:** a literal prop is set once on the template; any other prop is a hole, written with Preact's rules when its value changes.
- **Children:** static children are part of the template; other children are diffed by Preact's children diff.

A tree stays a `jsx()` call where its behaviour depends on more than attributes:

- form fields;
- custom elements;
- `ref`, `key` inside the tree, spread props;
- `dangerouslySetInnerHTML`;
- an element with both `class` and `className`.

A template renders what Preact renders for the same JSX, and has the same vnode shape for code that reads it: `props`, `type` and `key`, `cloneElement`, `Children` and `toChildArray`. When a template meets anything but its own kind (another element of its tag, server DOM to hydrate), both sides become plain vnodes over the same DOM, and Preact's element diff takes over.

## Differences from Preact

- `options.vnode`, `options.diffed` and the other `options` hooks see a compiled tree's root, not the elements inside it.
- The internal ids of the vnodes a template builds for `props.children` differ from those `jsx()` would give.

## Tests

The unit tests are differential: each scenario runs on Preact 11.1.0 and on this package, and the two transcripts must be equal. The compiled scenarios (`test/scenarios/*.tsx`) run on Preact as written and on this package after compiling.

```sh
bun test packages/preact
```

`apps/preact-compat` runs the repository's React compatibility scenarios with preact/compat 11.1.0 as the oracle, in headless Chrome.

## License

Apache-2.0. The renderer, hooks and compat layer are ports of Preact 11.1.0, MIT licensed; see [NOTICE](NOTICE).
