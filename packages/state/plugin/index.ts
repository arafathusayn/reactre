// @reactre/state/plugin (prototype): the compiler (../compiler) as a plugin for every bundler
// unplugin supports. Each bundler's entry (`@reactre/state/plugin/vite`, `/rollup`, `/rolldown`,
// `/esbuild`, `/webpack`, `/rspack`, `/bun`) is this plugin, built by unplugin for that bundler.
//
// Design decisions:
//   - `enforce: "pre"`, and listed before any plugin that strips TypeScript (@reactre/plugin
//     included): the contracts are types, so the compiler reads the source as written.
//   - Only files that mention "@reactre/state", "use pure" or ".machine(" are parsed; every other
//     file passes through as is. A file marked `"use pure";` is checked (a transition may call its
//     functions), and one that calls `.machine(` on a shape from another file fails (S4); both
//     pass through unchanged.
//   - A contract problem fails the build with every problem in the file, each with its place
//     (StateCompileError's message), so one build shows everything to change.
//   - `dev` defaults to NODE_ENV !== "production": a development build freezes data, so a
//     transition that edits it in place throws where it does it.

import { createUnplugin, type UnpluginInstance } from "unplugin";

import { compile } from "../compiler/index.ts";
import { devReact } from "./dev-react.ts";

/** Options of @reactre/state's plugin. */
export interface StateOptions {
  /** Development output (frozen data). Default: `process.env.NODE_ENV !== "production"`. */
  readonly dev?: boolean;
  /**
   * Packages whose exports are pure, so a transition may call them: `pure: ["date-fns"]`. A file of
   * the app's own is marked pure by `"use pure";` as its first line instead.
   */
  readonly pure?: readonly string[];
}

const SOURCE = /\.[cm]?[jt]sx?$/;

/** The plugin, for each bundler. */
export const state: UnpluginInstance<StateOptions | undefined, false> = createUnplugin<StateOptions | undefined, false>(
  (options) => {
    const dev = options?.dev ?? process.env["NODE_ENV"] !== "production";
    const pure = options?.pure ?? [];
    return {
      name: "@reactre/state",
      enforce: "pre",
      transformInclude: (id) => SOURCE.test(id.replace(/[?#].*$/, "")) && !id.includes("/node_modules/"),
      transform(code, id) {
        if (!code.includes("@reactre/state") && !code.includes("use pure") && !code.includes(".machine(")) return null;
        const file = id.replace(/[?#].*$/, "");
        // Development: the React entry becomes the one that warns (M313–M316). The compiler then
        // sees the dev entry, so its use sites are the same; a file with only React imports and no
        // machine is rewritten here, since the compiler returns null for it.
        const react = dev ? devReact(file, code) : null;
        const source = react ?? code;
        const out = compile(file, source, { dev, pure });
        if (out !== null) return { code: out.code };
        return react === null ? null : { code: react };
      },
    };
  },
);
