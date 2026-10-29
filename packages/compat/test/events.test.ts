// Unit tests for @reactre/compat's event system, react-dom's resource hints and the default
// export, on the fake DOM with the few additions below. What each test expects is React 19's
// behavior, read from react-dom's own source (react-dom-client.development.js).
//
// Covered: capture and bubble handlers, the native types behind onDoubleClick, onFocus, onBlur
// and onGotPointerCapture, onChange for text fields, checkboxes, selects and files (with React's
// value tracker), controlled fields shown their props again after an event, events through
// portals and nested roots, a root's listeners after unmount, events that do not bubble, mouse
// and pointer enter and leave, the synthetic event's methods and fields, preconnect,
// prefetchDNS, preload, preloadModule, preinit and preinitModule, and the default export.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, type FakeNode, FakeText, installFakeDocument } from "@reactre/testdom";

import React, {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as internals,
  createElement as h,
  createPortal,
  createRoot,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  type Root,
  useActionState,
  useState,
} from "../src/index.ts";

// #region Fake DOM additions

type Handler = (this: FakeNode, e: { type: string; target: FakeNode }) => void;

/**
 * An element with the DOM's listener phases: FakeElement has no capture listeners and no
 * removeEventListener. Events reach these listeners through `fire`, not dispatchEvent.
 */
class El extends FakeElement {
  readonly handlers: { type: string; fn: Handler; capture: boolean }[] = [];
  override addEventListener(type: string, fn: Handler, capture = false): void {
    if (!this.handlers.some((l) => l.type === type && l.fn === fn && l.capture === capture))
      this.handlers.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Handler, capture = false): void {
    const i = this.handlers.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.handlers.splice(i, 1);
  }
}

/**
 * An <input> or <textarea>: `value` and `checked` are accessors on the prototype, as the DOM's
 * are, so React's value tracker can wrap them (it looks for them there).
 */
class Field extends El {
  type = "text";
  #value = "";
  #checked = false;
  get value(): string {
    return this.#value;
  }
  set value(v: string) {
    this.#value = String(v);
  }
  get checked(): boolean {
    return this.#checked;
  }
  set checked(v: boolean) {
    this.#checked = v;
  }
}

/** Change a field as the user does: through the prototype's setter, which the tracker does not see. */
function userSets(el: FakeNode, key: "value" | "checked", v: string | boolean): void {
  Object.getOwnPropertyDescriptor(Field.prototype, key)!.set!.call(el, v);
}

/** A native event with what the event system reads: bubbles, preventDefault and relatedTarget. */
class Ev extends FakeEvent {
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  relatedTarget: FakeNode | null;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; relatedTarget?: FakeNode | null } = {}) {
    super(type);
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? false;
    this.relatedTarget = init.relatedTarget ?? null;
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  /** True for Shift, and only when called on the native event itself. */
  getModifierState(key: string): boolean {
    return this instanceof Ev && key === "Shift";
  }
}

/**
 * Dispatch `e` from `target` as the DOM does: capture listeners from the top down to the target,
 * then bubble listeners from the target up (the target's only when the event does not bubble),
 * until a listener stops propagation.
 */
function fire<E extends Ev>(target: FakeNode, e: E): E {
  e.target = target;
  const path: El[] = [];
  for (let n: FakeNode | null = target; n !== null; n = n.parentNode) if (n instanceof El) path.push(n);
  const run = (n: El, capture: boolean): void => {
    e.currentTarget = n;
    for (const l of n.handlers.slice())
      if (l.type === e.type && l.capture === capture) l.fn.call(n, e as { type: string; target: FakeNode });
  };
  for (let i = path.length - 1; i >= 0 && !e.cancelBubble; i--) run(path[i]!, true);
  for (let i = 0; i < path.length && !e.cancelBubble && (i === 0 || e.bubbles); i++) run(path[i]!, false);
  e.currentTarget = null;
  return e;
}

// #endregion

// #region Fixtures

let container: El;
let root: Root;

beforeEach(() => {
  installFakeDocument();
  (document as unknown as { createElement: (tag: string) => El }).createElement = (tag) =>
    tag === "input" || tag === "textarea" ? new Field(tag.toUpperCase()) : new El(tag.toUpperCase());
  container = new El("DIV");
  container.isDocument = true;
  root = createRoot(container as unknown as Element);
});

const render = (el: unknown): void => flushSync(() => root.render(el));
/** The `i`th child of `n`, as an element. */
const child = (n: FakeNode, i = 0): El => n.childNodes[i] as El;

// #endregion

