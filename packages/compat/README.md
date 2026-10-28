# @reactre/compat

Run a React 19 app on [reactre](https://github.com/arafathusayn/reactre)'s templates, unchanged. Function components and hooks, context, memo, refs, portals, Suspense and lazy, transitions, synthetic events, controlled fields and hydration all work as they do in React, and libraries such as React Router, TanStack Query, Radix, framer-motion and Recharts run on it (some of them through the class build below).

```sh
bun add @reactre/compat
```

Or with npm: `npm install @reactre/compat`.

Alias `react`, `react-dom` and their subpaths to it at build time. With Bun:

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

| Module                     | What it is                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@reactre/compat`          | React's API, without class components                                          |
| `@reactre/compat/classes`  | The same, with class components (lifecycles, setState, error boundaries)       |
| `@reactre/compat/compiler` | An optional Bun plugin that compiles JSX trees of host elements into templates |

Resolve to `@reactre/compat/classes` instead when the app or a library it uses renders class components.

Every change is checked against React 19 itself, scenario by scenario: the same app runs on both, and what each renders and logs must match line for line.

## License

Apache-2.0
