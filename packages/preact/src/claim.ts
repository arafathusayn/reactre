// Rendering over DOM the renderer did not create: hydration, and Preact's render into a container
// that already has children (it claims matching nodes and removes the rest). The rules are
// Preact 11.1.0's, moved out of the diff into the engine's `claim` slot.
//
// Only `render` and `hydrate` from this module fill the slot, and only they can hand the diff
// existing DOM: compat's createRoot empties its container first, so an app that never hydrates
// bundles none of this.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

import {
  type Any,
  hydrate as engineHydrate,
  render as engineRender,
  MODE_HYDRATE,
  MODE_SUSPENDED,
  NULL,
  removeNode,
  slots,
} from "./engine.ts";

/** The comment closing the server's Suspense range opened by `start`, collecting the nodes between. */
function rangeEnd(start: Any, nodes?: Any[]): Any {
  if (start && start.nodeType == 8 && start.data.startsWith("$s")) {
    for (let depth = 1; (start = start.nextSibling); ) {
      if (start.nodeType == 8) {
        if (start.data.startsWith("$s")) depth++;
        else if (start.data.startsWith("/$s") && !--depth) return start;
      }
      if (nodes) nodes.push(start);
    }
  }
}

const claim = {
  /**
   * A vnode that suspended while hydrating renders again: resume on the DOM range it kept.
   * Returns [isHydrating, the range's nodes to claim (or none), the DOM after them].
   */
  r(newVNode: Any, oldVNode: Any, oldDom: Any): [Any, Any, Any] {
    const isHydrating = oldVNode.__u & MODE_HYDRATE,
      start = oldVNode.__c.__z;
    if (!start) return [isHydrating, NULL, oldDom];
    newVNode.__u |= isHydrating;
    const excess: Any[] = [];
    if (start.nodeType == 8) oldDom = rangeEnd(start, excess);
    else excess.push(start);
    return [isHydrating, excess, excess[0] || oldDom];
  },

  /**
   * A component threw while its DOM was being claimed. A promise (a suspension) keeps the server's
   * DOM for the subtree, up to the matching `/$s` comment when the server marked the boundary;
   * any other error removes the unclaimed nodes. Returns the DOM after the subtree.
   */
  c(e: Any, newVNode: Any, excessDomChildren: Any, oldDom: Any, isHydrating: Any): Any {
    if (e.then) {
      let commentMarkersToFind = 0,
        startMarker: Any,
        end: Any;
      newVNode.__u |= MODE_SUSPENDED | isHydrating;
      if (excessDomChildren) {
        let i = excessDomChildren.indexOf(oldDom || undefined),
          child;
        if (!~i) i = excessDomChildren.length;
        while ((child = excessDomChildren[i - 1]) && child.nodeType == 8) i--;
        for (; i < excessDomChildren.length; i++) {
          child = excessDomChildren[i];
          if (!child) continue;
          excessDomChildren[i] = NULL;
          if (child.nodeType == 8) {
            if (child.data.startsWith("$s")) {
              if (!commentMarkersToFind++) startMarker = child;
            } else if (commentMarkersToFind && child.data.startsWith("/$s") && !--commentMarkersToFind) break;
          } else if (!commentMarkersToFind) break;
        }
      }
      if (!startMarker) {
        while (oldDom && oldDom.nodeType == 8 && oldDom.nextSibling) oldDom = oldDom.nextSibling;
        startMarker = oldDom;
      }
      startMarker = newVNode.__c.__z || (newVNode.__c.__z = startMarker);
      if ((end = rangeEnd(startMarker))) {
        newVNode.__e = startMarker;
        oldDom = end;
      } else newVNode.__e = oldDom;
      return oldDom && oldDom.nextSibling;
    }
    if (excessDomChildren) excessDomChildren.some(removeNode);
    return oldDom;
  },

  /** The first unclaimed node for a host vnode of `nodeType` (null for text), claimed. */
  n(excessDomChildren: Any[], nodeType: Any): Any {
    for (let i = 0; i < excessDomChildren.length; i++) {
      const value = excessDomChildren[i];
      if (value && (nodeType ? value.localName == nodeType : value.nodeType == 3)) {
        excessDomChildren[i] = NULL;
        return value;
      }
    }
  },

  /** A claimed element's attributes, as the old props a render (not a hydration) diffs against. */
  a(dom: Any): Any {
    const oldProps: Any = {};
    for (let i = 0; i < dom.attributes.length; i++) oldProps[dom.attributes[i].name] = dom.attributes[i].value;
    return oldProps;
  },

  /** An unmounted component's kept server range goes with it. */
  u(vnode: Any, start: Any): void {
    const nodes: Any[] = [];
    const end = rangeEnd(start, nodes);
    if (end) {
      if (start == vnode.__e) nodes.some(removeNode);
      removeNode(end);
      removeNode(start);
    }
  },
};

/** Preact's render: diffs against what was rendered before, or claims the DOM already there. */
export function render(vnode: Any, parentDom: Any): void {
  slots.claim = claim;
  engineRender(vnode, parentDom);
}

/** Attach `vnode` to the DOM already in `parentDom` (server-rendered) without diffing it. */
export function hydrate(vnode: Any, parentDom: Any): void {
  slots.claim = claim;
  engineHydrate(vnode, parentDom);
}
