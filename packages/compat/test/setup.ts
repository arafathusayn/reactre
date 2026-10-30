// Preloaded before every test file (bunfig.toml): the tests run compat's sources with time slicing
// compiled in, as @reactre/full-compat builds them, so its tests can turn it on (src/slicing.ts).
// It stays off unless a test turns it on, and then compat renders as @reactre/compat's builds do.
(globalThis as { __REACTRE_SLICING__?: boolean }).__REACTRE_SLICING__ = true;
