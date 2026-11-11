// The app's own TypeScript loader, after @reactre/state's plugin: webpack and Rspack need one to
// turn the rest of a .ts file into JavaScript (the plugin compiles the machine, not the file's
// types). It runs in Bun, which loads this .ts file as a module, and strips types with oxc.

import { transformSync } from "oxc-transform";

/** webpack's loader signature: the source in, the JavaScript out. */
export default function strip(this: { resourcePath: string }, source: string): string {
  const out = transformSync(this.resourcePath, source, { typescript: { onlyRemoveTypeImports: false } });
  if (out.errors.length > 0) throw new Error(out.errors.map((e) => e.message).join("\n"));
  return out.code;
}
