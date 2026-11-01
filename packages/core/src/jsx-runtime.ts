// @reactre/core/jsx-runtime: the types of reactre's TSX, found through `jsxImportSource`.
//
//   // tsconfig.json
//   { "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@reactre/core" } }
//
// TypeScript reads the JSX namespace below for every element: the host elements' attributes and
// events, what a child may be, and which components a tag may name (`<For>` and any function).
// @reactre/plugin compiles reactre's TSX with this import source too, and leaves no call to a JSX
// runtime behind, so the functions here only throw: one is called only when a TSX file reached the
// bundle without the compiler.
//
// The types follow what @reactre/compiler compiles, so code that type-checks compiles:
//
//   - An attribute's value is written as it is: a string, a number, a boolean (true sets the
//     attribute empty, false leaves it out) or nothing. A function is not a value: a hole that
//     calls one (`{count()}`) updates, and a function itself (`{count}`) would be written once,
//     as text, so it is a type error.
//   - `class` (or `className`) takes a string, or a class list written in place: an object
//     literal whose keys are classes, each set while its value is truthy (`{ active: on() }`),
//     or an array literal of class names, objects and nested arrays, falsy items left out. A
//     list held in a variable is put inside an array literal (`class={[classes]}`): the compiler
//     takes lists apart by their syntax, and a bare expression is a string to it. `style` takes
//     a string of CSS, or an object of properties (camelCase or CSS names, custom properties
//     too). A number gets no unit.
//   - `on` + the event's name (`onClick`, `onKeyDown`, `onPointerMove`) takes a handler for that
//     event. The compiler lowercases the name, so the handler of `onDblClick` gets "dblclick".
//     Inside a `<For>` row the handler is delegated to the list's parent, so neither `this` nor
//     `currentTarget` is the element: the handler's only argument is the event.
//   - `ref` takes a function, called with the element, or an object whose `current` gets it, or
//     an array literal of those, each given the element. A directive is a function that returns
//     the ref: `ref={tooltip("Save")}`.
//   - `defaultValue`, `defaultChecked`, `defaultSelected` and `defaultMuted` set the property
//     of their name: the initial value a form's reset goes back to, which the user's edits leave.
//   - `key` on an element outside `<For>` rebuilds the element when its value changes.
//   - A child is a node (an element, `<For>`, a component's result), text, a number, nothing, or
//     an array of those. Void elements (`<input>`, `<img>`, ...) take no children.
//   - SVG elements have their own attributes and events. A tag both HTML and SVG name (`a`,
//     `script`, `style`, `title`) has HTML's.
//   - `<For>` (declared in ./index.ts) takes a `fallback`, shown while `each` is empty. The other
//     control flow elements are declared in ./flow.ts.

// #region Values

/** An attribute's value: written as text, true sets it empty, false, null and undefined leave it out. */
type Attr = string | number | bigint | boolean | null | undefined;

/** A boolean attribute's value. */
type Bool = boolean | null | undefined;

/** A class object's value: the key is a class while it is truthy. */
type ClassFlag = string | number | bigint | boolean | null | undefined;

/** A class object: each key is a class (or several, space-separated), set while its value is truthy. */
export type ClassObject = { readonly [className: string]: ClassFlag };

/** An item of a class array: class names, a class object, a nested array, or nothing (left out). */
export type ClassItem = string | number | bigint | boolean | null | undefined | ClassObject | readonly ClassItem[];

/** `class`'s value: the class list as one string, or written in place as an object or an array. */
type ClassValue = string | ClassObject | readonly ClassItem[] | null | undefined;

/** A style property's value. Written as given: a number gets no unit; null, undefined and false remove it. */
type StyleValue = string | number | false | null | undefined;

/** A style object's properties: CSSStyleDeclaration's camelCase names, CSS names, custom properties. */
type StyleObject = {
  [K in keyof CSSStyleDeclaration as CSSStyleDeclaration[K] extends string ? K : never]?: StyleValue;
} & { [css: `${string}-${string}`]: StyleValue };

/** An element's `style`. */
type Style = string | StyleObject | null | undefined;

/** A host element's `key` outside `<For>`: the element is rebuilt when it changes. */
type Key = string | number | bigint | null | undefined;

