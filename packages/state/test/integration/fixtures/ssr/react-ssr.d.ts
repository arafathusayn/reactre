// The part of React's and react-dom's API the SSR fixture uses, typed here: the repository
// installs `react` without `@types/react` (src/entries/react-hooks.d.ts does the same for the
// adapter's hooks), and adding it would be a new dependency. An app's own `@types/react` agrees.

declare module "react" {
  export interface ReactElement {
    readonly type: unknown;
    readonly props: unknown;
  }
  export function createElement(
    type: unknown,
    props?: { readonly [key: string]: unknown } | null,
    ...children: readonly unknown[]
  ): ReactElement;
  export const StrictMode: unknown;
}

declare module "react-dom/server" {
  export function renderToString(element: unknown): string;
}

declare module "react-dom/client" {
  export interface Root {
    render(element: unknown): void;
    unmount(): void;
  }
  export function hydrateRoot(container: unknown, element: unknown): Root;
}
