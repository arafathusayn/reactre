// The installed package's development React entry, in a real browser: @reactre/state is packed from
// its build, installed into a folder outside the workspace with React, and the app in
// ./fixtures/dev-react is mounted by react-dom/client in headless Chrome under StrictMode, which
// mounts, unmounts and mounts again. The dev entry's hooks warn for M315 (a selector that builds a
// new object with no compare) and M316 (a send from an effect that runs once, lost when Strict
// Mode's second mount replaces the actor); the production entry warns for neither.
//
// Chrome is needed: the test skips when none is found, as the SSR test does.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChrome } from "../../../../apps/react-compat/chrome.ts";
import { installApp } from "./install.ts";

const root = join(import.meta.dir, "..", "..", "..", "..");
const pkg = join(root, "packages", "state");
const fixtures = join(import.meta.dir, "fixtures", "dev-react");

function chrome(): string | undefined {
  try {
    return findChrome();
  } catch {
    return undefined;
  }
}

const browser = chrome();
const dir = browser === undefined ? undefined : mkdtempSync(join(tmpdir(), "reactre-state-dev-react-"));
afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}\n${r.stderr.toString()}`);
  return out;
}

describe.skipIf(browser === undefined)("the installed package's dev React entry, in Chrome", () => {
  test("StrictMode warns for M315 and M316 in development, and not in production", async () => {
    if (dir === undefined || browser === undefined) throw new Error("no temp dir");
    const packs = join(dir, "packs");
    const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
    run(["bun", "pm", "pack", "--quiet", "--destination", packs], pkg);
    const tarball = join(packs, `reactre-state-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);

    const app = join(dir, "app");
    cpSync(fixtures, app, { recursive: true });
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "dev-react-consumer",
          private: true,
          type: "module",
          dependencies: { "@reactre/state": `file:${tarball}`, react: "19.3.1", "react-dom": "19.3.1" },
        },
        null,
        2,
      ),
    );
    installApp(app);

    const { default: state } = (await import(Bun.resolveSync("@reactre/state/plugin/bun", app))) as {
      default: (options?: { dev?: boolean }) => import("bun").BunPlugin;
    };
    const bundle = async (dev: boolean): Promise<string> => {
      const built = await Bun.build({
        entrypoints: [join(app, "client.tsx")],
        target: "browser",
        format: "esm",
        minify: true,
        plugins: [state({ dev })],
        throw: false,
      });
      if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
      const [file] = built.outputs;
      if (file === undefined) throw new Error("no client bundle");
      return file.text();
    };

    // puppeteer-core is installed in apps/react-compat, not here: its types aren't resolvable from
    // this package, so the little of it this test uses is typed here (as the SSR test does).
    type Page = {
      on: (event: string, listener: (e: unknown) => void) => void;
      setContent: (html: string) => Promise<void>;
      addScriptTag: (options: { content: string; type: string }) => Promise<unknown>;
      waitForFunction: (fn: () => boolean, options: { timeout: number }) => Promise<unknown>;
      evaluate: <T>(fn: () => T) => Promise<T>;
      close: () => Promise<void>;
    };
    type Browser = { newPage: () => Promise<Page>; close: () => Promise<void> };
    const puppeteer = (await import(Bun.resolveSync("puppeteer-core", join(root, "apps", "react-compat")))).default as {
      launch: (options: { executablePath: string; headless: boolean; args: string[] }) => Promise<Browser>;
    };
    const launched = await puppeteer.launch({ executablePath: browser, headless: true, args: ["--no-sandbox"] });
    try {
      const warnings = async (script: string): Promise<string[]> => {
        const page = await launched.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e: unknown) => errors.push(String(e)));
        await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
        await page.addScriptTag({ content: script, type: "module" });
        await page.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true, {
          timeout: 5000,
        });
        // Let StrictMode's second mount and its effects settle.
        await new Promise((r) => setTimeout(r, 100));
        const out = await page.evaluate(() => (globalThis as unknown as { __warnings: string[] }).__warnings);
        expect(errors).toEqual([]);
        await page.close();
        return out;
      };

      const dev = await warnings(await bundle(true));
      expect(dev.some((w) => w.includes("the selector returns a new object on each notification"))).toBe(true);
      expect(dev.some((w) => w.includes("Strict Mode's second mount replaced the actor"))).toBe(true);

      const prod = await warnings(await bundle(false));
      expect(prod).toEqual([]);
    } finally {
      await launched.close();
    }
  }, 60_000);
});