describe("capture and bubble", () => {
  test("capture handlers run outermost first, then bubble handlers innermost first", () => {
    const log: string[] = [];
    const on = (s: string) => () => log.push(s);
    render(
      h(
        "div",
        { onClickCapture: on("div capture"), onClick: on("div") },
        h("button", { onClickCapture: on("button capture"), onClick: on("button") }),
      ),
    );
    fire(child(child(container)), new Ev("click"));
    expect(log).toEqual(["div capture", "button capture", "button", "div"]);
  });

  test("stopPropagation in a capture handler ends the capture phase and skips the bubble phase", () => {
    const log: string[] = [];
    render(
      h(
        "div",
        { onClickCapture: (e: Ev) => (log.push("div capture"), e.stopPropagation()), onClick: () => log.push("div") },
        h("button", { onClickCapture: () => log.push("button capture"), onClick: () => log.push("button") }),
      ),
    );
    fire(child(child(container)), new Ev("click"));
    expect(log).toEqual(["div capture"]);
  });

  test("onDoubleClick listens to dblclick, and its event says dblclick", () => {
    const types: string[] = [];
    render(h("p", { onDoubleClick: (e: Ev) => types.push(e.type) }));
    fire(child(container), new Ev("dblclick"));
    expect(types).toEqual(["dblclick"]);
  });

  test("onFocus and onBlur bubble, from focusin and focusout, and say focus and blur", () => {
    const log: string[] = [];
    const on = (e: { type: string; target: El; currentTarget: El }) =>
      log.push(`${e.type} ${e.target.tagName} ${e.currentTarget.tagName}`);
    render(h("form", { onFocus: on, onBlur: on }, h("input")));
    const input = child(child(container));
    fire(input, new Ev("focusin"));
    fire(input, new Ev("focusout"));
    expect(log).toEqual(["focus INPUT FORM", "blur INPUT FORM"]);
  });

  test("onGotPointerCapture and onLostPointerCapture are bubble-phase props, though named ...Capture", () => {
    const log: string[] = [];
    render(
      h(
        "div",
        { onGotPointerCapture: (e: Ev) => log.push("div " + e.type) },
        h("span", { onLostPointerCapture: (e: Ev) => log.push("span " + e.type) }),
      ),
    );
    const span = child(child(container));
    fire(span, new Ev("gotpointercapture"));
    fire(span, new Ev("lostpointercapture"));
    expect(log).toEqual(["div gotpointercapture", "span lostpointercapture"]);
  });

  test("the handlers of one prop share one synthetic event; currentTarget is each handler's element, then null", () => {
    const seen: unknown[] = [];
    const at: string[] = [];
    const on = (e: { currentTarget: El }) => (seen.push(e), at.push(e.currentTarget.tagName));
    render(h("div", { onClick: on }, h("button", { onClick: on })));
    fire(child(child(container)), new Ev("click"));
    expect(at).toEqual(["BUTTON", "DIV"]);
    expect(seen[0]).toBe(seen[1]);
    expect((seen[0] as { currentTarget: unknown }).currentTarget).toBeNull();
  });
});

