// Runs every scenario in ./cases.tsx and the libraries-*.tsx files in order and leaves a
// transcript per scenario in window.__results for run.ts to compare.
//
// The same page is built once per runtime, so this harness must not depend on any runtime's
// specifics: it records only what a user could see, the logged values and the DOM's HTML.
// window.__done tells run.ts the transcripts are ready.

import { cases, type T } from "./cases.tsx";
import { libraries1To25 } from "./libraries-1-25.tsx";
import { libraries26To50 } from "./libraries-26-50.tsx";
import { libraries51To75 } from "./libraries-51-75.tsx";
import { libraries76To100 } from "./libraries-76-100.tsx";

declare global {
  interface Window {
    __ssr: Record<string, string>;
    __results: Record<string, string[]>;
    __done: boolean;
    __only: string | undefined;
  }
}

/**
 * Waits six macrotask turns, so microtasks, scheduled effects and short chains of follow-up
 * updates have run before the HTML is read. React and reactre-compat may schedule effects
 * differently; reading only after both have settled compares results, not timing.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Runs each scenario on a fresh body and collects its transcript. */
async function main(): Promise<void> {
  const results: Record<string, string[]> = {};
  for (const [name, run] of Object.entries({
    ...cases,
    ...libraries1To25,
    ...libraries26To50,
    ...libraries51To75,
    ...libraries76To100,
  })) {
    // run.ts --only: just the scenarios whose names contain one of the comma-separated texts.
    if (window.__only !== undefined && !window.__only.split(",").some((s) => name.includes(s))) continue;
    const out: string[] = (results[name] = []);
    // useId values follow each runtime's own scheme (they only have to be
    // unique and stable), so they are numbered by first appearance. react-aria adds a random
    // number per page load to its ids, which is dropped.
    const ids = new Map<string, string>();
    const norm = (s: string) =>
      s.replace(/react-aria\d+-/g, "react-aria-").replace(/_[rR]_[0-9a-z]+_|«[rR][0-9a-z]+»|:[rR][0-9a-z]+:/g, (id) => {
        let v = ids.get(id);
        if (v === undefined) ids.set(id, (v = "<id" + ids.size + ">"));
        return v;
      });
    console.log("scenario", name);
    // Fresh containers per scenario: `other` is for portals and second roots.
    document.body.innerHTML = '<div id="root"></div><div id="other"></div>';
    const root = document.getElementById("root")!;
    const other = document.getElementById("other")!;
    const t: T = {
      root,
      other,
      ssr: window.__ssr ?? {},
      log: (...parts) =>
        out.push(
          norm("log: " + parts.map((p) => (typeof p === "string" ? p : (JSON.stringify(p) ?? String(p)))).join(" ")),
        ),
      async step(label) {
        await settle();
        out.push(norm(`step ${label}: ${root.innerHTML}` + (other.innerHTML ? ` | other: ${other.innerHTML}` : "")));
      },
      $(sel) {
        const el = document.querySelector(sel);
        if (!el) throw new Error("no element " + sel);
        return el as HTMLElement;
      },
    };
    // An error thrown outside the scenario's own await (an event handler, a timer) is still part
    // of what React does, so it goes into the transcript too.
    const onError = (e: ErrorEvent) => out.push("uncaught: " + (e.error?.message ?? e.message));
    window.addEventListener("error", onError);
    try {
      await run(t);
      await settle();
    } catch (e) {
      out.push("threw: " + (e instanceof Error ? e.message : String(e)));
    }
    window.removeEventListener("error", onError);
  }
  window.__results = results;
  window.__done = true;
}

void main();
