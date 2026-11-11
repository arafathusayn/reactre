// test/fixtures/job.ts in @stateforward/hsm: the task is the state's `activity` (async; its
// context is marked done, with a `done` event, when the state exits, which aborts the save), and
// the timer is a transition `after(...)`. The task reports back by dispatching events. As in the
// door port, data lives on the instance and each state's `entry` calls the listener.

import * as hsm from "@stateforward/hsm";

/** What the task does, swapped by each run. */
let save: (text: string, signal: AbortSignal) => Promise<string> = async () => "";
export function useSave(fn: (text: string, signal: AbortSignal) => Promise<string>): void {
  save = fn;
}

export class Job extends hsm.Instance {
  text = "";
  id = "";
  error = "";
  constructor(readonly listener: (state: string) => void) {
    super();
  }
}

export const Save = hsm.event("save");
export const Cancel = hsm.event("cancel");
export const Retry = hsm.event("retry");
const Stored = hsm.event("stored");
const Failed = hsm.event("failed");

const entered = (state: string) => hsm.entry((_ctx, job) => (job as Job).listener(state));

export const jobModel = hsm.define(
  "job",
  hsm.state(
    "idle",
    entered("idle"),
    hsm.transition(
      hsm.on(Save),
      hsm.target("../saving"),
      hsm.effect((_ctx, job, event) => {
        (job as Job).text = event.data.text;
      }),
    ),
  ),
  hsm.state(
    "saving",
    entered("saving"),
    hsm.activity(
      (ctx, job) =>
        new Promise<void>((resolve) => {
          const abort = new AbortController();
          ctx.addEventListener("done", () => abort.abort());
          save((job as Job).text, abort.signal)
            .then(
              (id) => {
                if (!ctx.done) void job.dispatch({ ...Stored, data: { id } });
              },
              (error: unknown) => {
                if (!ctx.done) void job.dispatch({ ...Failed, data: { error: String(error) } });
              },
            )
            .finally(resolve);
        }),
    ),
    hsm.transition(
      hsm.on(Stored),
      hsm.target("../saved"),
      hsm.effect((_ctx, job, event) => {
        (job as Job).id = event.data.id;
      }),
    ),
    hsm.transition(
      hsm.on(Failed),
      hsm.target("../failed"),
      hsm.effect((_ctx, job, event) => {
        (job as Job).error = event.data.error;
      }),
    ),
    hsm.transition(hsm.on(Cancel), hsm.target("../idle")),
    hsm.transition(
      hsm.after(() => 20),
      hsm.target("../failed"),
      hsm.effect((_ctx, job) => {
        (job as Job).error = "timed out";
      }),
    ),
  ),
  hsm.state("saved", entered("saved")),
  hsm.state("failed", entered("failed"), hsm.transition(hsm.on(Retry), hsm.target("../idle"))),
  hsm.initial(hsm.target("idle")),
);
