// Type-checks a project that installs the published packages, as a user's project does: each
// package packed from its build (run each package's build first, as CI does), installed with npm
// into a folder outside the workspace, and checked by TypeScript's own tsc with skipLibCheck
// false. The project imports every entry of every package, from a browser app (no Node or Bun
// types) and from build tools (with them), each under moduleResolution bundler and node16, and
// it compiles packages/core/test/jsx-types.tsx, the JSX types test, against the declarations.
//
//   bun scripts/consumer.ts          exits non-zero if any of the four checks fails
//
// The repository's own `bun check` reads the sources (the reactre-source condition); only this
// reads the dist/*.d.ts files that the packages' `types` conditions name.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const PACKAGES = ["dom", "core", "compiler", "compat", "full-compat", "plugin", "preact"];
// The bundlers the plugin's declarations reach through unplugin's, which import each one's types.
const TOOLS: Record<string, string> = {
  typescript: "7.0.2",
  "@types/bun": "1.4.4",
  vite: "8.3.5",
  rollup: "4.67.2",
  rolldown: "1.2.16",
  esbuild: "0.28.2",
  webpack: "5.112.2",
  "@rspack/core": "2.3.0",
  unloader: "0.10.1",
};

/** Run `cmd` in `cwd`, its output passed through; throw if it fails. */
function run(cmd: string[], cwd: string): void {
  const { exitCode } = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd} (exit ${exitCode})`);
}

const dir = mkdtempSync(join(tmpdir(), "reactre-consumer-"));
try {
  const packs = join(dir, "packs");
  const deps: Record<string, string> = {};
  for (const name of PACKAGES) {
    const pkg = join(root, "packages", name);
    const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
    run(["bun", "pm", "pack", "--quiet", "--destination", packs], pkg);
    deps[`@reactre/${name}`] = `file:${join(packs, `reactre-${name}-${version}.tgz`)}`;
  }

  const app = join(dir, "app");
  cpSync(join(import.meta.dir, "consumer"), app, { recursive: true });
  cpSync(join(root, "packages/core/test/jsx-types.tsx"), join(app, "src/app.tsx"));
  const manifest = { name: "consumer", private: true, type: "module", dependencies: { ...deps, ...TOOLS } };
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2));
  const configs: string[] = [];
  for (const resolution of ["bundler", "node16"]) {
    const module = resolution === "bundler" ? "esnext" : "node16";
    for (const [part, types] of [
      ["src", []],
      ["tools", ["bun"]],
    ] as const) {
      const file = `tsconfig.${part}.${resolution}.json`;
      const compilerOptions = { module, moduleResolution: resolution, types };
      writeFileSync(
        join(app, file),
        JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions, include: [part] }),
      );
      configs.push(file);
    }
  }

  run(["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"], app);
  let failed = 0;
  for (const config of configs) {
    const { exitCode } = Bun.spawnSync(["./node_modules/.bin/tsc", "-p", config, "--pretty", "false"], {
      cwd: app,
      stdout: "inherit",
      stderr: "inherit",
    });
    console.log(`${exitCode === 0 ? "ok" : "not ok"} - ${config}`);
    if (exitCode !== 0) failed++;
  }
  if (failed > 0) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
