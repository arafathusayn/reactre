// Prints the codemod's output and report for one file: `bun packages/state/test/codemod/run.ts <file>`.

import { convert, printReport } from "../../codemod/index.ts";

const file = process.argv[2] ?? "";
const { code, report } = convert(file, await Bun.file(file).text());
console.log(code);
console.log(printReport(file, report));
