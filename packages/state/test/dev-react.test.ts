// The development build's React entry: with `dev` on, an app's `@reactre/state/react` import becomes
// `@reactre/state/react/dev` (whose hooks warn, M313–M316); a production build keeps the plain entry,
// so it ships none of the warnings. The rewrite is a source edit on the import's own literal, found
// by parsing, so a comment or a string that spells the specifier is left alone.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import esbuildPlugin from "@reactre/state/plugin/esbuild";
import { build } from "esbuild";

import { compile, StateCompileError } from "../compiler/index.ts";
import { devReact } from "../plugin/dev-react.ts";

const REACT = `import { useActor, useActorRef, useSelector } from "@reactre/state/react";

export function Door(): null {
  const [s, ref] = useActor({ v: 0, e: {}, i: () => ({ state: "a", data: {}, version: 0 }), o: { a: {} } });
  const n = useSelector(ref, (x) => x.state);
  return null;
}
`;

describe("devReact", () => {
  test("rewrites the React import's literal, and leaves a comment or a string alone", () => {
    const source = `// import { useActor } from "@reactre/state/react";\nconst s = "@reactre/state/react";\n${REACT}`;
    const out = devReact("door.tsx", source);
    expect(out).not.toBeNull();
    expect(out).toContain('from "@reactre/state/react/dev"');
    // The comment and the string are untouched.
    expect(out).toContain('// import { useActor } from "@reactre/state/react";');
    expect(out).toContain('const s = "@reactre/state/react";');
    // The import line is the dev one; the comment and the string keep the plain spelling.
    expect(out).toContain('import { useActor, useActorRef, useSelector } from "@reactre/state/react/dev";');
    expect(out).not.toContain('useSelector } from "@reactre/state/react";');
  });

  test("two React imports are both rewritten (the sort runs)", () => {
    const source = `import { useActor } from "@reactre/state/react";\nimport { useSelector } from "@reactre/state/react";\n`;
    const out = devReact("hooks.ts", source);
    expect(out).not.toBeNull();
    expect(out?.match(/@reactre\/state\/react\/dev/g)).toHaveLength(2);
  });

  test("a file with no React import is left alone", () => {
    expect(devReact("door.ts", `import { createActor } from "@reactre/state";\n`)).toBeNull();
  });

  test("a React-only file with no machine is rewritten (the compiler returns null for it)", () => {
    const source = `import { useActorRef } from "@reactre/state/react";\nexport const use = useActorRef;\n`;
    expect(devReact("hooks.ts", source)).toContain('from "@reactre/state/react/dev"');
  });
});

describe("the compiler", () => {
  test("the dev entry's hooks are use sites, as the plain entry's are", () => {
    // A send in a component's body is M593, whichever entry the hook comes from.
    const source = `import { useActor } from "@reactre/state/react/dev";
import { doorMachine } from "./door.ts";
export function Door(): null {
  const [s, ref] = useActor(doorMachine);
  if (s.state === "closed") ref.send({ type: "push", by: "ann" });
  return null;
}
`;
    let problems: string[] = [];
    try {
      compile("door.tsx", source);
    } catch (e) {
      if (e instanceof StateCompileError) problems = e.problems.map((p) => p.message);
      else throw e;
    }
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("in a component's body sends on every render");
  });

  // The dev entry's hooks refuse `any` as the plain entry's do: the compiler defers to the type
  // layer (NotAny), so it reports no cast of its own (REFUSES_ANY lists the dev entry).
  const anyCast = (entry: string, hook: string): string[] => {
    const source = `import { ${hook} } from "${entry}";
import { doorMachine } from "./door.ts";
export function Door(): null {
  ${hook}(doorMachine as any);
  return null;
}
`;
    try {
      compile("door.tsx", source);
    } catch (e) {
      if (e instanceof StateCompileError) return e.problems.map((p) => p.message);
      throw e;
    }
    return [];
  };

  test("the dev entry's useActor and useActorRef refuse any, as the plain entry's do", () => {
    for (const hook of ["useActor", "useActorRef"]) {
      // The plain entry: the type layer's to report, so the compiler says nothing.
      expect(anyCast("@reactre/state/react", hook)).toEqual([]);
      // The dev entry: the same, not the generic cast message.
      expect(anyCast("@reactre/state/react/dev", hook)).toEqual([]);
    }
  });
});

describe("the plugin", () => {
  // Inside the package, so `@reactre/state/react/dev` resolves as an app's would.
  const dir = join(import.meta.dir, "dev-react-out");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const build1 = async (dev: boolean): Promise<string> => {
    const entry = join(dir, `app-${dev}.ts`);
    writeFileSync(entry, REACT);
    const r = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
      conditions: ["reactre-source", "module"],
      plugins: [esbuildPlugin({ dev })],
    });
    return r.outputFiles[0]?.text ?? "";
  };

  // Each warning's text, as the dev entry writes it: none may be in a production bundle.
  const WARNINGS = [
    "a different machine was passed on a later render",
    "the input changed on a later render",
    "the selector returns a new object on each notification",
    "Strict Mode's second mount replaced the actor",
  ];

  test("dev: the bundle has the warnings; production: none of them", async () => {
    try {
      const dev = await build1(true);
      for (const w of WARNINGS) expect(dev).toContain(w);
      const prod = await build1(false);
      for (const w of WARNINGS) expect(prod).not.toContain(w);
      // The dev entry's own module is absent, not just its strings.
      expect(prod).not.toContain("@reactre/state/react/dev");
      // Production is smaller: the warnings' bytes are gone.
      expect(prod.length).toBeLessThan(dev.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
