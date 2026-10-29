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

For a React app, install `@reactre/compat` and pass `compat`:

```ts
plugins: [reactre({ compat: true })],
```

Leave `@vitejs/plugin-react` out: its Fast Refresh works through React's renderer, so with compat an edited component would stay as it was on screen. Without it, Vite reloads the page when you save.

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
  },
  // Files to compile, and files to leave alone, by path.
  include: /\.[jt]sx$/,
  exclude: /[\\/]node_modules[\\/]/,
});
```

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

## Limits

- No source maps yet: compiled files map to nothing.
- Fast Refresh is not supported yet; Vite reloads the page on save.
- In reactre mode, fragments and spread props are compile errors, as in `@reactre/compiler`.

## License

Apache-2.0
