// @reactre/preact's renderer: Preact 11.1.0's diff, ported to TypeScript, with one addition, a
// slot through which compiled templates (blocks, src/block.ts) render.
//
// Preact's source is the specification: every rule here (which props become DOM properties,
// how children match by key and type, when components render and in what order, how errors
// reach a boundary) is Preact's, line for line where it can be. Where this file differs, the
// difference is only in how the work is done, never in what the DOM or the app observes.
//
// Design decisions:
//   - Internal fields carry Preact's own minified names (`__k` children, `__` parent, `__e` DOM,
//     `__c` component, `__v` original, `__u` flags, ...), and `options` carries its hooks under
//     Preact's names (`__b`, `__r`, `diffed`, `__c`, `unmount`, `__e`). Code written against
//     Preact's internals, as its devtools and signals are, finds what it expects, and the names
//     cost the bundle no more than mangled ones.
//   - Like Preact, the hooks, compat and Suspense install themselves through `options` when
//     they load, so an app that imports none of them ships none of their code.
//   - A block vnode (src/block.ts) is a host vnode whose type is its root's tag name. It renders
//     through `slots.block`, which only block.ts fills, and block.ts is only bundled when the
//     compiler's output imports it: the slot is filled whenever a block exists.
//
// Field legend. VNode: type, props, key, ref, __k children, __ parent, __b depth, __e first DOM
// node, __c component, __v original (render identity), __i index in the parent, __u flags.
// Component: __g bits, __v vnode, __P parent DOM, __n global context, __s next state, __h render
// callbacks, __k state callbacks, __z suspended DOM range start, __H hooks. DOM: l listeners,
// __a attach times, __x ref cleanup, __k a root's vnode.
//
// Preact is MIT licensed, Copyright (c) 2015-present Jason Miller; see NOTICE.

// biome-ignore lint: the engine works on Preact's untyped internals.
export type Any = any;

// #region Constants

/**
 * Class support. @reactre/preact/compiler rewrites this line to false for an app that switches
 * classes off (the "Component" key), and the bundler drops the class-only code that tests it.
 */
const CLASSES: boolean = true;
/** The error a class component meets with class support off. */
const CLASSES_OFF =
  ' is a class component, and class support is switched off: remove "Component" from @reactre/preact/compiler\'s off option.';

/** Hydration attaches to the DOM tree without diffing it. */
export const MODE_HYDRATE: number = 1 << 5;
/** The vnode suspended on its previous render. */
export const MODE_SUSPENDED: number = 1 << 7;
/** The vnode is to be inserted while its siblings are placed. */
const INSERT_VNODE = 1 << 2;
/** The vnode was matched with a new one in the diff. */
const MATCHED = 1 << 1;
/** Props are written again on the next diff (the DOM was kept across a suspension). */
export const FORCE_PROPS_REVALIDATE: number = 1 << 0;
/** The vnode's ref was detached while Suspense parked its subtree. */
export const REF_DETACHED: number = 1 << 3;
/** A matched vnode that may be part of the longest increasing subsequence. */
const LIS_CANDIDATE = 1 << 4;
/** Reset the mode flags. */
const RESET_MODE = ~(MODE_HYDRATE | MODE_SUSPENDED);

/** The component is handling an error. */
const COMPONENT_PROCESSING_EXCEPTION = 1 << 0;
/** The component has an error to handle. */
const COMPONENT_PENDING_ERROR = 1 << 1;
/** The next render skips shouldComponentUpdate. */
export const COMPONENT_FORCE: number = 1 << 2;
/** The component is queued to render. */
const COMPONENT_DIRTY = 1 << 3;

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const MATH_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const MATHML_TOKEN_ELEMENTS = /^m(i|n|o|s|text|space)$/;

export const NULL = null;
export const VNODE_MARKER: symbol = Symbol.for("pv");
export const EMPTY_OBJ: Any = {};
export const EMPTY_ARR: Any[] = [];
export const isArray: (v: unknown) => v is Any[] = Array.isArray;
export const assign: typeof Object.assign = Object.assign;
const slice = EMPTY_ARR.slice;

/** Remove a node from its parent, if it has one. */
export function removeNode(node: Any): void {
  if (node && node.parentNode) node.remove();
}

// #endregion

// #region Options and slots

/**
 * Preact's `options`: the hooks a plugin sets to observe or change rendering. Public ones are
 * `vnode`, `event`, `diffed`, `unmount`, `debounceRendering`, `requestAnimationFrame` and
 * `useDebugValue`; the others keep Preact's minified names.
 */
export const options: Any = {
  __e: catchError,
};

/**
 * Render paths another module fills. src/block.ts fills `block`, `copy`, `drop` and `expand`
 * when a compiled template exists: diffing a block, copying one rendered twice, dropping one that
 * unmounts, and expanding one into plain vnodes. src/claim.ts fills `claim` when an app renders
 * over existing DOM (core's render, hydrate): only then does a diff see DOM it did not create.
 * src/effects.ts fills `p` and `u`, which queue passive effects and their cleanups after paint.
 */
export const slots: { block: Any; copy: Any; drop: Any; expand: Any; claim: Any; p: Any; u: Any } = {
  p: NULL,
  u: NULL,
  block: NULL,
  copy: NULL,
  drop: NULL,
  expand: NULL,
  claim: NULL,
};

/**
 * How compat writes a compiled template's hole values (src/compat.ts fills these): `v` changes a
 * value as its vnode hook would (numbers in style to px), and `s` is the `$$typeof` its elements
 * carry. Names and literal values need nothing here: the compiler applies compat's renames.
 */
export const blockHooks: {
  v: ((name: string, value: Any) => Any) | null;
  s: Any;
} = { v: NULL, s: undefined };

// #endregion

// #region Elements

let vnodeId = 0;

