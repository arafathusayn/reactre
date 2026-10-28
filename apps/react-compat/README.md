# react-compat

Checks that @reactre/compat behaves like React 19. Each scenario in `cases.tsx` and `libraries.tsx` renders with React's API, acts on the page like a user, and records what it sees. The same scenarios are built against React 19 and against @reactre/compat, run in headless Chrome, and their transcripts must match line for line.

```sh
bun run compat                                   # from the repository root
bun run.ts --runtimes reactre-compat+classes     # from this directory
bun run.ts --verbose                             # print both transcripts where they differ
```

| Runtime                           | Build                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `reactre-compat`                  | The default build, without class components                    |
| `reactre-compat+classes`          | With class components (`@reactre/compat/classes`)              |
| `reactre-compat+classes+compiler` | With classes, and the JSX compiled by @reactre/compat/compiler |

The check fails when a build with classes differs from React, or when the default build differs for any reason but rendering a class. The library scenarios cover React Router, TanStack Query, Radix, framer-motion, Recharts, react-hook-form, react-transition-group, sonner, zustand and lucide-react.
