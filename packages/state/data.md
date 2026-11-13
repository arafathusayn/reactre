# External JSON data

State and event contracts still list required workflow fields. A named field can
now hold a plain JSON object with optional properties and string-keyed records:

```ts
interface Catalog {
  title?: string;
  entries: Record<string, { label: string; tags?: string[] }>;
}

const catalog = setup({
  states: { ready: types<{ value: Catalog }>(), closed: types<{}>() },
  events: { replace: types<{ value: Catalog }>(), close: types<{}>() },
});
```

`value` is required. Within it, an absent `title` remains absent, an empty string
remains an empty string, and `null` is a value only if declared in the type.
Explicit `undefined` is not JSON. Enable `exactOptionalPropertyTypes` to distinguish
an absent property from a present undefined property, and `noUncheckedIndexedAccess`
to check whether a dynamic record has a key. Records' values are checked recursively;
`Record<string, unknown>` is not a way around contracts. Arrays and nested objects
were already supported. Map/Set, tuples, bigint, symbols, methods and resources
remain unsupported contracts. Normalize collections to arrays or string-keyed records.

## An immutable SDK boundary

An SDK can retain and mutate its objects after returning them. Accept a fresh
immutable projection at that boundary, outside pure transition handlers:

```ts
import { immutableData } from "@reactre/state/data";

const value = immutableData<Catalog>(sdkCatalog);
actor.send({ type: "replace", value });
```

`immutableData` validates plain JSON data, copies it, and freezes every object and
array in all builds. Its output is deeply readonly and remains a normal structural
contract. Mutating `sdkCatalog` later cannot change the actor's payload. Shared
subobjects within one input retain their identity within the copy; cycles fail.
No global cache retains SDK values. Copy once when data arrives; subsequent
transitions can share that immutable payload. Existing machines pay no runtime cost.

The boundary rejects non-finite numbers, undefined, symbols, callbacks, class
instances (including Map/Set/Date), accessors, non-enumerable properties, sparse or
decorated arrays, and cycles. It never invokes an input getter. Null-prototype
records become ordinary objects; own `__proto__` keys remain data, without changing
the output's prototype. TypeScript is structural and cannot distinguish a data-only
class from a plain object; this runtime validation does. Proxies are not a supported
input boundary: JavaScript reflection can execute their traps.

## Serialization and restoration

JSON.stringify uses normal JSON semantics; there is no tag, hidden brand or custom
codec to restore. JSON does not preserve object identity, freezing, prototypes or
negative zero. A round trip preserves the supported data values and absent optional
properties. The existing persist/version/shape checks continue to apply.

This helper validates JSON representability, not the application's schema. Validate
unknown network or stored input with the existing Standard Schema/validate APIs
before copying it. For production restoration requiring a frozen payload, have the
state schema return a payload copied with `immutableData`, just as the SDK boundary
does. Existing snapshots remain readonly by type, with deep freezing in development;
this change does not add copying or freezing to every production actor transition.

## Design choice and migration

Nested structural JSON is the smallest extension that preserves required workflow
fields, existing compiler purity checks and the snapshot format. A separate branded
arbitrary-object payload would need its own serialization and hydration protocol;
it could also hide mutable SDK objects from contracts. The explicit immutable-copy
function supplies the boundary without creating such an escape hatch.

Replace encoded string fields with required named payloads and remove their decode
memos for JSON-compatible SDK data. Retain downstream codecs/projections for SDK
error classes, bigint and Map/Set until they have been normalized explicitly.
Callbacks, DOM nodes, transports, timers and controllers stay outside snapshots.
If a persisted machine changes from a string to a payload, bump its version and
provide a migration; updating the contract does not migrate old storage itself.

See `apps/profiling/state-data.ts` for a controlled comparison with the tagged
encode/decode/freeze approach, including retained-heap observations. It isolates the
data boundary, so its results are not application latency or cross-framework rankings.
