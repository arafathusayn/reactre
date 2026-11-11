// The compiler's rules over components that use a machine (React's, and Vue's `reactive`): what
// runs on every render, what a hook is given, and what an effect does with a snapshot. The type
// checker sees each call's types, not where the call is. On ./usesites.ts's context.
//
// A component is a function named in PascalCase that renders JSX or calls a hook; a hook is a
// function named `use…`. Both run on every render: their bodies are the render.
//   - M592: provide(...) in a render, a new machine each time.
//   - M593, M603: a send, a subscribe or `on` in a render.
//   - M594: a component that runs an actor, declared in another: a new type, a new actor, each render.
//   - M595, M596: an effect on a snapshot that copies it into state, or writes to a server.
//   - M597: a getSnapshot that returns a new object each call.
//   - M598: createActor in useState's or useMemo's initializer (useActorRef is the hook for it).
//   - M599: use() of a promise made in the render.
//   - M600: Vue's reactive() or ref() of a snapshot, whose data is frozen.
//   - M601: `() => actor.send`, which returns send uncalled.
//   - M602: an onSubmit that sends without preventDefault().
//   - M604: useActor, useActorRef or useSelector in a condition, a loop or a callback.
//   - M605: a selector that sends.
//   - M606: the render's snapshot read after an await.

import type { ArrowFunctionExpression, Function as FunctionNode, Node } from "oxc-parser";

import { isFunction, keyName, returned, rootName, stringValue, walk, walkPath } from "./syntax.ts";
import { actorCall, has, importedCall, libraryCall, type SiteContext } from "./usesites.ts";

type Fn = ArrowFunctionExpression | FunctionNode;

/** The name a function is declared with: its own, or the const it is the value of (through `memo(...)`). */
function nameOf(fn: Fn, path: readonly Node[]): string | null {
  if (fn.type === "FunctionDeclaration") return fn.id?.name ?? null;
  const parent = path[path.length - 1];
  const holder = parent?.type === "CallExpression" ? path[path.length - 2] : parent;
  return holder?.type === "VariableDeclarator" && holder.id.type === "Identifier" ? holder.id.name : null;
}

/** A call of a hook: `useState(...)`, `use(...)`. */
const isHook = (n: Node): boolean =>
  n.type === "CallExpression" && n.callee.type === "Identifier" && /^use(?:[A-Z]|$)/.test(n.callee.name);

/** Whether each function renders, once each. */
const rendering = new WeakMap<Node, boolean>();

/** The function renders: a component (PascalCase, with JSX or a hook in its body) or a hook (`use…`). */
function renders(fn: Fn, path: readonly Node[]): boolean {
  const known = rendering.get(fn);
  if (known !== undefined) return known;
  const name = nameOf(fn, path);
  const body = fn.body;
  const out =
    name !== null &&
    body !== null &&
    (/^use[A-Z]/.test(name) ||
      (/^[A-Z]/.test(name) &&
        has(body, (n) => isHook(n) || n.type === "JSXElement" || n.type === "JSXFragment", true)));
  rendering.set(fn, out);
  return out;
}

/** The methods of a request that write. */
const WRITES = /^(POST|PUT|PATCH|DELETE)$/i;

