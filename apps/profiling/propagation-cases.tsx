/** @jsxImportSource @reactre/core */
import { attach, batch, effect, For, memo, onCleanup, signal } from "@reactre/core";
import { createRoot } from "@reactre/core/features/owner";
import { createActor } from "@reactre/state";
import { select } from "@reactre/state/utils/select";

import { type Payload, propagationMachine } from "./propagation.machine.ts";

export const modes = [
  "signal",
  "actor",
  "subscribers",
  "bridge",
  "memo",
  "selection",
  "selected-bridge",
  "payload-bridge",
] as const;
export const workloads = ["unchanged", "equal", "changed", "burst", "reentrant"] as const;
type Mode = (typeof modes)[number];
type Workload = (typeof workloads)[number];

function inputs(workload: Workload, count: number): Payload[] {
  return Array.from({ length: count }, (_, i) => ({
    value: workload === "unchanged" || workload === "equal" ? 0 : i + 1,
    revision: workload === "equal" ? 0 : i + 1,
  }));
}

// Inputs and events are prepared outside the measured dispatch loop. Every actor accepts every
// transition; selecting a value only changes the downstream reactive work.
export function exercise(mode: Mode, workload: Workload, count: number, consumers = 16) {
  const payloads = inputs(workload, count);
  const events = payloads.map((payload) => ({ type: "replace" as const, payload }));
  let notifications = 0,
    recomputations = 0,
    deliveries = 0,
    checksum = 0;
  const begin = performance.now();
  const fixture = createRoot((dispose) => {
    const actor = mode === "signal" ? undefined : createActor(propagationMachine);
    const [read, write] = signal<Readonly<Payload>>({ value: 0, revision: 0 });
    const [snapshot, setSnapshot] = signal(actor?.snapshot());
    const bridged = () => snapshot()!.data.payload;
    const cleanups: (() => void)[] = [];
    if (actor && ["bridge", "memo"].includes(mode))
      cleanups.push(
        actor.subscribe((s) => {
          notifications++;
          setSnapshot(() => s);
        }),
      );
    if (mode === "subscribers")
      for (let i = 0; i < consumers; i++)
        cleanups.push(
          actor!.subscribe((s) => {
            notifications++;
            checksum += s.data.payload.value;
          }),
        );
    if (mode === "bridge")
      for (let i = 0; i < consumers; i++)
        effect(() => {
          recomputations++;
          checksum += bridged().value;
        });
    if (mode === "memo")
      for (let i = 0; i < consumers; i++) {
        const value = memo(() => {
          recomputations++;
          return bridged().value;
        });
        effect(() => {
          deliveries++;
          checksum += value();
        });
      }
    if (mode === "selection" || mode === "selected-bridge")
      for (let i = 0; i < consumers; i++) {
        const selection = select(actor!, (s) => {
          recomputations++;
          return s.data.payload.value;
        });
        if (mode === "selection")
          cleanups.push(
            selection.subscribe((value) => {
              notifications++;
              checksum += value;
            }),
          );
        else {
          const [value, setValue] = signal({ value: selection.get() });
          cleanups.push(
            selection.subscribe((next) => {
              notifications++;
              setValue({ value: next });
            }),
          );
          effect(() => {
            deliveries++;
            checksum += value().value;
          });
        }
      }
    if (mode === "payload-bridge") {
      const selection = select(actor!, (s) => {
        recomputations++;
        return s.data.payload;
      });
      const [value, setValue] = signal({ value: selection.get() });
      cleanups.push(
        selection.subscribe((next) => {
          notifications++;
          setValue({ value: next });
        }),
      );
      for (let i = 0; i < consumers; i++)
        effect(() => {
          deliveries++;
          checksum += value().value.value;
        });
    }
    // A separate counter makes the extra reentrant transition observable on every actor mode.
    // The signal control performs the same second write synchronously, with no actor contract.
    if (actor && workload === "reentrant")
      cleanups.push(
        actor.subscribe((s) => {
          if (s.data.payload.revision > 0) {
            notifications++;
            actor.send({ type: "replace", payload: { value: s.data.payload.value, revision: -1 } });
          }
        }),
      );
    onCleanup(() => {
      for (const off of cleanups) off();
      actor?.stop();
    });
    return {
      dispose,
      run() {
        for (let i = 0; i < count; i++) {
          if (actor) actor.send(events[i]!);
          else {
            write(payloads[i]!);
            if (workload === "reentrant") write({ value: payloads[i]!.value, revision: -1 });
          }
        }
      },
      final: () => actor?.snapshot().data.payload ?? read(),
    };
  });
  const setupMs = performance.now() - begin;
  const initialCounts = { notifications, recomputations, deliveries };
  const start = performance.now();
  if (workload === "burst") batch(fixture.run);
  else fixture.run();
  const dispatchMs = performance.now() - start;
  const final = fixture.final();
  const expected = payloads.at(-1)!;
  if (final.value !== expected.value || final.revision !== (workload === "reentrant" ? -1 : expected.revision))
    throw new Error(`incorrect final payload: ${mode}/${workload}`);
  const stop = performance.now();
  fixture.dispose();
  return {
    setupMs,
    dispatchMs,
    disposalMs: performance.now() - stop,
    notifications: notifications - initialCounts.notifications,
    recomputations: recomputations - initialCounts.recomputations,
    deliveries: deliveries - initialCounts.deliveries,
    checksum,
    final,
  };
}

