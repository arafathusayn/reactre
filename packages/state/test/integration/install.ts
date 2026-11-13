// The installed-package tests' `bun install`: a user's project folder, with the packed tarball and
// any registry packages it names, installed for real.
//
// `--prefer-offline` takes each package from the install cache when it is there and from the
// registry when it isn't. `--offline` would need each package's registry manifest in the cache,
// and a cache filled by `bun install --frozen-lockfile` (as on CI) holds tarballs, not manifests.
// The install is bounded: one that hangs on the network fails the test with its output.

/** How long an install may take before the test fails. */
export const INSTALL_TIMEOUT = 30_000;

/** Install the project in `app`; throw with the output when it fails or runs past the bound. */
export function installApp(app: string): void {
  const r = Bun.spawnSync(["bun", "install", "--prefer-offline", "--no-summary", "--no-progress"], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
    timeout: INSTALL_TIMEOUT,
  });
  if (r.exitCode !== 0) {
    const why = r.exitedDueToTimeout === true ? `timed out after ${INSTALL_TIMEOUT}ms` : `exit ${r.exitCode}`;
    throw new Error(`bun install (${why}) failed in ${app}:\n${r.stdout.toString()}\n${r.stderr.toString()}`);
  }
}
