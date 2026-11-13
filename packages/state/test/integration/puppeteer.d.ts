// The part of puppeteer-core's API the SSR test uses, typed here: puppeteer-core is
// @reactre/plugin's dev dependency (apps/react-compat uses it), not this package's, so its types
// aren't in this package's node_modules. The test resolves the module from apps/react-compat at
// run time. These are exported types, NOT ambient `declare module`s: ambient declarations are
// global and would shadow the real puppeteer-core types for every other package and app in the
// repository's root type check. A module export is visible only to whoever imports it.

/** As much of puppeteer's page as the SSR test uses. */
export interface Page {
  on(event: "pageerror", listener: (error: unknown) => void): void;
  setContent(html: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  addScriptTag(options: { readonly content: string; readonly type?: string }): Promise<unknown>;
  waitForFunction(fn: () => boolean, options?: { readonly timeout?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
}

/** As much of puppeteer's browser as the SSR test uses. */
export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/** As much of puppeteer's launch options as the SSR test passes. */
export interface LaunchOptions {
  readonly executablePath: string;
  readonly headless: boolean;
  readonly args?: readonly string[];
}

/** The `puppeteer-core` module as the SSR test imports it (its default export is the API). */
export interface PuppeteerModule {
  readonly default: Puppeteer;
}

/** The part of puppeteer's API the SSR test calls. */
export interface Puppeteer {
  launch(options: LaunchOptions): Promise<Browser>;
}
