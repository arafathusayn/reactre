import * as compat from "@reactre/compat";
import * as compatClasses from "@reactre/compat/classes";
import * as compatCore from "@reactre/compat/core";
import * as fClasses from "@reactre/compat/features/classes";
import * as fConcurrent from "@reactre/compat/features/concurrent";
import * as fKeys from "@reactre/compat/features/keys";
import * as fRetry from "@reactre/compat/features/retry";
import * as fStacks from "@reactre/compat/features/stacks";
import * as fTimeSlicing from "@reactre/compat/features/timeSlicing";
import * as fUndo from "@reactre/compat/features/undo";
import * as fViewTransitions from "@reactre/compat/features/viewTransitions";
import * as server from "@reactre/compat/server";
import * as serverBrowser from "@reactre/compat/server.browser";
import * as serverEdge from "@reactre/compat/server.edge";
import * as serverNode from "@reactre/compat/server.node";
import * as staticApi from "@reactre/compat/static";
import * as core from "@reactre/core";
import * as coreActions from "@reactre/core/features/actions";
import * as coreAsync from "@reactre/core/features/async";
import * as coreContext from "@reactre/core/features/context";
import * as coreDynamic from "@reactre/core/features/dynamic";
import * as coreErrors from "@reactre/core/features/errors";
import * as coreMemo from "@reactre/core/features/memo";
import * as coreOwner from "@reactre/core/features/owner";
import * as coreReaction from "@reactre/core/features/reaction";
import * as coreStore from "@reactre/core/features/store";
import * as coreTiming from "@reactre/core/features/timing";
import * as jsxDevRuntime from "@reactre/core/jsx-dev-runtime";
import * as jsxRuntime from "@reactre/core/jsx-runtime";
// Every runtime entry of the packages, for a browser app with no server runtime's types.
import * as dom from "@reactre/dom";
import * as full from "@reactre/full-compat";
import * as fullCore from "@reactre/full-compat/core";
import * as ffClasses from "@reactre/full-compat/features/classes";
import * as ffConcurrent from "@reactre/full-compat/features/concurrent";
import * as ffKeys from "@reactre/full-compat/features/keys";
import * as ffRetry from "@reactre/full-compat/features/retry";
import * as ffStacks from "@reactre/full-compat/features/stacks";
import * as ffUndo from "@reactre/full-compat/features/undo";
import * as ffViewTransitions from "@reactre/full-compat/features/viewTransitions";
import * as fullServer from "@reactre/full-compat/server";
import * as fullServerBrowser from "@reactre/full-compat/server.browser";
import * as fullServerEdge from "@reactre/full-compat/server.edge";
import * as fullServerNode from "@reactre/full-compat/server.node";
import * as fullStatic from "@reactre/full-compat/static";
import * as preactCompat from "@reactre/preact/compat";
import * as preactCore from "@reactre/preact/core";
import * as preactDom from "@reactre/preact/dom";
import * as preactJsx from "@reactre/preact/jsx-runtime";

// Types flow through: a few uses that must check.
const [count, setCount] = core.signal(0);
setCount((n) => n + 1);
const doubled: () => number = core.memo(() => count() * 2);
const t = dom.html`<p>${dom.text<number>()}</p>`;
const el = compat.createElement("div", { id: "x" }, "hi");
const html: Promise<string> | string = typeof server.renderToString === "function" ? server.renderToString(el) : "";
const fullEl: unknown = full.createElement("span", null);
const [todos, setTodos] = coreStore.createStore({ list: [{ id: 1, done: false }] });
setTodos((d) => {
  d.list[0]!.done = true;
});
const done: boolean = todos.list[0]!.done;
const same: () => { id: number } = coreMemo.memo(() => ({ id: count() }), { equals: (a, b) => a.id === b.id });
const user: () => { name: string } = coreAsync.memo(async () => ({ name: String(count()) }));
const pending: boolean = coreAsync.isPending(() => user().name);
const [likes, setLikes] = coreActions.createOptimistic(0);
const like: (by: number) => Promise<string> = coreActions.action(function* (by: number) {
  setLikes((n) => n + by);
  yield coreAsync.refresh(user);
  return "ok";
});

export const all: unknown[] = [
  dom,
  core,
  coreOwner,
  coreTiming,
  coreReaction,
  coreDynamic,
  coreStore,
  coreMemo,
  coreContext,
  coreErrors,
  coreAsync,
  coreActions,
  jsxRuntime,
  jsxDevRuntime,
  compat,
  compatCore,
  compatClasses,
  fClasses,
  fStacks,
  fKeys,
  fRetry,
  fConcurrent,
  fViewTransitions,
  fUndo,
  fTimeSlicing,
  server,
  staticApi,
  serverNode,
  serverBrowser,
  serverEdge,
  full,
  fullCore,
  ffClasses,
  ffStacks,
  ffKeys,
  ffRetry,
  ffConcurrent,
  ffViewTransitions,
  ffUndo,
  fullServer,
  fullStatic,
  fullServerNode,
  fullServerBrowser,
  fullServerEdge,
  preactCore,
  preactCompat,
  preactJsx,
  preactDom,
  doubled,
  t,
  html,
  fullEl,
  done,
  same,
  pending,
  likes,
  like,
];
