// Plain-Bun entry for ./run-emitted.ts: the stdin is exactly a production build's emitted bytes,
// unless the caller supplies a written bundle's file URL. Only serialized results cross back.

export {};

const [, , operation, ...names] = Bun.argv;
const url =
  operation === "file-exports"
    ? Bun.pathToFileURL(names[0]!).href
    : `data:text/javascript;base64,${Buffer.from(await Bun.stdin.text()).toString("base64")}`;
const emitted = (await import(url)) as { readonly [name: string]: unknown };

if (operation === "file-exports") {
  const result = emitted[names[1] ?? "run"];
  if (typeof result !== "function") throw new Error(`emitted file has no function ${names[1] ?? "run"}`);
  console.log("\n__reactre-emitted-result__\n" + JSON.stringify(await result()));
} else if (operation === "exports") {
  const result: { readonly [name: string]: unknown } = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const value = emitted[name];
        if (name === "run" && typeof value !== "function") throw new Error("emitted bundle exports no run()");
        return [name, typeof value === "function" && name === "run" ? await value() : value];
      }),
    ),
  );
  // Fixture logging remains observable, but cannot be mistaken for the result payload.
  console.log("\n__reactre-emitted-result__\n" + JSON.stringify(result));
} else throw new Error(`unknown emitted-bundle operation: ${operation}`);