/** Preact's createElement (h): `key` and, for host elements, `ref` are taken out of the props. */
export function createElement(type: Any, props?: Any, ...children: Any[]): Any;
export function createElement(type: Any, props?: Any, children?: Any): Any {
  let normalizedProps: Any = {},
    key,
    ref,
    i: Any;
  const length = arguments.length;
  for (i in props) {
    if (i == "key") key = props[i];
    else if (i == "ref" && typeof type != "function") ref = props[i];
    else normalizedProps[i] = props[i];
  }
  if (length > 2) normalizedProps.children = length > 3 ? slice.call(arguments, 2) : children;
  return createVNode(type, normalizedProps, key, ref, NULL);
}

/** A copy of `vnode` with props merged in and, when given, its children replaced. */
export function cloneElement(vnode: Any, props?: Any, ...children: Any[]): Any;
export function cloneElement(vnode: Any, props?: Any, children?: Any): Any {
  let normalizedProps: Any = assign({}, vnode.props),
    key,
    ref,
    i: Any;
  const length = arguments.length;
  for (i in props) {
    if (i == "key") key = props[i];
    else if (i == "ref" && typeof vnode.type != "function") ref = props[i];
    else normalizedProps[i] = props[i];
  }
  if (length > 2) normalizedProps.children = length > 3 ? slice.call(arguments, 2) : children;
  return createVNode(
    vnode.type,
    normalizedProps,
    key !== undefined ? key : vnode.key,
    ref !== undefined ? ref : vnode.ref,
    NULL,
  );
}

/**
 * A vnode. One allocation site keeps one object shape for every vnode. `original` is set for an
 * exact copy, which skips `options.vnode`.
 */
export function createVNode(type: Any, props: Any, key: Any, ref: Any, original: Any): Any {
  const vnode = {
    type,
    props,
    key,
    ref,
    __k: NULL,
    __: NULL,
    __b: 0,
    __e: NULL,
    __c: NULL,
    constructor: VNODE_MARKER,
    __v: original || ++vnodeId,
    __i: -1,
    __u: 0,
  };
  if (!original && options.vnode) options.vnode(vnode);
  return vnode;
}

/** A ref object. */
export function createRef(): { current: Any } {
  return { current: NULL };
}

/** Renders its children. */
export function Fragment(props: Any): Any {
  return props.children;
}

/** Whether `vnode` is a Preact vnode. */
export const isValidElement = (vnode: Any): boolean => vnode != NULL && vnode.constructor === VNODE_MARKER;

// #endregion

// #region Components and the render queue

/** Preact's Component: setState and forceUpdate queue a render. */
export function Component(this: Any, props: Any, context: Any): void {
  this.props = props;
  this.context = context;
  this.__g = 0;
}

Component.prototype.setState = function (this: Any, update: Any, callback?: Any): void {
  // The next state is copied from the current one the first time only.
  let s = this.__s;
  if (!s || s == this.state) s = this.__s = assign({}, this.state);
  // Libraries such as immer freeze the state: hand the updater a copy.
  if (typeof update == "function") update = update(assign({}, s), this.props);
  if (update) assign(s, update);
  else return;
  if (this.__v) {
    if (callback) this.__k.push(callback);
    enqueueRender(this);
  }
};

Component.prototype.forceUpdate = function (this: Any, callback?: Any): void {
  if (this.__v) {
    // forceUpdate never asks shouldComponentUpdate.
    this.__g |= COMPONENT_FORCE;
    if (callback) this.__h.push(callback);
    enqueueRender(this);
  }
};

Component.prototype.render = Fragment;

/**
 * The first DOM node after `vnode`'s children from `childIndex` on, or after `vnode` itself when
 * `childIndex` is null: the insertion point for what is placed there.
 */
export function getDomSibling(vnode: Any, childIndex?: Any): Any {
  if (childIndex == NULL) return vnode.__ && getDomSibling(vnode.__, vnode.__i + 1);
  let sibling;
  for (; childIndex < vnode.__k.length; childIndex++) {
    sibling = vnode.__k[childIndex];
    // A child's __e is its first DOM node, kept current by updateParentDomPointers.
    if (sibling && sibling.__e) return sibling.__e;
  }
  // None among the children: continue after the vnode, unless it is a DOM node or a portal,
  // whose children are the only ones in their parent.
  return typeof vnode.type == "function" && !vnode.props.__P ? getDomSibling(vnode) : NULL;
}

/** Render `component` again where it is. */
function renderComponent(component: Any): void {
  const oldVNode = component.__v,
    oldDom = oldVNode.__e,
    commitQueue: Any[] = [],
    refQueue: Any[] = [];
  const parentDom = component.__P;
  if (parentDom) {
    const newVNode = assign({ constructor: VNODE_MARKER }, oldVNode);
    newVNode.__v = oldVNode.__v + 1;
    if (options.vnode) options.vnode(newVNode);
    diff(
      parentDom,
      newVNode,
      oldVNode,
      component.__n,
      parentDom.namespaceURI,
      oldVNode.__u & MODE_HYDRATE ? [oldDom] : NULL,
      commitQueue,
      oldDom || getDomSibling(oldVNode),
      oldVNode.__u & MODE_HYDRATE,
      refQueue,
    );
    newVNode.__v = oldVNode.__v;
    newVNode.__.__k[newVNode.__i] = newVNode;
    commitRoot(commitQueue, newVNode, refQueue);
    oldVNode.__ = oldVNode.__e = NULL;
    if (newVNode.__e != oldDom) updateParentDomPointers(newVNode);
  }
}

/** Point the ancestors' first DOM node at their new first child, up to the nearest DOM vnode. */
function updateParentDomPointers(vnode: Any): void {
  if ((vnode = vnode.__) && vnode.__c && !vnode.props.__P) {
    vnode.__e = NULL;
    vnode.__k.some((child: Any) => child && (vnode.__e = child.__e));
    updateParentDomPointers(vnode);
  }
}

