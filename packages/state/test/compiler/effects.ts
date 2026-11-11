// A module that isn't marked pure, for ../compiler.test.ts: a transition may not call its functions,
// since the compiler doesn't check them.

/** Fetches `url` again in a second: an effect. */
export function scheduleRetry(url: string): void {
  setTimeout(() => void fetch(url), 1000);
}
