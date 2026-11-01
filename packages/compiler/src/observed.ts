// @reactre/core/features/memo's `lazy` and `unobserved`, at their call sites: a call of `memo` or
// `signal` from that module that passes either option goes to the module's reader-counting entry
// (`__observedMemo`, `__observedSignal`), and every other call stays as it is.
//
// Both options need a count of a signal's readers, which only the reader-counting entry keeps;
// `memo` and `signal` keep none, so an app that never passes them ships the code it shipped
// before they existed, byte for byte. The compiler is what tells the two apart, by the options
// each call passes:
//
//   - An object literal is read: a `lazy` or `unobserved` key (`unobserved` alone for `signal`)
//     sends the call to the reader-counting entry; an object of other keys (`{ equals }`), no
//     options, or `undefined` leaves it as it is.
//   - Options it cannot read (a variable, a call, a spread, a computed key) may hold either
//     option, so the call goes to the reader-counting entry, which is right for any options.
//   - A use it cannot follow to a call (`memo` passed as a value, kept in a variable, exported,
//     re-exported by name) is the reader-counting entry too, for the same reason.
//
// It is a function of the file's text alone, so a dev server, which compiles each file alone, and
// a production build, which reads the whole program, give the same code. A file that does not
// import the module is left as it is.
//
// Design decisions:
//   - The imports are read by name: `memo` and `signal` under any local name (`memo as m`), and a
//     namespace import's members (`M.memo`). A local name the file binds again (a parameter, a
//     `const`, a function or class, a `catch` binding) is not the import where that binding is
//     in scope, so its calls there are left alone.
//   - The rewrite only renames: a call's callee, or a use, becomes the entry's local name (one
//     import the rewrite adds, `__rrObsMemo` and `__rrObsSignal`), and a namespace member
//     `M.__observedMemo`. Each edit is kept, so a source map of the output maps back through it
//     (`back`).
//   - What it cannot reach: a namespace object used as a value (`const { memo } = M`), `export *`
//     of the module, and code the compiler does not compile (a .ts file, a dependency). Those
//     calls reach `memo` and `signal` themselves, whose development build throws for either
//     option, naming the fix.
//
// @reactre/core/features/async's `memo` is the other way round: its own export takes the options
// (`loadingValue`, `id`, `ssrSource`, `deferStream`, `transparent`), and a call that passes none
// of them goes to `__memo`, the core's memo as the module exported it before it had options.
// So an app that passes none bundles what it did, and a call the compiler does not see (in a .ts
// file, a dependency) gets the options it passes, as does a use that is not a call.

import { isIdent, literal, NOT_LITERAL, skipToken, splitAt, until } from "./scan.ts";

/** A function the rewrite reads: the entry its calls go to, under a local name, and the options that decide it. */
interface Entry {
  readonly entry: string;
  readonly local: string;
  readonly needs: readonly string[];
}

/**
 * A module whose functions the rewrite reads, by their exported names. Without `plain`, a call
 * that passes one of an entry's options (or may) goes to the entry; with it, one that passes none.
 */
interface Mod {
  readonly name: string;
  readonly functions: Readonly<Record<string, Entry>>;
  readonly plain: boolean;
}

const MODULES: readonly Mod[] = [
  {
    name: "@reactre/core/features/memo",
    functions: {
      memo: { entry: "__observedMemo", local: "__rrObsMemo", needs: ["lazy", "unobserved"] },
      signal: { entry: "__observedSignal", local: "__rrObsSignal", needs: ["unobserved"] },
    },
    plain: false,
  },
  {
    name: "@reactre/core/features/async",
    functions: {
      memo: {
        entry: "__memo",
        // Its own name: the import the rewrite adds names it with no `as`, which a map would place at `import`.
        local: "__memo",
        needs: ["loadingValue", "id", "ssrSource", "deferStream", "transparent"],
      },
    },
    plain: true,
  },
];

/** Module `m`'s function named `n`, if the rewrite reads it. */
const fnOf = (m: Mod, n: string): Entry | undefined => (Object.hasOwn(m.functions, n) ? m.functions[n] : undefined);

/** Words before a parenthesized group that make it a condition or a head, not a parameter list. */
const HEADS = new Set(["if", "while", "for", "switch", "with", "return", "typeof", "await", "yield", "in", "of"]);

