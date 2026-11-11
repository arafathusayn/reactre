// Writes a published package's type declarations into its dist/: one .d.ts beside each module
// its exports name, and one for each module those import, so a consumer's compiler reads
// declarations and never type-checks reactre's sources under its own settings.
//
//   bun ../../scripts/declarations.ts      (from a package's directory, after its JS build)
//
// The sources live in src/ and each export's "reactre-source" condition names one (the repository
// type-checks the sources through that condition, tsconfig.json's customConditions). Its "types"
// condition names the declaration this writes: src/a/b.ts becomes dist/a/b.d.ts. A source outside
// src/ (@reactre/state's compiler/, plugin/ and codemod/) keeps its folder: compiler/a.ts becomes
// dist/compiler/a.d.ts.
//
// Design decisions:
//   - oxc's isolated declarations, not tsc: the packages already compile under
//     isolatedDeclarations (tsconfig.strict.json), so each file's declarations follow from that
//     file alone, and oxc writes them without a TypeScript install.
//   - Relative imports are rewritten from ./x.ts to ./x.js, which every moduleResolution maps to
//     ./x.d.ts (node16 and nodenext need the extension; .ts specifiers would need
//     allowImportingTsExtensions in the consumer's settings).
//   - Only modules reachable from an export are written, so build-only modules (a build script's
//     plugin) never reach a consumer.

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { isolatedDeclarationSync } from "oxc-transform";

/** The export condition that names a module's source in the repository. */
const SOURCE = "reactre-source";

/** A relative module specifier ending in .ts, in an import, export or import() type. */
const RELATIVE_TS = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g;

type Conditions = { readonly [condition: string]: string };

/**
 * Write the declarations of the package in `dir`.
 *
 * @returns The declaration files written, relative to `dir`.
 * @throws Error when an export has no source condition, a "types" condition that is not the
 *   declaration of its source, or a module oxc cannot declare.
 */
export function writeDeclarations(dir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    readonly name: string;
    readonly exports: { readonly [entry: string]: Conditions };
  };
  const queue: string[] = [];
  for (const [entry, conditions] of Object.entries(pkg.exports)) {
    const source = conditions[SOURCE];
    if (source === undefined) throw new Error(`${pkg.name}: export "${entry}" has no "${SOURCE}" condition`);
    if (conditions["types"] !== declarationOf(source)) {
      throw new Error(`${pkg.name}: export "${entry}" must have "types": "${declarationOf(source)}"`);
    }
    if (Object.keys(conditions)[0] !== SOURCE || Object.keys(conditions)[1] !== "types") {
      throw new Error(`${pkg.name}: export "${entry}" must list "${SOURCE}" first and "types" second`);
    }
    const matches = source.includes("*") ? globSync(source, { cwd: dir }) : [source];
    if (matches.length === 0) throw new Error(`${pkg.name}: export "${entry}" matches no source`);
    for (const m of matches) queue.push(resolve(dir, m));
  }
  const written: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) throw new Error(`${pkg.name}: ${relative(dir, file)} does not exist`);
    const out = isolatedDeclarationSync(file, readFileSync(file, "utf8"), { sourcemap: false });
    if (out.errors.length > 0) {
      throw new Error(`${relative(dir, file)}:\n${out.errors.map((e) => e.message).join("\n")}`);
    }
    const code = out.code.replace(RELATIVE_TS, (_, head: string, path: string, quote: string) => {
      queue.push(resolve(dirname(file), path + ".ts"));
      return `${head}${path}.js${quote}`;
    });
    const target = join(dir, declarationOf(`./${relative(dir, file)}`));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
    written.push(relative(dir, target));
  }
  return written.sort();
}

/**
 * The declaration a source's "types" condition names: ./src/a.ts is ./dist/a.d.ts, and a source
 * outside src/ keeps its folder under dist/: ./compiler/a.ts is ./dist/compiler/a.d.ts.
 */
function declarationOf(source: string): string {
  return source.replace(/^\.\/(?:src\/)?/, "./dist/").replace(/\.ts$/, ".d.ts");
}

if (import.meta.main) writeDeclarations(process.cwd());
