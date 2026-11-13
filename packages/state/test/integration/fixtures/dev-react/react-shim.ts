// The fixture's React, typed here. The repository has no @types/react (compiler.test.ts documents
// it, and relies on the import failing), so a consumer fixture that uses React can't type-check
// against real React types. This shim types exactly the members the fixture uses, at the boundary,
// and is imported explicitly: it is not a global `declare module "react"`, which would hide the
// missing types from the compiler's own tests.

// React resolves (the package is installed) but has no declarations: a namespace import is fine.
import * as reactModule from "react";
// react-dom/client resolves untyped (any): the cast below types it.
import * as clientModule from "react-dom/client";

/** A rendered node, as the fixture passes it around. */
export type Node = unknown;

const react = reactModule as unknown as {
  readonly createElement: (type: unknown, props?: unknown, ...children: Node[]) => Node;
  readonly StrictMode: (props: { readonly children?: Node }) => Node;
  readonly useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
};
const client = clientModule as unknown as {
  readonly createRoot: (container: Element) => { readonly render: (node: Node) => void };
};

export const createElement = react.createElement;
export const StrictMode = react.StrictMode;
export const useEffect = react.useEffect;
export const createRoot = client.createRoot;
