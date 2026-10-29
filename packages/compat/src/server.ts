// @reactre/compat/server: React 19's server rendering API (`react-dom/server`) for @reactre/compat.
//
// renderToString, renderToStaticMarkup, renderToReadableStream and renderToPipeableStream write
// the HTML React's own server writes, byte for byte: text separators, Suspense markers and
// streaming instructions, hoisted <title>, <meta> and <link> tags, image preloads, resource
// hints (preload, preinit, ...), stylesheet precedence, form actions, useId's server ids, and
// the rest.
//
// Key design decisions:
//
//   1. A tree walker of its own, not compat's reconciler. The reconciler builds fibers for the DOM
//      and keeps them for updates; a server render visits each element once and writes text. This
//      module follows React's server renderer (Fizz, react-dom@19.3.1's production builds, which
//      are its spec): the same tasks, segments and boundaries, so that where content suspends,
//      errors or streams the output is React's, not merely equivalent HTML.
//   2. Hooks are compat's own: a component calls the same useState or useId on the server as on
//      the client. index.ts's __serverRender runs a component on a throwaway fiber with this
//      module's ServerHooks set, and the hooks consult them only where they mount (useId,
//      useSyncExternalStore, useDeferredValue) or read a browser() token, so a client render pays
//      nothing for server rendering. Effects are collected and never run; no ref is attached,
//      since no host fiber exists. A setState after the render, or from a child during it, does
//      nothing, as on React's server.
//   3. Context values live on the context object (`_currentValue`), pushed and popped as React's
//      server does, and restored when each unit of work ends, so a client root in the same realm
//      reads its defaults as before. Class components are rendered here, as React's server renders
//      them (constructor, getDerivedStateFromProps, componentWillMount with its setState queue,
//      render), whether or not @reactre/compat/classes is loaded.
//   4. Output chunks are strings; the stream entries encode them into views as they flush, as
//      React's builds do: 4096-byte views for renderToPipeableStream, which pauses while the
//      writable is full (React's Node build), and 2048-byte views for renderToReadableStream (its
//      browser and edge builds), so the chunks are React's too.
//
// What differs from React (see the README for the full list): a promise created during render
// (uncached) is not replayed on retry, so `use()` of one suspends again; `formState` and the
// prerender and resume APIs are not supported (the latter throw); error messages are React's
// full (development) messages rather than minified codes.
//
// The file reads top down, in folding regions: HTML writing (escaping, attributes, elements,
// resources), format and tree contexts, the request and its tasks, rendering, the work loop,
// flushing, and the public API.

import {
  __serverHints,
  __serverRender,
  Children,
  type ReactElement,
  type ServerHooks,
  version as compatVersion,
} from "./core.ts";

// `Any` stands for React's untyped values (props, children, element types), as in index.ts.
// biome-ignore lint: elements, props and React's internal records are untyped.
type Any = any;

/** The React version this module implements: React's server reports the same as the client. */
export const version: string = compatVersion;

// React's type tags, from the global symbol registry, as index.ts reads them.
const ELEMENT = Symbol.for("react.transitional.element");
const PORTAL_TYPE = Symbol.for("react.portal");
const FRAGMENT_TYPE = Symbol.for("react.fragment");
const STRICT_MODE_TYPE = Symbol.for("react.strict_mode");
const PROFILER_TYPE = Symbol.for("react.profiler");
const CONSUMER_TYPE = Symbol.for("react.consumer");
const CONTEXT_TYPE = Symbol.for("react.context");
const FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const SUSPENSE_TYPE = Symbol.for("react.suspense");
const SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list");
const MEMO_TYPE = Symbol.for("react.memo");
const LAZY_TYPE = Symbol.for("react.lazy");
const SCOPE_TYPE = Symbol.for("react.scope");
const ACTIVITY_TYPE = Symbol.for("react.activity");
const LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden");
const VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition");
const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const RECOVERABLE_TYPE = Symbol.for("react.recoverable");

const hasOwn = Object.prototype.hasOwnProperty;
const isArray = Array.isArray;
const noop = (): void => {};

// #region HTML writing

// #region Escaping

const htmlChar = /["'&<>]/;

/** Text and attribute values escaped as React escapes them; numbers and booleans as they are. */
function escapeText(text: Any): string {
  if (typeof text === "boolean" || typeof text === "number" || typeof text === "bigint") return "" + text;
  const s = "" + text;
  const match = htmlChar.exec(s);
  if (match === null) return s;
  let html = "",
    last = 0,
    i = match.index;
  for (; i < s.length; i++) {
    let rep: string;
    switch (s.charCodeAt(i)) {
      case 34:
        rep = "&quot;";
        break;
      case 38:
        rep = "&amp;";
        break;
      case 39:
        rep = "&#x27;";
        break;
      case 60:
        rep = "&lt;";
        break;
      case 62:
        rep = "&gt;";
        break;
      default:
        continue;
    }
    if (last !== i) html += s.slice(last, i);
    last = i + 1;
    html += rep;
  }
  return last !== i ? html + s.slice(last, i) : html;
}

const jsProtocol =
  /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;

/** A `javascript:` URL replaced by one that throws, as React blocks it. */
function sanitizeURL(url: Any): Any {
  return jsProtocol.test("" + url)
    ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
    : url;
}

// Inline script and style text: a closing tag inside is escaped so it cannot end the element.
const scriptRegex = /(<\/|<)(s)(cript)/gi;
const scriptReplacer = (_: string, prefix: string, s: string, suffix: string): string =>
  prefix + (s === "s" ? "\\u0073" : "\\u0053") + suffix;
const styleRegex = /(<\/|<)(s)(tyle)/gi;
const styleReplacer = (_: string, prefix: string, s: string, suffix: string): string =>
  prefix + (s === "s" ? "\\73 " : "\\53 ") + suffix;

// Strings inside the instruction scripts: JSON, with the characters that could end a script or
// break a JavaScript string escaped.
const jsStringChars = /[<\u2028\u2029]/g;
const escapeJSString = (input: string): string =>
  JSON.stringify(input).replace(jsStringChars, (m) => (m === "<" ? "\\u003c" : m === "\u2028" ? "\\u2028" : "\\u2029"));
const jsObjectChars = /[&><\u2028\u2029]/g;
const escapeJSObject = (input: string): string =>
  JSON.stringify(input).replace(jsObjectChars, (m) =>
    m === "&" ? "\\u0026" : m === ">" ? "\\u003e" : m === "<" ? "\\u003c" : m === "\u2028" ? "\\u2028" : "\\u2029",
  );

/** UTF-8 byte length of a string, for React's progressive chunk sizes. */
function byteLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) {
      if (c < 0x800) n += 1;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        // A surrogate pair: four bytes for two code units.
        n += 2;
        i++;
      } else n += 2;
    }
  }
  return n;
}

// #endregion

// #region Attributes and styles

const attrNameRegex =
  /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/;
const safeNames = new Map<string, boolean>();

/** Whether `name` may be written as an attribute name (React's XML name check, cached). */
function isAttributeNameSafe(name: string): boolean {
  let ok = safeNames.get(name);
  if (ok === undefined) safeNames.set(name, (ok = attrNameRegex.test(name)));
  return ok;
}

// Numeric style values written without "px".
const unitless = new Set(
  (
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup " +
    "boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea " +
    "gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart " +
    "fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity " +
    "floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth " +
    "MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom " +
    "msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow " +
    "msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup " +
    "WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp"
  ).split(" "),
);

// Props written under another attribute name (SVG's dashed names, htmlFor, ...).
const aliases = new Map<string, string>(
  (
    "acceptCharset accept-charset htmlFor for httpEquiv http-equiv crossOrigin crossorigin accentHeight accent-height " +
    "alignmentBaseline alignment-baseline arabicForm arabic-form baselineShift baseline-shift capHeight cap-height " +
    "clipPath clip-path clipRule clip-rule colorInterpolation color-interpolation colorInterpolationFilters " +
    "color-interpolation-filters colorProfile color-profile colorRendering color-rendering dominantBaseline " +
    "dominant-baseline enableBackground enable-background fillOpacity fill-opacity fillRule fill-rule floodColor " +
    "flood-color floodOpacity flood-opacity fontFamily font-family fontSize font-size fontSizeAdjust " +
    "font-size-adjust fontStretch font-stretch fontStyle font-style fontVariant font-variant fontWeight font-weight " +
    "glyphName glyph-name glyphOrientationHorizontal glyph-orientation-horizontal glyphOrientationVertical " +
    "glyph-orientation-vertical horizAdvX horiz-adv-x horizOriginX horiz-origin-x imageRendering image-rendering " +
    "letterSpacing letter-spacing lightingColor lighting-color markerEnd marker-end markerMid marker-mid " +
    "markerStart marker-start maskType mask-type overlinePosition overline-position overlineThickness " +
    "overline-thickness paintOrder paint-order panose-1 panose-1 pointerEvents pointer-events renderingIntent " +
    "rendering-intent shapeRendering shape-rendering stopColor stop-color stopOpacity stop-opacity " +
    "strikethroughPosition strikethrough-position strikethroughThickness strikethrough-thickness strokeDasharray " +
    "stroke-dasharray strokeDashoffset stroke-dashoffset strokeLinecap stroke-linecap strokeLinejoin " +
    "stroke-linejoin strokeMiterlimit stroke-miterlimit strokeOpacity stroke-opacity strokeWidth stroke-width " +
    "textAnchor text-anchor textDecoration text-decoration textRendering text-rendering transformOrigin " +
    "transform-origin underlinePosition underline-position underlineThickness underline-thickness unicodeBidi " +
    "unicode-bidi unicodeRange unicode-range unitsPerEm units-per-em vAlphabetic v-alphabetic vHanging v-hanging " +
    "vIdeographic v-ideographic vMathematical v-mathematical vectorEffect vector-effect vertAdvY vert-adv-y " +
    "vertOriginX vert-origin-x vertOriginY vert-origin-y wordSpacing word-spacing writingMode writing-mode " +
    "xmlnsXlink xmlns:xlink xHeight x-height"
  )
    .split(" ")
    .reduce<[string, string][]>((out, w, i, all) => (i % 2 === 0 && out.push([w, all[i + 1]!]), out), []),
);

const styleNames = new Map<string, string>();

/** A `style` object as React writes it: hyphenated names, `px` where React adds it, trimmed. */
function pushStyleAttribute(target: string[], style: Any): void {
  if (typeof style !== "object")
    throw new Error(
      "The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.",
    );
  let first = true;
  for (const name in style) {
    if (!hasOwn.call(style, name)) continue;
    let value = style[name];
    if (value == null || typeof value === "boolean" || value === "") continue;
    let nameChunk: string;
    if (name.indexOf("--") === 0) {
      nameChunk = escapeText(name);
      value = escapeText(("" + value).trim());
    } else {
      let cached = styleNames.get(name);
      if (cached === undefined) {
        cached = escapeText(
          name
            .replace(/([A-Z])/g, "-$1")
            .toLowerCase()
            .replace(/^ms-/, "-ms-"),
        );
        styleNames.set(name, cached);
      }
      nameChunk = cached;
      value =
        typeof value === "number"
          ? value === 0 || unitless.has(name)
            ? "" + value
            : value + "px"
          : escapeText(("" + value).trim());
    }
    if (first) {
      first = false;
      target.push(' style="', nameChunk, ":", value);
    } else target.push(";", nameChunk, ":", value);
  }
  if (!first) target.push('"');
}

function pushBooleanAttribute(target: string[], name: string, value: Any): void {
  if (value && typeof value !== "function" && typeof value !== "symbol") target.push(" ", name, '=""');
}

function pushStringAttribute(target: string[], name: string, value: Any): void {
  if (typeof value !== "function" && typeof value !== "symbol" && typeof value !== "boolean")
    target.push(" ", name, '="', escapeText(value), '"');
}

/** One prop of a built-in element, written as React writes it (or not at all). */
function pushAttribute(target: string[], name: string, value: Any): void {
  switch (name) {
    case "className":
      pushStringAttribute(target, "class", value);
      break;
    case "tabIndex":
      pushStringAttribute(target, "tabindex", value);
      break;
    case "dir":
    case "role":
    case "viewBox":
    case "width":
    case "height":
      pushStringAttribute(target, name, value);
      break;
    case "style":
      pushStyleAttribute(target, value);
      break;
    case "src":
    case "href":
    case "action":
    case "formAction":
      // An empty src or href is left out, as React leaves it out.
      if (
        (value === "" && (name === "src" || name === "href")) ||
        value == null ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "boolean"
      )
        break;
      target.push(" ", name, '="', escapeText(sanitizeURL("" + value)), '"');
      break;
    case "defaultValue":
    case "defaultChecked":
    case "innerHTML":
    case "suppressContentEditableWarning":
    case "suppressHydrationWarning":
    case "ref":
      break;
    case "autoFocus":
    case "multiple":
    case "muted":
      pushBooleanAttribute(target, name.toLowerCase(), value);
      break;
    case "xlinkHref":
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "boolean") break;
      target.push(" ", "xlink:href", '="', escapeText(sanitizeURL("" + value)), '"');
      break;
    case "contentEditable":
    case "spellCheck":
    case "draggable":
    case "value":
    case "autoReverse":
    case "externalResourcesRequired":
    case "focusable":
    case "preserveAlpha":
      if (typeof value !== "function" && typeof value !== "symbol")
        target.push(" ", name, '="', escapeText(value), '"');
      break;
    case "inert":
    case "allowFullScreen":
    case "async":
    case "autoPlay":
    case "controls":
    case "credentialless":
    case "default":
    case "defer":
    case "disabled":
    case "disablePictureInPicture":
    case "disableRemotePlayback":
    case "formNoValidate":
    case "hidden":
    case "loop":
    case "noModule":
    case "noValidate":
    case "open":
    case "playsInline":
    case "readOnly":
    case "required":
    case "reversed":
    case "scoped":
    case "seamless":
    case "itemScope":
      pushBooleanAttribute(target, name, value);
      break;
    case "capture":
    case "download":
      if (value === true) target.push(" ", name, '=""');
      else if (value !== false && typeof value !== "function" && typeof value !== "symbol")
        target.push(" ", name, '="', escapeText(value), '"');
      break;
    case "cols":
    case "rows":
    case "size":
    case "span":
      if (typeof value !== "function" && typeof value !== "symbol" && !isNaN(value) && value >= 1)
        target.push(" ", name, '="', escapeText(value), '"');
      break;
    case "rowSpan":
    case "start":
      if (typeof value !== "function" && typeof value !== "symbol" && !isNaN(value))
        target.push(" ", name, '="', escapeText(value), '"');
      break;
    case "xlinkActuate":
      pushStringAttribute(target, "xlink:actuate", value);
      break;
    case "xlinkArcrole":
      pushStringAttribute(target, "xlink:arcrole", value);
      break;
    case "xlinkRole":
      pushStringAttribute(target, "xlink:role", value);
      break;
    case "xlinkShow":
      pushStringAttribute(target, "xlink:show", value);
      break;
    case "xlinkTitle":
      pushStringAttribute(target, "xlink:title", value);
      break;
    case "xlinkType":
      pushStringAttribute(target, "xlink:type", value);
      break;
    case "xmlBase":
      pushStringAttribute(target, "xml:base", value);
      break;
    case "xmlLang":
      pushStringAttribute(target, "xml:lang", value);
      break;
    case "xmlSpace":
      pushStringAttribute(target, "xml:space", value);
      break;
    default: {
      // Event handlers (on*) are never attributes.
      if (name.length > 2 && (name[0] === "o" || name[0] === "O") && (name[1] === "n" || name[1] === "N")) return;
      const attr = aliases.get(name) || name;
      if (!isAttributeNameSafe(attr)) return;
      switch (typeof value) {
        case "function":
        case "symbol":
          return;
        case "boolean": {
          const prefix = attr.toLowerCase().slice(0, 5);
          if (prefix !== "data-" && prefix !== "aria-") return;
        }
      }
      target.push(" ", attr, '="', escapeText(value), '"');
    }
  }
}

/** dangerouslySetInnerHTML's HTML, checked as React checks it. */
function pushInnerHTML(target: string[], innerHTML: Any, children: Any): void {
  if (innerHTML == null) return;
  if (children != null) throw new Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
  if (typeof innerHTML !== "object" || !("__html" in innerHTML))
    throw new Error(
      "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
    );
  const html = innerHTML.__html;
  if (html !== null && html !== undefined) target.push("" + html);
}

// #endregion

// #region Form actions

// A function as a form's or button's action has no URL: React writes one that throws, and a
// script that replays the submit once the client runtime loads.
const actionJavaScriptURL = escapeText("javascript:throw new Error('React form unexpectedly submitted.')");
const formReplayingRuntime =
  'addEventListener("submit",function(a){if(!a.defaultPrevented){var b=a.target,d=a.submitter,c=b.action,e=d;if(d){var f=d.getAttribute("formAction");null!=f&&(c=f,e=null)}"javascript:throw new Error(\'React form unexpectedly submitted.\')"===c&&(a.preventDefault(),a=new FormData(b,e),c=b.ownerDocument||b,(c.$$reactFormReplay=c.$$reactFormReplay||[]).push(b,d,a))}});';

function validateAdditionalFormField(value: Any): void {
  if (typeof value !== "string")
    throw new Error("File/Blob fields are not yet supported in progressive forms. Will fallback to client hydration.");
}

function pushAdditionalFormField(this: string[], value: Any, key: string): void {
  this.push('<input type="hidden"');
  validateAdditionalFormField(value);
  pushStringAttribute(this, "name", key);
  pushStringAttribute(this, "value", value);
  this.push("/>");
}

/** A server action's own fields (`$$FORM_ACTION`), if the function has them. */
function getCustomFormFields(rs: ResumableState, formAction: Any): Any {
  if (typeof formAction.$$FORM_ACTION === "function") {
    const id = rs.nextFormID++;
    try {
      const custom = formAction.$$FORM_ACTION(rs.idPrefix + id);
      if (custom) {
        const data = custom.data;
        if (data != null) data.forEach(validateAdditionalFormField);
      }
      return custom;
    } catch (x) {
      if (typeof x === "object" && x !== null && typeof (x as Any).then === "function") throw x;
    }
  }
  return null;
}

/** The submit-replaying script, once per render, in the bootstrap scripts. */
function injectFormReplayingRuntime(rs: ResumableState, state: RenderState): void {
  if ((rs.instructions & 16) !== 0) return;
  rs.instructions |= 16;
  const preamble = state.preamble,
    chunks = state.bootstrapChunks;
  if ((preamble.htmlChunks || preamble.headChunks) && chunks.length === 0) {
    chunks.push(state.startInlineScript);
    pushCompletedShellIdAttribute(chunks, rs);
    chunks.push(">", formReplayingRuntime, "</script>");
  } else chunks.unshift(state.startInlineScript, ">", formReplayingRuntime, "</script>");
}

function pushFormActionAttribute(
  target: string[],
  rs: ResumableState,
  state: RenderState,
  formAction: Any,
  formEncType: Any,
  formMethod: Any,
  formTarget: Any,
  name: Any,
): Any {
  let formData = null;
  if (typeof formAction === "function") {
    const custom = getCustomFormFields(rs, formAction);
    if (custom !== null) {
      name = custom.name;
      formAction = custom.action || "";
      formEncType = custom.encType;
      formMethod = custom.method;
      formTarget = custom.target;
      formData = custom.data;
    } else {
      target.push(" ", "formAction", '="', actionJavaScriptURL, '"');
      formTarget = formMethod = formEncType = formAction = name = null;
      injectFormReplayingRuntime(rs, state);
    }
  }
  if (name != null) pushAttribute(target, "name", name);
  if (formAction != null) pushAttribute(target, "formAction", formAction);
  if (formEncType != null) pushAttribute(target, "formEncType", formEncType);
  if (formMethod != null) pushAttribute(target, "formMethod", formMethod);
  if (formTarget != null) pushAttribute(target, "formTarget", formTarget);
  return formData;
}

// #endregion

// #region Elements

const validTag = /^[a-zA-Z][a-zA-Z:_.\-\d]*$/;
const startTags = new Map<string, string>();
const endTags = new Map<string, string>();

function startChunkForTag(tag: string): string {
  let chunk = startTags.get(tag);
  if (chunk === undefined) {
    if (!validTag.test(tag)) throw new Error("Invalid tag: " + tag);
    startTags.set(tag, (chunk = "<" + tag));
  }
  return chunk;
}

function endChunkForTag(tag: string): string {
  let chunk = endTags.get(tag);
  if (chunk === undefined) endTags.set(tag, (chunk = "</" + tag + ">"));
  return chunk;
}

/** A self-closing tag's error, for children or inner HTML on one. */
const selfClosing = (tag: string): Error =>
  new Error(tag + " is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.");

/** A view transition's attributes, for the first element under a <ViewTransition> (streams only). */
function pushViewTransitionAttributes(target: string[], ctx: FormatContext): void {
  const vt = ctx.viewTransition;
  if (vt === null) return;
  if (vt.name !== "auto") {
    pushStringAttribute(target, "vt-name", vt.nameIdx === 0 ? vt.name : vt.name + "_" + vt.nameIdx);
    vt.nameIdx++;
  }
  pushStringAttribute(target, "vt-update", vt.update);
  if (vt.enter !== "none") pushStringAttribute(target, "vt-enter", vt.enter);
  if (vt.exit !== "none") pushStringAttribute(target, "vt-exit", vt.exit);
  if (vt.share !== "none") pushStringAttribute(target, "vt-share", vt.share);
}

function pushLinkImpl(target: string[], props: Props): null {
  target.push(startChunkForTag("link"));
  for (const k in props) {
    if (!hasOwn.call(props, k)) continue;
    const v = props[k];
    if (v == null) continue;
    if (k === "children" || k === "dangerouslySetInnerHTML") throw selfClosing("link");
    pushAttribute(target, k, v);
  }
  target.push("/>");
  return null;
}

function pushSelfClosing(target: string[], props: Props, tag: string, ctx: FormatContext): null {
  target.push(startChunkForTag(tag));
  for (const k in props) {
    if (!hasOwn.call(props, k)) continue;
    const v = props[k];
    if (v == null) continue;
    if (k === "children" || k === "dangerouslySetInnerHTML") throw selfClosing(tag);
    pushAttribute(target, k, v);
  }
  pushViewTransitionAttributes(target, ctx);
  target.push("/>");
  return null;
}

/** Writes the start tag's attributes except children and inner HTML; returns them. */
function pushProps(target: string[], props: Props): [Any, Any] {
  let children = null,
    innerHTML = null;
  for (const k in props) {
    if (!hasOwn.call(props, k)) continue;
    const v = props[k];
    if (v == null) continue;
    if (k === "children") children = v;
    else if (k === "dangerouslySetInnerHTML") innerHTML = v;
    else pushAttribute(target, k, v);
  }
  return [children, innerHTML];
}

/** A <title>'s one child as text (more than one renders none). */
function pushTitleImpl(target: string[], props: Props): null {
  target.push(startChunkForTag("title"));
  const [children, innerHTML] = pushProps(target, props);
  target.push(">");
  const child = isArray(children) ? (children.length < 2 ? children[0] : null) : children;
  if (typeof child !== "function" && typeof child !== "symbol" && child !== null && child !== undefined)
    target.push(escapeText("" + child));
  pushInnerHTML(target, innerHTML, children);
  target.push(endChunkForTag("title"));
  return null;
}