/** Components waiting to render. */
const rerenderQueue: Any[] = [];
let prevDebounce: Any,
  rerenderCount = 0;

/** Restart the count of queued renders (after an error escapes). */
function resetRenderCount(): void {
  rerenderCount = 0;
}

/**
 * Queue `c` to render. The queue is flushed by `options.debounceRendering`, or a microtask: set
 * state several times in a row and the component renders once.
 */
export function enqueueRender(c: Any): void {
  if (
    (!(c.__g & COMPONENT_DIRTY) && ((c.__g |= COMPONENT_DIRTY), rerenderQueue.push(c), !rerenderCount++)) ||
    prevDebounce != options.debounceRendering
  ) {
    prevDebounce = options.debounceRendering;
    (prevDebounce || queueMicrotask)(processQueue);
  }
}

const depthSort = (a: Any, b: Any): number => a.__v.__b - b.__v.__b;

/** Render every queued component, parents before children. */
function processQueue(): void {
  try {
    let c,
      l = 1;
    while (rerenderQueue.length) {
      // Keep the queue sorted by depth; renders queued while it flushes join in order.
      if (rerenderQueue.length > l) rerenderQueue.sort(depthSort);
      c = rerenderQueue.shift();
      l = rerenderQueue.length;
      if (c.__g & COMPONENT_DIRTY) renderComponent(c);
    }
  } finally {
    if ((rerenderCount = rerenderQueue.length)) (prevDebounce || queueMicrotask)(processQueue);
  }
}

// #endregion

// #region Context and portals

let contextId = 0;

/** Preact's createContext: a Provider that re-renders its subscribers when its value changes. */
export function createContext(defaultValue: Any): Any {
  function Context(this: Any, props: Any): Any {
    if (!this.getChildContext) {
      const subs = new Set<Any>();
      const ctx: Any = {};
      ctx[Context.__c] = this;
      this.getChildContext = () => ctx;
      this.shouldComponentUpdate = function (this: Any, _props: Any) {
        if (this.props.value != _props.value) {
          subs.forEach((c) => {
            c.__g |= COMPONENT_FORCE;
            enqueueRender(c);
          });
        }
      };
      this.sub = (c: Any) => {
        subs.add(c);
        const old = c.componentWillUnmount;
        c.componentWillUnmount = () => {
          subs.delete(c);
          if (old) old.call(c);
        };
      };
    }
    return props.children;
  }
  Context.__c = "__cC" + contextId++;
  Context.__ = defaultValue;
  Context.Consumer = (props: Any, contextValue: Any) => props.children(contextValue);
  (Context as Any).Provider = (Context.Consumer as Any).contextType = Context;
  return Context;
}

function Portal(props: Any): Any {
  return props.children;
}

/** Render `vnode` into `container`, wherever the portal element sits. */
export function createPortal(vnode: Any, container: Any): Any {
  return createVNode(Portal, { __P: container, children: vnode }, undefined, undefined, NULL);
}

// #endregion

// #region Rendering roots

/** Render `vnode` into `parentDom`, diffing against what was rendered there before. */
export function render(vnode: Any, parentDom: Any): void {
  if (options.__) options.__(vnode, parentDom);
  // A document renders into its root element.
  if (parentDom.nodeType == 9) parentDom = parentDom.documentElement;
  const isHydrating = vnode && vnode.__u & MODE_HYDRATE;
  // The previous tree, kept on the DOM node; none the first time.
  const oldVNode = isHydrating ? NULL : parentDom.__k;
  parentDom.__k = createVNode(Fragment, { children: [vnode] }, undefined, undefined, NULL);
  const commitQueue: Any[] = [],
    refQueue: Any[] = [];
  diff(
    parentDom,
    parentDom.__k,
    oldVNode || EMPTY_OBJ,
    EMPTY_OBJ,
    parentDom.namespaceURI,
    oldVNode ? NULL : parentDom.firstChild ? slice.call(parentDom.childNodes) : NULL,
    commitQueue,
    oldVNode ? oldVNode.__e : parentDom.firstChild,
    isHydrating,
    refQueue,
  );
  commitRoot(commitQueue, parentDom.__k, refQueue);
  // The live children are tracked on __k after the diff.
  parentDom.__k.props.children = NULL;
}

/** Attach `vnode` to the DOM already in `parentDom` (server-rendered) without diffing it. */
export function hydrate(vnode: Any, parentDom: Any): void {
  // Only objects carry the flag; a primitive renders into the DOM the same way.
  if (vnode && typeof vnode == "object") vnode.__u |= MODE_HYDRATE;
  render(vnode, parentDom);
}

// #endregion

// #region Errors

/**
 * Hand `error`, thrown in `vnode`'s subtree, to the nearest boundary: a component with
 * getDerivedStateFromError or componentDidCatch. Thrown again when none handles it.
 */
function catchError(error: Any, vnode: Any, _oldVNode?: Any, errorInfo?: Any): void {
  let component, ctor, handled;
  for (; (vnode = vnode.__);) {
    if ((component = vnode.__c) && !(component.__g & COMPONENT_PROCESSING_EXCEPTION)) {
      component.__g |= COMPONENT_FORCE;
      try {
        ctor = component.constructor;
        if (CLASSES && (handled = ctor && ctor.getDerivedStateFromError))
          component.setState(ctor.getDerivedStateFromError(error));
        if (component.componentDidCatch) {
          component.componentDidCatch(error, errorInfo || {});
          handled = 1;
        }
        // A boundary: it renders again with the error noted.
        if (handled && component.__g & COMPONENT_DIRTY) {
          component.__g |= COMPONENT_PENDING_ERROR;
          return;
        }
      } catch (e) {
        error = e;
      }
    }
  }
  resetRenderCount();
  throw error;
}

// #endregion

// #region Diffing a vnode

/**
 * Diff `newVNode` against `oldVNode` and apply the changes under `parentDom`. Returns the DOM
 * node after the vnode's DOM: where its next sibling goes.
 */
