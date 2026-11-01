// unplugin's types import two bundlers whose own declarations fail under skipLibCheck: false
// (Farm's need @types/koa and more; Rsbuild's mix CommonJS and ESM). Neither is reactre's, so
// they are stubbed: every other declaration, reactre's and the other bundlers', is checked.
declare module "@farmfe/core" {
  export type CompilationContext = any;
  export type JsPlugin = any;
}
declare module "@rsbuild/core" {
  export type RsbuildPlugin = any;
}
