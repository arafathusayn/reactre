// @reactre/preact/dom: the DOM-only build, for a page that needs templates and events and no
// components. It is reactre's DOM layer (@reactre/dom): a template parsed once per call site and
// cloned with its values, typed holes for text, classes, attributes, properties and events, a
// keyed list that moves the fewest nodes, and morph. No vnodes, no diff, no Preact runtime.
//
//   import { html, on, text } from "@reactre/preact/dom";
//   const Counter = html`<button onclick=${on<"click">()}>Clicked ${text<number>()} times</button>`;

export * from "@reactre/dom";
