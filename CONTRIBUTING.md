# Contributing

The repository is a Bun workspace. Dependency versions live in one catalog in the root `package.json`.

```sh
bun install
bun test                    # unit tests, on a small fake DOM
bun check                   # type check
bun run check:strict        # the packages under the strictest settings
bun fmt                     # format
bun run compat              # React compatibility check, in headless Chrome
```

```
packages/dom            @reactre/dom: templates and keyed lists
packages/core           @reactre/core: signals, <For> and render, on @reactre/dom
packages/compiler       @reactre/compiler, and the JavaScript scanner both compilers share
packages/compat         @reactre/compat, @reactre/compat/classes and @reactre/compat/compiler
packages/testdom        @reactre/testdom: the fake DOM the tests run on (private)
apps/jfb                the js-framework-benchmark replica
apps/profiling          CPU profiles, trace windows and A/B proofs
apps/react-compat       scenarios run against React 19 and @reactre/compat
docs/roadmap.md         what is left to do
```

A change to the runtime's speed is kept only when [`apps/profiling/ab.ts`](apps/profiling) proves it faster on some benchmark test and slower on none.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`, where the scope is a package (`dom`, `core`, `compiler`, `compat`) or an app (`jfb`, `profiling`, `react-compat`).

## Releasing

The four public packages share one version. A release is a GitHub release tagged `v<version>`, matching every `packages/*/package.json` version, with a matching [CHANGELOG](CHANGELOG.md) entry. Its [workflow](.github/workflows/release.yml) runs the checks and tests, builds `dist/`, publishes each package to npm through npm's trusted publishing (no stored token, with provenance once the repository is public), and attaches the tarballs to the release.
