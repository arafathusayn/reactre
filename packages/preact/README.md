# @reactre/preact

Preact's API and behaviour, with a JSX compiler that turns your HTML element trees into templates. `@reactre/preact/core` is `preact` plus `preact/hooks`, and `@reactre/preact/compat` is `preact/compat`: the renderer is Preact 11.1.0's, ported, so an app sees what it sees on Preact. That covers DOM properties and attributes, native events, debounced rendering, error boundaries, keyed children and hydration.

```sh
bun add @reactre/preact
```

Or with npm: `npm install @reactre/preact`. The compiler and the bundler plugin run on Bun and on Node 20.19 or 22.12 and later.

## Modules

| Module                        | Stands in for            | What it is                                                                 |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `@reactre/preact/core`        | `preact`, `preact/hooks` | The renderer, components, context, refs and hooks                          |
| `@reactre/preact/compat`      | `preact/compat`, `react` | Preact's React layer: React's prop names, memo, forwardRef, Suspense, lazy |
| `@reactre/preact/jsx-runtime` | `preact/jsx-runtime`     | The automatic JSX runtime                                                  |
| `@reactre/preact/compiler`    | (none)                   | A Bun plugin that compiles JSX element trees into templates                |
| `@reactre/preact/plugin`      | (none)                   | The same compiler for Vite, Rollup, Rolldown, esbuild, webpack and Rspack  |
| `@reactre/preact/dom`         | (none)                   | The DOM-only build: templates and events, no components                    |

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

With Vite, Rollup, Rolldown, esbuild, webpack or Rspack, `@reactre/preact/plugin` is the same compiler with the same options, and it resolves `preact`, `preact/hooks`, `preact/compat`, `react`, `react-dom` and their JSX runtimes itself, so no alias is needed:

```ts
// vite.config.ts
import { reactrePreact } from "@reactre/preact/plugin";

export default {
  plugins: [reactrePreact.vite({ source: "react", off: ["@classes"] })],
};
```

`reactrePreact.rollup`, `.rolldown`, `.esbuild`, `.webpack` and `.rspack` are the others. It runs under Node as well as Bun.

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

## No JSX, no build step

`html` writes the same elements as a tagged template, in plain JavaScript that runs straight in the browser, and never touches `createElement`:

```ts
import { html, render, useState } from "@reactre/preact/core";

function Counter({ start }) {
  const [n, setN] = useState(start);
  return html`<button class="counter" onClick=${() => setN(n + 1)}>Clicked ${n} times</button>`;
}

render(html`<main><h1>Hello</h1><${Counter} start=${0} /></main>`, document.body);
```

Each template is parsed once per call site, into the templates the compiler would make of the same JSX, so it renders what that JSX renders on Preact. Components go in a tag as a value, closed with `/>`, `</${Counter}>` or `<//>`; `...${props}` spreads props; text follows JSX's whitespace rules. HTML entities in text and quoted attributes are decoded, as JSX decodes them. `@reactre/preact/compat` exports `html` too, with React's prop names (`className`, `onDoubleClick`).

## Strip out what you don't use

The hooks and features are separate modules, so an app bundles only those it imports. To be sure of that, switch APIs off with the compiler's `off` option:

```ts
reactrePreactCompiler({ source: "react", off: ["@classes", "useEffect", "useLayoutEffect"] });
```

- **Keys** are the names an app imports from `preact`, `preact/hooks`, `preact/compat` and `react`, and the groups `@classes`, `@suspense` and `@transitions`. What every app needs (createElement, Fragment, render, options, the JSX runtime) is always on.
- **Use one by mistake and the build tells you.** The plugin reads every module it bundles, your dependencies included. A named import, an `x.useEffect` through a default or namespace import, or a `require` of a switched-off API fails the build, naming the file and the key. A key the build can work out counts too: `React["useEffect"]`, ``React[`use${"Effect"}`]``, a `const` key, `"use" + "Effect"`, and `<React.Suspense>` in JSX.
- **Every use is proven, or the build fails.** Code that reads `react` or `preact` in a way the build cannot follow could reach any API: a key known only at run time (`React[name]`), `{ ...React }`, `Object.values(React)`, passing the module on, `export * from "react"` or `import("react")`. With any key off, that fails the build too, naming the file, line and column. For a library you trust, `allowUnresolved: (path) => path.includes("/some-lib/")` lets the file build, and a switched-off API it reaches throws when called.
- **`Component` switches class support off.** The class-only code leaves the engine and compat, an import of `Component` fails the build like any other key, and a class with no `Component` import throws an error naming the fix when it renders. Class-based APIs (`PureComponent`, compat's `Suspense`) go with it.
- The option works with every bundler (`@reactre/preact/plugin`) and with Bun (`@reactre/preact/compiler`). With any key off, the plugin resolves `preact`, `preact/hooks`, `preact/compat`, `react` and `react-dom` itself, so list it before your own aliases.

## DOM-only

For the absolute minimum, `@reactre/preact/dom` is templates and events with no components, vnodes or diff. It is reactre's DOM layer, [`@reactre/dom`](https://www.npmjs.com/package/@reactre/dom):

```ts
import { html, on, text } from "@reactre/preact/dom";

let count = 0;
const Counter = html`<button onclick=${on<"click">()}>Clicked ${text<number>()} times</button>`;
const view = Counter.mount([() => view.set(1, ++count), count]);
document.body.append(view.root);
```

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
