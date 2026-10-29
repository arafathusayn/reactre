// Children placement edge cases (src/engine.ts), each scenario run on Preact and on
// @reactre/preact: the transcripts must be equal.

import { describe } from "bun:test";

import { useDom } from "./dom.ts";
import { same } from "./same.ts";

useDom();

describe("placement", () => {
  same("a cursor node removed while rendering: the next sibling is looked up again, or the node appended", (t) => {
    const { createElement: h, render } = t.R;
    // Mounting before <b>, a component removes <b> from the DOM while it renders.
    function Thief() {
      const b = (t.c.firstChild as any)?.lastChild;
      if (b && b.localName == "b") b.remove();
      return h("i", null, "new");
    }
    render(h("div", null, h("b", { key: "b" }, "old")), t.c);
    render(h("div", null, h(Thief, { key: "t" }), h("b", { key: "b" }, "old")), t.c);
    t.snap("after");
  });
});