describe("onChange", () => {
  test("typing in a text input fires onInput, then onChange, which says change", () => {
    const log: string[] = [];
    const on = (e: { type: string; target: Field }) => log.push(`${e.type} ${e.target.value}`);
    render(h("input", { onInput: on, onChange: on }));
    const input = child(container);
    userSets(input, "value", "ab");
    fire(input, new Ev("input"));
    expect(log).toEqual(["input ab", "change ab"]);
  });

  test("a value a script set is no change: its input event fires onInput only", () => {
    const log: string[] = [];
    render(h("input", { onInput: () => log.push("input"), onChange: () => log.push("change") }));
    const input = child(container) as Field;
    input.value = "set by code";
    fire(input, new Ev("input"));
    expect(log).toEqual(["input"]);
  });

  test("a second input event with no new change fires no second onChange", () => {
    const log: string[] = [];
    render(h("textarea", { onChange: (e: { target: Field }) => log.push(e.target.value) }));
    const area = child(container);
    userSets(area, "value", "x");
    fire(area, new Ev("input"));
    fire(area, new Ev("input"));
    // A text field's native change event adds nothing: the input event already took the change.
    fire(area, new Ev("change"));
    expect(log).toEqual(["x"]);
  });

  test("onChangeCapture sees the change without taking it from onChange", () => {
    const log: string[] = [];
    render(h("input", { onChangeCapture: () => log.push("capture"), onChange: () => log.push("bubble") }));
    const input = child(container);
    userSets(input, "value", "a");
    fire(input, new Ev("input"));
    expect(log).toEqual(["capture", "bubble"]);
  });

  test("a checkbox's onChange follows clicks that change it, after onClick", () => {
    const log: string[] = [];
    const on = (e: { type: string; target: Field }) => log.push(`${e.type} ${e.target.checked}`);
    render(h("input", { type: "checkbox", onClick: on, onChange: on }));
    const box = child(container);
    userSets(box, "checked", true); // a click toggles the box before its listeners run
    fire(box, new Ev("click"));
    fire(box, new Ev("click")); // a click that left it as it was
    fire(box, new Ev("change")); // the native change event is not what onChange follows here
    expect(log).toEqual(["click true", "change true", "click true"]);
  });

  test("a radio's onChange follows clicks, with no onClick needed", () => {
    const log: string[] = [];
    render(h("input", { type: "radio", onChange: (e: { type: string }) => log.push(e.type) }));
    const radio = child(container);
    userSets(radio, "checked", true);
    fire(radio, new Ev("click"));
    expect(log).toEqual(["change"]);
  });

  test("a select's and a file input's onChange follow the change event; their input event is onInput's", () => {
    const log: string[] = [];
    const on = (e: { type: string; target: El }) => log.push(`${e.target.tagName} ${e.type}`);
    render(h("div", null, h("select", { onChange: on, onInput: on }), h("input", { type: "file", onChange: on })));
    const div = child(container);
    fire(child(div, 0), new Ev("input"));
    fire(child(div, 0), new Ev("change"));
    fire(child(div, 1), new Ev("change"));
    expect(log).toEqual(["SELECT input", "SELECT change", "INPUT change"]);
  });

  test("a controlled text input shows its value prop again when onChange does not update it", () => {
    render(h("input", { value: "a", onChange: () => {} }));
    const input = child(container) as Field;
    userSets(input, "value", "ab");
    fire(input, new Ev("input"));
    expect(input.value).toBe("a");
  });

  test("a controlled text input whose onChange sets its state keeps the typed value, rendered at once", () => {
    const seen: string[] = [];
    function Text() {
      const [v, setV] = useState("a");
      seen.push(v);
      return h("input", { value: v, onChange: (e: { target: Field }) => setV(e.target.value) });
    }
    render(h(Text));
    const input = child(container) as Field;
    userSets(input, "value", "ab");
    fire(input, new Ev("input"));
    expect(seen).toEqual(["a", "ab"]);
    expect(input.value).toBe("ab");
  });

  test("a controlled checkbox reverts a click unless onChange updates it", () => {
    render(h("input", { type: "checkbox", checked: false, onChange: () => {} }));
    const box = child(container) as Field;
    userSets(box, "checked", true);
    fire(box, new Ev("click"));
    expect(box.checked).toBe(false);
  });

  // React fires onChangeCapture from the bubble phase, with onChange (one two-phase list after
  // the other plugins' bubble handlers), not in the capture phase.
  test("onChangeCapture runs after onInput's bubble handlers, as in React", () => {
    const log: string[] = [];
    render(h("input", { onInput: () => log.push("input"), onChangeCapture: () => log.push("change capture") }));
    const input = child(container);
    userSets(input, "value", "a");
    fire(input, new Ev("input"));
    expect(log).toEqual(["input", "change capture"]);
  });

  // React fires onChange only for form fields and custom elements (ChangeEventPlugin).
  test("a change event on an element that is not a form field fires no onChange", () => {
    const log: string[] = [];
    render(h("div", { onChange: () => log.push("change") }));
    fire(child(container), new Ev("change"));
    expect(log).toEqual([]);
  });

  test("a change event on a text field fires onChange when its value moved", () => {
    const log: string[] = [];
    render(h("input", { onChange: () => log.push("change") }));
    const input = child(container);
    userSets(input, "value", "a");
    fire(input, new Ev("change"));
    fire(input, new Ev("change"));
    expect(log).toEqual(["change"]);
  });

  test("onChange fires for a custom element's change event, and never for a hidden input", () => {
    const log: string[] = [];
    render(
      h(
        "div",
        null,
        h("my-field", { onChange: () => log.push("custom") }),
        h("input", { type: "hidden", onChange: () => log.push("hidden") }),
      ),
    );
    const hidden = child(child(container), 1);
    userSets(hidden, "value", "a");
    fire(child(child(container)), new Ev("change"));
    fire(hidden, new Ev("input"));
    fire(hidden, new Ev("change"));
    expect(log).toEqual(["custom"]);
  });
});

