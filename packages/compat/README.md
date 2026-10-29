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
    // react, react-dom and every subpath of them, in your code and in your dependencies; the
    // server renderer first.
    alias: [
      { find: /^react-dom\/(server|static)(\.(browser|edge|node|bun))?(\.js)?$/, replacement: "@reactre/compat/server" },
      { find: /^react(-dom)?(\/.*)?$/, replacement: "@reactre/compat" },
    ],
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
| `@reactre/compat/server`   | `react-dom/server`: React's server rendering, on compat's hooks          |
| `@reactre/compat/compiler` | The compiler @reactre/plugin runs, and a Bun plugin of its own           |

Use `@reactre/compat/classes` (`compat: { classes: true }` in the plugin) when the app or a library it uses renders class components. The compiler is optional; without it, everything still runs.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line.

## Server rendering

`@reactre/compat/server` is `react-dom/server` (and its `.browser`, `.edge`, `.node` and `.bun` builds) for compat apps; the plugin resolves them to it. `renderToString`, `renderToStaticMarkup`, `renderToReadableStream` and `renderToPipeableStream` write the HTML React 19.3.1's production build writes for the same tree, byte for byte: text separators, Suspense markers and the scripts that stream suspended content in, hoisted `<title>`, `<meta>` and `<link>` tags, image preloads, stylesheet precedence, form actions and `useId`'s ids. Components call compat's own hooks, effects never run, and class components render whether or not the class build is loaded.

Server Components stay on React: the plugin leaves the RSC environment, and any build resolving with the `react-server` condition, on real React. Where compat differs from React's server renderer:

- `prerender`, `prerenderToNodeStream`, `resume` and `resumeToPipeableStream` are exported but throw: partial prerendering is not implemented.
- A promise created during render rather than cached suspends again on each retry, where React replays it.
- `preload`, `preinit` and the other resource functions write nothing during a server render. `onHeaders`, `formState` and `unstable_externalRuntimeSrc` are not supported.
- Errors carry React's full messages rather than minified codes, and `componentStack` is empty.
- `useId`'s server ids follow React's, but compat's client makes its own ids, so hydration patches the attributes that hold them.
- Streams are chunked differently and do not wait for a slow destination to drain; the bytes are the same.

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
