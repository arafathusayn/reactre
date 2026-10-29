import { expect, test } from "bun:test";

import { __block, __template } from "../src/block.ts";
import { Component, createElement as h, render } from "../src/engine.ts";
import { container, html, installDom, tick, useDom } from "./dom.ts";

useDom();

test("boundary reset keeps order", async () => {
  installDom();
  const Tp = __template(["p", 0, "fine"]);
  const Tdiv = __template(["div", 0, 0]);
  const Tbtn = __template(["button", { id: "explode" }, "explode"]);
  let setExplode: any, reset: any;
  function Bomb({ explode }: any) {
    if (explode) throw new Error("boom");
    return __block(Tp, undefined, []);
  }
  class EB extends (Component as any) {
    constructor(p: any) {
      super(p);
      this.state = { error: null };
      reset = () => this.setState({ error: null });
    }
    static getDerivedStateFromError(error: any) {
      return { error };
    }
    render() {
      return this.state.error ? h("button", { id: "reset" }, "failed") : this.props.children;
    }
  }
  class App extends (Component as any) {
    constructor(p: any) {
      super(p);
      this.state = { explode: false };
      setExplode = (v: boolean) => this.setState({ explode: v });
    }
    render() {
      return process.env.PLAIN
        ? h(
            "div",
            null,
            h(EB, null, h(Bomb, { explode: this.state.explode })),
            h("button", { id: "explode" }, "explode"),
          )
        : __block(Tdiv, undefined, [
            [h(EB, null, h(Bomb, { explode: this.state.explode })), __block(Tbtn, undefined, [])],
          ]);
    }
  }
  const c = container();
  render(h(App, null), c as any);
  console.log(html(c));
  setExplode(true);
  await tick();
  console.log(html(c));
  setExplode(false);
  reset();
  await tick();
  console.log(html(c));
  expect(html(c)).toBe('<div><p>fine</p><button id="explode">explode</button></div>');
});