function pushScriptImpl(target: string[], props: Props): null {
  target.push(startChunkForTag("script"));
  const [children, innerHTML] = pushProps(target, props);
  target.push(">");
  pushInnerHTML(target, innerHTML, children);
  if (typeof children === "string") target.push(("" + children).replace(scriptRegex, scriptReplacer));
  target.push(endChunkForTag("script"));
  return null;
}

/** <html>, <head> or <body> at the document's top: written to the preamble. */
function pushStartSingletonElement(target: string[], props: Props, tag: string, ctx: FormatContext): Any {
  target.push(startChunkForTag(tag));
  const [children, innerHTML] = pushProps(target, props);
  pushViewTransitionAttributes(target, ctx);
  target.push(">");
  pushInnerHTML(target, innerHTML, children);
  return children;
}

/** Any other element: start tag, then string children as text, else the children to render. */
function pushStartGenericElement(target: string[], props: Props, tag: string, ctx: FormatContext): Any {
  target.push(startChunkForTag(tag));
  const [children, innerHTML] = pushProps(target, props);
  pushViewTransitionAttributes(target, ctx);
  target.push(">");
  pushInnerHTML(target, innerHTML, children);
  if (typeof children === "string") {
    target.push(escapeText(children));
    return null;
  }
  return children;
}

/** An <option>'s text, to compare with its <select>'s value. */
function flattenOptionChildren(children: Any): string {
  let content = "";
  Children.forEach(children, (child) => {
    if (child != null) content += child;
  });
  return content;
}

/** The value of a select or textarea's `value` prop, else its `defaultValue`. */
const valueOf = (props: Props): Any => (props["value"] != null ? props["value"] : props["defaultValue"]);

/**
 * Write an element's start tag (or hoist it: titles, metas, links, async scripts, precedence
 * styles) and return the children to render inside it: null when written already, undefined for a
 * hoisted tag. React's pushStartInstance.
 */
function pushStartInstance(
  target: string[],
  type: string,
  props: Props,
  rs: ResumableState,
  state: RenderState,
  preambleState: PreambleState | null,
  hoistableState: HoistableState | null,
  ctx: FormatContext,
  textEmbedded: boolean,
): Any {
  switch (type) {
    case "div":
    case "span":
    case "svg":
    case "path":
    case "g":
    case "p":
    case "li":
    case "annotation-xml":
    case "color-profile":
    case "font-face":
    case "font-face-src":
    case "font-face-uri":
    case "font-face-format":
    case "font-face-name":
    case "missing-glyph":
      break;
    case "a": {
      target.push(startChunkForTag("a"));
      let children = null,
        innerHTML = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        if (k === "children") children = v;
        else if (k === "dangerouslySetInnerHTML") innerHTML = v;
        // An <a>'s empty href is kept, unlike other elements'.
        else if (k === "href" && v === "") pushStringAttribute(target, "href", "");
        else pushAttribute(target, k, v);
      }
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      pushInnerHTML(target, innerHTML, children);
      if (typeof children === "string") {
        target.push(escapeText(children));
        return null;
      }
      return children;
    }
    case "select": {
      target.push(startChunkForTag("select"));
      let children = null,
        innerHTML = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        if (k === "children") children = v;
        else if (k === "dangerouslySetInnerHTML") innerHTML = v;
        // The value selects options instead (see getChildFormatContext).
        else if (k !== "defaultValue" && k !== "value") pushAttribute(target, k, v);
      }
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      pushInnerHTML(target, innerHTML, children);
      return children;
    }
    case "option": {
      const selectedValue = ctx.selectedValue;
      target.push(startChunkForTag("option"));
      let children = null,
        value = null,
        selected = null,
        innerHTML = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        switch (k) {
          case "children":
            children = v;
            break;
          case "selected":
            selected = v;
            break;
          case "dangerouslySetInnerHTML":
            innerHTML = v;
            break;
          case "value":
            value = v;
            pushAttribute(target, k, v);
            break;
          default:
            pushAttribute(target, k, v);
        }
      }
      if (selectedValue != null) {
        const text = value !== null ? "" + value : flattenOptionChildren(children);
        if (isArray(selectedValue)) {
          for (let i = 0; i < selectedValue.length; i++) {
            if ("" + selectedValue[i] === text) {
              target.push(' selected=""');
              break;
            }
          }
        } else if ("" + selectedValue === text) target.push(' selected=""');
      } else if (selected) target.push(' selected=""');
      target.push(">");
      pushInnerHTML(target, innerHTML, children);
      return children;
    }
    case "textarea": {
      target.push(startChunkForTag("textarea"));
      let value: Any = null,
        defaultValue = null,
        children: Any = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        switch (k) {
          case "children":
            children = v;
            break;
          case "value":
            value = v;
            break;
          case "defaultValue":
            defaultValue = v;
            break;
          case "dangerouslySetInnerHTML":
            throw new Error("`dangerouslySetInnerHTML` does not make sense on <textarea>.");
          default:
            pushAttribute(target, k, v);
        }
      }
      if (value === null && defaultValue !== null) value = defaultValue;
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      if (children != null) {
        if (value != null) throw new Error("If you supply `defaultValue` on a <textarea>, do not pass children.");
        if (isArray(children) && children.length > 1) throw new Error("<textarea> can only have at most one child.");
        // As React: an array's string form, not its first item's.
        value = "" + children;
      }
      if (typeof value === "string" && value[0] === "\n") target.push("\n");
      if (value !== null) target.push(escapeText("" + value));
      return null;
    }
    case "input": {
      target.push(startChunkForTag("input"));
      let name = null,
        formAction = null,
        formEncType = null,
        formMethod = null,
        formTarget = null,
        value = null,
        defaultValue = null,
        checked = null,
        defaultChecked = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        switch (k) {
          case "children":
          case "dangerouslySetInnerHTML":
            throw selfClosing("input");
          case "name":
            name = v;
            break;
          case "formAction":
            formAction = v;
            break;
          case "formEncType":
            formEncType = v;
            break;
          case "formMethod":
            formMethod = v;
            break;
          case "formTarget":
            formTarget = v;
            break;
          case "defaultChecked":
            defaultChecked = v;
            break;
          case "defaultValue":
            defaultValue = v;
            break;
          case "checked":
            checked = v;
            break;
          case "value":
            value = v;
            break;
          default:
            pushAttribute(target, k, v);
        }
      }
      const formData = pushFormActionAttribute(
        target,
        rs,
        state,
        formAction,
        formEncType,
        formMethod,
        formTarget,
        name,
      );
      if (checked !== null) pushBooleanAttribute(target, "checked", checked);
      else if (defaultChecked !== null) pushBooleanAttribute(target, "checked", defaultChecked);
      if (value !== null) pushAttribute(target, "value", value);
      else if (defaultValue !== null) pushAttribute(target, "value", defaultValue);
      pushViewTransitionAttributes(target, ctx);
      target.push("/>");
      if (formData != null) formData.forEach(pushAdditionalFormField, target);
      return null;
    }
    case "button": {
      target.push(startChunkForTag("button"));
      let children = null,
        innerHTML = null,
        name = null,
        formAction = null,
        formEncType = null,
        formMethod = null,
        formTarget = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        switch (k) {
          case "children":
            children = v;
            break;
          case "dangerouslySetInnerHTML":
            innerHTML = v;
            break;
          case "name":
            name = v;
            break;
          case "formAction":
            formAction = v;
            break;
          case "formEncType":
            formEncType = v;
            break;
          case "formMethod":
            formMethod = v;
            break;
          case "formTarget":
            formTarget = v;
            break;
          default:
            pushAttribute(target, k, v);
        }
      }
      const formData = pushFormActionAttribute(
        target,
        rs,
        state,
        formAction,
        formEncType,
        formMethod,
        formTarget,
        name,
      );
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      if (formData != null) formData.forEach(pushAdditionalFormField, target);
      pushInnerHTML(target, innerHTML, children);
      if (typeof children === "string") {
        target.push(escapeText(children));
        return null;
      }
      return children;
    }
    case "form": {
      target.push(startChunkForTag("form"));
      let children = null,
        innerHTML = null,
        formAction: Any = null,
        formEncType = null,
        formMethod = null,
        formTarget = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        switch (k) {
          case "children":
            children = v;
            break;
          case "dangerouslySetInnerHTML":
            innerHTML = v;
            break;
          case "action":
            formAction = v;
            break;
          case "encType":
            formEncType = v;
            break;
          case "method":
            formMethod = v;
            break;
          case "target":
            formTarget = v;
            break;
          default:
            pushAttribute(target, k, v);
        }
      }
      let formData = null,
        actionName = null;
      if (typeof formAction === "function") {
        const custom = getCustomFormFields(rs, formAction);
        if (custom !== null) {
          formAction = custom.action || "";
          formEncType = custom.encType;
          formMethod = custom.method;
          formTarget = custom.target;
          formData = custom.data;
          actionName = custom.name;
        } else {
          target.push(" ", "action", '="', actionJavaScriptURL, '"');
          formTarget = formMethod = formEncType = formAction = null;
          injectFormReplayingRuntime(rs, state);
        }
      }
      if (formAction != null) pushAttribute(target, "action", formAction);
      if (formEncType != null) pushAttribute(target, "encType", formEncType);
      if (formMethod != null) pushAttribute(target, "method", formMethod);
      if (formTarget != null) pushAttribute(target, "target", formTarget);
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      if (actionName !== null) {
        target.push('<input type="hidden"');
        pushStringAttribute(target, "name", actionName);
        target.push("/>");
        if (formData != null) formData.forEach(pushAdditionalFormField, target);
      }
      pushInnerHTML(target, innerHTML, children);
      if (typeof children === "string") {
        target.push(escapeText(children));
        return null;
      }
      return children;
    }
    case "menuitem": {
      target.push(startChunkForTag("menuitem"));
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        if (k === "children" || k === "dangerouslySetInnerHTML")
          throw new Error("menuitems cannot have `children` nor `dangerouslySetInnerHTML`.");
        pushAttribute(target, k, v);
      }
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      return null;
    }
    case "object": {
      target.push(startChunkForTag("object"));
      let children = null,
        innerHTML = null;
      for (const k in props) {
        if (!hasOwn.call(props, k)) continue;
        const v = props[k];
        if (v == null) continue;
        if (k === "children") children = v;
        else if (k === "dangerouslySetInnerHTML") innerHTML = v;
        else if (k === "data") {
          const url = sanitizeURL("" + v);
          if (url !== "") target.push(" ", "data", '="', escapeText(url), '"');
        } else pushAttribute(target, k, v);
      }
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      pushInnerHTML(target, innerHTML, children);
      if (typeof children === "string") {
        target.push(escapeText(children));
        return null;
      }
      return children;
    }
    case "title": {
      // Hoisted into the head, except inside svg, noscript or with itemProp; a fallback's is dropped.
      if (ctx.insertionMode === SVG_MODE || ctx.tagScope & NOSCRIPT_SCOPE || props["itemProp"] != null)
        return pushTitleImpl(target, props);
      if (ctx.tagScope & FALLBACK_SCOPE) return null;
      pushTitleImpl(state.hoistableChunks, props);
      return undefined;
    }
    case "link": {
      const rel = props["rel"],
        href = props["href"],
        precedence = props["precedence"];
      if (
        ctx.insertionMode === SVG_MODE ||
        ctx.tagScope & NOSCRIPT_SCOPE ||
        props["itemProp"] != null ||
        typeof rel !== "string" ||
        typeof href !== "string" ||
        href === ""
      ) {
        pushLinkImpl(target, props);
        return null;
      }
      if (props["rel"] === "stylesheet") {
        if (typeof precedence !== "string" || props["disabled"] != null || props["onLoad"] || props["onError"])
          return pushLinkImpl(target, props);
        // A stylesheet with a precedence: a resource, written once, in precedence order.
        let queue = state.styles.get(precedence);
        const resourceState = rs.styleResources.get(href);
        if (resourceState !== null) {
          rs.styleResources.set(href, null);
          if (!queue) {
            queue = { precedence: escapeText(precedence), rules: [], hrefs: [], sheets: new Map() };
            state.styles.set(precedence, queue);
          }
          const resource: Stylesheet = {
            state: 0,
            props: { ...props, "data-precedence": props["precedence"], precedence: null },
          };
          if (resourceState) adoptPreload(resource, resourceState, state.preloads.stylesheets.get(href));
          queue.sheets.set(href, resource);
          if (hoistableState) hoistableState.stylesheets.add(resource);
        } else if (queue) {
          const resource = queue.sheets.get(href);
          if (resource && hoistableState) hoistableState.stylesheets.add(resource);
        }
        if (textEmbedded) target.push("<!-- -->");
        return null;
      }
      if (props["onLoad"] || props["onError"]) return pushLinkImpl(target, props);
      if (textEmbedded) target.push("<!-- -->");
      return ctx.tagScope & FALLBACK_SCOPE ? null : pushLinkImpl(state.hoistableChunks, props);
    }
    case "script": {
      const asyncProp = props["async"];
      if (
        typeof props["src"] !== "string" ||
        !props["src"] ||
        !asyncProp ||
        typeof asyncProp === "function" ||
        typeof asyncProp === "symbol" ||
        props["onLoad"] ||
        props["onError"] ||
        ctx.insertionMode === SVG_MODE ||
        ctx.tagScope & NOSCRIPT_SCOPE ||
        props["itemProp"] != null
      )
        return pushScriptImpl(target, props);
      // An async script with a src: a resource, written once, in the head.
      const key = props["src"];
      const module = props["type"] === "module";
      const resources = module ? rs.moduleScriptResources : rs.scriptResources;
      const resourceState = resources.get(key);
      if (resourceState !== null) {
        resources.set(key, null);
        let scriptProps = props;
        if (resourceState) {
          // A preload of the script lends its credentials, and is no longer written.
          if (resourceState.length === 2) adoptPreloadCredentials((scriptProps = { ...props }), resourceState);
          const preload = (module ? state.preloads.moduleScripts : state.preloads.scripts).get(key);
          if (preload) preload.length = 0;
        }
        const resource: string[] = [];
        state.scripts.add(resource);
        pushScriptImpl(resource, scriptProps);
      }
      if (textEmbedded) target.push("<!-- -->");
      return null;
    }
    case "style": {
      const precedence = props["precedence"],
        href = props["href"],
        nonce = props["nonce"];
      if (
        ctx.insertionMode === SVG_MODE ||
        ctx.tagScope & NOSCRIPT_SCOPE ||
        props["itemProp"] != null ||
        typeof precedence !== "string" ||
        typeof href !== "string" ||
        href === ""
      ) {
        target.push(startChunkForTag("style"));
        const [children, innerHTML] = pushProps(target, props);
        target.push(">");
        const child = isArray(children) ? (children.length < 2 ? children[0] : null) : children;
        if (typeof child !== "function" && typeof child !== "symbol" && child !== null && child !== undefined)
          target.push(("" + child).replace(styleRegex, styleReplacer));
        pushInnerHTML(target, innerHTML, children);
        target.push(endChunkForTag("style"));
        return null;
      }
      // A style with a precedence and href: its rules join its precedence's style tag.
      let queue = state.styles.get(precedence);
      if (rs.styleResources.get(href) !== null) {
        rs.styleResources.set(href, null);
        if (!queue) {
          queue = { precedence: escapeText(precedence), rules: [], hrefs: [], sheets: new Map() };
          state.styles.set(precedence, queue);
        }
        const nonceStyle = state.nonce.style;
        if (!nonceStyle || nonceStyle === nonce) {
          queue.hrefs.push(escapeText(href));
          let children = null,
            innerHTML = null;
          for (const k in props) {
            if (!hasOwn.call(props, k)) continue;
            const v = props[k];
            if (v == null) continue;
            if (k === "children") children = v;
            else if (k === "dangerouslySetInnerHTML") innerHTML = v;
          }
          const child: Any = isArray(children) ? (children.length < 2 ? children[0] : null) : children;
          if (typeof child !== "function" && typeof child !== "symbol" && child !== null && child !== undefined)
            queue.rules.push(("" + child).replace(styleRegex, styleReplacer));
          pushInnerHTML(queue.rules, innerHTML, children);
        }
      }
      if (queue && hoistableState) hoistableState.styles.add(queue);
      if (textEmbedded) target.push("<!-- -->");
      return undefined;
    }
    case "meta": {
      if (ctx.insertionMode === SVG_MODE || ctx.tagScope & NOSCRIPT_SCOPE || props["itemProp"] != null)
        return pushSelfClosing(target, props, "meta", ctx);
      if (textEmbedded) target.push("<!-- -->");
      if (ctx.tagScope & FALLBACK_SCOPE) return null;
      return typeof props["charSet"] === "string"
        ? pushSelfClosing(state.charsetChunks, props, "meta", ctx)
        : props["name"] === "viewport"
          ? pushSelfClosing(state.viewportChunks, props, "meta", ctx)
          : pushSelfClosing(state.hoistableChunks, props, "meta", ctx);
    }
    case "listing":
    case "pre": {
      target.push(startChunkForTag(type));
      const [children, innerHTML] = pushProps(target, props);
      pushViewTransitionAttributes(target, ctx);
      target.push(">");
      // A leading newline is dropped by the HTML parser, so one more is written.
      if (innerHTML != null) {
        if (children != null) throw new Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
        if (typeof innerHTML !== "object" || !("__html" in innerHTML))
          throw new Error(
            "`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.",
          );
        const html = innerHTML.__html;
        if (html !== null && html !== undefined) {
          if (typeof html === "string" && html.length > 0 && html[0] === "\n") target.push("\n", html);
          else target.push("" + html);
        }
      }
      if (typeof children === "string" && children[0] === "\n") target.push("\n");
      return children;
    }
    case "img": {
      const src = props["src"],
        srcSet = props["srcSet"];
      // An image that loads at once (not lazy, not low priority, not data: and not in <picture> or
      // <noscript>) gets a preload in the head, the first ten (or high priority ones) at the top.
      if (
        !(
          props["loading"] === "lazy" ||
          (!src && !srcSet) ||
          (typeof src !== "string" && src != null) ||
          (typeof srcSet !== "string" && srcSet != null) ||
          props["fetchPriority"] === "low" ||
          ctx.tagScope & (NOSCRIPT_SCOPE | PICTURE_SCOPE)
        ) &&
        !isDataURL(src) &&
        !isDataURL(srcSet)
      ) {
        if (hoistableState !== null && ctx.tagScope & 64) hoistableState.suspenseyImages = true;
        const sizes = typeof props["sizes"] === "string" ? props["sizes"] : undefined;
        const key = srcSet ? srcSet + "\n" + (sizes || "") : src;
        const promotable = state.preloads.images;
        let resource = promotable.get(key);
        if (resource) {
          if (props["fetchPriority"] === "high" || state.highImagePreloads.size < 10) {
            promotable.delete(key);
            state.highImagePreloads.add(resource);
          }
        } else if (!rs.imageResources.has(key)) {
          rs.imageResources.add(key);
          const input = props["crossOrigin"];
          const crossOrigin = typeof input === "string" ? (input === "use-credentials" ? input : "") : undefined;
          // With onHeaders, a Link header while it has room, for a high-priority image or while
          // the images there are short.
          const headers = state.headers;
          if (
            headers &&
            headers.remainingCapacity > 0 &&
            typeof srcSet !== "string" &&
            (props["fetchPriority"] === "high" || headers.highImagePreloads.length < 500) &&
            fitsHeader(
              headers,
              getPreloadAsHeader(src, "image", {
                imageSrcSet: srcSet,
                imageSizes: props["sizes"],
                crossOrigin,
                integrity: props["integrity"],
                nonce: props["nonce"],
                type: props["type"],
                fetchPriority: props["fetchPriority"],
                referrerPolicy: props["referrerPolicy"],
              }),
            )
          ) {
            headers.highImagePreloads = appendHeader(headers.highImagePreloads, lastHeader);
            return pushSelfClosing(target, props, "img", ctx);
          }
          resource = [];
          pushLinkImpl(resource, {
            rel: "preload",
            as: "image",
            href: srcSet ? undefined : src,
            imageSrcSet: srcSet,
            imageSizes: sizes,
            crossOrigin,
            integrity: props["integrity"],
            type: props["type"],
            fetchPriority: props["fetchPriority"],
            referrerPolicy: props["referrerPolicy"],
          });
          if (props["fetchPriority"] === "high" || state.highImagePreloads.size < 10)
            state.highImagePreloads.add(resource);
          else {
            state.bulkPreloads.add(resource);
            promotable.set(key, resource);
          }
        }
      }
      return pushSelfClosing(target, props, "img", ctx);
    }
    case "base":
    case "area":
    case "br":
    case "col":
    case "embed":
    case "hr":
    case "keygen":
    case "param":
    case "source":
    case "track":
    case "wbr":
      return pushSelfClosing(target, props, type, ctx);
    case "head":
    case "body":
    case "html": {
      // At the document's top these go to the preamble, written before everything else.
      if (ctx.insertionMode < (type === "html" ? 1 : HTML_MODE)) {
        const preamble = preambleState || state.preamble;
        const field = type === "html" ? "htmlChunks" : type === "head" ? "headChunks" : "bodyChunks";
        if (preamble[field]) throw new Error("The `<" + type + ">` tag may only be rendered once.");
        if (preambleState !== null) target.push("<!--" + type + "-->");
        const chunks: string[] = (preamble[field] = type === "html" ? [state.doctype] : []);
        return pushStartSingletonElement(chunks, props, type, ctx);
      }
      return pushStartGenericElement(target, props, type, ctx);
    }
    default:
      if (type.indexOf("-") !== -1) {
        // A custom element: any prop is an attribute, objects and false left out.
        target.push(startChunkForTag(type));
        let children = null,
          innerHTML = null;
        for (const k in props) {
          if (!hasOwn.call(props, k)) continue;
          let v = props[k];
          if (v == null) continue;
          let attr = k;
          switch (k) {
            case "children":
              children = v;
              continue;
            case "dangerouslySetInnerHTML":
              innerHTML = v;
              continue;
            case "style":
              pushStyleAttribute(target, v);
              continue;
            case "suppressContentEditableWarning":
            case "suppressHydrationWarning":
            case "ref":
              continue;
            case "className":
              attr = "class";
          }
          if (isAttributeNameSafe(k) && typeof v !== "function" && typeof v !== "symbol" && v !== false) {
            if (v === true) v = "";
            else if (typeof v === "object") continue;
            target.push(" ", attr, '="', escapeText(v), '"');
          }
        }
        pushViewTransitionAttributes(target, ctx);
        target.push(">");
        pushInnerHTML(target, innerHTML, children);
        return children;
      }
  }
  return pushStartGenericElement(target, props, type, ctx);
}

/** Whether a src or srcSet is a data: URL, which needs no preload. */
const isDataURL = (s: Any): boolean =>
  typeof s === "string" &&
  s[4] === ":" &&
  (s[0] === "d" || s[0] === "D") &&
  (s[1] === "a" || s[1] === "A") &&
  (s[2] === "t" || s[2] === "T") &&
  (s[3] === "a" || s[3] === "A");

// #endregion

// #region Resources and render state

type Props = Record<string, Any>;

/** A stylesheet with a precedence: 0 not flushed, 1 preloaded, 2 in the preamble, 3 in a script. */
interface Stylesheet {
  state: number;
  props: Props;
}

