/** @jsxImportSource @reactre/core */
// A type test of @reactre/core/jsx-runtime's JSX namespace: `bun check` passes only if every
// element here type-checks and every line under @ts-expect-error is an error. Nothing runs it;
// bun test runs only *.test.ts files.

import { Dynamic, For, Match, Portal, render, Repeat, selector, Show, signal, Switch } from "@reactre/core";
import { dynamic } from "@reactre/core/features/dynamic";
import type { Child, JSX } from "@reactre/core/jsx-runtime";

type Row = { id: number; label: string };

const [rows, setRows] = signal<Row[]>([]);
const [selected, setSelected] = signal(0);
const [count, setCount] = signal(0);
const isSelected = selector(selected);

// #region What must type-check

/** A component: a function of its props, children included. */
const Button = (props: { id: string; onClick: () => void; children?: Child }): JSX.Element => (
  <button type="button" id={props.id} class="btn" onClick={props.onClick}>
    {props.children}
  </button>
);

/** A component that returns text, not an element: a tag may still name it. */
const Label = (props: { text: string }): string => props.text;

const App = (): JSX.Element => (
  <div class="container" style="display: flex" data-test-id="app" aria-label="app" tabindex={0}>
    <Button id="add" onClick={() => setRows((r) => [...r, { id: r.length, label: "row" }])}>
      Add <Label text="a row" />
    </Button>
    <p className={count() > 0 ? "some" : ""} hidden={count() === 0} title={undefined}>
      Clicked {count()} times, {rows().length} rows, {null}
      {false}
      {[1, "two", 3n]}
    </p>
    <input type="text" value={count()} disabled={false} maxlength={10} onInput={(e: Event) => e.type} />
    <label htmlFor="name" for="name">
      Name
    </label>
    <button
      onClick={(e: MouseEvent) => setCount((n) => n + e.detail)}
      onDblClick={(e: MouseEvent) => e.button}
      onKeyDown={(e: KeyboardEvent) => e.key}
      onPointerMove={(e: PointerEvent) => e.pointerId}
      onFocusIn={(e: FocusEvent) => e.relatedTarget}
      onTransitionEnd={(e: TransitionEvent) => e.propertyName}
      onSubmit={(e: SubmitEvent) => e.submitter}
    />
    <table>
      <tbody>
        <For each={rows()} key={(row) => row.id}>
          {(row) => (
            <tr class={isSelected(row.id) ? "danger" : ""}>
              <td colspan={2} onClick={() => setSelected(row.id)}>
                {row.label}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
    <svg viewBox="0 0 24 24" width={24} height="24" xmlns="http://www.w3.org/2000/svg" class="icon">
      <g transform="translate(1 1)" fill="none" stroke="currentColor" stroke-width={2}>
        <path d="M0 0L10 10" stroke-linecap="round" onClick={(e: MouseEvent) => e.clientX} />
        <circle cx={12} cy={12} r={count()} />
        <linearGradient id="g" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="red" />
        </linearGradient>
      </g>
      <a href="#top">
        <text x={0} y={10}>
          top
        </text>
      </a>
    </svg>
    <img src="a.png" alt="" loading="lazy" />
    <br />
  </div>
);

render(App, document.body);

/** Every JSX expression is a JSX.Element, a Node. */
const node: Node = <span />;

/**
 * Props are typed as values. The compiler passes one that may change as a getter, and children
 * that hold JSX too, but the component reads `props.n` as a number and `props.children` as a Child.
 */
const Counter = (props: { n: number; children?: Child }): JSX.Element => (
  <b title={String(props.n + 1)}>
    {props.n}
    {props.children}
  </b>
);
const Counted = (): JSX.Element => (
  <div>
    <Counter n={count()}>
      <i>{count()}</i>
    </Counter>
    <Counter n={1} />
  </div>
);
void Counted;

// #endregion

// #region What must not type-check

const accepted = (): Node[] => {
  const input: { current: HTMLInputElement | null } = { current: null };
  return [
    <div style={{ color: "red", "--gap": "4px", "margin-top": 0, opacity: 0.5, display: false }} />,
    <div style="color: red" />,
    <div ref={(el: Element) => el} />,
    <input ref={input} />,
    <circle ref={(el: SVGCircleElement) => el.r} />,
    <li key={1} />,
    <>
      <p />
    </>,
    <ul>
      <For each={rows()} keyed={false}>
        {(row, i) => <li title={String(i)}>{row().label}</li>}
      </For>
    </ul>,
    <ul>
      <For each={rows()} keyed={(row) => row.id}>
        {(row) => <li>{row.label}</li>}
      </For>
    </ul>,
    // Anywhere content goes, with rows of any shape, and a keyed row's index accessor.
    <>
      <For each={rows()} key={(row) => row.id}>
        {(row, i) => [i().toFixed(0), row.label]}
      </For>
      <Repeat count={2}>{(i) => i + 1}</Repeat>
      <Repeat count={2}>
        <hr />
      </Repeat>
    </>,
  ];
};
void accepted;

const errors = (): Node[] => [
  // @ts-expect-error a style property that does not exist
  <div style={{ colour: "red" }} />,
  // @ts-expect-error a style value is a string or a number
  <div style={{ color: {} }} />,
  // @ts-expect-error a ref gets the element's own type
  <div ref={(el: HTMLInputElement) => el} />,
  // @ts-expect-error a key is a value, not a function
  <li key={() => 1} />,
  // @ts-expect-error an element that does not exist
  <notatag />,
  // @ts-expect-error an attribute that does not exist
  <div hreff="/" />,
  // @ts-expect-error a class object's value is a flag, not a signal's getter
  <div class={{ active: count }} />,
  // @ts-expect-error a class array's items are class names, objects and arrays
  <div class={[() => "a"]} />,
  // @ts-expect-error a signal's getter, not its value: it would be written once, as text
  <p title={count} />,
  // @ts-expect-error a child function would be written as text
  <p>{() => count()}</p>,
  // @ts-expect-error a handler's event is the event's type: a click is a MouseEvent
  <button onClick={(e: KeyboardEvent) => e.key} />,
  // @ts-expect-error a handler takes its event, not a value
  <button onClick="alert(1)" />,
  // @ts-expect-error capture handlers are not compiled (the event would be "clickcapture")
  <button onClickCapture={() => {}} />,
  // @ts-expect-error void elements take no children
  <input>text</input>,
  // @ts-expect-error <For> needs a key
  <For each={rows()}>{(row) => <tr>{row.label}</tr>}</For>,
  // @ts-expect-error a row's key reads the row's own type
  <For each={rows()} key={(row) => row.missing}>
    {(row) => <tr>{row.label}</tr>}
  </For>,
  // @ts-expect-error a row by position gets an accessor of its item, not the item
  <For each={rows()} keyed={false} children={(row: Row) => <tr>{row.label}</tr>} />,
  // @ts-expect-error keyed is false or a key function
  <For each={rows()} keyed={true} children={(row: () => Row) => <tr>{row().label}</tr>} />,
  // @ts-expect-error a component's props are checked
  <Button id={1} onClick={() => {}} />,
  // @ts-expect-error a component's required props are required
  <Label />,
  // @ts-expect-error an SVG attribute on an HTML element
  <div viewBox="0 0 1 1" />,
  // @ts-expect-error an SVG shape's geometry, not HTML's
  <circle href={() => 1} />,
];

(void node, errors);

// #endregion

// #region Control flow and element features

const [user] = signal<{ first: string } | null>(null);
const [on] = signal(false);
const Home = (): JSX.Element => <p>home</p>;
/** A directive: a function that returns a ref. */
const tooltip =
  (text: string) =>
  (el: HTMLElement): void =>
    void el.setAttribute("title", text);
const View = dynamic(() => (on() ? "h1" : "h2"));
const Chosen = dynamic(() => (on() ? Label : null));

const flow = (): Node[] => {
  const input: { current: HTMLDivElement | null } = { current: null };
  return [
    <div>
      <Show when={user()} fallback={<p>signed out</p>}>
        {(u) => <p>{u().first}</p>}
      </Show>
      <Show when={user()} keyed>
        {(u) => <p>{u.first}</p>}
      </Show>
      <Show when={count() > 0}>positive</Show>
      <Switch fallback="none">
        <Match when={count() === 1}>
          <Home />
        </Match>
        <Match when={user()}>{(u) => <p>{u().first}</p>}</Match>
        <Match when={user()} keyed>
          {(u) => <p>{u.first}</p>}
        </Match>
      </Switch>
      <Portal mount={document.body}>
        <p>modal</p>
      </Portal>
      <Portal>
        <p />
      </Portal>
      <Dynamic component="h1" class="title">
        x
      </Dynamic>
      <Dynamic component={on() ? "h1" : "h2"} id="t" />
      <Dynamic component={Button} id="b" onClick={() => {}} />
      <View class="v" />
      <Chosen text="chosen" />
    </div>,
    <ul>
      <For each={rows()} key={(r) => r.id} fallback={<li>none</li>}>
        {(row) => <li>{row.label}</li>}
      </For>
      <Repeat count={3} from={1} fallback={<li />}>
        {(i) => <li>{i.toFixed(0)}</li>}
      </Repeat>
    </ul>,
    <div class={{ active: on(), "big wide": true }} className="base" />,
    <div class={["a", { b: on() }, null, false, ["c", count()]]} />,
    <circle class={{ on: on() }} />,
    <input defaultValue="x" defaultChecked />,
    <textarea defaultValue="t" />,
    <option defaultSelected />,
    <video defaultMuted />,
    <div ref={[(el: HTMLDivElement) => el, input, null]} />,
    <div ref={tooltip("hi")} />,
  ];
};

const flowErrors = (): Node[] => [
  // @ts-expect-error <Show> needs when
  <Show>x</Show>,
  <Show when={user()} keyed>
    {
      // @ts-expect-error a keyed <Show>'s function child gets the value, not an accessor
      (u) => <p>{u().first}</p>
    }
  </Show>,
  <Show when={user()}>
    {
      // @ts-expect-error a <Show>'s function child gets an accessor of the value
      (u) => <p>{u.first}</p>
    }
  </Show>,
  // @ts-expect-error <Repeat>'s row gets the index, a number
  <Repeat count={2}>{(i: string) => <li>{i}</li>}</Repeat>,
  // @ts-expect-error <Dynamic>'s props are its tag's
  <Dynamic component="a" viewBox="0 0 1 1" />,
  // @ts-expect-error <Dynamic>'s props are its component's
  <Dynamic component={Button} id={1} onClick={() => {}} />,
  // @ts-expect-error a ref array's refs get the element's own type
  <div ref={[(el: HTMLInputElement) => el]} />,
  // @ts-expect-error defaultChecked is an input's
  <div defaultChecked />,
  // @ts-expect-error fallback is <For>'s, not every component's
  <Label text="x" fallback="y" />,
];

(void flow, flowErrors);

// #endregion
