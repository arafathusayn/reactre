// @reactre/state/plugin/runtime: the compiler as a Bun runtime plugin, so `bun run` and `bun test`
// load machines compiled. unplugin's Bun entry (./bun.ts) is for `Bun.build`; Bun's runtime
// plugins get no build config, which it reads. `@reactre/state/plugin/preload` registers it.
//
// A runtime onLoad that matches a file must return its contents: it can't hand the file back to
// Bun or to a later plugin. So `filter` decides which files it claims: by default every .ts and
// .tsx file outside node_modules. An app that has another runtime plugin for the same files (such
// as @reactre/compiler's) narrows it to the folders with machines.

import type { BunPlugin } from "bun";

import { compile } from "../compiler/index.ts";
import { devReact } from "./dev-react.ts";

export interface StatePreloadOptions {
  /** Development output (frozen data). Default: true. */
  readonly dev?: boolean;
  /** The files it claims, by path. Default: every .ts, .mts, .cts and .tsx file. */
  readonly filter?: RegExp;
  /** Packages whose exports are pure, so a transition may call them (the bundler plugin's `pure`). */
  readonly pure?: readonly string[];
}

/** The runtime plugin: compiles each claimed file outside node_modules that has a machine. */
export function statePreload(options: StatePreloadOptions = {}): BunPlugin {
  return {
    name: "@reactre/state",
    setup(build) {
      build.onLoad({ filter: options.filter ?? /\.[cm]?tsx?$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const loader = path.endsWith("x") ? "tsx" : "ts";
        if (path.includes("/node_modules/")) return { contents: source, loader };
        const dev = options.dev ?? true;
        // Development: the React entry becomes the one that warns (M313–M316), before the compiler
        // reads the file, so its use sites are the same.
        const react = dev ? devReact(path, source) : null;
        const out = compile(path, react ?? source, { dev, pure: options.pure ?? [] });
        return { contents: out?.code ?? react ?? source, loader };
      });
    },
  };
}