/** A file rewritten: its code, and where an offset in the code came from in the input. */
export interface Rewritten {
  readonly code: string;
  /** The offset in the input that offset `at` of the code was copied from (an edit's start for its text). */
  back(at: number): number;
}

/** One edit: input `[start, end)` becomes `text`. */
type Edit = readonly [start: number, end: number, text: string];

/** A token of code (not a literal or a comment): its text and where it starts and ends. */
interface Tok {
  readonly t: string;
  readonly s: number;
  readonly e: number;
}

/**
 * The code tokens of `js[from, to)`: names (and numbers) whole, every other character alone, and
 * each literal or comment as one token of text "". A template literal's substitutions follow it,
 * each inside a `(` and `)` of its own (its `${` and its `}`), so a call in one is seen.
 */
function tokens(js: string, from = 0, to = js.length, out: Tok[] = []): Tok[] {
  let prev = "",
    word = "";
  for (let i = from; i < to;) {
    const j = skipToken(js, i, prev, word);
    if (j !== i) {
      out.push({ t: "", s: i, e: j });
      if (js[i] === "`")
        for (let d = i + 1; d < j; d++) {
          if (js[d] === "\\") d++;
          else if (js[d] === "$" && js[d + 1] === "{") {
            const end = until(js, d + 2, "");
            out.push({ t: "(", s: d, e: d + 2 });
            tokens(js, d + 2, end, out);
            out.push({ t: ")", s: end, e: end + 1 });
            d = end;
          }
        }
      prev = "a";
      word = "";
      i = j;
      continue;
    }
    const c = js[i]!;
    if (isIdent(c)) {
      let e = i;
      while (isIdent(js[e])) e++;
      word = js.slice(i, e);
      out.push({ t: word, s: i, e });
      prev = "a";
      i = e;
      continue;
    }
    if (!/\s/.test(c)) {
      out.push({ t: c, s: i, e: i + 1 });
      prev = c;
      word = "";
    }
    i++;
  }
  return out;
}

/**
 * `js` with its calls of @reactre/core/features/memo's `memo` and `signal` that pass `lazy` or
 * `unobserved` (or options the compiler cannot read) sent to the module's reader-counting entry,
 * and its calls of features/async's `memo` that pass none of its options sent to `__memo`;
 * null when nothing changes.
 */
