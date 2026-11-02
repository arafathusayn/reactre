// Ports of Solid 2.0's ownership tests: onCleanup, createRoot, getOwner and runWithOwner, and the
// teardown of a root whose cleanups throw. They run on @reactre/core's `onCleanup`, `effect` and
// `memo`, `createRoot`, `getOwner` and `runWithOwner` (features/owner), and `reaction`
// (features/reaction) for createEffect(compute, apply).
//
// Ported from packages/signals/tests/onCleanup.test.ts, createRoot.test.ts, getOwner.test.ts,
// runWithOwner.test.ts and cleanup-throw-continues.test.ts of solid-js 2.0.0-rc.20
// (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato;
// the license is in ./harness.ts.
//
// Where a Solid test reads an owner's internals (`_context`, `_parent`, `_subs`), the port asserts
// what they stand for through the public API: the owner `runWithOwner` restores, and a child root
// that goes with its parent.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as context from "../../src/features/context.ts";
import * as errors from "../../src/features/errors.ts";
import * as ownerFeature from "../../src/features/owner.ts";
import { createRoot, getOwner, type Owner, runWithOwner } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush } from "../../src/features/timing.ts";
import { effect, memo, onCleanup, signal, untrack } from "../../src/index.ts";
import { base, compile, gap } from "./harness.ts";

beforeEach(installFakeDocument);
afterEach(() => flush());

/** Solid's exports reactre lacks, to call in a gap's port: undefined until reactre has them. */
const missing = ownerFeature as unknown as {
  isDisposed?: (o: Owner) => boolean;
  getNextChildId?: (o: Owner) => string;
};
/** createRoot with Solid's options, which reactre's does not take. */
const createRootWith = createRoot as unknown as <T>(fn: (dispose: () => void) => T, options: { id: string }) => T;
/** An owner's id, as Solid's owners carry one. */
const idOf = (o: Owner | null): unknown => (o as unknown as { id?: string } | null)?.id;

describe("onCleanup.test.ts", () => {
  test("should be invoked when computation is disposed", () => {
    const disposeA = mock(),
      disposeB = mock(),
      disposeC = mock();
    const stopEffect = createRoot((dispose) => {
      reaction(
        () => {
          onCleanup(disposeA);
          onCleanup(disposeB);
          onCleanup(disposeC);
        },
        () => {},
      );
      return dispose;
    });
    flush();
    stopEffect();
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalled();
    expect(disposeC).toHaveBeenCalled();
  });

  test("should not trigger wrong onCleanup", () => {
    const dispose = mock();
    createRoot(() => {
      reaction(
        () => {
          onCleanup(dispose);
        },
        () => {},
      );
      const stopEffect = createRoot((dispose) => {
        reaction(
          () => {},
          () => {},
        );
        return dispose;
      });
      stopEffect();
      flush();
      expect(dispose).toHaveBeenCalledTimes(0);
    });
  });

  gap(
    "dispose-order",
    "reactre disposes an owner's children in creation order",
    "should clean up in reverse order",
    () => {
      const disposeParent = mock(),
        disposeA = mock(),
        disposeB = mock();
      let calls = 0;
      const stopEffect = createRoot((dispose) => {
        reaction(
          () => {
            onCleanup(() => disposeParent(++calls));
            reaction(
              () => {
                onCleanup(() => disposeA(++calls));
              },
              () => {},
            );
            reaction(
              () => {
                onCleanup(() => disposeB(++calls));
              },
              () => {},
            );
          },
          () => {},
        );
        return dispose;
      });
      flush();
      stopEffect();
      expect(disposeB).toHaveBeenCalled();
      expect(disposeA).toHaveBeenCalled();
      expect(disposeParent).toHaveBeenCalled();
      expect(disposeB).toHaveBeenCalledWith(1);
      expect(disposeA).toHaveBeenCalledWith(2);
      expect(disposeParent).toHaveBeenCalledWith(3);
    },
  );

  gap(
    "dispose-order",
    "reactre runs an owner's children and cleanups in creation order",
    "cleanup order is unwind: children before owner, later registrations before earlier",
    () => {
      const order: string[] = [];
      const dispose = createRoot((dispose) => {
        onCleanup(() => order.push("A"));
        onCleanup(() => order.push("B"));
        createRoot(() => onCleanup(() => order.push("C")));
        reaction(
          () => {},
          () => () => order.push("D"),
        );
        return dispose;
      });
      flush();
      dispose();
      expect(order).toEqual(["D", "C", "B", "A"]);
    },
  );

  gap(
    "dispose-order",
    "reactre disposes sibling roots and effects in creation order",
    "should dispose all roots",
    () => {
      const disposals: string[] = [];
      const dispose = createRoot((dispose) => {
        createRoot(() => {
          onCleanup(() => disposals.push("SUBTREE 1"));
          reaction(
            () => onCleanup(() => disposals.push("+A1")),
            () => {},
          );
          reaction(
            () => onCleanup(() => disposals.push("+B1")),
            () => {},
          );
          reaction(
            () => onCleanup(() => disposals.push("+C1")),
            () => {},
          );
        });
        createRoot(() => {
          onCleanup(() => disposals.push("SUBTREE 2"));
          reaction(
            () => onCleanup(() => disposals.push("+A2")),
            () => {},
          );
          reaction(
            () => onCleanup(() => disposals.push("+B2")),
            () => {},
          );
          reaction(
            () => onCleanup(() => disposals.push("+C2")),
            () => {},
          );
        });
        onCleanup(() => disposals.push("ROOT"));
        return dispose;
      });
      flush();
      dispose();
      expect(disposals).toEqual(["+C2", "+B2", "+A2", "SUBTREE 2", "+C1", "+B1", "+A1", "SUBTREE 1", "ROOT"]);
    },
  );
});

