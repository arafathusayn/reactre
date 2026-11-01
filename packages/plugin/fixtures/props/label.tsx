// Exported, but every call site in the program passes `text` as a literal: its hole is written once.

export function Label(props: { text: string }) {
  return <b class="label">{props.text}</b>;
}