/** An element's `ref`: a function called with it, or an object given it as `current`. */
export type Ref<E> = ((element: E) => void) | { current: E | null } | null | undefined;

/** What `ref` takes: one ref, or an array literal of refs, each given the element. */
type Refs<E> = Ref<E> | readonly Ref<E>[];

/** A child of a host element: a node, text, nothing, or an array of children. */
export type Child = Node | string | number | bigint | boolean | null | undefined | readonly Child[];

// #endregion

// #region Events

/** React's names for the events whose name is several words: "dblclick" is `onDblClick`. */
interface CamelCase {
  animationcancel: "AnimationCancel";
  animationend: "AnimationEnd";
  animationiteration: "AnimationIteration";
  animationstart: "AnimationStart";
  auxclick: "AuxClick";
  beforeinput: "BeforeInput";
  beforematch: "BeforeMatch";
  beforetoggle: "BeforeToggle";
  canplay: "CanPlay";
  canplaythrough: "CanPlayThrough";
  compositionend: "CompositionEnd";
  compositionstart: "CompositionStart";
  compositionupdate: "CompositionUpdate";
  contextlost: "ContextLost";
  contextmenu: "ContextMenu";
  contextrestored: "ContextRestored";
  cuechange: "CueChange";
  dblclick: "DblClick";
  dragend: "DragEnd";
  dragenter: "DragEnter";
  dragexit: "DragExit";
  dragleave: "DragLeave";
  dragover: "DragOver";
  dragstart: "DragStart";
  durationchange: "DurationChange";
  focusin: "FocusIn";
  focusout: "FocusOut";
  formdata: "FormData";
  fullscreenchange: "FullscreenChange";
  fullscreenerror: "FullscreenError";
  gotpointercapture: "GotPointerCapture";
  keydown: "KeyDown";
  keypress: "KeyPress";
  keyup: "KeyUp";
  loadeddata: "LoadedData";
  loadedmetadata: "LoadedMetadata";
  loadend: "LoadEnd";
  loadstart: "LoadStart";
  lostpointercapture: "LostPointerCapture";
  mousedown: "MouseDown";
  mouseenter: "MouseEnter";
  mouseleave: "MouseLeave";
  mousemove: "MouseMove";
  mouseout: "MouseOut";
  mouseover: "MouseOver";
  mouseup: "MouseUp";
  pointercancel: "PointerCancel";
  pointerdown: "PointerDown";
  pointerenter: "PointerEnter";
  pointerleave: "PointerLeave";
  pointermove: "PointerMove";
  pointerout: "PointerOut";
  pointerover: "PointerOver";
  pointerrawupdate: "PointerRawUpdate";
  pointerup: "PointerUp";
  ratechange: "RateChange";
  scrollend: "ScrollEnd";
  securitypolicyviolation: "SecurityPolicyViolation";
  selectionchange: "SelectionChange";
  selectstart: "SelectStart";
  slotchange: "SlotChange";
  timeupdate: "TimeUpdate";
  touchcancel: "TouchCancel";
  touchend: "TouchEnd";
  touchmove: "TouchMove";
  touchstart: "TouchStart";
  transitioncancel: "TransitionCancel";
  transitionend: "TransitionEnd";
  transitionrun: "TransitionRun";
  transitionstart: "TransitionStart";
  volumechange: "VolumeChange";
}

/** The part of an event's handler name after `on`: "click" is `Click`, "keydown" is `KeyDown`. */
type HandlerName<K extends string> = K extends keyof CamelCase ? CamelCase[K] : Capitalize<K>;

/**
 * The `on*` attributes for the events of map M: `onClick` takes `(event: MouseEvent) => void`.
 * The prefixed WebKit names are left out.
 */
export type EventHandlers<M> = {
  [K in keyof M & string as K extends `webkit${string}` ? never : `on${HandlerName<K>}`]?: (event: M[K]) => void;
};

// #endregion

// #region HTML