export function observedCalls(js: string): Rewritten | null {
  if (!MODULES.some((m) => js.includes(m.name))) return null;
  const toks = tokens(js);
  // The imports: local names of the functions, and namespaces; and the statements to skip.
  const locals = new Map<string, [Mod, Entry]>(),
    spaces = new Map<string, Mod>(),
    skip: [number, number][] = [],
    edits: Edit[] = [],
    // A plain module's imports, by local name: where the imported name is in its import, and it.
    imported = new Map<string, [number, string]>(),
    // Each module's first named import: where its `import` and its `from` are, which the import
    // the rewrite adds of the module's entries maps back to.
    origins = new Map<Mod, [number, number]>();
  /** The module named by the string at token `k`, if the rewrite reads it. */
  const moduleAt = (k: number): Mod | undefined => {
    const t = toks[k];
    if (t === undefined || t.t !== "") return undefined;
    const s = js.slice(t.s, t.e);
    return MODULES.find((m) => s === `"${m.name}"` || s === `'${m.name}'`);
  };
  for (let k = 0; k < toks.length; k++) {
    const kw = toks[k]!.t;
    if ((kw !== "import" && kw !== "export") || toks[k - 1]?.t === ".") continue;
    const open = toks[k + 1];
    if (open?.t === "{") {
      let close = k + 2;
      while (close < toks.length && toks[close]!.t !== "}") close++;
      // An import's or a re-export's list names no local binding: none of its names is a use.
      const from = toks[close + 1]?.t === "from";
      if (from) skip.push([toks[k]!.s, toks[close + 2]?.e ?? js.length]);
      const m = from ? moduleAt(close + 2) : undefined;
      if (m === undefined) continue;
      if (kw === "import") {
        if (!origins.has(m)) origins.set(m, [toks[k]!.s, toks[close + 1]!.s]);
        for (const [name, local, at] of specifiers(js, toks[k + 1]!.e, toks[close]!.s)) {
          const f = fnOf(m, name);
          if (f === undefined) continue;
          locals.set(local, [m, f]);
          if (m.plain) imported.set(local, [at, name]);
        }
      } else if (!m.plain) {
        // A re-export by name hands the function to modules whose calls are not seen here. (A
        // plain module's own function takes every call, so its re-export stays.)
        for (const [at, name, renamed] of exportedNames(js, toks[k + 1]!.e, toks[close]!.s)) {
          const f = fnOf(m, name);
          if (f !== undefined) edits.push([at, at + name.length, renamed ? f.entry : `${f.entry} as ${name}`]);
        }
      }
    } else if (kw === "import" && open?.t === "*" && toks[k + 2]?.t === "as" && toks[k + 4]?.t === "from") {
      skip.push([toks[k]!.s, toks[k + 5]?.e ?? js.length]);
      const m = moduleAt(k + 5);
      if (m !== undefined) spaces.set(toks[k + 3]!.t, m);
    }
  }
  // The edits re-exports make need no import; the calls' need the entries'.
  const used = new Map<Entry, Mod>();
  /** Whether the use of `f` of `m` at token `k` (just past its name) goes to the entry. */
  const sent = (m: Mod, f: Entry, k: number): boolean => needs(js, toks, k, f) !== m.plain;
  // A plain module's calls that go to the entry, by local name, and the names used otherwise too.
  const plainCalls = new Map<string, Edit[]>(),
    mixed = new Set<string>();
  if (locals.size > 0 || spaces.size > 0) {
    const shadows = shadowed(js, toks, new Set([...locals.keys(), ...spaces.keys()]));
    const inSkip = (at: number) => skip.some(([s, e]) => s <= at && at < e);
    const shadow = (name: string, at: number) => shadows.get(name)?.some(([s, e]) => s <= at && at < e) === true;
    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k]!;
      const before = toks[k - 1];
      // A member (`x.memo`) is some other object's, unless it is spread (`...memo`).
      const member = before?.t === "." && toks[k - 2]?.t !== ".";
      if (tok.t === "" || member || inSkip(tok.s) || shadow(tok.t, tok.s)) continue;
      const space = spaces.get(tok.t);
      if (space !== undefined && toks[k + 1]?.t === ".") {
        const f = fnOf(space, toks[k + 2]?.t ?? "");
        if (f !== undefined) {
          if (sent(space, f, k + 3)) edits.push([toks[k + 2]!.s, toks[k + 2]!.e, f.entry]);
          continue;
        }
      }
      const found = locals.get(tok.t);
      if (found === undefined) continue;
      const [m, f] = found;
      const after = toks[k + 1];
      // An object's key (`{ memo: x }`), or a method's name (`memo(a) { ... }`), is not the import.
      if (after?.t === ":" && (before?.t === "{" || before?.t === ",")) continue;
      if (after?.t === "(" && toks[closing(toks, k + 1) + 1]?.t === "{") continue;
      // A use that is not a call goes to the entry of a module that is not plain (see `needs`).
      if (!sent(m, f, k + 1)) {
        if (m.plain) mixed.add(tok.t);
        continue;
      }
      if (m.plain) {
        // The call alone, which a plain module's import may take for every use (below).
        const calls = plainCalls.get(tok.t) ?? [];
        plainCalls.set(tok.t, calls);
        calls.push([tok.s, tok.e, f.local]);
        continue;
      }
      used.set(f, m);
      const local = f.local;
      // Shorthand (`{ memo }`) keeps its key; an export list (`export { memo }`) its name.
      const shorthand = (before?.t === "{" || before?.t === ",") && (after?.t === "}" || after?.t === ",");
      const text = exported(toks, k)
        ? after?.t === "as"
          ? local
          : `${local} as ${tok.t}`
        : shorthand && inObject(toks, k)
          ? `${tok.t}: ${local}`
          : local;
      edits.push([tok.s, tok.e, text]);
    }
  }
  for (const [local, calls] of plainCalls) {
    const [m, f] = locals.get(local)!;
    if (mixed.has(local)) {
      // Used otherwise too: the calls take the entry's own import.
      used.set(f, m);
      edits.push(...calls);
      continue;
    }
    // Only calls that go to the entry: the import names it, and the calls take its name if they had
    // the function's. So the file gains no line, and the bundle's minified names stay as they were
    // (see ../../core/src/asyncMemo.ts); and the rewrite writes no name a source map would place at
    // another (`as`).
    const [at, name] = imported.get(local)!;
    edits.push([at, at + name.length, f.entry]);
    if (name === local) for (const [s, e] of calls) edits.push([s, e, f.entry]);
  }
  if (edits.length === 0) return null;
  edits.sort((a, b) => a[0] - b[0]);
  // An import of the entries the calls use, per module, in the order the modules are listed.
  let head = "";
  // Each added import's start and its `from`'s in the code, and where they map back to: the
  // module's own import's `import` and `from`.
  const heads: [number, number, [number, number]][] = [];
  for (const m of MODULES) {
    const names = [...used]
      .filter(([, x]) => x === m)
      .map(([f]) => (f.entry === f.local ? f.entry : `${f.entry} as ${f.local}`));
    if (names.length === 0) continue;
    const line = `import { ${names.join(", ")} } from "${m.name}";\n`;
    heads.push([head.length, head.length + line.indexOf(" from ") + 1, origins.get(m)!]);
    head += line;
  }
  let code = head,
    last = 0;
  // Each edit's place in the code: where its text starts, where it ends, and its input start.
  const placed: [number, number, number, number][] = [];
  for (const [s, e, text] of edits) {
    code += js.slice(last, s);
    placed.push([code.length, code.length + text.length, s, e]);
    code += text;
    last = e;
  }
  code += js.slice(last);
  return {
    code,
    back(at) {
      if (at < head.length) {
        // An added import: its `from` and what follows at the module's import's, the rest at its `import`.
        const [start, from, [imp, fr]] = heads.findLast(([s]) => s <= at)!;
        return at >= from ? fr + (at - from) : at - start < 6 ? imp + (at - start) : imp;
      }
      // The input offset is the code's, less what the edits before it added.
      let shift = head.length;
      for (const [cs, ce, s, e] of placed) {
        if (at < cs) break;
        if (at < ce) return s;
        shift = ce - e;
      }
      return at - shift;
    },
  };
}