const rows = Array.from({ length: 200 }, (_, id) => ({ id }));
// Identical compiled DOM; only the source feeding the accessor differs. Each row selects the
// displayed scalar. A fresh object carrying the same scalar is still accepted by the actor.
export function dom(mode: "signal" | "bridge" | "memo" | "selected-bridge", workload: Workload, count: number) {
  const payloads = inputs(workload, count);
  const container = document.createElement("div");
  document.body.append(container);
  let send!: (payload: Payload) => void;
  let recomputations = 0,
    notifications = 0,
    cleaned = 0;
  const start = performance.now();
  const dispose = attach(() => {
    const actor = mode === "signal" ? undefined : createActor(propagationMachine);
    const [read, write] = signal<Readonly<Payload>>({ value: 0, revision: 0 });
    const [snapshot, setSnapshot] = signal(actor?.snapshot());
    const source = actor ? () => snapshot()!.data.payload : read;
    send = actor
      ? (payload) => {
          actor.send({ type: "replace", payload });
        }
      : (payload) => {
          write(payload);
        };
    if (actor && mode !== "selected-bridge")
      onCleanup(
        actor.subscribe((s) => {
          notifications++;
          setSnapshot(() => s);
        }),
      );
    onCleanup(() => {
      actor?.stop();
      cleaned++;
    });
    function Row(props: { id: number }) {
      let value: () => number;
      if (mode === "selected-bridge") {
        const selection = select(actor!, (s) => {
          recomputations++;
          return s.data.payload.value;
        });
        const [get, set] = signal({ value: selection.get() });
        onCleanup(
          selection.subscribe((next) => {
            notifications++;
            set({ value: next });
          }),
        );
        value = () => get().value;
      } else if (mode === "memo")
        value = memo(() => {
          recomputations++;
          return source().value;
        });
      else
        value = () => {
          recomputations++;
          return source().value;
        };
      return (
        <li data-id={props.id}>
          <span>{value()}</span>
        </li>
      );
    }
    return (
      <ul>
        <For each={rows} key={(row) => row.id}>
          {(row) => <Row id={row.id} />}
        </For>
      </ul>
    );
  }, container);
  const mountMs = performance.now() - start;
  const nodes = [...container.querySelectorAll("li")];
  const before = { recomputations, notifications };
  const update = () => {
    for (const payload of payloads) send(payload);
  };
  const begin = performance.now();
  if (workload === "burst") batch(update);
  else update();
  const updateMs = performance.now() - begin;
  const expected = String(payloads.at(-1)!.value);
  if (
    nodes.length !== 200 ||
    nodes.some((n, i) => n !== container.querySelectorAll("li")[i] || n.textContent !== expected)
  )
    throw new Error("incorrect DOM or lost keyed identity");
  const stop = performance.now();
  dispose();
  const disposalMs = performance.now() - stop;
  if (container.textContent || cleaned !== 1) throw new Error("incorrect disposal");
  send({ value: -100, revision: -100 });
  if (container.textContent) throw new Error("post-disposal update");
  container.remove();
  return {
    mountMs,
    updateMs,
    disposalMs,
    recomputations: recomputations - before.recomputations,
    notifications: notifications - before.notifications,
  };
}
