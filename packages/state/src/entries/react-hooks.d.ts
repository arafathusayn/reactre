// The part of React's API ./react.ts uses, typed here: the repository installs `react` without
// `@types/react`, and adding it would be a new dependency. An app's own `@types/react` agrees.

declare module "react" {
  export function useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  export function useState<T>(initial: () => T): [T, (next: T) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useCallback<F extends (...args: never[]) => unknown>(fn: F, deps: readonly unknown[]): F;
  export function useRef<T>(initial: T): { current: T };
}
