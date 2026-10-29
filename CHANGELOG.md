# Changelog

All notable changes to @reactre/dom, @reactre/core, @reactre/compiler, @reactre/compat and @reactre/plugin are recorded here. The packages are released together, at the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### @reactre/plugin

- Added: one plugin for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun, built on unplugin and running under Node and Bun. By default it compiles reactre TSX; with `compat`, it resolves `react` and `react-dom` to @reactre/compat (or its class build) and compiles the app's JSX with @reactre/compat/compiler.

### @reactre/compiler

- Added: an ES module build in `dist/`, so Node can load `compileJs` and the scanner.
- Changed: numbers written as `.5` or `1e3` in JSX are static values, as `0.5` and `1000` are.

### @reactre/compat

- Fixed: the class build (`@reactre/compat/classes`) is declared as having side effects, so bundlers that trust `sideEffects`, such as Vite's, keep the code that installs class support.
- Fixed: when an update arrives while a commit renders, its refs and layout effects still run before its passive effects, as in React (cmdk's list height).
- Fixed: a `<noscript>` renders its children only as text, as React does (input-otp's fallback style).
- Fixed: content a settled promise reveals inside `<Suspense>` waits until 300 ms after the last fallback appeared, as React throttles it (jotai's async atoms).
- Fixed: `useState` calls a lazy initial state with no arguments, as React does, instead of passing it itself (Apollo Client's `useQuery`).
- Fixed: keyboard events give `key`, `keyCode`, `charCode` and `which` as React does: `which` is the key code on keydown and keyup and the character code on keypress, and older key names are normalized (react-colorful's arrow keys). A field an event holds as its own without enumerating it, as events built with `Object.defineProperty` do, no longer goes missing.
- Fixed: a `<title>` rendered anywhere goes into `<head>` before the titles already there, as React places it, so the newest one sets the document's title (react-helmet-async's nested titles).
- Fixed: a new `<img>` gets `srcSet` and `src` after its other props, as React sets them, so attributes such as `sizes` and `loading` apply before the image is requested (react-image-crop's markup).
- Fixed: class components: `setState` in `componentWillMount` applies before the first render with no second render after it, and a class with a `getSnapshotBeforeUpdate` method gets no `componentWillMount` call, as in React.
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
