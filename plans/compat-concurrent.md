# Concurrent rendering in @reactre/compat

React 19.3.1's production client renders transitions concurrently; compat renders everything at once. This plan lists what that changes on screen and in logs, the ways compat could match it, and the one chosen.

## What differs today

Measured against React's production client on the fake DOM (`packages/compat/test/concurrent.test.ts`):

- **isPending.** React renders `isPending` true on its sync lane (an optimistic update, in a microtask even outside events), then the transition in a task, with `isPending` false and the new state together. Compat renders both at once: `isPending` true never shows for a transition that does not await.
- **Urgent updates first.** An urgent update made while a transition waits for its task renders first, without the transition's updates; the transition then renders on top of it, its updates replayed in order from the state before them (React's rebase: `set(v => v + 1)` in a transition, `set(v => v * 10)` urgently, from 1: 10, then 20). Compat applies each update as it is made.
- **Transitions apart.** Transitions started in different events render one after the other, each its own commit, unless they update the same state, which renders them together (React's entangled lanes).
- **Async actions.** Updates an async transition makes before it awaits commit when the action finishes, with `isPending` false. Compat commits them at once.
- **A transition that suspends** where content already shows (a Suspense boundary that shows its content, or no boundary at all) commits nothing: the screen stays as it was, `isPending` stays true, and when the data comes the transition renders again and commits. Compat shows the boundary's fallback, or with no boundary commits what rendered.
- **useDeferredValue.** An urgent render returns the old value and a background render (a transition) the new one; if that render suspends, the old value stays. Compat returns the new value at once.
- **The store check.** Before a transition commits, React calls each `useSyncExternalStore` getSnapshot the render read once more. Compat does not.
- **An update outside a transition that suspends with no boundary** keeps the screen, as a transition does.
- **Timing** of urgent updates (render, layout and passive effects against timers and microtasks) already matches.

## The constraint

Compat writes the DOM as it renders, and its fibers are single-buffered: a render changes props, children, hooks and DOM nodes in place, and runs some user code on the way (insertion effects, layout cleanups, ref detaches, `componentWillUnmount`). Keeping the old screen means rendering where the result can be thrown away. Measured A/Bs show that even a small branch in a hot function (runHost, handlersOn, reconcile, runFunc's normal path, place) costs 2–4% on the JS framework benchmark, so nothing may be added there.

## Options

1. **A work-in-progress tree (React's double buffering).** Every render makes alternates and commits them. The best fidelity, but it is a second reconciler, and the hot path would change shape: rejected.
2. **A dry-run walker.** A second, DOM-free renderer calls the components of a transition to find out whether it suspends, then the real render runs. No hot-path change, but every component of a transition renders twice (logs differ from React's), a second walker must follow blocks, classes, context and memo exactly, and its hooks must not touch the real ones: large, and still not React's call counts.
3. **Clone the tree and the DOM.** Render the transition on a deep copy of the fibers and of the DOM, swap it in on success. The copy runs user code against shared instances, refs and stores, and swapping DOM nodes breaks node identity (refs, focus, form state): rejected.
4. **Render in place, undo on a bad suspension (chosen).** A transition renders on the live tree, as compat renders anything, with three things around it, all outside the hot functions:
   - a **snapshot** of the fibers it may touch (each fiber's fields, its hooks' fields, a class instance's props, state and context, a provider's readers), taken before it renders;
   - a **MutationObserver** on the roots' containers (and the document, and portals' containers), whose records undo every DOM change in reverse order;
   - **deferred user code**: `safely()`, through which compat runs every effect, cleanup, ref detach and `componentWillUnmount`, queues its calls while the transition renders, and they run, in order, only when it commits.

   If nothing suspends where content already shows, the records are dropped, the deferred calls run and the transition commits as today. If something does, the DOM is undone, the fibers, hooks and queues are put back, the fibers the render created are marked dead, and the transition waits for the data, then renders again. A component renders once per attempt, as in React.

   Cost: on the normal path, one test of a module variable in `safely()` (once per effect or cleanup run, never per row) and one in a state setter. A transition pays for its snapshot (one small array per fiber under the fibers it renders) and the observer. All the machinery is a feature module, `@reactre/compat/features/concurrent` (the `concurrentRendering` key), which the JS framework benchmark build leaves out.

5. **Defer DOM writes.** Make every DOM write go through a queue during a transition. Every write site is in a hot function: rejected.

## Lanes

A transition update is not applied when it is made. The setter records it per hook (`{ base, updates }`, React's update queue) and per batch: the transitions started in one event, until the microtask after it (React's per-event transition lane). Updates to state that already has a transition pending join that transition's batch (entangled). An urgent update to such state is applied at once, as now, and recorded too, so the transition replays every update in order from the base (React's rebase). A batch renders in a task after urgent work, applying its updates as it starts; while any async action runs, no batch renders (React's entangled action lane). `root.render()` in a transition and a class's `setState` in one are batch updates too.

`useTransition` sets `isPending` true in a microtask and false inside the transition. `useDeferredValue` returns the value it returned last in an urgent render and asks for a batch render, in which it returns the new value. Before a batch commits, every store it read is read again (React's consistency check); a store that moved makes it render again at once.

## What is left as it is

- **Time slicing.** React yields every 5 ms while rendering a transition, so an urgent update can interrupt it. Compat renders a batch whole in one task: an urgent update that arrives while a transition renders waits until it ends. Yielding would mean pausing a render with the DOM half written; nothing a test or an app sees in a render shorter than 5 ms changes, so it is not worth it.
- **Prerendering.** In a transition that suspends, React renders a boundary's other children and its fallback (it does so for a discarded attempt too) and, after a later commit, renders a suspended transition once more to warm it. Compat stops a boundary's children at the one that suspends. Render logs of an attempt that suspends differ; screens and effects do not.
- **An update outside a transition that suspends with no boundary above.** Telling it apart costs a snapshot before every render: it still commits what rendered.
- **Throttled reveals.** React renders content a boundary can show again at once and commits it 300 ms after the fallback appeared; compat waits, then renders.
- **Properties the DOM does not reflect** that an undone transition changed: a select's selection and scroll positions stay as it set them (an input's or textarea's value and checkedness are put back, saved with the fibers). Their fibers are put back, so the next render writes them again.
