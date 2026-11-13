// children's compiler cases: purity in a child's handlers. Collected by ../compiler.ts into
// test/compiler.test.ts.

import { type Case, change, PAGE } from "../../sources.ts";

/** PAGE with effects in use, and `cancel`, which leaves busy (its job's node). */
export const CANCELS = change(
  change(
    change(PAGE, "use: [children],", "use: [children, effects],"),
    'import { children } from "@reactre/state/children";\n',
    'import { children } from "@reactre/state/children";\nimport { effects } from "@reactre/state/effects";\n',
  ),
  "events: { go: types<{}>() },",
  "events: { go: types<{}>(), cancel: types<{}>() },",
);

export const cases: Case[] = [
  [
    "M533: a send to a child in the step that stops it",
    change(
      CANCELS,
      "    busy: {\n",
      '    busy: {\n      on: { cancel: ({ enq, to }) => (enq.sendTo("job", { type: "finish", url: "" }), to("idle")) },\n',
    ),
    25,
    'sendTo("job") as "job" stops: send it before leaving, or in the child\'s own exit',
  ],
  [
    "M533: a send to a child in its node's exit",
    change(
      CANCELS,
      "    busy: {\n",
      '    busy: {\n      exit: ({ enq }) => enq.sendTo("job", { type: "finish", url: "" }),\n',
    ),
    25,
    'sendTo("job") as "job" stops',
  ],
  [
    "a cast in a child's done",
    change(PAGE, "{ url: output.data.url }", "{ url: output.data.url as string }"),
    27,
    "a cast in a transition hides a broken contract",
  ],
  [
    "a global in a child's each",
    change(PAGE, "data.files.map((f) =>", "(console.log(1), data.files).map((f) =>"),
    26,
    "console is a global a transition may not read",
  ],
];
