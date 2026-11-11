// @reactre/state/scxml: an SCXML document becomes a machine's source, which type-checks, compiles
// and runs like one written by hand.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Machine, Shape } from "@reactre/state";
import { fromSCXML } from "@reactre/state/scxml";

const LIGHT = `<?xml version="1.0"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" name="light" initial="off">
  <state id="off">
    <transition event="power" target="on"/>
    <transition event="go" target="menuHist"/>
  </state>
  <parallel id="on">
    <state id="color" initial="red">
      <state id="red"><transition event="next" target="green"/></state>
      <state id="green"><transition event="next" target="red" cond="ok"/></state>
    </state>
    <state id="dim" initial="high">
      <state id="high"><transition event="dim.down" target="low"/></state>
      <state id="low"><transition event="dim.*" target="high"/></state>
    </state>
    <transition event="power" target="off"/>
  </parallel>
  <state id="menu" initial="main">
    <history id="menuHist" type="shallow"><transition target="main"/></history>
    <state id="main"><transition event="open" target="sub"/></state>
    <state id="sub" initial="a">
      <state id="a"><transition target="b"/></state>
      <state id="b"><onentry><log expr="'b'"/></onentry><transition event="close" target="end"/></state>
    </state>
    <transition event="*" target="off"/>
  </state>
  <final id="end"/>
</scxml>`;

const dir = join(import.meta.dir, "scxml-out");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fromSCXML", () => {
  const { code, report } = fromSCXML(LIGHT);

  test("ids become dotted paths, and each construct the feature that writes it", () => {
    expect(code).toContain("use: [nested, parallel, history, always, wildcards]");
    expect(code).toContain('parallel: ["on"]');
    expect(code).toContain('"on.color.red": types<{}>()');
    // A target is the leaf it enters: a parallel node with a step for each region.
    expect(code).toContain('to("on", { "color": to("on.color.red"), "dim": to("on.dim.high") })');
    // Shallow history: back with a step for each child that is a parent.
    expect(code).toContain('back("menu", to("menu.main"), { "sub": to("menu.sub.a") })');
    expect(code).toContain('"menu.sub.a": { always: ({ to }) => to("menu.sub.b") }');
    expect(code).toContain('"dim.*": ({ to }) => to("on.dim.high")');
    expect(code).toContain('"end": { final: true }');
  });

  test("what isn't converted is a TODO in the code and a line in the report", () => {
    expect(code).toContain('/* TODO(@reactre/state): cond "ok" */');
    expect(report).toContain('TODO: <onentry> in "menu.sub.b" isn\'t converted: write it in a handler or a task');
    expect(report.some((line) => line.includes('cond "ok"'))).toBe(true);
  });

  test("the source type-checks, compiles and runs", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), `{ "extends": "../../../tsconfig.json", "include": ["."] }\n`);
    writeFileSync(join(dir, "light.ts"), code);
    const run = Bun.spawnSync(["bun", "check", "-p", join(dir, "tsconfig.json"), "--no-pretty"]);
    const said = run.stdout.toString() + run.stderr.toString();
    expect(said.split("\n").filter((l) => l.includes("light.ts("))).toEqual([]);

    await import("../../compiled.ts");
    const { createActor } = await import("@reactre/state");
    // A path the build never sees, so its import is untyped: its source type-checked just above.
    const { lightMachine }: { readonly lightMachine: Machine<Shape> } = await import(join(dir, "light.ts"));
    const actor = createActor(lightMachine);
    actor.send({ type: "go" });
    expect(actor.snapshot().state).toBe("menu.main");
    actor.send({ type: "open" });
    // The eventless transition: in "menu.sub.a" the machine never rests.
    expect(actor.snapshot().state).toBe("menu.sub.b");
    actor.send({ type: "power" });
    expect(actor.snapshot().state).toBe("off");
    actor.send({ type: "go" });
    expect(actor.snapshot().state).toBe("menu.sub.b");
    actor.send({ type: "power" });
    actor.send({ type: "power" });
    actor.send({ type: "dim.down" });
    actor.send({ type: "next" });
    expect(actor.snapshot()).toMatchObject({
      state: "on",
      data: { color: { state: "on.color.green" }, dim: { state: "on.dim.low" } },
    });
  });

  test("a document that isn't SCXML throws", () => {
    expect(() => fromSCXML("<html></html>")).toThrow("SCXML: the document has no <scxml> element");
    expect(() => fromSCXML("<scxml><state></scxml>")).toThrow("SCXML: </scxml> doesn't close the open element");
  });
});

