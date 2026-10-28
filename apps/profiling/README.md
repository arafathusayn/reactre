# profiling

Tools for finding where a benchmark click spends its time, and for proving that a change makes it faster. They build on the [jfb](../jfb) runner and measure the same click the benchmark measures. Run `bun prepare.ts` in `apps/jfb` first.

| Tool              | What it answers                                                                |
| ----------------- | ------------------------------------------------------------------------------ |
| `ab.ts`           | Is a change faster? An A/B of the working tree against a base git revision.    |
| `profile.ts`      | Where does a click's script time go? CPU profiles, flame graphs, hot lines.    |
| `window.ts`       | What does the measured window hold? Script, style, layout and paint, by entry. |
| `breakdown.ts`    | How much of a click is the runtime's own work, and how much the browser's?     |
| `native-clear.ts` | What does clearing rows cost natively? Shows per-row state kept on elements.   |

```sh
bun ab.ts --base main --entry reactre --benchmarks 04_select1k,05_swap1k --rounds 12 --batch 8
bun profile.ts select 30 --cold --entry reactre
bun window.ts reactre,vanillajs-lite 01_run1k 12 --kinds
bun breakdown.ts vanillajs,reactre run 4
bun native-clear.ts vanillajs,reactre-dom 40
```

`ab.ts` alternates fresh-browser batches of the two builds. Its verdict is a 95% bootstrap interval of the difference of medians, for the whole window and for script time. Keep a change only when it is proven faster on some test and slower on none. One click's time varies a lot between samples; script time is far less noisy than the whole window.

Profiles and traces are written under `apps/jfb/.cache`.
