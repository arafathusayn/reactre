// Compile-time data contracts: the workflow stays exact; its named payload may be structural.
import { type DeepReadonly, type NotJsonPath, setup, types } from "@reactre/state";
import { immutableData } from "@reactre/state/data";

export interface Catalog {
  title?: string;
  entries: Record<string, { label: string; tags?: string[] }>;
}

export function contracts(source: Catalog) {
  const value = immutableData(source);
  setup({ states: { ready: types<{ value: Catalog }>() }, events: { replace: types<{ value: Catalog }>() } });
  // @ts-expect-error workflow fields remain mandatory
  setup({ states: { ready: types<{ value?: Catalog }>() }, events: {} });
  // @ts-expect-error event payloads must name their fields
  setup({ states: { ready: types<{}>() }, events: { replace: types<Record<string, string>>() } });
  // @ts-expect-error explicit undefined is not JSON, even in an optional property
  setup({ states: { ready: types<{ value: { title?: string | undefined } }>() }, events: {} });
  // @ts-expect-error a dynamic record's values remain checked
  setup({ states: { ready: types<{ value: Record<string, () => void> }>() }, events: {} });
  // @ts-expect-error optional callbacks remain forbidden
  setup({ states: { ready: types<{ value: { done?: () => void } }>() }, events: {} });
  // @ts-expect-error dynamic records do not admit unknown data
  setup({ states: { ready: types<{ value: Record<string, unknown> }>() }, events: {} });
  // @ts-expect-error numeric index signatures cannot bypass checks of their values
  setup({ states: { ready: types<{ value: Record<number, () => void> }>() }, events: {} });
  // @ts-expect-error readonly through optional arrays and records
  value.entries["first"]!.tags?.push("changed");
  // @ts-expect-error readonly record
  value.entries["first"] = { label: "changed" };
  // @ts-expect-error resource collections require a projection
  immutableData(new Map<string, string>());
  // @ts-expect-error not plain JSON
  immutableData({ node: document.body });
  // @ts-expect-error optional undefined must be omitted
  immutableData<{ title?: string }>({ title: undefined });
  return value;
}

// Structural data stays recursively readonly and compatible with its original contract.
export type ReadonlyCatalog = DeepReadonly<Catalog>;
export const accepted: [NotJsonPath<Catalog, "payload", false>] extends [never] ? true : false = true;
