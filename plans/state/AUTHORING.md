# @reactre/state: authoring the four canonical flows

2026-11-11. A documentation-only authoring evaluation: the same four requirements, written with the
current API only, by hand, and compiled and run. No builder, no helper, no new runtime API, no model
or API call, no billed experiment, no benchmark. The code is
[`packages/state/test/authoring/machines.ts`](../../packages/state/test/authoring/machines.ts) and
its tests are [`authoring.test.ts`](../../packages/state/test/authoring/authoring.test.ts).

## What this is, and what it is not

This is **manual docs-to-code authoring evidence under the current authorization**. It shows that
four ordinary flows can be written with the API as it stands, that the type checker and the compiler
accept them, and that they behave as the requirements say when run. It is **not** an agent or model
run, and it is **not** a comparative ergonomics result: nothing here measures how long a person or a
model takes, or whether this API is easier than another. Any proposal for a builder, a helper, or a
shorter form remains **unverified** until it is built and measured; this document does not claim one
would help.

## The four requirements, the same for each

Each flow is written to the same bar:

1. **Exact per-state data types.** Every state's data is declared in `setup`'s `states` with
   `types<{...}>()`, and every move carries exactly that state's data. A move to a state with no
   data takes none; a move to a state with data takes all of it.
2. **`to` vs `keep` vs `reenter`.** A move to a _different_ leaf is `to`. A move to the _same_ leaf
   that must leave its task or timer running is `keep`; one that must restart them is `reenter`
   (the `reenter` opt-in). A plain `to` to the current leaf of a state with a task or timer is a type
   error that names the fix.
3. **Missing opt-in diagnostics.** A feature used without its opt-in is a type error naming both
   lines to add. The flows use `reenter` and show its diagnostic.
4. **Narrowed data and HTTP failure checking.** A snapshot's `state` narrows its `data` (only
   `loaded` has a `body`). A task that reads a response checks `res.ok` before reading the body, so
   a 404 or 500 page is a failure the task's `error` decides, not a success.

## 1. Typeahead with stale result cancellation

**Requirement.** A query starts a search. A newer query cancels the request in flight, and a result
that arrives for a query the state no longer holds is not shown.

**The code** (`searchMachine`):

- `searching` runs a task whose `run` fetches with the task's `signal` and checks `res.ok`; the body
  is validated (`Array.isArray` and every item a string) before it becomes the event, so a cast never
  takes outside data on trust.
- A new `query` in `searching` is `reenter("searching", { q })`: it exits and re-enters the leaf, so
  the running task's signal aborts the old fetch and a new one starts.
- `found` is declined (`null`) when `event.q !== data.q`, so a late result for an old query is
  dropped even if it arrives.

**What the tests pin.** The first request's signal is aborted and the second's is not; only the
latest query's result is shown; a 500 goes to `failed` with the query, and the next query searches
again.

**Friction.** The stale-result guard is a hand-written `event.q === data.q` check in `found`. The
library does not tie a task's result to the data it started with, so the author must carry the query
in the event and compare it. `reenter` is what makes the cancellation work, and it is an opt-in: a
machine that only ever moves forward does not need it, but a search box does.

## 2. Ordinary fetch with retry and failure statuses

**Requirement.** A fetch loads a URL. A non-2xx status is a failure. `retry` tries again, counting
attempts, up to a limit, then gives up. A 10s timer fails a slow load. `cancel` returns to idle.

