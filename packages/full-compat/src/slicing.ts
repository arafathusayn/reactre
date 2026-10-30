// Under Bun, which runs @reactre/compat's sources (its `bun` export condition), the core reads
// this flag where it would slice. The builds define it instead (../build.ts), so a source run gets
// it here, before anything renders. Set by name, so the builds' define leaves it alone.
Object.defineProperty(globalThis, "__REACTRE_SLICING__", { value: true, configurable: true, writable: true });
