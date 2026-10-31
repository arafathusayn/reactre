// Fast Refresh through a real Vite dev server: @vitejs/plugin-react and the plugin in compat mode
// serve fixtures/refresh (copied to a temp folder) to headless Chrome, which clicks a counter;
// then the test rewrites the counter's module, as an editor saves it. An edit to its text renders
// in place with the count kept, and an edit to its hook mounts it anew, as React's Fast Refresh
// does, both without a page reload. packages/compat/test/refresh.test.ts covers the renderer's
// side in detail.
//
// The dev server resolves @reactre/compat as an app's would, to its development build (dist/dev),
// so the packages are built first. Without Chrome or Chromium (or $CHROME), the test is skipped.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import react from "@vitejs/plugin-react";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type ViteDevServer } from "vite";

import reactre from "../src/vite.ts";

const PACKAGES = new URL("../../", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/refresh/", import.meta.url).pathname;

/** Chrome or Chromium: $CHROME, else the usual install places, else the usual names on PATH. */
function findChrome(): string | null {
  if (process.env["CHROME"]) return process.env["CHROME"];
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ])
    if (existsSync(p)) return p;
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = Bun.which(n);
    if (p) return p;
  }
  return null;
}
const chrome = findChrome();

let dir: string, server: ViteDevServer, browser: Browser, page: Page;
const errors: string[] = [];

beforeAll(async () => {
  if (chrome === null) return;
  for (const pkg of ["dom", "compat"]) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: PACKAGES + pkg, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`building ${pkg} failed:\n${r.stderr.toString()}`);
  }
  dir = mkdtempSync(join(tmpdir(), "reactre-plugin-refresh-"));
  cpSync(FIXTURE, dir, { recursive: true });
  server = await createServer({
    configFile: false,
    root: dir,
    logLevel: "silent",
    plugins: [reactre({ compat: true }), react()],
    // The temp folder reaches @reactre/compat through the plugin's own directory (see baseFor).
    server: { port: 0, fs: { allow: [dir, PACKAGES] } },
  });
  await server.listen();
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  page.on("pageerror", (e) => void errors.push(String(e)));
  // A failed load is reported as a console error without its URL: the response says it.
  page.on(
    "console",
    (m) => void (m.type() === "error" && !m.text().startsWith("Failed to load") && errors.push(m.text())),
  );
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`${r.status()} ${r.url()}`);
  });
  // A DevTools hook in place before the page runs, as the extension's is, which react-refresh's
  // preamble patches: it records the renderers injected into it.
  await page.evaluateOnNewDocument(() => {
    const injected: string[] = ((window as any).__injected = []);
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      inject: (renderer: { rendererPackageName: string }) => injected.push(renderer.rendererPackageName),
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
    };
  });
  await page.goto(server.resolvedUrls!.local[0]!);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Rewrite the counter's module, `from` replaced by `to`, as an editor saves it. */
function edit(from: string, to: string): void {
  const file = join(dir, "counter.tsx");
  const source = readFileSync(file, "utf8");
  expect(source).toContain(from);
  writeFileSync(file, source.replace(from, to));
}

/** Wait until the counter reads `text`. */
async function reads(text: string): Promise<void> {
  await page.waitForFunction((t) => document.getElementById("count")?.textContent === t, { timeout: 20_000 }, text);
}

test.skipIf(chrome === null)(
  "an edit renders in place keeping state, and an edit to a hook mounts anew, with no reload",
  async () => {
    await reads("before: 0");
    // react resolved to compat's development build, which registered with react-refresh's hook.
    const loaded = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name));
    expect(loaded.some((url) => url.includes("/compat/dist/dev/"))).toBe(true);
    expect(loaded.some((url) => /\/compat\/dist\/(index|core|chunk-)/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__injected)).toEqual(["react-dom"]);
    for (let i = 0; i < 3; i++) await page.click("#count");
    await reads("before: 3");
    // A page that reloads loses this.
    await page.evaluate(() => void ((window as any).__kept = true));

    edit("before: {count}", "after: {count}");
    await reads("after: 3");
    await page.click("#count");
    await reads("after: 4");

    // The hook's signature changes: React mounts the component anew, its state from the new code.
    edit("useState(0)", "useState(10)");
    await reads("after: 10");
    await page.click("#count");
    await reads("after: 11");

    expect(await page.evaluate(() => (window as any).__kept)).toBe(true);
    expect(errors).toEqual([]);
  },
  60_000,
);
