// One case's start, in its own process: `bun --conditions=development start.ts <lib> <file> <base>`.
// It imports the case (which creates the actor), drives the app's events through the library's
// `drive`, and prints what it said: a throw, a rejection, a warning or an error logged. run.ts
// subtracts what the correct port says on the same events.

import type { Base, CaseModule, Library } from "./cases.ts";

const [key, file, base] = Bun.argv.slice(2) as [string, string, Base];
const lib = ((await import(`./${key}.ts`)) as { default: Library }).default;

/** A browser's storage, which the apps run beside: Bun has none. */
class MemoryStorage {
  readonly #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
}
if (typeof globalThis.localStorage === "undefined")
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

await lib.preload?.();

const said: string[] = [];
const message = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const text = (args: readonly unknown[]): string =>
  args.map((a) => (a instanceof Error ? message(a) : String(a))).join(" ");
console.warn = (...args: unknown[]) => void said.push(`warns: ${text(args)}`);
console.error = (...args: unknown[]) => void said.push(`logs an error: ${text(args)}`);
process.on("unhandledRejection", (e) => void said.push(`rejects: ${message(e)}`));
process.on("uncaughtException", (e) => void said.push(`throws later: ${message(e)}`));

try {
  const mod = (await import(file)) as CaseModule;
  await lib.drive(mod, base);
} catch (e) {
  said.unshift(`throws: ${message(e)}`);
}

// A marked line: a library may print to stdout too.
process.stdout.write(`\n@@said ${JSON.stringify(said)}\n`);
process.exit(0);
