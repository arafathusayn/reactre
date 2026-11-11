// The client half of the installed-tarball dev-React test: mount under StrictMode, which mounts,
// unmounts and mounts again. The dev entry's warnings are collected on `globalThis.__warnings`.

import { View } from "./app.tsx";
import { createElement, createRoot, StrictMode, useEffect } from "./react-shim.ts";

const container = document.getElementById("root");
if (container === null) throw new Error("no #root");

const warnings: string[] = [];
(globalThis as unknown as { __warnings: string[] }).__warnings = warnings;
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warnings.push(args.join(" "));
  warn(...args);
};

/** Set once the tree's effects have run. */
function Ready(): null {
  useEffect(() => {
    (globalThis as unknown as { __ready?: boolean }).__ready = true;
  }, []);
  return null;
}

createRoot(container).render(createElement(StrictMode, null, createElement(View), createElement(Ready)));
