// @reactre/state's build-tool entries: its compiler, codemod and plugin, which run in a bundler's
// or Bun's process.
import * as codemod from "@reactre/state/codemod";
import * as compiler from "@reactre/state/compiler";
import bun from "@reactre/state/plugin/bun";
import esbuild from "@reactre/state/plugin/esbuild";
import * as preload from "@reactre/state/plugin/preload";
import rolldown from "@reactre/state/plugin/rolldown";
import rollup from "@reactre/state/plugin/rollup";
import rspack from "@reactre/state/plugin/rspack";
import * as runtime from "@reactre/state/plugin/runtime";
import vite, { type StateOptions } from "@reactre/state/plugin/vite";
import webpack from "@reactre/state/plugin/webpack";

const options: StateOptions = { dev: false, pure: ["date-fns"] };
const source = `import { setup, types } from "@reactre/state";
const shape = setup({ version: 1, states: { idle: types<{}>() }, events: {} });
export const machine = shape.machine({ start: ({ to }) => to("idle"), states: { idle: {} } });
`;
let compiled: string | undefined;
try {
  compiled = compiler.compile("machine.ts", source, options)?.code;
} catch (e) {
  if (!(e instanceof compiler.StateCompileError)) throw e;
}
const bunRuntime: import("bun").BunPlugin = runtime.statePreload({ dev: false, filter: /\/machines\// });
const converted: string = codemod.convert("door.ts", "").code;

export const all: unknown[] = [
  vite(options),
  rollup(options),
  rolldown(options),
  esbuild(options),
  webpack(options),
  rspack(options),
  bun(options),
  preload.statePreload,
  compiled,
  bunRuntime,
  converted,
];
