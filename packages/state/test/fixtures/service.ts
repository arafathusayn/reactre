// The service the mistakes files' tasks call, as an app's would: a task's run does its work with
// the signal it is given, so a filler task isn't a stub that reports a success it never earned (M461).

/** A request with the task's signal; an error status fails it, so the task's error decides. */
export async function request(signal: AbortSignal, url = "/api/save"): Promise<string> {
  const res = await fetch(url, { method: "POST", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** The request, then the event the task resolves to: `run: ({ signal }) => posted(signal, "stored")`. */
export async function posted<T extends string>(signal: AbortSignal, type: T): Promise<{ type: T }> {
  await request(signal);
  return { type };
}
