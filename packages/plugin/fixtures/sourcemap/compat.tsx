// A React app for test/sourcemap.test.ts, on @reactre/compat. Its list's rows compile to a
// template in a loop hoisted to module scope; the row's handler throws, and the test maps the
// stack's place back to this file.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

interface Row {
  readonly id: number;
  readonly label: string;
}

function Rows({ rows }: { readonly rows: readonly Row[] }) {
  return (
    <ul>
      {rows.map((row) => (
        <li
          key={row.id}
          className="row"
          onClick={() => {
            throw new Error("boom: compat row " + row.id);
          }}
        >
          {row.label}
        </li>
      ))}
    </ul>
  );
}

export function mount(el: Element) {
  const root = createRoot(el);
  flushSync(() => root.render(<Rows rows={[{ id: 1, label: "one" }]} />));
  return root;
}