/** The attributes every HTML element has. */
export interface HTMLAttributes extends EventHandlers<HTMLElementEventMap> {
  /** The element's content: nodes, text, nothing, or arrays of them. */
  children?: Child;
  [data: `data-${string}`]: Attr;
  [aria: `aria-${string}`]: Attr;
  accesskey?: Attr;
  autocapitalize?: Attr;
  autocorrect?: Attr;
  autofocus?: Bool;
  /** The element's classes: one string, or a class object or array written in place. */
  class?: ClassValue;
  /** `class`, by React's name. */
  className?: ClassValue;
  contenteditable?: Attr;
  dir?: Attr;
  draggable?: Attr;
  enterkeyhint?: Attr;
  exportparts?: Attr;
  hidden?: Attr;
  id?: Attr;
  inert?: Bool;
  inputmode?: Attr;
  is?: Attr;
  itemid?: Attr;
  itemprop?: Attr;
  itemref?: Attr;
  itemscope?: Bool;
  itemtype?: Attr;
  lang?: Attr;
  nonce?: Attr;
  part?: Attr;
  popover?: Attr;
  role?: Attr;
  slot?: Attr;
  spellcheck?: Attr;
  /** Inline CSS: a string (`style="color: red"`) or an object (`style={{ color: "red" }}`). */
  style?: Style;
  tabindex?: Attr;
  title?: Attr;
  translate?: Attr;
  writingsuggestions?: Attr;
}

/** An element that takes no children: `<input>`, `<img>`, `<br>`, ... */
interface VoidAttributes extends HTMLAttributes {
  children?: never;
}

/** The attributes of the form controls that submit a form. */
interface Submits {
  formaction?: Attr;
  formenctype?: Attr;
  formmethod?: Attr;
  formnovalidate?: Bool;
  formtarget?: Attr;
}

/** The attributes of the elements that open a popover or run a command. */
interface Invokes {
  command?: Attr;
  commandfor?: Attr;
  popovertarget?: Attr;
  popovertargetaction?: Attr;
}

/** `<audio>`'s and `<video>`'s attributes. */
interface MediaAttributes extends HTMLAttributes {
  autoplay?: Bool;
  controls?: Bool;
  controlslist?: Attr;
  crossorigin?: Attr;
  /** The `defaultMuted` property: whether the media starts muted (the `muted` attribute's state). */
  defaultMuted?: Bool;
  disableremoteplayback?: Bool;
  loop?: Bool;
  muted?: Bool;
  preload?: Attr;
  src?: Attr;
}

