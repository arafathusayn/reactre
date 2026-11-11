// A module of server actions, for ../compiler.test.ts's run cases (M472): a task's run that calls
// `createPost` calls a server action, which takes no signal. The compiler reads the directive.
"use server";

/** Saves the text on the server. */
export async function createPost(text: string): Promise<string> {
  return text;
}
