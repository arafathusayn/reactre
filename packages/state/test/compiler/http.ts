// A module of response checks, for ../compiler.test.ts's run cases (M77): a task's run may read a
// response's body after passing it to one of these, which the compiler reads to see that it looks
// at the status. `passThrough` doesn't look.

import { failed } from "./status.ts";

/** Throws for a 4xx or 5xx response. */
export function ensureOk(res: Response): void {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** The response, once checked: through a function of this module. */
export const checked = (res: Response): Response => {
  ensureOk(res);
  return res;
};

/** Through a function another module exports. */
const viaImport = (res: Response): void => {
  if (failed(res)) throw new Error("HTTP error");
};
export { viaImport as ensure };

/** Doesn't look at the status. */
export const passThrough = (res: Response): Response => res;
