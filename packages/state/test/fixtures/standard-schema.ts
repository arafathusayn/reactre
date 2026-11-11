// Standard Schema v1 objects written by hand (https://standardschema.dev): the spec is designed to
// be copied, so the tests need no zod or valibot. Each helper is a schema a library would build.

/** The Standard Schema v1 interface, copied from the spec. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type Result<Output> =
  { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly Issue[] };

export interface Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

function schema<Input, Output>(validate: (value: unknown) => Result<Output>): StandardSchemaV1<Input, Output> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

export const string = (): StandardSchemaV1<string> =>
  schema((value) => (typeof value === "string" ? { value } : { issues: [{ message: "expected a string" }] }));

export const number = (): StandardSchemaV1<number> =>
  schema((value) => (typeof value === "number" ? { value } : { issues: [{ message: "expected a number" }] }));

/** A string, trimmed: a schema whose output differs from its input. */
export const trimmed = (): StandardSchemaV1<string> =>
  schema((value) =>
    typeof value === "string" ? { value: value.trim() } : { issues: [{ message: "expected a string" }] },
  );

type Shape = { readonly [key: string]: StandardSchemaV1 };
type Out<S extends Shape> = { -readonly [K in keyof S]: S[K] extends StandardSchemaV1<unknown, infer O> ? O : never };

/** An object of fields: unknown keys are stripped, as zod's `object` does. Issues carry their path. */
export function object<const S extends Shape>(fields: S): StandardSchemaV1<Out<S>> {
  return schema((value) => {
    if (typeof value !== "object" || value === null) return { issues: [{ message: "expected an object" }] };
    const out: { [key: string]: unknown } = {};
    const issues: Issue[] = [];
    for (const [key, field] of Object.entries(fields)) {
      const result = field["~standard"].validate((value as { [key: string]: unknown })[key]);
      if (result instanceof Promise) throw new Error("object() takes synchronous fields");
      if (result.issues === undefined) out[key] = result.value;
      else for (const issue of result.issues) issues.push({ ...issue, path: [{ key }, ...(issue.path ?? [])] });
    }
    // The fields' values make up Out<S>: each one went through its schema.
    return issues.length > 0 ? { issues } : { value: out as Out<S> };
  });
}

/** A schema that answers with a Promise, as one with an async refinement does. */
export const later = (): StandardSchemaV1<string> => ({
  "~standard": { version: 1, vendor: "test", validate: async (value) => ({ value: String(value) }) },
});
