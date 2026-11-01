import * as compatApi from "@reactre/compat/api";
import * as compatCompiler from "@reactre/compat/compiler";
// Every build-tool entry of the packages: they run in a build tool's process, so this project has Bun's types.
import * as compiler from "@reactre/compiler";
import * as scan from "@reactre/compiler/scan";
// The core's server renderer, and the feature modules a server build points the app's imports at.
import * as server from "@reactre/core/server";
import * as serverAsync from "@reactre/core/server/async";
import * as serverDynamic from "@reactre/core/server/dynamic";
import * as serverEffects from "@reactre/core/server/effects";
import * as serverErrors from "@reactre/core/server/errors";
import * as serverHydrate from "@reactre/core/server/hydrate";
import * as serverReaction from "@reactre/core/server/reaction";
import * as serverTiming from "@reactre/core/server/timing";
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
// The response head a render's httpStatus and httpHeader write to, and its hydration writer.
const response: server.ResponseHead = { status: 200, headers: new Headers() };
const whole: Promise<string> = server.renderToStringAsync(
  () => {
    server.httpStatus(404, "Not Found");
    server.httpHeader("vary", "cookie", { append: true });
    const writer: server.HydrationWriter | undefined = server.getHydrationWriter();
    const wrote: boolean | undefined = writer?.write("app:user", Promise.resolve({ id: 1 }), { deferStream: true });
    const user: () => { id: number } = serverAsync.memo(async () => ({ id: 1 }), { id: "user", deferStream: true });
    return [wrote, user().id, serverHydrate.isHydrating()];
  },
  { response, nonce: "abc", hydrate: true },
);

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
  serverEffects,
  serverErrors,
  serverHydrate,
  serverReaction,
  serverTiming,
  html,
  stream,
  whole,
];
