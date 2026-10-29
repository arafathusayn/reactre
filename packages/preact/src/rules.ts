// Which host elements become templates, and how compat names their props. The compiler applies
// these rules at build time (src/compiler.ts), and the `html` tag at run time (src/html.ts), so
// JSX and a tagged template make the same templates.

/**
 * Tags that stay plain vnodes. Form fields write value and checked after their children,
 * against the live DOM. A template element's children live in .content. compat drops a
 * noscript's children.
 */
export const BAIL_TAGS: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "select",
  "option",
  "progress",
  "template",
  "noscript",
]);

/** Props with a behaviour of their own in Preact's element diff, or none in a template. */
export const BAIL_PROPS: ReadonlySet<string> = new Set([
  "ref",
  "key",
  "dangerouslySetInnerHTML",
  "is",
  "value",
  "checked",
  "defaultValue",
  "defaultChecked",
]);

/**
 * DOM properties with no attribute behind them. Set on a template's prototype, a clone would not
 * carry them, so a literal value for one is a hole, written on each use.
 */
export const UNCLONED: ReadonlySet<string> = new Set(
  "muted volume playbackRate defaultPlaybackRate currentTime srcObject scrollTop scrollLeft indeterminate selectedIndex innerText outerHTML outerText nodeValue".split(
    " ",
  ),
);

// What compat's vnode hook (src/compat.ts) does to a host element's props, applied to a
// template's names and literal values.
const CAMEL_PROPS =
  /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(?!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;

/** A React prop name as compat renames it, on an element that is not a form field. */
export function reactName(i: string): string {
  if (i === "className") return "class";
  if (i[0] === "o" && i[1] === "n") {
    const l = i.toLowerCase();
    if (l === "ondoubleclick") return "ondblclick";
    if (l === "onfocus") return "onfocusin";
    if (l === "onblur") return "onfocusout";
    return l === "oninput" ? l : i;
  }
  return CAMEL_PROPS.test(i) ? i.replace(/[A-Z0-9]/g, "-$&").toLowerCase() : i;
}

/** A literal prop value as compat writes it. null is no prop, except on an event. */
export function reactValue(name: string, v: unknown): unknown {
  if (name === "download" && v === true) return "";
  if (name === "translate" && v === "no") return false;
  return v === null && !(name[0] === "o" && name[1] === "n") ? undefined : v;
}

/** Whether a host element of `tag` with these prop names can be a template: no rule above leaves it a plain vnode. */
export const templatable = (tag: string, names: readonly string[]): boolean =>
  !tag.includes("-") &&
  !BAIL_TAGS.has(tag) &&
  !names.some((n) => BAIL_PROPS.has(n)) &&
  !(names.includes("class") && names.includes("className"));
