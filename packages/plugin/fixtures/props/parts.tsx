// `Count` is passed `n` reactively, so its hole follows it. `Provider` runs code before it reads
// its children, which are built only then.

import type { Child } from "@reactre/core/jsx-runtime";

export const log: string[] = [];

export function Count(props: { n: number }) {
  return <span class="count">{props.n}</span>;
}

export function Provider(props: { children: Child }) {
  log.push("provider");
  return <section>{props.children}</section>;
}