describe("portals and nested roots", () => {
  test("an event in a portal bubbles through the React tree once, though two of the root's elements listen", () => {
    const log: string[] = [];
    const app = (portal: boolean) =>
      h(
        "div",
        { onClick: () => log.push("div") },
        h("section", { onClick: () => log.push("section") }),
        portal ? createPortal(h("button", { onClick: () => log.push("button") }), section) : null,
      );
    render(app(false));
    const section = child(child(container)) as unknown as Element;
    render(app(true));
    fire(child(section as unknown as FakeNode), new Ev("click"));
    // The section holds the button in the DOM, but is not its ancestor in the React tree.
    expect(log).toEqual(["button", "div"]);
  });

  test("an event in a root inside another root's element reaches both roots' handlers, inner first", () => {
    const log: string[] = [];
    render(h("div", { onClick: () => log.push("outer") }));
    const inner = new El("DIV");
    child(container).appendChild(inner);
    const nested = createRoot(inner as unknown as Element);
    flushSync(() => nested.render(h("button", { onClick: () => log.push("inner") })));
    fire(child(inner), new Ev("click"));
    expect(log).toEqual(["inner", "outer"]);
  });
});

describe("unmounting", () => {
  test("an unmounted root removes every listener it added to its container", () => {
    const log: string[] = [];
    render(h("button", { onClickCapture: () => log.push("capture"), onClick: () => log.push("bubble") }));
    expect(container.handlers.some((l) => l.capture)).toBe(true);
    const button = child(container);
    root.unmount();
    expect(container.handlers).toEqual([]);
    container.appendChild(button);
    fire(button, new Ev("click"));
    expect(log).toEqual([]);
  });
});

describe("events that do not bubble", () => {
  test("onScroll runs for its own element's scroll only, with that element as currentTarget", () => {
    const log: string[] = [];
    const on = (e: { type: string; currentTarget: El }) => log.push(`${e.type} ${e.currentTarget.tagName}`);
    render(h("div", { onScroll: on }, h("ul", { onScroll: on })));
    const div = child(container);
    fire(child(div), new Ev("scroll", { bubbles: false }));
    fire(div, new Ev("scroll", { bubbles: false }));
    expect(log).toEqual(["scroll UL", "scroll DIV"]);
  });

  test("a new handler after a render takes the old one's place on the same listener", () => {
    const log: string[] = [];
    render(h("div", { onScroll: () => log.push("first") }));
    render(h("div", { onScroll: () => log.push("second") }));
    const div = child(container);
    expect(div.handlers.filter((l) => l.type === "scroll")).toHaveLength(1);
    fire(div, new Ev("scroll", { bubbles: false }));
    expect(log).toEqual(["second"]);
  });

  test("an element's handler is not called once the element is removed, nor once its prop is", () => {
    const log: string[] = [];
    render(h("p", null, h("img", { onLoad: () => log.push("load") }), h("video", { onPlay: () => log.push("play") })));
    const [img, video] = child(container).childNodes as El[];
    render(h("p", null, h("video", { onPlay: null })));
    fire(img!, new Ev("load", { bubbles: false }));
    fire(video!, new Ev("play", { bubbles: false }));
    expect(log).toEqual([]);
  });

  test("updates a handler makes render after it", async () => {
    function Scroller() {
      const [n, setN] = useState(0);
      return h("div", { onScroll: () => setN(n + 1) }, n);
    }
    render(h(Scroller));
    const div = child(container);
    fire(div, new Ev("scroll", { bubbles: false }));
    expect(div.textContent).toBe("0");
    await Promise.resolve();
    expect(div.textContent).toBe("1");
  });

  // React walks the fiber path for these (only scroll and scrollend stay on the target), so a
  // <div onLoad> runs for an <img> inside it.
  test("onLoad on an ancestor runs for a descendant's load, as in React", () => {
    const log: string[] = [];
    render(h("div", { onLoad: () => log.push("div") }, h("img", { onLoad: () => log.push("img") })));
    fire(child(child(container)), new Ev("load", { bubbles: false }));
    expect(log).toEqual(["img", "div"]);
  });
  // React's root listens to every non-delegated event in the capture phase.
  test("onLoadCapture runs in the capture phase, outermost first, as in React", () => {
    const log: string[] = [];
    render(h("div", { onLoadCapture: () => log.push("div") }, h("img", { onLoadCapture: () => log.push("img") })));
    fire(child(child(container)), new Ev("load", { bubbles: false }));
    expect(log).toEqual(["div", "img"]);
  });

  // React listens for load and error on every <img> it creates, whatever its props, but not on a
  // <span>.
  test("onLoad on an ancestor runs for an img with no onLoad of its own, and not for a span", () => {
    const log: string[] = [];
    render(h("div", { onLoad: () => log.push("div") }, h("img"), h("span")));
    const div = child(container);
    fire(child(div), new Ev("load", { bubbles: false }));
    fire(child(div, 1), new Ev("load", { bubbles: false }));
    fire(child(div), new Ev("load", { bubbles: false }));
    expect(log).toEqual(["div", "div"]);
  });
});

