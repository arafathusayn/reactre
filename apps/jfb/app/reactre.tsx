// The js-framework-benchmark app in reactre: declarative TSX over signals, compiled by
// reactre-compiler into templates and the code that updates them.
//
// The rows are a signal rendered by a keyed <For>; the selection is a signal read through a keyed
// selector, so selecting a row re-renders the two rows whose class changes, not all of them.
//
// prepare.ts bundles it as the `reactre` entry. The markup, ids and classes follow the official
// app: run.ts's tests find buttons and rows by them, and the shared stylesheet styles them.
// Every action builds a new rows array, so the keyed list can compare rows by identity.

import { batch, For, render, selector, signal } from "reactre";

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

// #region State and actions

const [rows, setRows] = signal<Row[]>([]);
const [selected, setSelected] = signal(0);
// A keyed view of `selected`: isSelected(id) changes only when that id gains or loses the
// selection, so a new selection wakes the old and the new row and no other.
const isSelected = selector(selected);

// Each action matches one of the official buttons. `batch` makes the rows and the selection
// change as one update, so nothing renders between the two writes.

const run = (n: number): void => batch(() => (setRows(build(n)), setSelected(0)));
const add = (): void => setRows((r) => r.concat(build(1000)));
const update = (): void =>
  setRows((r) => {
    const next = r.slice();
    for (let i = 0; i < next.length; i += 10) next[i] = { id: next[i]!.id, label: next[i]!.label + " !!!" };
    return next;
  });
const clear = (): void => batch(() => (setRows([]), setSelected(0)));
// Swaps the second and the 999th row, as the official apps do; a shorter table is left alone.
const swapRows = (): void =>
  setRows((r) => {
    if (r.length <= 998) return r;
    const next = r.slice();
    const a = next[1]!;
    next[1] = next[998]!;
    next[998] = a;
    return next;
  });
const remove = (id: number): void =>
  setRows((r) => {
    const next = r.slice();
    next.splice(
      next.findIndex((x) => x.id === id),
      1,
    );
    return next;
  });

// #endregion

// #region View

/** One of the jumbotron's buttons, with the official classes and id. */
function Button({ id, title, onClick }: { id: string; title: string; onClick: () => void }) {
  return (
    <div class="col-sm-6 smallpad">
      <button type="button" class="btn btn-primary btn-block" id={id} onClick={onClick}>
        {title}
      </button>
    </div>
  );
}

/**
 * The page. The trailing `preloadicon` span is the official apps' way to load the remove icon's
 * font before the first measured create.
 */
function App() {
  return (
    <div class="container">
      <div class="jumbotron">
        <div class="row">
          <div class="col-md-6">
            <h1>reactre keyed</h1>
          </div>
          <div class="col-md-6">
            <div class="row">
              <Button id="run" title="Create 1,000 rows" onClick={() => run(1000)} />
              <Button id="runlots" title="Create 10,000 rows" onClick={() => run(10000)} />
              <Button id="add" title="Append 1,000 rows" onClick={add} />
              <Button id="update" title="Update every 10th row" onClick={update} />
              <Button id="clear" title="Clear" onClick={clear} />
              <Button id="swaprows" title="Swap Rows" onClick={swapRows} />
            </div>
          </div>
        </div>
      </div>
      <table class="table table-hover table-striped test-data">
        <tbody>
          <For each={rows()} key={(row) => row.id}>
            {(row) => (
              <tr class={isSelected(row.id) ? "danger" : ""}>
                <td class="col-md-1">{row.id}</td>
                <td class="col-md-4">
                  <a onClick={() => setSelected(row.id)}>{row.label}</a>
                </td>
                <td class="col-md-1">
                  <a onClick={() => remove(row.id)}>
                    <span class="glyphicon glyphicon-remove" aria-hidden="true" />
                  </a>
                </td>
                <td class="col-md-6" />
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
    </div>
  );
}

// #endregion

render(App, document.getElementById("main")!);
