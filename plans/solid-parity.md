# Solid 2.0 parity, measured

836 of Solid 2.0's own tests (solid-js 2.0.0-rc.20, [solidjs/solid@5e68925](https://github.com/solidjs/solid/tree/5e68925cc2fd216a9fb06345019e66d5da5c523c)), ported to reactre's API in [`packages/core/test/solid/`](../packages/core/test/solid): **492 pass** (59%), and 344 fail because reactre lacks the capability or behaves differently.

| Area                                                      | Files                        |  Ported |    Pass |     Gap |  Todo |
| --------------------------------------------------------- | ---------------------------- | ------: | ------: | ------: | ----: |
| Signals and memos                                         | signals, memo                |      72 |      53 |      19 |     0 |
| Effects, ownership, timing                                | effects, owner, timing       |      90 |      50 |      40 |     0 |
| Stores                                                    | store, reconcile, projection |     172 |     128 |      44 |     0 |
| Control flow (Show, Switch, For, Repeat, Portal, Dynamic) | show, for, portal            |     172 |      60 |     112 |     0 |
| Context, errors, components                               | context, errors, component   |      77 |      45 |      32 |     0 |
| Async, Loading, actions                                   | loading, actions             |     122 |      71 |      51 |     0 |
| Server rendering, hydration                               | server, hydration            |     131 |      85 |      46 |     0 |
| **Total**                                                 | 18 files                     | **836** | **492** | **344** | **0** |

Without the list permutations (below), control flow is 60 of 84, and the total 492 of 748 (66%).

The top gaps, by the ports they block:

