// Finds a Chrome or Chromium for the compatibility check.
//
// The lookup order is $CHROME, then the usual install places on macOS and Linux, then the first
// of the usual executable names on PATH. $CHROME comes first so a run can pin one exact build.
// Puppeteer starts its own process with a fresh profile, never the user's open browser, so a
// run never sees the user's extensions, tabs or cache.
//
// The check keeps its own copy rather than importing apps/jfb's, so it depends on no app.

import { existsSync } from "node:fs";

/** Absolute install paths, checked in order: macOS app bundles first, then Linux packages. */
const places = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
/** Executable names looked up on PATH when no install path exists. */
const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/**
 * The browser executable to launch.
 *
 * The parameters default to the real environment, file system and PATH; tests pass stand-ins so
 * the lookup order can be checked without any browser installed.
 *
 * @throws When no browser is found, with a message that says how to point at one.
 */
export function findChrome(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | null = Bun.which,
): string {
  const set = env["CHROME"];
  if (set) return set;
  for (const p of places) if (exists(p)) return p;
  for (const n of names) {
    const p = which(n);
    if (p) return p;
  }
  throw new Error("No Chrome found: install Chrome or Chromium, or set CHROME to its executable.");
}
