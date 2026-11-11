// The server half of the installed-tarball SSR test: render the app to HTML under StrictMode, as a
// server render does (no effect runs, so the actor never starts). Prints one JSON line: the HTML,
// and how many times the start state's task ran (0: a render starts nothing).

import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";

import { started, View } from "./app.tsx";

const html = renderToString(createElement(StrictMode, null, createElement(View)));
process.stdout.write(JSON.stringify({ html, started: started.length }));