1. **`row-shape`, 58**: a `<For>`/`<Repeat>` row must be `(item) => <one element />`; Solid's rows may be text, fragments or arrays. Solid runs each of its 6 such sources through about 10 permutations.
2. **`for-placement`, 30**: `<For>`/`<Repeat>` as a component's whole view, not an element's direct child (3 sources × 10 permutations).
3. **`action-writes`, 19**: an action holding and batching its plain writes until it ends.
4. **`bug`, 10**: six bugs, [below](#bugs-found).
5. **`dev-checks`, 15**: Solid's dev warnings (strict reads in a component body) and messages.
6. **`held-writes`, 12**: reads and effects that see a write before `flush()`. By design (reactre applies writes at once), and counted once per file.
7. **`client-error-hook`, 9**: `configureClientErrors`/`render`'s `onError` hearing what a boundary caught.
8. **`glitch-free`, 9**: a diamond's join runs once per changed branch, and memos run depth-first; Solid's run once each, in topological order.
9. **`list-functions`, 8** (`mapArray`, `repeat`); **`render-effects`, 8** (render phase, `onFlush`, `defer`, `schedule`); **`ssr-semantics`, 8** (server primitives).
10. **`misuse-errors`, 7**; **`ssr-helpers`, 7** (`httpStatus`, `httpHeader`, `takeHydrationValue`, `getHydrationWriter`).

The other targets this set out to count: `memo-options` 5, `store-path` 5, `hydration` 5, `client-only` 4, `store-alias` 4, `from` 3, and `jsx-props` 0 (no port found JSX in a prop that did not work). [Gaps, by target](#gaps-by-target) lists all 61 targets and their tests.

## What was read

- **solid-js 2.0.0-rc.20** and **@solidjs/web 2.0.0-rc.20**, the npm `next` tags on 2026-11-01 (solid-js's `beta` tag is 1.10.0-beta.0, a 1.x line), and @solidjs/signals 2.0.0-rc.20, which solid-js re-exports. Their `gitHead` is [solidjs/solid@5e68925](https://github.com/solidjs/solid/tree/5e68925cc2fd216a9fb06345019e66d5da5c523c); the tests were read from the repository at that commit.
- The exports: solid-js's `types/index.d.ts` and `package.json` exports (`.`, `./refresh`, `./attribution`, `./internal`), @solidjs/web's `types/index.d.ts`, `index.server.d.ts`, `client.d.ts`, `server.d.ts`, `server-mock.d.ts`, `response.d.ts` and its subpaths (`./jsx-runtime`, `./storage`, `./serialization`, `./server-functions/*`, `./frames/*`, `./performance-tracks`).
- Nothing downloaded was run: the tarballs were read as data.

Parity here means Solid's capabilities, not its names: reactre keeps its own (`signal`, `memo`, `effect`, `reaction`) and puts runtime APIs in feature modules under `@reactre/core/features/*`.

## Capability map

"Core, compiled" is in `@reactre/core` and compiled away by @reactre/compiler (an app that does not use it ships none of it); "core" is a runtime function of `@reactre/core`'s main entry; "feature" is an opt-in module, `@reactre/core/features/<name>`, that an app ships only if it imports it; "server" is `@reactre/core/server`.

### solid-js: signals, memos and effects

| Solid 2.0                                                                                    | reactre                                                           | Where                     | Known differences                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createSignal(v)`                                                                            | `signal(v)`                                                       | core                      | A write applies at once: a read after it sees it, and its effects run before the setter returns (Solid holds both until `flush()` or the microtask). `batch(fn)` holds effects, not reads.                               |
| `createSignal(v, { equals })`, `createSignal(fn)`                                            | `signal(v, { equals })`, `signal(fn)` (a writable derived signal) | feature `memo`            | `signal(fn)` is synchronous: an async `fn` stores the Promise (Solid's writable async signal is `createOptimistic(fn)` in reactre, or a read-only `memo` from `async`).                                                  |
| `createSignal(v, { unobserved })`                                                            | `signal(v, { unobserved })`                                       | feature `memo`            | `unobserved` is called in a microtask after the last reader left (Solid: when it leaves). `ownedWrite`, `name`, `loc` are not taken.                                                                                     |
| `createMemo(fn)`                                                                             | `memo(fn)`                                                        | core                      | Core's `fn` gets no `prev`; features/memo's `memo(fn, { equals })` does.                                                                                                                                                 |
| `createMemo(fn, { lazy, unobserved })`                                                       | `memo(fn, { lazy, unobserved })`                                  | feature `memo`            | A lazy memo stops in a microtask after its last reader left; a read outside any reader computes it and it stops at the next microtask.                                                                                   |
| `createMemo(async fn)`, async iterables                                                      | `memo(async fn)`                                                  | feature `async`           | See the async rows.                                                                                                                                                                                                      |
| `createMemo` options `loadingValue`, `deferStream`, `transparent`, `ssrSource`, `sync`, `id` | missing                                                           |                           |                                                                                                                                                                                                                          |
| `createDeferred`                                                                             | missing                                                           |                           |                                                                                                                                                                                                                          |
| `createEffect(compute, apply)`                                                               | `reaction(compute, apply)`                                        | feature `reaction`        | `apply` runs at once, and again before the write returns (Solid: at the flush, after render effects). `apply` runs only when the value changed (`!==`). No `defer`/`schedule` options and no `{ effect, error }` bundle. |
| `createEffect(compute, { error })`                                                           | `effect(fn, { error })`                                           | feature `errors`          | One function, not a compute/apply pair.                                                                                                                                                                                  |
| `createRenderEffect`                                                                         | `reaction`, or core `effect`                                      | feature `reaction` / core | reactre has one kind of effect: no render phase ahead of user effects, no `schedule`.                                                                                                                                    |
| `createTrackedEffect(fn)`                                                                    | `effect(fn)`                                                      | core                      | A function `fn` returns is not a cleanup: use `onCleanup`.                                                                                                                                                               |
| `createReaction(apply)(track)`                                                               | missing                                                           |                           |                                                                                                                                                                                                                          |
| `untrack`                                                                                    | `untrack`                                                         | core                      |                                                                                                                                                                                                                          |
| `flush()`, `flush(fn)`                                                                       | `flush()`, `flush(fn)`                                            | feature `timing`          | Outside a batch `flush()` does nothing: there is nothing held. reactre keeps `batch(fn)`, which Solid removed.                                                                                                           |
| `onCleanup`                                                                                  | `onCleanup`                                                       | core                      | Called where nothing owns, it does nothing.                                                                                                                                                                              |
| `onSettled`                                                                                  | `onSettled`                                                       | feature `timing`          | Outside a batch it runs in a microtask.                                                                                                                                                                                  |
| `onFlush`                                                                                    | missing                                                           |                           |                                                                                                                                                                                                                          |
| `createRoot`, `getOwner`, `runWithOwner`                                                     | `createRoot`, `getOwner`, `runWithOwner`                          | feature `owner`           |                                                                                                                                                                                                                          |
| `createOwner`, `isDisposed`, `getObserver`                                                   | missing                                                           |                           |                                                                                                                                                                                                                          |
| `isEqual`                                                                                    | missing (reactre compares with `===`)                             |                           |                                                                                                                                                                                                                          |
| `from(source)`                                                                               | missing                                                           |                           |                                                                                                                                                                                                                          |
| `enableExternalSource`                                                                       | missing                                                           |                           |                                                                                                                                                                                                                          |
| (removed in 2.0) `createSelector`                                                            | `selector(source)`                                                | core                      | reactre's own; Solid 2.0 points to `createProjection`.                                                                                                                                                                   |

### solid-js: async and actions

| Solid 2.0                                   | reactre                                     | Where             | Known differences                                                                                            |
| ------------------------------------------- | ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `<Loading fallback on>`                     | `<Loading fallback on>`                     | feature `async`   | A slot that re-runs and reads something not ready keeps its old nodes, frozen, until the value comes.        |
| `<Reveal order collapsed>`                  | `<Reveal order>`                            | feature `async`   | No `collapsed`.                                                                                              |
| `isPending`, `latest`, `resolve`, `refresh` | `isPending`, `latest`, `resolve`, `refresh` | feature `async`   | `isPending` is false for a plain signal a transition holds the readers of. One transition is open at a time. |
| `NotReadyError`                             | `NotReadyError`                             | feature `async`   |                                                                                                              |
| `lazy(load)`                                | `lazy(load)`                                | feature `async`   | No `{ export }` option.                                                                                      |
| `lazyModule`                                | missing                                     |                   |                                                                                                              |
| `action(function* ...)`                     | `action`                                    | feature `actions` | In an async generator action, code after an `await` runs outside the action.                                 |
| `createOptimistic`, `createOptimisticStore` | `createOptimistic`, `createOptimisticStore` | feature `actions` | An optimistic write outside an action sets the base value.                                                   |
| `affects`, `until`, `TimeoutError`          | `affects`, `until`, `TimeoutError`          | feature `actions` |                                                                                                              |
| `enforceLoadingBoundary`                    | missing                                     |                   |                                                                                                              |

### solid-js: stores

| Solid 2.0                                    | reactre                                                | Where           | Known differences                                                                                     |
| -------------------------------------------- | ------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------- |
| `createStore(v)`, `createStore(fn, seed)`    | `createStore(v)`, `createStore(fn, seed)`              | feature `store` | No async `fn` (use `createOptimisticStore`, or read an async memo in `fn`).                           |
| `createProjection(fn, seed, { key })`        | `createProjection(fn, seed, { key })`                  | feature `store` | No async `fn`.                                                                                        |
| `reconcile(v, key)`                          | `reconcile(v, key)`                                    | feature `store` | `key` is a property name or null; Solid also takes a function of the item.                            |
| `snapshot`, `deep`, `merge`, `omit`          | `snapshot`, `deep`, `merge`, `omit`                    | feature `store` |                                                                                                       |
| `storePath` (in @solidjs/signals only)       | missing                                                |                 |                                                                                                       |
| `$PROXY`, `$TRACK`, `isWrappable`, `flatten` | missing                                                |                 |                                                                                                       |
| (compiler) store reads in JSX                | the compiler binds reads it can follow to a store root | core, compiled  | A read through an alias, a box, a function's result or `props.list` is written once (README's table). |

### solid-js: components, context, control flow

| Solid 2.0                                                                                      | reactre                                                  | Where                                                  | Known differences                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<Show when keyed fallback>`                                                                   | `<Show>`                                                 | core, compiled                                         |                                                                                                                                                                                            |
| `<Switch fallback>`, `<Match when keyed>`                                                      | `<Switch>`, `<Match>`                                    | core, compiled                                         | A `<Match>` stands only directly in a `<Switch>`.                                                                                                                                          |
| `<For each keyed fallback>`                                                                    | `<For each key fallback>`, `keyed={false}`, `keyed={fn}` | core, compiled; `keyed={false}` brings feature `index` | Stands only as an element's direct child. Keyed rows need a key: no `keyed={true}` (by reference) and no default by identity. With `keyed={false}` the index is a number, not an accessor. |
| `<Repeat count from fallback>`                                                                 | `<Repeat count from fallback>`                           | core, compiled                                         | Stands only as an element's direct child.                                                                                                                                                  |
| `mapArray`, `repeat`                                                                           | missing (compiled `<For>`, `<Repeat>` only)              |                                                        |                                                                                                                                                                                            |
| `<Errored fallback>`                                                                           | `<Errored fallback>`                                     | feature `errors`                                       |                                                                                                                                                                                            |
| `configureClientErrors`                                                                        | `configureClientErrors({ onError })`                     | feature `errors`                                       |                                                                                                                                                                                            |
| `resetErrorHalt`                                                                               | missing                                                  |                                                        |                                                                                                                                                                                            |
| `createContext`, `useContext`                                                                  | `createContext`, `useContext`, `ContextNotFoundError`    | feature `context`                                      | A context is a component, as in Solid 2.0. `value` is read once.                                                                                                                           |
| `children(fn)`                                                                                 | missing                                                  |                                                        |                                                                                                                                                                                            |
| `createComponent`                                                                              | (compiled: a component is called with its props)         | core, compiled                                         |                                                                                                                                                                                            |
| `dynamicComponent`                                                                             | `dynamic(source)`                                        | feature `dynamic`                                      |                                                                                                                                                                                            |
| `createUniqueId`, `getNextChildId`                                                             | missing                                                  |                                                        |                                                                                                                                                                                            |
| `isStatic`                                                                                     | missing (the compiler decides what is static)            |                                                        |                                                                                                                                                                                            |
| `markFlight`, `OBSERVE`, `DEV`, `IS_DEV`, `IS_OBSERVE`                                         | missing (devtools and frames)                            |                                                        | reactre's development checks come from its `dist/dev` build.                                                                                                                               |
| `enableHydration`, `NoHydration`, `Hydration`, `isHydrating`, `isHydratable`, `onHydrationEnd` | missing (hydration)                                      |                                                        |                                                                                                                                                                                            |
| subpaths `./refresh`, `./attribution`, `./internal`                                            | missing (hot reload, attribution, internals)             |                                                        |                                                                                                                                                                                            |

### @solidjs/web

| @solidjs/web                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | reactre                                                                                                                                                                                   | Where                             | Known differences                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render(fn, el)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `render(view, el)`; `attach(view, el)` returns the disposer                                                                                                                               | core                              | `render` returns nothing; `attach` is Solid's `render` with its dispose. No `init`/`options` arguments.                                                                                               |
| `hydrate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | missing                                                                                                                                                                                   |                                   | `renderToString(app, { hydrate: true })` writes the markers; the client renders afresh. plans/core-hydration.md is the design.                                                                        |
| `Portal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `<Portal mount>`                                                                                                                                                                          | core, compiled                    | Renders nothing on the server (Solid throws there).                                                                                                                                                   |
| `Dynamic`, `dynamic(source, options)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `<Dynamic component>`, `dynamic(source)`                                                                                                                                                  | core, compiled; feature `dynamic` | No `{ static, deferStream }` options; no Promise source.                                                                                                                                              |
| `For`, `Show`, `Switch`, `Match`, `Errored`, `Loading`, `Repeat`, `Reveal` (re-exported)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | as in solid-js above                                                                                                                                                                      |                                   |                                                                                                                                                                                                       |
| `isServer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `isServer`                                                                                                                                                                                | server                            |                                                                                                                                                                                                       |
| `isDev`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | missing                                                                                                                                                                                   |                                   |                                                                                                                                                                                                       |
| `renderToString`, `renderToStream`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `renderToString`, `renderToStream`, `renderToStringAsync`                                                                                                                                 | server                            | Options: `hydrate`, `nonce`, `onError`; no `renderId`, `noScripts`, `plugins`, `manifest`, `onCompleteShell`, `onCompleteAll`. A stream is a `ReadableStream`, not a pipeable that is also awaitable. |
| `escape`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `escape`                                                                                                                                                                                  | server                            |                                                                                                                                                                                                       |
| `HydrationScript`, `generateHydrationScript`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | missing                                                                                                                                                                                   |                                   |                                                                                                                                                                                                       |
| `clientOnly`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | missing                                                                                                                                                                                   |                                   |                                                                                                                                                                                                       |
| `httpStatus`, `httpHeader`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | missing                                                                                                                                                                                   |                                   |                                                                                                                                                                                                       |
| `takeHydrationValue`, `getHydrationWriter`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | missing                                                                                                                                                                                   |                                   |                                                                                                                                                                                                       |
| `getRequestEvent`, `createRequestEvent`, `RequestContext`, `createResponseStub`, `commitEventResponse`, `createSSRResponse`, `composeMiddleware`, `getExpectedRedirectStatus`, `configureServerErrors`, `reportRequestFailure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | missing (request and response)                                                                                                                                                            |                                   |                                                                                                                                                                                                       |
| `redirect`, `reload`, `respond`, `ResponseEnvelope`, `isResponseEnvelope`, `HREF`, `isHref`, `markSafeError`, `isSafeError`, `REVALIDATE_HEADER`, `REVALIDATE_ALL`, `NULL_BODY_STATUSES`, `RESPONSE_HEADER_VALUE_LIMIT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | missing (response helpers)                                                                                                                                                                |                                   |                                                                                                                                                                                                       |
| `parseCookieHeader`, `serializeCookie`, `clearFlashCookie`, `hasFlashCookie`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | missing (cookies)                                                                                                                                                                         |                                   |                                                                                                                                                                                                       |
| `getServerFunctionMetadata`, `getServerFunctionRPC`, `isServerFunction`, `./server-functions/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | missing (server functions)                                                                                                                                                                |                                   |                                                                                                                                                                                                       |
| `useHead`, `waitAsset`, `warmAsset`, `acquireAsset`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | missing (head and assets)                                                                                                                                                                 |                                   |                                                                                                                                                                                                       |
| `getTraceContext`, `./frames/*`, `./storage`, `./serialization`, `./performance-tracks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | missing (frames, storage, serializer, tracing)                                                                                                                                            |                                   |                                                                                                                                                                                                       |
| `DOMElements`, `SVGElements`, `MathMLElements`, `VoidElements`, `RawTextElements`, `ChildProperties`, `DOMWithState`, `Namespaces`, `DelegatedEvents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not public (the compiler's own tables)                                                                                                                                                    |                                   |                                                                                                                                                                                                       |
| compiler runtime: `template`, `insert`, `spread`, `assign`, `setAttribute`, `setAttributeNS`, `setProperty`, `setStatefulProperty`, `className`, `style`, `setStyleProperty`, `addEvent`, `delegateEvents`, `(un)registerDelegatedRoot/Container`, `getDelegatedRoot`, `dispatchAsInteraction`, `applyRef`, `ref`, `scope`, `effect`, `memo`, `untrack`, `getOwner`, `createComponent`, `mergeProps`, `dynamicProperty`, `readShallow`, `claimElement(Tree)`, `registerElementClaim`, `getNextElement`, `getNextMatch`, `getNextMarker`, `getFirstChild`, `getNextSibling`, `runHydrationEvents`, `installHydrationRuntime`, `installServerComponentHydration`, `getHydrationKey`, `setLinkClaim`, `hasServerLinkState`, `ssr*`, `resolveSSRNode` | reactre's compiled output has its own helpers (`__template`, `__bind`, `__slot`, `__insert`, `__spread`, `__on`, `__ref`, `__style`, and the server's `__ssr*`), internal to its compiler | core, compiled                    | Not an API: what Solid's compiler emits calls. Hydration's claim helpers are missing with hydration.                                                                                                  |
| `./jsx-runtime`, `./jsx-dev-runtime`, `JSX`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `@reactre/core/jsx-runtime`, `/jsx-dev-runtime`                                                                                                                                           | core                              | Types only: TSX must go through the compiler.                                                                                                                                                         |

## Gaps, by target

Each gap test names a target: what reactre would need for it to pass. The first eleven rows are the targets this measurement set out to count; the rest were found by the ports. A count is of ported tests: Solid runs some of its list sources through about ten permutations each (`1 missing`, `swaps`, `rotations`...), so `row-shape` and `for-placement` count each refused source about ten times.

| Target                                                                                                                                                                                                             |  Tests | What it is                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ssr-helpers`                                                                                                                                                                                                      |      7 | `httpStatus`, `httpHeader`, `takeHydrationValue`, `getHydrationWriter`                                                                                                   |
| `render-effects`                                                                                                                                                                                                   |      8 | `createRenderEffect`'s render phase, `createTrackedEffect` on the server, `onFlush`, the `defer` and `schedule` options (and `create-reaction`, 5, for `createReaction`) |
| `from`                                                                                                                                                                                                             |      3 | `from(source)`                                                                                                                                                           |
| `memo-options`                                                                                                                                                                                                     |      5 | `loadingValue`, `deferStream`, `ssrSource` (no port needed `transparent`)                                                                                                |
| `store-path`                                                                                                                                                                                                       |      5 | `storePath`                                                                                                                                                              |
| `client-only`                                                                                                                                                                                                      |      4 | `clientOnly`                                                                                                                                                             |
| `hydration`                                                                                                                                                                                                        |      5 | `hydrate`, `isHydrating`, `<NoHydration>`, a boundary's error serialized for the client                                                                                  |
| `for-placement`                                                                                                                                                                                                    |     30 | `<For>`/`<Repeat>` as a component's whole view (3 Solid sources × 10 permutations)                                                                                       |
| `jsx-props`                                                                                                                                                                                                        |      0 | none found: JSX in `fallback` and other props rendered in every port that had it                                                                                         |
| `store-alias`                                                                                                                                                                                                      |      4 | a store read through an alias, a box, a function's result, `props.list`                                                                                                  |
| `fold`                                                                                                                                                                                                             |      0 | done: `memo(fn, { lazy })` passes; the two `signal(v, { unobserved })` ports fail on timing alone (`unobserved-timing`)                                                  |
| `row-shape`                                                                                                                                                                                                        |     58 | a row that is text, a fragment, an array, `undefined` or an element child (6 sources × up to 10 permutations)                                                            |
| `action-writes`                                                                                                                                                                                                    |     19 | an action holding and batching its plain writes                                                                                                                          |
| `bug`                                                                                                                                                                                                              |     10 | the bugs below                                                                                                                                                           |
| `dev-checks`                                                                                                                                                                                                       |     15 | Solid's dev warnings and messages (strict reads in a component body, ContextNotFoundError's texts)                                                                       |
| `held-writes`                                                                                                                                                                                                      |     12 | reads and effects not seeing a write before `flush()`, by design                                                                                                         |
| `client-error-hook`                                                                                                                                                                                                |      9 | `configureClientErrors` and `render`'s `onError` hearing what a boundary caught                                                                                          |
| `glitch-free`                                                                                                                                                                                                      |      9 | memos updated once each, in topological order                                                                                                                            |
| `list-functions`                                                                                                                                                                                                   |      8 | `mapArray`, `repeat`                                                                                                                                                     |
| `ssr-semantics`                                                                                                                                                                                                    |      8 | server primitives as Solid's server has them                                                                                                                             |
| `misuse-errors`                                                                                                                                                                                                    |      7 | errors for an invalid cleanup value, `flush()` or `onCleanup` where Solid forbids them                                                                                   |
| `action-sync-yield`                                                                                                                                                                                                |      6 | a sync `yield` resuming at once                                                                                                                                          |
| `match-placement`                                                                                                                                                                                                  |      6 | a `<For>` or `<Show>` of `<Match>`es in a `<Switch>`                                                                                                                     |
| `create-reaction`, `dispose-order`, `owner-ids`, `pull-memos`, `portal-events`, `reconcile-identity`, `store-in-place`, `symbol-keys`                                                                              | 5 each |                                                                                                                                                                          |
| `async-store`, `class-instances`, `merge-views`, `optimistic-outside`, `projection-chain`, `refresh-promise`, `transition-scope`                                                                                   | 4 each |                                                                                                                                                                          |
| `cleanup-throw`, `error-accessor`, `store-direct-write`                                                                                                                                                            | 3 each |                                                                                                                                                                          |
| `array-text`, `class-values`, `effect-errors`, `lazy-retry`, `no-owner`, `pending-signal`, `settled-async`, `unobserved-timing`                                                                                    | 2 each |                                                                                                                                                                          |
| `async-signal`, `children-helper`, `draft-define`, `dynamic-svg`, `effect-bundle`, `effect-equals`, `fallback-tracking`, `for-index`, `memo-errors`, `root-hold`, `stale-accessor`, `store-spread`, `switch-reads` | 1 each |                                                                                                                                                                          |

[`harness.ts`](../packages/core/test/solid/harness.ts)'s `GAPS` has a line on each.

### The gap tests

Per target, per file and reason, the Solid test names (`×n`: that many permutations or Solid files with the name).

#### `row-shape` (58)

- for.test.ts, a text row is refused: "Create each control flow" (×2); "1 missing"; "2 missing"; "3 missing"; "all missing"; "swaps"; "rotations"; "reversal"; "full replace"; "swap backward edge".
- for.test.ts, a fragment row is refused: "Create each control flow" (×5); "1 missing" (×3); "2 missing" (×3); "3 missing" (×3); "all missing" (×3); "swaps" (×3); "rotations" (×3); "reversal" (×3); "full replace" (×3); "swap backward edge" (×3).
- for.test.ts, an array row is refused: "Create each control flow"; "1 missing"; "2 missing"; "3 missing"; "all missing"; "swaps"; "rotations"; "reversal"; "full replace"; "swap backward edge".
- for.test.ts, a row of undefined is refused: "Create each control flow" (×3).
- for.test.ts, an element child (no row function) is refused: "Create each control flow"; "element children run once per row".

#### `for-placement` (30)

- for.test.ts, a list that is a component's whole view is refused: "Create each control flow" (×3); "1 missing" (×3); "2 missing" (×3); "3 missing" (×3); "all missing" (×3); "swaps" (×3); "rotations" (×3); "reversal" (×3); "full replace" (×3); "swap backward edge" (×3).

#### `action-writes` (19)

- actions.test.ts, a plain write in an action is not held: it reads at once, and its effects run at once: "should maintain transition context across async boundaries"; "should initialize a transition when action starts"; "should keep transition alive while action is running"; "should allow multiple concurrent actions in same transition"; "should only complete transition when ALL actions finish"; "should merge actions when one action calls another"; "should hold regular signal updates during action"; "latest() shows an entangled write at once, and a later rewrite during the hold wins at settle"; "should handle action called multiple times"; "should support yield\* with async helper generator"; "should complete the transition when an async generator throws"; "should remove action from transition on error but let transition continue"; "should allow optimistic override during transition with held source".
- actions.test.ts, a plain write in an action is not held: its effect runs at once: "should complete transition when action finishes"; "should flush held signals when action completes"; "should maintain transition context across all delegated yields"; "should hold regular signal value during transition while showing optimistic".
- actions.test.ts, an action's writes are not batched: each optimistic write runs the effect: "should revert multiple optimistic signals together when transition completes".
- actions.test.ts, a plain store write in an action is not held: its effect runs at once: "should hold regular store value during transition while showing optimistic".

#### `bug` (10)

- show.test.ts, with a function child, `when` runs twice per change: "Toggle show control flow".
- signals.test.ts, memo(fn) calls a function fn returns, as a setter's updater: "updates downstream pending computations".
- reconcile.test.ts, core memo stores what a function it returns returns: "replaces a TRACKED function-valued object leaf without invoking it"; "replaces a TRACKED function-valued array item without invoking it".
- server.test.ts, reaction's apply half runs during a server render: "runs compute but not effectFn on the server".
- server.test.ts, on the server an async rejection under `<Errored>` renders the empty content, not the fallback: "Errored inside Loading — async rejection resolves to error fallback HTML"; "bare rejected async memo under Errored inside Loading resolves to error fallback"; "stream completes after error (no hang)".
- server.test.ts, a spread's attribute names are written unchecked, so a key can inject markup: "through a compiled spread".
- server.test.ts, a `<Dynamic>` tag name is written unchecked, so a tag can inject markup: "a tag that is not one HTML element name throws, on every render".

#### `dev-checks` (15)

- errors.test.ts, the dev build does not log an error that a fallback cannot see: "zero-arity fallback thunk renders".
- context.test.ts, ContextNotFoundError has one generic message: "default-less, no provider: says so and suggests a null default"; "a default-less read with no Provider suggests a null default"; "a Provider passing undefined counts as not provided".
- context.test.ts, createContext takes no name, and the message is generic: "explicit undefined default: says undefined is not a default"; "a provider passing undefined: says it counts as not provided"; "an explicit undefined default is no default; the dev message says so".
- context.test.ts, ContextNotFoundError's message is reactre's own: "a ContextNotFoundError constructed without a context keeps the generic message".
- component.test.ts, a call of a component that is not a function throws a plain TypeError: "non-function component throws a descriptive dev error, not a name-read crash (#3005)".
- component.test.ts, no strict-read warning for a signal read in a component body: "warns on direct signal read in component body"; "nested components each warn independently".
- component.test.ts, no strict-read warning for a reactive prop read in a component body: "warns on props.value access backed by signal".
- component.test.ts, no strict-read warning for a store property destructured in a component body: "warns on store property destructuring".
- component.test.ts, no strict-read warning for a keyed `<Show>` child reading its store value as it is built: "warns when keyed Show children read properties from store values during setup".
- component.test.ts, no strict-read warning for a keyed `<Match>` child reading its store value as it is built: "warns when keyed Match children read properties from store values during setup".

#### `held-writes` (12)

- store.test.ts, a write is read at once, before flush(): "reads see a store write only after flush()".
- actions.test.ts, Solid holds an optimistic write until flush: "a setter write is not visible before the flush (createOptimistic basic behavior)".
- memo.test.ts, an async memo recomputes at the write, before flush(): "a write is held until flush (diamond should not cause waterfalls on read, should waterfall when dependent on another async)".
- signals.test.ts, a read after a write sees it before flush(): "a write is held until flush (should update signal via setter, via update function, accept equals option)".
- effects.test.ts, an effect runs when it is made and at each write: "an effect has not run before the flush (createEffect, createTrackedEffect and flush: should run effect, should batch updates)".
- effects.test.ts, the first run is not merged into the next write's: "should run effect on change" (×2).
- effects.test.ts, the effect ran when it was made, before the root was disposed: "should stop effect" (×2).
- effects.test.ts, the inner effect ran when it was made: "should dispose of nested effect".
- effects.test.ts, the handler sees the error at the write: "error that recovers before the effect phase never reaches the handler (#2840)".
- loading.test.ts, Solid's async boundary holds a write until flush: "Children are reactive (before the flush, the old count)".

#### `client-error-hook` (9)

- errors.test.ts, onError hears only what no boundary caught: "a boundary rendering its fallback reports the error once, with what it caught"; "a reset that recomputes the same failure says nothing new; a different error is a new report"; "a primitive thrown has no identity and is reported per sight"; "a throwing hook is reported on the console; the boundary still renders".
- errors.test.ts, the same, with no owner path: "carries the owner path where owners are labelled".
- errors.test.ts, no root-level hook (ROOT_ERROR_HOOK): "a root's own hook (under ROOT_ERROR_HOOK) wins over the ambient one for failures under it".
- errors.test.ts, configureClientErrors does not check onError: "refuses a non-function".
- errors.test.ts, render takes no onError: "an `<Errored>` fallback under the root reports once, with the component labels"; "the root's hook wins over the ambient one; a root without one reports ambiently".

#### `glitch-free` (9)

- signals.test.ts, the join re-runs once per changed branch: "should only update every signal once (diamond graph)"; "should only update every signal once (diamond graph + tail)"; "should only update every signal once (jagged diamond graph + tails)"; "only propagates once with linear convergences"; "only propagates once with exponential convergence"; "ensures that new dependencies are updated before dependee".
- signals.test.ts, memos re-run depth-first, as each source writes: "propagates in topological order"; "applies updates to changed dependees in same order as createMemo"; "evaluates stale computations before dependees when trackers stay unchanged".

#### `list-functions` (8)

- store.test.ts, mapArray is missing: "Tracking Top-Level Array iteration, through mapArray".
- for.test.ts, reactre's lists are compiled `<For>` and `<Repeat>`: "should compute keyed map" (×2); "should notify observer" (×2); "should compute map when key by index".
- server.test.ts, mapArray is missing: "maps array items".
- server.test.ts, repeat is missing: "repeats with from offset".

#### `render-effects` (8)

- effects.test.ts, reactre has one kind of effect, run in creation order: "should run render effect before user effects" (×2).
- effects.test.ts, reaction takes no defer option: "should defer user effects with the defer option".
- effects.test.ts, reaction takes no schedule option: "does not run initial render-effect callback synchronously when schedule: true".
- effects.test.ts, reactre has no onFlush: "runs after the drain when called from an effect callback"; "lands after inline writes in the same frame; callbacks run in order and batch".
- server.test.ts, an effect has no defer option: "defer: true skips the initial effect run but still computes (#2811)".
- server.test.ts, createTrackedEffect is missing (on the server): "is a no-op".

#### `ssr-semantics` (8)

- server.test.ts, a memo on the server computes when first read: "memo is eager by default".
- server.test.ts, an optimistic write lands on the server: "createOptimistic writes do not land".
- server.test.ts, an optimistic setter runs its updater on the server: "createOptimistic never invokes updaters".
- server.test.ts, an optimistic store's setter runs on the server: "createOptimisticStore setters do not run or land".
- server.test.ts, deep() returns a copy, on the server too: "is identity".
- server.test.ts, isPending is false for a first async read: "isPending propagates NotReadyError from ownerful initial async reads".
- server.test.ts, action() wraps its function on the server too: "action passes through".
- server.test.ts, an async read outside every `<Loading>` renders nothing: "throws on async content without Loading boundary".

#### `misuse-errors` (7)

- timing.test.ts, flush() in an onSettled callback runs: "should throw when owner-backed onSettled calls flush reentrantly".
- timing.test.ts, onCleanup in an onSettled callback is taken: "should forbid onCleanup inside owner-backed onSettled".
- timing.test.ts, a cleanup returned where nothing owns is dropped: "should reject a returned cleanup in an unowned scope (#2766)".
- timing.test.ts, a value that is not a function is ignored: "should throw on invalid cleanup values".
- effects.test.ts, reaction ignores a cleanup that is not a function: "should throw on invalid cleanup values".
- effects.test.ts, reactre lets a tracked effect make memos and cleanups: "should throw when creating tracked-effect children inside (\_\_DEV\_\_ only)".
- effects.test.ts, an effect's return value is ignored: "should throw on invalid cleanup values".

#### `ssr-helpers` (7)

- hydration.test.ts, httpStatus() is missing: "declares status and statusText on the event's response during SSR"; "restores the snapshotted status on disposal, not a hardcoded 200".
- hydration.test.ts, httpHeader() is missing: "declares a header on the event's response during SSR"; "append adds to an existing value instead of replacing it".
- hydration.test.ts, takeHydrationValue() is missing: "seeded values: resolved, then gone (take-and-remove)"; "undefined with no registry or no entry".
- hydration.test.ts, getHydrationWriter() is missing: "getHydrationWriter is undefined on the client".

#### `action-sync-yield` (6)

- actions.test.ts, every yield resumes in a microtask, a value that is not a Promise too: "should execute generator body synchronously for sync yields"; "should step through multiple yield statements in sequence"; "should handle generators with only sync yields"; "should pass yielded values back into generator via yield expression result"; "should handle generator that yields undefined"; "should support yield\* with sync helper generator".

#### `match-placement` (6)

- show.test.ts, `<Switch>` refuses a `<For>` of `<Match>`es: "Create Switch control flow"; "Toggle Switch control flow".
- show.test.ts, `<Switch>` refuses a `<Show>` around a `<Match>`: "mounts with the gate off (nullish child slot)"; "gate on: gated Match participates in selection order"; "gate back off: selection falls through to later matches".
- server.test.ts, a `<Match>` stands only directly in a `<Switch>`: "skips nullish child slots from conditionally excluded Matches (#2911)".

#### `create-reaction` (5)

- effects.test.ts, reactre has no createReaction: "Create and trigger a Reaction"; "fires and disposes cleanly when the rerun tracks zero dependencies"; "re-arming before a fire replaces tracked sources (#2861)"; "re-arm inside the reaction callback arms the next cycle (#2861)".
- server.test.ts, createReaction is missing: "calls tracking function once".

#### `dispose-order` (5)

- owner.test.ts, reactre disposes an owner's children in creation order: "should clean up in reverse order".
- owner.test.ts, reactre runs an owner's children and cleanups in creation order: "cleanup order is unwind: children before owner, later registrations before earlier".
- owner.test.ts, reactre disposes sibling roots and effects in creation order: "should dispose all roots".
- effects.test.ts, reactre runs effects' and owner's cleanups in creation order: "fires in unwind order at the effect's structural position".
- server.test.ts, a root's cleanups run first-registered first, before its children's: "cleanup order is unwind: children before owner, later registrations before earlier (#3572)".

#### `owner-ids` (5)

- owner.test.ts, reactre has no getNextChildId: "should generate ids if id is provided".
- owner.test.ts, reactre's owners have no id: "should reset child ids when computations rerun".
- component.test.ts, createUniqueId is missing: "creating some".
- server.test.ts, owners have no id: "Show (non-keyed) children run under value memo scope"; "Repeat items run under per-item owners".

#### `portal-events` (5)

- portal.test.ts, the click reaches the portal's handler, not the `<section>`'s: "default body portal from an app root bubbles through the logical tree"; "outside-root portal delegated events bubble through the logical tree"; "delegated event targeting the render root itself does not crash with a body portal (#3008)"; "delegated events bubble through logical tree with an earlier sibling mount ref"; "delegated events retarget through nodes inserted by swaps".

#### `pull-memos` (5)

- memo.test.ts, a memo recomputes at the write, before it is read: "should only re-compute when needed".
- memo.test.ts, a memo nothing observes recomputes at the write: "should release untracked-read ownerless memos at flush, idempotently within a tick".
- memo.test.ts, a chain nothing observes recomputes at the write: "should recompute ownerless chains on direct read after suspension".
- memo.test.ts, memo() runs fn at once, so its error throws where the memo is made: "should route init errors through the boundary without a memo fallback".
- signals.test.ts, the memo keeps its value after an untracked source changes: "should not affect deep dependency being created".

#### `reconcile-identity` (5)

- projection.test.ts, a projection merges into its old children when the root's key changes: "does not merge children across an entity change".
- projection.test.ts, reconcile merges into the root whatever its key: "reconcile() itself still rejects a root identity mismatch".
- reconcile.test.ts, reconcile merges into the root whatever its key: "Reconcile top level key mismatch"; "Reconcile nested top level key mismatch"; "Reconcile top level key missing".

#### `store-in-place` (5)

- store.test.ts, a store writes into the object it was given, whose descriptors hold: "written non-configurable properties keep satisfying the proxy invariant".
- store.test.ts, a snapshot is always a copy: "returns same object if unchanged".
- reconcile.test.ts, a snapshot is a copy of the objects given, not them: "Reconcile reorder a keyed array, by snapshot identity".
- reconcile.test.ts, a keyless swap merges the new object's values into the old one, which another store owns: "Reconcile swaps keyless store-proxy property values".
- reconcile.test.ts, the draft writes into the object given, so returning that object adopts the write: "a returned replacement that is the SAME raw as committed still cancels the draft".

#### `store-path` (5)

- store.test.ts, storePath is missing: "storePath root merge keeps symbol keys"; "Functional setter no-op when returning same value"; "Triggers reactive updates"; "Deeply nested reactive updates"; "Delete triggers reactive updates".

#### `symbol-keys` (5)

- store.test.ts, a returned replacement copies string keys only: "Returned object replacement keeps symbol keys".
- store.test.ts, merge and omit enumerate string keys only: "merge/omit enumerate symbol keys".
- store.test.ts, deep and snapshot copy string keys only: "tracks updates in a symbol-keyed subtree".
- reconcile.test.ts, reconcile compares and copies string keys only: "notifies an effect tracking a symbol-keyed property"; "a symbol `in` check updates when reconcile adds the key".

#### `async-store` (4)

- actions.test.ts, createStore takes no async function: "control: createStore(fn, seed) in the same spot".
- loading.test.ts, createProjection takes no async function: "shows fallback while async projection is pending"; "side effect only runs when no longer pending"; "handles rapid signal changes while pending".

#### `class-instances` (4)

- store.test.ts, a store wraps plain objects and arrays only: "wrapped nested class"; "not wrapped nested class"; "prototype getters track instance field updates"; "user-class methods on the draft keep the proxy `this` (reactive writes)".

#### `client-only` (4)

- hydration.test.ts, clientOnly() is missing: "SSRs the fallback and never starts the import"; "renders nothing without a fallback"; "starts the import eagerly by default"; "lazy option defers the import to first render".

#### `merge-views` (4)

- store.test.ts, merge skips null and undefined sources, not false: "falsey values".
- store.test.ts, merge and omit are copies of getters, not views: "returns same reference when only one argument".
- store.test.ts, merge takes no function source: "simple set".
- store.test.ts, omit takes keys, not a predicate: "omit with a predicate hides keys by rule".

#### `optimistic-outside` (4)

- actions.test.ts, an optimistic write outside an action sets the base value: "a setter write in a frame that does not park never shows"; "should provide current optimistic value in update callback".
- actions.test.ts, an optimistic write outside an action sets the value until its function runs again: "should derive from source; an optimistic write with no frame to hold it never shows".
- actions.test.ts, an optimistic store's write outside an action sets its base: "should handle async projection and revert optimistic writes".

#### `projection-chain` (4)

- projection.test.ts, a projection copies what its fn returns once; a store it returns is not followed: "derive returning a store adopts it live: updates flow with no re-derive"; "array store at the root: structural and row updates flow"; "derived createStore(fn, seed) chains the same way"; "enumeration tracks through the chain".

#### `refresh-promise` (4)

- loading.test.ts, refresh() resolves with undefined, not the new value: "sync source: resolves with the re-executed value"; "async source: resolves with the landed value; the window stays quiet".
- loading.test.ts, an ignored refresh() whose re-ask fails is an unhandled rejection: "fire-and-forget refresh with a failing re-ask surfaces no unhandled rejection".
- loading.test.ts, refresh() of a plain signal's read throws TypeError: "plain signal accessor: refresh is a no-op — already quiescent, resolves with the value".

#### `store-alias` (4)

- store.test.ts, the compiler cannot follow the read to a store, so the hole is written once: "a store's array read through a local alias"; "a store read through a box"; "a store's array returned by a function, and its rows' reads"; "a store's array passed as props.list".

#### `transition-scope` (4)

- loading.test.ts, the update's transition holds the keyed `<Show>`'s rebuild, so the new boundary's fallback does not show: "new keyed Loading boundary shows fallback for previously resolved async value while it refreshes"; "isPending falls back only for newly mounted attribute branches".
- loading.test.ts, a write whose new reader waits on a flight already out is not held with it: "a conditional reveal waits for an async flight from an earlier flush".
- loading.test.ts, a branch change whose new content waits on fresh async reads is not held: "implicit route transition stays held after lazy component is cached".

#### `cleanup-throw` (3)

- owner.test.ts, a throwing cleanup stops the teardown: "runs every cleanup in the tree and rethrows the first error after"; "a throwing effect cleanup does not stop the owner's own cleanups".
- server.test.ts, the same: "a throwing cleanup does not stop the walk; the first error is rethrown after (#4193)".

#### `error-accessor` (3)

- errors.test.ts, the fallback gets the first error, and the children behind it are disposed: "instantiates the fallback once per show: a second error reaches it through the `error` accessor, not a re-render".
- loading.test.ts, an `<Errored>` keeps its first error: "isPending on an upstream signal clears after async rejection (issue #2700)"; "Errored shows the latest async error after repeated rejections (issue #2701)".

#### `from` (3)

- timing.test.ts, reactre has no from: "a value emitted during subscribe is readable right after flush (no tick)"; "dispose unsubscribes, and later emissions are ignored"; "accepts an RxJS-shaped Observable returning { unsubscribe }".

#### `store-direct-write` (3)

- store.test.ts, a direct write or delete on a store throws; Solid ignores it: "Setting a property"; "is immutable from the outside"; "Deleting a property".

#### Targets of one or two tests

- `array-text`: portal.test.ts "keeps raw array children reactive"; server.test.ts "adjacent memos that yield text are separated" (`["a", "b"]` shows as "a,b").
- `class-values`: server.test.ts "standalone booleans in arrays are ignored", "a skipped first class key leaves no leading space" (a class array or object from an expression is written as its string).
- `effect-errors`: effects.test.ts "compute-phase throw with no handler: logged, run skipped, system alive", "unhandled compute-phase error is logged unwrapped (#2840)" (thrown to the write instead).
- `lazy-retry`: loading.test.ts "failed import is not cached — Errored reset() retries the download (#2999)", "preload() retries after a failed import (#2999)".
- `no-owner`: context.test.ts "should throw error when trying to get context outside owner", "should throw error when trying to set context outside owner".
- `pending-signal`: show.test.ts "shows the pending indicator while the async memo refetches", "variant B from the issue: when reads a() before isPending(a)".
- `settled-async`: timing.test.ts "should wait for async to settle before running", "should call cleanup on re-run after async settles".
- `unobserved-timing`: signals.test.ts "should call unobserved callback when subscriber is disposed", "should call unobserved callback when signal is unobserved" (`unobserved` runs in a microtask after the last reader left, as a reader that runs again drops its reads before it reads anew; Solid calls it as the reader leaves).
- `async-signal`: server.test.ts "createSignal(fn) async value triggers Loading fallback (mirrors createMemo)".
- `children-helper`: component.test.ts "children".
- `draft-define`: store.test.ts "supports Object.defineProperty inside a setter".
- `dynamic-svg`: portal.test.ts "Renders SVG elements".
- `effect-bundle`: errors.test.ts "should catch errors thrown in user effect callbacks with error handler (back half)".
- `effect-equals`: effects.test.ts "should handle nested effect".
- `fallback-tracking`: errors.test.ts "zero-arity fallback that reads a signal re-renders when it changes".
- `for-index`: for.test.ts "Testing each with indexes > Create each control flow".
- `memo-errors`: errors.test.ts "should recover when sync memo errors then dependency changes and boundary resets".
- `root-hold`: loading.test.ts "isPending lets top-level initial async hold render".
- `stale-accessor`: show.test.ts "dangling callback > Create Switch control flow".
- `store-spread`: portal.test.ts "Testing Dynamic with state spread > Toggle Dynamic control flow".
- `switch-reads`: show.test.ts "Testing Switch conditions evaluation counts > Toggle conditions".

## Bugs found

Where reactre claims a capability and the port shows it wrong. Each has `gap("bug", ...)` tests, which fail until it is fixed. Bugs 2, 3 and 5 are fixed: their ports are plain tests now, and each has regression tests in the module's own test file.

1. **Core `memo` treats a function its `fn` returns as a setter's updater** (3 ports: signals "updates downstream pending computations", reconcile's two "replaces a TRACKED function-valued ... without invoking it"). `memo` stores `fn()` through `signal`'s setter, which calls any function it is given. The async build (`computed`) does not, so the two builds disagree. `reaction`, built on `memo`, has it too. features/memo's `memo` does not.
   ```ts
   import { memo } from "@reactre/core";
   const f = () => "called";
   memo(() => f)(); // "called"; expected f
   memo(() => () => 5)(); // 5 (typeof "number"); expected a function
   ```
2. **Fixed.** `reaction`'s effect now takes the live mark from its memo: once `compute` has read through `latest` or `isPending`, no transition holds `apply` (async.test.ts "a reaction whose compute reads through latest or isPending is not held"). Was: **`reaction`'s compute does not escape a transition through `latest` or `isPending`** (3 ports: memo's "should should show pending state in graph" and "should track pending value changes for loading indicator pattern", loading's "latest(asyncMemo) ... re-reports pending on each refresh (#2829)"). `latest` marks the current observer live, and in `reaction` that is the internal memo, not the effect that runs `apply`. The README says an effect that reads through `latest`/`isPending` is not held. With the async runtime on:
   ```ts
   const [s, set] = signal(1);
   const a = memo(() => Promise.resolve(s())); // features/async
   effect(() => void a());
   let r = 0, e = 0;
   reaction(() => latest(s), (v) => (r = v));
   effect(() => (e = latest(s)));
   await tick();
   set(2); // e === 2, r === 1
   ```
3. **Fixed.** An action called in another action's code settles its Promise when its generator ends, as Solid's always do; one called anywhere else still settles when the transition ends (actions.test.ts "an action called in another's code settles as it returns"). Was: **An action that yields another action's Promise never settles** (actions "should support yielding another action's promise"). The inner action joins the one open transition; its Promise waits for the transition, which waits for the outer action. The README says overlapping actions end together, not that they deadlock.
   ```ts
   const inner = action(function* () { yield Promise.resolve(); return 1; });
   await action(function* () { yield inner(); })(); // never resolves
   ```
4. **`<Show>` with a function child evaluates `when` twice per change** (show "Testing nonkeyed function show control flow > Toggle"). The compiler emits one memo for `!!when` and another for the accessor's value, and both run the expression; with plain children it runs once.
   ```tsx
   let n = 0; const [c, setC] = signal(0);
   attach(() => <div><Show when={(n++, c())}>{(v) => <span>{v()}</span>}</Show></div>, root);
   setC(7); // n === 3; Solid: 2
   ```
5. **Fixed.** `reconcile` on a shallow store replaces its values by reference, and re-runs their readers (store.test.ts "on a shallow store, it replaces the values"). Was: **`reconcile` on a shallow store merges into its raw rows and re-runs no reader** (store's two shallow.test.ts ports). A shallow store hands out raw values and tracks its own keys only, so a merge into the old row changes the caller's object and notifies nothing. The README says a shallow store's values are replaced.
   ```ts
   const [s, set] = createStore([{ v: 1 }], { shallow: true });
   effect(() => console.log(s[0]));
   set(reconcile([{ v: 2 }], null)); // logs nothing; s[0] is the old object, now { v: 2 }
   ```
6. **`reaction` runs its apply half during a server render** (server "runs compute but not effectFn on the server"). The README says effects do not run on the server. The server compile rewrites the app's own `effect` imports, but feature modules (features/reaction) get the real core `effect` through `@reactre/core/server`. In a server build: `reaction(() => 1, () => log.push("ran"))` in a component, then `renderToString`, logs "ran". Other feature modules' effects may do the same (not checked).
7. **On the server, `<Errored>` turns an async rejection into empty content** (3 server ports from ssr-async.spec and ssr-stream.spec). No fallback and no error: the stream ends with `<template id="rr:t0"><p></p></template>`. Without `<Errored>`, `renderToStringAsync` rejects with the error, as it should. In a server build:
   ```tsx
   const data = memo(() => Promise.reject(new Error("boom"))); // features/async
   <Loading fallback="L"><Errored fallback={(e) => <span>err {e.message}</span>}><p>{data()}</p></Errored></Loading>
   // renderToStringAsync: "<p></p>"; expected the fallback
   ```
8. **The server writes a spread's attribute names unchecked** (server "through a compiled spread"): a key can inject markup. The client's `setAttribute` throws for such a name; Solid drops it.
   ```ts
   __ssrAttrs({ "x><script>alert(1)</script": "" }); // ` x><script>alert(1)</script=""`
   ```
9. **The server writes a `<Dynamic>` tag name unchecked** (server "a tag that is not one HTML element name throws, on every render"): `<Dynamic component={tag()} />` with `"div x"` gives `<div x></div x>`. Solid throws "is not a valid tag name".

Found on the way, filed as gaps rather than bugs since reactre claims nothing about them, but worth a look:

- A cleanup that throws stops the teardown (`cleanup-throw`): the owner's later cleanups never run and its later children are never disposed, so they stay subscribed. `createRoot((d) => { onCleanup(() => log.push("owner")); reaction(() => 1, () => () => { throw e; }); return d; })()` throws and `log` stays empty.
- Fixed: a draft write of `__proto__`, or a `reconcile` of JSON with an own `__proto__` key, set that store object's prototype (`proto-guard`). It was worse than first filed: `reconcile(JSON.parse('{"__proto__": {"x": 1}}'))` merged into `Object.prototype` itself (the inherited `__proto__` read as the object to merge into), and so did a draft write through an inherited `__proto__` or `constructor` (`d.__proto__.x = 1`). Now, as in Solid 2.0, a draft write of `__proto__` is dropped; an inherited `__proto__` or `constructor` reads as undefined through a store or a draft; and an own `__proto__` (JSON's), from `reconcile`, a returned object or `snapshot`, is kept as own data (store.test.ts "\_\_proto\_\_ and constructor").
- `packages/core/package.json`'s `sideEffects` lists `./src/features/*.ts` and not `./src/server/*.ts`, so in a server build a bare `import "@reactre/core/features/async"` (rewritten to `server/async`) can be dropped by the bundler, and an async memo then reads as a Promise.

## How the ports are written

The ports are in [`packages/core/test/solid/`](../packages/core/test/solid), one file per area, and run in `bun test` with the rest. [`harness.ts`](../packages/core/test/solid/harness.ts) holds Solid's license and the rules:

- Each Solid `it` is one `test`, under Solid's name, in a `describe` named for its Solid file (Solid's own `describe`s kept inside). Each file's header names the Solid files it ports.
- Names are translated to reactre's (the map above), and each test keeps its intent and assertions. Where reactre has no such function, the port says how it was expressed (Solid's default keying by reference is `key={(x) => x}`; `render` returning a disposer is `attach`; an `Errored` fallback's `err()` accessor is `err`).
- TSX is compiled from strings by @reactre/compiler, as the plugin compiles it, and run on the fake DOM (`compile(src, modules, scope)`). The server ports that need a context provider or `<Errored>` on the server build the source with `Bun.build` and the compiler's Bun plugin in server mode, as a server build does, into a temp folder.
- Solid holds a write until `flush()`; reactre applies it at once, by design. `flush` (features/timing) is kept where Solid calls it. An assertion that a read or an effect has not yet seen a write is not repeated in every port that steps through one: each file has one `held-writes` test that collects them, so the design difference counts once per file.
- A port that fails because reactre lacks the capability or behaves differently is `gap(kind, why, name, fn)`: `test.failing` (Bun 1.4.4 has it), so it runs, must fail, and is reported once it passes; its name ends with `[kind: why]`. `SOLID_STRICT=1 bun test packages/core/test/solid` runs them as plain tests, to see why each fails; every one was checked to fail for its stated reason.
- The ports of `memo(fn, { lazy })` and `signal(v, { unobserved })` call `folded` in the harness: features/memo's reader-counting entries, which a call that passes either option compiles to. A port is TypeScript the compiler does not see, and `memo` and `signal` themselves throw for the options in the development build that `bun test` runs.
- Files that load features/async or features/actions turn the async runtime on before their tests and off after, as `../async.test.ts` does.
- When a capability lands, its `gap` tests start to pass and fail the run: make them plain `test`s and update the counts here. The counts come from a JUnit report: `bun test --reporter=junit --reporter-outfile=<file> packages/core/test/solid`, where a gap's name ends with `[kind: why]`.

Not ported: Solid's tests of its own machinery (attribution, lanes, held/verdict/landing internals, devtools and diagnostics records, dist artifacts, fuzzing, HMR), of server functions, frames, assets, cookies, request events and the serializer (missing as families, see the map), and most issue-numbered scheduling regressions. Each file's header and the agents' notes say what was read and skipped.
