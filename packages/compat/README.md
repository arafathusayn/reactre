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

| Module                     | What it is                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| `@reactre/compat`          | React's client API, class components included                              |
| `@reactre/compat/core`     | The same without class components (lifecycles, setState, error boundaries) |
| `@reactre/compat/classes`  | `@reactre/compat` under its earlier name, for apps that resolve to it      |
| `@reactre/compat/server`   | `react-dom/server`: React's server rendering, on compat's hooks            |
| `@reactre/compat/compiler` | The compiler @reactre/plugin runs, and a Bun plugin of its own             |
| `@reactre/compat/api`      | The keys that switch React's APIs on and off, and their rules              |

`@reactre/compat` is all of React's client API. An app that renders no class component, itself or through a library, can use `@reactre/compat/core` (`compat: { classes: false }` in the plugin) and leave class support out; a class that renders there throws an error naming the fix. The compiler is optional; without it, everything still runs.

An app can also switch off the React APIs it does not use, one by one, with the plugin's `compat.apis` and `compat.exclude`; see [the plugin's docs](https://www.npmjs.com/package/@reactre/plugin). Each combination keeps React's behaviour for every API it leaves on.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line.

## Server rendering

`@reactre/compat/server` is `react-dom/server` (and its `.browser`, `.edge`, `.node` and `.bun` builds) for compat apps; the plugin resolves them to it. `renderToString`, `renderToStaticMarkup`, `renderToReadableStream` and `renderToPipeableStream` write the HTML React 19.3.1's production build writes for the same tree, byte for byte: text separators, Suspense markers and the scripts that stream suspended content in, hoisted `<title>`, `<meta>` and `<link>` tags, image preloads, the links and scripts of `preload`, `preinit` and the other resource functions (or the Link header `onHeaders` gets), stylesheet precedence, form actions and `useId`'s ids. Components call compat's own hooks, effects never run, and class components render whether or not the class build is loaded.

Server Components stay on React: the plugin leaves the RSC environment, and any build resolving with the `react-server` condition, on real React. Where compat differs from React's server renderer:

- `prerender`, `prerenderToNodeStream`, `resume` and `resumeToPipeableStream` are exported but throw: partial prerendering is not implemented.
- `preload`, `preinit` and the other resource functions called in async work a stream's render started, such as a promise callback, reach that render wherever `AsyncLocalStorage` exists (a global one, as edge runtimes have, or `node:async_hooks`'), as in React's Node build and its edge build. Under Bun, `react-dom/server` resolves to React's Bun build, which keeps no such storage and drops those hints; compat takes them there too, as `react-dom/server.node` does under Bun. Without `AsyncLocalStorage`, only code the render's work runs reaches it, as in React's browser build.
- `useActionState`'s server action key (`$ACTION_KEY`) hashes the hook's place in the tree as each React build does for the entry: MD5 for `renderToPipeableStream`, as React's Node build; MurmurHash3 for `renderToReadableStream` and `renderToString`, as its browser, edge and legacy builds. React's Node build hashes its `renderToReadableStream`'s keys with MD5 too, and its Bun build hashes with `Bun.hash`; a postback still matches the server that wrote the form. A component that sets state while it renders keeps the action and dispatch of its first pass, where React takes the action each pass renders. (`unstable_externalRuntimeSrc` is ignored, as React's production build ignores it.)
- Errors carry React's full messages rather than minified codes.
- `onError`'s `componentStack` is React's production stack, each component's frame read from a native stack trace as React reads it, with two exceptions. A component whose first call that throws without props is `use()` of a promise gets a frame with only its name, as compat's `use()` reads a promise outside a render where React's throws. Under JavaScriptCore (Bun, Safari), a component that returns a hook's result directly, a tail call, has no frame of its own, so the frame shown is the hook's, in compat's code rather than React's. Frames are formatted as React's browser, Bun and legacy builds format them; its Node and edge builds use an `Error.prepareStackTrace` of their own, which Bun writes differently for an engine-made frame such as a class's implicit constructor.
- Stream chunks are those of one React build per entry: `renderToPipeableStream` writes as React's Node build does (4096-byte views, a long string as it is, and a pause when the writable is full until it drains), `renderToReadableStream` enqueues as its browser and edge builds do (2048-byte views). React's Bun build, which `react-dom/server` resolves to under Bun, writes each piece on its own instead. The bytes are the same.

## Size

Each module bundled whole, minified, for the browser in production mode, with React 19.3.1 for comparison:

| Bundle                              | Minified |    gzip |  brotli |
| ----------------------------------- | -------: | ------: | ------: |
| `@reactre/compat`                   |  77.4 KB | 28.4 KB | 25.2 KB |
| `@reactre/compat/core`              |  74.2 KB | 27.2 KB | 24.2 KB |
| `react` + `react-dom/client` 19.3.1 | 214.1 KB | 66.7 KB | 57.4 KB |

Class support costs about 3.3 KB minified, 1.1 KB gzipped, which apps on `@reactre/compat/core` leave out. Most of the runtime ships whatever an app imports: a counter with one `useState` and `createRoot` comes to 20.2 KB gzipped (19.0 KB on core), against 64.4 KB on React. Measured with Bun's bundler, gzip at level 9 and brotli at quality 11; Rolldown, the bundler in Vite, gives sizes within 1 KB of these.

## License

Apache-2.0
