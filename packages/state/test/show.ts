// Prints what the compiler makes of a file: `bun packages/state/test/show.ts packages/state/test/fetcher.ts`.

import { compile, StateCompileError } from "../compiler/index.ts";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: bun show.ts <file>");
try {
  console.log(
    compile(file, await Bun.file(file).text(), { dev: process.argv.includes("--dev") })?.code ?? "(not a machine file)",
  );
} catch (e) {
  if (!(e instanceof StateCompileError)) throw e;
  console.log(e.message);
}
