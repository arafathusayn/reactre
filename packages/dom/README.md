# @reactre/dom

Templates and keyed lists for the DOM, with no build step and no dependencies. A template is parsed once and cloned with its values; a change rewrites only the hole whose value changed. A keyed list reuses rows and makes the fewest DOM moves.

It is the layer [`@reactre/core`](https://www.npmjs.com/package/@reactre/core) renders TSX on, and you can use it directly from plain JavaScript or TypeScript.

```sh
bun add @reactre/dom
```

Or with npm: `npm install @reactre/dom`.

## A template

```ts
import { html, on, text } from "@reactre/dom";

let count = 0;

const Counter = html`<button onclick=${on<"click">()}>Clicked ${text<number>()} times</button>`;
const view = Counter.mount([() => view.set(1, ++count), count]);

document.body.append(view.root);
```

`html` parses the template once per call site. `mount` clones it with values for its holes, in order, and `set` writes one hole, only when its value changed.

Each hole is typed: `text<number>()` takes a number, `on<"click">()` a click handler, and a hole in the wrong place is an error when the template is first parsed, never per instance.

## A keyed list

```ts
import { html, List, text, type BlockOf } from "@reactre/dom";

type Todo = { id: number; title: string };

const Item = html`<li>${text()}</li>`;
const list = new List<Todo, BlockOf<typeof Item>>(document.querySelector("ul")!, {
  key: (todo) => todo.id,
  create: (todo) => Item.mount([todo.title]),
  update: (item, todo) => item.set(0, todo.title),
});

const todos = [
  { id: 1, title: "Write the docs" },
  { id: 2, title: "Ship it" },
];
list.set(todos);
list.set([...todos].reverse()); // both rows are kept; one moves
```

## API

| Export                        | What it does                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `html`, `svg`                 | A template, parsed once per call site, with typed holes.                                           |
| `text`, `cls`, `attr`, `prop` | Value holes: text content, the class, an attribute, a DOM property.                                |
| `on`, `slot`                  | An event handler hole, and a place to insert other content.                                        |
| `Template.mount(values)`      | Clones the template with its hole values and returns a `Block`.                                    |
| `Block.set(index, value)`     | Writes one hole, and only when the value changed.                                                  |
| `List`                        | A keyed list: reuses rows by key and keeps the longest run in place, so it moves the fewest nodes. |
| `morph(target, nodes)`        | Patches a live subtree to match freshly built nodes.                                               |

## Browsers and bundlers

It runs in every modern browser. Where the browser has `moveBefore`, moved rows keep focus, selection and running animations.

The package ships ES modules in `dist/` for browsers, bundlers and other runtimes, and its TypeScript sources, which Bun uses directly and which give editors full types.

## License

[Apache-2.0](LICENSE)
