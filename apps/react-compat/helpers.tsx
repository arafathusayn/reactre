// Helpers the library scenarios share: waiting for library work, mounting, and input events built
// as a browser sends them.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { T } from "./cases.tsx";

/** Resolves after `ms` milliseconds, for library work scheduled on timers. */
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Resolves after `n` animation frames, for library work that ResizeObserver callbacks and
 * animation frames schedule: a step that only waits for timers could read the page before that
 * work runs, on either runtime.
 */
export const frames = (n: number): Promise<void> =>
  new Promise((r) => (n > 0 ? requestAnimationFrame(() => void frames(n - 1).then(r)) : r()));

/** Renders `el` into the scenario's container and flushes it, so the mount is in the DOM at once. */
export function mount(t: T, el: React.ReactNode): void {
  const r = createRoot(t.root);
  flushSync(() => r.render(el));
}

/** A bubbling, cancelable keydown of key `k` on `el`, as a keyboard press sends it. */
export const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
/** The focused element as "tag:text", or "body" when nothing has focus. */
export const active = () => {
  const a = document.activeElement as HTMLElement | null;
  return a === null || a === document.body ? "body" : a.nodeName.toLowerCase() + ":" + (a.textContent ?? "");
};

/** A short, stable digest of a string, for logging large values such as canvas data URLs. */
export function digest(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

/** A keydown of `k` that also carries its legacy keyCode, for libraries that read it. */
export function keyWithCode(el: Element, k: string, keyCode: number): void {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  Object.defineProperty(e, "keyCode", { value: keyCode });
  el.dispatchEvent(e);
}

/** A pointer-capable mouse event of `type` at (x, y), as a real mouse sends it. */
export const mouse = (el: EventTarget, type: string, x = 0, y = 0) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

/** Resolves once `done()` holds, checking every animation frame, or after `ms` milliseconds. */
export async function until(done: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await frames(1);
}