**The code** (`fetcherMachine`, the README's fetcher whole):

- `loading` runs a task: `fetch(data.url, { signal })`, then `if (!res.ok) throw new Error(...)`, then
  `res.text()`. The task's `error` moves to `failed` with `{ ...data, error }`.
- `retry` in `failed` is `data.attempt < 3 ? to("loading", { attempt: data.attempt + 1 }) : to("gaveUp")`.
- `after: { "10s": ... }` fails a slow load; `cancel` returns to `idle` with the url.

**What the tests pin.** A 500 fails with `attempt: 1`; each `retry` re-enters `loading` with the
attempt counted; the third `retry` gives up; a 200 loads the body and the snapshot narrows to
`loaded`; the 10s timer fails the load; `cancel` returns to idle.

**Friction.** None beyond the ordinary: the flow is the README's, and it compiles and runs as
written. The `res.ok` check is required by the compiler (a body read without it is a build error),
which is the intended behaviour, not friction.

## 3. Polling re-arming

**Requirement.** A state polls on an interval. Each poll re-arms the wait, so the next poll is one
interval after the last, not on a fixed schedule that drifts.

**The code** (`pollMachine`):

- `polling` has `after: { "10ms": ({ data, reenter }) => reenter("polling", { n: data.n + 1 }) }`.
  Re-entering restarts the timer, so each poll waits the interval again from its own entry.
- `stop` moves to `done`.

**What the tests pin.** Each interval re-enters the state and the timer re-arms (n goes 0 → 1 → 2 at
10ms steps, and not at 9ms); `stop` leaves the loop and no timer fires after it.

**Friction.** Re-arming needs `reenter`, an opt-in. A plain `to("polling", ...)` to the same leaf is
a type error (the timer would keep its old deadline), and `keep` would leave the timer running with
the data it started with, which is not a re-arm. So a polling loop is a `reenter` machine. This is
the clearest case where the current API asks for an opt-in to express an ordinary pattern.

## 4. Debounced submit

**Requirement.** Each keystroke restarts a 300ms wait. Only a pause submits. A failed submit returns
to typing with the text kept, so the next pause retries it.

**The code** (`formMachine`):

- `typing` has `on: { type: ({ event, reenter }) => reenter("typing", { text: event.text }) }` and
  `after: { "300ms": ({ data, to }) => to("submitting", { text: data.text }) }`. Each keystroke
  re-enters, restarting the timer.
- `submitting` runs a task that POSTs with the signal and checks `res.ok`; `error` returns to
  `typing` with the text kept; `submit` moves to `sent`.
- `submitting` also needs a public event that leaves it (`cancel`), because a state that runs a task
  must have one: the type checker says so.

**What the tests pin.** Each keystroke restarts the wait (200ms + 200ms does not submit; 100ms more
does); a failed submit returns to typing with the text kept, and the next pause retries it.

**Friction.** Two things. First, the debounce is `reenter`, the same opt-in as polling. Second, a
state that runs a task must declare a public event or timer that leaves it, so `submitting` needs a
`cancel` even when the requirement does not name one. That is a real authoring cost: the type checker
is right (a task with no way out is a trap), but the requirement did not ask for it, and the author
must add it.

## The rubric, honestly

| Flow                | Compiles | Typechecks | Runs as required | Opt-in needed | Friction                                                       |
| ------------------- | -------- | ---------- | ---------------- | ------------- | -------------------------------------------------------------- |
| 1. Typeahead        | yes      | yes        | yes              | `reenter`     | stale-result guard is hand-written                             |
| 2. Fetch + retry    | yes      | yes        | yes              | none          | none beyond the README's                                       |
| 3. Polling          | yes      | yes        | yes              | `reenter`     | re-arm needs `reenter`                                         |
| 4. Debounced submit | yes      | yes        | yes              | `reenter`     | re-arm needs `reenter`; a task state needs a public exit event |

**What this evidence supports.** The four flows are expressible with the current API, the type
checker and compiler accept them, and they behave as the requirements say when run on a deterministic
clock. The exact per-state data types hold throughout: every move carries exactly its state's data,
and a wrong field is a type error.

**What it does not support.** It is not a measurement of authoring speed or difficulty, and it is not
a comparison with another library. It does not show that a builder or helper would help; that is an
unverified proposal. It does not cover flows beyond these four.

**The friction the four flows reveal, stated plainly.** Three of the four need `reenter` to express
an ordinary pattern (cancel-and-restart, re-arm, debounce). That is the API's design: a move to the
same leaf with `to` keeps its work, and restarting it is a distinct, opt-in move. Whether that is
the right trade-off is a product decision, not something this evaluation settles. The stale-result
guard and the task-state exit event are two places where the author writes code the requirement did
not name, because the library does not infer them.

## Verification

- `bun test test/authoring/authoring.test.ts` → 10 pass, 0 fail, 27 expect() calls.
- `bun check test/authoring` → no type errors.
- The machines are compiled by the preload plugin (`test/compiled.ts`), as a build compiles them.

No new builder API, no model API or billed experiment, no shared compiler or runtime edit, no
benchmark, no commit.
