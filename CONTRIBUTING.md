# Contributing

The repository is a Bun workspace. Dependency versions live in one catalog in the root `package.json`.

```sh
bun install
bun test --coverage         # unit tests, on a small fake DOM; CI requires 100% of lines and functions
bun check                   # type check
bun run check:strict        # the packages under the strictest settings
bun fmt                     # format
bun run compat              # React compatibility check, in headless Chrome
bun scripts/consumer.ts     # type-check a user's project against the packed packages (build them first)
```

CI runs these from a fresh clone, with no `dist/` folders. Before a push, run them the same way: a working copy that has built output, or tests run in macOS's file order, can pass where CI fails. Bun runs every test file in one process, and on Linux in another order, so a test that sets a global or module state must undo it.

```
packages/dom            @reactre/dom: templates and keyed lists
packages/core           @reactre/core: signals, <For> and render, on @reactre/dom
packages/compiler       @reactre/compiler, and the JavaScript scanner both compilers share
packages/compat         @reactre/compat, /core, /classes, /server and /compiler
packages/full-compat    @reactre/full-compat: @reactre/compat with React's time slicing compiled in
packages/plugin         @reactre/plugin: one plugin for Vite, Rollup, Rolldown, esbuild, webpack, Rspack and Bun
packages/preact         @reactre/preact: Preact's API on reactre's templates
packages/testdom        @reactre/testdom: the fake DOM the tests run on (private)
apps/jfb                the js-framework-benchmark replica
apps/profiling          CPU profiles, trace windows and A/B proofs
apps/react-compat       scenarios run against React 19 and @reactre/compat
apps/preact-compat      scenarios run against Preact and @reactre/preact
scripts/declarations.ts writes a package's .d.ts files into its dist/, after its build
scripts/consumer.ts     installs the packed packages into a project outside the workspace and runs tsc on it
docs/roadmap.md         what is left to do
```

A change to the runtime's speed is kept only when [`apps/profiling/ab.ts`](apps/profiling) proves it faster on some benchmark test and slower on none.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`, where the scope is a package (`dom`, `core`, `compiler`, `compat`) or an app (`jfb`, `profiling`, `react-compat`).

## Releasing

The seven public packages (dom, core, compiler, compat, full-compat, plugin and preact) share one version. A release is a GitHub release tagged `v<version>`, matching every `packages/*/package.json` version, with a matching [CHANGELOG](CHANGELOG.md) entry. Its [workflow](.github/workflows/release.yml) runs the checks and tests, builds `dist/`, publishes each package to npm through npm's trusted publishing (no stored token, with provenance once the repository is public), and attaches the tarballs to the release.

To cut one:

1. Set the version in each package's `package.json`.
2. In the CHANGELOG, add `## [<version>] - <date>` under `## [Unreleased]`, and update the links at the bottom.
3. Run `bun install`, so `bun.lock` records the new versions, then commit as `chore(release): <version>`.
4. Push, and once CI is green, create the release with the commit's full SHA as its target: `gh release create v<version> --target <sha> --notes-file <notes>`.
