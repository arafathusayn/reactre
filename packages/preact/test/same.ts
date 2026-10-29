// Differential tests: a scenario runs on Preact 11.1.0 and on @reactre/preact, each over a fresh
// fake DOM, and the two transcripts must be equal. Preact is the oracle, so no expected output is
// written by hand; a test only checks that the transcript says something.

import { expect, test } from "bun:test";

import { FakeEvent } from "@reactre/testdom";
import * as preact from "preact";
import * as preactCompat from "preact/compat";
import * as preactClient from "preact/compat/client";
import * as preactCompatJsx from "preact/compat/jsx-runtime";
import * as preactHooks from "preact/hooks";
import * as preactJsx from "preact/jsx-runtime";

import * as compat from "../src/compat.ts";
import * as core from "../src/core.ts";
import * as jsx from "../src/jsx-runtime.ts";
import { container, type El, html, installDom, tick } from "./dom.ts";

/** What a scenario gets: one runtime's API, a transcript, and helpers. */
export interface Ctx {
  /** preact plus preact/hooks, or @reactre/preact/core. */
  readonly R: any;
  /** preact/compat, or @reactre/preact/compat. */
  readonly X: any;
  /** The JSX runtime: preact/jsx-runtime, or @reactre/preact/jsx-runtime. */
  readonly J: any;
  /** compat's JSX runtime. */
  readonly XJ: any;
  /** A fresh connected container. */
  readonly c: El;
  /** Add a line to the transcript. */
  log(...parts: unknown[]): void;
  /** Add a container's HTML (default `c`) to the transcript. */
  snap(label: string, el?: El): void;
  fire(el: unknown, type: string, init?: Record<string, unknown>): void;
  container(): El;
  /** Wait for the render queue. */
  tick(): Promise<void>;
  /** Wait for passive effects (35 ms without a frame). */
  paint(): Promise<void>;
}

const runtimes = {
  preact: {
    R: { ...preact, ...preactHooks },
    X: { ...preactCompat, createRoot: preactClient.createRoot, hydrateRoot: preactClient.hydrateRoot },
    J: preactJsx,
    XJ: preactCompatJsx,
  },
  ours: { R: core, X: compat, J: jsx, XJ: compat },
};

/** Run a scenario on one runtime and return its transcript. */
export async function transcript(
  name: keyof typeof runtimes,
  scenario: (t: Ctx) => unknown,
  withCompat = false,
): Promise<string[]> {
  installDom();
  const { R, X, J, XJ } = runtimes[name];
  const opts = R.options as Record<string, unknown>;
  const saved = { ...opts };
  // compat installs its vnode and event hooks when loaded: a core scenario runs without them.
  if (!withCompat) opts.vnode = opts.event = undefined;
  const out: string[] = [];
  const show = (p: unknown): string =>
    typeof p === "string"
      ? p
      : // A TypeError's message names a variable, which minification renames.
        p instanceof TypeError
        ? "TypeError"
        : p instanceof Error
          ? `Error(${p.message})`
          : String(JSON.stringify(p));
  const t: Ctx = {
    R,
    X,
    J,
    XJ,
    c: container(),
    log: (...parts) => out.push(parts.map(show).join(" ")),
    snap: (label, el) => out.push(`${label}: ${html(el ?? t.c)}`),
    fire: (el, type, init) => {
      const e = Object.assign(new FakeEvent(type), init);
      (el as El).dispatchEvent(e);
    },
    container,
    tick,
    paint: () => new Promise((r) => setTimeout(r, 45)),
  };
  try {
    await scenario(t);
    await tick();
  } catch (e) {
    out.push("threw " + show(e));
  } finally {
    for (const k of Object.keys(opts)) if (!(k in saved)) delete opts[k];
    Object.assign(opts, saved);
  }
  return out;
}

/** A test that the scenario's transcript is the same on both runtimes; `withCompat` keeps compat's hooks on. */
export function same(title: string, scenario: (t: Ctx) => unknown, withCompat = false): void {
  test(title, async () => {
    const want = await transcript("preact", scenario, withCompat);
    const got = await transcript("ours", scenario, withCompat);
    expect(got).toEqual(want);
    expect(want.length).toBeGreaterThan(0);
  });
}
