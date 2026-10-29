# @reactre/compat

Run a React 19 app on [reactre](https://github.com/arafathusayn/reactre)'s templates, unchanged. Function components and hooks, context, memo, refs, portals, Suspense and lazy, transitions, synthetic events, controlled fields and hydration all work as they do in React, and libraries such as React Router, TanStack Query, Radix, framer-motion and Recharts run on it (some of them through the class build below).

```sh
bun add @reactre/compat
```

Or with npm: `npm install @reactre/compat`.

Alias `react`, `react-dom` and their subpaths to it at build time. [`@reactre/plugin`](https://www.npmjs.com/package/@reactre/plugin) does it for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun, and compiles your JSX's HTML element trees into templates as well.

## Vite

```sh
bun add -d @reactre/plugin
```

```ts
// vite.config.ts
import reactre from "@reactre/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [reactre({ compat: true })] });
```

Leave `@vitejs/plugin-react` out: its Fast Refresh works through React's renderer, and with compat an edited component would stay as it was on screen. Without it, Vite reloads the page when you save.

Without the plugin, an alias is enough. Vite then compiles JSX for React's automatic runtime on its own:

```ts
export default defineConfig({
  resolve: {
    // react, react-dom and every subpath of them, in your code and in your dependencies.
    alias: [{ find: /^react(-dom)?(\/.*)?$/, replacement: "@reactre/compat" }],
  },
});
```

## Other bundlers

The plugin has an entry for each: `@reactre/plugin/rollup`, `/rolldown`, `/esbuild`, `/webpack`, `/rspack` and `/bun`, each called as `reactre({ compat: true })`. See [its docs](https://www.npmjs.com/package/@reactre/plugin).

## Modules

| Module                     | What it is                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `@reactre/compat`          | React's API, without class components                                    |
| `@reactre/compat/classes`  | The same, with class components (lifecycles, setState, error boundaries) |
| `@reactre/compat/compiler` | The compiler @reactre/plugin runs, and a Bun plugin of its own           |

Use `@reactre/compat/classes` (`compat: { classes: true }` in the plugin) when the app or a library it uses renders class components. The compiler is optional; without it, everything still runs.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line.

## Size

Each module bundled whole, minified, for the browser in production mode, with React 19.3.1 for comparison:

| Bundle                              | Minified |    gzip |  brotli |
| ----------------------------------- | -------: | ------: | ------: |
| `@reactre/compat`                   |  49.3 KB | 18.7 KB | 16.8 KB |
| `@reactre/compat/classes`           |  52.6 KB | 19.7 KB | 17.7 KB |
| `react` + `react-dom/client` 19.3.1 | 214.1 KB | 66.7 KB | 57.4 KB |

Class support costs about 3.4 KB minified, 1 KB gzipped, and only apps that import `@reactre/compat/classes` pay it. Most of the runtime ships whatever an app imports: a counter with one `useState` and `createRoot` comes to 14.9 KB gzipped (16.0 KB with classes), against 64.4 KB on React. Measured with Bun's bundler, gzip at level 9 and brotli at quality 11; Rolldown, the bundler in Vite, gives sizes within 1 KB of these.

## License

Apache-2.0
