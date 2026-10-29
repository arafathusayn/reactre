// React APIs preact/compat 11.1.0 does not have. Both runtimes get these same stubs, so a scenario
// that uses one throws the same error on both sides.
const missing = (name: string) => () => {
  throw new Error(`preact/compat has no ${name}`);
};
export const Activity = missing("Activity");
export const useActionState = missing("useActionState");
export const useOptimistic = missing("useOptimistic");
export const useFormStatus = missing("useFormStatus");
