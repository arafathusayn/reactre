// The same mistakes, made in @reactre/state and in each other library's port of the same apps, and
// where each is caught. The harness is ./mistakes/: the cases and the guide for filling a library
// are in ./mistakes/cases.ts, each library's mutations in ./mistakes/<lib>.ts, the runner in
// ./mistakes/run.ts. This entry runs it, with the same flags.
//
// Run: bun --conditions=development packages/state/compare/mistakes.ts [--lib=xstate] [--case=M12]
// (each library's development build, so its runtime warnings count.)

export {};

await import("./mistakes/run.ts");