export function checkReact(ctx: SiteContext): void {
  const { program, src, report } = ctx;
  const hook = (n: Node, name: string): boolean =>
    n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === name;

  // The snapshots a render reads (`const [s] = useActor(m)`, `const s = useSelector(...)`) and its state setters.
  const snapshots = new Set<string>();
  const setters = new Set<string>();
  walk(program, (n) => {
    if (n.type !== "VariableDeclarator" || n.init === null) return true;
    const library = libraryCall(ctx, n.init);
    const first = n.id.type === "ArrayPattern" ? n.id.elements[0] : n.id;
    if ((library === "useActor" || library === "useSelector") && first?.type === "Identifier")
      snapshots.add(first.name);
    const second = n.id.type === "ArrayPattern" ? n.id.elements[1] : null;
    if ((hook(n.init, "useState") || hook(n.init, "useReducer")) && second?.type === "Identifier")
      setters.add(second.name);
    return true;
  });
  const onSnapshot = (n: Node): boolean => snapshots.has(rootName(n) ?? "");

  walkPath(program, (node, path) => {
    const fns = path.flatMap((n, i) => (isFunction(n) ? [{ fn: n, path: path.slice(0, i), at: i }] : []));
    const nearest = fns[fns.length - 1];
    const inRender = nearest !== undefined && renders(nearest.fn, nearest.path);
    const library = libraryCall(ctx, node);

    // M592: provide makes a machine: in a render, a new one each time, its options a stale closure.
    if (library === "provide" && inRender)
      report(
        node,
        "provide(...) in a component makes a new machine on every render, with the values of that render: provide once at module level, and send what changes as an event",
      );
    // M593, M603: what a render's body does, it does on every render.
    const sent = actorCall(ctx, node, "send");
    if (sent !== null && inRender)
      report(
        node,
        `${sent}.send(...) in a component's body sends on every render (and a send that renders again loops): send in an event handler or an effect`,
      );
    const listens = actorCall(ctx, node, "subscribe") ?? (library === "on" ? "on" : null);
    if (listens !== null && inRender)
      report(
        node,
        `${library === "on" ? "on(...)" : `${listens}.subscribe(...)`} in a component's body adds a listener on every render, and none is removed: read what you need with useSelector(actor, (s) => ...), or subscribe in an effect that unsubscribes`,
      );

    // M594: a component that runs an actor, declared inside another's render.
    if (isFunction(node) && node.body !== null && fns.some((f) => renders(f.fn, f.path))) {
      const name = nameOf(node, path);
      const outer = [...fns].reverse().find((f) => renders(f.fn, f.path));
      const runs = has(node.body, (n) => ["useActor", "useActorRef"].includes(libraryCall(ctx, n) ?? ""), true);
      if (name !== null && /^[A-Z]/.test(name) && runs && outer !== undefined)
        report(
          node,
          `${name} is declared in ${nameOf(outer.fn, outer.path) ?? "a component"}, so it is a new component on each render, and its actor restarts with it: declare ${name} at the top level, and pass it what it needs as props`,
        );
    }

    // M604: a hook in a condition, a loop or a callback runs out of order, or not at all.
    if (library === "useActor" || library === "useActorRef" || library === "useSelector") {
      const render = [...fns].reverse().find((f) => renders(f.fn, f.path));
      const between = render === undefined ? [] : path.slice(render.at + 1);
      const branched = between.some(
        (n) =>
          isFunction(n) ||
          [
            "IfStatement",
            "ConditionalExpression",
            "LogicalExpression",
            "SwitchStatement",
            "ForStatement",
            "ForOfStatement",
            "ForInStatement",
            "WhileStatement",
            "DoWhileStatement",
          ].includes(n.type),
      );
      if (render !== undefined && branched)
        report(
          node,
          `${library} in a condition, a loop or a callback runs in a different order from render to render, so actors are made and stopped out of order: call it at the component's top level, and branch on what it gives`,
        );
    }

    // M605: a selector runs during render: it only reads.
    if (library === "useSelector" && node.type === "CallExpression") {
      const selector = node.arguments[1];
      if (
        selector !== undefined &&
        isFunction(selector) &&
        selector.body !== null &&
        has(selector.body, (n) => actorCall(ctx, n, "send") !== null || libraryCall(ctx, n) === "persist")
      )
        report(
          selector,
          "a selector that sends runs during render, on every render: select only, and send from an event handler or an effect",
        );
    }

    // M606: after an await, the render's snapshot is stale.
    if (node.type === "Identifier" && snapshots.has(node.name) && nearest !== undefined && nearest.fn.async) {
      const parent = path[path.length - 1];
      const read = parent?.type === "MemberExpression" && parent.object === node;
      const waited = read && has(nearest.fn, (n) => n.type === "AwaitExpression" && n.end <= node.start);
      if (waited && fns.some((f) => renders(f.fn, f.path)))
        report(
          node,
          `${node.name} is the snapshot of the render this function was made in: after the await it is stale. Read the actor's current one, actor.snapshot()`,
        );
    }

    if (node.type !== "CallExpression") return true;
    const [first, second] = node.arguments;

    // M595, M596: an effect on a snapshot.
    if (
      (hook(node, "useEffect") || hook(node, "useLayoutEffect")) &&
      first !== undefined &&
      isFunction(first) &&
      first.body !== null
    ) {
      const deps = second?.type === "ArrayExpression" ? second.elements : [];
      if (deps.some((d) => d !== null && onSnapshot(d))) {
        walk(first.body, (n) => {
          if (isFunction(n)) return false;
          if (n.type === "CallExpression" && n.callee.type === "Identifier" && setters.has(n.callee.name))
            report(
              n,
              `an effect copies the snapshot into state, a render behind it: read ${n.arguments[0] === undefined ? "the snapshot" : src(n.arguments[0])} where you need it instead`,
            );
          return true;
        });
        walk(first.body, (n) => {
          const init =
            n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "fetch"
              ? n.arguments[1]
              : undefined;
          const method =
            init?.type === "ObjectExpression"
              ? init.properties.find((p) => p.type === "Property" && keyName(p) === "method")
              : undefined;
          if (method?.type === "Property" && WRITES.test(stringValue(method.value) ?? ""))
            report(
              n,
              `a ${stringValue(method.value)} in an effect on the snapshot runs again whenever the effect does (twice in strict mode): make it a task of the state it belongs to, task: { run: ... }`,
            );
          return true;
        });
      }
    }

    // M597: getSnapshot must return the same value until the store changes.
    if (hook(node, "useSyncExternalStore") && has(node, (n) => n.type === "Identifier" && ctx.tracked.has(n.name)))
      for (const get of node.arguments.slice(1))
        if (
          isFunction(get) &&
          get.body !== null &&
          returned(get.body).some((r) => r.type === "ObjectExpression" || r.type === "ArrayExpression")
        )
          report(
            get,
            "getSnapshot returns a new object on each call, so React renders again, forever: return actor.snapshot() itself, and select from it (or useSelector(actor, (s) => ...))",
          );

    // M598: createActor in a hook's initializer: strict mode makes two, and nothing stops either.
    const makes = (n: Node | undefined): boolean => n !== undefined && libraryCall(ctx, n) === "createActor";
    const initializer = ["useState", "useMemo", "useRef"].find((h) => hook(node, h));
    const made =
      first !== undefined && isFunction(first) && first.body !== null
        ? returned(first.body).find((r) => makes(r))
        : makes(first)
          ? first
          : undefined;
    if (initializer !== undefined && made !== undefined)
      report(
        made,
        `createActor in ${initializer} makes an actor during render, which strict mode makes twice and nothing stops: useActorRef(machine), from @reactre/state/react, keeps one and stops it on unmount`,
      );

    // M599: use() of a promise made in the render suspends on a new promise each time.
    const awaited = first === undefined ? null : libraryCall(ctx, first);
    if (importedCall(ctx, node, "react") === "use" && (awaited === "toPromise" || awaited === "waitFor"))
      report(
        node,
        `use(${awaited}(...)) makes a new promise on every render, so the component suspends for good: make the actor and its promise outside the component (or read the state with useActor)`,
      );

    // M600: Vue's reactive() proxies objects deeply, and a snapshot's data is frozen.
    const vue = importedCall(ctx, node, "vue");
    if ((vue === "reactive" || vue === "ref") && first !== undefined && actorCall(ctx, first, "snapshot") !== null)
      report(
        node,
        `${vue}() of a snapshot proxies its data deeply, which is frozen in development and not in production: hold it with shallowRef(actor.snapshot()), and replace it on each change`,
      );
    return true;
  });

  // M601, M602: event handlers' props.
  walk(program, (node) => {
    if (
      node.type === "ArrowFunctionExpression" &&
      node.expression &&
      node.body.type === "MemberExpression" &&
      !node.body.computed &&
      node.body.property.type === "Identifier" &&
      node.body.property.name === "send" &&
      node.body.object.type === "Identifier" &&
      ctx.tracked.has(node.body.object.name)
    )
      report(
        node,
        `() => ${src(node.body)} returns send without calling it, so the event never goes: call it, () => ${src(node.body)}({ type: "..." })`,
      );
    const submit =
      node.type === "Property" && keyName(node) === "onSubmit"
        ? node.value
        : node.type === "JSXAttribute" &&
            node.name.type === "JSXIdentifier" &&
            node.name.name === "onSubmit" &&
            node.value?.type === "JSXExpressionContainer"
          ? node.value.expression
          : null;
    if (
      submit !== null &&
      isFunction(submit) &&
      submit.body !== null &&
      has(
        submit.body,
        (n) =>
          n.type === "CallExpression" &&
          n.callee.type === "MemberExpression" &&
          n.callee.property.type === "Identifier" &&
          n.callee.property.name === "send",
      ) &&
      !has(submit.body, (n) => n.type === "Identifier" && n.name === "preventDefault")
    )
      report(
        submit,
        "an onSubmit that doesn't call preventDefault() lets the browser submit the form and reload the page, and the actor is lost: (e) => { e.preventDefault(); actor.send(...) }",
      );
    return true;
  });
}
