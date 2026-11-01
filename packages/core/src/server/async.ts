// @reactre/core/server/async: @reactre/core/features/async in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). Everything is the module's own
// but `<Loading>`, whose client version builds its children in a document fragment: here it is
// @reactre/core/server's, which writes its children, or its fallback while they wait (see there).

export * from "@reactre/core/features/async";
export { __ssrLoading as Loading } from "@reactre/core/server";
