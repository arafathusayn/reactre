// The clock's boundary with host timers: a timer made before installation belongs to the host,
// not to the simulated deadline table. Use a real host handle, never a stubbed global clearTimeout:
// a clock would capture a stub as its host clear, and that stub could leak into another test file.

import { describe, expect, test } from "bun:test";

import { SimulatedClock } from "../src/utils/SimulatedClock.ts";

describe("SimulatedClock and a timer from before its installation", () => {
  test("clearing the host handle delegates to the host, and uninstall restores both functions", async () => {
    const hostSet = globalThis.setTimeout;
    const hostClear = globalThis.clearTimeout;
    let fired = false;
    const before = hostSet(() => {
      fired = true;
    }, 0);
    const clock = new SimulatedClock();
    try {
      clearTimeout(before);
      expect(globalThis.setTimeout).not.toBe(hostSet);
      expect(globalThis.clearTimeout).not.toBe(hostClear);
    } finally {
      clock.uninstall();
    }
    expect(globalThis.setTimeout).toBe(hostSet);
    expect(globalThis.clearTimeout).toBe(hostClear);
    await new Promise((resolve) => hostSet(resolve, 2));
    expect(fired).toBe(false);
  });
});
