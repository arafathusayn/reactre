// A module of async work, for ../compiler.test.ts's run cases (M80): a task's run that calls
// `store` as a statement of its own starts a promise it doesn't wait for, which the compiler reads
// here. `label` returns no promise.

/** Writes the text somewhere: a promise. */
export async function store(text: string): Promise<string> {
  return text;
}

/** No promise. */
export function label(text: string): string {
  return `#${text}`;
}
