// Scenarios with the React libraries ranked 76th to 100th by npm weekly downloads, chosen as in
// ./libraries-51-75.tsx.
//
//   2026-10-29: lottie-react, react-phone-number-input, react-intl, react-image-crop,
//   @xstate/react, mobx-react-lite, react-qr-code, react-helmet, react-modal, slate-react,
//   @mantine/core, @trpc/react-query, react-player, valtio, react-device-detect, react-confetti,
//   react-map-gl, @fortawesome/react-fontawesome, react-copy-to-clipboard, react-tooltip,
//   react-color, notistack, @fullcalendar/react, react-tabs and react-virtualized.
//
// They run like the scenarios in ./libraries-1-25.tsx: the same code on React 19 and on each
// runtime, with every log and step compared.

import { faCoffee, faSpinner } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import { Button as MantineButton, Checkbox, MantineProvider, Modal as MantineModal, TextInput } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { unstable_localLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { initTRPC } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { useLottie } from "lottie-react";
import { makeAutoObservable, runInAction } from "mobx";
import { observer, useLocalObservable } from "mobx-react-lite";
import { closeSnackbar, enqueueSnackbar, SnackbarProvider } from "notistack";
import { useMemo, useRef, useState } from "react";
import { CirclePicker, SketchPicker } from "react-color";
import Confetti from "react-confetti";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { browserName, BrowserView, isBrowser, isMobile, MobileView } from "react-device-detect";
import { Helmet } from "react-helmet";
import ReactCrop, { type Crop } from "react-image-crop";
import { FormattedDate, FormattedMessage, FormattedNumber, IntlProvider, useIntl } from "react-intl";
import MapGL, { Marker, useMap } from "react-map-gl/maplibre";
import ReactModal from "react-modal";
import PhoneInput from "react-phone-number-input";
import ReactPlayer from "react-player";
import QRCode from "react-qr-code";
import { Tab, TabList, TabPanel, Tabs } from "react-tabs";
import { Tooltip } from "react-tooltip";
import { List as VirtualList } from "react-virtualized";
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { proxy, subscribe, useSnapshot } from "valtio";
import { assign, setup } from "xstate";

import { type T, type } from "./cases.tsx";
import { active, frames, key, keyWithCode, mount, mouse, until, wait } from "./helpers.tsx";

// #region Fixtures

/** A 4 by 4 PNG, for libraries that load an image. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";

/** A data URL of `ms` milliseconds of silent 8 kHz, 8-bit mono WAV audio, for media players. */
function silentWav(ms: number): string {
  const n = (8000 * ms) / 1000;
  const b = new DataView(new ArrayBuffer(44 + n));
  const text = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  b.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true);
  b.setUint32(28, 8000, true);
  b.setUint16(32, 1, true);
  b.setUint16(34, 8, true);
  text(36, "data");
  b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  let s = "";
  for (let i = 0; i < b.byteLength; i++) s += String.fromCharCode(b.getUint8(i));
  return "data:audio/wav;base64," + btoa(s);
}

/** A Lottie animation of a red square moving right over ten frames. */
const LOTTIE = {
  v: "5.7.4",
  fr: 10,
  ip: 0,
  op: 10,
  w: 40,
  h: 40,
  nm: "move",
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "box",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: {
          a: 1,
          k: [
            { t: 0, s: [10, 20, 0], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } },
            { t: 10, s: [30, 20, 0] },
          ],
        },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        { ty: "rc", d: 1, s: { a: 0, k: [10, 10] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 }, nm: "r" },
        { ty: "fl", c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1, nm: "f" },
      ],
      ip: 0,
      op: 10,
      st: 0,
      bm: 0,
    },
  ],
};

// A tRPC router served in the page through a local link: no HTTP. tRPC refuses to build a router
// in a browser unless told it is meant to.
const tr = initTRPC.create({ allowOutsideOfServer: true });
const appRouter = tr.router({
  greet: tr.procedure.input((v) => v as string).query(({ input }) => `hello ${input}`),
  double: tr.procedure.input((v) => v as number).mutation(({ input }) => input * 2),
});
const trpc = createTRPCReact<typeof appRouter>();

