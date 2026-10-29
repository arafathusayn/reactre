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

| Module                             | What it is                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `@reactre/compat`                  | React's client API, whole: core and the three feature modules                    |
| `@reactre/compat/core`             | The slim base: React's client API without the feature modules                    |
| `@reactre/compat/features/classes` | Class components (lifecycles, setState, error boundaries), installed when loaded |
| `@reactre/compat/features/stacks`  | React's component stacks in error reports, installed when loaded                 |
| `@reactre/compat/features/keys`    | React's handling of a list whose keys repeat, installed when loaded              |
| `@reactre/compat/classes`          | `@reactre/compat` under its earlier name, for apps that resolve to it            |
| `@reactre/compat/server`           | `react-dom/server`: React's server rendering, on compat's hooks                  |
| `@reactre/compat/compiler`         | The compiler @reactre/plugin runs, and a Bun plugin of its own                   |
| `@reactre/compat/api`              | The keys that switch React's APIs and behaviours on and off, and their rules     |

`@reactre/compat` is all of React's client API. The plugin builds narrower entries from the same modules: with `compat: { classes: false }`, or any key in `compat.exclude`, `react` resolves to a module built on `@reactre/compat/core` that loads each feature module still on, so every set of options behaves as React does for everything it keeps. Without class support, a class that renders throws an error naming the fix. Without the `componentStack` key, errors are reported with an empty `componentStack`; without `repeatedKeys`, a list whose keys repeat, which React warns about, is reconciled by compat's own rules. See [the plugin's docs](https://www.npmjs.com/package/@reactre/plugin). `@reactre/compat/core` alone, with no feature module, is for builds that choose all three off, as the js-framework-benchmark app does. The compiler is optional; without it, everything still runs.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line. Errors are React's production errors too: the client throws and reports the minified codes React's production client does (`Minified React error #31; visit https://react.dev/errors/31?args[]=…`, the full message one click away), and the full messages where React keeps them, as in `Children`.

## Where the client differs

- Component stacks (`componentStack` in what `onUncaughtError`, `onCaughtError`, `onRecoverableError` and `componentDidCatch` get) are React's production stacks: host elements and boundaries by name, and each function and class component by the frame of a native stack trace, found as React's `describeNativeComponentFrame` finds it, by calling or constructing the component without props when the error is reported. Two cases differ. A component whose first call that throws without props is `use()` of a promise gets a frame with only its name, as compat's `use()` reads a promise outside a render where React's throws. Under JavaScriptCore (Bun, Safari), a component that returns a hook's result directly, a tail call, has no frame of its own, so the frame shown is the hook's, in compat's code rather than React's. An error a host element's props throw on an update starts the stack at the element's parent.
- Repeated keys: where compat matches a list's rows against the old ones through a key map, as React does, it does what React's production build does, down to the old row React's map hides staying in the DOM, never rendered again. Before building a map, compat matches what it can cheaply (rows that line up from the end, one run of removed rows, two rows that traded places, rows inserted between unchanged ones, the changes a compiled list reports) by position. There, with a repeated key, React pairs the first new row of the key with the last old one and leaves the other old rows in the DOM, while compat pairs them in order: matching React would mean looking up every key of the rows that did not change, the work those paths exist to skip.
- Hydration finds what React's production client finds (an element, text or Suspense boundary the server did not render, server nodes the client does not render, text that differs) and recovers as React does: the nearest Suspense boundary the server rendered drops the server's nodes and renders on the client, or the whole root does, and `onRecoverableError` gets React's error and component stack. A boundary the server could not finish (`<!--$!-->`) renders on the client with React's error. Where it differs:
  - Hydration runs in one pass, before `hydrateRoot` returns, Suspense content included; React hydrates each boundary in a task of its own. So a boundary's errors are reported with the root's, after every layout effect of the pass.
  - A boundary whose content suspends while hydrating drops the server's nodes and shows its fallback until the content can render; React keeps the server's HTML and hydrates it once the content is ready. A boundary still streaming in (`<!--$?-->`) is rendered on the client with React's error even while the document loads, where React waits for it.
  - Claimed elements get the client's attributes and styles, written as on a mount. React's production client checks no attribute and keeps the server's until the prop next changes.
  - An Activity boundary is not one hydration recovers at: a mismatch inside it renders the nearest Suspense boundary or the root on the client. An error other than a mismatch thrown while hydrating goes to the nearest error boundary or the root at once; React first renders the nearest Suspense boundary or root on the client again, reporting the first error as recoverable.
  - Recovering a whole document, compat replaces `<html>` and everything in it; React keeps the `<html>`, `<head>` and `<body>` elements.

## Server rendering

`@reactre/compat/server` is `react-dom/server` (and its `.browser`, `.edge`, `.node` and `.bun` builds) for compat apps; the plugin resolves them to it. `renderToString`, `renderToStaticMarkup`, `renderToReadableStream` and `renderToPipeableStream` write the HTML React 19.3.1's production build writes for the same tree, byte for byte: text separators, Suspense markers and the scripts that stream suspended content in, hoisted `<title>`, `<meta>` and `<link>` tags, image preloads, the links and scripts of `preload`, `preinit` and the other resource functions (or the Link header `onHeaders` gets), stylesheet precedence, form actions and `useId`'s ids. Components call compat's own hooks, effects never run, and class components render whether or not the class build is loaded.

Server Components stay on React: the plugin leaves the RSC environment, and any build resolving with the `react-server` condition, on real React. Where compat differs from React's server renderer:

- `prerender`, `prerenderToNodeStream`, `resume` and `resumeToPipeableStream` are exported but throw: partial prerendering is not implemented.
- `preload`, `preinit` and the other resource functions called in async work a stream's render started, such as a promise callback, reach that render wherever `AsyncLocalStorage` exists (a global one, as edge runtimes have, or `node:async_hooks`'), as in React's Node build and its edge build. Under Bun, `react-dom/server` resolves to React's Bun build, which keeps no such storage and drops those hints; compat takes them there too, as `react-dom/server.node` does under Bun. Without `AsyncLocalStorage`, only code the render's work runs reaches it, as in React's browser build.
- `useActionState`'s server action key (`$ACTION_KEY`) hashes the hook's place in the tree as each React build does for the entry: MD5 for `renderToPipeableStream`, as React's Node build; MurmurHash3 for `renderToReadableStream` and `renderToString`, as its browser, edge and legacy builds. React's Node build hashes its `renderToReadableStream`'s keys with MD5 too, and its Bun build hashes with `Bun.hash`; a postback still matches the server that wrote the form. A component that sets state while it renders keeps the action and dispatch of its first pass, where React takes the action each pass renders. (`unstable_externalRuntimeSrc` is ignored, as React's production build ignores it.)
- Errors carry React's full messages, as React's builds for Node, Deno, Bun and edge runtimes throw them, while compat's client throws React's production codes. React's browser build (`react-dom/server.browser`, which a bundle for the browser or a web worker resolves to) throws the minified codes instead.
- `onError`'s `componentStack` is React's production stack, each component's frame read from a native stack trace as React reads it, with two exceptions. A component whose first call that throws without props is `use()` of a promise gets a frame with only its name, as compat's `use()` reads a promise outside a render where React's throws. Under JavaScriptCore (Bun, Safari), a component that returns a hook's result directly, a tail call, has no frame of its own, so the frame shown is the hook's, in compat's code rather than React's. Frames are formatted as React's browser, Bun and legacy builds format them; its Node and edge builds use an `Error.prepareStackTrace` of their own, which Bun writes differently for an engine-made frame such as a class's implicit constructor.
- Stream chunks are those of one React build per entry: `renderToPipeableStream` writes as React's Node build does (4096-byte views, a long string as it is, and a pause when the writable is full until it drains), `renderToReadableStream` enqueues as its browser and edge builds do (2048-byte views). React's Bun build, which `react-dom/server` resolves to under Bun, writes each piece on its own instead. The bytes are the same.

## Size

Each module bundled whole, minified, for the browser in production mode, with React 19.3.1 for comparison:

| Bundle                              | Minified |    gzip |  brotli |
| ----------------------------------- | -------: | ------: | ------: |
| `@reactre/compat`                   |  83.1 KB | 30.7 KB | 27.3 KB |
| `@reactre/compat/core`              |  77.8 KB | 28.7 KB | 25.5 KB |
| `react` + `react-dom/client` 19.3.1 | 214.1 KB | 66.7 KB | 57.4 KB |

The feature modules cost an app about 7.1 KB minified, 2.7 KB gzipped: class support 1.3 KB gzipped, component stacks 0.9 KB and React's handling of repeated keys 0.5 KB, each left out with its key off. Most of the runtime ships whatever an app imports: a counter with one `useState` and `createRoot` comes to 21.2 KB gzipped (18.5 KB on core alone), against 64.4 KB on React. Measured with Bun's bundler, gzip at level 9 and brotli at quality 11; Rolldown, the bundler in Vite, gives sizes within 1 KB of these.

## License

Apache-2.0
