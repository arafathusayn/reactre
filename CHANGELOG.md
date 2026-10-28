# Changelog

All notable changes to reactre, reactre-compiler and reactre-compat are recorded here. The three packages are released together, at the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-10-29

First release.

### reactre

- Signals, effects, `memo`, `batch`, `untrack` and a keyed `selector`.
- `<For>` keyed lists and `render` for TSX views compiled by reactre-compiler.
- `reactre/dom`: templates parsed once and cloned, typed holes, a keyed `List` that makes the fewest DOM moves, and `morph`.
- ES modules for browsers and bundlers, and TypeScript sources for types.

### reactre-compiler

- A Bun plugin that compiles reactre TSX into templates and the code that updates them.

### reactre-compat

- React 19's client API on reactre's templates: hooks, context, memo, refs, portals, Suspense and lazy, transitions, synthetic events, controlled fields and hydration.
- `reactre-compat/classes` for class components, and `reactre-compat/compiler`, a Bun plugin that compiles host JSX trees to templates.

[0.0.1]: https://github.com/arafathusayn/reactre/releases/tag/v0.0.1
