# Changelog

All notable changes to @reactre/dom, @reactre/core, @reactre/compiler and @reactre/compat are recorded here. The four packages are released together, at the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### @reactre/compat

- Fixed: the class build (`@reactre/compat/classes`) is declared as having side effects, so bundlers that trust `sideEffects`, such as Vite's, keep the code that installs class support.
- Fixed: when an update arrives while a commit renders, its refs and layout effects still run before its passive effects, as in React (cmdk's list height).
- Fixed: a `<noscript>` renders its children only as text, as React does (input-otp's fallback style).
- Docs: setting up Vite.

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
