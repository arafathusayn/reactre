// Spread props at a component call: `<C a={1} {...rest} b={x()} />`. The compiler passes a prop
// that may change as a getter, so a component's props object can hold getters, and handing it on
// (`<Child {...props} />`) must keep them: an object spread would read each once. `__props`
// merges the parts by their property descriptors instead, getters included, later parts winning
// as in a spread. It is in a bundle only when compiled code calls it.

/** Internal: the props of a component call with spread props, each part's getters kept. */
export function __props(...parts: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parts) if (p != null) Object.defineProperties(out, Object.getOwnPropertyDescriptors(p));
  return out;
}
