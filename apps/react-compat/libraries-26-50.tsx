// Scenarios with the React libraries ranked 26th to 50th by npm weekly downloads, chosen as the
// first 25 in ./libraries-1-25.tsx were: one package per project, libraries an app imports itself;
// not dependencies of other libraries, frameworks, renderers (react-reconciler, react-native,
// @react-three/fiber), build or test tools.
//
//   2026-10-29: @tiptap/react, swr, react-i18next, react-error-boundary, @xyflow/react,
//   react-dropzone, styled-components, react-aria, @mui/material, qrcode.react,
//   @stripe/react-stripe-js, react-select, react-textarea-autosize, react-icons,
//   @vercel/analytics, react-draggable, react-syntax-highlighter, @headlessui/react, react-pdf,
//   jotai, react-colorful, react-window, @apollo/client, @lexical/react and react-number-format.
//
// They run like the scenarios in ./libraries-1-25.tsx: the same code on React 19 and on each runtime,
// with every log and step compared.

import { ApolloClient, ApolloLink, gql, InMemoryCache } from "@apollo/client";
import { ApolloProvider, useMutation, useQuery } from "@apollo/client/react";
import {
  Dialog as HeadlessDialog,
  DialogPanel,
  DialogTitle as HeadlessDialogTitle,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Switch,
} from "@headlessui/react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  Button as MuiButton,
  Checkbox,
  createTheme,
  Dialog as MuiDialog,
  DialogContent,
  DialogTitle as MuiDialogTitle,
  TextField,
  ThemeProvider as MuiThemeProvider,
} from "@mui/material";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { track } from "@vercel/analytics";
import { Analytics } from "@vercel/analytics/react";
import { type Edge, type Node, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import i18next from "i18next";
import { atom, createStore, Provider as JotaiProvider, useAtom, useAtomValue } from "jotai";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $selectAll,
  FORMAT_TEXT_COMMAND,
  UNDO_COMMAND,
} from "lexical";
// pdf.js runs its worker on the main thread when this module has set globalThis.pdfjsWorker: a
// worker script cannot start in the check's about:blank page.
import "pdfjs-dist/build/pdf.worker.min.mjs";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { type ReactNode, Suspense, useRef, useState } from "react";
import {
  FocusScope,
  I18nProvider,
  mergeProps,
  useButton,
  useDateFormatter,
  useFocusRing,
  useNumberFormatter,
  useTextField,
  VisuallyHidden,
} from "react-aria";
import { HexColorInput, HexColorPicker } from "react-colorful";
import Draggable from "react-draggable";
import { useDropzone } from "react-dropzone";
import { ErrorBoundary, useErrorBoundary } from "react-error-boundary";
import { I18nextProvider, initReactI18next, Trans, useTranslation } from "react-i18next";
import { IconContext } from "react-icons";
import { FaBeer, FaCheck } from "react-icons/fa";
import { NumericFormat, PatternFormat } from "react-number-format";
import { Document, Page } from "react-pdf";
import Select from "react-select";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import tsxLanguage from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import TextareaAutosize from "react-textarea-autosize";
import { List, type RowComponentProps, useListRef } from "react-window";
import { Observable } from "rxjs";
import styled, { createGlobalStyle, css, keyframes, ThemeProvider } from "styled-components";
import useSWR, { SWRConfig, useSWRConfig } from "swr";

import { type T, type } from "./cases.tsx";
import { digest, frames, key, keyWithCode, mount, mouse, until, wait } from "./helpers.tsx";

