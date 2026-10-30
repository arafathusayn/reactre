# @reactre/full-compat

[`@reactre/compat`](https://www.npmjs.com/package/@reactre/compat) with React's time slicing. A transition's render yields to the page every 5 ms, as React's concurrent render does: events, timers and paints run between its slices, and an urgent update made meanwhile commits first while the transition renders again from the start.

```sh
bun add @reactre/full-compat
bun add -d @reactre/plugin
```

Or with npm: `npm install @reactre/full-compat` and `npm install -D @reactre/plugin`.

```ts
// vite.config.ts
import reactre from "@reactre/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [reactre({ compat: { package: "@reactre/full-compat" } })] });
```

Every other option works as with `@reactre/compat`: see [the plugin's docs](https://www.npmjs.com/package/@reactre/plugin).

## Why a separate package

Slicing needs a check of the clock before each component renders. That check costs on every render, transitions or not, so `@reactre/compat`'s builds leave it out and this package's builds compile it in. Pick this one when long transitions must not block input; pick `@reactre/compat` when renders are short (a render under 5 ms looks the same on both) or every kilobyte counts.

## How it works

Compat writes the DOM while it renders. When a slice's 5 ms run out, the transition's DOM changes are undone and its fibers and hooks put back, so the page shows the last commit, as React's does between slices; the next slice makes the changes again and goes on where the last one stopped. A transition that has waited 5 seconds renders the rest at once, as React's expired lanes do.

## Where it differs from React

- A transition renders whole, as in `@reactre/compat`, where its render cannot be undone: a root that hydrates, or a page without `MutationObserver`.
- A render that throws renders again whole, without slicing, as React's synchronous retry does.

The rest of [`@reactre/compat`'s docs](https://www.npmjs.com/package/@reactre/compat) holds here.

## Modules

The same as `@reactre/compat`'s client and server entries, under `@reactre/full-compat`: `.`, `/core`, `/features/*`, `/server`, `/static`, `/server.browser`, `/server.edge` and `/server.node`. The server entries are `@reactre/compat`'s: a server render does not slice.

## Size

About 1 KB gzipped more than `@reactre/compat`: 125.3 KB minified, 45.8 KB gzipped, bundled whole for the browser in production mode.

## License

Apache-2.0
