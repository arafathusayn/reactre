import * as compatApi from "@reactre/compat/api";
import * as compatCompiler from "@reactre/compat/compiler";
// Every build-tool entry of the packages: they run in a build tool's process, so this project has Bun's types.
import * as compiler from "@reactre/compiler";
import * as scan from "@reactre/compiler/scan";
// The core's server renderer, and the feature modules a server build points the app's imports at.
import * as server from "@reactre/core/server";
import * as serverAsync from "@reactre/core/server/async";
import * as serverDynamic from "@reactre/core/server/dynamic";
import * as plugin from "@reactre/plugin";
import bun from "@reactre/plugin/bun";
import esbuild from "@reactre/plugin/esbuild";
import rolldown from "@reactre/plugin/rolldown";
import rollup from "@reactre/plugin/rollup";
import rspack from "@reactre/plugin/rspack";
import vite from "@reactre/plugin/vite";
import webpack from "@reactre/plugin/webpack";
import * as preactCompiler from "@reactre/preact/compiler";
import * as preactPlugin from "@reactre/preact/plugin";

const js: string = compiler.compileJs("const a = 1;");
const p = vite({ compat: { classes: false } });
const html: string = server.renderToString(() => "hi", { hydrate: true });
const stream: ReadableStream<Uint8Array> = server.renderToStream(() => "hi");

export const all: unknown[] = [
  compiler,
  scan,
  compatApi,
  compatCompiler,
  plugin,
  vite,
  rollup,
  rolldown,
  esbuild,
  webpack,
  rspack,
  bun,
  preactCompiler,
  preactPlugin,
  js,
  p,
  server,
  serverAsync,
  serverDynamic,
  html,
  stream,
];