export function diff(
  parentDom: Any,
  newVNode: Any,
  oldVNode: Any,
  globalContext: Any,
  namespace: Any,
  excessDomChildren: Any,
  commitQueue: Any[],
  oldDom: Any,
  isHydrating: Any,
  refQueue: Any[],
): Any {
  let tmp: Any,
    resumed: Any,
    newType = newVNode.type;
  // A JSON object posing as a vnode is not rendered.
  if (newVNode.constructor !== VNODE_MARKER) return NULL;

  // A suspended hydration resumes on the DOM range it kept.
  if (oldVNode.__u & MODE_SUSPENDED) {
    tmp = slots.claim.r(newVNode, oldVNode, oldDom);
    isHydrating = tmp[0];
    if (tmp[1]) {
      resumed = excessDomChildren = tmp[1];
      oldDom = tmp[2];
    }
  }

  if ((tmp = options.__b)) tmp(newVNode);

  outer: if (typeof newType == "function") {
    const oldCommitQueueLength = commitQueue.length;
    try {
      let c: Any, oldProps: Any, oldState: Any, snapshot: Any;
      const newProps = newVNode.props;
      const isClassComponent = CLASSES && (tmp = newType.prototype) && tmp.render;
      // The context this component reads: its contextType's provider value, or the whole map.
      tmp = newType.contextType;
      const provider = tmp && globalContext[tmp.__c];
      const componentContext = tmp ? (provider ? provider.props.value : tmp.__) : globalContext;

      if ((c = oldVNode.__c)) {
        newVNode.__c = c;
        if (c.__g & COMPONENT_PENDING_ERROR) c.__g |= COMPONENT_PROCESSING_EXCEPTION;
      } else {
        if (isClassComponent) newVNode.__c = c = new newType(newProps, componentContext);
        else {
          // Kept on one line: tests run with class support on, where it is only the test.
          if (!CLASSES && (tmp = newType.prototype) && tmp.render) throw Error(newType.name + CLASSES_OFF);
          // A function component runs on a Component whose render calls it.
          newVNode.__c = c = new (Component as Any)(newProps, componentContext);
          c.constructor = newType;
          c.render = doRender;
        }
        if (provider) provider.sub(c);
        if (!c.state) c.state = {};
        c.__n = globalContext;
        c.__g |= COMPONENT_DIRTY;
        c.__h = [];
        c.__k = [];
      }

      if (isClassComponent) {
        if (!c.__s) c.__s = c.state;
        if (newType.getDerivedStateFromProps) {
          if (c.__s == c.state) c.__s = assign({}, c.__s);
          assign(c.__s, newType.getDerivedStateFromProps(newProps, c.__s));
        }
      }

      oldProps = c.props;
      oldState = c.state;
      c.__v = newVNode;

      if (!oldVNode.__c) {
        if (isClassComponent && !newType.getDerivedStateFromProps && c.componentWillMount) c.componentWillMount();
        if (isClassComponent && c.componentDidMount) c.__h.push(c.componentDidMount);
      } else {
        if (
          newProps !== oldProps &&
          isClassComponent &&
          !newType.getDerivedStateFromProps &&
          c.componentWillReceiveProps
        )
          c.componentWillReceiveProps(newProps, componentContext);

        // The same vnode again with nothing queued, or shouldComponentUpdate said no: keep the
        // rendered children.
        if (
          (newVNode.__v == oldVNode.__v && !(c.__g & COMPONENT_DIRTY)) ||
          (!(c.__g & COMPONENT_FORCE) &&
            c.shouldComponentUpdate &&
            c.shouldComponentUpdate(newProps, c.__s, componentContext) === false)
        ) {
          if (newVNode.__v != oldVNode.__v) {
            c.props = newProps;
            c.state = c.__s;
            c.__g &= ~COMPONENT_DIRTY;
          }
          newVNode.__e = oldVNode.__e;
          newVNode.__k = oldVNode.__k;
          newVNode.__k.some((vnode: Any) => {
            if (vnode) vnode.__ = newVNode;
          });
          EMPTY_ARR.push.apply(c.__h, c.__k);
          c.__k = [];
          if (c.__h.length) commitQueue.push(c);
          oldDom = getDomSibling(oldVNode);
          break outer;
        }

        if (c.componentWillUpdate) c.componentWillUpdate(newProps, c.__s, componentContext);
        if (isClassComponent && c.componentDidUpdate)
          c.__h.push(() => {
            c.componentDidUpdate(oldProps, oldState, snapshot);
          });
      }

      c.context = componentContext;
      c.props = newProps;
      c.__P = parentDom;
      c.__g &= ~COMPONENT_FORCE;

      const renderHook = options.__r;
      let count = 0;
      if (isClassComponent) {
        c.state = c.__s;
        c.__g &= ~COMPONENT_DIRTY;
        if (renderHook) renderHook(newVNode);
        tmp = c.render(c.props, c.state, c.context);
        EMPTY_ARR.push.apply(c.__h, c.__k);
        c.__k = [];
      } else {
        // A function component that sets state while rendering renders again, up to 25 times.
        do {
          c.__g &= ~COMPONENT_DIRTY;
          if (renderHook) renderHook(newVNode);
          tmp = c.render(c.props, c.state, c.context);
          c.state = c.__s;
        } while (c.__g & COMPONENT_DIRTY && ++count < 25);
      }
      c.state = c.__s;

      if (c.getChildContext) globalContext = assign({}, globalContext, c.getChildContext());
      if (isClassComponent && oldVNode.__c && c.getSnapshotBeforeUpdate)
        snapshot = c.getSnapshotBeforeUpdate(oldProps, oldState);

      // An unkeyed Fragment at the top of the output is flattened away.
      const renderResult = tmp && tmp.type === Fragment && tmp.key == NULL ? tmp.props.children : tmp;

      // A portal renders into its own container.
      if (newProps.__P) {
        tmp = oldDom;
        parentDom = newProps.__P;
        namespace = parentDom.namespaceURI;
        isHydrating = excessDomChildren = NULL;
        // Moved to another container: its old children leave the old one.
        if (oldVNode.props && oldVNode.props.__P != parentDom) {
          if (oldVNode.__k)
            oldVNode.__k.some((child: Any) => {
              if (child) unmount(child, child);
            });
          oldVNode.__k = NULL;
        }
        oldDom = oldVNode.__k ? getDomSibling(oldVNode, 0) : NULL;
      }

      oldDom = diffChildren(
        parentDom,
        isArray(renderResult) ? renderResult : [renderResult],
        newVNode,
        oldVNode,
        globalContext,
        namespace,
        excessDomChildren,
        commitQueue,
        oldDom,
        isHydrating,
        refQueue,
      );

      if (newProps.__P) {
        newVNode.__e = NULL;
        oldDom = tmp;
      }
      newVNode.__u &= RESET_MODE;
      if (resumed) resumed.some(removeNode);
      if (c.__h.length) commitQueue.push(c);
      if (c.__g & COMPONENT_PROCESSING_EXCEPTION) c.__g &= ~(COMPONENT_PROCESSING_EXCEPTION | COMPONENT_PENDING_ERROR);
    } catch (e: Any) {
      commitQueue.length = oldCommitQueueLength;
      // Not the same vnode as before any more: a later render must not bail out on it.
      newVNode.__v = NULL;
      if (isHydrating || excessDomChildren) oldDom = slots.claim.c(e, newVNode, excessDomChildren, oldDom, isHydrating);
      else newVNode.__e = oldVNode.__e;
      if (!newVNode.__k) newVNode.__k = oldVNode.__k || [];
      if (!e.then) markAsForce(newVNode);
      options.__e(e, newVNode, oldVNode);
    }
  } else if (newVNode.__t) {
    oldDom = newVNode.__e = slots.block(
      oldVNode,
      newVNode,
      globalContext,
      namespace,
      excessDomChildren,
      commitQueue,
      isHydrating,
      refQueue,
      parentDom,
    );
  } else {
    // A block met by a plain element of its tag becomes plain vnodes over its DOM first.
    if (oldVNode.__t) slots.expand(oldVNode);
    oldDom = newVNode.__e = diffElementNodes(
      oldVNode.__e,
      newVNode,
      oldVNode,
      globalContext,
      namespace,
      excessDomChildren,
      commitQueue,
      isHydrating,
      refQueue,
      parentDom,
    );
  }

  if ((tmp = options.diffed)) tmp(newVNode);
  return oldDom;
}

