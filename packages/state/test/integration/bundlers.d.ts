// The bundlers the integration test resolves from @reactre/plugin's install, not from this
// package's: Rollup, webpack and Rspack are @reactre/plugin's dev dependencies, so their types
// aren't in this package's node_modules. These are the minimal typed surface the test uses, kept
// here as an ordinary module of exported types, NOT as ambient `declare module`s: ambient
// declarations are global, and they would shadow the real Rollup, webpack and Rspack types for
// every other package and app in the repository's root type check. A module export is visible only
// to whoever imports it, so the rest of the tree keeps its resolved-package types.

/** As much of Rollup's plugin as the test builds and hands to `rollup`. */
export interface RollupPlugin {
  readonly name: string;
  transform?(
    code: string,
    id: string,
  ): { code: string; map: null } | null | Promise<{ code: string; map: null } | null>;
}

/** As much of Rollup's options as the test passes. */
export interface RollupOptions {
  readonly input: string;
  readonly plugins: readonly RollupPlugin[];
  readonly logLevel?: "silent" | "warn" | "info" | "debug";
}

/** As much of Rollup's output as the test reads: its chunks' code. */
export interface RollupOutput {
  readonly output: readonly ({ readonly type: "chunk"; readonly code: string } | { readonly type: "asset" })[];
}

/** As much of Rollup's build as the test uses: `generate`. */
export interface RollupBuild {
  generate(options: { readonly format: "es" }): Promise<RollupOutput>;
}

/** The `rollup` module as the test imports it. */
export interface RollupModule {
  rollup(options: RollupOptions): Promise<RollupBuild>;
}

/** The node-resolve plugin module as the test imports it. */
export interface NodeResolveModule {
  nodeResolve(options?: { readonly extensions?: readonly string[] }): RollupPlugin;
}

/** As much of webpack's plugin as the test hands to the plugin entry. */
export interface WebpackPluginInstance {
  apply(compiler: unknown): void;
}

/** As much of webpack's stats as the test reads after a build. */
export interface Stats {
  hasErrors(): boolean;
  toString(options: { readonly errors: boolean }): string;
}

/** As much of webpack's config as the test passes. */
export interface WebpackConfiguration {
  readonly mode?: "production" | "development" | "none";
  readonly entry: string;
  readonly output: {
    readonly path: string;
    readonly filename: string;
    readonly library: { readonly type: "module" };
  };
  readonly experiments?: { readonly outputModule?: boolean };
  readonly plugins?: readonly WebpackPluginInstance[];
  readonly module?: {
    readonly rules: readonly { readonly test: RegExp; readonly use: readonly { readonly loader: string }[] }[];
  };
  readonly resolve?: { readonly extensions?: readonly string[] };
  readonly stats?: "errors-only";
}

/** The callback webpack and Rspack call when a build settles. */
export type BuildCallback = (error: Error | null, stats?: Stats) => void;

/** The `webpack` module as the test imports it (its default export is the runner). */
export interface WebpackModule {
  readonly default: (config: WebpackConfiguration, callback: BuildCallback) => void;
}

/** As much of Rspack's plugin as the test hands to the plugin entry. */
export interface RspackPluginInstance {
  apply(compiler: unknown): void;
}

/** As much of Rspack's config as the test passes. */
export interface RspackConfiguration {
  readonly mode?: "production" | "development" | "none";
  readonly entry: string;
  readonly output: {
    readonly path: string;
    readonly filename: string;
    readonly library: { readonly type: "module" };
  };
  readonly experiments?: { readonly outputModule?: boolean };
  readonly plugins?: readonly RspackPluginInstance[];
  readonly module?: {
    readonly rules: readonly { readonly test: RegExp; readonly use: readonly { readonly loader: string }[] }[];
  };
  readonly resolve?: { readonly extensions?: readonly string[] };
  readonly stats?: "errors-only";
}

/** The `@rspack/core` module as the test imports it. */
export interface RspackModule {
  rspack(config: RspackConfiguration, callback: BuildCallback): void;
}
