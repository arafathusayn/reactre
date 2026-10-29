# A configurable @reactre/compat

The goal: an app turns on only the React APIs it uses, and everything only those APIs need leaves its bundle. Example: an app that turns off `useState` and `useEffect` doesn't ship their code, or the passive-effect queue only `useEffect` needs. With every API on, compat is 100% compatible with React, as the full entry is today. Speed must not regress: compat is the fastest React layer in js-framework-benchmark (JFB).

## Where the bytes are

Today's JFB compat bundle is 21.7 KB gzipped (minified, gzip -9). preact/compat's JFB bundle is 8.0 KB.

| Step                                                                             | JFB gzip    |
| -------------------------------------------------------------------------------- | ----------- |
| Today                                                                            | 21.7 KB     |
| Leave out the top-level code only switched-off keys reach                        | ~16.0 KB    |
| Also move the feature checks and tables inside core functions into their modules | ~14–14.5 KB |
| The same without compiled blocks (`compile: false`, slower)                      | ~12.5 KB    |

What remains after that is mostly speed code:

- the reconcile fast paths: swaps, appends, matched suffixes and middles (~2 KB);
- the Template and list deltas;
- placement by longest increasing subsequence;
- lane scheduling.

To beat 8 KB, those must become switches too: `"fastLists"` and `"blocks"`. Then a size-first app trades speed for bytes by its own choice, and the default keeps both.

Cuts that cost no speed:

- production error codes instead of development messages (~0.6 KB, estimated);
- a slimmer `nameOfType` (~0.4 KB).

## Configuration

```ts
reactre({
  compat: {
    apis?: "all" | string[], // default "all": today's behaviour
    exclude?: string[], // e.g. ["useState", "useEffect"]
    compile?: boolean,
  },
});
```

- **Keys are React's export names:** `useState`, `createPortal`, `hydrateRoot`, `preload`, `startTransition`, `Suspense`, `lazy`, `Component`, and so on.
- **Behaviour that props and elements switch on** has keys of its own:
  - `"<svg>"`, `"<math>"`
  - `"customElements"`, `"controlledFields"`
  - `"onMouseEnter"` (the enter/leave family)
  - `"nonBubblingEvents"`, `"keyboardEvents"`
  - `"metadata"` (title/meta/link hoisting)
  - `"action"` (function form actions)
  - `"blocks"`, `"fastLists"`
- **Groups** expand to lists of keys: `"@suspense"`, `"@transitions"`, `"@forms"`, `"@hints"`.
- **`classes`** becomes the `"Component"` key, on by default like every key.
- **The manifest** `packages/compat/src/api.ts` (`@reactre/compat/api`) maps every key to its module and its dependencies. The plugin, the entry generator and the tests all read it.

At buildStart the plugin writes `node_modules/.cache/reactre/compat-<hash>.js`, and `react` and `react-dom` resolve to it. It contains:

- `export *` from `@reactre/compat/core`;
- `export { x } from "@reactre/compat/api/<x>"` for each enabled key;
- callable stubs for the disabled names;
- a default object holding exactly the enabled names.

A real file works the same in Vite's dependency optimizer, webpack, Rollup, esbuild and Bun.

How each import style interacts with this:

- **Named imports and `import * as React`** with static member reads tree-shake normally.
- **`import React from "react"`** keeps every enabled API. In app code, the plugin rewrites `React.x` into named imports when the default binding is never passed anywhere else.
- **CommonJS `require("react")`** keeps every enabled API. The config is what caps it.

## How a module plugs in with no hot-path cost

- `index.ts` became `core.ts` (`@reactre/compat/core`, no class components). The new `index.ts` is the full entry, `@reactre/compat`: core with class support installed, so the default is all of React.
- Each API module imports engine internals from `core.ts` as `__`-prefixed exports, so bundlers inline them and minify their names.
- A module installs its implementation into a module-level slot when it loads, so the slot is filled if and only if an enabled API imported it. No render pays for the install.

Three kinds of slot call:

1. **Guaranteed by state.** Only the module can create that state (`hydrating`, an effect list on a fiber, a BLOCK fiber), so core calls `slot!()` without a check.
2. **Inside a branch that already exists** (`case SUSPENSE`, `tag === "input"`, `type === "svg"`, `name === "action"`). Core calls `(slot ?? missing("…")).run()`.
3. **Function slots that default to doing nothing** (flushPassive), for calls on a flush path. No check at all.

