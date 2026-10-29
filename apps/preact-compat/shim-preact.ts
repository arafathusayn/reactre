// `react` and `react-dom` for the oracle: preact/compat 11.1.0, with stubs (stubs.ts) for the
// React APIs it does not have.
// @ts-expect-error preact/compat's types use `export =`, which `export *` cannot re-export; the module is ESM.
export * from "preact/compat";
export { default } from "preact/compat";
export { createRoot, hydrateRoot } from "preact/compat/client";
export * from "./stubs.ts";
