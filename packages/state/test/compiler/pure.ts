// A module marked pure, for ../compiler.test.ts: a transition may call its functions, and the
// compiler holds each of them to a transition's rules when it compiles this file.
"use pure";

/** A person's name as a label. */
export function label(by: string): string {
  return trimmed(by).toUpperCase();
}

const trimmed = (text: string): string => text.trim();
