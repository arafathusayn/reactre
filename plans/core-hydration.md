# Hydrating server-rendered HTML: a design

`@reactre/core/server` renders an app to HTML (`renderToString`, `renderToStream`). The client then renders the page afresh: `render` replaces the container's content. Hydration would instead claim the nodes the server sent, attaching the client's effects, handlers and refs to them, so the page is interactive without building its DOM twice. This note is the design for it; none of it is built yet.

## The rule it has to keep

An app that does not hydrate ships nothing for it, byte for byte, as with SSR itself (the size profiles in [sizes.json](../packages/core/sizes.json) check it). So hydration is a compile mode and a module of its own, not a branch in the code every app runs:

- The compiler gets a `hydrate` option (the plugin turns it on for the client build of an app that has a server build, or by its own option). Without it, the output is what it is now.
- With it, a template's code does not clone the template: it takes the next nodes of the page, by the same `firstChild`/`nextSibling` paths it walks a clone with today, and binds its holes there. Its helpers come from `@reactre/core/features/hydrate`, which no other build imports.
- `hydrate(App, el)` in that module runs the app with a cursor at `el`'s first child, and falls back to `render` where the page does not match.

## The markers the server writes

With `renderToString(app, { hydrate: true })` (or `renderToStream`), the HTML carries comment markers wherever the client's DOM has structure that the markup alone does not show. Without the option, none are written.

| Marker                             | Where                                                                                                                 | What it lets the client do                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<!--[-->` ... `<!--]-->`          | Around every slot (a hole that may hold nodes, `<Show>`, `<Switch>`, `<Dynamic>`), every list, and a `<For>` fallback | Know a slot's nodes: the slot's effect adopts the nodes between the pair, and its next content replaces them. A list's rows are the nodes between its pair. |
| `<!--[-->` ... `<!--]-->`          | Around each function child of a fragment (a context provider's or an `<Errored>`'s children)                          | The same, for the owned effect that builds those children on the client.                                                                                    |
| `<!---->`                          | Between a text hole and static text or another text hole beside it                                                    | The HTML parser merges adjacent text into one node; the marker keeps the hole's text a node of its own, which the client's text binding can take as it is.  |
| `<!--rr:bN-->` ... `<!--/rr:bN-->` | Around a streamed `<Loading>`'s fallback, until its content comes                                                     | The swap script finds the fallback to replace. Once swapped, the markers are gone and the content is a slot's like any other (it keeps its `[`/`]` pair).   |
| `<template id="rr:tN">`, `$rr(N)`  | A streamed boundary's content, and the script that swaps it in                                                        | Nothing for hydration: the template is removed when it is swapped in.                                                                                       |

Static markup needs no marker: the client's paths through a template are the same over the server's markup, as both come from the same JSX. A component leaves no trace in the markup, as it leaves none in the DOM.

## Claiming

- **Templates.** The compiled code walks the page where it would walk a clone. Its elements are in the order the template has them, and its holes are where the template's markers would be: an element's attribute and property holes bind to the element; a text hole takes its text node (an empty one is missing in the HTML, and is made and inserted at the separator).
- **Slots.** A slot's effect runs once to know what it holds, but adopts the nodes between its markers instead of inserting new ones: a component's or an element's content claims from a cursor inside the pair. The markers stay as the slot's anchors (today a slot keeps an anchor node of its own).
- **Lists.** The rows are between one pair of markers, in the order of `each`. The list's first run claims a row per item, in order, by the row's template paths, and records the keys as it would build them. A server and a client that see different data (a list fetched again) do not match: see mismatches below.
- **Context and boundaries.** These run on the client as they do now: a provider's children claim within its pair. An `<Errored>` whose server render showed its fallback hydrates its fallback and keeps the error: its `reset` builds the children afresh.
- **Async data.** The server's `<Loading>` content was rendered with data the client does not have. The client either reads the same data (an async memo computes again, and the boundary keeps the server's nodes until it has) or is given it: the server would write each async memo's resolved value into the page (`self.$rrd`), keyed by the memo's place in the render, and the client's memo would start with it. The second avoids a second fetch and a flash, but needs the memos to be found by a key both sides agree on, which is the main open question.
- **Streaming.** A boundary still streaming when `hydrate` runs is hydrated when its content is swapped in: `$rr` calls a hook the client module sets (`self.$rrh`), so a boundary hydrates on its own, as React's selective hydration does.

## Mismatches

Where the page does not have the node the code expects (a different tag, a missing node, a marker where an element was expected), hydration stops claiming for the nearest slot and renders its content afresh, replacing the nodes between its markers, and reports it in development. Outside every slot, the root renders afresh. Attribute values the server wrote and the client computes differently are set by the client's binding as it runs, as any update would.

## What the server does not write today, and the client would need

- Event handlers are not in the HTML (no inline handlers): hydration attaches them. A click before hydration is lost, unless the module replays clicks it records from the start, as Solid and Qwik can.
- `<select value>` is not written as `selected` on its option, and a `<textarea value>` only through spread props: the client sets them as properties, which hydration does when it binds the hole.
- `<Portal>` renders nothing on the server: its children are built on the client, into its mount, as they are now.
- Effects do not run on the server: on the client they run once at hydration, as on a first render.

## Open questions

- Keys for async data: by the order memos are made under each owner (fragile when code paths differ), by a key the app gives (`memo(fn, { key })`), or only for `<Loading>` boundaries' resources.
- Whether `hydrate` is a compile option of its own or part of the plugin's SSR setup (a Vite app with an SSR build would want both client and server compiled to match).
- Whether a list's rows should carry a key marker each (`<!--[k-->`), so a client with different data can still match rows by key rather than re-rendering the list.