/** The style tags and stylesheets of one precedence. */
interface StyleQueue {
  precedence: string;
  rules: string[];
  hrefs: string[];
  sheets: Map<string, Stylesheet>;
}

/** The styles a boundary's content needs before it shows. */
interface HoistableState {
  styles: Set<StyleQueue>;
  stylesheets: Set<Stylesheet>;
  suspenseyImages: boolean;
}

const createHoistableState = (): HoistableState => ({
  styles: new Set(),
  stylesheets: new Set(),
  suspenseyImages: false,
});

function hoistHoistables(parent: HoistableState, child: HoistableState): void {
  child.styles.forEach((q) => parent.styles.add(q));
  child.stylesheets.forEach((s) => parent.stylesheets.add(s));
  if (child.suspenseyImages) parent.suspenseyImages = true;
}

function hasSuspenseyContent(state: HoistableState, flushingInShell: boolean): boolean {
  return flushingInShell ? state.suspenseyImages : state.stylesheets.size > 0 || state.suspenseyImages;
}

/** The <html>, <head> and <body> start tags, written first. */
interface PreambleState {
  htmlChunks: string[] | null;
  headChunks: string[] | null;
  bodyChunks: string[] | null;
}

const createPreambleState = (): PreambleState => ({ htmlChunks: null, headChunks: null, bodyChunks: null });

/** What the render has written once and must not again (React's resumable state). */
interface ResumableState {
  idPrefix: string;
  nextFormID: number;
  /** Instruction scripts already written, as bits. */
  instructions: number;
  hasBody: boolean;
  hasHtml: boolean;
  /** The resources hinted or written, by key (for preloads of other types, by type, then URL). */
  unknownResources: Map<string, Set<string>>;
  dnsResources: Set<string>;
  connectResources: { default: Set<string>; anonymous: Set<string>; credentials: Set<string> };
  imageResources: Set<string>;
  styleResources: Map<string, ResourceState>;
  scriptResources: Map<string, ResourceState>;
  moduleUnknownResources: Map<string, Set<string>>;
  moduleScriptResources: Map<string, ResourceState>;
}

/**
 * A stylesheet or script resource: null once it is written (or loads otherwise), else a preload's
 * credentials, [crossOrigin, integrity], or none ([]), for the element that loads it to adopt.
 */
type ResourceState = string[] | null;
const PRELOAD_NO_CREDS: string[] = [];

function createResumableState(identifierPrefix: string | undefined): ResumableState {
  return {
    idPrefix: identifierPrefix === undefined ? "" : identifierPrefix,
    nextFormID: 0,
    instructions: 0,
    hasBody: false,
    hasHtml: false,
    unknownResources: new Map(),
    dnsResources: new Set(),
    connectResources: { default: new Set(), anonymous: new Set(), credentials: new Set() },
    imageResources: new Set(),
    styleResources: new Map(),
    scriptResources: new Map(),
    moduleUnknownResources: new Map(),
    moduleScriptResources: new Map(),
  };
}

/** The chunks the head collects, and the per-render prefixes and options. */
interface RenderState {
  placeholderPrefix: string;
  segmentPrefix: string;
  boundaryPrefix: string;
  startInlineScript: string;
  startInlineStyle: string;
  preamble: PreambleState;
  bootstrapChunks: string[];
  importMapChunks: string[];
  charsetChunks: string[];
  viewportChunks: string[];
  hoistableChunks: string[];
  preconnects: Set<string[]>;
  fontPreloads: Set<string[]>;
  highImagePreloads: Set<string[]>;
  styles: Map<string, StyleQueue>;
  bootstrapScripts: Set<string[]>;
  scripts: Set<string[]>;
  bulkPreloads: Set<string[]>;
  /**
   * Preloads by URL, emptied when the resource itself is written; images past the first ten, by
   * key, which a later high-priority use promotes.
   */
  preloads: {
    images: Map<string, string[]>;
    stylesheets: Map<string, string[]>;
    scripts: Map<string, string[]>;
    moduleScripts: Map<string, string[]>;
  };
  nonce: { script: string | undefined; style: string | undefined };
  /** onHeaders' Link header as it fills, until it is given (then null); null without onHeaders. */
  headers: HeadersState | null;
  onHeaders: ((headers: Record<string, string>) => void) | undefined;
  stylesToHoist: boolean;
  /** "<!DOCTYPE html>" for streams; renderToString writes none. */
  doctype: string;
  /** renderToStaticMarkup: no text separators or boundary comments. */
  generateStaticMarkup: boolean;
}

/** The Link header's parts, and the room left in it. */
interface HeadersState {
  preconnects: string;
  fontPreloads: string;
  highImagePreloads: string;
  remainingCapacity: number;
}

/** Options of the stream entries that shape the HTML. */
/** The options both stream entries take. */
export interface StreamOptions {
  identifierPrefix?: string;
  namespaceURI?: string;
  nonce?: string | { script?: string; style?: string };
  bootstrapScriptContent?: string;
  bootstrapScripts?: (string | { src: string; integrity?: string; crossOrigin?: string })[];
  bootstrapModules?: (string | { src: string; integrity?: string; crossOrigin?: string })[];
  importMap?: unknown;
  progressiveChunkSize?: number;
  /** The Link header's length at most (2000 by default). */
  maxHeadersLength?: number;
  onError?: (error: unknown, errorInfo: ErrorInfo) => string | void;
  onBrowserBailout?: (error: unknown, errorInfo: ErrorInfo) => void;
  /** A server action's postback (decodeFormState's result): useActionState starts from its state. */
  formState?: ReactFormState | null;
}

/** A postback: the action's state, its key, and the action's reference and bound arguments. */
export type ReactFormState = [unknown, string, string, unknown];

/** renderToReadableStream's options. */
export interface RenderToReadableStreamOptions extends StreamOptions {
  signal?: AbortSignal;
  /** Called once, before the HTML, with a Link header of the hints it can hold. */
  onHeaders?: (headers: Headers) => void;
}

/** renderToPipeableStream's options: the stream options and its callbacks. */
export interface RenderToPipeableStreamOptions extends StreamOptions {
  /** Called once, before the HTML, with the Link header of the hints it can hold. */
  onHeaders?: (headers: { Link?: string }) => void;
  onShellReady?: () => void;
  onShellError?: (error: unknown) => void;
  onAllReady?: () => void;
}

/** Options of renderToString and renderToStaticMarkup. */
export interface ServerOptions {
  identifierPrefix?: string;
}

function pushCompletedShellIdAttribute(target: string[], rs: ResumableState): void {
  if ((rs.instructions & 32) !== 0) return;
  rs.instructions |= 32;
  target.push(' id="', escapeText("_" + rs.idPrefix + "R_"), '"');
}

function createRenderState(
  rs: ResumableState,
  options: StreamOptions | undefined,
  legacy: boolean,
  generateStaticMarkup: boolean,
  onHeaders: ((headers: Record<string, string>) => void) | undefined,
): RenderState {
  const maxHeadersLength = options?.maxHeadersLength;
  const nonceOpt = options?.nonce;
  const nonceScript = typeof nonceOpt === "string" ? nonceOpt : nonceOpt && nonceOpt.script;
  const nonceStyle = typeof nonceOpt === "string" ? undefined : nonceOpt && nonceOpt.style;
  const startInlineScript = nonceScript === undefined ? "<script" : '<script nonce="' + escapeText(nonceScript) + '"';
  const startInlineStyle = nonceStyle === undefined ? "<style" : '<style nonce="' + escapeText(nonceStyle) + '"';
  const idPrefix = rs.idPrefix;
  const bootstrapChunks: string[] = [];
  const content = options?.bootstrapScriptContent;
  if (content !== undefined) {
    bootstrapChunks.push(startInlineScript);
    pushCompletedShellIdAttribute(bootstrapChunks, rs);
    bootstrapChunks.push(">", ("" + content).replace(scriptRegex, scriptReplacer), "</script>");
  }
  const importMapChunks: string[] = [];
  const importMap = options?.importMap;
  if (importMap !== undefined) {
    importMapChunks.push(
      nonceScript === undefined
        ? '<script type="importmap">'
        : '<script type="importmap" nonce="' + escapeText(nonceScript) + '">',
      ("" + JSON.stringify(importMap)).replace(scriptRegex, scriptReplacer),
      "</script>",
    );
  }
  const state: RenderState = {
    placeholderPrefix: idPrefix + "P:",
    segmentPrefix: idPrefix + "S:",
    boundaryPrefix: idPrefix + "B:",
    startInlineScript,
    startInlineStyle,
    preamble: createPreambleState(),
    bootstrapChunks,
    importMapChunks,
    charsetChunks: [],
    viewportChunks: [],
    hoistableChunks: [],
    preconnects: new Set(),
    fontPreloads: new Set(),
    highImagePreloads: new Set(),
    styles: new Map(),
    bootstrapScripts: new Set(),
    scripts: new Set(),
    bulkPreloads: new Set(),
    preloads: { images: new Map(), stylesheets: new Map(), scripts: new Map(), moduleScripts: new Map() },
    nonce: { script: nonceScript, style: nonceStyle },
    headers: onHeaders
      ? {
          preconnects: "",
          fontPreloads: "",
          highImagePreloads: "",
          remainingCapacity: 2 + (typeof maxHeadersLength === "number" ? maxHeadersLength : 2000),
        }
      : null,
    onHeaders,
    stylesToHoist: false,
    doctype: legacy ? "" : "<!DOCTYPE html>",
    generateStaticMarkup,
  };
  // Bootstrap scripts: preloaded at low priority in the head, run after the shell.
  const bootstrap = (list: Any[] | undefined, module: boolean): void => {
    if (list === undefined) return;
    for (const config of list) {
      let src: string, integrity: string | undefined, crossOrigin: string | undefined;
      const props: Props = module
        ? { rel: "modulepreload", fetchPriority: "low", nonce: nonceScript }
        : { rel: "preload", as: "script", fetchPriority: "low", nonce: nonceOpt };
      if (typeof config === "string") props["href"] = src = config;
      else {
        props["href"] = src = config.src;
        props["integrity"] = integrity = typeof config.integrity === "string" ? config.integrity : undefined;
        props["crossOrigin"] = crossOrigin =
          config.crossOrigin == null ? undefined : config.crossOrigin === "use-credentials" ? "use-credentials" : "";
      }
      rs.scriptResources.set(src, null);
      rs.moduleScriptResources.set(src, null);
      const link: string[] = [];
      pushLinkImpl(link, props);
      state.bootstrapScripts.add(link);
      bootstrapChunks.push(module ? '<script type="module" src="' : '<script src="', escapeText(src), '"');
      if (nonceScript) bootstrapChunks.push(' nonce="', escapeText(nonceScript), '"');
      if (typeof integrity === "string") bootstrapChunks.push(' integrity="', escapeText(integrity), '"');
      if (typeof crossOrigin === "string") bootstrapChunks.push(' crossorigin="', escapeText(crossOrigin), '"');
      pushCompletedShellIdAttribute(bootstrapChunks, rs);
      bootstrapChunks.push(' async="">', "</script>");
    }
  };
  bootstrap(options?.bootstrapScripts, false);
  bootstrap(options?.bootstrapModules, true);
  return state;
}

// #endregion

// #endregion

// #region Resource hints

// ReactDOM's preload, preinit and the rest, while a request works (React's server dispatcher):
// compat's react-dom functions check their options as React's do and pass what they keep here.
// Like React's browser and Bun builds, a hint reaches the request only from code its work runs.
// (React's Node build, and its edge build where AsyncLocalStorage exists, also take hints made
// later in a promise callback the render started.)

/** The request working now: hints go to it. */
let currentRequest: Request | null = null;

const credentialsOf = (options: Any): ResourceState =>
  !options || (typeof options.crossOrigin !== "string" && typeof options.integrity !== "string")
    ? PRELOAD_NO_CREDS
    : [options.crossOrigin, options.integrity];

function adoptPreloadCredentials(props: Props, state: string[]): void {
  if (props["crossOrigin"] == null) props["crossOrigin"] = state[0];
  if (props["integrity"] == null) props["integrity"] = state[1];
}

/** A stylesheet that was preloaded: its preload goes unwritten, or it was written already. */
function adoptPreload(sheet: Stylesheet, state: string[], preload: string[] | undefined): void {
  if (state.length === 2) adoptPreloadCredentials(sheet.props, state);
  if (preload && preload.length > 0) preload.length = 0;
  else sheet.state = 1;
}

/** A preload of another type: once per type and URL. Whether it was new. */
function addUnknown(resources: Map<string, Set<string>>, as: string, href: string): boolean {
  let hrefs = resources.get(as);
  if (hrefs === undefined) resources.set(as, (hrefs = new Set()));
  else if (hrefs.has(href)) return false;
  hrefs.add(href);
  return true;
}

function linkOf(props: Props): string[] {
  const link: string[] = [];
  pushLinkImpl(link, props);
  return link;
}

/** preinit's script or preinitModule's: written once, adopting a preload's credentials. */
function preinitScriptAs(src: string, options: Any, module: boolean): void {
  const request = currentRequest!;
  const resources = module ? request.resumableState.moduleScriptResources : request.resumableState.scriptResources;
  const resourceState = resources.get(src);
  if (!src || resourceState === null) return;
  resources.set(src, null);
  const props: Props = module ? { src, type: "module", async: true, ...options } : { src, async: true, ...options };
  const state = request.renderState;
  if (resourceState) {
    if (resourceState.length === 2) adoptPreloadCredentials(props, resourceState);
    const preload = (module ? state.preloads.moduleScripts : state.preloads.scripts).get(src);
    if (preload) preload.length = 0;
  }
  const script: string[] = [];
  state.scripts.add(script);
  pushScriptImpl(script, props);
}

