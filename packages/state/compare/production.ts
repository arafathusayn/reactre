// Registers the compiler as a Bun runtime plugin with `dev` off, so machines load as a production
// build ships them: no frozen data. The other libraries run their production builds, so ours must
// too. Import it, then import the machines dynamically (static imports load before it runs).

import { compile } from "../compiler/index.ts";

Bun.plugin({
  name: "@reactre/state (production)",
  setup(build) {
    build.onLoad({ filter: /\/packages\/state\/.*\.[cm]?tsx?$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const loader = path.endsWith("x") ? "tsx" : "ts";
      if (path.includes("/node_modules/")) return { contents: source, loader };
      return { contents: compile(path, source, { dev: false })?.code ?? source, loader };
    });
  },
});
