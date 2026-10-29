// The keys an app's compat options turn on and off (@reactre/plugin's `compat.apis` and
// `compat.exclude`): React's export names, and groups of them. @reactre/plugin reads this to
// write the module `react` resolves to, and to find the switched-off APIs an app's code uses; the
// tests check it against the runtime's default export.
//
// Design decisions:
//   - A key is the name an app imports. A switched-off name stays exported as a function that
//     throws, so a library's `typeof React.useEffect === "function"` check still passes and the
//     failure is loud, not a silent fallback.
//   - `Component` is class support: off, `react` resolves to @reactre/compat/core, whose own
//     Component throws a clear error when a class renders.
//   - What every app needs (elements, fragments, the version and the internals compiled code and
//     libraries read) is not a key.
//   - A behaviour React has that is not an export (component stacks, React's handling of repeated
//     keys) is a key too, in BEHAVIOURS. A behaviour is on unless an app's options exclude it, so
//     every set of options is React's behaviour for everything it keeps.
//   - A key whose code is a module of its own (MODULES) is in the build exactly when it is on:
//     @reactre/plugin's entry imports that module, which installs it into @reactre/compat/core.

/** The names every build exports, which no option turns off. */
export const ALWAYS: readonly string[] = [
  "version",
  "Fragment",
  "createElement",
  "__COMPILER_RUNTIME",
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
];

/** The names an app can turn off, in the order of the runtime's default export. */
export const KEYS: readonly string[] = [
  "StrictMode",
  "Profiler",
  "Suspense",
  "Activity",
  "ViewTransition",
  "addTransitionType",
  "Children",
  "Component",
  "PureComponent",
  "cloneElement",
  "isValidElement",
  "createRef",
  "createContext",
  "memo",
  "forwardRef",
  "lazy",
  "use",
  "useState",
  "useReducer",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
  "useImperativeHandle",
  "useDebugValue",
  "useId",
  "useSyncExternalStore",
  "useTransition",
  "useDeferredValue",
  "useOptimistic",
  "useActionState",
  "useEffectEvent",
  "startTransition",
  "cache",
  "cacheSignal",
  "captureOwnerStack",
  "unstable_useCacheRefresh",
  "act",
  "createRoot",
  "hydrateRoot",
  "createPortal",
  "browser",
  "flushSync",
  "unstable_batchedUpdates",
  "useFormStatus",
  "useFormState",
  "requestFormReset",
  "preconnect",
  "prefetchDNS",
  "preload",
  "preloadModule",
  "preinit",
  "preinitModule",
];

/**
 * Keys for React's behaviours that are not exports: on unless the options exclude them, whatever
 * `apis` lists. `componentStack`: errors are reported with React's component stack (else an empty
 * one). `repeatedKeys`: a list whose keys repeat is reconciled as React does (else by compat's own
 * rules). `renderRetry`: a render that throws renders again before its error counts, as React does
 * (else the error counts at once). `concurrentRendering`: transitions render as React's lanes
 * render them, after urgent updates, keeping the screen while one suspends (else at once).
 * `viewTransitions`: a transition that changes a <ViewTransition> commits through
 * `document.startViewTransition`, as React's does (else it commits plainly); it needs
 * `concurrentRendering`. `renderUndo`: an urgent render that suspends with no Suspense boundary
 * above is undone and the screen kept, as React keeps it (else what rendered commits).
 */
export const BEHAVIOURS: readonly string[] = [
  "componentStack",
  "repeatedKeys",
  "renderRetry",
  "concurrentRendering",
  "viewTransitions",
  "renderUndo",
];

/**
 * The keys whose code is a module of its own, and that module. With the key on, the module
 * @reactre/plugin writes for an app's options imports it; @reactre/compat imports all of them.
 */
export const MODULES: Readonly<Record<string, string>> = {
  Component: "@reactre/compat/features/classes",
  componentStack: "@reactre/compat/features/stacks",
  repeatedKeys: "@reactre/compat/features/keys",
  renderRetry: "@reactre/compat/features/retry",
  concurrentRendering: "@reactre/compat/features/concurrent",
  viewTransitions: "@reactre/compat/features/viewTransitions",
  renderUndo: "@reactre/compat/features/undo",
};

/** Groups of keys, by the feature they make up. A group is written where a key may be. */
export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "@suspense": ["Suspense", "lazy"],
  "@transitions": ["startTransition", "useTransition", "useDeferredValue", "useOptimistic", "addTransitionType"],
  "@forms": ["useActionState", "useFormState", "useFormStatus", "requestFormReset"],
  "@hints": ["preconnect", "prefetchDNS", "preload", "preloadModule", "preinit", "preinitModule"],
  "@classes": ["Component", "PureComponent"],
};

/** Keys that are part of another: on, they turn it on; it off, they are off. */
export const REQUIRES: Readonly<Record<string, string>> = {
  PureComponent: "Component",
  useFormState: "useActionState",
  viewTransitions: "concurrentRendering",
};

const known = new Set([...KEYS, ...BEHAVIOURS]);

/** Keys and groups as keys, or an error naming the first unknown one. */
function expand(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of list) {
    const group = GROUPS[k];
    if (group !== undefined) out.push(...group);
    else if (known.has(k)) out.push(k);
    else
      throw new Error(
        `@reactre/compat: "${k}" is not an API key. Keys are React's export names (${KEYS.join(", ")}), ` +
          `the behaviours ${BEHAVIOURS.join(", ")} and the groups ${Object.keys(GROUPS).join(", ")}.`,
      );
  }
  return out;
}

/**
 * The keys that are on for `apis` ("all", or the keys an app uses) and every behaviour, less
 * `exclude`. A key listed in `apis` turns on what it is part of; a key excluded turns off what is
 * part of it.
 */
export function enabledApis(apis: "all" | readonly string[], exclude: readonly string[]): Set<string> {
  const on = new Set([...(apis === "all" ? KEYS : expand(apis)), ...BEHAVIOURS]);
  for (const [k, whole] of Object.entries(REQUIRES)) if (on.has(k)) on.add(whole);
  for (const k of expand(exclude)) on.delete(k);
  for (const [k, whole] of Object.entries(REQUIRES)) if (!on.has(whole)) on.delete(k);
  if (!on.has("createRoot") && !on.has("hydrateRoot"))
    throw new Error("@reactre/compat: an app needs createRoot or hydrateRoot; the options turn both off.");
  return on;
}
