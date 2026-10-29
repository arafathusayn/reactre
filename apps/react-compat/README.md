# react-compat

Checks that @reactre/compat behaves like React 19. Each scenario in `cases.tsx`, `libraries.tsx` and `more-libraries.tsx` renders with React's API, acts on the page like a user, and records what it sees. The same scenarios are built against React 19 and against @reactre/compat, run in headless Chrome, and their transcripts must match line for line.

```sh
bun run compat                                   # from the repository root
bun run.ts --runtimes reactre-compat+classes     # from this directory
bun run.ts --verbose                             # print both transcripts where they differ
bun run.ts --only cmdk,react-redux               # just the scenarios whose names contain these
bun run.ts --runtimes react,react               # React against itself: a scenario that differs is flaky
```

| Runtime                           | Build                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `reactre-compat`                  | The default build, without class components                    |
| `reactre-compat+classes`          | With class components (`@reactre/compat/classes`)              |
| `reactre-compat+classes+compiler` | With classes, and the JSX compiled by @reactre/compat/compiler |

The check fails when a build with classes differs from React, or when the default build differs for any reason but rendering a class. The library scenarios cover the 50 React libraries npm downloads most, one package per project, leaving out renderers, frameworks, build and test tools, and packages most apps get only as dependencies. The lists and how they were chosen are at the top of `libraries.tsx` (the first 25) and `more-libraries.tsx` (the next 25):

- **1–25:** React Router, TanStack Query, Table and Virtual, Radix, framer-motion, Recharts, react-hook-form, react-transition-group, sonner, zustand, lucide-react, React Redux, react-markdown, react-day-picker, cmdk, dnd kit, Sentry, Floating UI, vaul, next-themes, react-resizable-panels, Embla Carousel, input-otp and Emotion.
- **26–50:** Tiptap, SWR, react-i18next, react-error-boundary, React Flow, react-dropzone, styled-components, React Aria, Material UI, qrcode.react, Stripe's React SDK, react-select, react-textarea-autosize, react-icons, Vercel Analytics, react-draggable, react-syntax-highlighter, Headless UI, react-pdf, Jotai, react-colorful, react-window, Apollo Client, Lexical and react-number-format.