/** A PDF of one page per text, each line drawn in Helvetica, with a valid cross-reference table. */
function tinyPdf(pages: string[]): Uint8Array {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 18 Tf 20 40 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// #region Scenarios

/** The scenarios by name, run after ./libraries-1-25.tsx's. */
export const libraries26To50: Record<string, (t: T) => Promise<void>> = {
  // Data fetching through useSyncExternalStore: loading, errors, a shared cache between two hooks
  // with the same key, revalidation, and mutation from inside and outside the component.
  async "swr: fetch, shared cache, errors, mutate"(t) {
    let calls = 0;
    const fetcher = async (k: string) => {
      const n = ++calls;
      await wait(50);
      if (k === "/bad") throw new Error("bad key");
      return `${k}#${n}`;
    };
    function Data({ k, id }: { k: string; id: string }) {
      const { data, error, isLoading, mutate } = useSWR(k, fetcher);
      return (
        <p id={id} onClick={() => void mutate()}>
          {isLoading ? "loading" : error ? "error " + (error as Error).message : data}
        </p>
      );
    }
    function Local() {
      const { mutate } = useSWRConfig();
      return (
        <button id="local" onClick={() => void mutate("/a", "local", { revalidate: false })}>
          local
        </button>
      );
    }
    function App() {
      const [two, setTwo] = useState(false);
      return (
        <SWRConfig
          value={{
            provider: () => new Map(),
            dedupingInterval: 0,
            revalidateOnFocus: false,
            revalidateOnReconnect: false,
            shouldRetryOnError: false,
          }}
        >
          <Data k="/a" id="a" />
          <Data k="/bad" id="bad" />
          {two && <Data k="/a" id="a2" />}
          <button id="two" onClick={() => setTwo(true)}>
            two
          </button>
          <Local />
        </SWRConfig>
      );
    }
    mount(t, <App />);
    await t.step("loading");
    await wait(150);
    await t.step("loaded");
    t.$("#two").click();
    await t.step("second hook, from the cache");
    await wait(150);
    await t.step("second hook revalidated");
    t.$("#a").click();
    await wait(150);
    await t.step("mutated by refetch");
    t.$("#local").click();
    await t.step("mutated locally");
    t.log("calls", calls);
  },

  // A provider, hooks, pluralization, interpolation, <Trans> with components, and a language
  // change that renders every consumer again.
  async "react-i18next: translate, plurals, Trans, change language"(t) {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({
      lng: "en",
      resources: {
        en: {
          translation: {
            hello: "Hello {{name}}",
            items_one: "{{count}} item",
            items_other: "{{count}} items",
            rich: "Read <1>the docs</1> now",
          },
        },
        fr: {
          translation: {
            hello: "Bonjour {{name}}",
            items_one: "{{count}} article",
            items_other: "{{count}} articles",
            rich: "Lisez <1>la doc</1> maintenant",
          },
        },
      },
      interpolation: { escapeValue: false },
    });
    function App() {
      const { t: tr, i18n: inst } = useTranslation();
      const [n, setN] = useState(1);
      return (
        <div>
          <p>{tr("hello", { name: "Ann" })}</p>
          <p>{tr("items", { count: n })}</p>
          <p>
            <Trans i18nKey="rich">
              Read <a href="#docs">the docs</a> now
            </Trans>
          </p>
          <button id="more" onClick={() => setN(n + 1)}>
            more
          </button>
          <button id="fr" onClick={() => void inst.changeLanguage("fr")}>
            fr
          </button>
        </div>
      );
    }
    mount(
      t,
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );
    await t.step("english");
    t.$("#more").click();
    await t.step("plural");
    t.$("#fr").click();
    await wait(10);
    await t.step("french");
  },

  // A class error boundary from a library: render errors, errors shown from an event handler,
  // reset by its button and by resetKeys.
  async "react-error-boundary: fallback, showBoundary, reset, resetKeys"(t) {
    function Bomb({ explode }: { explode: boolean }) {
      if (explode) throw new Error("boom");
      return <span>fine</span>;
    }
    function Later() {
      const { showBoundary } = useErrorBoundary();
      return (
        <button id="later" onClick={() => showBoundary(new Error("from a handler"))}>
          later
        </button>
      );
    }
    function App() {
      const [explode, setExplode] = useState(false);
      const [k, setK] = useState(0);
      return (
        <div>
          <button id="explode" onClick={() => setExplode(true)}>
            explode
          </button>
          <button id="key" onClick={() => (setExplode(false), setK(k + 1))}>
            key
          </button>
          <ErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
              <p role="alert">
                {(error as Error).message}
                <button id="reset" onClick={resetErrorBoundary}>
                  reset
                </button>
              </p>
            )}
            onError={(e) => t.log("caught", (e as Error).message)}
            onReset={(d) => (t.log("reset", d.reason), setExplode(false))}
            resetKeys={[k]}
          >
            <Bomb explode={explode} />
            <Later />
          </ErrorBoundary>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("fine");
    t.$("#explode").click();
    await t.step("exploded");
    t.$("#reset").click();
    await t.step("reset by its button");
    t.$("#later").click();
    await t.step("shown from a handler");
    t.$("#key").click();
    await t.step("reset by a key");
  },

  // Atoms in a store: derived atoms, an async atom that suspends, renders limited to the
  // components whose atoms changed, and writes from outside React.
  async "jotai: atoms, derived, async with Suspense, store writes"(t) {
    const count = atom(0);
    const doubled = atom((get) => get(count) * 2);
    const later = atom(async (get) => {
      const c = get(count);
      await wait(50);
      return "async " + c;
    });
    const store = createStore();
    const renders: string[] = [];
    function Counter() {
      const [c, setC] = useAtom(count);
      renders.push("counter");
      return (
        <button id="inc" onClick={() => setC((x) => x + 1)}>
          {c}
        </button>
      );
    }
    function Double() {
      renders.push("double");
      return <b>{useAtomValue(doubled)}</b>;
    }
    function Other() {
      renders.push("other");
      return <i>other</i>;
    }
    function Later() {
      return <em>{useAtomValue(later)}</em>;
    }
    mount(
      t,
      <JotaiProvider store={store}>
        <Counter />
        <Double />
        <Other />
        <Suspense fallback={<em>loading</em>}>
          <Later />
        </Suspense>
      </JotaiProvider>,
    );
    await t.step("mounted");
    await wait(150);
    await t.step("async loaded");
    t.log(renders.splice(0).join(" "));
    t.$("#inc").click();
    await wait(150);
    await t.step("incremented");
    t.log(renders.splice(0).join(" "));
    store.set(count, 10);
    await wait(150);
    await t.step("set from the store");
    t.log(renders.splice(0).join(" "), store.get(doubled));
  },

  // Icon components rendering SVG, with props and the IconContext provider's defaults.
  async "react-icons: icons, props, IconContext"(t) {
    function App() {
      const [color, setColor] = useState("red");
      return (
        <IconContext.Provider value={{ color, size: "2em", className: "icon" }}>
          <FaBeer title="beer" />
          <FaCheck size={12} style={{ verticalAlign: "middle" }} />
          <button id="blue" onClick={() => setColor("blue")}>
            blue
          </button>
        </IconContext.Provider>
      );
    }
    mount(t, <App />);
    await t.step("red");
    t.$("#blue").click();
    await t.step("blue");
  },

  // QR codes as SVG and on a canvas, drawn in an effect, and redrawn when the value changes.
  async "qrcode.react: SVG and canvas, value updates"(t) {
    function App() {
      const [value, setValue] = useState("https://example.com/a");
      return (
        <div>
          <QRCodeSVG value={value} size={64} level="M" title="code" />
          <QRCodeCanvas id="canvas" value={value} size={64} marginSize={2} />
          <button id="next" onClick={() => setValue("https://example.com/b")}>
            next
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("a");
    t.log("canvas", digest((t.$("#canvas") as HTMLCanvasElement).toDataURL()));
    t.$("#next").click();
    await t.step("b");
    t.log("canvas", digest((t.$("#canvas") as HTMLCanvasElement).toDataURL()));
  },

  // A textarea that measures a hidden copy of itself to grow with its content, between min
  // and max rows, reporting height changes.
  async "react-textarea-autosize: grows and shrinks with content"(t) {
    function App() {
      const [v, setV] = useState("one");
      return (
        <TextareaAutosize
          id="ta"
          minRows={1}
          maxRows={4}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onHeightChange={(h) => t.log("height", h)}
          style={{ font: "16px monospace", lineHeight: "20px", padding: 0, border: 0, width: 200 }}
        />
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("one line");
    type(t.$("#ta"), "one\ntwo\nthree");
    await frames(2);
    await t.step("three lines");
    type(t.$("#ta"), "1\n2\n3\n4\n5\n6");
    await frames(2);
    await t.step("capped at four rows");
    type(t.$("#ta"), "x");
    await frames(2);
    await t.step("back to one");
  },

  // A color picker driven by the keyboard on its sliders, and a hex input that only reports
  // valid colors.
  async "react-colorful: picker keyboard, hex input"(t) {
    function App() {
      const [color, setColor] = useState("#336699");
      return (
        <div>
          <HexColorPicker color={color} onChange={(c) => (t.log("change", c), setColor(c))} />
          <HexColorInput id="hex" color={color} onChange={setColor} />
          <p id="value">{color}</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    const [saturation, hue] = document.querySelectorAll<HTMLElement>(".react-colorful [role=slider]");
    keyWithCode(saturation!, "ArrowRight", 39);
    await t.step("saturation right");
    keyWithCode(hue!, "ArrowLeft", 37);
    await t.step("hue left");
    type(t.$("#hex"), "12");
    await t.step("partial hex");
    type(t.$("#hex"), "ff0000");
    t.$("#hex").dispatchEvent(new Event("blur"));
    await t.step("full hex");
  },

  // Formatted inputs: thousands separators and a prefix, a pattern with a mask, and the raw
  // values reported alongside the formatted ones.
  async "react-number-format: numeric and pattern formats"(t) {
    function App() {
      const [n, setN] = useState<string>("1234.5");
      return (
        <div>
          <NumericFormat
            id="num"
            value={n}
            thousandSeparator=","
            prefix="$"
            decimalScale={2}
            fixedDecimalScale
            onValueChange={(v, s) => (t.log("num", v.value, v.formattedValue, s.source), setN(v.value))}
          />
          <PatternFormat
            id="phone"
            format="+1 (###) ###-####"
            mask="_"
            onValueChange={(v) => t.log("phone", v.value, v.formattedValue)}
          />
        </div>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    type(t.$("#num"), "$9876543");
    await t.step("typed a number");
    type(t.$("#phone"), "555");
    await t.step("typed a phone prefix");
  },

  // A virtualized list: only the rows in view render, scrolling renders others, and an
  // imperative ref scrolls to a row.
  async "react-window: virtual rows, scroll, scrollToRow"(t) {
    function Row({ index, style, label }: RowComponentProps<{ label: string }>) {
      return (
        <div className="row" style={style}>
          {label} {index}
        </div>
      );
    }
    function App() {
      const ref = useListRef(null);
      return (
        <div>
          <List
            listRef={ref}
            rowComponent={Row}
            rowCount={1000}
            rowHeight={20}
            rowProps={{ label: "row" }}
            overscanCount={1}
            style={{ height: 100 }}
            onRowsRendered={(v) => t.log("rendered", v.startIndex, v.stopIndex)}
          />
          <button id="jump" onClick={() => ref.current?.scrollToRow({ index: 500, align: "start" })}>
            jump
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(3);
    t.log("rows", document.querySelectorAll(".row").length);
    const list =
      t.root.querySelector<HTMLElement>("[role=list]") ?? (t.root.firstElementChild!.firstElementChild as HTMLElement);
    list.scrollTop = 400;
    list.dispatchEvent(new Event("scroll"));
    await frames(3);
    t.log("first", document.querySelector(".row")!.textContent);
    t.$("#jump").click();
    await frames(3);
    t.log("first", document.querySelector(".row")!.textContent, "rows", document.querySelectorAll(".row").length);
    await t.step("jumped");
  },

  // Styled components: props and transient props, a theme, css and keyframes helpers, attrs, the
  // `as` prop, extending, and global styles. Class names hash the styles, so they match across
  // runtimes.
  async "styled-components: props, theme, as, extend, global"(t) {
    const fade = keyframes`from { opacity: 0 } to { opacity: 1 }`;
    const Button = styled.button.attrs({ type: "button" })<{ $primary?: boolean }>`
      color: ${(p) => (p.$primary ? "white" : (p.theme as { fg: string }).fg)};
      background: ${(p) => (p.$primary ? "rgb(0, 0, 255)" : "transparent")};
      ${(p) =>
        p.disabled &&
        css`
          opacity: 0.5;
        `}
    `;
    const Fading = styled.i`
      animation: ${fade} 1s paused;
    `;
    const Big = styled(Button)`
      font-size: 20px;
    `;
    const Global = createGlobalStyle`.styled-global { font-weight: 700; }`;
    function App() {
      const [fg, setFg] = useState("rgb(255, 0, 0)");
      const [primary, setPrimary] = useState(false);
      return (
        <ThemeProvider theme={{ fg }}>
          <Global />
          <Fading id="fading">fading</Fading>
          <Button id="b" $primary={primary} onClick={() => setPrimary(!primary)}>
            toggle
          </Button>
          <Big id="big" disabled>
            big
          </Big>
          <Button as="a" id="link" href="#x">
            link
          </Button>
          <span className="styled-global" id="g">
            global
          </span>
          <button id="green" onClick={() => setFg("rgb(0, 128, 0)")}>
            green
          </button>
        </ThemeProvider>
      );
    }
    mount(t, <App />);
    const style = (sel: string, prop: string) => getComputedStyle(t.$(sel)).getPropertyValue(prop);
    await t.step("initial");
    t.log(style("#b", "color"), style("#big", "font-size"), style("#big", "opacity"), style("#g", "font-weight"));
    t.log(style("#fading", "animation-play-state"), style("#fading", "animation-name") !== "none");
    t.$("#b").click();
    await t.step("primary");
    t.log(style("#b", "color"), style("#b", "background-color"));
    t.$("#green").click();
    await t.step("theme changed");
    t.log(style("#link", "color"));
  },

  // A select with its own menu: opened by the mouse, filtered by typing, chosen by the keyboard
  // and by a click, and a multi select with removable values.
  async "react-select: open, filter, keyboard, multi"(t) {
    const options = [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
      { value: "c", label: "Cherry" },
    ];
    function App() {
      return (
        <div>
          <Select
            instanceId="one"
            inputId="one-input"
            classNamePrefix="one"
            options={options}
            onChange={(v) => t.log("one", v?.value)}
          />
          <Select
            instanceId="many"
            inputId="many-input"
            classNamePrefix="many"
            isMulti
            options={options}
            defaultValue={[options[0]!, options[1]!]}
            onChange={(v) => t.log("many", v.map((o) => o.value).join(","))}
          />
        </div>
      );
    }
    mount(t, <App />);
    await t.step("closed");
    mouse(t.$(".one__control"), "mousedown");
    await t.step("opened by the mouse");
    type(t.$("#one-input"), "an");
    await t.step("filtered");
    key(t.$("#one-input"), "ArrowDown");
    key(t.$("#one-input"), "Enter");
    await t.step("chosen by the keyboard");
    mouse(t.$(".one__control"), "mousedown");
    await t.step("opened again");
    t.$(".one__option:first-child").click();
    await t.step("chosen by a click");
    mouse(t.$(".many__multi-value__remove"), "mousedown");
    t.$(".many__multi-value__remove").click();
    await t.step("removed a value");
  },
  // Material UI: emotion styles from a theme, a ripple on press, a text field whose label moves
  // when it is focused and filled, a controlled checkbox, and a dialog that portals into a
  // container and closes on Escape.
  async "@mui/material: theme, ripple, text field, checkbox, dialog"(t) {
    const theme = createTheme({ palette: { primary: { main: "#336699" } } });
    function App() {
      const [open, setOpen] = useState(false);
      const [checked, setChecked] = useState(false);
      const [name, setName] = useState("");
      return (
        <MuiThemeProvider theme={theme}>
          <MuiButton id="open" variant="contained" onClick={() => setOpen(true)}>
            Open
          </MuiButton>
          <Checkbox id="check" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <TextField id="name" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <MuiDialog
            open={open}
            container={t.other}
            transitionDuration={0}
            onClose={(_, reason) => (t.log("close", reason), setOpen(false))}
          >
            <MuiDialogTitle>Hello {name}</MuiDialogTitle>
            <DialogContent>content</DialogContent>
          </MuiDialog>
        </MuiThemeProvider>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    mouse(t.$("#open"), "mousedown", 20, 20);
    await t.step("ripple");
    mouse(t.$("#open"), "mouseup", 20, 20);
    await wait(700);
    await t.step("ripple gone");
    t.$("#name").focus();
    type(t.$("#name"), "Ann");
    await t.step("typed");
    t.$("#check").click();
    await t.step("checked");
    t.$("#open").click();
    await wait(50);
    await t.step("dialog open");
    key(t.other.querySelector("[role=dialog]")!, "Escape");
    await wait(50);
    await t.step("dialog closed");
  },

  // React Aria's hooks: press events from clicks and keys, a labelled text field, focus rings,
  // a focus scope that contains Tab and restores focus, and locale-aware formatting.
  async "react-aria: press, text field, focus scope, i18n"(t) {
    function AriaButton(props: { id: string; onPress: () => void; children: ReactNode }) {
      const ref = useRef<HTMLButtonElement>(null);
      const { buttonProps, isPressed } = useButton(props, ref);
      const { focusProps, isFocusVisible } = useFocusRing();
      return (
        <button
          {...mergeProps(buttonProps, focusProps)}
          id={props.id}
          ref={ref}
          data-pressed={isPressed}
          data-focus-visible={isFocusVisible}
        >
          {props.children}
        </button>
      );
    }
    function Field() {
      const ref = useRef<HTMLInputElement>(null);
      const { labelProps, inputProps, descriptionProps } = useTextField({ label: "Email", description: "work" }, ref);
      return (
        <div>
          <label {...labelProps}>Email</label>
          <input {...inputProps} className="email" ref={ref} />
          <span {...descriptionProps}>work</span>
        </div>
      );
    }
    function Formats() {
      const n = useNumberFormatter({ style: "currency", currency: "EUR" });
      const d = useDateFormatter({ dateStyle: "long", timeZone: "UTC" });
      return (
        <p id="formats">
          {n.format(1234.5)} {d.format(new Date(Date.UTC(2026, 0, 2)))}
        </p>
      );
    }
    function App() {
      const [locale, setLocale] = useState("en-US");
      const [scope, setScope] = useState(false);
      return (
        <I18nProvider locale={locale}>
          <AriaButton id="press" onPress={() => t.log("pressed")}>
            press
          </AriaButton>
          <AriaButton id="de" onPress={() => setLocale("de-DE")}>
            de
          </AriaButton>
          <AriaButton id="scope" onPress={() => setScope(!scope)}>
            scope
          </AriaButton>
          <Field />
          <Formats />
          <VisuallyHidden>hidden text</VisuallyHidden>
          {scope && (
            <FocusScope contain restoreFocus autoFocus>
              <input id="first" />
              <input id="second" />
              <AriaButton id="close" onPress={() => setScope(false)}>
                close
              </AriaButton>
            </FocusScope>
          )}
        </I18nProvider>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    t.$("#press").click();
    await t.step("clicked");
    t.$("#press").focus();
    key(t.$("#press"), "Enter");
    t.$("#press").dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    await t.step("pressed by a key");
    t.$("#de").click();
    await t.step("german");
    t.$("#scope").focus();
    t.$("#scope").click();
    await frames(2);
    await t.step("scope open");
    t.log("focus", document.activeElement?.id);
    t.$("#close").focus();
    key(t.$("#close"), "Tab");
    await frames(1);
    t.log("after tab", document.activeElement?.id);
    t.$("#close").click();
    await frames(2);
    await t.step("scope closed");
    t.log("focus", document.activeElement?.id);
  },

  // Headless UI: a menu driven by the keyboard, a switch, and a modal dialog that portals to the
  // body, traps focus and closes on Escape.
  async "@headlessui/react: menu, switch, dialog"(t) {
    function App() {
      const [on, setOn] = useState(false);
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Menu>
            <MenuButton id="menu">Options</MenuButton>
            <MenuItems className="items">
              {["Edit", "Delete"].map((x) => (
                <MenuItem key={x}>
                  <button className="item" onClick={() => t.log("chose", x)}>
                    {x}
                  </button>
                </MenuItem>
              ))}
            </MenuItems>
          </Menu>
          <Switch id="switch" checked={on} onChange={(v) => (t.log("switch", v), setOn(v))}>
            wifi
          </Switch>
          <button id="dialog" onClick={() => setOpen(true)}>
            dialog
          </button>
          <HeadlessDialog open={open} onClose={() => (t.log("dialog closed"), setOpen(false))}>
            <DialogPanel>
              <HeadlessDialogTitle>Title</HeadlessDialogTitle>
              <button id="inside">ok</button>
            </DialogPanel>
          </HeadlessDialog>
        </div>
      );
    }
    const dialog = () => document.querySelector("[role=dialog]")?.textContent ?? "none";
    mount(t, <App />);
    await t.step("initial");
    t.$("#menu").focus();
    key(t.$("#menu"), "ArrowDown");
    await frames(3);
    await t.step("menu open");
    t.log("focus", document.activeElement?.textContent);
    key(document.activeElement!, "ArrowDown");
    await frames(2);
    t.log("focus", document.activeElement?.textContent, document.querySelector("[data-focus]")?.textContent);
    key(document.activeElement!, "Enter");
    await frames(3);
    await t.step("menu chose");
    t.$("#switch").click();
    await t.step("switched");
    t.$("#dialog").click();
    await frames(4);
    t.log("dialog", dialog(), "focus", document.activeElement?.nodeName);
    key(document.activeElement ?? document.body, "Escape");
    await frames(4);
    await t.step("dialog closed");
    t.log("dialog", dialog());
  },

  // React Flow: nodes measured with ResizeObserver, edges between them, a click that selects a
  // node through the store's change events, and nodes added from outside the flow.
  async "@xyflow/react: nodes, edges, select, add"(t) {
    const initialNodes: Node[] = [
      { id: "1", position: { x: 0, y: 0 }, data: { label: "one" } },
      { id: "2", position: { x: 150, y: 100 }, data: { label: "two" } },
    ];
    const initialEdges: Edge[] = [{ id: "e1-2", source: "1", target: "2" }];
    function Flow() {
      const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
      const [edges, , onEdgesChange] = useEdgesState(initialEdges);
      return (
        <div>
          <div style={{ width: 400, height: 300 }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, n) => t.log("node click", n.id)}
              proOptions={{ hideAttribution: true }}
            />
          </div>
          <p id="selected">
            {nodes
              .filter((n) => n.selected)
              .map((n) => n.id)
              .join(",") || "none"}
          </p>
          <button
            id="add"
            onClick={() => setNodes((ns) => [...ns, { id: "3", position: { x: 0, y: 200 }, data: { label: "three" } }])}
          >
            add
          </button>
        </div>
      );
    }
    mount(t, <Flow />);
    await frames(4);
    await t.step("measured");
    t.root.querySelector<HTMLElement>('.react-flow__node[data-id="2"]')!.click();
    await frames(2);
    await t.step("selected two");
    t.$("#add").click();
    await frames(4);
    await t.step("added three");
    t.log(
      "nodes",
      t.root.querySelectorAll(".react-flow__node").length,
      "edges",
      t.root.querySelectorAll(".react-flow__edge").length,
    );
  },

  // A drop zone: drag state from dragenter, files read from a drop event, and accepted and
  // rejected files sorted by type.
  async "react-dropzone: drag state, drop, accept and reject"(t) {
    function App() {
      const { getRootProps, getInputProps, isDragActive, acceptedFiles, fileRejections } = useDropzone({
        accept: { "text/plain": [".txt"] },
        onDrop: (ok, bad) =>
          t.log(
            "drop",
            ok.map((f) => f.name).join(","),
            bad.map((r) => r.file.name + ":" + r.errors[0]?.code).join(","),
          ),
      });
      return (
        <div {...getRootProps({ id: "zone" })}>
          <input {...getInputProps()} />
          <p>{isDragActive ? "drop here" : "drag files"}</p>
          <ul>
            {acceptedFiles.map((f) => (
              <li key={f.name}>
                {f.name} {f.size}
              </li>
            ))}
          </ul>
          <p>{fileRejections.length} rejected</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("idle");
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "a.txt", { type: "text/plain" }));
    dt.items.add(new File(["x"], "b.png", { type: "image/png" }));
    const drag = (type: string) =>
      t.$("#zone").dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    drag("dragenter");
    drag("dragover");
    await wait(30);
    await t.step("dragging");
    drag("drop");
    await wait(30);
    await t.step("dropped");
  },

  // A draggable box (a class component) that follows the mouse within its parent's bounds,
  // through document listeners added on mousedown.
  async "react-draggable: drag within bounds"(t) {
    function App() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div style={{ position: "relative", width: 300, height: 200 }}>
          <Draggable
            nodeRef={ref}
            bounds="parent"
            onStart={(_, d) => t.log("start", d.x, d.y)}
            onDrag={(_, d) => t.log("drag", d.x, d.y)}
            onStop={(_, d) => t.log("stop", d.x, d.y)}
          >
            <div ref={ref} id="box" style={{ width: 50, height: 50 }}>
              box
            </div>
          </Draggable>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    const r = t.$("#box").getBoundingClientRect();
    mouse(t.$("#box"), "mousedown", r.left + 5, r.top + 5);
    await wait(0);
    mouse(document, "mousemove", r.left + 45, r.top + 25);
    await t.step("dragged");
    mouse(document, "mousemove", r.left + 500, r.top + 500);
    await t.step("dragging, clamped");
    mouse(document, "mouseup", r.left + 500, r.top + 500);
    await t.step("dropped");
  },

  // Highlighted code: Prism's tokens as styled spans, line numbers, and a language and code
  // change.
  async "react-syntax-highlighter: tokens, line numbers, updates"(t) {
    SyntaxHighlighter.registerLanguage("tsx", tsxLanguage);
    function App() {
      const [code, setCode] = useState("const a: number = 1;");
      return (
        <div>
          <SyntaxHighlighter language="tsx" style={oneLight} showLineNumbers customStyle={{ margin: 0 }}>
            {code}
          </SyntaxHighlighter>
          <button id="more" onClick={() => setCode("function f() {\n  return <b>{a}</b>;\n}")}>
            more
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("one line");
    t.$("#more").click();
    await t.step("jsx");
  },

  // Vercel Analytics: a component whose effect injects its script once and queues page views and
  // custom events until the script loads.
  async "@vercel/analytics: script injection, page views, events"(t) {
    function App() {
      const [path, setPath] = useState("/a");
      return (
        <div>
          <Analytics mode="production" route="/[id]" path={path} />
          <button id="next" onClick={() => setPath("/b")}>
            next
          </button>
        </div>
      );
    }
    const scripts = () =>
      [...document.querySelectorAll<HTMLScriptElement>("script[data-sdkn]")].map(
        (s) => s.getAttribute("src") + " " + s.dataset["sdkn"],
      );
    const queue = () => JSON.stringify((window as unknown as { vaq?: unknown[] }).vaq ?? []);
    mount(t, <App />);
    await t.step("mounted");
    t.log("scripts", scripts(), "queue", queue());
    track("signup", { plan: "pro" });
    t.$("#next").click();
    await t.step("navigated");
    t.log("scripts", scripts(), "queue", queue());
  },

  // Apollo Client: queries through a link, loading and data states, variables, a mutation that
  // refetches, and the normalized cache shared by two components.
  async "@apollo/client: query, variables, mutation, cache"(t) {
    const db = [
      { __typename: "Todo", id: "1", text: "one", done: false },
      { __typename: "Todo", id: "2", text: "two", done: true },
    ];
    const ops: string[] = [];
    const link = new ApolloLink(
      (op) =>
        new Observable((o) => {
          ops.push(op.operationName + " " + JSON.stringify(op.variables));
          const id = setTimeout(() => {
            if (op.operationName === "Todos") {
              const done = op.variables["done"] as boolean | undefined;
              o.next({
                data: { todos: db.filter((x) => done === undefined || x.done === done).map((x) => ({ ...x })) },
              });
            } else {
              const item = {
                __typename: "Todo",
                id: String(db.length + 1),
                text: op.variables["text"] as string,
                done: false,
              };
              db.push(item);
              o.next({ data: { add: { ...item } } });
            }
            o.complete();
          }, 50);
          return () => clearTimeout(id);
        }),
    );
    const client = new ApolloClient({ link, cache: new InMemoryCache() });
    const TODOS = gql`
      query Todos($done: Boolean) {
        todos(done: $done) {
          id
          text
          done
        }
      }
    `;
    const ADD = gql`
      mutation Add($text: String!) {
        add(text: $text) {
          id
          text
          done
        }
      }
    `;
    function Todos({ id, done }: { id: string; done?: boolean }) {
      const { data, loading } = useQuery<{ todos: { id: string; text: string }[] }>(TODOS, {
        variables: done === undefined ? {} : { done },
      });
      if (loading) return <p id={id}>loading</p>;
      return <p id={id}>{data?.todos.map((x) => x.text).join(",")}</p>;
    }
    function Add() {
      const [add, { loading }] = useMutation(ADD, { refetchQueries: ["Todos"], awaitRefetchQueries: true });
      return (
        <button id="add" onClick={() => void add({ variables: { text: "three" } })}>
          {loading ? "adding" : "add"}
        </button>
      );
    }
    function App() {
      const [open, setOpen] = useState(false);
      return (
        <ApolloProvider client={client}>
          <Todos id="all" />
          {open && <Todos id="open" done={false} />}
          <button id="filter" onClick={() => setOpen(true)}>
            filter
          </button>
          <Add />
        </ApolloProvider>
      );
    }
    mount(t, <App />);
    await t.step("loading");
    await wait(150);
    await t.step("loaded");
    t.$("#filter").click();
    await wait(150);
    await t.step("filtered");
    t.$("#add").click();
    await t.step("adding");
    await wait(300);
    await t.step("added");
    t.log(ops.join(" | "));
  },

  // Stripe Elements over a stand-in for Stripe.js: the provider creates elements once, a card
  // element is created, mounted, updated with new options and destroyed, and events reach props.
  async "@stripe/react-stripe-js: elements lifecycle on a stand-in Stripe"(t) {
    const calls: string[] = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const element = (kind: string) => ({
      mount: (n: HTMLElement) => calls.push(`mount ${kind} into ${n.nodeName.toLowerCase()}`),
      on: (ev: string, h: (e: unknown) => void) => ((handlers[ev] = h), calls.push("on " + ev)),
      off: (ev: string) => calls.push("off " + ev),
      update: (o: unknown) => calls.push("update " + JSON.stringify(o)),
      destroy: () => calls.push("destroy " + kind),
    });
    const stripe = {
      elements: (o: unknown) => (
        calls.push("elements " + JSON.stringify(o)),
        {
          create: (kind: string, o: unknown) => (calls.push(`create ${kind} ${JSON.stringify(o)}`), element(kind)),
          update: (o: unknown) => calls.push("elements update " + JSON.stringify(o)),
          getElement: () => null,
        }
      ),
      createToken: () => Promise.resolve({}),
      createPaymentMethod: () => Promise.resolve({}),
      confirmCardPayment: () => Promise.resolve({}),
      _registerWrapper: (w: { name: string }) => calls.push("wrapper " + w.name),
      registerAppInfo: (i: { name: string }) => calls.push("app " + i.name),
    };
    function Status() {
      const s = useStripe();
      const e = useElements();
      return (
        <p id="status">{`${s === (stripe as unknown) ? "stripe" : "none"} ${e === null ? "none" : "elements"}`}</p>
      );
    }
    function App() {
      const [show, setShow] = useState(true);
      const [color, setColor] = useState("black");
      return (
        <Elements stripe={stripe as never} options={{ locale: "en" }}>
          <Status />
          {show && (
            <CardElement
              options={{ style: { base: { color } }, hidePostalCode: true }}
              onChange={(e) => t.log("change", (e as { complete: boolean }).complete)}
              onReady={() => t.log("ready")}
            />
          )}
          <button id="color" onClick={() => setColor("red")}>
            color
          </button>
          <button id="hide" onClick={() => setShow(false)}>
            hide
          </button>
        </Elements>
      );
    }
    mount(t, <App />);
    await t.step("mounted");
    t.log(calls.splice(0).join(" | "));
    handlers["ready"]?.({ elementType: "card" });
    handlers["change"]?.({ elementType: "card", complete: true });
    await t.step("events");
    t.$("#color").click();
    await t.step("restyled");
    t.log(calls.splice(0).join(" | "));
    t.$("#hide").click();
    await t.step("removed");
    t.log(calls.splice(0).join(" | "));
  },

  // Tiptap: a ProseMirror editor that renders into its own DOM, selector state from
  // useEditorState, commands, and content replaced from outside.
  async "@tiptap/react: editor, commands, editor state"(t) {
    function Editor() {
      const editor = useEditor({
        extensions: [StarterKit],
        content: "<p>Hello <strong>world</strong></p>",
        immediatelyRender: true,
        shouldRerenderOnTransaction: false,
        onUpdate: ({ editor: e }) => t.log("update", e.getHTML()),
      });
      const bold = useEditorState({ editor, selector: (s) => s.editor?.isActive("bold") ?? false });
      return (
        <div>
          <EditorContent editor={editor} />
          <p id="bold">bold {String(bold)}</p>
          <button id="all-bold" onClick={() => editor?.chain().selectAll().toggleBold().run()}>
            bold
          </button>
          <button id="set" onClick={() => editor?.commands.setContent("<h2>Title</h2><ul><li><p>item</p></li></ul>")}>
            set
          </button>
          <button id="insert" onClick={() => editor?.chain().focus("end").insertContent(" more").run()}>
            insert
          </button>
        </div>
      );
    }
    mount(t, <Editor />);
    await t.step("initial");
    t.$("#all-bold").click();
    await t.step("all bold");
    t.$("#set").click();
    await t.step("replaced");
    t.$("#insert").click();
    await t.step("inserted");
  },

  // Lexical: a rich text editor with its own reconciler, updated through the composer context,
  // formatted by a command, undone through history, with changes reported by a plugin.
  async "@lexical/react: rich text, commands, history, change events"(t) {
    function Actions() {
      const [editor] = useLexicalComposerContext();
      return (
        <div>
          <button
            id="write"
            onClick={() =>
              editor.update(() => {
                const p = $createParagraphNode();
                p.append($createTextNode("hello lexical"));
                $getRoot().clear().append(p);
              })
            }
          >
            write
          </button>
          <button
            id="bold"
            onClick={() => {
              editor.update(() => $selectAll());
              editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
            }}
          >
            bold
          </button>
          <button id="undo" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
            undo
          </button>
        </div>
      );
    }
    function App() {
      return (
        <LexicalComposer
          initialConfig={{
            namespace: "check",
            onError: (e) => t.log("error", e.message),
            theme: { text: { bold: "b" } },
          }}
        >
          <RichTextPlugin
            contentEditable={<ContentEditable className="editor" />}
            placeholder={<p className="placeholder">Type here</p>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin delay={0} />
          <OnChangePlugin
            ignoreSelectionChange
            onChange={(state) =>
              t.log(
                "change",
                state.read(() => $getRoot().getTextContent()),
              )
            }
          />
          <Actions />
        </LexicalComposer>
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("empty");
    t.$("#write").click();
    await frames(2);
    await t.step("written");
    t.$("#bold").click();
    await frames(2);
    await t.step("bold");
    t.$("#undo").click();
    await frames(2);
    await t.step("undone");
  },

  // react-pdf: a PDF loaded and parsed by pdf.js (its worker on the main thread), a page with its
  // text layer, and a page change. The page is not drawn: when pdf.js sizes the canvas races the
  // effect that styles it, so its attribute order differs from run to run, on React too.
  async "react-pdf: document, page, text layer"(t) {
    const file = { data: tinyPdf(["first page", "second page"]) };
    function App() {
      const [page, setPage] = useState(1);
      return (
        <div>
          <Document
            file={file}
            onLoadSuccess={(pdf) => t.log("pages", pdf.numPages)}
            onLoadError={(e) => t.log("load error", e.message)}
            loading="loading pdf"
          >
            <Page
              pageNumber={page}
              width={200}
              renderMode="none"
              renderAnnotationLayer={false}
              onRenderSuccess={() => t.log("rendered", page)}
              onGetTextSuccess={(text) => t.log("text", text.items.map((i) => ("str" in i ? i.str : "")).join(""))}
            />
          </Document>
          <button id="next" onClick={() => setPage(2)}>
            next
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await until(() => t.root.querySelector(".textLayer span") !== null, 5000);
    await t.step("first page");
    t.$("#next").click();
    await until(() => t.root.querySelector(".textLayer")?.textContent?.includes("second") === true, 5000);
    await t.step("second page");
  },
};

// #endregion