describe("enter and leave", () => {
  // <div> holding <p><b/></p> and <i/>, each logging its enter and leave events.
  function hover(log: string[], kind: "Mouse" | "Pointer" = "Mouse"): void {
    const on = (name: string) => (e: { type: string }) => log.push(`${e.type} ${name}`);
    const props = (name: string) => ({ [`on${kind}Enter`]: on(name), [`on${kind}Leave`]: on(name) });
    render(h("div", props("div"), h("p", props("p"), h("b", props("b"), "x")), h("i", props("i"))));
  }

  test("moving in, across and out: onMouseEnter outermost first, onMouseLeave innermost first", () => {
    const log: string[] = [];
    hover(log);
    const div = child(container),
      b = child(child(div)),
      i = child(div, 1);
    fire(b, new Ev("mouseover", { relatedTarget: null }));
    log.push("|");
    fire(b, new Ev("mouseout", { relatedTarget: i }));
    fire(i, new Ev("mouseover", { relatedTarget: b }));
    log.push("|");
    fire(i, new Ev("mouseout", { relatedTarget: null }));
    expect(log).toEqual([
      "mouseenter div",
      "mouseenter p",
      "mouseenter b",
      "|",
      "mouseleave b",
      "mouseleave p",
      "mouseenter i",
      "|",
      "mouseleave i",
      "mouseleave div",
    ]);
  });

  test("leave targets the element left and enter the one entered, each with the other as relatedTarget", () => {
    const seen: string[] = [];
    const tag = (n: unknown): string => (n as El).tagName;
    const on = (e: { type: string; target: unknown; relatedTarget: unknown; currentTarget: unknown }) =>
      seen.push(`${e.type} ${tag(e.currentTarget)}: ${tag(e.target)} from/to ${tag(e.relatedTarget)}`);
    render(h("div", null, h("b", { onMouseLeave: on }), h("i", { onMouseEnter: on })));
    const div = child(container);
    fire(child(div, 0), new Ev("mouseout", { relatedTarget: child(div, 1) }));
    expect(seen).toEqual(["mouseleave B: B from/to I", "mouseenter I: I from/to B"]);
  });

  test("pointer over and out events give onPointerEnter and onPointerLeave", () => {
    const log: string[] = [];
    hover(log, "Pointer");
    const div = child(container),
      i = child(div, 1);
    fire(i, new Ev("pointerover", { relatedTarget: null }));
    fire(i, new Ev("pointerout", { relatedTarget: div }));
    expect(log).toEqual(["pointerenter div", "pointerenter i", "pointerleave i"]);
  });

  test("an over event from inside the root, or a move within one element, fires nothing", () => {
    const log: string[] = [];
    hover(log);
    const div = child(container),
      b = child(child(div));
    fire(div, new Ev("mouseover", { relatedTarget: b }));
    fire(b.firstChild!, new Ev("mouseout", { relatedTarget: b }));
    expect(log).toEqual([]);
  });

  // React gives the end outside React's tree as the window.
  test("an enter or leave event's relatedTarget is the window when the pointer comes from outside", () => {
    const seen: unknown[] = [];
    const on = (e: { relatedTarget: unknown }) => seen.push(e.relatedTarget);
    render(h("b", { onMouseEnter: on, onMouseLeave: on }));
    const b = child(container);
    // React's window is the target's document's defaultView.
    const doc = b.ownerDocument as { defaultView?: unknown };
    const had = "defaultView" in doc,
      old = doc.defaultView,
      win = {};
    doc.defaultView = win;
    try {
      fire(b, new Ev("mouseover", { relatedTarget: null }));
      fire(b, new Ev("mouseout", { relatedTarget: null }));
      expect(seen).toEqual([win, win]);
    } finally {
      if (had) doc.defaultView = old;
      else delete doc.defaultView;
    }
  });
});

