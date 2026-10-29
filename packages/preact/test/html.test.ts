// The `html` tag (src/html.ts): each scenario in scenarios/html.tsx renders its view as JSX on
// Preact and as a tagged template on @reactre/preact; the transcripts must be equal.

import { describe, expect, test } from "bun:test";

import { transcript } from "./same.ts";
import { pairs } from "./scenarios/html.tsx";

describe("html", () => {
  for (const [name, p] of Object.entries(pairs)) {
    test(name, async () => {
      const compat = name.startsWith("compat:");
      const want = await transcript("preact", (t) => p.run(t, p.jsx(t)), compat);
      const got = await transcript("ours", (t) => p.run(t, p.html(t)), compat);
      expect(got).toEqual(want);
      expect(want.length).toBeGreaterThan(0);
    });
  }
});
