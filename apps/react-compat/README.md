# react-compat

Checks that @reactre/compat behaves like React 19. Each scenario in `cases.tsx` and the `libraries-*.tsx` files renders with React's API, acts on the page like a user, and records what it sees. The same scenarios are built against React 19 and against @reactre/compat, run in headless Chrome, and their transcripts must match line for line.

```sh
bun run compat                                   # from the repository root
bun run.ts --runtimes reactre-compat+core        # from this directory
bun run.ts --verbose                             # print both transcripts where they differ
bun run.ts --only cmdk,react-redux               # just the scenarios whose names contain these
bun run.ts --runtimes react,react               # React against itself: a scenario that differs is flaky
```

| Runtime                   | Build                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| `reactre-compat`          | The default build, `@reactre/compat`: React's whole client API             |
| `reactre-compat+compiler` | The same, with the JSX compiled by @reactre/compat/compiler                |
| `reactre-compat+core`     | `@reactre/compat/core`, which an app chooses to leave class components out |

The check fails when a scenario differs from React on the default build or with the compiler, or when `@reactre/compat/core` differs for any reason but rendering a class or needing a feature module core leaves out (the scenarios in `NEEDS_FEATURES` in `run.ts`, which need React's transition lanes). The library scenarios cover the 100 React libraries npm downloads most, one package per project, leaving out renderers, frameworks, build and test tools, packages most apps get only as dependencies, libraries whose peer range leaves React 19 out, and ones that need a hosted service. The lists and how they were chosen are at the top of each `libraries-*.tsx` file, named by rank:

- **1–25:** React Router, TanStack Query, Table and Virtual, Radix, framer-motion, Recharts, react-hook-form, react-transition-group, sonner, zustand, lucide-react, React Redux, react-markdown, react-day-picker, cmdk, dnd kit, Sentry, Floating UI, vaul, next-themes, react-resizable-panels, Embla Carousel, input-otp and Emotion.
- **26–50:** Tiptap, SWR, react-i18next, react-error-boundary, React Flow, react-dropzone, styled-components, React Aria, Material UI, qrcode.react, Stripe's React SDK, react-select, react-textarea-autosize, react-icons, Vercel Analytics, react-draggable, react-syntax-highlighter, Headless UI, react-pdf, Jotai, react-colorful, react-window, Apollo Client, Lexical and react-number-format.
- **51–75:** Phosphor Icons, React Spring, react-datepicker, React DnD, Vercel Speed Insights, CodeMirror, react-intersection-observer, react-hotkeys-hook, Formik, react-chartjs-2, Heroicons, TanStack Form, Downshift, react-grid-layout, Swiper, react-helmet-async, React Leaflet, react-hot-toast, react-easy-crop, React-Toastify, Tabler Icons, Ant Design, react-use, React Virtuoso and hello-pangea/dnd.
- **76–100:** lottie-react, react-phone-number-input, React Intl, react-image-crop, XState, MobX, react-qr-code, React Helmet, react-modal, Slate, Mantine, tRPC, ReactPlayer, Valtio, react-device-detect, react-confetti, react-map-gl, Font Awesome, react-copy-to-clipboard, react-tooltip, react-color, notistack, FullCalendar, react-tabs and react-virtualized.