/** Mark every component in the subtree to skip shouldComponentUpdate next time. */
function markAsForce(vnode: Any): void {
  if (vnode) {
    if (vnode.__c) vnode.__c.__g |= COMPONENT_FORCE;
    if (vnode.__k) vnode.__k.some(markAsForce);
  }
}

/** Apply the queued refs, then run each queued component's render callbacks. */
export function commitRoot(commitQueue: Any[], root: Any, refQueue: Any[]): void {
  for (let i = 0; i < refQueue.length;) applyRef(refQueue[i++], refQueue[i++], refQueue[i++]);
  if (options.__c) options.__c(root, commitQueue);
  commitQueue.some((c) => {
    try {
      commitQueue = c.__h;
      c.__h = [];
      commitQueue.some((cb: Any) => {
        cb.call(c);
      });
    } catch (e) {
      options.__e(e, c.__v);
    }
  });
}

/** Diff a host element (or text) vnode: create or claim its node, then its props and children. */
export function diffElementNodes(
  dom: Any,
  newVNode: Any,
  oldVNode: Any,
  globalContext: Any,
  namespace: Any,
  excessDomChildren: Any,
  commitQueue: Any[],
  isHydrating: Any,
  refQueue: Any[],
  parentDom: Any,
): Any {
  let oldProps = oldVNode.props || EMPTY_OBJ;
  const newProps = newVNode.props;
  const nodeType = newVNode.type;
  let i: Any, newHtml: Any, oldHtml: Any, newChildren: Any, value: Any, inputValue: Any, checked: Any;

  if (nodeType == "svg") namespace = SVG_NAMESPACE;
  else if (nodeType == "math") namespace = MATH_NAMESPACE;
  else if (!namespace) namespace = XHTML_NAMESPACE;

  // Hydrating: claim the first unclaimed node of the same kind.
  if (excessDomChildren) dom = slots.claim.n(excessDomChildren, nodeType) || dom;

  if (!dom) {
    const doc = parentDom.ownerDocument || document;
    if (!nodeType) return doc.createTextNode(newProps);
    dom = doc.createElementNS(namespace, nodeType, newProps.is && newProps);
    if (isHydrating) {
      if (options.__m) options.__m(newVNode, excessDomChildren);
      isHydrating = false;
    }
    // A new node has no server children to claim.
    excessDomChildren = NULL;
  }

  if (!nodeType) {
    if (oldProps !== newProps && (!isHydrating || dom.data != newProps)) dom.data = newProps;
  } else {
    parentDom = nodeType == "template" ? dom.content : dom;
    excessDomChildren =
      nodeType == "textarea" && newProps.defaultValue != NULL
        ? NULL
        : excessDomChildren && slice.call(parentDom.childNodes);

    // Claiming a server node without hydrating: its attributes are the old props.
    if (!isHydrating && excessDomChildren) oldProps = slots.claim.a(dom);

    for (i in oldProps) {
      value = oldProps[i];
      if (i == "dangerouslySetInnerHTML") oldHtml = value;
      else if (
        i != "children" &&
        !(i in newProps) &&
        !(i == "value" && "defaultValue" in newProps) &&
        !(i == "checked" && "defaultChecked" in newProps)
      )
        setProperty(dom, i, NULL, value, namespace);
    }

    const shouldRevalidateProps = oldVNode.__u & FORCE_PROPS_REVALIDATE;
    for (i in newProps) {
      value = newProps[i];
      if (i == "children") newChildren = value;
      else if (i == "dangerouslySetInnerHTML") newHtml = value;
      else if (i == "value") inputValue = value;
      else if (i == "checked") checked = value;
      else if (
        (!isHydrating || typeof value == "function") &&
        (oldProps[i] !== value || (shouldRevalidateProps && value != NULL))
      )
        setProperty(dom, i, value, oldProps[i], namespace);
    }

    if (newHtml) {
      if (!isHydrating && (!oldHtml || (newHtml.__html != oldHtml.__html && newHtml.__html != dom.innerHTML)))
        dom.innerHTML = newHtml.__html;
      newVNode.__k = [];
    } else {
      if (oldHtml) dom.textContent = "";
      // foreignObject and MathML's token elements hold HTML.
      if (nodeType == "foreignObject" || (namespace == MATH_NAMESPACE && MATHML_TOKEN_ELEMENTS.test(nodeType)))
        namespace = XHTML_NAMESPACE;
      diffChildren(
        parentDom,
        isArray(newChildren) ? newChildren : [newChildren],
        newVNode,
        oldVNode,
        globalContext,
        namespace,
        excessDomChildren,
        commitQueue,
        excessDomChildren ? excessDomChildren[0] : oldVNode.__k && getDomSibling(oldVNode, 0),
        isHydrating,
        refQueue,
      );
      // Server nodes nothing claimed are removed.
      if (excessDomChildren) excessDomChildren.some(removeNode);
    }

    // value and checked go last, after the children (a select's options) exist.
    if (!isHydrating || nodeType == "textarea") {
      i = "value";
      if (nodeType == "progress" && inputValue == NULL) dom.removeAttribute(i);
      else if (inputValue != undefined && (inputValue !== dom[i] || (nodeType == "progress" && !inputValue)))
        setProperty(dom, i, inputValue, oldProps[i], namespace);
      i = "checked";
      if (checked != undefined && checked != dom[i]) setProperty(dom, i, checked, oldProps[i], namespace);
    }
  }
  return dom;
}

