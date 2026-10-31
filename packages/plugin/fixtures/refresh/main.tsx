// A React app for test/refresh.test.ts, served by Vite with @vitejs/plugin-react and the plugin in
// compat mode: react and react-dom resolve to @reactre/compat's development build.

import { createRoot } from "react-dom/client";

import { Counter } from "./counter.tsx";

createRoot(document.getElementById("root")!).render(<Counter />);