describe("synthetic events", () => {
  test("preventDefault reaches the native event, and isDefaultPrevented and defaultPrevented say so", () => {
    const seen: unknown[] = [];
    render(
      h("a", {
        onClick: (e: { preventDefault(): void; isDefaultPrevented(): boolean; defaultPrevented: boolean }) => {
          seen.push(e.isDefaultPrevented(), e.defaultPrevented);
          e.preventDefault();
          seen.push(e.isDefaultPrevented(), e.defaultPrevented);
        },
      }),
    );
    const native = fire(child(container), new Ev("click", { cancelable: true }));
    expect(seen).toEqual([false, false, true, true]);
    expect(native.defaultPrevented).toBe(true);
  });

  test("stopPropagation stops the handlers above and the native event", () => {
    const log: unknown[] = [];
    render(
      h(
        "div",
        { onClick: () => log.push("div") },
        h("button", {
          onClick: (e: { stopPropagation(): void; isPropagationStopped(): boolean }) => {
            log.push(e.isPropagationStopped());
            e.stopPropagation();
            log.push(e.isPropagationStopped());
          },
        }),
      ),
    );
    const native = fire(child(child(container)), new Ev("click"));
    expect(log).toEqual([false, true]);
    expect(native.cancelBubble).toBe(true);
  });

  test("stopping a checkbox's click leaves its onChange, which has its own event", () => {
    const log: string[] = [];
    render(
      h(
        "label",
        { onChange: () => log.push("label change") },
        h("input", {
          type: "checkbox",
          onClick: (e: { stopPropagation(): void }) => (log.push("click"), e.stopPropagation()),
          onChange: () => log.push("change"),
        }),
      ),
    );
    const box = child(child(container));
    userSets(box, "checked", true);
    fire(box, new Ev("click"));
    expect(log).toEqual(["click", "change", "label change"]);
  });

  test("persist does nothing and isPersistent is true: events are not pooled", () => {
    let kept: { persist(): void; isPersistent(): boolean; type: string } | undefined;
    render(h("button", { onClick: (e: typeof kept) => (kept = e) }));
    fire(child(container), new Ev("click"));
    kept!.persist();
    expect(kept!.isPersistent()).toBe(true);
    expect(kept!.type).toBe("click");
  });

  test("native fields are read through, and native methods come bound to the native event", () => {
    const seen: unknown[] = [];
    render(
      h("button", {
        onClick: (e: {
          target: unknown;
          nativeEvent: unknown;
          bubbles: boolean;
          getModifierState(k: string): boolean;
        }) => seen.push(e.target, e.nativeEvent, e.bubbles, e.getModifierState("Shift"), e.getModifierState("Alt")),
      }),
    );
    const button = child(container);
    const native = fire(button, new Ev("click"));
    expect(seen).toEqual([button, native, true, true, false]);
  });

  test("a field a handler sets is the synthetic event's own, and the native event keeps its value", () => {
    const seen: unknown[] = [];
    const other = new FakeText("elsewhere");
    render(
      h(
        "div",
        { onClick: (e: { target: unknown }) => seen.push(e.target) },
        h("button", { onClick: (e: { target: unknown }) => (e.target = other) }),
      ),
    );
    const button = child(child(container));
    const native = fire(button, new Ev("click"));
    expect(seen).toEqual([other]);
    expect(native.target).toBe(button);
  });

  // React's isDefaultPrevented() is true after preventDefault() even when the native event is not
  // cancelable (an input event, say).
  test("isDefaultPrevented is true after preventDefault on an event that cannot be canceled", () => {
    const seen: boolean[] = [];
    render(
      h("input", {
        onInput: (e: { preventDefault(): void; isDefaultPrevented(): boolean }) => {
          e.preventDefault();
          seen.push(e.isDefaultPrevented());
        },
      }),
    );
    fire(child(container), new Ev("input", { cancelable: false }));
    expect(seen).toEqual([true]);
  });
});