/** The attributes of the HTML elements that have their own, by tag. */
interface HTMLElementAttributes {
  a: HTMLAttributes & {
    download?: Attr;
    href?: Attr;
    hreflang?: Attr;
    ping?: Attr;
    referrerpolicy?: Attr;
    rel?: Attr;
    target?: Attr;
    type?: Attr;
  };
  area: VoidAttributes & {
    alt?: Attr;
    coords?: Attr;
    download?: Attr;
    href?: Attr;
    ping?: Attr;
    referrerpolicy?: Attr;
    rel?: Attr;
    shape?: Attr;
    target?: Attr;
  };
  audio: MediaAttributes;
  base: VoidAttributes & { href?: Attr; target?: Attr };
  blockquote: HTMLAttributes & { cite?: Attr };
  br: VoidAttributes;
  button: HTMLAttributes & Submits & Invokes & { disabled?: Bool; form?: Attr; name?: Attr; type?: Attr; value?: Attr };
  canvas: HTMLAttributes & { height?: Attr; width?: Attr };
  col: VoidAttributes & { span?: Attr };
  colgroup: HTMLAttributes & { span?: Attr };
  data: HTMLAttributes & { value?: Attr };
  del: HTMLAttributes & { cite?: Attr; datetime?: Attr };
  details: HTMLAttributes & { name?: Attr; open?: Bool };
  dialog: HTMLAttributes & { closedby?: Attr; open?: Bool };
  embed: VoidAttributes & { height?: Attr; src?: Attr; type?: Attr; width?: Attr };
  fieldset: HTMLAttributes & { disabled?: Bool; form?: Attr; name?: Attr };
  form: HTMLAttributes & {
    "accept-charset"?: Attr;
    action?: Attr;
    autocomplete?: Attr;
    enctype?: Attr;
    method?: Attr;
    name?: Attr;
    novalidate?: Bool;
    rel?: Attr;
    target?: Attr;
  };
  hr: VoidAttributes;
  html: HTMLAttributes & { xmlns?: Attr };
  iframe: HTMLAttributes & {
    allow?: Attr;
    allowfullscreen?: Bool;
    height?: Attr;
    loading?: Attr;
    name?: Attr;
    referrerpolicy?: Attr;
    sandbox?: Attr;
    src?: Attr;
    srcdoc?: Attr;
    width?: Attr;
  };
  img: VoidAttributes & {
    alt?: Attr;
    crossorigin?: Attr;
    decoding?: Attr;
    fetchpriority?: Attr;
    height?: Attr;
    ismap?: Bool;
    loading?: Attr;
    referrerpolicy?: Attr;
    sizes?: Attr;
    src?: Attr;
    srcset?: Attr;
    usemap?: Attr;
    width?: Attr;
  };
  input: VoidAttributes &
    Submits &
    Invokes & {
      accept?: Attr;
      alt?: Attr;
      autocomplete?: Attr;
      checked?: Bool;
      /** The `defaultChecked` property: the state a form's reset goes back to. */
      defaultChecked?: Bool;
      /** The `defaultValue` property: the value a form's reset goes back to. */
      defaultValue?: Attr;
      dirname?: Attr;
      disabled?: Bool;
      form?: Attr;
      height?: Attr;
      list?: Attr;
      max?: Attr;
      maxlength?: Attr;
      min?: Attr;
      minlength?: Attr;
      multiple?: Bool;
      name?: Attr;
      pattern?: Attr;
      placeholder?: Attr;
      readonly?: Bool;
      required?: Bool;
      size?: Attr;
      src?: Attr;
      step?: Attr;
      type?: Attr;
      value?: Attr;
      width?: Attr;
    };
  ins: HTMLAttributes & { cite?: Attr; datetime?: Attr };
  label: HTMLAttributes & { for?: Attr; htmlFor?: Attr };
  li: HTMLAttributes & { value?: Attr };
  link: VoidAttributes & {
    as?: Attr;
    blocking?: Attr;
    crossorigin?: Attr;
    disabled?: Bool;
    fetchpriority?: Attr;
    href?: Attr;
    hreflang?: Attr;
    imagesizes?: Attr;
    imagesrcset?: Attr;
    integrity?: Attr;
    media?: Attr;
    referrerpolicy?: Attr;
    rel?: Attr;
    sizes?: Attr;
    type?: Attr;
  };
  map: HTMLAttributes & { name?: Attr };
  meta: VoidAttributes & { charset?: Attr; content?: Attr; "http-equiv"?: Attr; media?: Attr; name?: Attr };
  meter: HTMLAttributes & { high?: Attr; low?: Attr; max?: Attr; min?: Attr; optimum?: Attr; value?: Attr };
  object: HTMLAttributes & { data?: Attr; form?: Attr; height?: Attr; name?: Attr; type?: Attr; width?: Attr };
  ol: HTMLAttributes & { reversed?: Bool; start?: Attr; type?: Attr };
  optgroup: HTMLAttributes & { disabled?: Bool; label?: Attr };
  option: HTMLAttributes & {
    /** The `defaultSelected` property: the selection a form's reset goes back to. */
    defaultSelected?: Bool;
    disabled?: Bool;
    label?: Attr;
    selected?: Bool;
    value?: Attr;
  };
  output: HTMLAttributes & { for?: Attr; form?: Attr; htmlFor?: Attr; name?: Attr };
  progress: HTMLAttributes & { max?: Attr; value?: Attr };
  q: HTMLAttributes & { cite?: Attr };
  script: HTMLAttributes & {
    async?: Bool;
    blocking?: Attr;
    crossorigin?: Attr;
    defer?: Bool;
    fetchpriority?: Attr;
    integrity?: Attr;
    nomodule?: Bool;
    referrerpolicy?: Attr;
    src?: Attr;
    type?: Attr;
  };
  select: HTMLAttributes & {
    autocomplete?: Attr;
    disabled?: Bool;
    form?: Attr;
    multiple?: Bool;
    name?: Attr;
    required?: Bool;
    size?: Attr;
  };
  slot: HTMLAttributes & { name?: Attr };
  source: VoidAttributes & {
    height?: Attr;
    media?: Attr;
    sizes?: Attr;
    src?: Attr;
    srcset?: Attr;
    type?: Attr;
    width?: Attr;
  };
  style: HTMLAttributes & { blocking?: Attr; media?: Attr };
  td: HTMLAttributes & { colspan?: Attr; headers?: Attr; rowspan?: Attr };
  template: HTMLAttributes & {
    shadowrootclonable?: Bool;
    shadowrootdelegatesfocus?: Bool;
    shadowrootmode?: Attr;
    shadowrootserializable?: Bool;
  };
  textarea: HTMLAttributes & {
    autocomplete?: Attr;
    cols?: Attr;
    /** The `defaultValue` property: the text a form's reset goes back to. */
    defaultValue?: Attr;
    dirname?: Attr;
    disabled?: Bool;
    form?: Attr;
    maxlength?: Attr;
    minlength?: Attr;
    name?: Attr;
    placeholder?: Attr;
    readonly?: Bool;
    required?: Bool;
    rows?: Attr;
    wrap?: Attr;
  };
  th: HTMLAttributes & { abbr?: Attr; colspan?: Attr; headers?: Attr; rowspan?: Attr; scope?: Attr };
  time: HTMLAttributes & { datetime?: Attr };
  track: VoidAttributes & { default?: Bool; kind?: Attr; label?: Attr; src?: Attr; srclang?: Attr };
  video: MediaAttributes & { height?: Attr; playsinline?: Bool; poster?: Attr; width?: Attr };
  wbr: VoidAttributes;
}

