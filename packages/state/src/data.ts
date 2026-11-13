// An explicit boundary for mutable SDK data. No actor/runtime changes and no global cache:
// copy only when accepting new data, then share the immutable projection between snapshots.
import type { DeepReadonly, NotJsonPath } from "./index.ts";

type Checked<T> = [NotJsonPath<T, "data", false>] extends [never]
  ? unknown
  : { readonly "immutableData requires plain JSON data": NotJsonPath<T, "data", false> };

/**
 * Validate, copy and deeply freeze typed JSON data before giving it to an actor. Optional
 * properties may be absent, never explicitly undefined (use exactOptionalPropertyTypes).
 * Records use string keys; Map/Set and resource/class instances need an explicit projection.
 * This is not a schema validator: validate unknown network/persisted input with a schema first.
 */
export function immutableData<T extends object>(value: T & Checked<T>): DeepReadonly<T> {
  // copy checks every own data property and preserves its value/type. The assertion connects
  // that checked recursive traversal to T; it does not admit unvalidated values into a contract.
  return copy(value, "data", new Map(), new Set()) as DeepReadonly<T>;
}

function invalid(path: string, reason: string): never {
  throw new TypeError(`immutableData: ${path} ${reason}; use plain JSON data`);
}

function copy(value: unknown, path: string, copies: Map<object, object>, active: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid(path, "is not finite");
  if (typeof value !== "object") return invalid(path, `is ${typeof value}`);
  const array = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    return invalid(path, "is a class or resource");
  if (active.has(value)) return invalid(path, "contains a cycle");
  const previous = copies.get(value);
  if (previous !== undefined) return previous;
  const out: object = array ? [] : {};
  copies.set(value, out);
  active.add(value);
  const keys = Reflect.ownKeys(value);
  // Holes serialize as null, which changes their meaning. Extra array properties are lost.
  if (array && keys.length !== value.length + 1) return invalid(path, "is a sparse or decorated array");
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return invalid(path, "has a symbol key");
    if (
      array &&
      (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= value.length || String(Number(key)) !== key)
    )
      return invalid(path, "has a non-index array property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor))
      return invalid(`${path}.${key}`, "is not an enumerable data property");
    Object.defineProperty(out, key, {
      value: copy(descriptor.value, `${path}.${key}`, copies, active),
      enumerable: true,
    });
  }
  active.delete(value);
  return Object.freeze(out);
}
