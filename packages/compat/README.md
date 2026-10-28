# @reactre/compat

Run a React 19 app on [reactre](https://github.com/arafathusayn/reactre)'s templates, unchanged. Function components and hooks, context, memo, refs, portals, Suspense and lazy, transitions, synthetic events, controlled fields and hydration all work as they do in React, and libraries such as React Router, TanStack Query, Radix, framer-motion and Recharts run on it (some of them through the class build below).

```sh
bun add @reactre/compat
```

Or with npm: `npm install @reactre/compat`.

Alias `react`, `react-dom` and their subpaths to it at build time.

## Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // react, react-dom and every subpath of them, in your code and in your dependencies.
    alias: [{ find: /^react(-dom)?(\/.*)?$/, replacement: "@reactre/compat" }],
  },
});
```

Vite compiles JSX for React's automatic runtime on its own, so no React plugin is needed. Leave `@vitejs/plugin-react` out: its Fast Refresh works through React's renderer, and with compat an edited component would stay as it was on screen. Without it, Vite reloads the page when you save.

## Bun

```ts
import type { BunPlugin } from "bun";
import { reactreCompatCompiler } from "@reactre/compat/compiler";

const react: BunPlugin = {
  name: "react-to-reactre-compat",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, () => ({
      path: Bun.resolveSync("@reactre/compat", import.meta.dir),
    }));
  },
};

await Bun.build({
  entrypoints: ["src/main.jsx"],
  outdir: "dist",
  plugins: [reactreCompatCompiler(), react],
});
```

## Modules

| Module                     | What it is                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@reactre/compat`          | React's API, without class components                                          |
| `@reactre/compat/classes`  | The same, with class components (lifecycles, setState, error boundaries)       |
| `@reactre/compat/compiler` | An optional Bun plugin that compiles JSX trees of host elements into templates |

Point the alias at `@reactre/compat/classes` instead when the app or a library it uses renders class components. The compiler is optional, and a Bun plugin for now; without it, everything still runs.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line.

## License

Apache-2.0