/** Every HTML element, by tag: its own attributes, or the global ones. */
type HTMLElements = {
  [K in keyof HTMLElementTagNameMap]: (K extends keyof HTMLElementAttributes
    ? HTMLElementAttributes[K]
    : HTMLAttributes) & {
    ref?: Refs<HTMLElementTagNameMap[K]>;
    key?: Key;
  };
};

// #endregion

// #region SVG

/** The attributes of SVG elements: the core and presentation attributes, and the shapes' geometry. */
export interface SVGAttributes extends EventHandlers<SVGElementEventMap> {
  /** The element's content: nodes, text, nothing, or arrays of them. */
  children?: Child;
  [data: `data-${string}`]: Attr;
  [aria: `aria-${string}`]: Attr;
  /** The element's classes: one string, or a class object or array written in place. */
  class?: ClassValue;
  /** `class`, by React's name. */
  className?: ClassValue;
  /** Inline CSS: a string or an object. */
  style?: Style;
  id?: Attr;
  lang?: Attr;
  role?: Attr;
  tabindex?: Attr;
  "xml:lang"?: Attr;
  "xml:space"?: Attr;
  // Geometry and coordinates.
  cx?: Attr;
  cy?: Attr;
  d?: Attr;
  dx?: Attr;
  dy?: Attr;
  fr?: Attr;
  fx?: Attr;
  fy?: Attr;
  height?: Attr;
  pathLength?: Attr;
  points?: Attr;
  r?: Attr;
  rx?: Attr;
  ry?: Attr;
  width?: Attr;
  x?: Attr;
  x1?: Attr;
  x2?: Attr;
  y?: Attr;
  y1?: Attr;
  y2?: Attr;
  // Viewports, links and references.
  href?: Attr;
  preserveAspectRatio?: Attr;
  transform?: Attr;
  version?: Attr;
  viewBox?: Attr;
  xmlns?: Attr;
  "xmlns:xlink"?: Attr;
  "xlink:href"?: Attr;
  // Presentation.
  "alignment-baseline"?: Attr;
  "clip-path"?: Attr;
  "clip-rule"?: Attr;
  color?: Attr;
  cursor?: Attr;
  display?: Attr;
  "dominant-baseline"?: Attr;
  fill?: Attr;
  "fill-opacity"?: Attr;
  "fill-rule"?: Attr;
  filter?: Attr;
  "flood-color"?: Attr;
  "flood-opacity"?: Attr;
  "font-family"?: Attr;
  "font-size"?: Attr;
  "font-style"?: Attr;
  "font-weight"?: Attr;
  "letter-spacing"?: Attr;
  "marker-end"?: Attr;
  "marker-mid"?: Attr;
  "marker-start"?: Attr;
  mask?: Attr;
  opacity?: Attr;
  overflow?: Attr;
  "paint-order"?: Attr;
  "pointer-events"?: Attr;
  "shape-rendering"?: Attr;
  "stop-color"?: Attr;
  "stop-opacity"?: Attr;
  stroke?: Attr;
  "stroke-dasharray"?: Attr;
  "stroke-dashoffset"?: Attr;
  "stroke-linecap"?: Attr;
  "stroke-linejoin"?: Attr;
  "stroke-miterlimit"?: Attr;
  "stroke-opacity"?: Attr;
  "stroke-width"?: Attr;
  "text-anchor"?: Attr;
  "text-decoration"?: Attr;
  "text-rendering"?: Attr;
  "vector-effect"?: Attr;
  visibility?: Attr;
  "word-spacing"?: Attr;
  "writing-mode"?: Attr;
  // Text.
  lengthAdjust?: Attr;
  rotate?: Attr;
  startOffset?: Attr;
  textLength?: Attr;
  // Gradients, patterns, markers, clips, masks and filters.
  clipPathUnits?: Attr;
  filterUnits?: Attr;
  gradientTransform?: Attr;
  gradientUnits?: Attr;
  markerHeight?: Attr;
  markerUnits?: Attr;
  markerWidth?: Attr;
  maskContentUnits?: Attr;
  maskUnits?: Attr;
  offset?: Attr;
  orient?: Attr;
  patternContentUnits?: Attr;
  patternTransform?: Attr;
  patternUnits?: Attr;
  primitiveUnits?: Attr;
  refX?: Attr;
  refY?: Attr;
  spreadMethod?: Attr;
  in?: Attr;
  in2?: Attr;
  mode?: Attr;
  operator?: Attr;
  result?: Attr;
  stdDeviation?: Attr;
  type?: Attr;
  values?: Attr;
  // Animation.
  attributeName?: Attr;
  begin?: Attr;
  dur?: Attr;
  end?: Attr;
  from?: Attr;
  keySplines?: Attr;
  keyTimes?: Attr;
  repeatCount?: Attr;
  to?: Attr;
}