/** The `name as local` (or `name`) specifiers of an import list `js[from, to)`, as [name, local, where name is]. */
function specifiers(js: string, from: number, to: number): [string, string, number][] {
  return splitAt(js, from, to).map(([part, at]) => {
    const [name, local = name] = part.split(/\s+as\s+/) as [string, string?];
    return [name, local, at];
  });
}

/** The names an export list `js[from, to)` exports (`memo`, or `memo as m`): where each starts, it, and whether it is renamed. */
function exportedNames(js: string, from: number, to: number): [number, string, boolean][] {
  return splitAt(js, from, to).map(([part, at]) => {
    const [name, as] = part.split(/\s+as\s+/);
    return [at, name!, as !== undefined];
  });
}

/** The token that closes the bracket opened at token `k`. */
function closing(toks: readonly Tok[], k: number): number {
  let depth = 0;
  for (let i = k; i < toks.length; i++) {
    const t = toks[i]!.t;
    if (t === "(" || t === "[" || t === "{") depth++;
    else if (t === ")" || t === "]" || t === "}") if (--depth === 0) return i;
  }
  return toks.length;
}

/** Whether token `k` is in a local export list (`export { memo }`), which names it. */
function exported(toks: readonly Tok[], k: number): boolean {
  let i = k - 1;
  while (i >= 0 && toks[i]!.t !== "{" && toks[i]!.t !== "}" && toks[i]!.t !== ";") i--;
  return toks[i]?.t === "{" && toks[i - 1]?.t === "export";
}

/** Whether the `{` around token `k` opens an object literal: a value is expected before it. */
function inObject(toks: readonly Tok[], k: number): boolean {
  let i = k - 1;
  for (let depth = 0; i >= 0; i--) {
    const t = toks[i]!.t;
    if (t === "}" || t === ")" || t === "]") depth++;
    else if (t === "{" || t === "(" || t === "[") {
      if (depth === 0) break;
      depth--;
    }
  }
  const b = toks[i - 1]?.t;
  return b === undefined || "(,=:[?!&|+-*%<>~^".includes(b) || b === "return";
}

/**
 * Whether the use of function `fn` at token `k` (just past its name) may pass the options that
 * decide its entry (`fn.needs`): a call whose options are a literal with one of them, or that the
 * compiler cannot read; or a use that is not a call.
 */
