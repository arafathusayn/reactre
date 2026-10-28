// The js-framework-benchmark app on reactre/dom: a declarative row template with typed holes, and
// a keyed list that renders the rows array (reusing, moving and removing rows by id).
//
// The state is the rows array and the selected id; each action changes the state and renders
// what it touches: the list for changes to the rows, two class holes for a new selection. Clicks
// on buttons and rows are delegated to one listener on the page's root element.
//
// prepare.ts bundles it as the `reactre-dom` entry. It is written by hand, with no compiler and
// no reactivity, to show what the layer under reactre's compiled output does on its own. The
// markup, ids and classes follow the official app: run.ts's tests find buttons and rows by them.
//
// The templates below are single-line on purpose: whitespace between tags would become text
// nodes in the DOM, which the official markup does not have.

import { cls, html, List, text } from "reactre/dom";

// #region Data

// The official word lists, so labels have the same lengths as every other entry's.
const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];
const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

/** A random word, picked the way the official apps pick it. */
const pick = (list: readonly string[]): string => list[Math.round(Math.random() * 1000) % list.length]!;
/** Ids keep counting across creates, as in every official app; run.ts's checks rely on it. */
let nextId = 1;

/** One table row. Rows are immutable: an update replaces the object. */
interface Row {
  readonly id: number;
  readonly label: string;
}
/** `count` new rows with fresh ids and random labels. */
function build(count: number): Row[] {
  const rows = new Array<Row>(count);
  for (let i = 0; i < count; i++)
    rows[i] = { id: nextId++, label: `${pick(adjectives)} ${pick(colours)} ${pick(nouns)}` };
  return rows;
}

// #endregion

// #region Row template

// One row. Its holes, in order: 0 the row's class, 1 the id's text, 2 the label's text.
const RowTemplate = html`<tr class=${cls()}><td class="col-md-1">${text<number>()}</td><td class="col-md-4"><a>${text()}</a></td><td class="col-md-1"><a><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td></tr>`;
/** Hole indexes in RowTemplate. */
const CLASS = 0,
  LABEL = 2;
// A row is the template's clone and the row it shows; its label's text node is looked up the
// first time the label changes, so creating rows walks no paths at all. The class hole is the
// row element itself, so it needs no lookup.
const findLabel = RowTemplate.locator([LABEL]);
// The values a new row is baked from: one array, refilled per row (clone copies them into the DOM
// and keeps nothing), so creating 10,000 rows allocates no value arrays.
const vals: [string, number, string] = ["", 0, ""];

/** The list's entry for one row: its DOM root, the row it shows, and its label's text node. */
interface Entry {
  readonly root: Element;
  row: Row;
  /** The label's text node, or null until `setLabel` first needs it. */
  label: Node | null;
}

/** Writes a new label into a row's DOM, looking up the text node on first use. */
function setLabel(e: Entry, label: string): void {
  if (e.label === null) {
    const out: unknown[] = [];
    findLabel(e.root, out);
    e.label = out[LABEL] as Node;
  }
  RowTemplate.write(LABEL, e.label, label);
}

// #endregion

// #region State and rendering

/** The rows as last rendered. */
let rows: Row[] = [];
/** The selected row's id; 0 is no selection, since ids start at 1. */
let selected = 0;
/** The selected row's entry, so a new selection can clear its class without a search. */
let selectedEntry: Entry | null = null;

// The page: static markup, one template with no holes.
const App = html`<div class="container"><div class="jumbotron"><div class="row"><div class="col-md-6"><h1>reactre-dom keyed</h1></div><div class="col-md-6"><div class="row"><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="run">Create 1,000 rows</button></div><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="runlots">Create 10,000 rows</button></div><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="add">Append 1,000 rows</button></div><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="update">Update every 10th row</button></div><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="clear">Clear</button></div><div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="swaprows">Swap Rows</button></div></div></div></div></div><table class="table table-hover table-striped test-data"><tbody></tbody></table><span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span></div>`;
const app = App.mount([]);
document.getElementById("main")!.appendChild(app.root);
const tbody = app.root.querySelector("tbody")!;
// The list is the table body's only content (`owns`), so a clear can empty it in one write, and
// a full create can fill it while it is out of the document (`detach`): style and layout then
// run once, not per row.
const list = new List<Row, Entry, number>(tbody, {
  key: (row) => row.id,
  // A row created while its id is selected starts with the class and becomes the selected
  // entry, so the state and the DOM agree however the row came to be created.
  create: (row) => {
    vals[0] = row.id === selected ? "danger" : "";
    vals[1] = row.id;
    vals[2] = row.label;
    const root = RowTemplate.clone(vals);
    const e: Entry = { root, row, label: null };
    if (row.id === selected) selectedEntry = e;
    return e;
  },
  update: (e, row) => {
    if (row.label !== e.row.label) setLabel(e, row.label);
    e.row = row;
  },
  owns: true,
  detach: true,
  // Each render passes a new array; a row given the same object is not visited.
  skipUnchanged: true,
});

/** Renders a new rows array; it must be a new array each time (see skipUnchanged). */
function render(next: Row[]): void {
  rows = next;
  list.set(rows);
}

/** Moves the selection to `e`: two class writes, the old row's and the new row's. */
function select(e: Entry): void {
  if (selectedEntry === e) return;
  if (selectedEntry !== null) RowTemplate.write(CLASS, selectedEntry.root, "");
  RowTemplate.write(CLASS, e.root, "danger");
  selectedEntry = e;
  selected = e.row.id;
}

/**
 * Forgets the selection without touching the DOM; callers use it before the selected row
 * leaves, so there is no class left to clear.
 */
function unselect(): void {
  selected = 0;
  selectedEntry = null;
}

// #endregion

// #region Actions and events

/** The official buttons' actions, by button id. */
const actions: Record<string, () => void> = {
  run: () => (unselect(), render(build(1000))),
  runlots: () => (unselect(), render(build(10000))),
  add: () => render(rows.concat(build(1000))),
  update: () => {
    const next = rows.slice();
    for (let i = 0; i < next.length; i += 10) next[i] = { id: next[i]!.id, label: next[i]!.label + " !!!" };
    render(next);
  },
  clear: () => (unselect(), render([])),
  // Swaps the second and the 999th row, as the official apps do; a shorter table is left alone.
  swaprows: () => {
    if (rows.length <= 998) return;
    const next = rows.slice();
    const a = next[1]!;
    next[1] = next[998]!;
    next[998] = a;
    render(next);
  },
};

// One delegated listener for the whole page: buttons by id, and a row's links by the cell they
// sit in (col-md-4 selects, the other removes). No per-row listeners are created or removed.
document.getElementById("main")!.addEventListener("click", (ev) => {
  const t = ev.target as Element;
  const button = t.closest("button");
  if (button !== null) {
    const run = actions[button.id];
    if (run !== undefined) {
      ev.preventDefault();
      run();
    }
    return;
  }
  const a = t.closest("a");
  const tr = a?.closest("tr");
  if (a == null || tr == null) return;
  // The clicked row's place: the list's entries are in the rows' order.
  const es = list.entries;
  let i = 0;
  while (i < es.length && es[i]!.root !== tr) i++;
  const e = es[i];
  if (e === undefined) return;
  ev.preventDefault();
  if (a.parentElement!.classList.contains("col-md-4")) select(e);
  else {
    if (selectedEntry === e) unselect();
    const next = rows.slice();
    next.splice(i, 1);
    render(next);
  }
});

// #endregion
