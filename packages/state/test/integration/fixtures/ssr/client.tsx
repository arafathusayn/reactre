// The client half of the installed-tarball SSR test: hydrate the server's HTML under StrictMode.
// StrictMode mounts, unmounts and mounts again, so the second mount must get a working actor. The
// test clicks the button once hydration has committed (the flag below), and reads the state after.

import { createElement, StrictMode, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";

import { View } from "./app.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("no #root");

/** Set once the hydrated tree's effects have run: the actor is started and the button is live. */
function Ready(): null {
  useEffect(() => {
    (globalThis as unknown as { __ready?: boolean }).__ready = true;
  }, []);
  return null;
}

hydrateRoot(container, createElement(StrictMode, null, createElement(View), createElement(Ready)));