/** Point `ref` at `value`, or detach it (running the cleanup a callback ref returned). */
export function applyRef(ref: Any, value: Any, vnode: Any, owner?: Any): void {
  try {
    if (typeof ref == "function") {
      if (value) value.__x = ref(value) || 1;
      else if (owner && (owner = owner.__c || owner.__e) && (value = owner.__x)) {
        owner.__x = NULL;
        if (typeof value == "function") value();
        else ref(NULL);
      }
    } else ref.current = value;
  } catch (e) {
    options.__e(e, vnode);
  }
}

/**
 * Unmount `vnode` and its subtree: refs detached, componentWillUnmount called, DOM removed
 * (unless `skipRemove`, when an ancestor's removal takes it along).
 */
export function unmount(vnode: Any, parentVNode: Any, skipRemove?: Any): void {
  let r: Any;
  if (options.unmount) options.unmount(vnode);
  if ((r = vnode.ref) && (!r.current || r.current == vnode.__e)) applyRef(r, NULL, parentVNode, vnode);
  if ((r = vnode.__c)) {
    if (r.componentWillUnmount) {
      try {
        r.componentWillUnmount();
      } catch (e) {
        options.__e(e, parentVNode);
      }
    }
    r.__P = r.__n = NULL;
  }
  if ((r = vnode.__k)) {
    for (let i = 0; i < r.length; i++) {
      if (r[i]) unmount(r[i], parentVNode, typeof vnode.type == "function" ? skipRemove && !vnode.props.__P : true);
    }
  }
  // A suspended hydration's kept server range goes with it.
  if (!skipRemove && (r = vnode.__c) && r.__z) slots.claim.u(vnode, r.__z);
  if ((r = vnode.__e)) {
    if (!skipRemove) removeNode(r);
    if (r.l) r.l = NULL;
  }
  if (vnode.__t) slots.drop(vnode);
  vnode.__e = vnode.__c = vnode.__ = NULL;
}

/** A function component's render: the function itself. */
function doRender(this: Any, props: Any, _state: Any, context: Any): Any {
  return this.constructor(props, context);
}

// #endregion

// #region Diffing children

/**
 * Diff the children of a vnode. Returns the DOM node after the last child: where the next
 * sibling of the parent's DOM goes.
 */
export function diffChildren(
  parentDom: Any,
  renderResult: Any[],
  newParentVNode: Any,
  oldParentVNode: Any,
  globalContext: Any,
  namespace: Any,
  excessDomChildren: Any,
  commitQueue: Any[],
  oldDom: Any,
  isHydrating: Any,
  refQueue: Any[],
): Any {
  let i, oldVNode, childVNode, newDom, firstChildDom, result;
  const oldChildren = oldParentVNode.__k || EMPTY_ARR;
  const newChildrenLength = renderResult.length;

  oldDom = constructNewChildrenArray(newParentVNode, renderResult, oldChildren, oldDom, newChildrenLength);

  for (i = 0; i < newChildrenLength; i++) {
    childVNode = newParentVNode.__k[i];
    if (childVNode == NULL) continue;
    // A child whose __i is -1 matched nothing: it mounts against an empty vnode.
    oldVNode = (~childVNode.__i && oldChildren[childVNode.__i]) || EMPTY_OBJ;
    childVNode.__i = i;
    result = diff(
      parentDom,
      childVNode,
      oldVNode,
      globalContext,
      namespace,
      excessDomChildren,
      commitQueue,
      oldDom,
      isHydrating,
      refQueue,
    );
    newDom = childVNode.__e;
    if (oldVNode.ref != childVNode.ref || oldVNode.__u & REF_DETACHED) {
      if (oldVNode.ref) applyRef(oldVNode.ref, NULL, childVNode, oldVNode);
      if (childVNode.ref) refQueue.push(childVNode.ref, childVNode.__c || newDom, childVNode);
    }
    firstChildDom = firstChildDom || newDom;
    if (childVNode.__u & INSERT_VNODE) {
      oldDom = insert(childVNode, oldDom, parentDom, !oldVNode.__v);
      if (oldVNode.__e) oldVNode.__e = NULL;
    } else if (typeof childVNode.type == "function" && result !== undefined) {
      // A component returns its last DOM node's next sibling.
      oldDom = result;
    } else if (newDom) oldDom = newDom.nextSibling;
    childVNode.__u &= ~(INSERT_VNODE | LIS_CANDIDATE);
  }
  newParentVNode.__e = firstChildDom;
  return oldDom;
}

