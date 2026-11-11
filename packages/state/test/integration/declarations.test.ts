// The packed declarations, as a user's project reads them: @reactre/state is packed from its build
// and installed outside the workspace, and `bun check` type-checks a project against its
// dist/*.d.ts with skipLibCheck off. The project imports every runtime entry, and its machine
// checks that a broken contract is still a type error from the declarations (not from the sources).
//
// This is the state package's own slice of scripts/consumer.ts: that script packs every package
// and checks a whole app; this one proves the state package's declarations alone, in the
// integration suite, so a change to its exports or types fails here first.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..");
const pkg = join(root, "packages", "state");
const fixtures = join(import.meta.dir, "fixtures", "declarations");

const dir = mkdtempSync(join(tmpdir(), "reactre-state-declarations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run `cmd` in `cwd`, its output returned; throw with the output when it fails. */
function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}\n${r.stderr.toString()}`);
  return out;
}

describe("the packed declarations, as a user's project reads them", () => {
  test("every entry imports, and a broken contract is still a type error", () => {
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
          name: "declarations-consumer",
          private: true,
          type: "module",
          dependencies: { "@reactre/state": `file:${tarball}`, react: "19.3.1" },
        },
        null,
        2,
      ),
    );
    run(["bun", "install", "--offline", "--no-summary", "--no-progress"], app);

    // The declarations are the ones the package ships, not the sources: the project's tsconfig
    // has no `reactre-source` condition, so `types` resolves to dist/*.d.ts. `bun check` writes
    // its success line to stderr, so the exit status is what this asserts; a failure's output is
    // in the thrown error.
    const r = Bun.spawnSync(["bun", "check", "-p", "tsconfig.json", "--no-pretty"], {
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(`bun check failed:\n${r.stdout.toString()}\n${r.stderr.toString()}`);
    }
    // The deliberate error in machine.ts is held by @ts-expect-error: an unused one would fail too.
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
