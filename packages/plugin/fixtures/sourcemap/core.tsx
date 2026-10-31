// A reactre app for test/sourcemap.test.ts. Each `throw` below is found by its message: the test
// throws it from the bundle and maps the stack's place back to this file.

import { For, render, signal } from "@reactre/core";

interface Row {
  readonly id: number;
  readonly label: string;
}

/** Throws while it renders, when asked to. */
function Panel(props: { boom: boolean }) {
  const title: string = props.boom ? "never" : "ok";
  if (props.boom) throw new Error("boom: component");
  return <p class="panel">{title}</p>;
}

export function mount(el: Element, boom: boolean): void {
  const [rows] = signal<Row[]>([{ id: 1, label: "one" }]);
  render(
    () => (
      <section>
        <Panel boom={boom} />
        <table>
          <tbody>
            <For each={rows()} key={(row: Row) => row.id}>
              {(row: Row) => (
                <tr>
                  <td
                    class="label"
                    onClick={() => {
                      throw new Error("boom: row " + row.id);
                    }}
                  >
                    {row.label}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    ),
    el,
  );
}
