# @reactre/plugin

[reactre](https://github.com/arafathusayn/reactre)'s build step for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun, built on [unplugin](https://unplugin.unjs.io). It runs under Node and Bun.

```sh
bun add -d @reactre/plugin
```

Or with npm: `npm install -D @reactre/plugin`.

It has two modes:

- **reactre** (the default): your `.jsx` and `.tsx` files are compiled by [`@reactre/compiler`](https://www.npmjs.com/package/@reactre/compiler) into templates and the code that updates them.
- **compat**: `react`, `react-dom` and their subpaths resolve to [`@reactre/compat`](https://www.npmjs.com/package/@reactre/compat), and `react-dom/server` and `react-dom/static` to `@reactre/compat/server`, in your code and in your dependencies. Your `.jsx` and `.tsx` files are compiled too, so trees of HTML elements become templates. Server Components stay on React: a Vite environment named `rsc`, or a build that resolves with the `react-server` condition, is left alone.

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
    // Resolve react to @reactre/compat/classes, for apps and libraries with class components.
    classes: false,
    // Compile your JSX's HTML element trees to templates. Off, your bundler's JSX transform
    // handles JSX and the plugin only resolves react.
    compile: true,
  },
  // Files to compile, and files to leave alone, by path.
  include: /\.[jt]sx$/,
  exclude: /[\\/]node_modules[\\/]/,
});
```

## Limits

- No source maps yet: compiled files map to nothing.
- Fast Refresh is not supported yet; Vite reloads the page on save.
- In reactre mode, fragments and spread props are compile errors, as in `@reactre/compiler`.

## License

Apache-2.0
