# Changelog

All notable changes to @reactre/dom, @reactre/core, @reactre/compiler, @reactre/compat and @reactre/plugin are recorded here. The packages are released together, at the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### @reactre/core

- Fixed: a `<For>` row with several handlers for one event type, such as two `onClick` links, calls the clicked one once per event. Before, the list added one listener per handler, so each click ran the handler once per handler of its type.

### @reactre/plugin

- Added: `compat.apis` and `compat.exclude` switch React's APIs on and off one by one, by export name or group (`@suspense`, `@transitions`, `@forms`, `@hints`, `@classes`). With any off, `react` resolves to a module written for the options, which imports only the APIs that are on and exports each one that is off as a function that throws, naming the fix. The build fails where a module, a dependency included, imports a switched-off API, reads it as `React.x`, or takes it from `require("react")`.
- Changed: in compat mode, `classes` defaults to true: `react` resolves to @reactre/compat, React's whole client API. `classes: false` resolves it to @reactre/compat/core, without class components.
- Added: in compat mode, `react-dom/server`, `react-dom/static` and their `.browser`, `.edge`, `.node` and `.bun` builds resolve to @reactre/compat/server, with or without `classes`.
- Added: Server Components stay on React: compat mode leaves a Vite environment named `rsc`, and a build that resolves with the `react-server` condition (Vite, Rolldown, esbuild, webpack, Rspack, Bun), alone. In Vite the redirect is now a resolve hook per environment, applied in each environment's dependency optimizer too, instead of `resolve.alias`.
- Fixed: in compat mode, a dependency that cannot see @reactre/compat through `node_modules`, as with Bun's and pnpm's isolated installs, gets the app's copy of compat for `react`, not React or nothing. In every bundler the target resolves from the importer's directory when it reaches @reactre/compat, else from the app's root, else from the plugin's own. `vite dev` now prebundles one copy of compat that the app and its dependencies share; before, its dependency scan failed.
- Added: one plugin for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun, built on unplugin and running under Node and Bun. By default it compiles reactre TSX; with `compat`, it resolves `react` and `react-dom` to @reactre/compat (or its class build) and compiles the app's JSX with @reactre/compat/compiler.

### @reactre/compiler

- Added: an ES module build in `dist/`, so Node can load `compileJs` and the scanner.
- Changed: numbers written as `.5` or `1e3` in JSX are static values, as `0.5` and `1000` are.

### @reactre/compat

