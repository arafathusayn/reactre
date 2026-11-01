# @reactre/plugin

[reactre](https://github.com/arafathusayn/reactre)'s build step for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun, built on [unplugin](https://unplugin.unjs.io). It runs under Node and Bun.

```sh
bun add -d @reactre/plugin
```

Or with npm: `npm install -D @reactre/plugin`.

It has two modes:

- **reactre** (the default): your `.jsx` and `.tsx` files are compiled by [`@reactre/compiler`](https://www.npmjs.com/package/@reactre/compiler) into templates and the code that updates them.
- **compat**: `react`, `react-dom` and their subpaths resolve to [`@reactre/compat`](https://www.npmjs.com/package/@reactre/compat), and `react-dom/server` and `react-dom/static` to `@reactre/compat/server` and `/static`, in your code and in your dependencies. Those pick the build for the bundle's target as `react-dom`'s do: a browser bundle's server renderer throws React's minified error codes, as React's browser build does, and a Node SSR build's React's full messages. `react-dom/server.browser`, `.edge`, `.bun` and `.node` resolve to compat's entry for that build. Your `.jsx` and `.tsx` files are compiled too, so trees of HTML elements become templates. Server Components stay on React: a Vite environment named `rsc`, or a build that resolves with the `react-server` condition, is left alone.

## Vite

```ts
// vite.config.ts
import reactre from "@reactre/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactre()],
});
```

For a React app, install `@reactre/compat` and pass `compat`. Add [`@vitejs/plugin-react`](https://www.npmjs.com/package/@vitejs/plugin-react) after it for Fast Refresh:

```ts
import react from "@vitejs/plugin-react";

plugins: [reactre({ compat: true }), react()],
```

With it, a saved component renders again in place, keeping its state; an edit that changes its hooks, or one to a class component, mounts it anew, as with React. `react` resolves to compat's development build in `vite dev` (the `development` export condition), which registers with React Refresh as `react-dom` does, and to its production build in `vite build`, which leaves Fast Refresh out. `@vitejs/plugin-react`'s JSX transform does not run on the files this plugin compiles: it sees them already compiled. Without `@vitejs/plugin-react`, Vite reloads the page when you save.

## Other bundlers

Each bundler has its own entry. The options are the same everywhere.

```ts
// rollup.config.js: put reactre() before the plugin that resolves node_modules.
import reactre from "@reactre/plugin/rollup";
export default { input: "src/main.tsx", plugins: [reactre(), nodeResolve()] };

// rolldown.config.js
import reactre from "@reactre/plugin/rolldown";
export default { input: "src/main.tsx", plugins: [reactre()] };

// esbuild
import reactre from "@reactre/plugin/esbuild";
await esbuild.build({ entryPoints: ["src/main.tsx"], bundle: true, plugins: [reactre()] });

// webpack.config.js
import reactre from "@reactre/plugin/webpack";
export default { entry: "./src/main.tsx", plugins: [reactre()] };

// rspack.config.js
import reactre from "@reactre/plugin/rspack";
export default { entry: "./src/main.tsx", plugins: [reactre()] };

// Bun
import reactre from "@reactre/plugin/bun";
await Bun.build({ entrypoints: ["src/main.tsx"], outdir: "dist", plugins: [reactre()] });
```

The plugin turns `.jsx` and `.tsx` files into plain JavaScript, TypeScript included, so webpack and Rspack need no other loader for them.

## Options

```ts
reactre({
  // Run a React app on @reactre/compat. true, or:
  compat: {
    // Include class components. false leaves them out, for apps whose code and libraries render
    // no class component; the same as excluding "@classes".
    classes: true,
    // Compile your JSX's HTML element trees to templates. Off, your bundler's JSX transform
    // handles JSX and the plugin only resolves react.
    compile: true,
    // The React APIs your app and its libraries use: "all", or a list of keys.
    apis: "all",
    // APIs and behaviours to switch off, by key: what only they need leaves the bundle.
    exclude: [],
    // The package react resolves to: "@reactre/compat", or "@reactre/full-compat", the same with
    // React's time slicing (a transition's render yields every 5 ms). Install the one you name.
    package: "@reactre/compat",
  },
  // Files to compile, and files to leave alone, by path.
  include: /\.[jt]sx$/,
  exclude: /[\\/]node_modules[\\/]/,
  // reactre mode: read the whole program at a production build's start, so a component's holes
  // that read a prop are bound only where some call site passes that prop reactively.
  wholeProgram: true,
});
```

### The whole program

In reactre mode, a prop that may change is passed to a component as a getter, and a hole that reads a prop (`{props.title}`) is bound only if some call site may pass that prop reactively ([Props](https://www.npmjs.com/package/@reactre/core#props)). To see every call site, a build reads its program when it starts: from the build's entries (an HTML page's module scripts included), it follows each import your bundler's own resolver places among your files, aliases and tsconfig paths included, and leaves node_modules alone. A component whose every caller passes literals and plain names keeps its holes written once, as before props were reactive.

- Only a one-shot build reads it: `vite build`, Rollup, Rolldown, esbuild (again at each rebuild of a context), webpack, Rspack and `Bun.build`. A dev server and watch mode compile each file alone, where a component the file exports gets every prop reactively.
- A build whose graph the plugin cannot see (`import(expr)`, `import.meta.glob`, `require.context`, a virtual module, a file type that may import code, webpack's function entries) compiles each file alone too.
- A module the program did not reach (a chunk another plugin adds) joins it at its transform, whether the plugin compiles it or not: a `.js` or `.ts` module, or a virtual one, that calls a component by hand is one of its callers. If it passes a prop reactively to a component compiled already without it, the build fails, naming both. In Rollup, Rolldown and Vite, a late file that is not a script (a `.vue` or `.mdx` file another plugin makes code of) joins once it is JavaScript. `wholeProgram: false` compiles each file alone. A build never ships a hole written once that some caller passes a prop reactively.

### Switching React APIs off

`compat.apis` and `compat.exclude` take keys:

- React's export names, such as `useState`, `useEffect`, `createPortal` or `hydrateRoot`.
- Groups: `"@suspense"`, `"@transitions"`, `"@forms"`, `"@hints"` and `"@classes"`.
- Behaviours, which are not exports: `"componentStack"`, React's component stack in what `onUncaughtError`, `onCaughtError`, `onRecoverableError` and `componentDidCatch` get (off, it is empty), `"repeatedKeys"`, React's handling of a list whose keys repeat (off, compat pairs the rows by its own rules), `"renderRetry"`, React's retry of a render that throws before its error counts (off, the error goes to the nearest error boundary or the root at once), `"concurrentRendering"`, React's transition lanes: a transition renders after urgent updates, `isPending` shows first, and one that suspends where content shows keeps the screen until its data comes (off, a transition renders at once), `"viewTransitions"`, React's view transitions: a transition that changes a `<ViewTransition>` commits through `document.startViewTransition`, with its names, classes, types and events (off, it commits plainly; it is off whenever `"concurrentRendering"` is), and `"renderUndo"`, React's handling of an update outside a transition that suspends with no Suspense boundary above: the screen stays as it was until the data comes (off, what rendered commits). A behaviour is on unless `exclude` names it, whatever `apis` lists.

`@reactre/compat/api` lists them all. A key brings in what it is part of: `PureComponent` brings `Component`, and `useFormState` brings `useActionState`.

With any key off, class support included, `react` resolves to a module written for your options, under `node_modules/.cache/reactre`:

- It builds on `@reactre/compat/core` and imports the module of each feature that is on: `@reactre/compat/features/classes`, `/stacks` and `/keys`. So every set of options behaves as React does for everything it keeps; `classes: false` keeps component stacks and React's handling of repeated keys.
- It imports only the APIs that are on, so your bundler can leave out what only the others need.
- Each switched-off API is still exported, as a function that throws and names the fix. Class support off keeps `Component`, which throws when a class renders.

With an API other than class support off, the plugin also reads every module it bundles, your dependencies included. A named import, a `React.x` or a `require("react").x` of a switched-off API fails the build, naming the file and the key to add back. Only a use the scan cannot see, such as `React[name]`, reaches the throwing function at run time.

Leaving out what a small app does not use saves about a sixth of compat's bundle today. For example, a counter that imports `React` and calls `useState` goes from 28.4 KB gzipped to 23.9 KB with every other API off. The savings grow as more of compat moves into modules of its own.

## Source maps

A compiled file comes with a source map back to your `.tsx` or `.jsx`, so a stack trace, a breakpoint or an error report points at the line and column you wrote. Turn maps on as your bundler does: `build.sourcemap` in Vite (`vite dev` always serves them, inline), `output.sourcemap` in Rollup and Rolldown, `sourcemap` in esbuild, `devtool` in webpack and Rspack. Where the bundler asks for no map, the plugin builds none. The compiled code is the same with a map or without.

Bun is the exception: its plugins return code without a map, so `Bun.build` with `sourcemap` maps a bundle to the compiled code of each file, not to what you wrote, and the plugin builds no map for it.

## Limits

- In Bun, source maps lead to the compiled code, not your source (see above).
- Fast Refresh is checked with Vite and `@vitejs/plugin-react` (see above). Other bundlers' React Refresh integrations speak the same protocol to the renderer, but are not tested.
- In reactre mode, a key after spread props is a compile error: Bun gives that JSX to React's classic runtime.

## License

Apache-2.0
