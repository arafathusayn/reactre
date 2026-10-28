# jfb

A replica of [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)'s CPU tests, for measuring reactre against the fastest keyed entries. It runs the official tests, warmups, CPU throttling, forced GC, trace-based durations and weights in headless Chrome.

## Entries

| Entry            | App               | What it measures                                                 |
| ---------------- | ----------------- | ---------------------------------------------------------------- |
| `reactre`        | `app/reactre.tsx` | @reactre/core, compiled by @reactre/compiler                     |
| `reactre-compat` | `app/main.jsx`    | An idiomatic React app on @reactre/compat, compiled to templates |
| `react`          | `app/main.jsx`    | The same React app on React 19, for reference                    |
| `reactre-dom`    | `app/dom.ts`      | The app written by hand on @reactre/dom                          |

The field is the official keyed top 5 of the Chrome 156 results: re, thane, vanillajs-lite, vanillajs and doohtml-dp.

## Running

From this directory, after `bun install` at the repository root:

```sh
bun prepare.ts                      # clone the benchmark at a pinned commit, build the top 5 and our entries
bun run.ts                          # every entry, 15 samples per test (25 for select)
bun run.ts --entries re,reactre --iterations 3
bun prepare.ts --app-only           # rebuild our entries after a change to the packages
```

`prepare.ts` needs network access once. No package install script runs, here or in the benchmark's entries.

## Reading the numbers

Each test's median is divided by the best median of that test, and an entry's score is the weighted geometric mean of those factors with the official weights: 1.000 is fastest on every test.

One run's score moves by a few hundredths on an ordinary machine. Judge standings by a pool of runs, not one:

```sh
for s in 0 1 2 3; do bun run.ts --shift $s > run-$s.log; done
bun pool.ts run-0.log run-1.log run-2.log run-3.log
```

| Option         | Effect                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--shift n`    | Rotates the entries' order in each test, so a pool of runs evens out drift that favors a place in the order.         |
| `--batch n`    | The entries take turns, `n` samples each in a fresh browser, so the machine's slow spells land on all of them alike. |
| `--benchmarks` | Runs only the listed tests, e.g. `01_run1k,04_select1k`.                                                             |

Keep the machine otherwise idle while measuring: builds, tests or a browser running alongside show up in the numbers.

Set `CHROME` to a Chrome or Chromium executable, or it is looked for in the usual places. Results from a different Chrome version than the official run's can differ for every entry.

Profiling and A/B tools that build on this runner live in [`apps/profiling`](../profiling).
