# Changelog

All notable changes to @reactre/dom, @reactre/core, @reactre/compiler, @reactre/compat and @reactre/plugin are recorded here. The packages are released together, at the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### @reactre/core

- Fixed: a `<For>` row with several handlers for one event type, such as two `onClick` links, calls the clicked one once per event. Before, the list added one listener per handler, so each click ran the handler once per handler of its type.

### @reactre/plugin

- Added: the behaviour key `renderRetry`, on unless `compat.exclude` names it: the module written for the options loads `@reactre/compat/features/retry`, React's retry of a render that throws.
- Changed: with anything switched off, class support included, `react` resolves to a module built on @reactre/compat/core that loads the feature module of each key still on (`@reactre/compat/features/classes`, `/stacks` and `/keys`). `classes: false` now keeps component stacks and React's handling of repeated keys; before, it resolved to @reactre/compat/core, which dropped both. Only the default options resolve to @reactre/compat itself.
- Added: `compat.exclude` takes the behaviour keys `componentStack` and `repeatedKeys`, which are on unless excluded, whatever `compat.apis` lists.
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

- Fixed: a render that throws an error renders again before the error counts, as React 19.3.1's production client does. A root's first render renders again whole, and an update renders again the component that threw, or the boundary that caught it with its update undone; only an error that render throws too is caught by a boundary or reported, and a boundary's fallback commits only then. If it renders, `onRecoverableError` gets React's #520, caused by the first error, with the stack it was first captured with, after the layout effects. An error is captured as React captures it, twice, so React's calls of each component without props to read its frame happen as often. Compat reported the first error at once, and rendered a component fewer times than React. The retry is a feature module, `@reactre/compat/features/retry`, which @reactre/compat loads: @reactre/compat/core without it counts an error at once, as before. The README lists what still differs. Only the catch blocks of the render loop change on the normal path; @reactre/compat grows 1.2 KB gzipped, and an app on core that does not load the module 0.1 KB (the js-framework-benchmark app).
- Fixed: `useSyncExternalStore` calls `getSnapshot` once more after every commit whose snapshot, `getSnapshot` or `subscribe` changed, after its subscription's effect, and renders again if the store moved on meanwhile, as React does. A render compares three values; the check is queued only when one changed.
- Fixed: #185 counts the commits of each root, as React does, so two roots that update each other on every commit no longer throw. Each commit that leaves an update compares the roots of the queued updates.
- Fixed: the rest of hydration's differences from React 19.3.1's production client. An update that reaches a Suspense boundary or Activity still dehydrated hydrates it first, with the props and context it had, in a commit of its own, then renders, as React does; one whose content cannot hydrate yet renders on the client. Before, compat hydrated it with the update's props, a mismatch that rendered it on the client with React's #418. The latest continuous event of each kind (`focusin`, `dragenter`, `mouseover`, and each pointer's `pointerover` and `gotpointercapture`) whose target has not hydrated is kept, as React's `queueIfContinuousEvent` does: what blocks it hydrates before other boundaries, and a copy is dispatched on the target once nothing does; `focusout`, `dragleave`, `mouseout`, `pointerout` and `lostpointercapture` drop the one kept of their kind. A document whose hydration ends in an uncaught error keeps its `<html>`, `<head>` and `<body>`, emptied, where it lost `<html>`. `onMouseEnter` and `onPointerEnter` (and the leave handlers) run after `onMouseOver` and `onPointerOver` (and the out handlers) for the same native event, as in React; they ran before. An app that only renders on the client grows 27 bytes minified (one test per batch of updates), a hydrating app 0.5 KB gzipped, @reactre/compat 0.6 KB.
- Fixed: hydration follows React 19.3.1's production client. The shell hydrates in a task (at once inside `flushSync`) and leaves each Suspense boundary and Activity dehydrated, the server's HTML in place, for a later pass; nested boundaries hydrate a pass after the ones around them, with React's order of renders, layout and passive effects and `onRecoverableError` reports. Before, everything hydrated in one pass before `hydrateRoot` returned. A boundary whose content suspends keeps the server's HTML and hydrates once the content can render, where compat showed its fallback; a boundary still streaming in (`<!--$?-->` while the document loads, `<!--$~-->`) waits for the server through `_reactRetry` and `DOMContentLoaded`, and only `<!--$!-->` renders on the client at once. A click or another of React's discrete events inside a dehydrated boundary, or before the shell hydrated, hydrates it first, outermost first, then reaches its handlers; other events reach no handler until their target hydrates. Claimed elements keep the server's attributes and styles until a prop changes, and take only what React's `hydrateInstance` writes: listeners and an input's or textarea's initial value, checkedness and name. Activity is a boundary hydration recovers at, as Suspense is. An error other than a mismatch thrown while hydrating renders the nearest boundary or the root on the client and is reported as React's #422 or #423, with the error as its cause; error boundaries do not catch it first. A whole document that renders on the client keeps its `<html>`, `<head>` and `<body>` and the scripts, styles and stylesheets in them, as React's singletons do, where compat replaced `<html>`. The code is only in builds that call `hydrateRoot`: a hydrating app grows 2.0 KB gzipped, @reactre/compat 2.0 KB (it exports `hydrateRoot`), and an app that only renders on the client by 7 bytes; the js-framework-benchmark app is 10 bytes smaller gzipped. The README lists what still differs.
- Fixed: an update loop through a layout effect, a ref callback or `componentDidUpdate` that sets state on every commit throws React's #185 where React 19.3.1's production client does, from the setState of the 52nd commit in a row that left an update, to the nearest error boundary or the root; compat hung. Updates from passive effects stay unlimited, as in React's production build.
- Fixed: hooks are checked as React's production client checks them. A render that calls fewer hooks than the last throws #300, one that calls more #310 (#467 in a later pass of a first render, #312 on the server), and a state or optimistic hook where the last render called a hook of another kind #311; compat rendered on with the wrong slots. A render that calls no hook mounts its hooks anew the next time it calls them, as in React. The checks cost a render two integer compares and a flag test, and a flag test where a hook mounts.
- Fixed: `useSyncExternalStore` hydrates with `getServerSnapshot`, as React's client does, and renders the store's snapshot after it subscribes if that differs; compat read `getSnapshot`, so a store that differed from the server's was a mismatch that rendered the root on the client. Without `getServerSnapshot`, the nearest Suspense boundary or the root renders on the client and `onRecoverableError` gets React's #423 or #422, caused by #407. `useSyncExternalStoreWithSelector` selects the server snapshot through the client's memo, as React's selector hook does. The store hook now subscribes before it checks the store, in React's order. These three fixes add 0.3 KB gzipped to @reactre/compat and 0.2 KB to the js-framework-benchmark app.
- Added: partial prerendering in `@reactre/compat/server`, as React 19.3.1's production builds do it: `prerender` and `prerenderToNodeStream` (with `signal`, `onError`, `onHeaders`, `maxHeadersLength`, the bootstrap options and `identifierPrefix`) resolve with the prelude and the postponed state, `resume` and `resumeToPipeableStream` write the rest, and `resumeAndPrerender` and `resumeAndPrerenderToNodeStream` resume and postpone again. The prelude, the postponed state (the same JSON as React's, so either server resumes the other's) and the resumed HTML are React's, byte for byte; replaying a tree that differs renders the boundaries it cannot reach on the client, with React's errors. Before, these entries threw.
- Fixed: the client throws where React 19.3.1's production client throws for input compat accepted: a root or portal container that is not an element, a document or a fragment (#299, from `createRoot`, `hydrateRoot` and `createPortal`); `dangerouslySetInnerHTML` not in the form `{__html}` (#61) or with children (#60), checked when it changes; `dangerouslySetInnerHTML` on a `<textarea>` (#91), and a textarea's children with a `defaultValue` (#92) or several of them (#93); children or `dangerouslySetInnerHTML` on a void element such as `<img>` or `<br>` (#137); a ref that is neither a function nor an object (#284); an event handler prop that is set but not a function, when its event fires (#231); and optimistic state set (#479), or a `useActionState` action dispatched (#485), while the component renders. `cloneElement` of null or undefined, and `setState` of anything but an object, a function or null, throw React's full messages, as React's isomorphic package does. `Children` read a thenable as `use()` reads one (its value, its error, or the thenable itself while it is pending) and a lazy type through its loader, as React's do, where compat threw. `dangerouslySetInnerHTML` whose `__html` is null or undefined renders the element's children, and a `<textarea>` with an empty children array starts empty, as in React. @reactre/compat/compiler leaves a void element with children to the runtime, which throws. The checks sit where compat already handles each case, so a valid tree does no extra work beyond a lookup as a host with children mounts; @reactre/compat grows 0.5 KB gzipped, the js-framework-benchmark app 0.4 KB.
- Changed: errors are React's production errors. The client throws and reports the minified codes React 19.3.1's production client does, with React's arguments in the react.dev link (`Minified React error #31; visit https://react.dev/errors/31?args[]=…`), where it threw React's development messages: invalid hook calls (#321) and `use()` of a context outside a render (#308), too many re-renders (#301), objects rendered as children (#31) and elements of an older React (#525), invalid element types (#130), a string `style` (#62), hydration mismatches (#418) and boundaries the server could not finish (#419), `render()` of an unmounted root (#409), `use()` of a value it cannot read (#438), a useEffectEvent function called while rendering (#440), `requestFormReset` of a form React did not render (#522) and a Fragment ref's `scrollIntoView` with options (#566). `Children` keeps React's full message, which now names the object as React does, and passes over function and symbol children, as React does, where compat threw. The server keeps React's full messages, as React's builds for Node, Deno, Bun and edge runtimes do. @reactre/compat is 0.8 KB smaller gzipped, the js-framework-benchmark app 0.4 KB.
- Fixed: a lazy type that loads something other than a function, forwardRef, memo or context throws React's error (#306), naming what it loaded as React does; compat rendered it, or threw a different error.
- Fixed: hydration recovers from a mismatch as React's production client does. An element, text or Suspense boundary the server did not render, server nodes the client does not render, or text that differs (unless `suppressHydrationWarning`, which keeps the server's text) makes the nearest Suspense boundary the server rendered, or else the root, drop the server's nodes and render on the client, where compat patched them in place before. `onRecoverableError` gets React's error and component stack after the layout effects, and a boundary the server could not finish (`<!--$!-->`) renders on the client with React's error too. In the root and the document's `<html>`, `<head>` and `<body>`, server nodes that do not match are passed over and kept, as React keeps them; an element's server HTML (`dangerouslySetInnerHTML`) is kept. The code is only in builds that call `hydrateRoot`. The README lists what still differs.
- Fixed: component stacks give each function and class component the frame React's `describeNativeComponentFrame` finds, by calling or constructing it without props when the error is reported, so stacks match React's text, locations included. `onRecoverableError` gets one too.
- Added: `@reactre/compat/features/classes`, `/stacks` and `/keys`, the modules that install class components, component stacks and React's handling of repeated keys into @reactre/compat/core when loaded. @reactre/compat loads all three; core loads none.
- Added: `@reactre/compat/api` has the behaviour keys `componentStack` and `repeatedKeys` (`BEHAVIOURS`), on unless excluded, and `MODULES`, the feature module of each key that has one.
- Fixed: errors are reported with React's component stack. `onUncaughtError`, `onCaughtError` and `componentDidCatch` get a `componentStack` with a frame per host element and component from where the error was thrown up to the root, named as React's production build names them. The stack is built only when an error is reported; recording where an error came from costs nothing until something throws. The README lists what can differ.
- Fixed: a list whose old rows repeat a key is reconciled as React's production build does wherever compat matches rows through a key map: rows match in place while their keys do, then the last old row of each key is the one reused, the others stay in the DOM where they are, never rendered again, and moved or new rows go where React's commit puts them. Lists with unique keys do no extra work. compat's faster paths still match repeated keys by position; the README says where.
- Changed: `@reactre/compat/core` is the slim base, without the feature modules: class components, component stacks and React's handling of repeated keys. Errors are reported there with an empty `componentStack`, and repeated keys are matched by compat's own rules. @reactre/plugin's `classes: false` no longer resolves to it.
- Fixed: `useId` gives React's ids while hydrating. As React's client does, it works out the tree id the server rendered (`_R_…_`) from the component's place in the tree, so the attributes that hold ids hydrate unchanged. The work happens only when `useId` mounts during hydration. Outside hydration ids still come from the client counter (`_r_…_`), which hydration no longer uses up.
- Added: `renderToReadableStream` and `renderToPipeableStream` take `formState`, a server action's postback: `useActionState` with a server action gives its form React's `$ACTION_KEY` (the permalink, or a hash of the hook's place in the tree, by React's key paths), the hook whose key and action match starts from the postback's state, and each component with the hook writes React's `<!--F!-->` or `<!--F-->` markers.
- Added: @reactre/compat/server replays a component's promises when it renders again after suspending, as React's server does: `use()` of a promise made during render reads the one the component used at the same place before, so it no longer suspends on each retry.
- Added: `preload`, `preinit` and the other resource functions called in async work a stream's render started, such as a promise callback, reach the render and are flushed, as in React's Node and edge builds, wherever `AsyncLocalStorage` exists.
- Added: `@reactre/compat/api`, the keys that switch React's APIs on and off (`KEYS`, `GROUPS`, `REQUIRES`, the names every build keeps in `ALWAYS`) and `enabledApis`, which expands and checks an app's keys.
- Added: `renderToPipeableStream` stops writing when the writable's `write` returns false and goes on when it emits `drain`, as React's Node build does, and both stream entries write React's chunks: 4096-byte views and long strings for `renderToPipeableStream`, 2048-byte views for `renderToReadableStream`. Piping calls `onHeaders` if the render has not yet, as React's does.
- Added: `renderToReadableStream` and `renderToPipeableStream` take `onHeaders` and `maxHeadersLength`: `onHeaders` gets, once, the Link header React's server builds of preconnects, font and high-priority image preloads, and the shell's stylesheets while the shell is still rendering, as many as `maxHeadersLength` allows; those hints are not written again in the HTML.
- Added: `preconnect`, `prefetchDNS`, `preload`, `preloadModule`, `preinit` and `preinitModule` called during a server render write what React's server writes: the links and scripts in the head, in React's order, or before the content that streams in later, each resource once, a preload giving its credentials to the stylesheet or script that loads it and going unwritten when that is written with it.
- Added: @reactre/compat/server gives `onError` (and `onBrowserBailout`) the `componentStack` React's production server gives: host elements, boundaries and `Suspense Fallback` by name, and each component by the frame of a native stack trace it throws from when called without props, read when the stack is first read. The README lists the cases that differ.
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