// What a document can say that has no one-to-one form here: each is converted the nearest way,
// and the report says what was guessed, renamed or left out.
const DOOR = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" name="front-door" initial="door.closed">
  <state id="door.closed">
    <transition event="open" target="opened" cond="n &lt; 3 &#38;&#x26; ok"/>
    <transition event="open" target="alarm"/>
    <transition event="lock" target="locked"><assign location="x" expr="1"/></transition>
    <transition event="knock"><log expr="'who'"/></transition>
    <transition event="kick" target="nowhere"/>
  </state>
  <state id="opened">
    <initial><transition target="wide"/></initial>
    <state id="ajar">
      <transition event="open.wide" target="wide"/>
      <transition event="shove" target="alarm"/>
    </state>
    <state id="wide"><transition event="close" target="door.closed locked"/></state>
    <transition event="ping"/>
  </state>
  <state id="locked">
    <transition target="door.closed" cond="unlocked"/>
    <transition target="alarm"/>
  </state>
  <parallel id="alarm">
    <state id="siren"/>
    <state id="lights" initial="blink">
      <state id="blink"><transition event="reset" target="door.closed"/></state>
    </state>
  </parallel>
</scxml>`;

describe("fromSCXML, on what it converts the nearest way", () => {
  const { code, report } = fromSCXML(DOOR);

  test("the document's name is the machine's, and a dotted id is renamed", () => {
    expect(code).toContain("const frontDoor = setup({");
    expect(code).toContain("export const frontDoorMachine = frontDoor.machine({");
    expect(code).toContain('start: ({ to }) => to("door_closed"),');
    expect(report).toContain(
      'id "door.closed" has a dot, which separates a parent from its child here: it is "door_closed"',
    );
  });

  test("an <initial> element picks the child entered, and a region that is a leaf gets one", () => {
    expect(code).toContain('"open": ({ to }) => /* TODO(@reactre/state): cond "n < 3 && ok" */ to("opened.wide")');
    expect(code).toContain('to("alarm", { "siren": to("alarm.siren.active"), "lights": to("alarm.lights.blink") })');
    expect(report).toContain('region "alarm.siren" has no states: it is the parent of one leaf, "alarm.siren.active"');
    expect(report).toContain(
      '"alarm.siren.active" has no transition and isn\'t final: the type checker will ask for one, or { final: true }',
    );
  });

  test("a transition without a target stays, and one to no state stays and is reported", () => {
    expect(code).toContain('"knock": ({ to }) => /* TODO(@reactre/state): <log> */ to("door_closed")');
    expect(code).toContain('"kick": ({ to }) => to("door_closed")');
    // On a parent, a transition without a target declines.
    expect(code).toContain('"opened": { on: { "ping": () => null } }');
    expect(report).toContain('"door_closed" has a transition without a target: it stays');
    expect(report).toContain('"door_closed"\'s transition goes to "nowhere", which no state is');
  });

  test("what has more than one form here keeps the first, and the report says so", () => {
    expect(code).toContain('"lock": ({ to }) => /* TODO(@reactre/state): <assign> */ to("locked")');
    expect(code).toContain('"close": ({ to }) => to("door_closed")');
    expect(report).toContain("TODO: <assign> in \"door_closed\"'s transition isn't converted");
    expect(report).toContain('TODO: "door_closed" has more than one transition on "open": only the first is converted');
    expect(report).toContain(
      'TODO: "opened.wide"\'s transition goes to door.closed and locked: only the first is converted',
    );
    expect(report).toContain('TODO: "locked" has more than one eventless transition: only the first is converted');
    expect(report).toContain(
      'event "open" matches only itself here; in SCXML it also matches "open.<...>": add "open.*" for those',
    );
  });

  test("without an initial, the first state; a history without a default, its parent's first child", () => {
    const tabs = fromSCXML(`<scxml name="tabs">
      <state id="tabs">
        <history id="last" type="deep"/>
        <state id="one"><transition event="next" target="two"/></state>
        <state id="two"><transition event="away" target="gone"/></state>
      </state>
      <state id="gone"><transition event="return" target="last"/></state>
    </scxml>`);
    expect(tabs.code).toContain('start: ({ to }) => to("tabs.one"),');
    expect(tabs.code).toContain('"gone": { on: { "return": ({ to, back }) => back("tabs", to("tabs.one")) } }');
  });
});