Code reached only through an API's export needs no slot; the bundler drops it when the export goes.

Shared internals, and what pulls each in:

| Internal                                                    | Needed by                                                            | Pulled in by                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| hook(), Hook, the layout queue, `later()`                   | every hook, refs                                                     | always core                                       |
| useReducer's dispatch and the re-render-during-render path  | useState, useReducer, useTransition, useActionState                  | exports                                           |
| effect() and commitEffects                                  | the effect hooks, useImperativeHandle, useSyncExternalStore          | slot (state-guaranteed)                           |
| passive queues, flushPassive, the after-paint passive timer | useEffect, useSyncExternalStore                                      | function slot, nothing by default                 |
| transition state, settle                                    | startTransition, useTransition, useOptimistic, useActionState, forms | exports, plus a slot for `action={fn}`            |
| readThenable                                                | use, useActionState, promise children                                | exports, plus a slot for promise children         |
| runSuspense, runActivity, hiding and showing                | Suspense, Activity, lazy                                             | slots in run's existing cases                     |
| claim functions                                             | hydrateRoot                                                          | slot (state-guaranteed)                           |
| runBlock                                                    | compiled blocks                                                      | function slot, monomorphic; checked with apps/jfb |

Always core:

- element creation, fibers, reconcile, placement, roots;
- React's attribute, style and URL rules (without them apps break silently);
- delegated bubbling events;
- scheduling, error routing, unmounting;
- portals (about 30 B; not worth a switch).

At least one of `createRoot` and `hydrateRoot` must be on.

## Using an API that is turned off

- **The build fails.** The plugin scans every module that imports react, node_modules included: named imports, `React.x`, `require("react").x`. The compat compiler reports host tags and props in the app's own JSX. The error names the key, the importing file and what to add.
- **At runtime, a disabled name is a callable stub** that throws a clear error. A library's `typeof React.useEffect === "function"` check therefore still passes, and the failure is loud rather than a silent fallback.
- **Props and elements** whose behaviour is off throw on first mount, through normal error routing.
- **One silent case:** React applies the SVG kebab-case aliases to HTML elements too. That table stays in core (+0.45 KB).

## Tests

- **Main run.** `bun test --coverage` runs on the full entry. A test-only `__swap(key, impl | null)` empties a slot, so the missing-API branches are covered there and the 100% gate holds.
- **Per-key runs.** `test/profiles/<key>.profile.ts` imports only core plus that key's modules. They run in separate `bun test` processes with coverage off. One of them drops `useState` and `useEffect`, and asserts that flushPassive and commitEffects are absent from the bundle.
- **Size check.** `size.test.ts` builds each profile in memory: JFB minimal, core plus each key, full, full plus `Component`. Any growth over `sizes.json` fails CI.
- **Browser check.** apps/react-compat keeps running every scenario against the full profile against real React in Chrome.

## Order

0. The size check and its budgets (no runtime change).
1. `index.ts` → `core.ts`, a full `index.ts`, `__install`, `missing()`, `__swap`, and the `./api/*` exports. Done: the rename, the full `index.ts` with classes, the `./core` export and the manifest (`@reactre/compat/api`).
2. Plugin: `apis` and `exclude`, the generated entry, the import scan and the stubs. At first every key maps to core. Done: the entry imports only what is on (a counter that imports `React` drops from 28.4 to 23.9 KB gzipped with the rest off).
3. The extra events (~1.5 KB).
4. Controlled fields (~1.2 KB).
5. SVG and MathML, then custom elements (~1.1 KB together).
6. Metadata hoisting, then hydrateRoot.
7. Compiled blocks, then the reconcile fast paths: each checked with apps/jfb.
8. The effect hooks: commitEffects and the passive slot (~0.4 KB).
9. The useReducer family, useRef, useMemo, useCallback, useId, useSyncExternalStore and useEffectEvent, into `api/` modules.
10. Suspense, Activity, lazy and use (~1.3 KB).
11. Transitions.
12. Forms and actions.
13. Hints.
14. Production error codes.

Fragment refs land as their own API module, checked only when a fragment mounts.
