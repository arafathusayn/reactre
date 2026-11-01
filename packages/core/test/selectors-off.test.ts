// Without @reactre/core/features/selectors, a <For> row that reads a second selector key throws,
// naming the import. Once a test installs the module it stays installed, so this test loads its
// own copy of the runtime.

import { beforeEach, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

// A copy of the runtime of its own: the test run shares one module across files, and another file
// installs the selectors module in it.
const copy: string = "../src/index.ts?selectors-off";
const runtime = (await import(copy)) as typeof import("../src/index.ts");

beforeEach(installFakeDocument);

test("a row that reads a second key through its own function throws, naming the module", () => {
  // One call with arguments in the row's hole, so the compiler does not import the module itself.
  const src = `
    import { For, render, selector, signal } from "@reactre/core";
    const [sel] = signal(0);
    const isSel = selector(sel);
    const near = (id) => isSel(id) || isSel(id + 1);
    const rows = [1, 2].map((id) => ({ id }));
    function App() {
      return <ul><For each={rows} key={(r) => r.id}>{(r) => <li class={near(r.id) ? "near" : ""} />}</For></ul>;
    }
    render(App, root);
  `;
  const js = compileSource(src).replace(/^import \{([^}]*)\} from "@reactre\/core";$/gm, (_, names: string) =>
    names
      .split(",")
      .map((n) => {
        const [a, b] = n.trim().split(" as ");
        return `const ${b ?? a} = rr.${a};`;
      })
      .join("\n"),
  );
  expect(js).not.toContain("features/selectors");
  const root = new FakeElement("DIV");
  expect(() => new Function("rr", "root", js)(runtime, root)).toThrow('import "@reactre/core/features/selectors"');
});