/** A MobX store with an action and a computed value. */
class Cart {
  items: string[] = [];
  constructor() {
    makeAutoObservable(this);
  }
  add(item: string) {
    this.items.push(item);
  }
  get count() {
    return this.items.length;
  }
}

// #endregion

// #region Scenarios

/** The scenarios by name, run after ./libraries-51-75.tsx's. */
export const libraries76To100: Record<string, (t: T) => Promise<void>> = {
  // A Lottie animation rendered to SVG by lottie-web through the hook: its loading state, then
  // seeks to two frames while paused.
  async "lottie-react: useLottie, state, seek"(t) {
    function App() {
      const l = useLottie({ src: LOTTIE, autoplay: false, loop: false });
      return (
        <div>
          <div ref={l.setDisplayRef} style={{ width: 40, height: 40 }} />
          <p id="state">
            {l.state} {l.playableFrames}
          </p>
          <button id="f0" onClick={() => l.seek(0)}>
            0
          </button>
          <button id="f5" onClick={() => l.seek(5)}>
            5
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await until(() => !t.$("#state").textContent!.startsWith("loading"), 2000);
    await frames(2);
    t.$("#f0").click();
    await frames(2);
    await t.step("frame 0");
    t.$("#f5").click();
    await frames(2);
    await t.step("frame 5");
  },

  // An international phone number field: typing formats the number as the country's, and the
  // value comes back in E.164.
  async "react-phone-number-input: typing, formatting, E.164 value"(t) {
    function App() {
      const [value, setValue] = useState<string | undefined>();
      return (
        <div>
          <PhoneInput
            id="phone"
            defaultCountry="US"
            international={false}
            value={value}
            onChange={(v) => (t.log("value", v ?? "none"), setValue(v))}
          />
          <p id="value">{value}</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("empty");
    type(t.$("input[type=tel]"), "2133734");
    await t.step("partial");
    type(t.$("input[type=tel]"), "2133734253");
    await t.step("complete");
  },

  // Messages, numbers and dates formatted for a locale, an imperative formatter from a hook, and
  // a locale switch.
  async "react-intl: messages, numbers, dates, locale switch"(t) {
    const messages = {
      en: { hello: "Hello, {name}! You have {n, plural, one {# message} other {# messages}}." },
      fr: { hello: "Bonjour, {name} ! Vous avez {n, plural, one {# message} other {# messages}}." },
    };
    function Count() {
      const intl = useIntl();
      return <p id="pct">{intl.formatNumber(0.256, { style: "percent" })}</p>;
    }
    function App() {
      const [locale, setLocale] = useState<"en" | "fr">("en");
      const [n, setN] = useState(1);
      return (
        <IntlProvider locale={locale} messages={messages[locale]} timeZone="UTC">
          <p>
            <FormattedMessage id="hello" values={{ name: "Ada", n }} />
          </p>
          <p>
            <FormattedNumber value={1234567.891} style="currency" currency="EUR" />
          </p>
          <p>
            <FormattedDate value={Date.UTC(2026, 0, 15)} year="numeric" month="long" day="numeric" />
          </p>
          <Count />
          <button id="more" onClick={() => setN(5)}>
            more
          </button>
          <button id="fr" onClick={() => setLocale("fr")}>
            fr
          </button>
        </IntlProvider>
      );
    }
    mount(t, <App />);
    await t.step("english");
    t.$("#more").click();
    await t.step("plural");
    t.$("#fr").click();
    await t.step("french");
  },

  // A crop selection over an image, moved with the keyboard and reported on change and on
  // completion.
  async "react-image-crop: controlled crop, keyboard nudges"(t) {
    function App() {
      const [crop, setCrop] = useState<Crop>({ unit: "px", x: 10, y: 10, width: 40, height: 40 });
      return (
        <ReactCrop
          crop={crop}
          aspect={1}
          onChange={(c) => setCrop(c)}
          onComplete={(c) => t.log("complete", c.x, c.y, c.width, c.height)}
        >
          <img src={PNG} alt="" style={{ width: 100, height: 100, display: "block" }} />
        </ReactCrop>
      );
    }
    mount(t, <App />);
    await until(() => t.root.querySelector("img")?.complete === true, 2000);
    await t.step("placed");
    const sel = t.$(".ReactCrop__crop-selection");
    sel.focus();
    key(sel, "ArrowRight");
    key(sel, "ArrowDown");
    sel.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    await t.step("nudged");
  },

  // An XState v5 machine in a component: events, guarded transitions, context updated by
  // actions, and a delayed transition.
  async "@xstate/react: useMachine, guards, context, delays"(t) {
    const machine = setup({
      types: { context: {} as { count: number }, events: {} as { type: "INC" } | { type: "GO" } },
      guards: { under3: ({ context }) => context.count < 3 },
    }).createMachine({
      id: "m",
      initial: "idle",
      context: { count: 0 },
      states: {
        idle: {
          on: {
            INC: { guard: "under3", actions: assign({ count: ({ context }) => context.count + 1 }) },
            GO: "busy",
          },
        },
        busy: { after: { 50: "done" } },
        done: { type: "final" },
      },
    });
    function App() {
      const [state, send] = useMachine(machine);
      return (
        <div>
          <p>
            {String(state.value)} {state.context.count}
          </p>
          <button id="inc" onClick={() => send({ type: "INC" })}>
            inc
          </button>
          <button id="go" onClick={() => send({ type: "GO" })}>
            go
          </button>
        </div>
      );
    }
    mount(t, <App />);
    for (let i = 0; i < 5; i++) t.$("#inc").click();
    await t.step("counted to the guard");
    t.$("#go").click();
    await t.step("busy");
    await wait(120);
    await t.step("done");
  },

  // MobX observers: a component that re-renders when the observables it read change, a store
  // changed outside React, and local observable state.
  async "mobx-react-lite: observer, outside actions, local observables"(t) {
    const cart = new Cart();
    let renders = 0;
    const Count = observer(function Count() {
      renders++;
      return <p id="count">{cart.count}</p>;
    });
    const Local = observer(function Local() {
      const s = useLocalObservable(() => ({
        n: 0,
        inc() {
          this.n++;
        },
      }));
      return (
        <button id="local" onClick={s.inc}>
          {s.n}
        </button>
      );
    });
    mount(
      t,
      <div>
        <Count />
        <Local />
      </div>,
    );
    await t.step("empty");
    runInAction(() => cart.add("apple"));
    cart.add("pear");
    await t.step("two items");
    t.$("#local").click();
    t.$("#local").click();
    await t.step("local");
    t.log("renders", renders);
  },

  // A QR code drawn as SVG paths for a value and error-correction level.
  async "react-qr-code: value and level"(t) {
    function App() {
      const [value, setValue] = useState("hello");
      return (
        <div>
          <QRCode value={value} size={64} level="M" />
          <button id="change" onClick={() => setValue("https://example.com/a/longer/value")}>
            change
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("hello");
    t.$("#change").click();
    await t.step("changed");
  },

  // react-helmet's class-based head manager: the title from the innermost Helmet, html
  // attributes, and the title restored when that one unmounts.
  async "react-helmet: title, html attributes, nesting"(t) {
    function App() {
      const [inner, setInner] = useState(true);
      return (
        <div>
          <Helmet htmlAttributes={{ lang: "en" }} titleTemplate="%s | site">
            <title>Outer</title>
          </Helmet>
          {inner && (
            <Helmet>
              <title>Inner</title>
            </Helmet>
          )}
          <button id="drop" onClick={() => setInner(false)}>
            drop
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(50);
    t.log("title", document.title, "lang", document.documentElement.lang);
    t.$("#drop").click();
    await wait(50);
    t.log("title", document.title);
    await t.step("dropped");
  },

  // An accessible modal from a class component: rendered into a chosen parent, focus moved into
  // it, closed with Escape, and focus given back.
  async "react-modal: portal, focus, Escape"(t) {
    function App() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button id="open" onClick={() => setOpen(true)}>
            open
          </button>
          <ReactModal
            isOpen={open}
            appElement={t.root}
            parentSelector={() => t.other}
            contentLabel="Example"
            onAfterOpen={() => t.log("after open")}
            onRequestClose={(e) => (t.log("request close", e.type), setOpen(false))}
            ariaHideApp
          >
            <p>modal body</p>
            <button id="inside">inside</button>
          </ReactModal>
        </div>
      );
    }
    mount(t, <App />);
    t.$("#open").focus();
    t.$("#open").click();
    await frames(2);
    await t.step("open");
    t.log("focus", active());
    keyWithCode(t.other.querySelector(".ReactModal__Content")!, "Escape", 27);
    await frames(2);
    await t.step("closed");
    t.log("focus", active());
  },

  // A Slate editor: the document rendered with custom elements and leaves, edits made through
  // Slate's transforms, a mark, undo, and change events.
  async "slate-react: render, transforms, marks, undo"(t) {
    let ed: Editor | undefined;
    function App() {
      const editor = useMemo(() => withHistory(withReact(createEditor())), []);
      ed = editor;
      const initial: Descendant[] = [{ type: "p", children: [{ text: "hello" }] } as Descendant];
      return (
        <Slate editor={editor} initialValue={initial} onChange={(v) => t.log("change", JSON.stringify(v))}>
          <Editable
            renderElement={({ attributes, children }) => <p {...attributes}>{children}</p>}
            renderLeaf={({ attributes, children, leaf }) => (
              <span {...attributes} style={{ fontWeight: (leaf as { bold?: boolean }).bold ? "bold" : "normal" }}>
                {children}
              </span>
            )}
          />
        </Slate>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    Transforms.select(ed!, Editor.end(ed!, []));
    Editor.insertText(ed!, " world");
    await t.step("inserted");
    Transforms.select(ed!, { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 5 } });
    Editor.addMark(ed!, "bold", true);
    await t.step("bold");
    HistoryEditor.undo(ed!);
    HistoryEditor.undo(ed!);
    await t.step("undone");
  },

  // Mantine: components in a provider with a theme, a controlled text input and checkbox, and a
  // modal portaled into a container with no transition.
  async "@mantine/core: provider, inputs, modal"(t) {
    function App() {
      const [text, setText] = useState("");
      const [checked, setChecked] = useState(false);
      const [open, setOpen] = useState(false);
      return (
        <MantineProvider theme={{ primaryColor: "grape" }}>
          <TextInput id="text" label="Name" value={text} onChange={(e) => setText(e.currentTarget.value)} />
          <Checkbox id="check" label="Agree" checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} />
          <MantineButton id="open" onClick={() => setOpen(true)}>
            open
          </MantineButton>
          <MantineModal
            // Mantine replaces React's id with a random one after mounting; a fixed id stays.
            id="modal"
            opened={open}
            onClose={() => (t.log("close"), setOpen(false))}
            title="Hello"
            transitionProps={{ duration: 0 }}
            portalProps={{ target: t.other }}
          >
            text: {text}
          </MantineModal>
        </MantineProvider>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    type(t.$("#text"), "Ada");
    t.$("#check").click();
    await t.step("typed and checked");
    t.$("#open").click();
    await wait(50);
    await t.step("modal open");
    t.other.querySelector<HTMLElement>(".mantine-Modal-close")!.click();
    await wait(50);
    await t.step("modal closed");
  },

  // tRPC's React Query hooks over a local link: a query with input, a mutation, and an
  // invalidation that refetches.
  async "@trpc/react-query: query, mutation, invalidation"(t) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = trpc.createClient({
      links: [unstable_localLink({ router: appRouter, createContext: async () => ({}) })],
    });
    function Greeting() {
      const [name, setName] = useState("Ada");
      const greet = trpc.greet.useQuery(name);
      const double = trpc.double.useMutation({ onSuccess: (v) => t.log("doubled", v) });
      return (
        <div>
          <p>{greet.isPending ? "loading" : greet.data}</p>
          <button id="name" onClick={() => setName("Grace")}>
            name
          </button>
          <button id="double" onClick={() => double.mutate(21)}>
            double
          </button>
        </div>
      );
    }
    mount(
      t,
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Greeting />
        </QueryClientProvider>
      </trpc.Provider>,
    );
    await t.step("loading");
    await wait(50);
    await t.step("loaded");
    t.$("#name").click();
    await wait(50);
    await t.step("other name");
    t.$("#double").click();
    await wait(50);
    await t.step("mutated");
  },

  // A media player: a light preview that loads the player on click, a file played through the
  // HTML player, and its ready and duration events.
  async "react-player: light preview, HTML player, ready"(t) {
    const src = silentWav(200);
    function App() {
      return (
        <ReactPlayer
          src={src}
          light={PNG}
          width={160}
          height={90}
          playing={false}
          controls={false}
          onClickPreview={() => t.log("preview clicked")}
          onReady={() => t.log("ready")}
          onDurationChange={(e) =>
            t.log("duration", Math.round((e.currentTarget as HTMLMediaElement).duration * 10) / 10)
          }
        />
      );
    }
    mount(t, <App />);
    // The preview and the players are lazy components.
    await until(() => t.root.querySelector(".react-player__preview") !== null, 3000);
    await frames(2);
    await t.step("preview");
    t.root.querySelector<HTMLElement>(".react-player__preview")!.click();
    await until(() => (t.root.querySelector("video")?.readyState ?? 0) >= 1, 3000);
    await wait(50);
    await t.step("player");
  },

  // valtio: a proxy state mutated directly, components that re-render from snapshots of what they
  // read, and a subscription.
  async "valtio: proxy state, snapshots, subscribe"(t) {
    const state = proxy({ count: 0, todos: [] as { text: string; done: boolean }[] });
    const unsub = subscribe(state, () => t.log("changed", state.count, state.todos.length));
    let todoRenders = 0;
    function Counter() {
      const snap = useSnapshot(state);
      return (
        <button id="inc" onClick={() => state.count++}>
          {snap.count}
        </button>
      );
    }
    function Todos() {
      const snap = useSnapshot(state);
      todoRenders++;
      return (
        <ul>
          {snap.todos.map((x, i) => (
            <li key={i} onClick={() => (state.todos[i]!.done = !x.done)}>
              {x.text} {String(x.done)}
            </li>
          ))}
        </ul>
      );
    }
    mount(
      t,
      <div>
        <Counter />
        <Todos />
      </div>,
    );
    t.$("#inc").click();
    t.$("#inc").click();
    await t.step("counted");
    state.todos.push({ text: "a", done: false });
    await t.step("todo");
    t.root.querySelector("li")!.click();
    await t.step("done");
    t.log("todo renders", todoRenders);
    unsub();
  },

  // Device detection from the user agent: the flags, the browser name, and the views that render
  // for a browser or a phone.
  async "react-device-detect: flags and views"(t) {
    mount(
      t,
      <div>
        <p>
          {String(isBrowser)} {String(isMobile)} {browserName}
        </p>
        <BrowserView>
          <p>browser view</p>
        </BrowserView>
        <MobileView>
          <p>mobile view</p>
        </MobileView>
      </div>,
    );
    await t.step("detected");
  },

  // Confetti on a canvas from a class component: a burst of pieces that falls out of the canvas
  // and reports completion. Random positions make the pixels differ, so only events and size are
  // compared.
  async "react-confetti: burst and completion"(t) {
    let done = false;
    mount(
      t,
      <Confetti
        width={100}
        height={60}
        numberOfPieces={10}
        recycle={false}
        gravity={3}
        onConfettiComplete={() => ((done = true), t.log("complete"))}
      />,
    );
    await frames(2);
    await t.step("running");
    await until(() => done, 8000);
    t.log("done", done);
  },

  // A MapLibre map through react-map-gl: an inline style with no tiles, a marker positioned in
  // the map, a load event, and the map instance from a child through useMap.
  async "react-map-gl: maplibre map, marker, useMap"(t) {
    function Center() {
      const { current } = useMap();
      return (
        <button
          id="center"
          onClick={() =>
            t.log(
              "center",
              current
                ?.getCenter()
                .toArray()
                .map((n) => n.toFixed(2)),
            )
          }
        >
          center
        </button>
      );
    }
    let loaded = false;
    mount(
      t,
      <MapGL
        initialViewState={{ longitude: -0.1, latitude: 51.5, zoom: 5 }}
        style={{ width: 200, height: 120 }}
        mapStyle={{
          version: 8,
          sources: {},
          layers: [{ id: "bg", type: "background", paint: { "background-color": "#ccc" } }],
        }}
        onLoad={() => ((loaded = true), t.log("load"))}
        onError={(e) => t.log("error", e.error.message)}
        attributionControl={false}
      >
        <Marker longitude={-0.1} latitude={51.5}>
          <b id="pin">pin</b>
        </Marker>
        <Center />
      </MapGL>,
    );
    await until(() => loaded, 5000);
    await frames(2);
    t.$("#center").click();
    t.log("pin", t.$("#pin").parentElement?.className);
  },

  // Font Awesome icons: SVGs from icon definitions, with size, rotation, spin and a title.
  async "@fortawesome/react-fontawesome: icons, size, spin, title"(t) {
    function App() {
      const [busy, setBusy] = useState(false);
      return (
        <div>
          <FontAwesomeIcon icon={busy ? faSpinner : faCoffee} size="lg" spin={busy} title={busy ? "busy" : "coffee"} />
          <FontAwesomeIcon icon={faCoffee} rotation={90} fixedWidth />
          <button id="busy" onClick={() => setBusy(true)}>
            busy
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("coffee");
    t.$("#busy").click();
    await t.step("spinner");
  },

  // A class component that wraps its child's click to copy text: the copy event's data and the
  // result. A blocked copy falls back to window.prompt, which is stubbed.
  async "react-copy-to-clipboard: copy on click"(t) {
    const prompt = window.prompt;
    window.prompt = (_m?: string, v?: string) => (t.log("prompt", v ?? ""), null);
    const onCopy = (e: ClipboardEvent) => t.log("copy event", e.clipboardData?.getData("text/plain") ?? "");
    document.addEventListener("copy", onCopy);
    mount(
      t,
      <CopyToClipboard text="copied text" onCopy={(text, result) => t.log("onCopy", text, typeof result)}>
        <button id="copy">copy</button>
      </CopyToClipboard>,
    );
    t.$("#copy").click();
    await t.step("copied");
    document.removeEventListener("copy", onCopy);
    window.prompt = prompt;
  },

  // Tooltips on anchors chosen by attribute: shown on hover with its content, positioned by
  // floating-ui, and hidden when the pointer leaves.
  async "react-tooltip: hover anchors, content, hide"(t) {
    // Hiding ends after a transition: the scenario waits for both the event and the removal.
    let hidden = false;
    mount(
      t,
      <div style={{ padding: 40 }}>
        <button id="a" data-tooltip-id="tip" data-tooltip-content="first tip">
          a
        </button>
        <button id="b" data-tooltip-id="tip" data-tooltip-content="second tip">
          b
        </button>
        <Tooltip
          id="tip"
          place="bottom"
          delayShow={0}
          delayHide={0}
          afterShow={() => t.log("shown")}
          afterHide={() => (hidden = true)}
        />
      </div>,
    );
    await t.step("idle");
    mouse(t.$("#a"), "mouseover");
    mouse(t.$("#a"), "mouseenter");
    await wait(100);
    t.log("tip", document.querySelector("[role=tooltip]")?.textContent ?? "none");
    mouse(t.$("#a"), "mouseout");
    mouse(t.$("#a"), "mouseleave");
    mouse(t.$("#b"), "mouseover");
    mouse(t.$("#b"), "mouseenter");
    await wait(100);
    t.log("tip", document.querySelector("[role=tooltip]")?.textContent ?? "none");
    mouse(t.$("#b"), "mouseout");
    mouse(t.$("#b"), "mouseleave");
    await until(() => hidden && document.querySelector("[role=tooltip]") === null, 3000);
    t.log("hidden", hidden, "tip", document.querySelector("[role=tooltip]")?.textContent ?? "none");
  },

  // Colour pickers from class components: a hex typed into the Sketch picker's field and a
  // swatch clicked in the Circle picker.
  async "react-color: Sketch hex input, Circle swatch"(t) {
    function App() {
      const [color, setColor] = useState("#336699");
      return (
        <div>
          <SketchPicker
            color={color}
            onChangeComplete={(c) => (t.log("sketch", c.hex), setColor(c.hex))}
            disableAlpha
          />
          <CirclePicker color={color} onChangeComplete={(c) => (t.log("circle", c.hex), setColor(c.hex))} />
          <p id="color">{color}</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    const hex = t.root.querySelector<HTMLInputElement>(".flexbox-fix input")!;
    type(hex, "ff0000");
    await wait(200);
    await t.step("typed a hex");
    t.root.querySelector<HTMLElement>('[title="#2196f3"]')!.click();
    await wait(200);
    await t.step("clicked a swatch");
  },

  // Snackbars queued from outside React: shown up to the limit, one closed by its key, and the
  // rest closed together.
  async "notistack: enqueue, max snack, close"(t) {
    mount(t, <SnackbarProvider maxSnack={2} autoHideDuration={null} transitionDuration={{ enter: 0, exit: 0 }} />);
    enqueueSnackbar("one");
    const two = enqueueSnackbar("two", { variant: "success" });
    enqueueSnackbar("three", { variant: "error" });
    await wait(100);
    await t.step("two shown");
    closeSnackbar(two);
    await wait(300);
    await t.step("closed two");
    closeSnackbar();
    await wait(300);
    await t.step("closed all");
  },

  // FullCalendar v7's month grid for a fixed date, with events, a click on an event, and a move
  // to the next month through its API.
  async "@fullcalendar/react: month grid, events, navigation"(t) {
    const ref = { current: null as FullCalendar | null };
    mount(
      t,
      <FullCalendar
        ref={(c) => void (ref.current = c)}
        plugins={[dayGridPlugin]}
        initialView="dayGridMonth"
        initialDate="2026-01-15"
        timeZone="UTC"
        events={[
          { id: "a", title: "Launch", start: "2026-01-20" },
          { id: "b", title: "Review", start: "2026-02-03" },
        ]}
        eventClick={(info) => t.log("event", info.event.title)}
        datesSet={(info) => t.log("dates", info.view.title)}
        height={400}
      />,
    );
    // An event's title is the text of an element with no children.
    const titles = () =>
      [...t.root.querySelectorAll<HTMLElement>("*")].filter(
        (e) => e.children.length === 0 && /^(Launch|Review)$/.test(e.textContent ?? ""),
      );
    await until(() => titles().length > 0, 2000);
    await frames(2);
    t.log(
      "events",
      titles().map((e) => e.textContent),
    );
    titles()[0]?.click();
    ref.current?.getApi().next();
    await until(() => titles()[0]?.textContent === "Review", 2000);
    await frames(2);
    t.log(
      "events",
      titles().map((e) => e.textContent),
    );
    t.log("cells", t.root.querySelectorAll("[data-date]").length);
  },

  // Accessible tabs: a click, arrow-key moves between tabs, a disabled tab skipped, and the
  // panel shown for each.
  async "react-tabs: click, arrow keys, disabled tab"(t) {
    mount(
      t,
      <Tabs onSelect={(i, last) => t.log("select", i, last)}>
        <TabList>
          <Tab>One</Tab>
          <Tab disabled>Two</Tab>
          <Tab>Three</Tab>
        </TabList>
        <TabPanel>first</TabPanel>
        <TabPanel>second</TabPanel>
        <TabPanel>third</TabPanel>
      </Tabs>,
    );
    await t.step("first");
    const tabs = t.root.querySelectorAll<HTMLElement>("[role=tab]");
    tabs[2]!.click();
    await t.step("clicked three");
    keyWithCode(tabs[2]!, "ArrowLeft", 37);
    await t.step("arrow left");
    t.log("focus", active());
  },

  // A windowed list from react-virtualized's class components: the rows in view, and the rows
  // and events after a scroll.
  async "react-virtualized: List, scroll, rows rendered"(t) {
    mount(
      t,
      <VirtualList
        width={200}
        height={100}
        rowCount={1000}
        rowHeight={20}
        className="list"
        onRowsRendered={({ startIndex, stopIndex }) => t.log("rows", startIndex, stopIndex)}
        onScroll={({ scrollTop }) => t.log("scroll", scrollTop)}
        rowRenderer={({ key, index, style }) => (
          <div key={key} style={style}>
            row {index}
          </div>
        )}
      />,
    );
    await frames(2);
    await t.step("top");
    // A user's scroll: the list renders the rows in view from the scroll event.
    t.$(".list").scrollTop = 10000;
    await wait(100);
    await frames(2);
    await t.step("scrolled");
  },
};

// #endregion
