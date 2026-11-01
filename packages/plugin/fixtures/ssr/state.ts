// A module of the app that the plugin does not compile (no JSX): in a server build, its effect
// does not run either.

import { effect, signal } from "@reactre/core";

export const [greeting, setGreeting] = signal("Hello");
export const log: string[] = [];
effect(() => void log.push(greeting()));
