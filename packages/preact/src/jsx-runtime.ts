// preact/jsx-runtime: the automatic JSX runtime. `ref` is taken out of a host element's props;
// the props object is otherwise the one JSX built.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import { type Any, Fragment, options, VNODE_MARKER } from "./engine.ts";

let vnodeId = 0;

/** A vnode for the automatic runtime's `jsx(type, props, key)`. */
export function jsx(type: Any, props: Any, key?: Any, _isStaticChildren?: Any, __source?: Any, __self?: Any): Any {
  if (!props) props = {};
  let normalizedProps = props,
    ref,
    i;
  if ("ref" in normalizedProps && typeof type != "function") {
    normalizedProps = {};
    for (i in props) {
      if (i == "ref") ref = props[i];
      else normalizedProps[i] = props[i];
    }
  }
  const vnode: Any = {
    type,
    props: normalizedProps,
    key,
    ref,
    __k: null,
    __: null,
    __b: 0,
    __e: null,
    __c: null,
    constructor: VNODE_MARKER,
    __v: --vnodeId,
    __i: -1,
    __u: 0,
  };
  if (__source || __self) {
    vnode.__source = __source;
    vnode.__self = __self;
  }
  if (options.vnode) options.vnode(vnode);
  return vnode;
}

export { Fragment, jsx as jsxDEV, jsx as jsxs };