/** Every SVG element whose tag HTML has no element of: `svg`, `path`, `circle`, ... */
type SVGElements = {
  [K in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]: SVGAttributes & {
    ref?: Refs<SVGElementTagNameMap[K]>;
    key?: Key;
  };
};

// #endregion

// #region The JSX namespace

/** The intrinsic elements: every HTML tag, and every SVG tag HTML has no element of. */
interface IntrinsicElementMap extends HTMLElements, SVGElements {}

/** The types TypeScript gives reactre's TSX (`jsxImportSource: "@reactre/core"`). */
export declare namespace JSX {
  /** What a JSX expression evaluates to: a host element's tree, or a component's result. */
  type Element = Node;
  /** What a tag may name: an intrinsic element, or a component, any function of its props. */
  type ElementType = keyof IntrinsicElements | ((props: never) => unknown);
  /**
   * Children are passed as the `children` prop. Props are typed as values: that the compiler
   * passes a prop that may change, and children that hold JSX, as getters is not in the types.
   */
  interface ElementChildrenAttribute {
    children: {};
  }
  /** The attributes every element takes besides its own: none (a host element's `key` is in its own). */
  interface IntrinsicAttributes {}
  /** The host elements and their attributes. */
  interface IntrinsicElements extends IntrinsicElementMap {}
}

// #endregion

// #region Runtime

/**
 * The automatic runtime's element call. reactre's TSX compiles to templates, so a call here means
 * a TSX file was bundled without @reactre/plugin (or @reactre/compiler).
 *
 * @throws Error always.
 */
export function jsx(type: unknown, _props?: unknown, _key?: unknown): never {
  throw new Error(
    `reactre: <${typeof type === "string" ? type : "component"}> must be compiled by @reactre/plugin or @reactre/compiler`,
  );
}

export { jsx as jsxDEV, jsx as jsxs };

// #endregion