describe("resource hints", () => {
  // A document with a <head>: elements reflect rel, href, src, type, crossOrigin and async to
  // attributes, as the DOM's do, and querySelector matches the `tag[attr="value"]` selectors the
  // hints use, with React's escapes (a hex code and a space) in the values. CSS.escape, which Bun
  // lacks, is stubbed: it escapes every non-word character.
  let head: FakeElement;
  let hadCSS: boolean;
  let css: unknown;
  const g = globalThis as unknown as { CSS?: unknown; document?: unknown };

  /** Every element below `from` matching one of the comma-separated `tag[attr]` selectors. */
  function selectAll(from: FakeNode, sel: string, out: FakeElement[] = []): FakeElement[] {
    const parts = sel.split(",").map((one) => {
      const m = /^([a-z]+)(.*)$/.exec(one)!;
      const attrs = [...m[2]!.matchAll(/\[([a-z-]+)(?:="((?:[^"\\]|\\.)*)")?\]/g)].map(
        (a) =>
          [
            a[1]!,
            a[2]?.replace(/\\([0-9a-f]{1,6}) ?|\\(.)/g, (_, hex, ch) =>
              hex ? String.fromCharCode(parseInt(hex, 16)) : ch,
            ),
          ] as const,
      );
      return { tag: m[1]!.toUpperCase(), attrs };
    });
    for (let c = from.firstChild; c !== null; c = c.nextSibling) {
      if (!(c instanceof FakeElement)) continue;
      const el = c;
      if (
        parts.some(
          (p) =>
            el.tagName === p.tag &&
            p.attrs.every(([k, v]) => (v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === v)),
        )
      )
        out.push(el);
      selectAll(el, sel, out);
    }
    return out;
  }
  const select = (from: FakeNode, sel: string): FakeElement | null => selectAll(from, sel)[0] ?? null;

  beforeEach(() => {
    const reflect = (attr: string): PropertyDescriptor => ({
      get(this: FakeElement) {
        return this.getAttribute(attr);
      },
      set(this: FakeElement, v: unknown) {
        this.setAttribute(attr, String(v));
      },
    });
    class Html extends FakeElement {
      querySelector(sel: string): FakeElement | null {
        return select(this, sel);
      }
    }
    Object.defineProperties(Html.prototype, {
      rel: reflect("rel"),
      href: reflect("href"),
      src: reflect("src"),
      type: reflect("type"),
      crossOrigin: reflect("crossorigin"),
      async: {
        set(this: FakeElement, v: boolean) {
          if (v) this.setAttribute("async", "");
          else this.removeAttribute("async");
        },
      },
    });
    const html = new Html("HTML");
    head = new Html("HEAD");
    html.appendChild(head);
    g.document = {
      head,
      createElement: (tag: string) => new Html(tag.toUpperCase()),
      querySelector: (sel: string) => select(html, sel),
      querySelectorAll: (sel: string) => selectAll(html, sel),
      nodeType: 9,
    };
    hadCSS = "CSS" in globalThis;
    css = g.CSS;
    g.CSS = { escape: (s: string) => s.replace(/[^\w-]/g, (ch) => "\\" + ch) };
  });
  afterEach(() => {
    if (hadCSS) g.CSS = css;
    else delete g.CSS;
  });

  /** <head>'s elements, each with its attributes sorted by name (lower case, as HTML's are). */
  const tags = (): string[] =>
    head.childNodes.map((n) => {
      const el = n as FakeElement;
      const attrs = el.attributes.map((a) => `${a.name.toLowerCase()}=${a.value}`).sort();
      return [el.tagName.toLowerCase(), ...attrs].join(" ");
    });

  test("prefetchDNS adds one dns-prefetch link per URL", () => {
    prefetchDNS("https://cdn.test/");
    prefetchDNS("https://cdn.test/");
    prefetchDNS("");
    expect(tags()).toEqual(["link href=https://cdn.test/ rel=dns-prefetch"]);
  });

  test("preconnect adds a preconnect link once, with crossorigin as React normalizes it", () => {
    preconnect("https://a.test");
    preconnect("https://a.test");
    preconnect("https://b.test", { crossOrigin: "use-credentials" });
    preconnect("https://c.test", { crossOrigin: "anonymous" });
    preconnect("https://d.test", {});
    expect(tags()).toEqual([
      "link href=https://a.test rel=preconnect",
      "link crossorigin=use-credentials href=https://b.test rel=preconnect",
      "link crossorigin= href=https://c.test rel=preconnect",
      "link href=https://d.test rel=preconnect",
    ]);
  });

  test("preload adds a preload link once, with its as, crossorigin, type and fetchpriority", () => {
    const opts = { as: "font", crossOrigin: "anonymous", type: "font/woff2", fetchPriority: "high" };
    preload("/f.woff2", opts);
    preload("/f.woff2", opts);
    preload("/hero.png", { as: "image" });
    expect(tags()).toEqual([
      "link as=font crossorigin= fetchpriority=high href=/f.woff2 rel=preload type=font/woff2",
      "link as=image href=/hero.png rel=preload",
    ]);
  });

  test("preloadModule adds a modulepreload link once, with as only when given", () => {
    preloadModule("/m.js");
    preloadModule("/m.js");
    preloadModule("/w.js", { as: "worker" });
    expect(tags()).toEqual(["link href=/m.js rel=modulepreload", "link as=worker href=/w.js rel=modulepreload"]);
  });

  test("preinit loads a stylesheet with a link, and a script with an async script, once each", () => {
    preinit("/s.css", { as: "style" });
    preinit("/s.css", { as: "style" });
    preinit("/a.js", { as: "script" });
    preinit("/a.js", { as: "script" });
    const link = head.firstChild as FakeElement;
    expect(head.childNodes).toHaveLength(2);
    expect([link.tagName, link.getAttribute("rel"), link.getAttribute("href")]).toEqual([
      "LINK",
      "stylesheet",
      "/s.css",
    ]);
    expect(tags()[1]).toBe("script async= src=/a.js");
  });

  test("preinitModule loads a module script once", () => {
    preinitModule("/m.js");
    preinitModule("/m.js");
    expect(head.childNodes).toHaveLength(1);
    const s = head.firstChild as FakeElement;
    expect([s.tagName, s.getAttribute("type"), s.getAttribute("src")]).toEqual(["SCRIPT", "module", "/m.js"]);
  });

  test("the link hints do nothing without a document, as on a server", () => {
    const doc = g.document;
    delete g.document;
    try {
      preconnect("https://a.test");
      prefetchDNS("https://a.test");
      preload("/f.woff2", { as: "font" });
      preloadModule("/m.js");
      preinit("/s.css", { as: "style" });
    } finally {
      g.document = doc;
    }
    expect(tags()).toEqual([]);
  });

  // React's rules, from its dispatcher (react-dom-client's preconnectAs, preload, preinitStyle,
  // preinitScript and preinitModuleScript):
  // - preconnect keys on crossOrigin too: the same URL with and without it gets two links.
  test("preconnect adds a second link for the same URL with another crossOrigin", () => {
    preconnect("https://a.test");
    preconnect("https://a.test", { crossOrigin: "anonymous" });
    expect(head.childNodes).toHaveLength(2);
  });
  // - preinit of a stylesheet sets data-precedence ("default" when not given).
  test("preinit marks a stylesheet with data-precedence", () => {
    preinit("/s.css", { as: "style" });
    expect((head.firstChild as FakeElement).getAttribute("data-precedence")).toBe("default");
  });
  // - preinitModule's script is async, as React's is.
  test("preinitModule's script is async", () => {
    preinitModule("/m.js");
    expect((head.firstChild as FakeElement).getAttribute("async")).toBe("");
  });
  // - preload without `as` does nothing; a font preload is always crossorigin; integrity, nonce,
  //   referrerPolicy, imageSrcSet, imageSizes and media reach the link.
  test("preload follows React's rules for as, fonts and its other options", () => {
    preload("/no-as.js", {});
    preload("/f.woff2", { as: "font", integrity: "sha384-x", media: "print" });
    expect(tags()).toEqual(["link as=font crossorigin= href=/f.woff2 integrity=sha384-x media=print rel=preload"]);
  });
  // - a stylesheet goes after the last one of its precedence, or after all of them.
  test("preinit places a stylesheet after the last one of its precedence", () => {
    preinit("/a.css", { as: "style", precedence: "low" });
    preinit("/b.css", { as: "style", precedence: "high" });
    preinit("/c.css", { as: "style", precedence: "low" });
    preinit("/d.css", { as: "style" });
    expect(head.childNodes.map((n) => (n as FakeElement).getAttribute("href"))).toEqual([
      "/a.css",
      "/c.css",
      "/b.css",
      "/d.css",
    ]);
  });
  // - a stylesheet or script takes crossOrigin, referrerPolicy (and a script integrity) from its
  //   preload when it has none of its own.
  test("preinit takes crossOrigin and referrerPolicy from an earlier preload", () => {
    preload("/p.css", { as: "style", crossOrigin: "use-credentials", referrerPolicy: "no-referrer" });
    preinit("/p.css", { as: "style" });
    preload("/p.js", { as: "script", integrity: "sha384-y" });
    preinit("/p.js", { as: "script" });
    // The stylesheet goes first in <head>, before the preloads, as no other stylesheet is there.
    expect(tags().filter((t) => !t.includes("rel=preload"))).toEqual([
      "link crossorigin=use-credentials data-precedence=default href=/p.css referrerpolicy=no-referrer rel=stylesheet",
      "script async= integrity=sha384-y src=/p.js",
    ]);
  });
  // - preinit without `as: "style"` or `as: "script"` does nothing, and preinit of a script and
  //   preinitModule do nothing without a document (compat throws a ReferenceError).
  test("preinit and preinitModule do nothing without a known as or without a document", () => {
    preinit("/x.css");
    expect(head.childNodes).toHaveLength(0);
    const doc = g.document;
    delete g.document;
    try {
      expect(() => preinit("/a.js", { as: "script" })).not.toThrow();
      expect(() => preinitModule("/m.js")).not.toThrow();
    } finally {
      g.document = doc;
    }
  });
});

describe("default export", () => {
  test("one object serves import React from react and import ReactDOM from react-dom", () => {
    const R = React as Record<string, unknown>;
    expect(R["useState"]).toBe(useState);
    expect(R["createRoot"]).toBe(createRoot);
    expect(R["createPortal"]).toBe(createPortal);
    expect(R["preconnect"]).toBe(preconnect);
    expect(R["preinitModule"]).toBe(preinitModule);
    // react-dom's old name for useActionState.
    expect(R["useFormState"]).toBe(useActionState);
    expect(R["version"]).toMatch(/^19\./);
    expect(R["__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"]).toBe(internals);
    expect(typeof internals.H.useMemoCache).toBe("function");
  });
});
