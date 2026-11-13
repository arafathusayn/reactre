// The child process ./run-emitted-interactive.ts spawns: import the emitted module and the ordinary
// runtime actor entry, then run the test's actor script outside the parent's development preload.
// Development's table hook stays observable on that emitted table; the core entry is the same for
// both modes. The result follows a distinct stdout marker.

export {};

const { code, actor, script } = JSON.parse(await Bun.stdin.text()) as {
  readonly code: string;
  readonly actor: { readonly code: string };
  readonly script: string;
};
const emitted = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as Record<
  string,
  unknown
>;
const core = (await import(`data:text/javascript;base64,${Buffer.from(actor.code).toString("base64")}`)) as {
  readonly createActor: unknown;
};
const run = new Function("exports", "createActor", `return (async () => {${script}})();`) as (
  exports: Record<string, unknown>,
  createActor: unknown,
) => Promise<unknown>;
const result = await run(emitted, core.createActor);
console.log("\n__reactre-emitted-result__\n" + JSON.stringify({ result }));
