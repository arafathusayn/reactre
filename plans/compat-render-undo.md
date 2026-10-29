# Undoing an urgent render: what items 25 to 29 would cost

Items 25 to 29 of [compat-remaining.md](compat-remaining.md) have one cause. React renders into a work-in-progress tree and commits it at the end, so a render it abandons leaves the screen and the committed tree untouched. Compat writes the DOM and its one fiber tree as it renders. To match React on these items, compat has to put back what a render changed, as it already does for transitions (the lanes module, [compat-concurrent.md](compat-concurrent.md)).

| #   | What React does                                                                | What compat needs                                                                                               |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 25  | The retry renders again after any render error, not only a component's own     | The state from before the render, to render again from it                                                       |
| 26  | An update's retry renders the whole root again                                 | The same, for the root                                                                                          |
| 27  | The retry computes `useMemo` again                                             | Closed without an undo: the retry module notes what each memo held before it computed, and a retry puts it back |
| 28  | A hydration error renders the root again, client-side, before it recovers      | The state from before the hydrating pass                                                                        |
| 29  | An update outside a transition that suspends with no boundary keeps the screen | The undo started before the render, since the suspension comes later                                            |

## What the transition undo costs, and why it cannot simply run for every render

A transition's attempt saves the fibers and hooks of the whole tree under each root it renders (`save()` in `core.ts`), and watches the containers with a MutationObserver. That costs time and memory in proportion to the tree, not to the update. A transition is rare and expected to be slow, so it pays that cost. A click that updates one row of a 10,000-row table renders a few fibers. Saving all 10,000 first would make every update cost as much as rendering the whole tree, far slower than React, which allocates only the fibers it renders.

## The options

1. **Save everything before every urgent render** (the transition path, run every time). This is correct, simple, and reuses tested code, but it turns every update into O(tree). It would break compat's goal of being faster than React, so it is not acceptable as the default.
2. **Save lazily, copy-on-write.** Save each fiber's fields and hooks the first time a render changes them, and keep the MutationObserver on the roots while the render runs. The cost then grows with what the render touches, as React's does. But every function that changes a fiber (`run`, `patch`, `create`, `take`, `unmount`, `setProps`, every hook setter) has to note the change first. Doing that in `@reactre/compat/core` adds a branch to each of those hot functions, and an A/B showed that one such branch costs 2 to 4% on the JS framework benchmark. To keep core's cost at zero, the module would have to install its own copies of those functions, the way `__installKeys` swaps `dupList`. That works only if each call site already goes through a variable, which none of these do today. Making them do so is itself the 2 to 4% cost.
3. **Leave items 25 to 29 as documented differences** (today's state). They only show when a render throws, hydration fails, or an urgent update suspends with no boundary. In each case the app already shows an error boundary, a recoverable error, or a suspended screen, and the visible difference is how many times components render and which state the retry starts from.

## Recommendation

Option 2, as its own opt-in key (`renderUndo`), with `@reactre/compat` loading it, is the only way to match React on these items without making updates O(tree). Its cost to `@reactre/compat/core` is the indirection at each mutation site. That cost has to be measured before anything ships, with the A/B rules: an A/A control and 95% CIs. If the A/B shows any cost to core outside the A/A noise, the items stay as option 3.

Item 24 is separate: React itself does not check the hook's kind there, and many of its outcomes are TypeErrors from React's internals, whose messages depend on the engine. Matching it means mirroring React's hook object layout in every hook, which is a rewrite of the hooks, not a module.
