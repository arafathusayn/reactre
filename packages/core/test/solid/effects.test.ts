// Ports of Solid 2.0's effect tests: createEffect, createTrackedEffect, createReaction, onFlush,
// flush, and the error phases of createEffect. They run on @reactre/core's `effect`, `reaction`
// (features/reaction) for createEffect(compute, apply) and createRenderEffect, `effect(fn, {
// error })` (features/errors) for an effect's error handler, and `flush` (features/timing).
//
// Ported from packages/signals/tests/createEffect.test.ts, createTrackedEffect.test.ts,
// createReaction.test.ts, onFlush.test.ts, flush.test.ts and effect-error-phases.test.ts of
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// How the ports translate Solid's effects:
//   - createEffect(compute, apply) and createRenderEffect(compute, apply) are `reaction(compute,
//     apply)`: reactre has one kind of effect, so a test of the order of the two kinds is a
//     "render-effects" gap. reaction runs `apply` at once, where Solid runs it at the flush: an
//     assertion that it has not run before the flush goes to the file's "held-writes" test.
//   - createTrackedEffect(fn) is `effect(fn)`; a cleanup the function returns is registered with
//     `onCleanup` instead, as reactre's effects take their cleanups.
//   - Solid's EffectBundle `{ effect, error }` is `effect(fn, { error })` from features/errors,
//     with the compute and the effect in one function.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { FakeElement } from "@reactre/testdom";

import * as context from "../../src/features/context.ts";
import * as errors from "../../src/features/errors.ts";
import { configureClientErrors, effect as effectWith } from "../../src/features/errors.ts";
import { createRoot } from "../../src/features/owner.ts";
import * as reactionFeature from "../../src/features/reaction.ts";
import { reaction } from "../../src/features/reaction.ts";
import * as timing from "../../src/features/timing.ts";
import { flush } from "../../src/features/timing.ts";
import { effect, memo, onCleanup, signal } from "../../src/index.ts";
import { base, compile, gap } from "./harness.ts";

afterEach(() => {
  configureClientErrors({});
  flush();
});

/** Solid's exports reactre lacks, to call in a gap's port: undefined until reactre has them. */
const missing = { ...reactionFeature, ...timing } as unknown as {
  createReaction?: (fn: () => void) => (tracking: () => void) => void;
  onFlush?: (fn: () => void) => void;
};
/** reaction with Solid's effect options, which reactre's does not take. */
const reactionWith = reaction as unknown as <T>(
  compute: () => T,
  apply: (v: T, prev: T | undefined) => void | (() => void),
  options: { defer?: boolean; schedule?: boolean },
) => void;

const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("held writes", () => {
  gap(
    "held-writes",
    "an effect runs when it is made and at each write",
    "an effect has not run before the flush (createEffect, createTrackedEffect and flush: should run effect, should batch updates)",
    () => {
      // createEffect.test.ts, should run effect: the apply half waits for the flush.
      const [$x] = signal(0);
      const fx = mock();
      createRoot(() => reaction($x, fx));
      expect(fx).toHaveBeenCalledTimes(0);
      // createTrackedEffect.test.ts, should run effect: so does a tracked effect.
      const tracked = mock($x);
      createRoot(() => effect(() => void tracked()));
      expect(tracked).toHaveBeenCalledTimes(0);
      // flush.test.ts, should batch updates: writes outside a flush are batched.
      const [$y, setY] = signal(10);
      const fy = mock();
      createRoot(() => reaction($y, fy));
      flush();
      setY(20);
      setY(30);
      setY(40);
      expect(fy).toHaveBeenCalledTimes(1);
      flush();
      expect(fy).toHaveBeenCalledTimes(2);
    },
  );
});