/**
 * Normalize the new children into vnodes, match each with an old one, decide which DOM nodes
 * move (all but a longest increasing subsequence of the matched ones), and unmount the old
 * children nothing matched.
 */
function constructNewChildrenArray(
  newParentVNode: Any,
  renderResult: Any[],
  oldChildren: Any[],
  oldDom: Any,
  newChildrenLength: number,
): Any {
  let i, childVNode: Any, oldVNode: Any;
  const oldChildrenLength = oldChildren.length;
  let remainingOldChildren = oldChildrenLength,
    skew = 0,
    moved = 0;
  const newChildren = (newParentVNode.__k = Array(newChildrenLength));

  for (i = 0; i < newChildrenLength; i++) {
    childVNode = renderResult[i];
    if (childVNode == NULL || typeof childVNode == "boolean" || typeof childVNode == "function") {
      newChildren[i] = NULL;
      continue;
    } else if (typeof childVNode != "object" || childVNode.constructor === String) {
      childVNode = newChildren[i] = createVNode(NULL, childVNode, undefined, undefined, NULL);
    } else if (isArray(childVNode)) {
      childVNode = newChildren[i] = createVNode(Fragment, { children: childVNode }, undefined, undefined, NULL);
    } else if (childVNode.constructor === VNODE_MARKER && childVNode.__b) {
      // The same vnode rendered a second time: a copy, so each place has its own.
      childVNode = newChildren[i] = childVNode.__t
        ? slots.copy(childVNode)
        : createVNode(childVNode.type, childVNode.props, childVNode.key, childVNode.ref, childVNode.__v);
    } else newChildren[i] = childVNode;

    const skewedIndex = i + skew;
    childVNode.__ = newParentVNode;
    childVNode.__b = newParentVNode.__b + 1;
    const matchingIndex = (childVNode.__i = findMatchingIndex(
      childVNode,
      oldChildren,
      skewedIndex,
      remainingOldChildren,
    ));
    oldVNode = NULL;
    if (~matchingIndex) {
      oldVNode = oldChildren[matchingIndex];
      remainingOldChildren--;
      if (oldVNode) oldVNode.__u |= MATCHED;
    }

    if (!oldVNode || !oldVNode.__v) {
      // A new child: shift the skew when the list grows or shrinks.
      if (!~matchingIndex) {
        if (newChildrenLength > oldChildrenLength) skew--;
        else if (newChildrenLength < oldChildrenLength) skew++;
      }
      // Components insert their DOM as they render; elements are inserted here.
      if (typeof childVNode.type != "function") childVNode.__u |= INSERT_VNODE;
    } else {
      childVNode.__u |= LIS_CANDIDATE;
      if (matchingIndex == skewedIndex - 1) skew--;
      else if (matchingIndex == skewedIndex + 1) skew++;
      else if (matchingIndex != skewedIndex) {
        if (matchingIndex > skewedIndex) skew--;
        else skew++;
        moved = 1;
      }
    }
  }

  // Something moved: keep the longest increasing subsequence of old indexes in place, and mark
  // every other matched child to be inserted.
  if (moved) {
    const tails: number[] = [];
    const lisLengths: number[] = [];
    for (i = 0; i < newChildrenLength; i++) {
      childVNode = newChildren[i];
      if (childVNode && childVNode.__u & LIS_CANDIDATE) {
        skew = 0;
        let hi = tails.length;
        while (skew < hi) {
          const mid = (skew + hi) >> 1;
          if (tails[mid]! < childVNode.__i) skew = mid + 1;
          else hi = mid;
        }
        tails[skew] = childVNode.__i;
        lisLengths[i] = skew + 1;
      }
    }
    skew = tails.length;
    while (i--) {
      if (lisLengths[i]) {
        if (lisLengths[i] == skew) skew--;
        else newChildren[i].__u |= INSERT_VNODE;
      }
    }
  }

  if (remainingOldChildren) {
    for (i = 0; i < oldChildrenLength; i++) {
      oldVNode = oldChildren[i];
      if (oldVNode && !(oldVNode.__u & MATCHED)) {
        if (oldVNode.__e == oldDom) oldDom = getDomSibling(oldVNode);
        unmount(oldVNode, oldVNode);
      }
    }
  }
  return oldDom;
}

/** Insert `parentVNode`'s DOM before `oldDom`, returning the node after it. */
function insert(parentVNode: Any, oldDom: Any, parentDom: Any, isMounting: Any): Any {
  if (typeof parentVNode.type == "function") {
    // A portal's DOM lives in its container.
    if (parentVNode.props.__P) return oldDom;
    const children = parentVNode.__k;
    if (children) {
      for (let i = 0; i < children.length; i++) {
        if (children[i]) {
          children[i].__ = parentVNode;
          oldDom = insert(children[i], oldDom, parentDom, false);
        }
      }
    }
    return oldDom;
  }
  // oldDom may have been removed meanwhile: find the real next sibling.
  if (oldDom && !oldDom.parentNode) {
    oldDom = getDomSibling(parentVNode);
    if (oldDom && !oldDom.parentNode) oldDom = NULL;
  }
  const dom = parentVNode.__e;
  let next = oldDom;
  while (next && next.nodeType == 8) next = next.nextSibling;
  if (dom != next) {
    // moveBefore keeps a moved node's state (focus, playback) where the browser has it.
    if (!isMounting && parentDom.moveBefore && dom.parentNode) parentDom.moveBefore(dom, oldDom);
    else parentDom.insertBefore(dom, oldDom || NULL);
  }
  oldDom = dom;
  // Skip comments, except a server Suspense range's start.
  while ((oldDom = oldDom && oldDom.nextSibling) && oldDom.nodeType == 8 && !oldDom.data.startsWith("$s"));
  return oldDom;
}