function needs(js: string, toks: readonly Tok[], k: number, fn: Entry): boolean {
  if (toks[k]?.t !== "(") return true;
  // A call that never closes (code cut short) runs to the end.
  const args = splitAt(js, toks[k]!.e, toks[closing(toks, k)]?.s ?? js.length);
  if (args.some(([a]) => a.startsWith("..."))) return true;
  const options = args[1]?.[0];
  if (options === undefined || options === "undefined" || options === "void 0") return false;
  if (!options.startsWith("{") || until(options, 1, "") !== options.length - 1) return true;
  for (const [part] of splitAt(options, 1, options.length - 1)) {
    if (part.startsWith("...") || part.startsWith("[")) return true;
    const key = /^(?:(?:get|set|async)\s+(?=[\w$"*]))?\*?\s*("(?:[^"\\]|\\.)*"|[\w$]+)/.exec(part)?.[1];
    // A key the scan cannot read (single quotes, which Bun does not print) may be either option.
    if (key === undefined) return true;
    const name = key.startsWith('"') ? literal(key) : key;
    if (name === NOT_LITERAL || fn.needs.includes(name as string)) return true;
  }
  return false;
}

/**
 * Where each of `names` is bound again in `js`, so a use there is not the import: the scope of
 * each parameter, `const`, `let` or `var` declaration, function or class declaration, and `catch`
 * binding of the name. A scope is a range of offsets: a function's parameters and body, or the
 * block a declaration is in (a `var` is taken as block-scoped, the only scope the scan knows).
 */
function shadowed(js: string, toks: readonly Tok[], names: ReadonlySet<string>): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  /** Note `name` as bound in `scope()`, a range worked out only for the names asked about. */
  const add = (name: string, scope: () => [number, number]) => {
    if (!names.has(name)) return;
    let r = out.get(name);
    if (r === undefined) out.set(name, (r = []));
    r.push(scope());
  };
  // The block each token is in: from the innermost `{` open at it to its `}`, or the whole file.
  const blocks: number[] = [];
  const block = (): [number, number] => {
    const open = blocks[blocks.length - 1];
    return open === undefined ? [0, js.length] : [toks[open]!.s, toks[closing(toks, open)]?.e ?? js.length];
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!.t;
    if (t === "{") blocks.push(k);
    else if (t === "}") blocks.pop();
    if (t === "function" || t === "class") {
      const n = toks[k + 1]?.t === "*" ? k + 2 : k + 1;
      const name = toks[n]?.t;
      if (name !== undefined && isIdent(name[0]) && name !== "extends") add(name, block);
    } else if (t === "const" || t === "let" || t === "var") {
      const end = until(js, toks[k]!.e, ";");
      for (const [part] of splitAt(js, toks[k]!.e, end))
        for (const n of patternNames(part.slice(0, until(part, 0, "=")))) add(n, block);
    } else if (t === "(") {
      // A parameter list: before `=>`, or before a body after a function's, method's or catch's name.
      const close = closing(toks, k);
      const next = toks[close + 1]?.t;
      const head = toks[k - 1]?.t;
      const arrow = next === "=" && toks[close + 2]?.t === ">";
      const body = next === "{" && head !== undefined && isIdent(head[0]) && !HEADS.has(head);
      if (!arrow && !body) continue;
      const scope = (): [number, number] => [toks[k]!.s, bodyEnd(js, toks, arrow ? close + 3 : close + 1)];
      const params = js.slice(toks[k]!.e, toks[close]!.s);
      for (const [part] of splitAt(params, 0, params.length))
        for (const n of patternNames(part.slice(0, until(part, 0, "=")))) add(n, scope);
    } else if (isIdent(t[0]) && toks[k + 1]?.t === "=" && toks[k + 2]?.t === ">" && toks[k - 1]?.t !== ".") {
      // A lone parameter: `memo => ...`.
      add(t, () => [toks[k]!.s, bodyEnd(js, toks, k + 3)]);
    }
  }
  return out;
}

/** Where a function body that starts at token `k` ends: its block's `}`, or its expression's end. */
function bodyEnd(js: string, toks: readonly Tok[], k: number): number {
  const t = toks[k];
  if (t === undefined) return js.length;
  if (t.t === "{") return toks[closing(toks, k)]?.e ?? js.length;
  return until(js, t.s, ",;");
}

/** The names a binding pattern (`a`, `{ a, b: c }`, `[a, ...b]`) binds: keys before `:` are not. */
function patternNames(pattern: string): string[] {
  const ts = tokens(pattern);
  return ts.filter((t, i) => isIdent(t.t[0]) && !/^\d/.test(t.t) && ts[i + 1]?.t !== ":").map((t) => t.t);
}
