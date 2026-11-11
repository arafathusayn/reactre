// @reactre/state/plugin/dev-react: the development build's React entry. With `dev` on, an app's
// `@reactre/state/react` import becomes `@reactre/state/react/dev`, whose hooks warn (M313–M316);
// a production build keeps the plain entry, so it ships none of the warnings.
//
// The rewrite is a source edit on the import's own string literal, found by parsing: a comment or a
// string that spells the specifier is left alone. It runs before the compiler, so the compiler's
// checks see the dev entry (its `useActor` and `useActorRef` are the same use sites). A file with
// only React imports and no machine is rewritten too: the compiler returns null for it, and the
// rewrite is what the plugin returns.

import { parseSync } from "oxc-parser";

const REACT = "@reactre/state/react";
const DEV = "@reactre/state/react/dev";

/** `source` with each `@reactre/state/react` import rewritten to the dev entry, or null when none is. */
export function devReact(file: string, source: string): string | null {
  if (!source.includes(REACT)) return null;
  const lang = file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : /\.[cm]?js$/.test(file) ? "js" : "ts";
  const parsed = parseSync(file, source, { lang, sourceType: "module", preserveParens: false });
  if (parsed.errors.length > 0) return null;
  const edits: { readonly start: number; readonly end: number }[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== REACT) continue;
    // The literal's own range, quotes included: `"@reactre/state/react"` -> `"@reactre/state/react/dev"`.
    edits.push({ start: statement.source.start, end: statement.source.end });
  }
  if (edits.length === 0) return null;
  let out = "";
  let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    out += source.slice(at, e.start) + JSON.stringify(DEV);
    at = e.end;
  }
  return out + source.slice(at);
}
