// @reactre/compiler's hydrate mode (`compileJs(js, { hydrate: true })`): the client's code, for an
// app that @reactre/core/features/hydrate's `hydrate` runs over server-rendered HTML. The output
// is the client's, but for what claims the page: a template's clone (`__hclone`), a slot
// (`__hslot`), content inserted once (`__hinsert`), a list (`__hfor`), a fragment (that module's
// `__frag`), a `<Portal>`'s content (`__hportal`) and a `<Dynamic>` element (`__hel`, `__hkids`).
// The file imports the core from that module, which re-exports it with its `__frag`.
//
// Imports are pointed at hydration's versions, as the server mode points them at the server's:
// @reactre/core/features/async's and /errors' at @reactre/core/hydrate/async and /hydrate/errors,
// whose `<Loading>` and `<Errored>` take over what the server rendered of them. A hydrate build's
// bundler plugin loads @reactre/core's feature modules with `hydrateImports(code, false)`, so
// that they build their content with the `__frag` that claims (see that module).

/** The modules a hydrate build of an app imports in place of the client's. */
const HYDRATE_MODULES: Record<string, string> = {
  "@reactre/core/features/async": "@reactre/core/hydrate/async",
  "@reactre/core/features/errors": "@reactre/core/hydrate/errors",
};

/** The module the compiled code and the core's feature modules import the core from. */
export const HYDRATE_CORE: string = "@reactre/core/features/hydrate";

/** A module specifier of @reactre/core in an import or export: `from "..."`, `import "..."`, `import("...")`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(@reactre\/core(?:\/features\/[a-z]+)?)\2/g;

/** @reactre/core/features/hydrate itself (its sources' or its builds'), which imports the core as it is. */
export const HYDRATE_FILE: RegExp = /[\\/]features[\\/]hydrate\.[jt]s$/;

/**
 * Module `js`'s imports of @reactre/core, as a hydrate build makes them. With `app`, for the app's
 * own modules: @reactre/core/features/async and /errors point at @reactre/core/hydrate/async and
 * /hydrate/errors. Without, for @reactre/core's own feature modules: the core points at
 * @reactre/core/features/hydrate.
 */
export function hydrateImports(js: string, app: boolean = true): string {
  return js.replace(SPECIFIER, (whole, head: string, q: string, spec: string) => {
    const to = app ? HYDRATE_MODULES[spec] : spec === "@reactre/core" ? HYDRATE_CORE : undefined;
    return to === undefined ? whole : `${head}${q}${to}${q}`;
  });
}

/** @reactre/core/features/hydrate's helpers, with their local names, imported where the code uses them. */
export const HYDRATE_HELPERS: readonly (readonly [string, string])[] = [
  ["__hclone", "__rrhC"],
  ["__hslot", "__rrhS"],
  ["__hinsert", "__rrhI"],
  ["__hfor", "__rrhF"],
  ["__htemplate", "__rrhT"],
  ["__hportal", "__rrhP"],
  ["__hel", "__rrhE"],
  ["__hkids", "__rrhK"],
];

/** What compiling a file that calls `hydrate` without the hydrate mode throws. */
export const NEEDS_HYDRATE: string =
  "reactre: this file imports hydrate from @reactre/core/features/hydrate, and it is not compiled for hydration, " +
  "so its templates would clone instead of claiming the page. Build with @reactre/plugin's `hydrate: true` option " +
  "(or @reactre/compiler's `hydrate` compile option).";

/** Whether module `js` imports `hydrate` from @reactre/core/features/hydrate. */
export function importsHydrate(js: string): boolean {
  for (const m of js.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']@reactre\/core\/features\/hydrate["']/g))
    if (m[1]!.split(",").some((p) => p.trim().split(/\s+as\s+/)[0] === "hydrate")) return true;
  return false;
}