- Added: `@reactre/compat/api`, the keys that switch React's APIs on and off (`KEYS`, `GROUPS`, `REQUIRES`, the names every build keeps in `ALWAYS`) and `enabledApis`, which expands and checks an app's keys.
- Changed: `@reactre/compat` includes class components, so the default entry is all of React's client API. `@reactre/compat/core` is the entry without them, for apps that render no class component; `@reactre/compat/classes` stays as an alias of `@reactre/compat`.
- Changed: `version` is `"19.3.1"`, the React release compat matches.
- Added: `@reactre/compat/server`, React 19.3.1's server rendering API: `renderToString`, `renderToStaticMarkup`, `renderToReadableStream` and `renderToPipeableStream` write the HTML React's production build writes, byte for byte, running compat's own hooks. `prerender`, `prerenderToNodeStream`, `resume` and `resumeToPipeableStream` are exported so imports resolve, and throw: compat does not implement partial prerendering. The README lists what else differs.
- Fixed: the class build (`@reactre/compat/classes`) is declared as having side effects, so bundlers that trust `sideEffects`, such as Vite's, keep the code that installs class support.
- Fixed: when an update arrives while a commit renders, its refs and layout effects still run before its passive effects, as in React (cmdk's list height).
- Fixed: a `<noscript>` renders its children only as text, as React does (input-otp's fallback style).
- Fixed: content a settled promise reveals inside `<Suspense>` waits until 300 ms after the last fallback appeared, as React throttles it (jotai's async atoms).
- Fixed: `useState` calls a lazy initial state with no arguments, as React does, instead of passing it itself (Apollo Client's `useQuery`).
- Fixed: keyboard events give `key`, `keyCode`, `charCode` and `which` as React does: `which` is the key code on keydown and keyup and the character code on keypress, and older key names are normalized (react-colorful's arrow keys). A field an event holds as its own without enumerating it, as events built with `Object.defineProperty` do, no longer goes missing.
- Fixed: a `<title>` rendered anywhere goes into `<head>` before the titles already there, as React places it, so the newest one sets the document's title (react-helmet-async's nested titles).
- Fixed: a new `<img>` gets `srcSet` and `src` after its other props, as React sets them, so attributes such as `sizes` and `loading` apply before the image is requested (react-image-crop's markup).
- Fixed: class components: `setState` in `componentWillMount` applies before the first render with no second render after it, and a class with a `getSnapshotBeforeUpdate` method gets no `componentWillMount` call, as in React.
- Fixed: hooks follow React 19's rules:
  - Deps arrays of another length compare on their common part.
  - An effect keeps each render's deps.
  - `useEffectEvent` returns a new function each render and throws when called during rendering.
  - `cache` returns a wrapper.
  - `useId` counts across all roots, as React's one client counter does.
  - A passive cleanup that throws after its component is removed goes to the error boundary above the removed subtree, or to the root, which unmounts and calls `onUncaughtError`. An error from a sync render's passive effects renders before `flushSync` returns.
- Fixed: a DOM error while placing nodes goes to the error boundary above, or to the root, which unmounts and reports it, as React captures a commit-phase error. The flush goes on to render the other updates queued with it.
- Fixed: `onCaughtError` runs before `componentDidCatch` and is given the boundary as `errorBoundary`. An error that `onCaughtError` or `onUncaughtError` throws is thrown again from a task of its own, and without `onUncaughtError` an uncaught error falls back to a task when `reportError` is missing.
- Fixed: on an update, each component's insertion effect cleanups, insertion effects and layout effect cleanups run together, children first, as in React's mutation phase.
- Fixed: `requestFormReset` resets at the next commit, after the transition it was made in ends, as React's state update of the form does, and throws React's error for a form React did not render.
- Changed: `flushSync` renders sync-lane updates only, as React's does: an update made outside an event waits for its own task, unless a sync update reaches the same component.
- Added: `browser()` from React 19.3: `use()` reads its token as undefined on the client. `use()` of anything but a promise, a context or that token throws React's error.
- Added: Fragment refs from React 19.3: a ref on a `<Fragment>` gets a FragmentInstance whose `addEventListener`, `removeEventListener`, `dispatchEvent`, `focus`, `focusLast`, `blur`, `observeUsing`, `unobserveUsing`, `getClientRects`, `getRootNode`, `compareDocumentPosition` and `scrollIntoView` work as react-dom's do on the fragment's visible top-level nodes. A node that mounts or shows in the fragment gets its listeners and observers, and loses them when it unmounts or hides. The code comes with the `Fragment` export, so an app that never imports `Fragment` leaves it out.
- Fixed: a render that throws is unwound to its boundary before the commit's layout effects run, as React renders the boundary within the same render. Content that suspends again commits nothing of the render that suspended: its layout effects and refs run when it shows.
- Fixed: `autoFocus` focuses only a `<button>`, `<input>`, `<select>` or `<textarea>`, as React does.
- Fixed: a `<Context.Consumer>` calls its children whatever they are, so children that are not a function throw, as in React.
- Fixed: an element rendered as a type is named in the error as React names its type, and a client reference has no name.
- Fixed: `useActionState` queues actions as React does:
  - The first action runs inside `dispatch`; the others wait for it.
  - In a transition, `isPending` is true until the queue drains, and the state is the last action's result.
  - Outside a transition, there is no pending state: the component suspends until the action finishes.
  - An action that fails rejects the actions queued after it, none of which runs, and its error reaches the error boundary once. Dispatch does nothing until a new action is rendered.
- Fixed: hidden content follows React's Offscreen rules:
  - A hidden `<Activity>` commits no effects, refs or class lifecycles, from its first render to the render that shows it.
  - Hiding runs every layout cleanup, ref detach and `componentWillUnmount`, parent first, then every passive cleanup.
  - Showing runs each effect once, children first, and attaches the refs and calls `componentDidMount` again.
  - An Activity inside hidden content waits for that content.
  - Shown content that suspends again has its layout effects and refs cleaned up until it is revealed, and its passive effects stay connected.
- Fixed: `unstable_batchedUpdates` is `fn(a)`, as React 19's is: updates outside an event render when the scheduler runs them.
- Fixed: a transition callback that throws synchronously sends the error to the component's error boundary (`useTransition`), or reports it (`startTransition`), instead of throwing to the caller.
- Fixed: a class's ref is detached before its `componentWillUnmount` runs, and either can throw without stopping the other. A callback ref to a class instance may return a cleanup, which runs instead of a call with `null`.
- Fixed: an element made by React 18 or older (`react.element`) is not a valid element and throws React 19's error when rendered. React's messages and hints are used for an invalid element type, and an object of another class rendered as a child is named by its tag, such as `[object Date]`.
- Fixed: events follow react-dom's rules:
  - `onChangeCapture` runs in the bubble phase with `onChange`, after the other bubble handlers.
  - `onChange` fires only for text fields (React's list of input types), checkboxes, radios, selects, file inputs and custom elements. A `change` event on a text field fires it when the value moved.
  - A non-bubbling event such as `load` runs the handlers of every element up the tree, and its capture handlers run in the capture phase. Elements React listens on, such as an `<img>`, need no handler of their own for that.
  - The far end of an enter or leave event from outside the root is the window.
  - `isDefaultPrevented()` is true after `preventDefault()`, even for an event that cannot be canceled.
- Fixed: the resource hints follow react-dom's rules:
  - `preconnect` keys on `crossOrigin` too.
  - `preload` needs an `as`, always fetches fonts with CORS, and passes `integrity`, `nonce`, `referrerPolicy`, `imageSrcSet`, `imageSizes` and `media` on.
  - `preinit` needs `as: "style"` or `as: "script"`. A stylesheet gets `data-precedence` and goes after the last one of its precedence.
  - `preinitModule`'s script is async.
  - A stylesheet or script takes what it lacks from an earlier preload of it.
  - Without a document, every hint does nothing.
- Fixed: element props follow React 19's rules:
  - Boolean attributes use React's list by prop name, `credentialless` included, and are present for any truthy value.
  - `muted`, `multiple` and an `<option>`'s `selected` are set as properties only.
  - An empty `src`, or an empty `href` off an `<a>`, is left out.
  - `cols`, `rows`, `size` and `span` need a number of at least 1, and `rowSpan` and `start` need a number.
  - `innerText` and `textContent` props are ignored.
  - `xlink*` and `xml*` props are namespaced on every element.
  - A `javascript:` URL in `src`, `href`, `action`, `formAction` or `xlinkHref` is replaced by one that throws, as React blocks it.
  - A custom element takes any value through a property it defines, strings and `undefined` included.
  - A custom element's own `on*` function props, such as `onMyEvent`, are native listeners for the event named after "on"; React's event props stay synthetic.
  - A prop starting with "on", in any case, is never an attribute of a built-in element.
- Fixed: styles follow React 19's rules: a string `style` throws, React's own list decides which numbers get `px`, and string values are trimmed.
- Fixed: form fields follow React 19's rules:
  - A boolean `value` is written as text.
  - An uncontrolled `<textarea>`'s `defaultValue` updates its default.
  - A controlled `<textarea>` with a `defaultValue` keeps it as its default.
  - A `<select>` with no matching option selects its first enabled one.
  - A `<select>`'s `defaultValue` also sets its options' `defaultSelected`.
  - A change of `multiple` with no `value` applies the `defaultValue` again or clears the selection.
- Changed: an update made outside React's event handlers renders as React's lanes order it: in a microtask during a discrete event such as a click or a key, and otherwise (timers, promises, continuous events such as mouseover) in a task of its own, so updates from timers that fire one after another render together (react-tooltip moving between anchors).
- Added: an ES module build of `@reactre/compat/compiler` in `dist/`, so Node can load `compileJs`.
- Docs: setting up Vite, with @reactre/plugin or an alias.

## [0.0.1] - 2026-10-29

First release.

### @reactre/dom

- Templates parsed once and cloned, with typed holes for text, classes, attributes, properties, events and slots.
- A keyed `List` that reuses rows and makes the fewest DOM moves, and `morph`.

### @reactre/core

- Signals, effects, `memo`, `batch`, `untrack` and a keyed `selector`.
- `<For>` keyed lists and `render` for TSX views compiled by @reactre/compiler, on @reactre/dom's templates.

### @reactre/compiler

- A Bun plugin that compiles reactre TSX into templates and the code that updates them.

### @reactre/compat

- React 19's client API on @reactre/dom's templates: hooks, context, memo, refs, portals, Suspense and lazy, transitions, synthetic events, controlled fields and hydration.
- `@reactre/compat/classes` for class components, and `@reactre/compat/compiler`, a Bun plugin that compiles host JSX trees to templates.

All packages ship ES modules for browsers and bundlers, and TypeScript sources for types.

[0.0.1]: https://github.com/arafathusayn/reactre/releases/tag/v0.0.1
