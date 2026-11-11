// The installed package, server-rendered and hydrated in a real browser: @reactre/state is packed
// from its build, installed into a folder outside the workspace with React, and the app in
// ./fixtures/ssr is rendered to HTML by react-dom/server under StrictMode, then hydrated by
// react-dom/client in headless Chrome under StrictMode, where React mounts, unmounts and mounts
// again. The click after hydration must move the machine, so the second mount's actor works.
//
// The package is installed as a user installs it: `bun pm pack` from dist/, then `bun install
// --offline` (the tarball is local; React comes from the install cache). The app's files are
// compiled by the installed plugin, through `bun --preload @reactre/state/plugin/preload`, so the
// test also proves the packed plugin entry works from node_modules.
//
// Chrome is needed: the test skips when none is found (the repository's own lookup,
// apps/react-compat/chrome.ts), so a machine without a browser still runs the suite.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChrome } from "../../../../apps/react-compat/chrome.ts";
import type { PuppeteerModule } from "./puppeteer.d.ts";

const root = join(import.meta.dir, "..", "..", "..", "..");
const pkg = join(root, "packages", "state");
const fixtures = join(import.meta.dir, "fixtures", "ssr");

/** The Chrome to run, or undefined when none is installed. */
function chrome(): string | undefined {
  try {
    return findChrome();
  } catch {
    return undefined;
  }
}

const browser = chrome();
const dir = browser === undefined ? undefined : mkdtempSync(join(tmpdir(), "reactre-state-ssr-"));
afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

/** Run `cmd` in `cwd`, its output returned; throw with the output when it fails. */
function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}\n${r.stderr.toString()}`);
  return out;
}

describe.skipIf(browser === undefined)("the installed package, server-rendered and hydrated", () => {
  test("renders under StrictMode, hydrates in Chrome, and the click moves the machine", async () => {
    if (dir === undefined || browser === undefined) throw new Error("no temp dir");
    // The package as it ships: its build, packed.
    const packs = join(dir, "packs");
    const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
    run(["bun", "pm", "pack", "--quiet", "--destination", packs], pkg);
    const tarball = join(packs, `reactre-state-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);

    // A user's project: the tarball and React, installed outside the workspace.
    const app = join(dir, "app");
    cpSync(fixtures, app, { recursive: true });
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "ssr-consumer",
          private: true,
          type: "module",
          dependencies: { "@reactre/state": `file:${tarball}`, react: "19.3.1", "react-dom": "19.3.1" },
        },
        null,
        2,
      ),
    );
    run(["bun", "install", "--offline", "--no-summary", "--no-progress"], app);

    // The server render, by the installed plugin: no effect runs, so the actor never starts, and
    // the start state's task (which records each run) never runs.
    const rendered = JSON.parse(run(["bun", "--preload", "@reactre/state/plugin/preload", "server.tsx"], app)) as {
      html: string;
      started: number;
    };
    const html = rendered.html;
    expect(html).toContain('<p id="state">closed</p>');
    expect(html).toContain('<button id="push">push</button>');
    // The render started nothing: the task's counter is 0, not 1.
    expect(rendered.started).toBe(0);

    // The client bundle, by the installed plugin's Bun entry, as a browser build.
    const { default: state } = (await import(Bun.resolveSync("@reactre/state/plugin/bun", app))) as {
      default: (options?: { dev?: boolean }) => import("bun").BunPlugin;
    };
    const built = await Bun.build({
      entrypoints: [join(app, "client.tsx")],
      target: "browser",
      format: "esm",
      minify: true,
      plugins: [state({ dev: false })],
      throw: false,
    });
    if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
    const [bundle] = built.outputs;
    if (bundle === undefined) throw new Error("no client bundle");
    const script = await bundle.text();

    // The page: the server's HTML, then the client bundle, in a real browser.
    const puppeteer = (
      (await import(Bun.resolveSync("puppeteer-core", join(root, "apps", "react-compat")))) as PuppeteerModule
    ).default;
    const launched = await puppeteer.launch({ executablePath: browser, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await launched.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.setContent(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
      await page.addScriptTag({ content: script, type: "module" });
      // Hydration committed and the effects ran: the actor is started and the button is live.
      await page.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true, {
        timeout: 5000,
      });
      await page.click("#push");
      await page.waitForFunction(() => document.getElementById("state")?.textContent === "open", {
        timeout: 5000,
      });
      const result = await page.evaluate(() => document.getElementById("state")?.textContent);
      expect(errors).toEqual([]);
      // The click after hydration moved the machine: the second StrictMode mount's actor works.
      expect(result).toBe("open");
    } finally {
      await launched.close();
    }
  }, 60_000);
});
