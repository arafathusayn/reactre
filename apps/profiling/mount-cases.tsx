import { attach, For, onCleanup, Show, signal } from "@reactre/core";

import { labels } from "./mount-data.ts";

type Item = { id: number; label: string; kind: "plain" | "alternate" };
const items: Item[] = Array.from({ length: 500 }, (_, id) => ({
  id,
  label: `row ${id}`,
  kind: id % 2 ? "plain" : "alternate",
}));
let cleaned = 0;
function Resource() {
  onCleanup(() => cleaned++);
  return <em>resource</em>;
}
export function mount(root: Element, mode: string) {
  const [rows, setRows] = signal(items);
  const [shown, setShown] = signal(true);
  const [count, setCount] = signal(0);
  const dispose = attach(
    () => (
      <main>
        <Show when={shown()}>
          <ul>
            <For each={rows()} key={(row) => row.id}>
              {(row) => (
                <li>
                  {mode === "nested" ? (
                    row.kind === "plain" ? (
                      <span>
                        {row.label}
                        <Resource />
                      </span>
                    ) : (
                      <i>
                        {row.label}
                        <Resource />
                      </i>
                    )
                  ) : mode === "text" ? (
                    <span>{`${labels[row.kind]}: ${row.label}`}</span>
                  ) : (
                    <span>{row.label}</span>
                  )}
                  <b>{count()}</b>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </main>
    ),
    root,
  );
  return {
    update() {
      setRows(rows().map((r) => ({ ...r, label: r.label + "!", kind: r.kind === "plain" ? "alternate" : "plain" })));
    },
    switch() {
      setShown(false);
      setShown(true);
    },
    signal() {
      setCount(count() + 1);
    },
    dispose,
  };
}
export function exercise(mode: string, operation: string, cycles: number): number {
  const root = document.createElement("div");
  document.body.append(root);
  const app = mount(root, mode);
  const before = cleaned;
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    if (operation === "mount-dispose") {
      const another = document.createElement("div");
      const mounted = mount(another, mode);
      mounted.dispose();
    } else if (operation === "switch") app.switch();
    else if (operation === "update") app.update();
    else app.signal();
  }
  const ms = performance.now() - start;
  if (root.querySelectorAll("li").length !== 500) throw new Error("lost rows");
  app.dispose();
  if (root.textContent !== "") throw new Error("disposal left content");
  if (mode === "nested" && cleaned <= before) throw new Error("missing resource cleanup");
  root.remove();
  return ms;
}