/** Flatten children (nested arrays) into one array, leaving out null, undefined and booleans. */
export function toChildArray(children: Any, out?: Any[]): Any[] {
  out = out || [];
  if (children != NULL && typeof children != "boolean") {
    if (isArray(children))
      children.some((child) => {
        toChildArray(child, out);
      });
    else out.push(children);
  }
  return out;
}

/**
 * The index of the old child `childVNode` takes over: the one at `skewedIndex` if key and type
 * match, else the nearest unmatched one with the same key and type, searching backward then
 * forward. -1 when none.
 */
function findMatchingIndex(
  childVNode: Any,
  oldChildren: Any[],
  skewedIndex: number,
  remainingOldChildren: number,
): number {
  const key = childVNode.key;
  const type = childVNode.type;
  let oldVNode = oldChildren[skewedIndex];
  const matched = oldVNode && !(oldVNode.__u & MATCHED);
  const shouldSearch = remainingOldChildren > (matched ? 1 : 0);
  if ((oldVNode === NULL && key == NULL) || (matched && key == oldVNode.key && type == oldVNode.type))
    return skewedIndex;
  if (shouldSearch) {
    let x;
    for (x = skewedIndex - 1; x >= 0; x--) {
      oldVNode = oldChildren[x];
      if (oldVNode && !(oldVNode.__u & MATCHED) && key == oldVNode.key && type == oldVNode.type) return x;
    }
    for (x = skewedIndex + 1; x < oldChildren.length; x++) {
      oldVNode = oldChildren[x];
      if (oldVNode && !(oldVNode.__u & MATCHED) && key == oldVNode.key && type == oldVNode.type) return x;
    }
  }
  return -1;
}

// #endregion

// #region Props

/** Each copy of the engine stamps events under its own symbol. */
const EVENT_DISPATCHED = Symbol();
const CAPTURE_REGEX = /(PointerCapture)$|Capture$/i;
/**
 * A logical clock: an event that reaches, while bubbling, a listener attached after the event
 * was dispatched (on an element the event's own handlers created) does not call it.
 */
let eventClock = 0;

function setStyle(style: Any, key: string, value?: Any): void {
  if (value == NULL) value = "";
  if (key[0] == "-") style.setProperty(key, value);
  else style[key] = value;
}

/**
 * Set prop `name` on `dom` by Preact's rules: style and events have their own handling; other
 * names are DOM properties when the element has one (except a few whose property and attribute
 * differ), else attributes.
 */
export function setProperty(dom: Any, name: string, value: Any, oldValue: Any, namespace: Any): void {
  let useCapture;
  if (name == "style") {
    if (typeof value == "string") dom.style.cssText = value;
    else {
      if (typeof oldValue == "string") dom.style.cssText = oldValue = "";
      if (oldValue) for (name in oldValue) if (!(value && name in value)) setStyle(dom.style, name);
      if (value)
        for (name in value) if (!oldValue || value[name] != oldValue[name]) setStyle(dom.style, name, value[name]);
    }
  } else if (name[0] == "o" && name[1] == "n") {
    // Each prop name has one proxy listener; swapping the handler is a store.
    (dom.l || (dom.l = {}))[name] = value;
    if (!value || !oldValue) {
      const proxy = eventProxies[name] || (eventProxies[name] = createEventProxy(name));
      (dom.__a || (dom.__a = {}))[name] = eventClock;
      useCapture = name != (name = name.replace(CAPTURE_REGEX, "$1"));
      // onClick -> click; a lowercase start keeps a custom event's casing: onionChange -> ionChange.
      name = name.slice(2);
      if (name[0]! < "a") name = name.toLowerCase();
      if (value) dom.addEventListener(name, proxy, useCapture);
      else dom.removeEventListener(name, proxy, useCapture);
    }
  } else {
    if (namespace == SVG_NAMESPACE) {
      // xlink:href and xlinkHref are href; className is class.
      name = name.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
    } else if (
      name != "width" &&
      name != "height" &&
      name != "href" &&
      name != "list" &&
      name != "form" &&
      name != "tabIndex" &&
      name != "download" &&
      name != "rowSpan" &&
      name != "colSpan" &&
      name != "role" &&
      name != "popover" &&
      name in dom
    ) {
      try {
        dom[name] = value == NULL ? "" : value;
        return;
      } catch (_e) {}
    }
    // Functions are never attributes. aria- and data- attributes keep `false` as text.
    if (typeof value == "function") return;
    if (value != NULL && (value !== false || name[4] == "-"))
      dom.setAttribute(name, name == "popover" && value == true ? "" : value);
    else dom.removeAttribute(name);
  }
}

/** The listener for prop `name`: calls the element's current handler for it. */
function createEventProxy(name: string): (e: Any) => Any {
  return function (this: Any, e: Any): Any {
    let eventHandler = this.l;
    if (eventHandler) {
      eventHandler = eventHandler[name];
      if (e[EVENT_DISPATCHED] == NULL) e[EVENT_DISPATCHED] = eventClock++;
      else if (e[EVENT_DISPATCHED] < this.__a[name]) return;
      return eventHandler(options.event ? options.event(e) : e);
    }
  };
}

const eventProxies: Record<string, (e: Any) => Any> = {};

// #endregion