// onHeaders' Link header: URLs and quoted parameters escaped as React escapes them.
const linkHeaderEscapes: Record<string, string> = {
  "<": "%3C",
  ">": "%3E",
  "\n": "%0A",
  "\r": "%0D",
  '"': "%22",
  "'": "%27",
  ";": "%3B",
  ",": "%2C",
};
const linkHeaderEscape = (c: string): string => linkHeaderEscapes[c]!;
const escapeHrefForHeader = (href: string): string => ("" + href).replace(/[<>\r\n]/g, linkHeaderEscape);
const escapeParamForHeader = (value: string): string => ("" + value).replace(/["';,\r\n]/g, linkHeaderEscape);

/** A preload as a Link header entry, with its string options as parameters. */
function getPreloadAsHeader(href: string, as: string, params: Any): string {
  let header = "<" + escapeHrefForHeader(href) + '>; rel=preload; as="' + escapeParamForHeader(as) + '"';
  for (const name in params) {
    const value = params[name];
    if (hasOwn.call(params, name) && typeof value === "string")
      header += "; " + name.toLowerCase() + '="' + escapeParamForHeader(value) + '"';
  }
  return header;
}

// The entry fitsHeader last measured, to append when it fits.
let lastHeader = "";
/** Whether `header` fits in the Link header; its length (and a separator's) is taken either way. */
function fitsHeader(headers: HeadersState, header: string): boolean {
  lastHeader = header;
  return (headers.remainingCapacity -= header.length + 2) >= 0;
}
const appendHeader = (list: string, header: string): string => (list ? list + ", " + header : header);

/** Give onHeaders its Link header, once: when the first work ends, or the shell or all is done. */
function safelyEmitEarlyPreloads(request: Request, shellComplete: boolean): void {
  try {
    const state = request.renderState,
      headers = state.headers;
    if (headers === null) return;
    state.headers = null;
    let link = headers.preconnects;
    if (headers.fontPreloads) link = appendHeader(link, headers.fontPreloads);
    if (headers.highImagePreloads) link = appendHeader(link, headers.highImagePreloads);
    // While the shell renders, its stylesheets too, as long as they fit.
    if (!shellComplete)
      outer: for (const queue of state.styles.values())
        for (const sheet of queue.sheets.values()) {
          if (headers.remainingCapacity <= 0) break outer;
          const props = sheet.props;
          const header = getPreloadAsHeader(props["href"], "style", {
            crossOrigin: props["crossOrigin"],
            integrity: props["integrity"],
            nonce: props["nonce"],
            type: props["type"],
            fetchPriority: props["fetchPriority"],
            referrerPolicy: props["referrerPolicy"],
            media: props["media"],
          });
          if (!fitsHeader(headers, header)) break outer;
          link = appendHeader(link, header);
        }
    state.onHeaders!(link ? { Link: link } : {});
  } catch (error) {
    logRecoverableError(request, error, {});
  }
}

const serverHints = {
  "dns-prefetch"(href: string): void {
    const request = currentRequest!,
      dns = request.resumableState.dnsResources;
    if (!href || dns.has(href)) return;
    dns.add(href);
    const headers = request.renderState.headers;
    if (
      headers &&
      headers.remainingCapacity > 0 &&
      fitsHeader(headers, "<" + escapeHrefForHeader(href) + ">; rel=dns-prefetch")
    )
      headers.preconnects = appendHeader(headers.preconnects, lastHeader);
    else request.renderState.preconnects.add(linkOf({ href, rel: "dns-prefetch" }));
  },
  preconnect(href: string, crossOrigin: string | null | undefined): void {
    const request = currentRequest!,
      connect = request.resumableState.connectResources;
    const bucket =
      crossOrigin === "use-credentials"
        ? connect.credentials
        : typeof crossOrigin === "string"
          ? connect.anonymous
          : connect.default;
    if (!href || bucket.has(href)) return;
    bucket.add(href);
    const headers = request.renderState.headers;
    if (
      headers &&
      headers.remainingCapacity > 0 &&
      fitsHeader(
        headers,
        "<" +
          escapeHrefForHeader(href) +
          ">; rel=preconnect" +
          (typeof crossOrigin === "string" ? '; crossorigin="' + escapeParamForHeader(crossOrigin) + '"' : ""),
      )
    )
      headers.preconnects = appendHeader(headers.preconnects, lastHeader);
    else request.renderState.preconnects.add(linkOf({ rel: "preconnect", href, crossOrigin }));
  },
  L(href: string, as: string, options: Any): void {
    const request = currentRequest!,
      rs = request.resumableState,
      state = request.renderState;
    if (!as || !href) return;
    switch (as) {
      case "image": {
        const imageSrcSet = options.imageSrcSet;
        const key = imageSrcSet ? imageSrcSet + "\n" + (options.imageSizes || "") : href;
        if (rs.imageResources.has(key)) return;
        rs.imageResources.add(key);
        const headers = state.headers;
        if (
          headers &&
          headers.remainingCapacity > 0 &&
          typeof imageSrcSet !== "string" &&
          options.fetchPriority === "high" &&
          fitsHeader(headers, getPreloadAsHeader(href, as, options))
        ) {
          headers.highImagePreloads = appendHeader(headers.highImagePreloads, lastHeader);
          return;
        }
        const link = linkOf({ rel: "preload", href: imageSrcSet ? undefined : href, as, ...options });
        if (options.fetchPriority === "high") state.highImagePreloads.add(link);
        else {
          state.bulkPreloads.add(link);
          state.preloads.images.set(key, link);
        }
        return;
      }
      case "style":
      case "script": {
        const resources = as === "style" ? rs.styleResources : rs.scriptResources;
        if (resources.has(href)) return;
        const link = linkOf({ rel: "preload", href, as, ...options });
        resources.set(href, credentialsOf(options));
        (as === "style" ? state.preloads.stylesheets : state.preloads.scripts).set(href, link);
        state.bulkPreloads.add(link);
        return;
      }
    }
    if (!addUnknown(rs.unknownResources, as, href)) return;
    const headers = state.headers;
    if (
      headers &&
      headers.remainingCapacity > 0 &&
      as === "font" &&
      fitsHeader(headers, getPreloadAsHeader(href, as, options))
    )
      headers.fontPreloads = appendHeader(headers.fontPreloads, lastHeader);
    else
      (as === "font" ? state.fontPreloads : state.bulkPreloads).add(linkOf({ rel: "preload", href, as, ...options }));
  },
  m(href: string, options: Any): void {
    const request = currentRequest!,
      rs = request.resumableState,
      state = request.renderState;
    if (!href) return;
    const as = options && typeof options.as === "string" ? options.as : "script";
    if (as === "script") {
      if (rs.moduleScriptResources.has(href)) return;
      rs.moduleScriptResources.set(href, credentialsOf(options));
    } else if (!addUnknown(rs.moduleUnknownResources, as, href)) return;
    const link = linkOf({ rel: "modulepreload", href, ...options });
    if (as === "script") state.preloads.moduleScripts.set(href, link);
    state.bulkPreloads.add(link);
  },
  S(href: string, precedence: string | undefined, options: Any): void {
    const request = currentRequest!,
      rs = request.resumableState,
      state = request.renderState;
    if (!href) return;
    const prec = precedence || "default";
    const resourceState = rs.styleResources.get(href);
    if (resourceState === null) return;
    rs.styleResources.set(href, null);
    let queue = state.styles.get(prec);
    if (!queue) {
      queue = { precedence: escapeText(prec), rules: [], hrefs: [], sheets: new Map() };
      state.styles.set(prec, queue);
    }
    const sheet: Stylesheet = { state: 0, props: { rel: "stylesheet", href, "data-precedence": prec, ...options } };
    if (resourceState) adoptPreload(sheet, resourceState, state.preloads.stylesheets.get(href));
    queue.sheets.set(href, sheet);
  },
  X: preinitScriptAs,
};

// #endregion

// #region Format contexts

// Insertion modes: where an element is (React's insertionMode).
const ROOT_HTML_MODE = 0;
const HTML_HTML_MODE = 1;
const HTML_MODE = 2;
const HTML_HEAD_MODE = 3;
const SVG_MODE = 4;
const MATHML_MODE = 5;
const HTML_TABLE_MODE = 6;
const HTML_TABLE_BODY_MODE = 7;
const HTML_TABLE_ROW_MODE = 8;
const HTML_COLGROUP_MODE = 9;

// Tag scopes (bits): inside <noscript>, <picture>, a Suspense fallback (two bits), Suspense
// content, a view transition's update or enter.
const NOSCRIPT_SCOPE = 1;
const PICTURE_SCOPE = 2;
const FALLBACK_SCOPE = 4;

/** A view transition's classes and name, for the elements under a <ViewTransition>. */
interface ViewTransitionContext {
  update: string;
  enter: string;
  exit: string;
  share: string;
  parentEnter: string;
  parentExit: string;
  name: string;
  autoName: string;
  nameIdx: number;
}

/** Where an element renders: mode, the select's value, scope bits and the view transition. */
interface FormatContext {
  insertionMode: number;
  selectedValue: Any;
  tagScope: number;
  viewTransition: ViewTransitionContext | null;
}

const formatContext = (
  insertionMode: number,
  selectedValue: Any,
  tagScope: number,
  viewTransition: ViewTransitionContext | null,
): FormatContext => ({ insertionMode, selectedValue, tagScope, viewTransition });

function createRootFormatContext(namespaceURI: string | undefined): FormatContext {
  return formatContext(
    namespaceURI === "http://www.w3.org/2000/svg"
      ? SVG_MODE
      : namespaceURI === "http://www.w3.org/1998/Math/MathML"
        ? MATHML_MODE
        : ROOT_HTML_MODE,
    null,
    0,
    null,
  );
}

function getChildFormatContext(parent: FormatContext, type: string, props: Props): FormatContext {
  const scope = parent.tagScope & -25;
  switch (type) {
    case "noscript":
      return formatContext(HTML_MODE, null, scope | NOSCRIPT_SCOPE, null);
    case "select":
      return formatContext(HTML_MODE, valueOf(props), scope, null);
    case "svg":
      return formatContext(SVG_MODE, null, scope, null);
    case "picture":
      return formatContext(HTML_MODE, null, scope | PICTURE_SCOPE, null);
    case "math":
      return formatContext(MATHML_MODE, null, scope, null);
    case "foreignObject":
      return formatContext(HTML_MODE, null, scope, null);
    case "table":
      return formatContext(HTML_TABLE_MODE, null, scope, null);
    case "thead":
    case "tbody":
    case "tfoot":
      return formatContext(HTML_TABLE_BODY_MODE, null, scope, null);
    case "colgroup":
      return formatContext(HTML_COLGROUP_MODE, null, scope, null);
    case "tr":
      return formatContext(HTML_TABLE_ROW_MODE, null, scope, null);
    case "head":
      if (parent.insertionMode < HTML_MODE) return formatContext(HTML_HEAD_MODE, null, scope, null);
      break;
    case "html":
      if (parent.insertionMode === ROOT_HTML_MODE) return formatContext(HTML_HTML_MODE, null, scope, null);
  }
  return parent.insertionMode >= HTML_TABLE_MODE || parent.insertionMode < HTML_MODE
    ? formatContext(HTML_MODE, null, scope, null)
    : parent.viewTransition !== null || parent.tagScope !== scope
      ? formatContext(parent.insertionMode, parent.selectedValue, scope, null)
      : parent;
}

function getSuspenseViewTransition(parent: ViewTransitionContext | null): ViewTransitionContext | null {
  return parent === null
    ? null
    : {
        update: parent.update,
        enter: "none",
        exit: "none",
        share: parent.update,
        parentEnter: "none",
        parentExit: "none",
        name: parent.autoName,
        autoName: parent.autoName,
        nameIdx: 0,
      };
}

function getSuspenseFallbackFormatContext(rs: ResumableState, parent: FormatContext): FormatContext {
  if (parent.tagScope & 32) rs.instructions |= 128;
  return formatContext(
    parent.insertionMode,
    parent.selectedValue,
    parent.tagScope | 12,
    getSuspenseViewTransition(parent.viewTransition),
  );
}

function getSuspenseContentFormatContext(_rs: ResumableState, parent: FormatContext): FormatContext {
  const vt = getSuspenseViewTransition(parent.viewTransition);
  let scope = parent.tagScope | 16;
  if (vt !== null && vt.share !== "none") scope |= 64;
  return formatContext(parent.insertionMode, parent.selectedValue, scope, vt);
}

function viewTransitionClass(defaultClass: Any, eventClass: Any): Any {
  defaultClass = defaultClass == null || typeof defaultClass === "string" ? defaultClass : defaultClass.default;
  eventClass = eventClass == null || typeof eventClass === "string" ? eventClass : eventClass.default;
  return eventClass == null
    ? defaultClass === "auto"
      ? null
      : defaultClass
    : eventClass === "auto"
      ? null
      : eventClass;
}

// #endregion

// #region Tree ids and context values

/** A component's place in the tree, as React's server tracks it for useId. */
interface TreeContext {
  id: number;
  overflow: string;
}

const emptyTreeContext: TreeContext = { id: 1, overflow: "" };

function getTreeId(ctx: TreeContext): string {
  const id = ctx.id;
  return (id & ~(1 << (32 - Math.clz32(id) - 1))).toString(32) + ctx.overflow;
}

/** The tree context of child `index` of `total` under `base`. */
function pushTreeContext(base: TreeContext, total: number, index: number): TreeContext {
  let baseId = base.id;
  const baseOverflow = base.overflow;
  let baseLength = 32 - Math.clz32(baseId) - 1;
  baseId &= ~(1 << baseLength);
  const slot = index + 1;
  const length = 32 - Math.clz32(total) + baseLength;
  if (length > 30) {
    // The id would not fit in 32 bits: the low bits move to the overflow string.
    const overflowBits = baseLength - (baseLength % 5);
    const overflow = (baseId & ((1 << overflowBits) - 1)).toString(32);
    baseId >>= overflowBits;
    baseLength -= overflowBits;
    return {
      id: (1 << (32 - Math.clz32(total) + baseLength)) | (slot << baseLength) | baseId,
      overflow: overflow + baseOverflow,
    };
  }
  return { id: (1 << length) | (slot << baseLength) | baseId, overflow: baseOverflow };
}

function makeId(rs: ResumableState, treeId: string, localId: number): string {
  let id = "_" + rs.idPrefix + "R_" + treeId;
  if (localId > 0) id += "H" + localId.toString(32);
  return id + "_";
}

/** A provided context value, linked to the one it shadows: a task's context is the innermost. */
interface ContextNode {
  parent: ContextNode | null;
  depth: number;
  context: Any;
  parentValue: Any;
  value: Any;
}

// The context values set on the context objects now.
let currentSnapshot: ContextNode | null = null;

function popToNearestCommonAncestor(prev: ContextNode, next: ContextNode): void {
  if (prev === next) return;
  prev.context._currentValue = prev.parentValue;
  // Both chains have the same depth here, so their parents are both null or both not.
  if (prev.parent !== null) popToNearestCommonAncestor(prev.parent, next.parent!);
  next.context._currentValue = next.value;
}

function popAllPrevious(prev: ContextNode): void {
  prev.context._currentValue = prev.parentValue;
  if (prev.parent !== null) popAllPrevious(prev.parent);
}

function pushAllNext(next: ContextNode): void {
  if (next.parent !== null) pushAllNext(next.parent);
  next.context._currentValue = next.value;
}

function popPreviousToCommonLevel(prev: ContextNode, next: ContextNode): void {
  prev.context._currentValue = prev.parentValue;
  const parent = prev.parent!;
  if (parent.depth === next.depth) popToNearestCommonAncestor(parent, next);
  else popPreviousToCommonLevel(parent, next);
}

function popNextToCommonLevel(prev: ContextNode, next: ContextNode): void {
  const parent = next.parent!;
  if (prev.depth === parent.depth) popToNearestCommonAncestor(prev, parent);
  else popNextToCommonLevel(prev, parent);
  next.context._currentValue = next.value;
}

/** Set the context objects' values to those of `next`, undoing the current ones. */
function switchContext(next: ContextNode | null): void {
  const prev = currentSnapshot;
  if (prev === next) return;
  if (prev === null) pushAllNext(next!);
  else if (next === null) popAllPrevious(prev);
  else if (prev.depth === next.depth) popToNearestCommonAncestor(prev, next);
  else if (prev.depth > next.depth) popPreviousToCommonLevel(prev, next);
  else popNextToCommonLevel(prev, next);
  currentSnapshot = next;
}

// #endregion

// #region The request

// Request status.
const OPENING = 10;
const OPEN = 11;
const ABORTING = 12;
const CLOSED = 13;

// Segment and boundary status.
const PENDING = 0;
const COMPLETED = 1;
const FLUSHED = 2;
const ABORTED = 3;
const ERRORED = 4;

/** Where flushed HTML goes, through views of bytes as React's builds write them. */
interface Destination {
  /** Write a chunk; whether the destination has had room for every write since the views began. */
  push(chunk: string): boolean;
  /** Write into new views, the destination's room forgotten (a flush's start, and its middle). */
  begin(): void;
  /** Hand over the view written so far. */
  complete(): void;
  /** The end of one flush, after complete: the destination's own flush. */
  flush(): void;
  /** The render is done: no more chunks. */
  close(): void;
  /** The render failed. */
  error(e: unknown): void;
}

/** A run of output: its chunks, with the segments of nested suspended work at their positions. */
interface Segment {
  status: number;
  parentFlushed: boolean;
  id: number;
  index: number;
  chunks: string[];
  children: Segment[];
  preambleChildren: Segment[];
  parentFormatContext: FormatContext;
  boundary: Boundary | null;
  lastPushedText: boolean;
  textEmbedded: boolean;
}

/** A Suspense boundary: its content's state and segments, and its fallback's. */
interface Boundary {
  status: number;
  rootSegmentID: number;
  parentFlushed: boolean;
  pendingTasks: number;
  row: Row | null;
  completedSegments: Segment[];
  byteSize: number;
  defer: boolean;
  fallbackAbortableTasks: Set<Task>;
  errorDigest: Any;
  contentState: HoistableState;
  fallbackState: HoistableState;
  preamble: { content: PreambleState; fallback: PreambleState } | null;
}

/** A row of a <SuspenseList>, which reveals its boundaries in order. */
interface Row {
  pendingTasks: number;
  boundaries: Boundary[] | null;
  hoistables: HoistableState;
  inheritedHoistables: HoistableState | null;
  together: boolean;
  next: Row | null;
}

/** A unit of work: a node to render into a segment, retried when what it waits for settles. */
interface Task {
  node: Any;
  childIndex: number;
  ping: () => void;
  blockedBoundary: Boundary | null;
  blockedSegment: Segment;
  blockedPreamble: PreambleState | null;
  hoistableState: HoistableState | null;
  abortSet: Set<Task>;
  formatContext: FormatContext;
  context: ContextNode | null;
  treeContext: TreeContext;
  row: Row | null;
  /** The elements from the root to the node rendering, for errors' component stacks. */
  componentStack: StackNode | null;
  /** The promises the suspended component used, in order: it reads them again when it retries. */
  thenableState: Any[] | null;
  /** The element path to the node rendering, as React keeps it: useActionState's form keys hash it. */
  keyPath: KeyPath | null;
}

/** A step of an element path: the parent's path, the element's type name, its key or index. */
type KeyPath = [KeyPath | null, string | null, string | number];

interface Request {
  /** renderToString and renderToStaticMarkup: legacy's flush rules and no doctype. */
  legacy: boolean;
  destination: Destination | null;
  flushScheduled: boolean;
  resumableState: ResumableState;
  renderState: RenderState;
  progressiveChunkSize: number;
  status: number;
  fatalError: Any;
  aborted: boolean;
  pendingRootTasks: number;
  allPendingTasks: number;
  nextSegmentId: number;
  completedRootSegment: Segment | null;
  completedPreambleSegments: Segment[][] | null;
  byteSize: number;
  abortableTasks: Set<Task>;
  pingedTasks: Task[];
  currentTask: Task | null;
  clientRenderedBoundaries: Boundary[];
  completedBoundaries: Boundary[];
  partialBoundaries: Boundary[];
  onError: (error: unknown, info: ErrorInfo) => Any;
  onBrowserBailout: (error: unknown, info: ErrorInfo) => void;
  onAllReady: () => void;
  onShellReady: () => void;
  onShellError: (error: unknown) => void;
  onFatalError: (error: unknown) => void;
  /** Stops listening to the abort signal when the render ends. */
  lifetime: AbortController | null;
  /** Runs a callback in a task of its own (the legacy entries run it at once). */
  scheduleWork: (fn: () => void) => void;
  /** The postback's state, key and action, from the server action's response (streams only). */
  formState: ReactFormState | null;
  /** The hash of useActionState keys: MD5 for renderToPipeableStream, else MurmurHash3. */
  hash: (key: string) => string | number;
}

/** React's default onError: logs the error, gives no digest. */
function defaultErrorHandler(error: unknown): null {
  console.error(error);
  return null;
}

interface RequestOptions {
  legacy: boolean;
  generateStaticMarkup: boolean;
  options: StreamOptions | undefined;
  progressiveChunkSize: number | undefined;
  onAllReady?: (() => void) | undefined;
  onShellReady?: (() => void) | undefined;
  onShellError?: ((error: unknown) => void) | undefined;
  onFatalError?: ((error: unknown) => void) | undefined;
  onHeaders?: ((headers: Record<string, string>) => void) | undefined;
  scheduleWork: (fn: () => void) => void;
  /** renderToPipeableStream: React's Node build, whose form keys are MD5 hashes. */
  md5?: boolean;
}

function createRequest(children: Any, o: RequestOptions): Request {
  const rs = createResumableState(o.options?.identifierPrefix);
  const rootContext = o.legacy
    ? formatContext(ROOT_HTML_MODE, null, 0, null)
    : createRootFormatContext(o.options?.namespaceURI);
  const request: Request = {
    legacy: o.legacy,
    destination: null,
    flushScheduled: false,
    resumableState: rs,
    renderState: createRenderState(rs, o.legacy ? undefined : o.options, o.legacy, o.generateStaticMarkup, o.onHeaders),
    progressiveChunkSize: o.progressiveChunkSize === undefined ? 12800 : o.progressiveChunkSize,
    status: OPENING,
    fatalError: null,
    aborted: false,
    pendingRootTasks: 0,
    allPendingTasks: 0,
    nextSegmentId: 0,
    completedRootSegment: null,
    completedPreambleSegments: null,
    byteSize: 0,
    abortableTasks: new Set(),
    pingedTasks: [],
    currentTask: null,
    clientRenderedBoundaries: [],
    completedBoundaries: [],
    partialBoundaries: [],
    onError: o.options?.onError ?? (o.legacy ? noop : defaultErrorHandler),
    onBrowserBailout: o.options?.onBrowserBailout ?? noop,
    onAllReady: o.onAllReady ?? noop,
    onShellReady: o.onShellReady ?? noop,
    onShellError: o.onShellError ?? noop,
    onFatalError: o.onFatalError ?? noop,
    lifetime: null,
    scheduleWork: o.scheduleWork,
    formState: o.legacy ? null : (o.options?.formState ?? null),
    hash: o.md5 ? md5 : murmurhash3,
  };
  const root = createPendingSegment(request, 0, null, rootContext, false, false);
  root.parentFlushed = true;
  const task = createRenderTask(
    request,
    children,
    -1,
    null,
    root,
    null,
    null,
    request.abortableTasks,
    null,
    rootContext,
    null,
    emptyTreeContext,
    null,
    null,
  );
  pushComponentStack(task);
  request.pingedTasks.push(task);
  return request;
}

function pingTask(request: Request, task: Task): void {
  request.pingedTasks.push(task);
  if (request.pingedTasks.length === 1) {
    request.flushScheduled = request.destination !== null;
    if (request.status === OPENING) queueMicrotask(() => performWork(request));
    else request.scheduleWork(() => performWork(request));
  }
}

function createSuspenseBoundary(
  request: Request,
  row: Row | null,
  fallbackAbortableTasks: Set<Task>,
  preamble: Boundary["preamble"],
): Boundary {
  const boundary: Boundary = {
    status: PENDING,
    rootSegmentID: -1,
    parentFlushed: false,
    pendingTasks: 0,
    row,
    completedSegments: [],
    byteSize: 0,
    defer: false,
    fallbackAbortableTasks,
    errorDigest: null,
    contentState: createHoistableState(),
    fallbackState: createHoistableState(),
    preamble,
  };
  if (row !== null) {
    row.pendingTasks++;
    const boundaries = row.boundaries;
    if (boundaries !== null) {
      request.allPendingTasks++;
      boundary.pendingTasks++;
      boundaries.push(boundary);
    }
    if (row.inheritedHoistables !== null) hoistHoistables(boundary.contentState, row.inheritedHoistables);
  }
  return boundary;
}

function createRenderTask(
  request: Request,
  node: Any,
  childIndex: number,
  blockedBoundary: Boundary | null,
  blockedSegment: Segment,
  blockedPreamble: PreambleState | null,
  hoistableState: HoistableState | null,
  abortSet: Set<Task>,
  keyPath: KeyPath | null,
  formatContext: FormatContext,
  context: ContextNode | null,
  treeContext: TreeContext,
  row: Row | null,
  componentStack: StackNode | null,
): Task {
  request.allPendingTasks++;
  if (blockedBoundary === null) request.pendingRootTasks++;
  else blockedBoundary.pendingTasks++;
  if (row !== null) row.pendingTasks++;
  const task: Task = {
    node,
    childIndex,
    ping: () => pingTask(request, task),
    blockedBoundary,
    blockedSegment,
    blockedPreamble,
    hoistableState,
    abortSet,
    formatContext,
    context,
    treeContext,
    row,
    componentStack,
    thenableState: null,
    keyPath,
  };
  abortSet.add(task);
  return task;
}

function createPendingSegment(
  _request: Request,
  index: number,
  boundary: Boundary | null,
  parentFormatContext: FormatContext,
  lastPushedText: boolean,
  textEmbedded: boolean,
): Segment {
  return {
    status: PENDING,
    parentFlushed: false,
    id: -1,
    index,
    chunks: [],
    children: [],
    preambleChildren: [],
    parentFormatContext,
    boundary,
    lastPushedText,
    textEmbedded,
  };
}

/** An onError digest: the string it returned, else none. Browser bailouts go to their own callback. */
function logRecoverableError(request: Request, error: Any, info: ErrorInfo): Any {
  if (isRecoverableError(error)) {
    request.onBrowserBailout(error, info);
    return "";
  }
  const digest = request.onError(error, info);
  if (digest == null || typeof digest === "string") return digest === "" ? undefined : digest;
  return undefined;
}

function fatalError(request: Request, error: Any): void {
  if (request.pendingRootTasks !== 0) request.onShellError(error);
  request.onFatalError(error);
  endRenderLifetime(request);
  if (request.destination !== null) {
    request.status = CLOSED;
    request.destination.error(error);
  } else {
    request.status = ABORTING;
    if (!request.aborted) request.fatalError = error;
  }
}

function endRenderLifetime(request: Request): void {
  if (request.lifetime !== null) request.lifetime.abort("The render ended.");
}

// #endregion

// #region browser() tokens

/** The error a browser() token raises on the server: its boundary renders on the client. */
function createRecoverableError(token: Any): Error {
  const reason = token._reason;
  let initialized: Any;
  if (typeof reason === "function") {
    try {
      initialized = reason();
    } catch {
      initialized = "The reason for browser-only rendering could not be determined because its initializer threw.";
    }
  } else initialized = reason;
  const error = new Error(
    "Browser-only rendering was requested by `browser()`.",
    reason === undefined ? undefined : { cause: initialized },
  );
  Object.defineProperty(error, RECOVERABLE_TYPE, { value: true });
  return error;
}

const isRecoverableError = (error: Any): boolean =>
  typeof error === "object" && error !== null && error[RECOVERABLE_TYPE] === true;

/** A browser() token outside any boundary: the whole render fails, with this error. */
function cloneRecoverableErrorAsFatal(error: Any): Error {
  const fatal = new Error(
    "The server render could not complete because client rendering was requested outside a Suspense boundary. See this error's cause for additional details.",
    hasOwn.call(error, "cause") ? { cause: error.cause } : undefined,
  );
  const stack: string | undefined = error.stack;
  if (stack !== undefined) {
    const frame = stack.indexOf("\n");
    fatal.stack = fatal.name + ": " + fatal.message + (frame === -1 ? "" : stack.slice(frame));
  } else fatal.stack = undefined as Any;
  return fatal;
}

// #endregion

// #region Component stacks

// React's production component stacks: the element types from the root to where an error was
// thrown, each described when onError first reads `componentStack` (describing calls components).
// A component's frame is read from a native stack: it is called without props (a class is
// constructed without them) so that it throws, and the frame below the probe's own is its line.
// The frames are formatted as React's browser, Bun and legacy builds format them (its Node and
// edge builds format them with an Error.prepareStackTrace of their own).

/** What onError and onBrowserBailout receive with an error. */
export interface ErrorInfo {
  componentStack?: string;
}

/** One element of a component stack, and the elements above it. */
interface StackNode {
  parent: StackNode | null;
  type: Any;
}

function pushComponentStack(task: Task): void {
  const node = task.node;
  if (typeof node === "object" && node !== null && node.$$typeof === ELEMENT)
    task.componentStack = { parent: task.componentStack, type: node.type };
}

/** A fallback's stack: the boundary's, with the boundary named as its fallback. */
const fallbackStack = (stack: StackNode | null): StackNode | null =>
  stack === null ? null : { parent: stack.parent, type: "Suspense Fallback" };

// How this engine writes a frame: "    at " before the name and " (<anonymous>)" after it in V8,
// JavaScriptCore and Bun; "name@unknown:0:0" in Firefox.
let framePrefix: string | undefined,
  frameSuffix = "";
function describeBuiltInComponentFrame(name: string): string {
  if (framePrefix === undefined) {
    const stack = new Error().stack!;
    const match = stack.trim().match(/\n( *(at )?)/);
    framePrefix = (match && match[1]) || "";
    frameSuffix = stack.indexOf("\n    at") > -1 ? " (<anonymous>)" : stack.indexOf("@") > -1 ? "@unknown:0:0" : "";
  }
  return "\n" + framePrefix + name + frameSuffix;
}

let describing = false;
/** The native frame of component `fn` (a class when `construct`), else a frame with its name. */
function describeNativeComponentFrame(fn: Any, construct: boolean): string {
  if (!fn || describing) return "";
  describing = true;
  const ErrorCtor: Any = Error;
  const prevPrepare = ErrorCtor.prepareStackTrace;
  ErrorCtor.prepareStackTrace = undefined;
  try {
    // The probe: its name marks the frame both stacks share.
    const RunInRootFrame = {
      DetermineComponentFrameRoot(): (string | null)[] {
        let control: Any;
        try {
          if (construct) {
            const Fake = function (): void {
              throw Error();
            };
            Object.defineProperty(Fake.prototype, "props", {
              set() {
                throw Error();
              },
            });
            try {
              Reflect.construct(Fake, []);
            } catch (x) {
              control = x;
            }
            Reflect.construct(fn, [], Fake);
          } else {
            try {
              throw Error();
            } catch (x) {
              control = x;
            }
            const out = fn();
            if (out && typeof out.catch === "function") out.catch(noop);
          }
        } catch (sample: Any) {
          if (sample && control && typeof sample.stack === "string") return [sample.stack, control.stack];
        }
        return [null, null];
      },
    };
    const [sampleStack, controlStack] = RunInRootFrame.DetermineComponentFrameRoot();
    if (sampleStack && controlStack) {
      const sampleLines = sampleStack.split("\n"),
        controlLines = controlStack.split("\n");
      let s = 0,
        c = 0;
      while (s < sampleLines.length && !sampleLines[s]!.includes("DetermineComponentFrameRoot")) s++;
      while (c < controlLines.length && !controlLines[c]!.includes("DetermineComponentFrameRoot")) c++;
      // The probe's frame is missing (a short stack): line the stacks up from their ends.
      if (s === sampleLines.length || c === controlLines.length)
        for (
          s = sampleLines.length - 1, c = controlLines.length - 1;
          s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c];
        )
          c--;
      for (; s >= 1 && c >= 0; s--, c--)
        if (sampleLines[s] !== controlLines[c]) {
          // The frame above the first that differs is the component's (React's loop, unrolled).
          if (s !== 1 || c !== 1) {
            do (s--, c--);
            while (c >= 0 && sampleLines[s] === controlLines[c] && s >= 1);
            if (c < 0 || sampleLines[s] !== controlLines[c]) {
              let frame = "\n" + sampleLines[s]!.replace(" at new ", " at ");
              if (fn.displayName && frame.includes("<anonymous>")) frame = frame.replace("<anonymous>", fn.displayName);
              return frame;
            }
          }
          break;
        }
    }
  } finally {
    describing = false;
    ErrorCtor.prepareStackTrace = prevPrepare;
  }
  const name = fn.displayName || fn.name;
  return name ? describeBuiltInComponentFrame(name) : "";
}

function describeComponentStackByType(type: Any): string {
  if (typeof type === "string") return describeBuiltInComponentFrame(type);
  if (typeof type === "function")
    return describeNativeComponentFrame(type, !!(type.prototype && type.prototype.isReactComponent));
  if (typeof type === "object" && type !== null) {
    switch (type.$$typeof) {
      case FORWARD_REF_TYPE:
        return describeNativeComponentFrame(type.render, false);
      case MEMO_TYPE:
        return describeNativeComponentFrame(type.type, false);
      case LAZY_TYPE: {
        let resolved: Any;
        try {
          resolved = type._init(type._payload);
        } catch {
          return describeBuiltInComponentFrame("Lazy");
        }
        return describeComponentStackByType(resolved);
      }
    }
    // A server component's info (its location is known only in development builds).
    if (typeof type.name === "string")
      return describeBuiltInComponentFrame(type.name + (type.env ? " [" + type.env + "]" : ""));
  }
  switch (type) {
    case SUSPENSE_LIST_TYPE:
      return describeBuiltInComponentFrame("SuspenseList");
    case SUSPENSE_TYPE:
      return describeBuiltInComponentFrame("Suspense");
    case VIEW_TRANSITION_TYPE:
      return describeBuiltInComponentFrame("ViewTransition");
  }
  return "";
}

/** The info for an error thrown at `stack`: its componentStack is described when first read. */
function getThrownInfo(stack: StackNode | null): ErrorInfo {
  const info: ErrorInfo = {};
  if (stack !== null)
    Object.defineProperty(info, "componentStack", {
      configurable: true,
      enumerable: true,
      get() {
        let described = "";
        try {
          for (let node: StackNode | null = stack; node !== null; node = node.parent)
            described += describeComponentStackByType(node.type);
        } catch (x: Any) {
          described = "\nError generating stack: " + x.message + "\n" + x.stack;
        }
        Object.defineProperty(info, "componentStack", { value: described });
        return described;
      },
    });
  return info;
}

// #endregion

// #region Rendering

// The task rendering now and its component's useId count, for the hooks' server side.
let currentTask: Task | null = null;
let currentResumableState: ResumableState | null = null;
let localIdCounter = 0;

/** What compat's hooks ask of the server while it renders a component (see index.ts). */
const serverHooks: ServerHooks = {
  id() {
    const treeId = getTreeId(currentTask!.treeContext);
    return makeId(currentResumableState!, treeId, localIdCounter++);
  },
  snapshot(getServerSnapshot, select) {
    if (getServerSnapshot === undefined)
      throw new Error(
        "Missing getServerSnapshot, which is required for server-rendered content. Will revert to client rendering.",
      );
    const v = getServerSnapshot();
    return select === undefined ? v : select(v);
  },
  browser: createRecoverableError,
  actionState(action, initialState, permalink) {
    // React's server useActionState: a server action's form carries a key for the hook, and a
    // postback (formState) whose key and action match gives the hook its state.
    const index = actionStateCounter++;
    if (typeof action.$$FORM_ACTION === "function") {
      const request = currentRequest!,
        keyPath = currentKeyPath,
        formState = request.formState,
        isSignatureEqual = action.$$IS_SIGNATURE_EQUAL;
      let nextKey: string | null = null;
      const key = (): string => (nextKey ??= postbackActionStateKey(request, permalink, keyPath, index));
      if (
        formState !== null &&
        typeof isSignatureEqual === "function" &&
        isSignatureEqual.call(action, formState[2], formState[3]) &&
        formState[1] === key()
      ) {
        actionStateMatchingIndex = index;
        initialState = formState[0];
      }
      const bound = action.bind(null, initialState);
      const dispatch: Any = (payload: Any) => void bound(payload);
      if (typeof bound.$$FORM_ACTION === "function")
        dispatch.$$FORM_ACTION = (prefix: string) => {
          const fields = bound.$$FORM_ACTION(prefix);
          if (permalink !== undefined) fields.action = permalink + "";
          const data = fields.data;
          if (data) data.append("$ACTION_KEY", key());
          return fields;
        };
      return [initialState, dispatch, false];
    }
    const bound = action.bind(null, initialState);
    return [initialState, (payload: Any) => void bound(payload), false];
  },
  thenable(t) {
    // React's trackUsedThenable: the promise used at this place before is read in place of a new one.
    const state = (thenableState ??= []);
    const prev = state[thenableIndex++];
    if (prev === undefined) state.push(t);
    else if (prev !== t) {
      t.then(noop, noop);
      t = prev;
    }
    return (lastThenable = t);
  },
};

// The rendering component's element path, and its useActionState hooks so far and the one a
// postback matched (React's currentlyRenderingKeyPath, actionStateCounter, actionStateMatchingIndex).
let currentKeyPath: KeyPath | null = null;
let actionStateCounter = 0;
let actionStateMatchingIndex = -1;

/** A useActionState hook's postback key: its permalink, or a hash of where it is in the tree. */
function postbackActionStateKey(
  request: Request,
  permalink: string | undefined,
  keyPath: KeyPath | null,
  index: number,
): string {
  if (permalink !== undefined) return "p" + permalink;
  return "k" + request.hash(JSON.stringify([keyPath, null, index]));
}

/** React's Node build's key hash: MD5, in hex. */
function md5(s: string): string {
  return (globalThis as Any).process.getBuiltinModule("crypto").createHash("md5").update(s).digest("hex");
}

/** The other builds' key hash: MurmurHash3 (32 bits, seed 0) of the string's low bytes, as React's. */
function murmurhash3(key: string): number {
  const remainder = key.length & 3,
    bytes = key.length - remainder;
  let h1 = 0,
    k1 = 0,
    i = 0;
  while (i < bytes) {
    k1 =
      (key.charCodeAt(i) & 255) |
      ((key.charCodeAt(++i) & 255) << 8) |
      ((key.charCodeAt(++i) & 255) << 16) |
      ((key.charCodeAt(++i) & 255) << 24);
    ++i;
    k1 = (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (5 * (h1 & 65535) + (((5 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
    h1 = (h1 & 65535) + 27492 + ((((h1 >>> 16) + 58964) & 65535) << 16);
  }
  if (remainder !== 0) {
    k1 = 0;
    if (remainder === 3) k1 ^= (key.charCodeAt(i + 2) & 255) << 16;
    if (remainder >= 2) k1 ^= (key.charCodeAt(i + 1) & 255) << 8;
    k1 ^= key.charCodeAt(i) & 255;
    k1 = (3432918353 * (k1 & 65535) + (((3432918353 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
    k1 = (k1 << 15) | (k1 >>> 17);
    h1 ^= (461845907 * (k1 & 65535) + (((461845907 * (k1 >>> 16)) & 65535) << 16)) & 4294967295;
  }
  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = (2246822507 * (h1 & 65535) + (((2246822507 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
  h1 ^= h1 >>> 13;
  h1 = (3266489909 * (h1 & 65535) + (((3266489909 * (h1 >>> 16)) & 65535) << 16)) & 4294967295;
  return (h1 ^ (h1 >>> 16)) >>> 0;
}

// The promises the rendering component has used, and the next one's place. A component that
// suspends hands them to the task that retries it (React's thenableState).
let thenableState: Any[] | null = null;
let thenableIndex = 0;
let lastThenable: Any = null;
// The promise a component suspended on through use(), and the promises it had used.
let suspendedThenable: Any = null;
let suspendedState: Any[] | null = null;

/** The promises used before a suspension on `x`, or null when `x` did not come from use(). */
function thenableStateAfterSuspending(x: Any): Any[] | null {
  const state = x === suspendedThenable ? suspendedState : null;
  suspendedThenable = suspendedState = null;
  return state;
}

// The component __serverRender calls on each pass: each pass reads its promises from the first.
let renderingComponent: Any = null;
function renderPass(props: Any, secondArg: Any): Any {
  thenableIndex = 0;
  return renderingComponent(props, secondArg);
}

/**
 * Call a function component with compat's hooks; `hadId` says whether it called useId,
 * `actionStates` how many useActionState hooks it has and `matchedActionState` which of them
 * takes the postback's state (-1 for none).
 */
let hadId = false;
let actionStates = 0;
let matchedActionState = -1;
function renderWithHooks(task: Task, keyPath: KeyPath, Component: Any, props: Any, secondArg: Any): Any {
  const prevTask = currentTask,
    prevCount = localIdCounter,
    prevKeyPath = currentKeyPath,
    prevActionStates = actionStateCounter,
    prevMatching = actionStateMatchingIndex,
    prevComponent = renderingComponent,
    prevState = thenableState,
    prevIndex = thenableIndex;
  currentTask = task;
  localIdCounter = 0;
  currentKeyPath = keyPath;
  actionStateCounter = 0;
  actionStateMatchingIndex = -1;
  renderingComponent = Component;
  thenableState = task.thenableState;
  task.thenableState = null;
  try {
    const out = __serverRender(serverHooks, renderPass, props, secondArg);
    hadId = localIdCounter !== 0;
    actionStates = actionStateCounter;
    matchedActionState = actionStateMatchingIndex;
    return out;
  } catch (x) {
    if (x === lastThenable) {
      suspendedThenable = x;
      suspendedState = thenableState;
    }
    throw x;
  } finally {
    currentTask = prevTask;
    localIdCounter = prevCount;
    currentKeyPath = prevKeyPath;
    actionStateCounter = prevActionStates;
    actionStateMatchingIndex = prevMatching;
    renderingComponent = prevComponent;
    thenableState = prevState;
    thenableIndex = prevIndex;
    lastThenable = null;
  }
}

/**
 * A function component's children; one that called useId gives them a tree level of their own.
 * With a postback's formState, a marker per useActionState hook says which one took its state.
 */
function finishFunctionComponent(
  request: Request,
  task: Task,
  keyPath: KeyPath,
  children: Any,
  hasId: boolean,
  actionStateCount: number,
  matchingIndex: number,
): void {
  let markers = false;
  if (actionStateCount !== 0 && request.formState !== null) {
    markers = true;
    const chunks = task.blockedSegment.chunks;
    for (let i = 0; i < actionStateCount; i++) chunks.push(i === matchingIndex ? "<!--F!-->" : "<!--F-->");
  }
  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  if (hasId) {
    const prev = task.treeContext;
    task.treeContext = pushTreeContext(prev, 1, 0);
    renderNode(request, task, children, -1);
    task.treeContext = prev;
  } else if (markers) renderNode(request, task, children, -1);
  else renderNodeDestructive(request, task, children, -1);
  task.keyPath = prevKeyPath;
}

/** A class component, mounted as React's server mounts one, then its render's output. */
function renderClassComponent(request: Request, task: Task, keyPath: KeyPath, type: Any, props: Props): void {
  let newProps = props;
  if ("ref" in props) {
    newProps = {};
    for (const k in props) if (k !== "ref") newProps[k] = props[k];
  }
  const defaults = type.defaultProps;
  if (defaults) {
    if (newProps === props) newProps = { ...newProps };
    for (const k in defaults) if (newProps[k] === undefined) newProps[k] = defaults[k];
  }
  const contextType = type.contextType;
  const context = typeof contextType === "object" && contextType !== null ? contextType._currentValue : {};
  const inst = new type(newProps, context);
  const initialState = inst.state !== undefined ? inst.state : null;
  inst.props = newProps;
  inst.state = initialState;
  inst.context = context;
  if (typeof type.getDerivedStateFromProps === "function") {
    const partial = type.getDerivedStateFromProps(newProps, initialState);
    inst.state = partial == null ? initialState : { ...initialState, ...partial };
  }
  if (
    typeof type.getDerivedStateFromProps !== "function" &&
    typeof inst.getSnapshotBeforeUpdate !== "function" &&
    (typeof inst.UNSAFE_componentWillMount === "function" || typeof inst.componentWillMount === "function")
  ) {
    // setState in componentWillMount queues updates that apply before render; the instance's own
    // setState stands in for the class's while the lifecycles run, then goes.
    let queue: Any[] = [],
      replace = false;
    const own = (name: string, value: Any): void => {
      Object.defineProperty(inst, name, { value, configurable: true, writable: true });
    };
    own("setState", (partial: Any) => queue.push(partial));
    own("forceUpdate", noop);
    const oldState = inst.state;
    try {
      if (typeof inst.componentWillMount === "function") inst.componentWillMount();
      if (typeof inst.UNSAFE_componentWillMount === "function") inst.UNSAFE_componentWillMount();
    } finally {
      delete inst.setState;
      delete inst.forceUpdate;
    }
    // Assigning this.state in the lifecycle replaces the state the queue starts from.
    if (oldState !== inst.state) {
      replace = true;
      queue = [inst.state];
    }
    if (queue.length > 0) {
      if (replace && queue.length === 1) inst.state = queue[0];
      else {
        let next = replace ? queue[0] : inst.state,
          copied = false;
        for (let i = replace ? 1 : 0; i < queue.length; i++) {
          const update = queue[i];
          const partial = typeof update === "function" ? update.call(inst, next, newProps, undefined) : update;
          if (partial == null) continue;
          if (!copied) {
            copied = true;
            next = { ...next, ...partial };
          } else Object.assign(next, partial);
        }
        inst.state = next;
      }
    }
  }
  const out = inst.render();
  if (request.aborted) throw null;
  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  renderNodeDestructive(request, task, out, -1);
  task.keyPath = prevKeyPath;
}

/** Render one element of type `type`. React's renderElement. */
function renderElement(request: Request, task: Task, keyPath: KeyPath, type: Any, props: Props, ref: Any): void {
  if (typeof type === "function") {
    if (type.prototype && type.prototype.isReactComponent) {
      renderClassComponent(request, task, keyPath, type, props);
      return;
    }
    const out = renderWithHooks(task, keyPath, type, props, undefined);
    if (request.aborted) throw null;
    finishFunctionComponent(request, task, keyPath, out, hadId, actionStates, matchedActionState);
    return;
  }
  if (typeof type === "string") {
    renderHostElement(request, task, keyPath, type, props);
    return;
  }
  const prevKeyPath = task.keyPath;
  switch (type) {
    case LEGACY_HIDDEN_TYPE:
    case STRICT_MODE_TYPE:
    case PROFILER_TYPE:
    case FRAGMENT_TYPE:
      task.keyPath = keyPath;
      renderNodeDestructive(request, task, props["children"], -1);
      task.keyPath = prevKeyPath;
      return;
    case ACTIVITY_TYPE: {
      if (props["mode"] === "hidden") return;
      const segment = task.blockedSegment;
      const marks = !request.renderState.generateStaticMarkup;
      if (marks) segment.chunks.push("<!--&-->");
      segment.lastPushedText = false;
      task.keyPath = keyPath;
      renderNode(request, task, props["children"], -1);
      task.keyPath = prevKeyPath;
      if (marks) segment.chunks.push("<!--/&-->");
      segment.lastPushedText = false;
      return;
    }
    case SUSPENSE_LIST_TYPE:
      renderSuspenseList(request, task, keyPath, props);
      return;
    case VIEW_TRANSITION_TYPE:
      task.keyPath = keyPath;
      renderViewTransition(request, task, props);
      task.keyPath = prevKeyPath;
      return;
    case SCOPE_TYPE:
      throw new Error("ReactDOMServer does not yet support scope components.");
    case SUSPENSE_TYPE:
      renderSuspenseBoundary(request, task, keyPath, props);
      return;
  }
  if (typeof type === "object" && type !== null) {
    switch (type.$$typeof) {
      case FORWARD_REF_TYPE: {
        let propsWithoutRef = props;
        if ("ref" in props) {
          propsWithoutRef = {};
          for (const k in props) if (k !== "ref") propsWithoutRef[k] = props[k];
        }
        const out = renderWithHooks(task, keyPath, type.render, propsWithoutRef, ref);
        finishFunctionComponent(request, task, keyPath, out, hadId, actionStates, matchedActionState);
        return;
      }
      case MEMO_TYPE:
        renderElement(request, task, keyPath, type.type, props, ref);
        return;
      case CONTEXT_TYPE: {
        // A provider: set the value for the subtree, then restore the one it shadowed.
        const value = props["value"];
        const prevValue = type._currentValue;
        type._currentValue = value;
        const prevNode = currentSnapshot;
        const node: ContextNode = {
          parent: prevNode,
          depth: prevNode === null ? 0 : prevNode.depth + 1,
          context: type,
          parentValue: prevValue,
          value,
        };
        currentSnapshot = node;
        task.context = node;
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, props["children"], -1);
        const snapshot = currentSnapshot!;
        snapshot.context._currentValue = snapshot.parentValue;
        task.context = currentSnapshot = snapshot.parent;
        task.keyPath = prevKeyPath;
        return;
      }
      case CONSUMER_TYPE: {
        const render = props["children"];
        const children = render(type._context._currentValue);
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, children, -1);
        task.keyPath = prevKeyPath;
        return;
      }
      case LAZY_TYPE: {
        const Component = type._init(type._payload);
        if (request.aborted) throw null;
        renderElement(request, task, keyPath, Component, props, ref);
        return;
      }
    }
  }
  throw new Error(
    "Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: " +
      (type == null ? type : typeof type) +
      ".",
  );
}

/** A host element: its start tag, children and end tag; <head>'s children go to the preamble. */
function renderHostElement(request: Request, task: Task, keyPath: KeyPath, type: string, props: Props): void {
  const segment = task.blockedSegment;
  const children = pushStartInstance(
    segment.chunks,
    type,
    props,
    request.resumableState,
    request.renderState,
    task.blockedPreamble,
    task.hoistableState,
    task.formatContext,
    segment.lastPushedText,
  );
  segment.lastPushedText = false;
  const prevContext = task.formatContext,
    prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  task.formatContext = getChildFormatContext(prevContext, type, props);
  if (task.formatContext.insertionMode === HTML_HEAD_MODE) {
    const preambleSegment = createPendingSegment(request, 0, null, task.formatContext, false, false);
    segment.preambleChildren.push(preambleSegment);
    task.blockedSegment = preambleSegment;
    try {
      renderNode(request, task, children, -1);
      segmentFinale(request, preambleSegment);
      preambleSegment.status = COMPLETED;
      finishedSegment(request, task.blockedBoundary, preambleSegment);
    } finally {
      task.blockedSegment = segment;
    }
  } else renderNode(request, task, children, -1);
  task.formatContext = prevContext;
  task.keyPath = prevKeyPath;
  switch (type) {
    case "title":
    case "style":
    case "script":
    case "area":
    case "base":
    case "br":
    case "col":
    case "embed":
    case "hr":
    case "img":
    case "input":
    case "keygen":
    case "link":
    case "meta":
    case "param":
    case "source":
    case "track":
    case "wbr":
      segment.lastPushedText = false;
      return;
    case "body":
      if (prevContext.insertionMode <= HTML_HTML_MODE) {
        request.resumableState.hasBody = true;
        segment.lastPushedText = false;
        return;
      }
      break;
    case "html":
      if (prevContext.insertionMode === ROOT_HTML_MODE) {
        request.resumableState.hasHtml = true;
        segment.lastPushedText = false;
        return;
      }
      break;
    case "head":
      if (prevContext.insertionMode <= HTML_HTML_MODE) {
        segment.lastPushedText = false;
        return;
      }
  }
  segment.chunks.push(endChunkForTag(type));
  segment.lastPushedText = false;
}

/** A separator after a segment that ends in text and sits between texts (streams, suspended work). */
function segmentFinale(request: Request, segment: Segment): void {
  if (!request.renderState.generateStaticMarkup && segment.lastPushedText && segment.textEmbedded)
    segment.chunks.push("<!-- -->");
}

function renderViewTransition(request: Request, task: Task, props: Props): void {
  const prevContext = task.formatContext;
  const rs = request.resumableState;
  const named = props["name"] != null && props["name"] !== "auto";
  if (!request.legacy) {
    // Streams write the view transition's classes on the elements under it.
    const autoName = named ? props["name"] : makeId(rs, getTreeId(task.treeContext), 0);
    let update = viewTransitionClass(props["default"], props["update"]),
      enter = viewTransitionClass(props["default"], props["enter"]),
      exit = viewTransitionClass(props["default"], props["exit"]),
      share = viewTransitionClass(props["default"], props["share"]),
      name = props["name"];
    if (update == null) update = "auto";
    if (enter == null) enter = "auto";
    if (exit == null) exit = "auto";
    if (name == null) {
      const parent = prevContext.viewTransition;
      if (parent !== null) {
        name = parent.name;
        share = parent.share;
      } else {
        name = "auto";
        share = "none";
      }
    } else {
      if (share == null) share = "auto";
      if (prevContext.tagScope & 4) rs.instructions |= 128;
    }
    if (prevContext.tagScope & 8) rs.instructions |= 128;
    else exit = "none";
    if (prevContext.tagScope & 16) rs.instructions |= 128;
    else enter = "none";
    let scope = prevContext.tagScope & -25;
    scope = update !== "none" ? scope | 32 : scope & -33;
    if (enter !== "none") scope |= 64;
    task.formatContext = formatContext(prevContext.insertionMode, prevContext.selectedValue, scope, {
      update,
      enter,
      exit,
      share,
      parentEnter: "none",
      parentExit: "none",
      name,
      autoName,
      nameIdx: 0,
    });
  }
  if (named) renderNodeDestructive(request, task, props["children"], -1);
  else {
    // An unnamed transition takes a tree level, as its auto name is an id.
    const prevTree = task.treeContext;
    task.treeContext = pushTreeContext(prevTree, 1, 0);
    renderNode(request, task, props["children"], -1);
    task.treeContext = prevTree;
  }
  task.formatContext = prevContext;
}

/**
 * A Suspense boundary: its content renders first, into a segment of its own; if that completes,
 * the fallback never renders. Otherwise the fallback renders in a task of its own and the content
 * finishes when what it waits for settles (or, for renderToString, renders on the client).
 */
function renderSuspenseBoundary(request: Request, task: Task, keyPath: KeyPath, props: Props): void {
  const prevKeyPath = task.keyPath,
    prevContext = task.formatContext,
    prevRow = task.row,
    parentBoundary = task.blockedBoundary,
    parentPreamble = task.blockedPreamble,
    parentHoistableState = task.hoistableState,
    parentSegment = task.blockedSegment,
    fallback = props["fallback"],
    content = props["children"],
    fallbackAbortSet = new Set<Task>();
  const boundary = createSuspenseBoundary(
    request,
    task.row,
    fallbackAbortSet,
    !request.legacy && task.formatContext.insertionMode < HTML_MODE
      ? { content: createPreambleState(), fallback: createPreambleState() }
      : null,
  );
  const boundarySegment = createPendingSegment(
    request,
    parentSegment.chunks.length,
    boundary,
    task.formatContext,
    false,
    false,
  );
  parentSegment.children.push(boundarySegment);
  parentSegment.lastPushedText = false;
  const contentRootSegment = createPendingSegment(request, 0, null, task.formatContext, false, false);
  contentRootSegment.parentFlushed = true;
  task.blockedBoundary = boundary;
  task.blockedPreamble = boundary.preamble === null ? null : boundary.preamble.content;
  task.hoistableState = boundary.contentState;
  task.blockedSegment = contentRootSegment;
  task.keyPath = keyPath;
  task.formatContext = getSuspenseContentFormatContext(request.resumableState, prevContext);
  task.row = null;
  try {
    renderNode(request, task, content, -1);
    segmentFinale(request, contentRootSegment);
    contentRootSegment.status = COMPLETED;
    finishedSegment(request, boundary, contentRootSegment);
    queueCompletedSegment(boundary, contentRootSegment);
    if (boundary.pendingTasks === 0 && boundary.status === PENDING) {
      boundary.status = COMPLETED;
      if (!isEligibleForOutlining(request, boundary)) {
        if (prevRow !== null && --prevRow.pendingTasks === 0) finishSuspenseListRow(request, prevRow);
        if (request.pendingRootTasks === 0 && task.blockedPreamble) preparePreamble(request);
        return;
      }
    } else if (prevRow !== null && prevRow.together) tryToResolveTogetherRow(request, prevRow);
  } catch (thrown) {
    boundary.status = ERRORED;
    let error: Any;
    if (request.aborted) {
      contentRootSegment.status = ABORTED;
      error = request.fatalError;
    } else {
      contentRootSegment.status = ERRORED;
      error = thrown;
    }
    boundary.errorDigest = logRecoverableError(request, error, getThrownInfo(task.componentStack));
  } finally {
    task.blockedBoundary = parentBoundary;
    task.blockedPreamble = parentPreamble;
    task.hoistableState = parentHoistableState;
    task.blockedSegment = parentSegment;
    task.keyPath = prevKeyPath;
    task.formatContext = prevContext;
    task.row = prevRow;
  }
  const fallbackTask = createRenderTask(
    request,
    fallback,
    -1,
    parentBoundary,
    boundarySegment,
    boundary.preamble === null ? null : boundary.preamble.fallback,
    boundary.fallbackState,
    fallbackAbortSet,
    [keyPath[0], "Suspense Fallback", keyPath[2]],
    getSuspenseFallbackFormatContext(request.resumableState, task.formatContext),
    task.context,
    task.treeContext,
    task.row,
    fallbackStack(task.componentStack),
  );
  pushComponentStack(fallbackTask);
  request.pingedTasks.push(fallbackTask);
}

function renderSuspenseList(request: Request, task: Task, keyPath: KeyPath, props: Props): void {
  const children = props["children"],
    revealOrder = props["revealOrder"];
  if (revealOrder !== "independent" && revealOrder !== "together") {
    if (isArray(children)) {
      renderSuspenseListRows(request, task, keyPath, children, revealOrder);
      return;
    }
    const iteratorFn = getIteratorFn(children);
    if (iteratorFn) {
      const iterator = iteratorFn.call(children);
      if (iterator) {
        let step = iterator.next();
        if (!step.done) {
          do step = iterator.next();
          while (!step.done);
          // React renders the rows from the iterable again, as it does in this version.
          renderSuspenseListRows(request, task, keyPath, children, revealOrder);
        }
        return;
      }
    }
  }
  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  if (revealOrder === "together") {
    const prevRow = task.row;
    const row = (task.row = createSuspenseListRow(null));
    row.boundaries = [];
    row.together = true;
    renderNodeDestructive(request, task, children, -1);
    if (--row.pendingTasks === 0) finishSuspenseListRow(request, row);
    task.row = prevRow;
    if (prevRow !== null && row.pendingTasks > 0) {
      prevRow.pendingTasks++;
      row.next = prevRow;
    }
  } else renderNodeDestructive(request, task, children, -1);
  task.keyPath = prevKeyPath;
}

function renderSuspenseListRows(request: Request, task: Task, keyPath: KeyPath, rows: Any, revealOrder: Any): void {
  const prevKeyPath = task.keyPath,
    prevTreeContext = task.treeContext,
    prevRow = task.row;
  task.keyPath = keyPath;
  const total = rows.length;
  let previous: Row | null = null;
  if (revealOrder !== "backwards" && revealOrder !== "unstable_legacy-backwards") {
    for (let i = 0; i < total; i++) {
      task.row = previous = createSuspenseListRow(previous);
      task.treeContext = pushTreeContext(prevTreeContext, total, i);
      renderNode(request, task, rows[i], i);
      if (--previous.pendingTasks === 0) finishSuspenseListRow(request, previous);
    }
  } else {
    // Backwards: rows render last to first, each into a segment placed in document order.
    const parentSegment = task.blockedSegment;
    const childIndex = parentSegment.children.length,
      chunkIndex = parentSegment.chunks.length;
    for (let n = 0; n < total; n++) {
      const i = revealOrder === "unstable_legacy-backwards" ? total - 1 - n : n;
      task.row = previous = createSuspenseListRow(previous);
      task.treeContext = pushTreeContext(prevTreeContext, total, i);
      const segment = createPendingSegment(
        request,
        chunkIndex,
        null,
        task.formatContext,
        i === 0 ? parentSegment.lastPushedText : true,
        true,
      );
      parentSegment.children.splice(childIndex, 0, segment);
      task.blockedSegment = segment;
      try {
        renderNode(request, task, rows[i], i);
        segmentFinale(request, segment);
        segment.status = COMPLETED;
        finishedSegment(request, task.blockedBoundary, segment);
        if (--previous.pendingTasks === 0) finishSuspenseListRow(request, previous);
      } catch (thrown) {
        segment.status = request.aborted ? ABORTED : ERRORED;
        throw thrown;
      }
    }
    task.blockedSegment = parentSegment;
    parentSegment.lastPushedText = false;
  }
  if (prevRow !== null && previous !== null && previous.pendingTasks > 0) {
    prevRow.pendingTasks++;
    previous.next = prevRow;
  }
  task.treeContext = prevTreeContext;
  task.row = prevRow;
  task.keyPath = prevKeyPath;
}

function createSuspenseListRow(previous: Row | null): Row {
  const row: Row = {
    pendingTasks: 1,
    boundaries: null,
    hoistables: createHoistableState(),
    inheritedHoistables: null,
    together: false,
    next: null,
  };
  if (previous !== null && previous.pendingTasks > 0) {
    row.pendingTasks++;
    row.boundaries = [];
    previous.next = row;
  }
  return row;
}

function finishSuspenseListRow(request: Request, row: Row): void {
  unblockSuspenseListRow(request, row.next, row.hoistables);
}

function unblockSuspenseListRow(request: Request, row: Row | null, inherited: HoistableState | null): void {
  while (row !== null) {
    if (inherited !== null) {
      hoistHoistables(row.hoistables, inherited);
      row.inheritedHoistables = inherited;
    }
    const boundaries = row.boundaries;
    if (boundaries !== null) {
      row.boundaries = null;
      for (const b of boundaries) {
        if (inherited !== null) hoistHoistables(b.contentState, inherited);
        finishedTask(request, b, null, null);
      }
    }
    row.pendingTasks--;
    if (row.pendingTasks > 0) break;
    inherited = row.hoistables;
    row = row.next;
  }
}

function tryToResolveTogetherRow(request: Request, row: Row): void {
  const boundaries = row.boundaries;
  if (boundaries === null || row.pendingTasks !== boundaries.length) return;
  for (const b of boundaries) {
    if (b.pendingTasks !== 1 || b.parentFlushed || isEligibleForOutlining(request, b)) return;
  }
  unblockSuspenseListRow(request, row, row.hoistables);
}

/** An element type's name, as React's getComponentNameFromType gives it (key paths use it). */
function getComponentNameFromType(type: Any): string | null {
  if (type == null) return null;
  if (typeof type === "function")
    return type.$$typeof === CLIENT_REFERENCE ? null : type.displayName || type.name || null;
  if (typeof type === "string") return type;
  switch (type) {
    case FRAGMENT_TYPE:
      return "Fragment";
    case PROFILER_TYPE:
      return "Profiler";
    case STRICT_MODE_TYPE:
      return "StrictMode";
    case SUSPENSE_TYPE:
      return "Suspense";
    case SUSPENSE_LIST_TYPE:
      return "SuspenseList";
    case ACTIVITY_TYPE:
      return "Activity";
    case VIEW_TRANSITION_TYPE:
      return "ViewTransition";
  }
  if (typeof type === "object")
    switch (type.$$typeof) {
      // (A portal as a type is never rendered: React throws for it.)
      case CONTEXT_TYPE:
        return type.displayName || "Context";
      case CONSUMER_TYPE:
        return (type._context.displayName || "Context") + ".Consumer";
      case FORWARD_REF_TYPE: {
        if (type.displayName) return type.displayName;
        const inner = type.render.displayName || type.render.name || "";
        return inner !== "" ? "ForwardRef(" + inner + ")" : "ForwardRef";
      }
      case MEMO_TYPE:
        return type.displayName || getComponentNameFromType(type.type) || "Memo";
      case LAZY_TYPE:
        try {
          return getComponentNameFromType(type._init(type._payload));
        } catch {
          return null;
        }
    }
  return null;
}

/** An iterable's iterator function, as React looks for one. */
function getIteratorFn(o: Any): Any {
  if (o === null || typeof o !== "object") return null;
  const fn = o[Symbol.iterator] || o["@@iterator"];
  return typeof fn === "function" ? fn : null;
}

/** Render a node in place: an element, text, an array, an iterable, a promise or a context. */
function renderNodeDestructive(request: Request, task: Task, node: Any, childIndex: number): void {
  task.node = node;
  task.childIndex = childIndex;
  // An error leaves the stack where it was thrown, for the boundary or task that catches it.
  const stack = task.componentStack;
  pushComponentStack(task);
  retryNode(request, task);
  task.componentStack = stack;
}

function retryNode(request: Request, task: Task): void {
  let node = task.node;
  const childIndex = task.childIndex;
  if (node === null) return;
  if (typeof node === "object") {
    switch (node.$$typeof) {
      case ELEMENT: {
        const type = node.type,
          key = node.key,
          props = node.props;
        const ref = props.ref;
        const keyPath: KeyPath = [
          task.keyPath,
          getComponentNameFromType(type),
          key == null ? (childIndex === -1 ? 0 : childIndex) : key,
        ];
        renderElement(request, task, keyPath, type, props, ref !== undefined ? ref : null);
        return;
      }
      case PORTAL_TYPE:
        throw new Error(
          "Portals are not currently supported by the server renderer. Render them conditionally so that they only appear on the client render.",
        );
      case LAZY_TYPE:
        node = node._init(node._payload);
        if (request.aborted) throw null;
        renderNodeDestructive(request, task, node, childIndex);
        return;
    }
    if (isArray(node)) {
      renderChildrenArray(request, task, node, childIndex);
      return;
    }
    const iteratorFn = getIteratorFn(node);
    if (iteratorFn) {
      const iterator = iteratorFn.call(node);
      if (iterator) {
        let step = iterator.next();
        if (!step.done) {
          const items: Any[] = [];
          do {
            items.push(step.value);
            step = iterator.next();
          } while (!step.done);
          renderChildrenArray(request, task, items, childIndex);
        }
        return;
      }
    }
    if (typeof node.then === "function") {
      renderNodeDestructive(request, task, readThenable(node), childIndex);
      return;
    }
    if (node.$$typeof === CONTEXT_TYPE) {
      renderNodeDestructive(request, task, node._currentValue, childIndex);
      return;
    }
    const tag = Object.prototype.toString.call(node);
    throw new Error(
      "Objects are not valid as a React child (found: " +
        (tag === "[object Object]" ? "object with keys {" + Object.keys(node).join(", ") + "}" : tag) +
        "). If you meant to render a collection of children, use an array instead.",
    );
  }
  if (typeof node === "string") {
    const segment = task.blockedSegment;
    segment.lastPushedText = pushTextInstance(segment.chunks, node, request.renderState, segment.lastPushedText);
  } else if (typeof node === "number" || typeof node === "bigint") {
    const segment = task.blockedSegment;
    segment.lastPushedText = pushTextInstance(segment.chunks, "" + node, request.renderState, segment.lastPushedText);
  }
}

/** Text, with a separator from text just before it, so the client finds two text nodes. */
function pushTextInstance(target: string[], text: string, state: RenderState, textEmbedded: boolean): boolean {
  if (state.generateStaticMarkup) {
    target.push(escapeText(text));
    return false;
  }
  if (text === "") return textEmbedded;
  if (textEmbedded) target.push("<!-- -->");
  target.push(escapeText(text));
  return true;
}

/** A promise rendered as a child: its value, or a suspension, tracked on the promise as React does. */
function readThenable(t: Any): Any {
  switch (t.status) {
    case "fulfilled":
      return t.value;
    case "rejected":
      throw t.reason;
  }
  if (typeof t.status === "string") t.then(noop, noop);
  else {
    t.status = "pending";
    t.then(
      (v: Any) => {
        if (t.status === "pending") {
          t.status = "fulfilled";
          t.value = v;
        }
      },
      (e: Any) => {
        if (t.status === "pending") {
          t.status = "rejected";
          t.reason = e;
        }
      },
    );
  }
  switch (t.status) {
    case "fulfilled":
      return t.value;
    case "rejected":
      throw t.reason;
  }
  throw t;
}

/** Children of an array, each at its own tree position; a nested array is a step of the key path. */
function renderChildrenArray(request: Request, task: Task, children: Any[], childIndex: number): void {
  const prevKeyPath = task.keyPath,
    prevTreeContext = task.treeContext;
  if (childIndex !== -1) task.keyPath = [prevKeyPath, "Fragment", childIndex];
  const total = children.length;
  for (let i = 0; i < total; i++) {
    task.treeContext = pushTreeContext(prevTreeContext, total, i);
    renderNode(request, task, children[i], i);
  }
  task.treeContext = prevTreeContext;
  task.keyPath = prevKeyPath;
}

/** A task for a node that suspended: a segment of its own where the node was, rendered later. */
function spawnNewSuspendedRenderTask(request: Request, task: Task, thenableState: Any[] | null): Task {
  const segment = task.blockedSegment;
  const newSegment = createPendingSegment(
    request,
    segment.chunks.length,
    null,
    task.formatContext,
    segment.lastPushedText,
    true,
  );
  segment.children.push(newSegment);
  segment.lastPushedText = false;
  const newTask = createRenderTask(
    request,
    task.node,
    task.childIndex,
    task.blockedBoundary,
    newSegment,
    task.blockedPreamble,
    task.hoistableState,
    task.abortSet,
    task.keyPath,
    task.formatContext,
    task.context,
    task.treeContext,
    task.row,
    task.componentStack,
  );
  newTask.thenableState = thenableState;
  return newTask;
}

const STACK_OVERFLOW = "Maximum call stack size exceeded";

/**
 * Render a node, catching a suspension: what it wrote is dropped and a new task renders it when
 * the promise settles. Errors go up to the nearest boundary.
 */
function renderNode(request: Request, task: Task, node: Any, childIndex: number): void {
  const prevFormat = task.formatContext,
    prevContext = task.context,
    prevKeyPath = task.keyPath,
    prevTree = task.treeContext,
    prevStack = task.componentStack,
    segment = task.blockedSegment;
  const childrenLength = segment.children.length,
    chunkLength = segment.chunks.length;
  let x: Any;
  try {
    renderNodeDestructive(request, task, node, childIndex);
    return;
  } catch (thrown) {
    segment.children.length = childrenLength;
    segment.chunks.length = chunkLength;
    x = thrown;
    if (!request.aborted && typeof x === "object" && x !== null) {
      if (typeof x.then === "function") {
        const newTask = spawnNewSuspendedRenderTask(request, task, thenableStateAfterSuspending(x));
        x.then(newTask.ping, newTask.ping);
        task.formatContext = prevFormat;
        task.context = prevContext;
        task.keyPath = prevKeyPath;
        task.treeContext = prevTree;
        task.componentStack = prevStack;
        switchContext(prevContext);
        return;
      }
      if (x.message === STACK_OVERFLOW) {
        // A deep tree: the rest renders in a task of its own, from a fresh stack.
        request.pingedTasks.push(spawnNewSuspendedRenderTask(request, task, null));
        task.formatContext = prevFormat;
        task.context = prevContext;
        task.keyPath = prevKeyPath;
        task.treeContext = prevTree;
        task.componentStack = prevStack;
        switchContext(prevContext);
        return;
      }
    }
  }
  task.formatContext = prevFormat;
  task.context = prevContext;
  task.keyPath = prevKeyPath;
  task.treeContext = prevTree;
  switchContext(prevContext);
  throw x;
}

// #endregion

// #region The work loop

/** Render every pinged task, then flush if a destination is attached. */
function performWork(request: Request): void {
  if (request.aborted || request.status > OPEN) return;
  const prevContext = currentSnapshot,
    prevResumable = currentResumableState,
    prevRequest = currentRequest;
  currentResumableState = request.resumableState;
  currentRequest = request;
  __serverHints(serverHints);
  try {
    const pinged = request.pingedTasks;
    let i: number;
    for (i = 0; i < pinged.length; i++) retryTask(request, pinged[i]!);
    pinged.splice(0, i);
    if (request.destination !== null) flushCompletedQueues(request, request.destination);
  } catch (error) {
    logRecoverableError(request, error, {});
    fatalError(request, error);
  } finally {
    currentResumableState = prevResumable;
    // A render inside a render's component goes back to the outer one's request.
    currentRequest = prevRequest;
    __serverHints(prevRequest === null ? null : serverHints);
    // The context objects go back to the values they had, so client roots read their defaults.
    switchContext(prevContext);
  }
}

function retryTask(request: Request, task: Task): void {
  const segment = task.blockedSegment;
  if (segment.status !== PENDING) return;
  const prevTask = request.currentTask;
  request.currentTask = task;
  switchContext(task.context);
  const childrenLength = segment.children.length,
    chunkLength = segment.chunks.length,
    startNode = task.node;
  try {
    retryNode(request, task);
    segmentFinale(request, segment);
    task.abortSet.delete(task);
    segment.status = COMPLETED;
    finishedSegment(request, task.blockedBoundary, segment);
    finishedTask(request, task.blockedBoundary, task.row, segment);
  } catch (thrown) {
    segment.children.length = childrenLength;
    segment.chunks.length = chunkLength;
    const x: Any = thrown;
    if (request.aborted) {
      request.currentTask = prevTask;
      abortTask(task, request);
      task.abortSet.delete(task);
      finishAbortedTask(task, request, request.fatalError);
      return;
    }
    if (typeof x === "object" && x !== null) {
      if (typeof x.then === "function") {
        segment.status = PENDING;
        task.thenableState = thenableStateAfterSuspending(x);
        x.then(task.ping, task.ping);
        return;
      }
      if (x.message === STACK_OVERFLOW && task.node !== startNode) {
        segment.status = PENDING;
        task.thenableState = null;
        request.pingedTasks.push(task);
        return;
      }
    }
    erroredTask(request, task, x);
  } finally {
    request.currentTask = prevTask;
  }
}

/** A task threw: its boundary renders on the client, or, outside any boundary, the render fails. */
function erroredTask(request: Request, task: Task, x: Any): void {
  task.abortSet.delete(task);
  task.blockedSegment.status = ERRORED;
  const boundary = task.blockedBoundary,
    row = task.row;
  if (row !== null && --row.pendingTasks === 0) finishSuspenseListRow(request, row);
  request.allPendingTasks--;
  const info = getThrownInfo(task.componentStack);
  if (boundary === null) {
    const error = isRecoverableError(x) ? cloneRecoverableErrorAsFatal(x) : x;
    logRecoverableError(request, error, info);
    fatalError(request, error);
    return;
  }
  const digest = logRecoverableError(request, x, info);
  boundary.pendingTasks--;
  if (boundary.status !== ERRORED) {
    boundary.status = ERRORED;
    boundary.errorDigest = digest;
    const boundaryRow = boundary.row;
    if (boundaryRow !== null) {
      request.allPendingTasks++;
      if (--boundaryRow.pendingTasks === 0) finishSuspenseListRow(request, boundaryRow);
      request.allPendingTasks--;
    }
    if (boundary.parentFlushed) request.clientRenderedBoundaries.push(boundary);
    if (request.pendingRootTasks === 0 && boundary.preamble !== null) preparePreamble(request);
  }
  if (request.allPendingTasks === 0) completeAll(request);
}

/** Add a finished segment's bytes to its boundary (or the shell), for outlining (streams only). */
function finishedSegment(request: Request, boundary: Boundary | null, segment: Segment): void {
  if (request.legacy) return;
  let size = 0;
  for (const chunk of segment.chunks) size += byteLength(chunk);
  if (boundary === null) request.byteSize += size;
  else boundary.byteSize += size;
}

/** A completed segment of a boundary; one that only wraps another hands its place to it. */
function queueCompletedSegment(boundary: Boundary, segment: Segment): void {
  if (
    segment.chunks.length === 0 &&
    segment.children.length === 1 &&
    segment.children[0]!.boundary === null &&
    segment.children[0]!.id === -1
  ) {
    const child = segment.children[0]!;
    child.id = segment.id;
    child.parentFlushed = true;
    if (child.status === COMPLETED || child.status === ABORTED || child.status === ERRORED)
      queueCompletedSegment(boundary, child);
  } else boundary.completedSegments.push(segment);
}

/** Whether a completed boundary is written later, apart from the shell (streams: large ones). */
function isEligibleForOutlining(request: Request, boundary: Boundary): boolean {
  return (
    (boundary.byteSize > 500 ||
      (!request.legacy && hasSuspenseyContent(boundary.contentState, false)) ||
      boundary.defer) &&
    boundary.preamble === null
  );
}

function finishedTask(request: Request, boundary: Boundary | null, row: Row | null, segment: Segment | null): void {
  if (row !== null) {
    if (--row.pendingTasks === 0) finishSuspenseListRow(request, row);
    else if (row.together) tryToResolveTogetherRow(request, row);
  }
  request.allPendingTasks--;
  if (boundary === null) {
    if (segment !== null && segment.parentFlushed) request.completedRootSegment = segment;
    request.pendingRootTasks--;
    if (request.pendingRootTasks === 0) completeShell(request);
  } else {
    boundary.pendingTasks--;
    if (boundary.status !== ERRORED) {
      if (boundary.pendingTasks === 0) {
        if (boundary.status === PENDING) boundary.status = COMPLETED;
        if (segment !== null && segment.parentFlushed && (segment.status === COMPLETED || segment.status === ABORTED))
          queueCompletedSegment(boundary, segment);
        if (boundary.parentFlushed) request.completedBoundaries.push(boundary);
        if (boundary.status === COMPLETED) {
          const boundaryRow = boundary.row;
          if (boundaryRow !== null) hoistHoistables(boundaryRow.hoistables, boundary.contentState);
          if (!isEligibleForOutlining(request, boundary)) {
            // Shown inline: its fallback is never needed.
            request.allPendingTasks++;
            boundary.fallbackAbortableTasks.forEach((t) => abortTaskSoft(request, t));
            boundary.fallbackAbortableTasks.clear();
            if (boundaryRow !== null && --boundaryRow.pendingTasks === 0) finishSuspenseListRow(request, boundaryRow);
            request.allPendingTasks--;
          }
          if (request.pendingRootTasks === 0 && boundary.preamble !== null) preparePreamble(request);
        }
      } else {
        if (segment !== null && segment.parentFlushed && (segment.status === COMPLETED || segment.status === ABORTED)) {
          queueCompletedSegment(boundary, segment);
          if (boundary.completedSegments.length === 1 && boundary.parentFlushed)
            request.partialBoundaries.push(boundary);
        }
        const boundaryRow = boundary.row;
        if (boundaryRow !== null && boundaryRow.together) tryToResolveTogetherRow(request, boundaryRow);
      }
    }
  }
  if (request.allPendingTasks === 0) completeAll(request);
}

function completeShell(request: Request): void {
  safelyEmitEarlyPreloads(request, true);
  preparePreamble(request);
  request.onShellReady();
}

function completeAll(request: Request): void {
  safelyEmitEarlyPreloads(request, true);
  preparePreamble(request);
  request.onAllReady();
}

/** A fallback task no longer needed: its boundary's content completed. */
function abortTaskSoft(request: Request, task: Task): void {
  const segment = task.blockedSegment;
  segment.status = ABORTED;
  finishedTask(request, task.blockedBoundary, task.row, segment);
}

function abortTask(task: Task, request: Request): void {
  if (task === request.currentTask) return;
  const boundary = task.blockedBoundary;
  task.blockedSegment.status = ABORTED;
  if (boundary !== null) boundary.fallbackAbortableTasks.forEach((t) => abortTask(t, request));
}

/** An aborted task: its boundary renders on the client; outside any boundary, the render fails. */
function finishAbortedTask(task: Task, request: Request, error: Any): void {
  if (task === request.currentTask) return;
  const boundary = task.blockedBoundary,
    segment = task.blockedSegment;
  if (segment.status !== ABORTED) return;
  const info = getThrownInfo(task.componentStack);
  const recoverable = isRecoverableError(error);
  if (boundary === null) {
    const e = recoverable ? cloneRecoverableErrorAsFatal(error) : error;
    logRecoverableError(request, e, info);
    if (request.status !== ABORTING && request.status !== CLOSED) fatalError(request, e);
    return;
  }
  if (boundary.status !== ERRORED) {
    boundary.status = ERRORED;
    boundary.errorDigest = logRecoverableError(request, error, info);
    if (boundary.parentFlushed) request.clientRenderedBoundaries.push(boundary);
  }
  boundary.pendingTasks--;
  const boundaryRow = boundary.row;
  if (boundaryRow !== null && --boundaryRow.pendingTasks === 0) finishSuspenseListRow(request, boundaryRow);
  boundary.fallbackAbortableTasks.forEach((t) => finishAbortedTask(t, request, error));
  boundary.fallbackAbortableTasks.clear();
  const row = task.row;
  if (row !== null && --row.pendingTasks === 0) finishSuspenseListRow(request, row);
  request.allPendingTasks--;
  if (request.allPendingTasks === 0) completeAll(request);
}

/** Stop the render: what is still pending renders on the client. */
function abort(request: Request, reason: Any): void {
  if (request.aborted || (request.status !== OPEN && request.status !== OPENING)) return;
  endRenderLifetime(request);
  request.aborted = true;
  const error = isRecoverableReason(reason)
    ? createRecoverableError(reason)
    : reason === undefined
      ? new Error("The render was aborted by the server without a reason.")
      : typeof reason === "object" && reason !== null && typeof reason.then === "function"
        ? new Error("The render was aborted by the server with a promise.")
        : reason;
  request.fatalError = error;
  const tasks = request.abortableTasks;
  tasks.forEach((t) => abortTask(t, request));
  const finish = (): void => {
    try {
      if (tasks.size > 0) {
        tasks.forEach((t) => finishAbortedTask(t, request, error));
        tasks.clear();
      }
      if (request.destination !== null) flushCompletedQueues(request, request.destination);
    } catch (e) {
      logRecoverableError(request, e, {});
      fatalError(request, e);
    }
  };
  if (request.legacy) finish();
  else request.scheduleWork(finish);
}

const isRecoverableReason = (reason: Any): boolean =>
  typeof reason === "object" && reason !== null && reason.$$typeof === RECOVERABLE_TYPE;

// #endregion

// #region The preamble

function hoistPreambleState(state: RenderState, preamble: PreambleState): void {
  const target = state.preamble;
  if (target.htmlChunks === null && preamble.htmlChunks) target.htmlChunks = preamble.htmlChunks;
  if (target.headChunks === null && preamble.headChunks) target.headChunks = preamble.headChunks;
  if (target.bodyChunks === null && preamble.bodyChunks) target.bodyChunks = preamble.bodyChunks;
}

function preparePreambleFromSubtree(request: Request, segment: Segment, collected: Segment[][]): boolean {
  if (segment.preambleChildren.length) collected.push(segment.preambleChildren);
  let pending = false;
  for (const child of segment.children) pending = preparePreambleFromSegment(request, child, collected) || pending;
  return pending;
}

function preparePreambleFromSegment(request: Request, segment: Segment, collected: Segment[][]): boolean {
  const boundary = segment.boundary;
  if (boundary === null) return preparePreambleFromSubtree(request, segment, collected);
  const preamble = boundary.preamble;
  if (preamble === null) return false;
  switch (boundary.status) {
    case COMPLETED: {
      hoistPreambleState(request.renderState, preamble.content);
      request.byteSize += boundary.byteSize;
      return preparePreambleFromSubtree(request, boundary.completedSegments[0]!, collected);
    }
    case ERRORED:
      if (segment.status === COMPLETED) {
        hoistPreambleState(request.renderState, preamble.fallback);
        return preparePreambleFromSubtree(request, segment, collected);
      }
  }
  return true;
}

/** Once the shell is done: the <html>, <head> and <body> tags any boundary rendered, if all are known. */
function preparePreamble(request: Request): void {
  if (request.completedRootSegment === null || request.completedPreambleSegments !== null) return;
  const collected: Segment[][] = [],
    byteSize = request.byteSize;
  const pending = preparePreambleFromSegment(request, request.completedRootSegment, collected);
  const preamble = request.renderState.preamble;
  if (!pending || (preamble.headChunks && preamble.bodyChunks)) request.completedPreambleSegments = collected;
  else request.byteSize = byteSize;
}

// #endregion

// #region Flushing

// Instruction scripts, written once each (ResumableState.instructions bits), as React writes them.
const completeSegmentFunction =
  "$RS=function(a,b){a=document.getElementById(a);b=document.getElementById(b);for(a.parentNode.removeChild(a);a.firstChild;)b.parentNode.insertBefore(a.firstChild,b);b.parentNode.removeChild(b)};";
const completeBoundaryFunction =
  '$RB=[];$RV=function(a){$RT=performance.now();for(var b=0;b<a.length;b+=2){var c=a[b],e=a[b+1];null!==e.parentNode&&e.parentNode.removeChild(e);var f=c.parentNode;if(f){var g=c.previousSibling,h=0;do{if(c&&8===c.nodeType){var d=c.data;if("/$"===d||"/&"===d)if(0===h)break;else h--;else"$"!==d&&"$?"!==d&&"$~"!==d&&"$!"!==d&&"&"!==d||h++}d=c.nextSibling;f.removeChild(c);c=d}while(c);for(;e.firstChild;)f.insertBefore(e.firstChild,c);g.data="$";g._reactRetry&&requestAnimationFrame(g._reactRetry)}}a.length=0};\n$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))?(a.previousSibling.data="$~",$RB.push(a,b),2===$RB.length&&("number"!==typeof $RT?requestAnimationFrame($RV.bind(null,$RB)):(a=performance.now(),setTimeout($RV.bind(null,$RB),2300>a&&2E3<a?2300-a:$RT+300-a)))):b.parentNode.removeChild(b)};';
const viewTransitionsFunction =
  '$RV=function(B,g){function h(a,c){var e=a.getAttribute(c);e&&(c=a.style,l.push(a,c.viewTransitionName,c.viewTransitionClass),"auto"!==e&&(c.viewTransitionClass=e),(a=a.getAttribute("vt-name"))||(a="_T_"+N++ +"_"),a=CSS.escape(a)!==a?"r-"+btoa(a).replace(/=/g,""):a,c.viewTransitionName=a,C=!0)}var C=!1,N=0,l=[];try{var f=document.__reactViewTransition;if(f){f.finished.finally($RV.bind(null,g));return}var m=new Map;for(f=1;f<g.length;f+=2)for(var k=g[f].querySelectorAll("[vt-share]"),d=0;d<k.length;d++){var b=k[d];m.set(b.getAttribute("vt-name"),b)}var u=[];for(k=0;k<g.length;k+=2){var D=g[k],x=D.parentNode;if(x){var v=x.getBoundingClientRect();if(v.left||v.top||v.width||v.height){b=D;for(f=0;b;){if(8===b.nodeType){var t=b.data;if("/$"===t)if(0===f)break;else f--;else"$"!==t&&"$?"!==t&&"$~"!==t&&"$!"!==t||f++}else if(1===b.nodeType){d=b;var E=d.getAttribute("vt-name"),y=m.get(E);h(d,y?"vt-share":"vt-exit");y&&(h(y,"vt-share"),m.set(E,null));for(var F=d.querySelectorAll("[vt-share]"),\nz=0;z<F.length;z++){var G=F[z],H=G.getAttribute("vt-name"),I=m.get(H);I&&(h(G,"vt-share"),h(I,"vt-share"),m.set(H,null))}var J=d.querySelectorAll("[vt-parent-exit]");for(d=0;d<J.length;d++)h(J[d],"vt-parent-exit")}b=b.nextSibling}for(var K=g[k+1],n=K.firstElementChild;n;){null!==m.get(n.getAttribute("vt-name"))&&h(n,"vt-enter");var L=n.querySelectorAll("[vt-parent-enter]");for(b=0;b<L.length;b++)h(L[b],"vt-parent-enter");n=n.nextElementSibling}b=x;do for(var p=b.firstElementChild;p;){var M=p.getAttribute("vt-update");\nM&&"none"!==M&&!l.includes(p)&&h(p,"vt-update");p=p.nextElementSibling}while((b=b.parentNode)&&1===b.nodeType&&"none"!==b.getAttribute("vt-update"));u.push.apply(u,K.querySelectorAll(\'img[src]:not([loading="lazy"])\'))}}}if(C){var A=document.__reactViewTransition=document.startViewTransition({update:function(){B(g);for(var a=[document.documentElement.clientHeight,document.fonts.ready],c={},e=0;e<u.length;c={g:c.g},e++)if(c.g=u[e],!c.g.complete){var q=c.g.getBoundingClientRect();0<q.bottom&&0<q.right&&\nq.top<window.innerHeight&&q.left<window.innerWidth&&(q=new Promise(function(w){return function(r){w.g.addEventListener("load",r);w.g.addEventListener("error",r)}}(c)),a.push(q))}return Promise.race([Promise.all(a),new Promise(function(w){var r=performance.now();setTimeout(w,2300>r&&2E3<r?2300-r:500)})])},types:[]});A.ready.finally(function(){for(var a=l.length-3;0<=a;a-=3){var c=l[a],e=c.style;e.viewTransitionName=l[a+1];e.viewTransitionClass=l[a+1];""===c.getAttribute("style")&&c.removeAttribute("style")}});\nA.finished.finally(function(){document.__reactViewTransition===A&&(document.__reactViewTransition=null)});$RB=[];return}}catch(a){}B(g)}.bind(null,$RV);';
const completeBoundaryWithStylesFunction =
  '$RM=new Map;$RR=function(n,w,p){function u(q){this._p=null;q()}for(var r=new Map,t=document,h,b,e=t.querySelectorAll("link[data-precedence],style[data-precedence]"),v=[],k=0;b=e[k++];)"not all"===b.getAttribute("media")?v.push(b):("LINK"===b.tagName&&$RM.set(b.getAttribute("href"),b),r.set(b.dataset.precedence,h=b));e=0;b=[];var l,a;for(k=!0;;){if(k){var f=p[e++];if(!f){k=!1;e=0;continue}var c=!1,m=0;var d=f[m++];if(a=$RM.get(d)){var g=a._p;c=!0}else{a=t.createElement("link");a.href=d;a.rel=\n"stylesheet";for(a.dataset.precedence=l=f[m++];g=f[m++];)a.setAttribute(g,f[m++]);g=a._p=new Promise(function(q,x){a.onload=u.bind(a,q);a.onerror=u.bind(a,x)});$RM.set(d,a)}d=a.getAttribute("media");!g||d&&!matchMedia(d).matches||b.push(g);if(c)continue}else{a=v[e++];if(!a)break;l=a.getAttribute("data-precedence");a.removeAttribute("media")}c=r.get(l)||h;c===h&&(h=a);r.set(l,a);c?c.parentNode.insertBefore(a,c.nextSibling):(c=t.head,c.insertBefore(a,c.firstChild))}if(p=document.getElementById(n))p.previousSibling.data=\n"$~";Promise.all(b).then($RC.bind(null,n,w),$RX.bind(null,n,"CSS failed to load"))};';
const clientRenderFunction =
  '$RX=function(b,c,d,e,f){var a=document.getElementById(b);a&&(b=a.previousSibling,b.data="$!",a=a.dataset,null!=c&&(a.dgst=c),d&&(a.msg=d),e&&(a.stck=e),f&&(a.cstck=f),b._reactRetry&&b._reactRetry())};';

/** The bootstrap scripts, written once the shell is out; true while the destination has room. */
function writeBootstrap(destination: Destination, state: RenderState): boolean {
  const chunks = state.bootstrapChunks;
  let i = 0;
  for (; i < chunks.length - 1; i++) destination.push(chunks[i]!);
  if (i < chunks.length) {
    const last = chunks[i]!;
    chunks.length = 0;
    return destination.push(last);
  }
  return true;
}

function writeStartPendingSuspenseBoundary(destination: Destination, state: RenderState, id: number): boolean {
  destination.push('<!--$?--><template id="');
  destination.push(state.boundaryPrefix);
  destination.push(id.toString(16));
  return destination.push('"></template>');
}

// The hidden container a segment is written in, apart from the shell, by insertion mode.
const segmentContainers: [string, string][] = [
  ['<div hidden id="', "</div>"],
  ['<div hidden id="', "</div>"],
  ['<div hidden id="', "</div>"],
  ['<div hidden id="', "</div>"],
  ['<svg aria-hidden="true" style="display:none" id="', "</svg>"],
  ['<math aria-hidden="true" style="display:none" id="', "</math>"],
  ['<table hidden id="', "</table>"],
  ['<table hidden><tbody id="', "</tbody></table>"],
  ['<table hidden><tr id="', "</tr></table>"],
  ['<table hidden><colgroup id="', "</colgroup></table>"],
];

function flushResource(this: Destination, resource: string[]): void {
  for (const chunk of resource) this.push(chunk);
  resource.length = 0;
}

let currentlyFlushingRenderState: RenderState | null = null;
let currentlyRenderingBoundaryHasStylesToHoist = false;
let destinationHasCapacity = true;

/** A boundary's precedence styles, written before it shows, as a disabled style tag. */
function flushStyleTagsLateForBoundary(this: Destination, queue: StyleQueue): void {
  const rules = queue.rules,
    hrefs = queue.hrefs;
  if (!hrefs.length) return;
  this.push(currentlyFlushingRenderState!.startInlineStyle);
  this.push(' media="not all" data-precedence="');
  this.push(queue.precedence);
  this.push('" data-href="');
  let i = 0;
  for (; i < hrefs.length - 1; i++) (this.push(hrefs[i]!), this.push(" "));
  this.push(hrefs[i]!);
  this.push('">');
  for (const rule of rules) this.push(rule);
  destinationHasCapacity = this.push("</style>");
  currentlyRenderingBoundaryHasStylesToHoist = true;
  rules.length = 0;
  hrefs.length = 0;
}

function writeHoistablesForBoundary(
  destination: Destination,
  state: HoistableState,
  renderState: RenderState,
): boolean {
  currentlyRenderingBoundaryHasStylesToHoist = false;
  destinationHasCapacity = true;
  currentlyFlushingRenderState = renderState;
  state.styles.forEach(flushStyleTagsLateForBoundary, destination);
  currentlyFlushingRenderState = null;
  state.stylesheets.forEach((sheet) => {
    if (sheet.state !== 2) currentlyRenderingBoundaryHasStylesToHoist = true;
  });
  if (currentlyRenderingBoundaryHasStylesToHoist) renderState.stylesToHoist = true;
  return destinationHasCapacity;
}

const stylesheetFlushingQueue: string[] = [];

function flushStyleInPreamble(this: Destination, sheet: Stylesheet): void {
  pushLinkImpl(stylesheetFlushingQueue, sheet.props);
  for (const chunk of stylesheetFlushingQueue) this.push(chunk);
  stylesheetFlushingQueue.length = 0;
  sheet.state = 2;
}

/** A precedence's stylesheets and style rules, in the head. */
function flushStylesInPreamble(this: Destination, queue: StyleQueue): void {
  const hasSheets = queue.sheets.size > 0;
  queue.sheets.forEach(flushStyleInPreamble, this);
  queue.sheets.clear();
  const rules = queue.rules,
    hrefs = queue.hrefs;
  if (hasSheets && !hrefs.length) return;
  this.push(currentlyFlushingRenderState!.startInlineStyle);
  this.push(' data-precedence="');
  this.push(queue.precedence);
  if (hrefs.length) {
    this.push('" data-href="');
    let i = 0;
    for (; i < hrefs.length - 1; i++) (this.push(hrefs[i]!), this.push(" "));
    this.push(hrefs[i]!);
  }
  this.push('">');
  for (const rule of rules) this.push(rule);
  this.push("</style>");
  rules.length = 0;
  hrefs.length = 0;
}

/** Stylesheets found after the shell: preloaded, to be inserted by the boundary's script. */
function preloadLateStyles(this: Destination, queue: StyleQueue): void {
  queue.sheets.forEach((sheet) => {
    if (sheet.state !== 0) return;
    sheet.state = 1;
    const props = sheet.props;
    pushLinkImpl(stylesheetFlushingQueue, {
      rel: "preload",
      as: "style",
      href: props["href"],
      crossOrigin: props["crossOrigin"],
      fetchPriority: props["fetchPriority"],
      integrity: props["integrity"],
      media: props["media"],
      hrefLang: props["hrefLang"],
      referrerPolicy: props["referrerPolicy"],
    });
    for (const chunk of stylesheetFlushingQueue) this.push(chunk);
    stylesheetFlushingQueue.length = 0;
  });
  queue.sheets.clear();
}

/** The stylesheets a boundary waits for, as the $RR script's array argument. */
function writeStyleResourceDependenciesInJS(destination: Destination, state: HoistableState): void {
  destination.push("[");
  let open = "[";
  state.stylesheets.forEach((resource) => {
    if (resource.state === 2) return;
    if (resource.state === 3) {
      destination.push(open);
      destination.push(escapeJSObject("" + resource.props["href"]));
      destination.push("]");
      open = ",[";
      return;
    }
    destination.push(open);
    const props = resource.props;
    destination.push(escapeJSObject("" + sanitizeURL("" + props["href"])));
    destination.push(",");
    destination.push(escapeJSObject("" + props["data-precedence"]));
    for (const k in props) {
      if (!hasOwn.call(props, k)) continue;
      const v = props[k];
      if (v == null) continue;
      switch (k) {
        case "href":
        case "rel":
        case "precedence":
        case "data-precedence":
          break;
        case "children":
        case "dangerouslySetInnerHTML":
          throw selfClosing("link");
        default:
          writeStyleResourceAttributeInJS(destination, k, v);
      }
    }
    destination.push("]");
    open = ",[";
    resource.state = 3;
  });
  destination.push("]");
}

function writeStyleResourceAttributeInJS(destination: Destination, name: string, value: Any): void {
  let attr = name.toLowerCase(),
    text: string;
  if (typeof value === "function" || typeof value === "symbol") return;
  switch (name) {
    case "innerHTML":
    case "dangerouslySetInnerHTML":
    case "suppressContentEditableWarning":
    case "suppressHydrationWarning":
    case "style":
    case "ref":
      return;
    case "className":
      attr = "class";
      text = "" + value;
      break;
    case "hidden":
      if (value === false) return;
      text = "";
      break;
    case "src":
    case "href":
      text = "" + sanitizeURL(value);
      break;
    default:
      if (
        (name.length > 2 && (name[0] === "o" || name[0] === "O") && (name[1] === "n" || name[1] === "N")) ||
        !isAttributeNameSafe(name)
      )
        return;
      text = "" + value;
  }
  destination.push(",");
  destination.push(escapeJSObject(attr));
  destination.push(",");
  destination.push(escapeJSObject(text));
}

let flushedByteSize = 0;
let flushingPartialBoundaries = false;
let flushingShell = false;

function flushSubtree(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistable: HoistableState | null,
): boolean {
  segment.parentFlushed = true;
  if (segment.status === PENDING) {
    // Not done yet: a placeholder its content replaces later.
    segment.id = request.nextSegmentId++;
    segment.lastPushedText = false;
    segment.textEmbedded = false;
    destination.push('<template id="');
    destination.push(request.renderState.placeholderPrefix);
    destination.push(segment.id.toString(16));
    return destination.push('"></template>');
  }
  // An aborted segment writes nothing. (React throws for an errored or flushed one; neither is
  // ever flushed here, as an aborted one is only flushed by React's prerender.)
  if (segment.status !== COMPLETED) return true;
  segment.status = FLUSHED;
  let r = true,
    chunkIdx = 0;
  const chunks = segment.chunks;
  for (const child of segment.children) {
    for (; chunkIdx < child.index; chunkIdx++) destination.push(chunks[chunkIdx]!);
    r = flushSegment(request, destination, child, hoistable);
  }
  for (; chunkIdx < chunks.length - 1; chunkIdx++) destination.push(chunks[chunkIdx]!);
  if (chunkIdx < chunks.length) r = destination.push(chunks[chunkIdx]!);
  return r;
}

function flushSegment(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistable: HoistableState | null,
): boolean {
  const boundary = segment.boundary;
  if (boundary === null) return flushSubtree(request, destination, segment, hoistable);
  segment.boundary = null;
  boundary.parentFlushed = true;
  const marks = !request.renderState.generateStaticMarkup;
  if (boundary.status === ERRORED) {
    // Rendered on the client: the fallback, marked so hydration renders the content.
    const row = boundary.row;
    if (row !== null && --row.pendingTasks === 0) finishSuspenseListRow(request, row);
    if (marks) {
      destination.push("<!--$!-->");
      destination.push("<template");
      if (boundary.errorDigest != null) {
        destination.push(' data-dgst="');
        destination.push(escapeText(boundary.errorDigest));
        destination.push('"');
      }
      destination.push("></template>");
    }
    flushSubtree(request, destination, segment, hoistable);
  } else if (boundary.status !== COMPLETED) {
    // Still pending: the fallback, with an id the content's script finds.
    if (boundary.status === PENDING) boundary.rootSegmentID = request.nextSegmentId++;
    if (boundary.completedSegments.length > 0) request.partialBoundaries.push(boundary);
    writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID);
    if (hoistable) hoistHoistables(hoistable, boundary.fallbackState);
    flushSubtree(request, destination, segment, hoistable);
  } else if (
    !flushingPartialBoundaries &&
    isEligibleForOutlining(request, boundary) &&
    (flushedByteSize + boundary.byteSize > request.progressiveChunkSize ||
      (!request.legacy && hasSuspenseyContent(boundary.contentState, flushingShell)) ||
      boundary.defer)
  ) {
    // Complete but large: written after the shell, so the shell streams first.
    boundary.rootSegmentID = request.nextSegmentId++;
    request.completedBoundaries.push(boundary);
    writeStartPendingSuspenseBoundary(destination, request.renderState, boundary.rootSegmentID);
    flushSubtree(request, destination, segment, hoistable);
  } else {
    flushedByteSize += boundary.byteSize;
    if (hoistable) hoistHoistables(hoistable, boundary.contentState);
    const row = boundary.row;
    if (row !== null && isEligibleForOutlining(request, boundary) && --row.pendingTasks === 0)
      finishSuspenseListRow(request, row);
    if (marks) destination.push("<!--$-->");
    flushSegment(request, destination, boundary.completedSegments[0]!, hoistable);
  }
  return marks ? destination.push("<!--/$-->") : true;
}

function flushSegmentContainer(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistable: HoistableState,
): boolean {
  const [start, end] = segmentContainers[segment.parentFormatContext.insertionMode]!;
  destination.push(start);
  destination.push(request.renderState.segmentPrefix);
  destination.push(segment.id.toString(16));
  destination.push('">');
  flushSegment(request, destination, segment, hoistable);
  return destination.push(end);
}

/** A boundary completed after the shell: its content, hidden, then the script that reveals it. */
function flushCompletedBoundary(request: Request, destination: Destination, boundary: Boundary): boolean {
  flushedByteSize = boundary.byteSize;
  const segments = boundary.completedSegments;
  for (const segment of segments) flushPartiallyCompletedSegment(request, destination, boundary, segment);
  segments.length = 0;
  const row = boundary.row;
  if (row !== null && isEligibleForOutlining(request, boundary) && --row.pendingTasks === 0)
    finishSuspenseListRow(request, row);
  writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
  const rs = request.resumableState,
    state = request.renderState;
  const id = boundary.rootSegmentID.toString(16);
  const withStyles = state.stylesToHoist,
    viewTransitions = (rs.instructions & 128) !== 0;
  state.stylesToHoist = false;
  destination.push(state.startInlineScript);
  destination.push(">");
  if (withStyles) {
    if ((rs.instructions & 4) === 0) {
      rs.instructions |= 4;
      destination.push(clientRenderFunction);
    }
  }
  if ((rs.instructions & 2) === 0) {
    rs.instructions |= 2;
    destination.push(completeBoundaryFunction);
  }
  if (viewTransitions && (rs.instructions & 256) === 0) {
    rs.instructions |= 256;
    destination.push(viewTransitionsFunction);
  }
  if (withStyles) {
    if ((rs.instructions & 8) === 0) {
      rs.instructions |= 8;
      destination.push(completeBoundaryWithStylesFunction + '$RR("');
    } else destination.push('$RR("');
  } else destination.push('$RC("');
  destination.push(state.boundaryPrefix);
  destination.push(id);
  destination.push('","');
  destination.push(state.segmentPrefix);
  destination.push(id);
  if (withStyles) {
    destination.push('",');
    writeStyleResourceDependenciesInJS(destination, boundary.contentState);
  } else destination.push('"');
  const ok = destination.push(")</script>");
  return writeBootstrap(destination, state) && ok;
}

/** A segment of a boundary that is not complete yet, and the script that puts it in place. */
function flushPartiallyCompletedSegment(
  request: Request,
  destination: Destination,
  boundary: Boundary,
  segment: Segment,
): boolean {
  if (segment.status === FLUSHED) return true;
  const hoistable = boundary.contentState;
  const id = segment.id;
  if (id === -1) {
    segment.id = boundary.rootSegmentID;
    return flushSegmentContainer(request, destination, segment, hoistable);
  }
  if (id === boundary.rootSegmentID) return flushSegmentContainer(request, destination, segment, hoistable);
  flushSegmentContainer(request, destination, segment, hoistable);
  const rs = request.resumableState,
    state = request.renderState;
  destination.push(state.startInlineScript);
  destination.push(">");
  if ((rs.instructions & 1) === 0) {
    rs.instructions |= 1;
    destination.push(completeSegmentFunction + '$RS("');
  } else destination.push('$RS("');
  destination.push(state.segmentPrefix);
  destination.push(id.toString(16));
  destination.push('","');
  destination.push(state.placeholderPrefix);
  destination.push(id.toString(16));
  return destination.push('")</script>');
}

/** The preamble and the shell, once; then whatever completed since the last flush. */
function flushCompletedQueues(request: Request, destination: Destination): void {
  destination.begin();
  let i: number;
  try {
    if (request.pendingRootTasks > 0) return;
    const root = request.completedRootSegment;
    if (root !== null) {
      const preambleSegments = request.completedPreambleSegments;
      if (preambleSegments === null) return;
      flushedByteSize = request.byteSize;
      const rs = request.resumableState,
        state = request.renderState,
        preamble = state.preamble;
      const htmlChunks = preamble.htmlChunks,
        headChunks = preamble.headChunks;
      if (htmlChunks) {
        for (const c of htmlChunks) destination.push(c);
        if (headChunks) for (const c of headChunks) destination.push(c);
        else (destination.push(startChunkForTag("head")), destination.push(">"));
      } else if (headChunks) for (const c of headChunks) destination.push(c);
      for (const c of state.charsetChunks) destination.push(c);
      state.charsetChunks.length = 0;
      state.preconnects.forEach(flushResource, destination);
      state.preconnects.clear();
      for (const c of state.viewportChunks) destination.push(c);
      state.viewportChunks.length = 0;
      state.fontPreloads.forEach(flushResource, destination);
      state.fontPreloads.clear();
      state.highImagePreloads.forEach(flushResource, destination);
      state.highImagePreloads.clear();
      currentlyFlushingRenderState = state;
      state.styles.forEach(flushStylesInPreamble, destination);
      currentlyFlushingRenderState = null;
      for (const c of state.importMapChunks) destination.push(c);
      state.importMapChunks.length = 0;
      state.bootstrapScripts.forEach(flushResource, destination);
      state.scripts.forEach(flushResource, destination);
      state.scripts.clear();
      state.bulkPreloads.forEach(flushResource, destination);
      state.bulkPreloads.clear();
      // The shell's id goes on the first inline script, unless this is a whole document.
      if (request.legacy || !(htmlChunks || headChunks)) rs.instructions |= 32;
      for (const c of state.hoistableChunks) destination.push(c);
      state.hoistableChunks.length = 0;
      for (const segments of preambleSegments)
        for (const segment of segments) flushSegment(request, destination, segment, null);
      if (preamble.htmlChunks || preamble.headChunks) destination.push(endChunkForTag("head"));
      if (preamble.bodyChunks) for (const c of preamble.bodyChunks) destination.push(c);
      flushingShell = true;
      flushSegment(request, destination, root, null);
      flushingShell = false;
      request.completedRootSegment = null;
      if (
        request.allPendingTasks !== 0 ||
        request.clientRenderedBoundaries.length !== 0 ||
        request.completedBoundaries.length !== 0
      ) {
        // More is coming: a script marks when the shell painted, to pace the reveals.
        if ((rs.instructions & 64) === 0) {
          rs.instructions |= 64;
          destination.push(state.startInlineScript);
          if ((rs.instructions & 32) === 0) {
            rs.instructions |= 32;
            destination.push(' id="');
            destination.push(escapeText("_" + rs.idPrefix + "R_"));
            destination.push('"');
          }
          destination.push(">");
          destination.push("requestAnimationFrame(function(){$RT=performance.now()});");
          destination.push("</script>");
        }
      }
      writeBootstrap(destination, state);
    }
    const state = request.renderState;
    for (const c of state.viewportChunks) destination.push(c);
    state.viewportChunks.length = 0;
    state.preconnects.forEach(flushResource, destination);
    state.preconnects.clear();
    state.fontPreloads.forEach(flushResource, destination);
    state.fontPreloads.clear();
    state.highImagePreloads.forEach(flushResource, destination);
    state.highImagePreloads.clear();
    state.styles.forEach(preloadLateStyles, destination);
    state.scripts.forEach(flushResource, destination);
    state.scripts.clear();
    state.bulkPreloads.forEach(flushResource, destination);
    state.bulkPreloads.clear();
    for (const c of state.hoistableChunks) destination.push(c);
    state.hoistableChunks.length = 0;
    const rs = request.resumableState;
    // A destination with no room left stops the flush after the boundary that filled it; a drain
    // flushes the rest.
    const clientRendered = request.clientRenderedBoundaries;
    for (i = 0; i < clientRendered.length; i++) {
      const boundary = clientRendered[i]!;
      destination.push(state.startInlineScript);
      destination.push(">");
      if ((rs.instructions & 4) === 0) {
        rs.instructions |= 4;
        destination.push(clientRenderFunction + ';$RX("');
      } else destination.push('$RX("');
      destination.push(state.boundaryPrefix);
      destination.push(boundary.rootSegmentID.toString(16));
      destination.push('"');
      if (boundary.errorDigest != null) {
        destination.push(",");
        destination.push(escapeJSString(boundary.errorDigest));
      }
      if (!destination.push(")</script>")) return stopFlowing(request, clientRendered, i);
    }
    clientRendered.splice(0, i);
    const completed = request.completedBoundaries;
    for (i = 0; i < completed.length; i++)
      if (!flushCompletedBoundary(request, destination, completed[i]!)) return stopFlowing(request, completed, i);
    completed.splice(0, i);
    // Partial boundaries start new views.
    destination.complete();
    destination.begin();
    flushingPartialBoundaries = true;
    const partial = request.partialBoundaries;
    for (i = 0; i < partial.length; i++)
      if (!flushPartialBoundary(request, destination, partial[i]!)) return stopFlowing(request, partial, i);
    partial.splice(0, i);
    flushingPartialBoundaries = false;
    // Boundaries completed while flushing partial ones, written after them.
    for (i = 0; i < completed.length; i++)
      if (!flushCompletedBoundary(request, destination, completed[i]!)) return stopFlowing(request, completed, i);
    completed.splice(0, i);
  } finally {
    flushingPartialBoundaries = false;
    if (
      request.allPendingTasks === 0 &&
      request.clientRenderedBoundaries.length === 0 &&
      request.completedBoundaries.length === 0
    ) {
      request.flushScheduled = false;
      const rs = request.resumableState;
      if (rs.hasBody) destination.push(endChunkForTag("body"));
      if (rs.hasHtml) destination.push(endChunkForTag("html"));
      destination.complete();
      destination.flush();
      endRenderLifetime(request);
      request.status = CLOSED;
      destination.close();
      request.destination = null;
    } else {
      destination.complete();
      destination.flush();
    }
  }
}

/** The destination is full after `queue[i]`: drop what was written, and wait for a drain. */
function stopFlowing(request: Request, queue: Boundary[], i: number): void {
  request.destination = null;
  queue.splice(0, i + 1);
}

/** A partial boundary's completed segments and styles; false when the destination filled. */
function flushPartialBoundary(request: Request, destination: Destination, boundary: Boundary): boolean {
  flushedByteSize = boundary.byteSize;
  const segments = boundary.completedSegments;
  let i = 0;
  for (; i < segments.length; i++)
    if (!flushPartiallyCompletedSegment(request, destination, boundary, segments[i]!)) {
      segments.splice(0, i + 1);
      return false;
    }
  segments.splice(0, i);
  const row = boundary.row;
  if (row !== null && row.together && boundary.pendingTasks === 1) {
    if (row.pendingTasks === 1) unblockSuspenseListRow(request, row, row.hoistables);
    else row.pendingTasks--;
  }
  return writeHoistablesForBoundary(destination, boundary.contentState, request.renderState);
}

// The views React's builds write in. Its browser and edge builds enqueue each piece's bytes into
// 2048-byte views, a longer piece on its own; its Node build encodes strings into 4096-byte views,
// a string that may not fit in one (3 bytes a character) written as it is, and remembers when the
// writable reports it is full.
const encoder = new TextEncoder();

/** renderToReadableStream's destination: React's browser build's 2048-byte views. */
function controllerDestination(controller: ReadableByteStreamController): Destination {
  let view = new Uint8Array(2048),
    written = 0;
  const enqueue = (bytes: Uint8Array<ArrayBuffer>): void => controller.enqueue(bytes);
  return {
    push(chunk) {
      // A piece that surely fits is encoded in place.
      if (chunk.length * 3 <= view.length - written) {
        written += encoder.encodeInto(chunk, view.subarray(written)).written;
        return true;
      }
      let bytes = encoder.encode(chunk);
      if (bytes.byteLength > 2048) {
        if (written > 0) {
          enqueue(new Uint8Array(view.buffer, 0, written));
          view = new Uint8Array(2048);
          written = 0;
        }
        enqueue(bytes);
        return true;
      }
      const room = view.length - written;
      if (room < bytes.byteLength) {
        if (room > 0) {
          view.set(bytes.subarray(0, room), written);
          bytes = bytes.subarray(room);
        }
        enqueue(view);
        view = new Uint8Array(2048);
        written = 0;
      }
      view.set(bytes, written);
      written += bytes.byteLength;
      return true;
    },
    begin() {
      view = new Uint8Array(2048);
      written = 0;
    },
    complete() {
      if (written > 0) enqueue(new Uint8Array(view.buffer, 0, written));
      written = 0;
    },
    flush: noop,
    close: () => controller.close(),
    error: (e) => controller.error(e),
  };
}

/** renderToPipeableStream's destination: React's Node build's 4096-byte views and backpressure. */
function writableDestination(writable: PipeableWritable): Destination {
  let view = new Uint8Array(4096),
    written = 0,
    room = true;
  const write = (chunk: Uint8Array | string): void => {
    if (!writable.write(chunk as Any)) room = false;
  };
  const writeView = (): void => {
    write(view.subarray(0, written));
    view = new Uint8Array(4096);
    written = 0;
  };
  return {
    push(chunk) {
      if (chunk.length === 0) return room;
      if (chunk.length * 3 > 4096) {
        if (written > 0) writeView();
        write(chunk);
        return room;
      }
      const r = encoder.encodeInto(chunk, view.subarray(written));
      written += r.written;
      if (r.read < chunk.length) {
        writeView();
        written = encoder.encodeInto(chunk.slice(r.read), view).written;
      }
      if (written === 4096) writeView();
      return room;
    },
    begin() {
      view = new Uint8Array(4096);
      written = 0;
      room = true;
    },
    complete() {
      if (written > 0) writable.write(view.subarray(0, written));
      written = 0;
      room = true;
    },
    flush() {
      if (typeof writable.flush === "function") writable.flush();
    },
    close: () => writable.end(),
    error: (e) => (typeof writable.destroy === "function" ? writable.destroy(e) : writable.end()),
  };
}

/** Attach a destination and flush what is ready; a render that failed fails it. */
function startFlowing(request: Request, destination: Destination): void {
  if (request.status === ABORTING) {
    request.status = CLOSED;
    let error = request.fatalError;
    if (isRecoverableError(error)) error = cloneRecoverableErrorAsFatal(error);
    destination.error(error);
  } else if (request.status !== CLOSED && request.destination === null) {
    request.destination = destination;
    try {
      flushCompletedQueues(request, destination);
    } catch (error) {
      logRecoverableError(request, error, {});
      fatalError(request, error);
    }
  }
}

/** Start rendering: the work in a microtask, and the request opens after the first task. */
function startWork(request: Request): void {
  request.flushScheduled = request.destination !== null;
  queueMicrotask(() => performWork(request));
  request.scheduleWork(() => {
    if (request.status === OPENING) request.status = OPEN;
    safelyEmitEarlyPreloads(request, request.pendingRootTasks === 0);
  });
}

function attachAbortSignal(request: Request, signal: AbortSignal): void {
  if (signal.aborted) abort(request, signal.reason);
  else {
    const lifetime = new AbortController();
    request.lifetime = lifetime;
    signal.addEventListener("abort", () => abort(request, signal.reason), { signal: lifetime.signal });
  }
}

// #endregion

// #region Public API

/** Run a callback in a task of its own, as React's browser and Node builds schedule work. */
function scheduleTask(fn: () => void): void {
  if (typeof setImmediate === "function") setImmediate(fn);
  else setTimeout(fn, 0);
}

function renderToStringImpl(
  children: Any,
  options: ServerOptions | undefined,
  staticMarkup: boolean,
  abortReason: string,
): string {
  let result = "",
    didFatal = false,
    fatal: Any = null,
    readyToStream = false;
  const request = createRequest(children, {
    legacy: true,
    generateStaticMarkup: staticMarkup,
    options: options?.identifierPrefix === undefined ? undefined : { identifierPrefix: options.identifierPrefix },
    progressiveChunkSize: Infinity,
    onShellReady: () => {
      readyToStream = true;
    },
    // A promise that settles later finds the render over: nothing to schedule.
    scheduleWork: noop,
  });
  request.flushScheduled = false;
  performWork(request);
  if (request.status === OPENING) request.status = OPEN;
  abort(request, abortReason);
  startFlowing(request, {
    push(chunk) {
      result += chunk;
      return true;
    },
    begin: noop,
    complete: noop,
    flush: noop,
    close: noop,
    error(e) {
      didFatal = true;
      fatal = e;
    },
  });
  if (didFatal && fatal !== abortReason) throw fatal;
  if (!readyToStream)
    throw new Error(
      "A component suspended while responding to synchronous input. This will cause the UI to be replaced with a loading indicator. To fix, updates that suspend should be wrapped with startTransition.",
    );
  return result;
}

/**
 * The HTML of `children`, rendered synchronously, as React's renderToString writes it: content
 * still suspended when it returns is left to the client, behind its boundary's fallback.
 */
export function renderToString(children: ReactElement | Any, options?: ServerOptions): string {
  return renderToStringImpl(
    children,
    options,
    false,
    'The server used "renderToString" which does not support Suspense. If you intended for this Suspense boundary to render the fallback content on the server consider throwing an Error somewhere within the Suspense boundary. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
  );
}

/** Like renderToString, without the markers hydration needs: plain HTML for pages that never hydrate. */
export function renderToStaticMarkup(children: ReactElement | Any, options?: ServerOptions): string {
  return renderToStringImpl(
    children,
    options,
    true,
    'The server used "renderToStaticMarkup" which does not support Suspense. If you intended to have the server wait for the suspended component please switch to "renderToReadableStream" which supports Suspense on the server',
  );
}

/** What renderToReadableStream resolves to: the HTML stream, and when all of it is rendered. */
export interface ReactDOMServerReadableStream extends ReadableStream<Uint8Array> {
  allReady: Promise<void>;
}

/**
 * The HTML of `children` as a stream of bytes, once the shell (everything outside a pending
 * Suspense boundary) is rendered. Suspended content streams in as it resolves, with the scripts
 * that put it in place; `allReady` resolves when all of it is rendered.
 */
export function renderToReadableStream(
  children: ReactElement | Any,
  options?: RenderToReadableStreamOptions,
): Promise<ReactDOMServerReadableStream> {
  return new Promise((resolve, reject) => {
    let onAllReady!: () => void, onFatalError!: (e: unknown) => void;
    const allReady = new Promise<void>((res, rej) => {
      onAllReady = res;
      onFatalError = rej;
    });
    const request: Request = createRequest(children, {
      legacy: false,
      generateStaticMarkup: false,
      options,
      progressiveChunkSize: options?.progressiveChunkSize,
      onAllReady,
      onShellReady() {
        let destination: Destination | undefined;
        const stream = new ReadableStream<Uint8Array>(
          {
            type: "bytes",
            pull(controller: ReadableByteStreamController) {
              startFlowing(request, (destination ??= controllerDestination(controller)));
            },
            cancel(reason: unknown) {
              request.destination = null;
              abort(request, reason);
            },
          } as Any,
          { highWaterMark: 0 },
        ) as ReactDOMServerReadableStream;
        stream.allReady = allReady;
        resolve(stream);
      },
      onShellError(error) {
        allReady.catch(noop);
        reject(error);
      },
      onFatalError,
      onHeaders: options?.onHeaders && ((headers) => options.onHeaders!(new Headers(headers))),
      scheduleWork: scheduleTask,
    });
    if (options?.signal) attachAbortSignal(request, options.signal);
    startWork(request);
  });
}

/** The writable renderToPipeableStream pipes to: a Node stream.Writable, or anything shaped like one. */
export interface PipeableWritable {
  /** Takes a chunk (bytes, or a string too long for one of React's views); false when it is full. */
  write(chunk: Uint8Array | string): unknown;
  end(): unknown;
  destroy?(error?: unknown): unknown;
  flush?(): unknown;
  on(event: string, listener: (...args: Any[]) => void): unknown;
}

/** What renderToPipeableStream returns. */
export interface PipeableStream {
  pipe<W extends PipeableWritable>(destination: W): W;
  abort(reason?: unknown): void;
}

/**
 * The HTML of `children`, written to a Node writable once `pipe` is called (usually from
 * `onShellReady`, or from `onAllReady` for crawlers), as React's renderToPipeableStream does.
 */
export function renderToPipeableStream(
  children: ReactElement | Any,
  options?: RenderToPipeableStreamOptions,
): PipeableStream {
  const request = createRequest(children, {
    legacy: false,
    generateStaticMarkup: false,
    options,
    progressiveChunkSize: options?.progressiveChunkSize,
    onAllReady: options?.onAllReady,
    onShellReady: options?.onShellReady,
    onShellError: options?.onShellError,
    onHeaders: options?.onHeaders,
    scheduleWork: scheduleTask,
    md5: true,
  });
  let started = false;
  startWork(request);
  return {
    pipe(writable) {
      if (started) throw new Error("React currently only supports piping to one writable stream.");
      started = true;
      const destination = writableDestination(writable);
      safelyEmitEarlyPreloads(request, request.pendingRootTasks === 0);
      startFlowing(request, destination);
      writable.on("drain", () => startFlowing(request, destination));
      writable.on("error", () => {
        request.destination = null;
        abort(request, new Error("The destination stream errored while writing data."));
      });
      writable.on("close", () => {
        request.destination = null;
        abort(request, new Error("The destination stream closed early."));
      });
      return writable;
    },
    abort(reason) {
      abort(request, reason);
    },
  };
}

/** An API of React's server this module does not implement: it throws when called. */
function unsupported(name: string): (...args: Any[]) => never {
  return () => {
    throw new Error(
      `${name} is not supported by @reactre/compat/server: it renders with renderToString, renderToStaticMarkup, renderToReadableStream and renderToPipeableStream. Use react-dom/server's own ${name} for partial prerendering.`,
    );
  };
}

/** Not implemented: resuming needs React's prerender (partial prerendering). Throws. */
export const resume: (...args: Any[]) => never = unsupported("resume");
/** Not implemented: resuming needs React's prerender (partial prerendering). Throws. */
export const resumeToPipeableStream: (...args: Any[]) => never = unsupported("resumeToPipeableStream");
/** Not implemented (react-dom/static's partial prerendering). Throws. */
export const prerender: (...args: Any[]) => never = unsupported("prerender");
/** Not implemented (react-dom/static's partial prerendering). Throws. */
export const prerenderToNodeStream: (...args: Any[]) => never = unsupported("prerenderToNodeStream");

const ReactDOMServer: Record<string, unknown> = {
  version,
  renderToString,
  renderToStaticMarkup,
  renderToReadableStream,
  renderToPipeableStream,
  resume,
  resumeToPipeableStream,
  prerender,
  prerenderToNodeStream,
};
export default ReactDOMServer;

// #endregion