describe("createEffect.test.ts", () => {
  test("should run effect", () => {
    const [$x, setX] = signal(0),
      compute = mock($x),
      fx = mock();
    createRoot(() => reaction(compute, fx));
    expect(compute).toHaveBeenCalledTimes(1);
    flush();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(fx).toHaveBeenCalledTimes(1);
    expect(fx).toHaveBeenCalledWith(0, undefined);
    setX(1);
    flush();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(fx).toHaveBeenCalledTimes(2);
    expect(fx).toHaveBeenCalledWith(1, 0);
  });

  gap("held-writes", "the first run is not merged into the next write's", "should run effect on change", () => {
    const fx = mock();
    const [$x, setX] = signal(10);
    const [$y, setY] = signal(10);
    const $a = memo(() => $x() + $y());
    const $b = memo(() => $a());
    createRoot(() => reaction($b, fx));
    expect(fx).toHaveBeenCalledTimes(0);
    setX(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setY(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setX(20);
    setY(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
  });

  gap(
    "effect-equals",
    "reaction skips apply when compute returns the same value",
    "should handle nested effect",
    () => {
      const [$x, setX] = signal(0);
      const [$y, setY] = signal(0);
      const outerEffect = mock(),
        innerEffect = mock(),
        innerPureDispose = mock(),
        innerEffectDispose = mock();
      const stopEffect = createRoot((dispose) => {
        reaction(() => {
          $x();
          reaction(
            () => {
              $y();
              onCleanup(innerPureDispose);
            },
            () => {
              innerEffect();
              return () => {
                innerEffectDispose();
              };
            },
          );
        }, outerEffect);
        return dispose;
      });
      flush();
      expect(outerEffect).toHaveBeenCalledTimes(1);
      expect(innerEffect).toHaveBeenCalledTimes(1);
      expect(innerPureDispose).toHaveBeenCalledTimes(0);
      expect(innerEffectDispose).toHaveBeenCalledTimes(0);
      setY(1);
      flush();
      expect(outerEffect).toHaveBeenCalledTimes(1);
      expect(innerEffect).toHaveBeenCalledTimes(2);
      expect(innerPureDispose).toHaveBeenCalledTimes(1);
      expect(innerEffectDispose).toHaveBeenCalledTimes(1);
      setY(2);
      flush();
      expect(outerEffect).toHaveBeenCalledTimes(1);
      expect(innerEffect).toHaveBeenCalledTimes(3);
      expect(innerPureDispose).toHaveBeenCalledTimes(2);
      expect(innerEffectDispose).toHaveBeenCalledTimes(2);
      innerEffect.mockReset();
      innerPureDispose.mockReset();
      innerEffectDispose.mockReset();
      setX(1);
      flush();
      expect(outerEffect).toHaveBeenCalledTimes(2);
      expect(innerEffect).toHaveBeenCalledTimes(1);
      expect(innerPureDispose).toHaveBeenCalledTimes(1);
      expect(innerEffectDispose).toHaveBeenCalledTimes(1);
      setY(3);
      flush();
      expect(outerEffect).toHaveBeenCalledTimes(2);
      expect(innerEffect).toHaveBeenCalledTimes(2);
      expect(innerPureDispose).toHaveBeenCalledTimes(2);
      expect(innerEffectDispose).toHaveBeenCalledTimes(2);
      stopEffect();
      setX(10);
      setY(10);
      expect(outerEffect).toHaveBeenCalledTimes(2);
      expect(innerEffect).toHaveBeenCalledTimes(2);
      expect(innerPureDispose).toHaveBeenCalledTimes(3);
      expect(innerEffectDispose).toHaveBeenCalledTimes(3);
    },
  );

  gap("held-writes", "the effect ran when it was made, before the root was disposed", "should stop effect", () => {
    const fx = mock();
    const [$x, setX] = signal(10);
    const stopEffect = createRoot((dispose) => {
      reaction($x, fx);
      return dispose;
    });
    stopEffect();
    setX(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(0);
  });

  gap(
    "misuse-errors",
    "reaction ignores a cleanup that is not a function",
    "should throw on invalid cleanup values",
    () => {
      expect(() => {
        createRoot(() => {
          reaction(
            () => 1,
            () => 123 as never,
          );
        });
        flush();
      }).toThrow();
    },
  );

  test("should run all disposals before each new run", () => {
    const fx = mock(),
      disposeA = mock(),
      disposeB = mock(),
      disposeC = mock();
    const fnA = (): void => onCleanup(disposeA);
    const fnB = (): void => onCleanup(disposeB);
    const [$x, setX] = signal(0);
    createRoot(() =>
      reaction(
        () => {
          (fnA(), fnB());
          return $x();
        },
        () => {
          fx();
          return disposeC;
        },
      ),
    );
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    expect(disposeA).toHaveBeenCalledTimes(0);
    expect(disposeB).toHaveBeenCalledTimes(0);
    expect(disposeC).toHaveBeenCalledTimes(0);
    for (let i = 1; i <= 3; i += 1) {
      setX(i);
      flush();
      expect(fx).toHaveBeenCalledTimes(i + 1);
      expect(disposeA).toHaveBeenCalledTimes(i);
      expect(disposeB).toHaveBeenCalledTimes(i);
      expect(disposeC).toHaveBeenCalledTimes(i);
    }
  });

  gap("held-writes", "the inner effect ran when it was made", "should dispose of nested effect", () => {
    const [$x, setX] = signal(0);
    const innerEffect = mock();
    const stopEffect = createRoot((dispose) => {
      reaction(
        () => {
          reaction($x, innerEffect);
        },
        () => {},
      );
      return dispose;
    });
    stopEffect();
    setX(10);
    flush();
    expect(innerEffect).toHaveBeenCalledTimes(0);
    expect(innerEffect).not.toHaveBeenCalledWith(10, 0);
  });

  test("should conditionally observe", () => {
    const [$x, setX] = signal(0);
    const [$y, setY] = signal(0);
    const [$condition, setCondition] = signal(true);
    const $a = memo(() => ($condition() ? $x() : $y()));
    const fx = mock();
    createRoot(() => reaction($a, fx));
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setY(1);
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setX(1);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setCondition(false);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setY(2);
    flush();
    expect(fx).toHaveBeenCalledTimes(3);
    setX(3);
    flush();
    expect(fx).toHaveBeenCalledTimes(3);
  });

  test("should dispose of nested conditional effect", () => {
    const [$condition, setCondition] = signal(true);
    const disposeA = mock(),
      disposeB = mock();
    const fnA = (): void =>
      reaction(
        () => {
          onCleanup(disposeA);
        },
        () => {},
      );
    const fnB = (): void =>
      reaction(
        () => {
          onCleanup(disposeB);
        },
        () => {},
      );
    createRoot(() =>
      reaction(
        () => ($condition() ? fnA() : fnB()),
        () => {},
      ),
    );
    flush();
    setCondition(false);
    flush();
    expect(disposeA).toHaveBeenCalledTimes(1);
  });

  test("should handle looped effects", () => {
    let values: number[] = [],
      loop = 2;
    const [$value, setValue] = signal(0);
    createRoot(() =>
      reaction(
        () => {
          values.push($value());
          for (let i = 0; i < loop; i++) {
            reaction(
              () => {
                values.push($value() + i);
              },
              () => {},
            );
          }
        },
        () => {},
      ),
    );
    flush();
    expect(values).toHaveLength(3);
    expect(values.join(",")).toBe("0,0,1");
    loop = 1;
    values = [];
    setValue(1);
    flush();
    expect(values).toHaveLength(2);
    expect(values.join(",")).toBe("1,1");
    values = [];
    setValue(2);
    flush();
    expect(values).toHaveLength(2);
    expect(values.join(",")).toBe("2,2");
  });

  test("should apply changes in effect in same flush", () => {
    const [$x, setX] = signal(0),
      [$y, setY] = signal(0);
    const $a = memo(() => $x() + 1),
      $b = memo(() => $a() + 2);
    createRoot(() =>
      reaction($y, () => {
        setX((n) => n + 1);
      }),
    );
    flush();
    expect($x()).toBe(1);
    expect($b()).toBe(4);
    expect($a()).toBe(2);
    setY(1);
    flush();
    expect($x()).toBe(2);
    expect($b()).toBe(5);
    expect($a()).toBe(3);
    setY(2);
    flush();
    expect($x()).toBe(3);
    expect($b()).toBe(6);
    expect($a()).toBe(4);
  });

  test("should run parent effect before child effect", () => {
    const [$x, setX] = signal(0);
    const $condition = memo(() => $x());
    let calls = 0;
    createRoot(() =>
      reaction(
        () => {
          reaction(
            () => {
              $x();
              calls++;
            },
            () => {},
          );
          $condition();
        },
        () => {},
      ),
    );
    setX(1);
    flush();
    expect(calls).toBe(2);
  });

  gap(
    "render-effects",
    "reactre has one kind of effect, run in creation order",
    "should run render effect before user effects",
    () => {
      const [$x, setX] = signal(0);
      let mark = "";
      createRoot(() => {
        reaction($x, () => {
          mark += "b";
        });
        // createRenderEffect
        reaction($x, () => {
          mark += "a";
        });
      });
      flush();
      expect(mark).toBe("ab");
      setX(1);
      flush();
      expect(mark).toBe("abab");
    },
  );

  gap("render-effects", "reaction takes no defer option", "should defer user effects with the defer option", () => {
    let mark = "";
    const [$x, setX] = signal(0);
    createRoot(() => {
      reactionWith(
        $x,
        () => {
          mark += "b";
        },
        { defer: true },
      );
    });
    flush();
    expect(mark).toBe("");
    setX(1);
    flush();
    expect(mark).toBe("b");
  });

  describe("schedule option", () => {
    gap(
      "render-effects",
      "reaction takes no schedule option",
      "does not run initial render-effect callback synchronously when schedule: true",
      () => {
        let calls = 0;
        createRoot(() => {
          reactionWith(
            () => 1,
            () => {
              calls++;
            },
            { schedule: true },
          );
          expect(calls).toBe(0);
        });
        flush();
        expect(calls).toBe(1);
      },
    );

    test("runs initial render-effect callback synchronously without schedule (default)", () => {
      let calls = 0;
      createRoot(() => {
        reaction(
          () => 1,
          () => {
            calls++;
          },
        );
        expect(calls).toBe(1);
      });
      flush();
      expect(calls).toBe(1);
    });
  });

  describe("final returned cleanup runs at the effect's own disposal", () => {
    test("runs once at disposal, after per-rerun cleanups", () => {
      const [$x, setX] = signal(0);
      const cleanup = mock();
      const dispose = createRoot((dispose) => {
        reaction($x, () => cleanup);
        return dispose;
      });
      flush();
      expect(cleanup).toHaveBeenCalledTimes(0);
      setX(1);
      flush();
      expect(cleanup).toHaveBeenCalledTimes(1);
      dispose();
      expect(cleanup).toHaveBeenCalledTimes(2);
      setX(2);
      flush();
      expect(cleanup).toHaveBeenCalledTimes(2);
    });

    gap(
      "dispose-order",
      "reactre runs effects' and owner's cleanups in creation order",
      "fires in unwind order at the effect's structural position",
      () => {
        const order: string[] = [];
        const [$x] = signal(0);
        const dispose = createRoot((dispose) => {
          onCleanup(() => order.push("onCleanup:before"));
          reaction($x, () => () => order.push("effect:A"));
          reaction($x, () => () => order.push("effect:B"));
          onCleanup(() => order.push("onCleanup:after"));
          return dispose;
        });
        flush();
        dispose();
        expect(order).toEqual(["effect:B", "effect:A", "onCleanup:after", "onCleanup:before"]);
      },
    );

    test("early individual disposal fires the cleanup once; outer disposal does not re-run it", () => {
      const [$x] = signal(0);
      const cleanup = mock();
      let disposeInner!: () => void;
      const disposeOuter = createRoot((dispose) => {
        createRoot((d) => {
          disposeInner = d;
          reaction($x, () => cleanup);
        });
        return dispose;
      });
      flush();
      disposeInner();
      expect(cleanup).toHaveBeenCalledTimes(1);
      disposeOuter();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("render effect final cleanup follows the same rule", () => {
      const [$x, setX] = signal(0);
      const cleanup = mock();
      const dispose = createRoot((dispose) => {
        reaction($x, () => cleanup);
        return dispose;
      });
      flush();
      setX(1);
      flush();
      expect(cleanup).toHaveBeenCalledTimes(1);
      dispose();
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
  });
});

describe("flush.test.ts", () => {
  test("balances syncDepth when an effect throws inside flush(fn)", async () => {
    const [a, setA] = signal(0);
    const [c, setC] = signal(0);
    const seenC: number[] = [];
    createRoot(() => {
      reaction(a, (v) => {
        if (v === 1) throw new Error("boom");
      });
      reaction(c, (v) => {
        seenC.push(v);
      });
    });
    flush();
    await Promise.resolve();
    seenC.length = 0;
    expect(() => flush(() => setA(1))).toThrow("boom");
    setC(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(seenC).toEqual([3]);
  });

  test("should wait for queue to flush", () => {
    const [$x, setX] = signal(10);
    const $effect = mock();
    createRoot(() => reaction($x, $effect));
    flush();
    expect($effect).toHaveBeenCalledTimes(1);
    setX(20);
    flush();
    expect($effect).toHaveBeenCalledTimes(2);
    setX(30);
    flush();
    expect($effect).toHaveBeenCalledTimes(3);
  });

  test("should not fail if called while flushing", () => {
    const [$a, setA] = signal(10);
    const fx = mock(() => {
      flush();
    });
    createRoot(() => reaction($a, fx));
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setA(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
  });

  test("should run callback and flush before returning", () => {
    const [$x, setX] = signal(10);
    const fx = mock();
    createRoot(() => reaction($x, fx));
    flush();
    const result = flush(() => {
      setX(20);
      expect(fx).toHaveBeenCalledTimes(1);
      return "done";
    });
    expect(result).toBe("done");
    expect(fx).toHaveBeenCalledTimes(2);
  });

  test("nested flush(fn) drains at each level", () => {
    const [$x, setX] = signal(10);
    const [$y, setY] = signal(10);
    const fx = mock();
    createRoot(() => reaction(() => [$x(), $y()], fx));
    flush();
    flush(() => {
      setX(20);
      expect(fx).toHaveBeenCalledTimes(1);
      const inner = flush(() => {
        setY(30);
        expect(fx).toHaveBeenCalledTimes(1);
        return 1;
      });
      expect(inner).toBe(1);
      expect(fx).toHaveBeenCalledTimes(2);
    });
    expect(fx).toHaveBeenCalledTimes(2);
  });
});

describe("createTrackedEffect.test.ts", () => {
  test("should run effect", () => {
    const [$x, setX] = signal(0),
      fx = mock($x);
    createRoot(() =>
      effect(() => {
        fx();
      }),
    );
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setX(1);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
  });

  gap("held-writes", "the first run is not merged into the next write's", "should run effect on change", () => {
    const [$x, setX] = signal(10);
    const [$y, setY] = signal(10);
    const $a = memo(() => $x() + $y());
    const $b = memo(() => $a());
    const fx = mock($b);
    createRoot(() =>
      effect(() => {
        fx();
      }),
    );
    expect(fx).toHaveBeenCalledTimes(0);
    setX(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setY(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setX(20);
    setY(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
  });

  gap("held-writes", "the effect ran when it was made, before the root was disposed", "should stop effect", () => {
    const [$x, setX] = signal(10);
    const fx = mock($x);
    const stopEffect = createRoot((dispose) => {
      effect(() => {
        fx();
      });
      return dispose;
    });
    stopEffect();
    setX(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(0);
  });

  test("should run all disposals before each new run", () => {
    const fx = mock(),
      dispose = mock();
    const [$x, setX] = signal(0);
    createRoot(() =>
      effect(() => {
        $x();
        fx();
        onCleanup(dispose);
      }),
    );
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(0);
    for (let i = 1; i <= 3; i += 1) {
      setX(i);
      flush();
      expect(fx).toHaveBeenCalledTimes(i + 1);
      expect(dispose).toHaveBeenCalledTimes(i);
    }
  });

  test("should conditionally observe", () => {
    const [$x, setX] = signal(0);
    const [$y, setY] = signal(0);
    const [$condition, setCondition] = signal(true);
    const $a = memo(() => ($condition() ? $x() : $y()));
    const fx = mock($a);
    createRoot(() =>
      effect(() => {
        fx();
      }),
    );
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setY(1);
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    setX(1);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setCondition(false);
    flush();
    expect(fx).toHaveBeenCalledTimes(2);
    setY(2);
    flush();
    expect(fx).toHaveBeenCalledTimes(3);
    setX(3);
    flush();
    expect(fx).toHaveBeenCalledTimes(3);
  });

  test("should not warn on signal writes inside tracked effect", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [$trigger, setTrigger] = signal(0);
      const [$target, setTarget] = signal(0);
      createRoot(() =>
        effect(() => {
          $trigger();
          setTarget((n) => n + 1);
        }),
      );
      flush();
      expect($target()).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      setTrigger(1);
      flush();
      expect($target()).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("should apply changes in effect in same flush", () => {
    const [$x, setX] = signal(0),
      [$y, setY] = signal(0);
    const $a = memo(() => $x() + 1),
      $b = memo(() => $a() + 2);
    createRoot(() =>
      effect(() => {
        $y();
        setX((n) => n + 1);
      }),
    );
    flush();
    expect($x()).toBe(1);
    expect($b()).toBe(4);
    expect($a()).toBe(2);
    setY(1);
    flush();
    expect($x()).toBe(2);
    expect($b()).toBe(5);
    expect($a()).toBe(3);
    setY(2);
    flush();
    expect($x()).toBe(3);
    expect($b()).toBe(6);
    expect($a()).toBe(4);
  });

  gap(
    "render-effects",
    "reactre has one kind of effect, run in creation order",
    "should run render effect before user effects",
    () => {
      const [$x, setX] = signal(0);
      let mark = "";
      createRoot(() => {
        effect(() => {
          $x();
          mark += "b";
        });
        reaction($x, () => {
          mark += "a";
        });
      });
      flush();
      expect(mark).toBe("ab");
      setX(1);
      flush();
      expect(mark).toBe("abab");
    },
  );

  gap(
    "misuse-errors",
    "reactre lets a tracked effect make memos and cleanups",
    "should throw when creating tracked-effect children inside (__DEV__ only)",
    () => {
      createRoot(() => {
        effect(() => {
          expect(() => effect(() => {})).toThrow();
          expect(() => memo(() => 1)).toThrow();
          expect(() => onCleanup(() => {})).toThrow();
        });
      });
      flush();
    },
  );

  test("should throw uncaught tracked effect errors during flush", () => {
    // reactre runs the effect when it is made, so the error comes from there.
    expect(() => {
      createRoot(() => {
        effect(() => {
          throw new Error("tracked boom");
        });
      });
      flush();
    }).toThrow("tracked boom");
  });

  gap("misuse-errors", "an effect's return value is ignored", "should throw on invalid cleanup values", () => {
    expect(() => {
      createRoot(() => {
        effect((() => ({})) as () => void);
      });
      flush();
    }).toThrow();
  });

  test("should run the final returned cleanup at the node's own disposal", () => {
    const [$x, setX] = signal(0);
    const cleanup = mock();
    const dispose = createRoot((dispose) => {
      effect(() => {
        $x();
        onCleanup(cleanup);
      });
      return dispose;
    });
    flush();
    expect(cleanup).toHaveBeenCalledTimes(0);
    setX(1);
    flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  test("should work with dynamic conditional tracking", () => {
    const [$type, setType] = signal<"a" | "b">("a");
    const [$valueA, setValueA] = signal("Alice");
    const [$valueB, setValueB] = signal("Bob");
    const log = mock();
    createRoot(() => {
      effect(() => {
        if ($type() === "a") log($valueA());
        else log($valueB());
      });
    });
    flush();
    expect(log).toHaveBeenCalledWith("Alice");
    expect(log).toHaveBeenCalledTimes(1);
    setValueB("Bobby");
    flush();
    expect(log).toHaveBeenCalledTimes(1);
    setType("b");
    flush();
    expect(log).toHaveBeenCalledWith("Bobby");
    expect(log).toHaveBeenCalledTimes(2);
    setValueA("Alicia");
    flush();
    expect(log).toHaveBeenCalledTimes(2);
    setValueB("Robert");
    flush();
    expect(log).toHaveBeenCalledWith("Robert");
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe("createReaction.test.ts", () => {
  gap("create-reaction", "reactre has no createReaction", "Create and trigger a Reaction", () => {
    let count = 0;
    const [sign, setSign] = signal("thoughts");
    const track = createRoot(() =>
      missing.createReaction!(() => {
        count++;
      }),
    );
    flush();
    expect(count).toBe(0);
    track(sign);
    expect(count).toBe(0);
    flush();
    expect(count).toBe(0);
    setSign("mind");
    flush();
    expect(count).toBe(1);
    setSign("body");
    flush();
    expect(count).toBe(1);
    track(sign);
    setSign("everything");
    flush();
    expect(count).toBe(2);
  });

  gap(
    "create-reaction",
    "reactre has no createReaction",
    "fires and disposes cleanly when the rerun tracks zero dependencies",
    () => {
      let fired = 0;
      let readDep = true;
      const [sign, setSign] = signal("a");
      createRoot(() => {
        const track = missing.createReaction!(() => {
          fired++;
        });
        track(() => {
          if (readDep) sign();
        });
      });
      flush();
      expect(fired).toBe(0);
      readDep = false;
      setSign("b");
      expect(() => flush()).not.toThrow();
      expect(fired).toBe(1);
    },
  );

  gap(
    "create-reaction",
    "reactre has no createReaction",
    "re-arming before a fire replaces tracked sources (#2861)",
    () => {
      let count = 0;
      const [a, setA] = signal(0);
      const [b, setB] = signal(0);
      const track = createRoot(() =>
        missing.createReaction!(() => {
          count++;
        }),
      );
      track(() => a());
      track(() => b());
      setA(1);
      flush();
      expect(count).toBe(0);
      setB(1);
      flush();
      expect(count).toBe(1);
      setB(2);
      setA(2);
      flush();
      expect(count).toBe(1);
    },
  );

  gap(
    "create-reaction",
    "reactre has no createReaction",
    "re-arm inside the reaction callback arms the next cycle (#2861)",
    () => {
      let count = 0;
      const [a, setA] = signal(0);
      let track!: (fn: () => void) => void;
      createRoot(() => {
        track = missing.createReaction!(() => {
          count++;
          track(() => a());
        });
      });
      track(() => a());
      setA(1);
      flush();
      expect(count).toBe(1);
      setA(2);
      flush();
      expect(count).toBe(2);
    },
  );
});

describe("onFlush.test.ts", () => {
  gap(
    "render-effects",
    "reactre has no onFlush",
    "runs after the drain when called from an effect callback",
    async () => {
      const [trigger, setTrigger] = signal(0);
      const [value, setValue] = signal(0);
      const log: string[] = [];
      createRoot(() => {
        reaction(trigger, (t) => {
          if (t) missing.onFlush!(() => setValue(t * 10));
        });
        reaction(value, (v) => void log.push(`value:${v}`));
      });
      flush();
      setTrigger(1);
      await microtasks();
      expect(log).toEqual(["value:0", "value:10"]);
    },
  );

  gap(
    "render-effects",
    "reactre has no onFlush",
    "lands after inline writes in the same frame; callbacks run in order and batch",
    async () => {
      const [v, setV] = signal(0);
      const log: number[] = [];
      createRoot(() => reaction(v, (x) => void log.push(x)));
      flush();
      log.length = 0;
      missing.onFlush!(() => setV(1));
      setV(2);
      await microtasks();
      expect(log).toEqual([2, 1]);
      log.length = 0;
      missing.onFlush!(() => setV((x) => x + 10));
      setV((x) => x * 2);
      await microtasks();
      expect(log).toEqual([2, 12]);
      log.length = 0;
      missing.onFlush!(() => setV(100));
      missing.onFlush!(() => setV(200));
      await microtasks();
      expect(log).toEqual([200]);
    },
  );
});

describe("effect-error-phases.test.ts", () => {
  gap(
    "effect-errors",
    "an unhandled error is thrown to the write",
    "compute-phase throw with no handler: logged, run skipped, system alive",
    () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const log: string[] = [];
        const [beat, setBeat] = signal(0);
        const [armed, setArmed] = signal(false);
        createRoot(() => {
          reaction(beat, (v) => {
            log.push(`beat=${v}`);
          });
          reaction(
            () => {
              if (armed()) throw new Error("boom-compute");
              return 0;
            },
            () => {
              log.push("effect ran");
            },
          );
        });
        flush();
        expect(log).toEqual(["beat=0", "effect ran"]);
        log.length = 0;
        expect(() => {
          setArmed(true);
          flush();
        }).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: "boom-compute" }));
        expect(log).toEqual([]);
        setBeat(1);
        flush();
        expect(log).toEqual(["beat=1"]);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  test("compute-phase throw with EffectBundle handler: handler receives it, no log", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const log: string[] = [];
      const [armed, setArmed] = signal(false);
      createRoot(() => {
        effectWith(
          () => {
            if (armed()) throw new Error("boom-compute");
          },
          {
            error: (err) => {
              log.push(`handler: ${(err as Error).message}`);
            },
          },
        );
      });
      flush();
      setArmed(true);
      flush();
      expect(log).toEqual(["handler: boom-compute"]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("handler receives the thrown error's identity, not the internal wrapper (#2840)", () => {
    class MyError extends Error {}
    const boom = new MyError("boom-identity");
    const [armed, setArmed] = signal(false);
    let received: unknown;
    createRoot(() => {
      effectWith(
        () => {
          if (armed()) throw boom;
        },
        {
          error: (err) => {
            received = err;
          },
        },
      );
    });
    flush();
    setArmed(true);
    flush();
    expect(received).toBe(boom);
    expect(received).toBeInstanceOf(MyError);
    expect(received !== null && typeof received === "object" && "source" in received).toBe(false);
  });

  gap(
    "effect-errors",
    "an unhandled error is thrown to the write",
    "unhandled compute-phase error is logged unwrapped (#2840)",
    () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        class MyError extends Error {}
        const boom = new MyError("boom-log");
        const [armed, setArmed] = signal(false);
        createRoot(() => {
          reaction(
            () => {
              if (armed()) throw boom;
              return 0;
            },
            () => {},
          );
        });
        flush();
        setArmed(true);
        flush();
        expect(errorSpy).toHaveBeenCalledWith(boom);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  test("handler runs in a writable scope: signal writes are legal (#2840)", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [armed, setArmed] = signal(false);
      const [errorMsg, setErrorMsg] = signal("");
      const views: string[] = [];
      createRoot(() => {
        effectWith(
          () => {
            if (armed()) throw new Error("boom-write");
          },
          {
            error: (err) => {
              setErrorMsg((err as Error).message);
            },
          },
        );
        reaction(errorMsg, (v) => {
          views.push(v);
        });
      });
      flush();
      expect(views).toEqual([""]);
      setArmed(true);
      flush();
      expect(errorMsg()).toBe("boom-write");
      expect(views).toEqual(["", "boom-write"]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warn.mockRestore();
    }
  });

  gap(
    "held-writes",
    "the handler sees the error at the write",
    "error that recovers before the effect phase never reaches the handler (#2840)",
    () => {
      const [source, setSource] = signal(0);
      const handled: string[] = [];
      const ran: number[] = [];
      createRoot(() => {
        effectWith(
          () => {
            const v = source();
            if (v === 1) throw new Error("transient");
            ran.push(v);
          },
          {
            error: (err) => {
              handled.push((err as Error).message);
            },
          },
        );
      });
      flush();
      expect(ran).toEqual([0]);
      setSource(1);
      setSource(2);
      flush();
      expect(handled).toEqual([]);
      expect(ran).toEqual([0, 2]);
      setSource(1);
      flush();
      expect(handled).toEqual(["transient"]);
      expect(ran).toEqual([0, 2]);
    },
  );

  test("handler rethrow escalates to the nearest error boundary", () => {
    // createErrorBoundary is <Errored>; what its fallback shows is the page's text.
    const log: string[] = [];
    const [armed, setArmed] = signal(false);
    const root = new FakeElement("DIV");
    compile(
      `
      import { render } from "@reactre/core";
      import { effect, Errored } from "@reactre/core/features/errors";
      function Content() {
        effect(() => {
          if (armed()) throw new Error("boom-compute");
        }, {
          error: (err) => {
            log.push("handler saw it");
            throw err;
          },
        });
        return <b>content</b>;
      }
      render(() => (
        <div>
          <Errored fallback={(err) => <i>{"fallback:" + err.message}</i>}>
            <Content />
          </Errored>
        </div>
      ), root);
      return {};
      `,
      { ...base, "@reactre/core/features/context": context, "@reactre/core/features/errors": errors },
      { root, armed, log },
    );
    flush();
    expect(root.textContent).toBe("content");
    setArmed(true);
    flush();
    expect(log).toEqual(["handler saw it"]);
    expect(root.textContent).toBe("fallback:boom-compute");
  });
});
