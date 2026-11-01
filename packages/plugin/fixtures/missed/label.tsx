// A component whose callers the program reads may all pass `text` as a literal: then its hole is
// written once. Its one reactive caller, ./hidden/caller.tsx, is reached in ways the program read
// before the build may not see (test/missed.test.ts).

export function Label(props: { text: string | number }) {
  return <b class="label">{props.text}</b>;
}