describe("createRoot.test.ts", () => {
  test("should dispose of inner computations", () => {
    let $x!: ReturnType<typeof signal<number>>;
    const m = mock(() => $x[0]() + 10);
    createRoot((dispose) => {
      $x = signal(10);
      memo(m);
      dispose();
    });
    expect(m).toHaveBeenCalledTimes(1);
    flush();
    $x[1](50);
    flush();
    expect(m).toHaveBeenCalledTimes(1);
  });

  test("should return result", () => {
    const result = createRoot((dispose) => {
      dispose();
      return 10;
    });
    expect(result).toBe(10);
  });

  test("should create new tracking scope", () => {
    const [$x, setX] = signal(0);
    const fx = mock();
    const stopEffect = createRoot((dispose) => {
      reaction(
        () => {
          $x();
          createRoot(() => void reaction($x, fx));
        },
        () => {},
      );
      return dispose;
    });
    flush();
    expect(fx).toHaveBeenCalledWith(0, undefined);
    expect(fx).toHaveBeenCalledTimes(1);
    stopEffect();
    setX(10);
    flush();
    expect(fx).not.toHaveBeenCalledWith(10, 0);
    expect(fx).toHaveBeenCalledTimes(1);
  });

  test("should not be reactive", () => {
    let $x!: ReturnType<typeof signal<number>>;
    const root = mock();
    createRoot(() => {
      $x = signal(0);
      $x[0]();
      root();
    });
    expect(root).toHaveBeenCalledTimes(1);
    $x[1](1);
    flush();
    expect(root).toHaveBeenCalledTimes(1);
  });

  test("should hold parent tracking", () => {
    // Solid reads `getOwner()._parent`; what it stands for is that the inner root goes with the outer.
    const gone = mock();
    let parent: Owner | null = null;
    const dispose = createRoot((dispose) => {
      parent = getOwner();
      createRoot(() => {
        expect(getOwner()).not.toBe(parent);
        onCleanup(gone);
      });
      return dispose;
    });
    expect(parent).not.toBeNull();
    dispose();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  test("should not throw if dispose called during active disposal process", () => {
    createRoot((dispose) => {
      onCleanup(() => dispose());
      dispose();
    });
  });

  test("should not generate ids if no id is provided", () => {
    let o: Owner | null = null,
      m: Owner | null = null;
    createRoot(() => {
      o = getOwner();
      const c = memo(() => {
        m = getOwner();
      });
      c();
    });
    expect(idOf(o)).toEqual(undefined);
    expect(idOf(m)).toEqual(undefined);
  });

  gap("owner-ids", "reactre has no getNextChildId", "should generate ids if id is provided", () => {
    let o: Owner | null = null,
      m: Owner | null = null,
      m2: Owner | null = null,
      r: Owner | null = null;
    let c = "",
      c2 = "",
      c3 = "";
    createRootWith(
      () => {
        o = getOwner();
        const outer = memo(() => {
          m = getOwner()!;
          c = missing.getNextChildId!(m);
          return memo(() => {
            m2 = getOwner()!;
            c2 = missing.getNextChildId!(m2);
            c3 = missing.getNextChildId!(m2);
          });
        });
        reaction(
          () => {
            r = getOwner();
            outer()();
          },
          () => {},
        );
      },
      { id: "" },
    );
    expect(idOf(o)).toEqual("");
    expect(idOf(m)).toEqual("0");
    expect(c).toEqual("00");
    expect(idOf(m2)).toEqual("01");
    expect(idOf(r)).toEqual("1");
    expect(c2).toEqual("010");
    expect(c3).toEqual("011");
  });

  gap("owner-ids", "reactre's owners have no id", "should reset child ids when computations rerun", () => {
    const [$x, setX] = signal(0);
    const ids: string[][] = [];
    createRootWith(
      () => {
        memo(() => {
          $x();
          const run: string[] = [];
          run.push(memo(() => idOf(getOwner()) as string)());
          run.push(memo(() => idOf(getOwner()) as string)());
          ids.push(run);
        });
      },
      { id: "" },
    );
    expect(ids).toHaveLength(1);
    expect(ids[0]).toEqual(["00", "01"]);
    setX(1);
    flush();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toEqual(["00", "01"]);
  });
});

describe("getOwner.test.ts", () => {
  test("should return current owner", () => {
    createRoot(() => {
      const owner = getOwner();
      expect(owner).toBeDefined();
      expect(owner).not.toBeNull();
      reaction(
        () => {
          expect(getOwner()).toBeDefined();
          expect(getOwner()).not.toBe(owner);
        },
        () => {},
      );
    });
  });

  test("should return parent scope from inside untrack", () => {
    createRoot(() => {
      untrack(() => {
        expect(getOwner()).toBeDefined();
        expect(getOwner()).not.toBeNull();
      });
    });
  });
});

describe("runWithOwner.test.ts", () => {
  test("should scope function to current scope", () => {
    // Solid stores `_context` on the owner and reads it back; the port asserts the owner itself.
    let owner!: Owner | null;
    createRoot(() => {
      owner = getOwner();
    });
    runWithOwner(owner, () => {
      expect(getOwner()).toBe(owner);
    });
  });

  test("should return value", () => {
    expect(runWithOwner(null, () => 100)).toBe(100);
  });

  test("should handle errors", () => {
    // createErrorBoundary is <Errored> in reactre; the effect made later under an owner from
    // inside it throws to it.
    const error = new Error();
    const handler = mock();
    const root = new FakeElement("DIV");
    const api = compile<{ owner: () => Owner | null }>(
      `
      import { render } from "@reactre/core";
      import { Errored } from "@reactre/core/features/errors";
      import { getOwner } from "@reactre/core/features/owner";
      let owner = null;
      render(() => (
        <div>
          <Errored fallback={(err) => (handler(err), <b>caught</b>)}>
            {() => ((owner = getOwner()), <i>ok</i>)}
          </Errored>
        </div>
      ), root);
      return { owner: () => owner };
      `,
      { ...base, "@reactre/core/features/context": context, "@reactre/core/features/errors": errors },
      { root, handler },
    );
    runWithOwner(api.owner(), () => {
      effect(() => {
        throw error;
      });
    });
    flush();
    expect(handler).toHaveBeenCalledWith(error);
    expect(root.textContent).toBe("caught");
  });
});

describe("cleanup-throw-continues.test.ts", () => {
  gap(
    "dispose-order",
    "every cleanup runs and the first error is rethrown, but in creation order (and there is no isDisposed)",
    "runs every cleanup in the tree and rethrows the first error after",
    () => {
      const log: string[] = [];
      let inner!: Owner, sibling!: Owner;
      const dispose = createRoot((dispose) => {
        onCleanup(() => log.push("root"));
        createRoot(() => {
          inner = getOwner()!;
          onCleanup(() => log.push("inner first"));
          reaction(
            () => 1,
            () => () => log.push("effect cleanup"),
          );
          onCleanup(() => {
            throw new Error("first error");
          });
          onCleanup(() => log.push("inner last"));
        });
        createRoot(() => {
          sibling = getOwner()!;
          onCleanup(() => {
            throw new Error("second error");
          });
          onCleanup(() => log.push("sibling"));
        });
        return dispose;
      });
      flush();
      expect(dispose).toThrow("second error");
      expect(log).toEqual(["sibling", "effect cleanup", "inner last", "inner first", "root"]);
      expect(missing.isDisposed!(inner)).toBe(true);
      expect(missing.isDisposed!(sibling)).toBe(true);
    },
  );

  test("rethrows once: a later teardown does not see the error again", () => {
    const first = createRoot((dispose) => {
      onCleanup(() => {
        throw new Error("boom");
      });
      return dispose;
    });
    const second = createRoot((dispose) => {
      onCleanup(() => {});
      return dispose;
    });
    expect(first).toThrow("boom");
    expect(second).not.toThrow();
    expect(() => flush()).not.toThrow();
  });

  test("a throwing effect cleanup does not stop the owner's own cleanups", () => {
    const log: string[] = [];
    const dispose = createRoot((dispose) => {
      onCleanup(() => log.push("owner"));
      reaction(
        () => 1,
        () => () => {
          throw new Error("boom");
        },
      );
      return dispose;
    });
    flush();
    expect(dispose).toThrow("boom");
    expect(log).toEqual(["owner"]);
  });
});
