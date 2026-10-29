// Scenarios with the React libraries ranked 51st to 75th by npm weekly downloads, chosen as the
// first 25 in ./libraries-1-25.tsx were: one package per project, libraries an app imports itself;
// not dependencies of other libraries (react-popper), frameworks, renderers (@react-three/drei),
// build or test tools. Libraries whose peer range leaves React 19 out (react-quill,
// react-beautiful-dnd) and ones that need a hosted service (@clerk/clerk-react,
// @react-google-maps/api) are skipped for the next in line.
//
//   2026-10-29: @phosphor-icons/react, @react-spring/web, react-datepicker, react-dnd,
//   @vercel/speed-insights, @uiw/react-codemirror, react-intersection-observer,
//   react-hotkeys-hook, formik, react-chartjs-2, @heroicons/react, @tanstack/react-form,
//   downshift, react-grid-layout, swiper, react-helmet-async, react-leaflet, react-hot-toast,
//   react-easy-crop, react-toastify, @tabler/icons-react, antd, react-use, react-virtuoso and
//   @hello-pangea/dnd.
//
// They run like the scenarios in ./libraries-1-25.tsx: the same code on React 19 and on each
// runtime, with every log and step compared.

import { DragDropContext, Draggable as PangeaDraggable, Droppable } from "@hello-pangea/dnd";
import { BeakerIcon } from "@heroicons/react/24/solid";
import { Heart, IconContext as PhosphorContext } from "@phosphor-icons/react";
import { animated, useSpring, useTransition } from "@react-spring/web";
import { IconHome, IconStar } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";
import CodeMirror, { type EditorView } from "@uiw/react-codemirror";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Button as AntButton, ConfigProvider, Input as AntInput, Modal as AntModal, Switch as AntSwitch } from "antd";
import { BarElement, CategoryScale, Chart as ChartJS, LinearScale } from "chart.js";
import { useCombobox } from "downshift";
import { ErrorMessage, Field, Form, Formik } from "formik";
import { useRef, useState } from "react";
import { Bar } from "react-chartjs-2";
import DatePicker from "react-datepicker";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import Cropper from "react-easy-crop";
import { GridLayout } from "react-grid-layout";
import { Helmet, HelmetProvider } from "react-helmet-async";
import toast, { Toaster } from "react-hot-toast";
import { useHotkeys } from "react-hotkeys-hook";
import { InView, useInView } from "react-intersection-observer";
import { CircleMarker, MapContainer, Polygon, Popup, useMap } from "react-leaflet";
import { toast as toastify, ToastContainer } from "react-toastify";
import { useCounter, useList, usePrevious, useToggle } from "react-use";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Swiper, SwiperSlide } from "swiper/react";

import { type T, type } from "./cases.tsx";
import { digest, frames, key, keyWithCode, mount, until, wait } from "./helpers.tsx";

ChartJS.register(BarElement, CategoryScale, LinearScale);

/** A 4 by 4 PNG, for libraries that load an image. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";

/** A drag event of `type` carrying `dt`, as the browser fires it during a drag and drop. */
const drag = (el: Element, type: string, dt: DataTransfer, x = 0, y = 0) =>
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));

// #region Scenarios

/** The scenarios by name, run after ./libraries-26-50.tsx's. */
export const libraries51To75: Record<string, (t: T) => Promise<void>> = {
  // Icon components with weights and sizes, and defaults from a context provider.
  async "@phosphor-icons/react: icons, weights, context"(t) {
    function App() {
      const [weight, setWeight] = useState<"regular" | "bold">("regular");
      return (
        <PhosphorContext.Provider value={{ size: 24, color: "red", mirrored: false }}>
          <Heart weight={weight} />
          <Heart size={12} color="blue" weight="fill" alt="liked" />
          <button id="bold" onClick={() => setWeight("bold")}>
            bold
          </button>
        </PhosphorContext.Provider>
      );
    }
    mount(t, <App />);
    await t.step("regular");
    t.$("#bold").click();
    await t.step("bold");
  },

  // Springs driven by state and by an imperative API, and transitions that mount and unmount
  // items. Each animation is short, and steps read the values it settles on.
  async "@react-spring/web: springs, imperative api, transitions"(t) {
    function App() {
      const [on, setOn] = useState(false);
      const [items, setItems] = useState(["a"]);
      const style = useSpring({ opacity: on ? 1 : 0.5, width: on ? 100 : 50, config: { duration: 40 } });
      const [box, api] = useSpring(() => ({ x: 0, config: { duration: 40 } }));
      const transitions = useTransition(items, {
        from: { opacity: 0 },
        enter: { opacity: 1 },
        leave: { opacity: 0 },
        config: { duration: 40 },
        onRest: (_r, _c, item) => t.log("rest", item),
      });
      return (
        <div>
          <animated.div id="fade" style={style}>
            fade
          </animated.div>
          <animated.div id="box" style={{ transform: box.x.to((x) => `translateX(${x}px)`) }}>
            box
          </animated.div>
          {transitions((s, item) => (
            <animated.span style={s}>{item}</animated.span>
          ))}
          <button id="toggle" onClick={() => setOn(!on)}>
            toggle
          </button>
          <button id="move" onClick={() => void api.start({ x: 30 })}>
            move
          </button>
          <button id="swap" onClick={() => setItems(["b"])}>
            swap
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(200);
    await t.step("initial");
    t.$("#toggle").click();
    await wait(200);
    await t.step("toggled");
    t.$("#move").click();
    await wait(200);
    await t.step("moved");
    t.$("#swap").click();
    await wait(200);
    await t.step("swapped");
  },

  // An inline calendar for a fixed month: choosing a day, moving a month, and a controlled
  // input field that opens a popup calendar.
  async "react-datepicker: inline calendar, choose a day, month navigation"(t) {
    function App() {
      const [date, setDate] = useState<Date | null>(new Date(2026, 0, 15));
      return (
        <div>
          <DatePicker
            inline
            selected={date}
            onChange={(d: Date | null) => (t.log("chose", d?.toDateString() ?? "none"), setDate(d))}
          />
          <p id="value">{date?.toDateString()}</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("january");
    t.$(".react-datepicker__day--020:not(.react-datepicker__day--outside-month)").click();
    await t.step("chose the 20th");
    t.$(".react-datepicker__navigation--next").click();
    await t.step("february");
  },

  // Drag and drop through the HTML5 backend: a drag source, a drop target that highlights while
  // something hovers it, and the drop result.
  async "react-dnd: HTML5 drag source and drop target"(t) {
    function Card({ id }: { id: string }) {
      const [{ dragging }, ref] = useDrag(() => ({
        type: "card",
        item: { id },
        collect: (m) => ({ dragging: m.isDragging() }),
        end: (item, m) => t.log("end", item.id, m.didDrop()),
      }));
      return (
        <div ref={ref as unknown as React.Ref<HTMLDivElement>} id={"card-" + id} className={dragging ? "dragging" : ""}>
          {id}
        </div>
      );
    }
    function Bin() {
      const [dropped, setDropped] = useState<string[]>([]);
      const [{ over }, ref] = useDrop(() => ({
        accept: "card",
        drop: (item: { id: string }) => setDropped((d) => [...d, item.id]),
        collect: (m) => ({ over: m.isOver() }),
      }));
      return (
        <div ref={ref as unknown as React.Ref<HTMLDivElement>} id="bin" className={over ? "over" : ""}>
          bin: {dropped.join(",")}
        </div>
      );
    }
    mount(
      t,
      <DndProvider backend={HTML5Backend}>
        <Card id="a" />
        <Bin />
      </DndProvider>,
    );
    await t.step("idle");
    const dt = new DataTransfer();
    drag(t.$("#card-a"), "dragstart", dt);
    await frames(2);
    drag(t.$("#bin"), "dragenter", dt);
    drag(t.$("#bin"), "dragover", dt);
    await frames(2);
    await t.step("hovering");
    drag(t.$("#bin"), "drop", dt);
    drag(t.$("#card-a"), "dragend", dt);
    await frames(2);
    await t.step("dropped");
  },

  // Vercel Speed Insights: an effect that injects its script once and queues route changes.
  async "@vercel/speed-insights: script injection and routes"(t) {
    function App() {
      const [route, setRoute] = useState("/a");
      return (
        <div>
          <SpeedInsights route={route} sampleRate={1} />
          <button id="next" onClick={() => setRoute("/b")}>
            next
          </button>
        </div>
      );
    }
    const scripts = () =>
      [...document.querySelectorAll<HTMLScriptElement>("script[data-sdkn]")].map(
        (s) => `${s.getAttribute("src")} ${s.dataset["sdkn"]} ${s.dataset["route"] ?? ""}`,
      );
    const queue = () => JSON.stringify((window as unknown as { siq?: unknown[] }).siq ?? []);
    mount(t, <App />);
    await t.step("mounted");
    t.log("scripts", scripts(), "queue", queue());
    t.$("#next").click();
    await t.step("next route");
    t.log("scripts", scripts(), "queue", queue());
  },

  // CodeMirror 6 in a component: a controlled value, edits dispatched to the editor view, and
  // change events back to React.
  async "@uiw/react-codemirror: controlled value, edits, change events"(t) {
    let view: EditorView | undefined;
    function App() {
      const [value, setValue] = useState("let a = 1;");
      return (
        <div>
          <CodeMirror
            value={value}
            height="100px"
            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
            onCreateEditor={(v) => (view = v)}
            onChange={(v) => (t.log("change", v), setValue(v))}
          />
          <p id="value">{value}</p>
          <button id="reset" onClick={() => setValue("reset();")}>
            reset
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(2);
    t.log("doc", view?.state.doc.toString());
    view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\nlet b = 2;" } });
    await frames(2);
    await t.step("edited");
    // The wrapper holds back outside values after an edit, as it does while the user types, on a
    // latch that counts down once per interval tick (4 ms or more in a browser).
    await wait(1500);
    t.$("#reset").click();
    await frames(2);
    t.log("doc", view?.state.doc.toString());
    await t.step("reset");
  },

  // Visibility from IntersectionObserver: a hook and a render-prop component, inside a scrolling
  // root, updated as the root scrolls.
  async "react-intersection-observer: useInView and InView in a scroll root"(t) {
    function Watched({ root }: { root: Element | null }) {
      const { ref, inView } = useInView({ root, threshold: 0.5 });
      return (
        <div ref={ref} id="watched" style={{ height: 40, marginTop: 300 }}>
          watched {String(inView)}
        </div>
      );
    }
    function App() {
      const [root, setRoot] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setRoot} id="scroller" style={{ height: 100, overflow: "auto" }}>
          <div style={{ height: 20 }}>top</div>
          {root !== null && <Watched root={root} />}
          {root !== null && (
            <InView root={root} onChange={(v) => t.log("in view", v)}>
              {({ ref, inView }) => (
                <div ref={ref} style={{ height: 40 }}>
                  second {String(inView)}
                </div>
              )}
            </InView>
          )}
        </div>
      );
    }
    mount(t, <App />);
    await wait(100);
    await t.step("top");
    t.$("#scroller").scrollTop = 290;
    await wait(100);
    await t.step("scrolled");
  },

  // Keyboard shortcuts on the document: combinations, a callback that reads the latest state
  // through its dependencies, and shortcuts ignored while typing in a field.
  async "react-hotkeys-hook: combinations, dependencies, form fields"(t) {
    function App() {
      const [n, setN] = useState(0);
      const [step, setStep] = useState(1);
      useHotkeys("ctrl+k", () => setN((x) => x + step), [step]);
      useHotkeys("shift+a", () => t.log("shift a"));
      return (
        <div>
          <p id="n">{n}</p>
          <button id="step" onClick={() => setStep(10)}>
            step
          </button>
          <input id="field" />
        </div>
      );
    }
    const press = (el: EventTarget, k: string, code: string, mods: KeyboardEventInit) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...mods }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: k, code, bubbles: true, cancelable: true, ...mods }));
    };
    mount(t, <App />);
    press(document.body, "k", "KeyK", { ctrlKey: true });
    await t.step("ctrl k");
    t.$("#step").click();
    await t.step("step 10");
    press(document.body, "k", "KeyK", { ctrlKey: true });
    await t.step("ctrl k again");
    press(document.body, "A", "KeyA", { shiftKey: true });
    t.$("#field").focus();
    press(t.$("#field"), "k", "KeyK", { ctrlKey: true });
    await t.step("typing in a field");
  },

  // Formik: fields bound by name, validation on change and on submit, error messages, and an
  // async submit with its submitting state.
  async "formik: fields, validation, submit"(t) {
    function App() {
      return (
        <Formik
          initialValues={{ email: "", age: "" }}
          validate={(v) => {
            const e: Record<string, string> = {};
            if (!v.email.includes("@")) e["email"] = "invalid email";
            if (v.age !== "" && Number(v.age) < 18) e["age"] = "too young";
            return e;
          }}
          onSubmit={async (v, { setSubmitting }) => {
            await wait(10);
            t.log("submit", JSON.stringify(v));
            setSubmitting(false);
          }}
        >
          {({ isSubmitting, errors, touched }) => (
            <Form>
              <Field name="email" id="email" />
              <ErrorMessage name="email" component="p" />
              <Field name="age" id="age" type="number" />
              <ErrorMessage name="age" component="p" />
              <p id="touched">{JSON.stringify(touched)}</p>
              <p id="errors">{JSON.stringify(errors)}</p>
              <button id="submit" type="submit" disabled={isSubmitting}>
                send
              </button>
            </Form>
          )}
        </Formik>
      );
    }
    mount(t, <App />);
    await t.step("empty");
    t.$("#submit").click();
    await wait(50);
    await t.step("submitted empty");
    type(t.$("#email"), "a@b.c");
    type(t.$("#age"), "12");
    await wait(50);
    await t.step("typed");
    type(t.$("#age"), "30");
    await wait(50);
    t.$("#submit").click();
    await wait(80);
    await t.step("submitted valid");
  },

  // Chart.js through react-chartjs-2: a bar chart drawn on a canvas without animation, its data
  // updated from state, and the chart instance through a ref.
  async "react-chartjs-2: bar chart, data updates, chart ref"(t) {
    function App() {
      const [values, setValues] = useState([3, 1, 4]);
      const ref = useRef<ChartJS<"bar"> | null>(null);
      return (
        <div>
          <Bar
            ref={ref}
            width={200}
            height={100}
            options={{ animation: false, responsive: false, plugins: {} }}
            data={{
              labels: ["a", "b", "c"],
              datasets: [{ label: "n", data: values, backgroundColor: "rgb(0, 0, 255)" }],
            }}
          />
          <button id="more" onClick={() => setValues([5, 9, 2])}>
            more
          </button>
          <button id="read" onClick={() => t.log("chart", JSON.stringify(ref.current?.data.datasets[0]?.data))}>
            read
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("drawn");
    t.log("pixels", digest(t.root.querySelector("canvas")!.toDataURL()));
    t.$("#more").click();
    await frames(2);
    t.$("#read").click();
    t.log("pixels", digest(t.root.querySelector("canvas")!.toDataURL()));
    await t.step("updated");
  },

  // Heroicons: SVG icon components with forwarded refs and titles.
  async "@heroicons/react: icons, title, ref"(t) {
    function App() {
      const ref = useRef<SVGSVGElement>(null);
      const [big, setBig] = useState(false);
      return (
        <div>
          <BeakerIcon ref={ref} title="beaker" className={big ? "big" : "small"} />
          <button id="grow" onClick={() => (setBig(true), t.log("ref", ref.current?.nodeName))}>
            grow
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("small");
    t.$("#grow").click();
    await t.step("big");
  },

  // TanStack Form: fields from a form hook, validators on change, a subscribed submit state and
  // a submit handler.
  async "@tanstack/react-form: fields, validators, submit"(t) {
    function App() {
      const form = useForm({
        defaultValues: { name: "", count: 1 },
        onSubmit: async ({ value }) => t.log("submit", JSON.stringify(value)),
      });
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="name"
            validators={{ onChange: ({ value }) => (value.length < 3 ? "too short" : undefined) }}
          >
            {(field) => (
              <div>
                <input
                  id="name"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                <em>{field.state.meta.errors.join(",")}</em>
              </div>
            )}
          </form.Field>
          <form.Field name="count">
            {(field) => (
              <button id="inc" type="button" onClick={() => field.handleChange(field.state.value + 1)}>
                {field.state.value}
              </button>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting]}>
            {([can]) => (
              <button id="submit" type="submit" disabled={!can}>
                submit
              </button>
            )}
          </form.Subscribe>
        </form>
      );
    }
    mount(t, <App />);
    await t.step("empty");
    type(t.$("#name"), "ab");
    await wait(20);
    await t.step("too short");
    type(t.$("#name"), "abc");
    t.$("#inc").click();
    await wait(20);
    await t.step("valid");
    t.$("#submit").click();
    await wait(50);
    await t.step("submitted");
  },

  // Downshift's combobox hook: prop getters, filtering as the input changes, keyboard
  // highlighting, and selection.
  async "downshift: useCombobox filter, keyboard, select"(t) {
    const all = ["apple", "banana", "cherry", "date"];
    function App() {
      const [items, setItems] = useState(all);
      const cb = useCombobox({
        items,
        onInputValueChange: ({ inputValue }) => setItems(all.filter((i) => i.includes(inputValue ?? ""))),
        onSelectedItemChange: ({ selectedItem }) => t.log("selected", selectedItem),
      });
      return (
        <div>
          <label {...cb.getLabelProps()}>Fruit</label>
          <input {...cb.getInputProps()} id="combo" />
          <button {...cb.getToggleButtonProps()} id="toggle">
            v
          </button>
          <ul {...cb.getMenuProps()}>
            {cb.isOpen &&
              items.map((item, index) => (
                <li
                  key={item}
                  {...cb.getItemProps({ item, index })}
                  className={cb.highlightedIndex === index ? "hi" : ""}
                >
                  {item}
                </li>
              ))}
          </ul>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("closed");
    t.$("#toggle").click();
    await t.step("open");
    type(t.$("#combo"), "an");
    await t.step("filtered");
    key(t.$("#combo"), "ArrowDown");
    await t.step("highlighted");
    key(t.$("#combo"), "Enter");
    await t.step("selected");
  },

  // A grid layout: items placed from a layout, positions in pixels from the width, and a layout
  // change from outside.
  async "react-grid-layout: layout, positions, changes"(t) {
    function App() {
      const [layout, setLayout] = useState([
        { i: "a", x: 0, y: 0, w: 2, h: 1 },
        { i: "b", x: 2, y: 0, w: 2, h: 2 },
      ]);
      return (
        <div>
          <GridLayout
            width={400}
            layout={layout}
            gridConfig={{ cols: 4, rowHeight: 30 }}
            onLayoutChange={(l) => t.log("layout", l.map((x) => `${x.i}:${x.x},${x.y}`).join(" "))}
          >
            <div key="a">a</div>
            <div key="b">b</div>
          </GridLayout>
          <button id="move" onClick={() => setLayout([{ i: "a", x: 2, y: 2, w: 2, h: 1 }, ...layout.slice(1)])}>
            move
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("placed");
    t.$("#move").click();
    await frames(2);
    await t.step("moved");
  },

  // Swiper's React components: slides, the swiper instance, slide changes and their events.
  async "swiper: slides, instance, slide changes"(t) {
    function App() {
      const [index, setIndex] = useState(0);
      const [slides, setSlides] = useState(["one", "two", "three"]);
      return (
        <div style={{ width: 300 }}>
          <Swiper
            speed={0}
            onSwiper={(s) => t.log("swiper", s.slides.length)}
            onSlideChange={(s) => setIndex(s.activeIndex)}
          >
            {slides.map((s) => (
              <SwiperSlide key={s}>{s}</SwiperSlide>
            ))}
          </Swiper>
          <p id="index">{index}</p>
          <button id="add" onClick={() => setSlides([...slides, "four"])}>
            add
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("first");
    (t.root.querySelector(".swiper") as unknown as { swiper: { slideNext(): void } }).swiper.slideNext();
    await frames(2);
    await t.step("next");
    t.$("#add").click();
    await frames(2);
    await t.step("added a slide");
  },

  // Document head management: the title and meta tags from nested Helmets, the innermost
  // winning, and the head restored when one unmounts. On React 19 it renders the tags themselves,
  // which React hoists into the head.
  async "react-helmet-async: title, meta, nesting, unmount"(t) {
    function App() {
      const [inner, setInner] = useState(true);
      return (
        <HelmetProvider>
          <Helmet>
            <title>Outer</title>
            <meta name="description" content="outer page" />
          </Helmet>
          {inner && (
            <Helmet>
              <title>Inner</title>
            </Helmet>
          )}
          <button id="drop" onClick={() => setInner(false)}>
            drop
          </button>
        </HelmetProvider>
      );
    }
    const head = () => ({
      title: document.title,
      meta: document.head.querySelector('meta[name="description"]')?.getAttribute("content") ?? null,
      titles: document.head.querySelectorAll("title").length,
    });
    mount(t, <App />);
    await wait(30);
    await t.step("mounted");
    t.log(JSON.stringify(head()));
    t.$("#drop").click();
    await wait(30);
    await t.step("inner dropped");
    t.log(JSON.stringify(head()));
  },

  // Leaflet maps: a map container, vector layers through the SVG renderer, a popup, and the map
  // instance moved from a child through useMap.
  async "react-leaflet: map, vector layers, popup, useMap"(t) {
    function Zoom() {
      const map = useMap();
      return (
        <button id="zoom" onClick={() => map.setZoom(map.getZoom() + 1, { animate: false })}>
          zoom
        </button>
      );
    }
    function App() {
      const [color, setColor] = useState("red");
      return (
        <div>
          <MapContainer
            center={[51.5, -0.1]}
            zoom={10}
            style={{ width: 300, height: 200 }}
            zoomAnimation={false}
            fadeAnimation={false}
          >
            <CircleMarker center={[51.5, -0.1]} radius={10} pathOptions={{ color }}>
              <Popup>circle</Popup>
            </CircleMarker>
            <Polygon
              positions={[
                [51.5, -0.2],
                [51.6, -0.1],
                [51.5, 0],
              ]}
            />
            <Zoom />
          </MapContainer>
          <button id="blue" onClick={() => setColor("blue")}>
            blue
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await frames(2);
    await t.step("map");
    t.$("#blue").click();
    await frames(2);
    await t.step("recolored");
    t.$("#zoom").click();
    await frames(2);
    await t.step("zoomed");
  },

  // Toasts from a module-level store: success and error toasts, a promise toast, and dismissal.
  async "react-hot-toast: toasts, promise, dismiss"(t) {
    mount(t, <Toaster position="top-left" toastOptions={{ duration: 100000 }} />);
    toast("plain");
    const id = toast.success("saved");
    await wait(100);
    await t.step("two toasts");
    void toast.promise(
      wait(20).then(() => "done"),
      { loading: "loading", success: "loaded", error: "failed" },
    );
    await wait(100);
    await t.step("promise resolved");
    toast.dismiss(id);
    await wait(1200);
    await t.step("one dismissed");
    toast.remove();
    await wait(50);
    await t.step("all removed");
  },

  // An image cropper: crop and zoom as controlled state, the cropped area reported once the
  // image has loaded, and a zoom change.
  async "react-easy-crop: controlled crop and zoom, cropped area"(t) {
    function App() {
      const [crop, setCrop] = useState({ x: 0, y: 0 });
      const [zoom, setZoom] = useState(1);
      return (
        <div>
          <div style={{ position: "relative", width: 200, height: 200 }}>
            <Cropper
              image={PNG}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(area) => t.log("area", JSON.stringify(area))}
            />
          </div>
          <button id="zoom" onClick={() => setZoom(2)}>
            zoom
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await until(() => t.root.querySelector("img")?.complete === true, 2000);
    await frames(3);
    await t.step("loaded");
    t.$("#zoom").click();
    await frames(3);
    await t.step("zoomed");
  },

  // react-toastify: a container, toasts that stay until closed, an update to one, and dismissal
  // with its exit animation.
  async "react-toastify: show, update, dismiss"(t) {
    mount(t, <ToastContainer position="top-left" autoClose={false} closeOnClick={false} hideProgressBar />);
    await wait(20);
    const id = toastify("first");
    toastify.success("second");
    await wait(100);
    await t.step("two toasts");
    toastify.update(id, { render: "first, updated" });
    await wait(100);
    await t.step("updated");
    toastify.dismiss(id);
    await wait(1500);
    await t.step("dismissed");
  },

  // Tabler icons: SVG components with stroke and size props.
  async "@tabler/icons-react: icons, stroke, size"(t) {
    function App() {
      const [stroke, setStroke] = useState(2);
      return (
        <div>
          <IconHome stroke={stroke} size={24} />
          <IconStar color="gold" size={16} className="star" />
          <button id="thin" onClick={() => setStroke(1)}>
            thin
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("stroke 2");
    t.$("#thin").click();
    await t.step("stroke 1");
  },

  // Ant Design: components styled through its CSS-in-JS with a theme, a controlled input and
  // switch, a loading button, and a modal rendered into a container.
  async "antd: theme, input, switch, button, modal"(t) {
    function App() {
      const [open, setOpen] = useState(false);
      const [text, setText] = useState("");
      const [on, setOn] = useState(false);
      return (
        <ConfigProvider theme={{ token: { colorPrimary: "#336699", motion: false } }} wave={{ disabled: true }}>
          <AntButton id="open" type="primary" loading={open} onClick={() => setOpen(true)}>
            open
          </AntButton>
          <AntInput id="text" value={text} onChange={(e) => setText(e.target.value)} />
          <AntSwitch id="switch" checked={on} onChange={(v) => (t.log("switch", v), setOn(v))} />
          <AntModal
            open={open}
            title="Hello"
            getContainer={() => t.other}
            transitionName=""
            maskTransitionName=""
            onOk={() => (t.log("ok"), setOpen(false))}
            onCancel={() => (t.log("cancel"), setOpen(false))}
          >
            <p>text: {text}</p>
          </AntModal>
        </ConfigProvider>
      );
    }
    mount(t, <App />);
    await wait(50);
    await t.step("initial");
    type(t.$("#text"), "abc");
    t.$("#switch").click();
    await wait(50);
    await t.step("typed and switched");
    t.$("#open").click();
    await wait(200);
    await t.step("modal open");
    t.other.querySelector<HTMLElement>(".ant-modal-footer .ant-btn-primary")!.click();
    await wait(300);
    await t.step("modal closed");
  },

  // react-use's state hooks: a toggle, a counter with bounds, a list, and the previous value.
  async "react-use: toggle, counter, list, previous"(t) {
    function App() {
      const [on, toggle] = useToggle(false);
      const [n, { inc, dec, reset }] = useCounter(1, 3, 0);
      const [list, { push, removeAt }] = useList(["a"]);
      const prev = usePrevious(n);
      return (
        <div>
          <p>
            {String(on)} {n} prev {String(prev)} {list.join(",")}
          </p>
          <button id="toggle" onClick={toggle}>
            toggle
          </button>
          <button id="inc" onClick={() => inc()}>
            inc
          </button>
          <button id="dec" onClick={() => dec(5)}>
            dec
          </button>
          <button id="reset" onClick={() => reset()}>
            reset
          </button>
          <button id="push" onClick={() => push("b")}>
            push
          </button>
          <button id="remove" onClick={() => removeAt(0)}>
            remove
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("initial");
    t.$("#toggle").click();
    t.$("#inc").click();
    t.$("#inc").click();
    t.$("#inc").click();
    await t.step("capped at 3");
    t.$("#dec").click();
    t.$("#push").click();
    await t.step("floored at 0");
    t.$("#reset").click();
    t.$("#remove").click();
    await t.step("reset");
  },

  // A virtualized list that measures its items: the items in view, scrolling to an index
  // through its handle, and range events.
  async "react-virtuoso: measured items, scrollToIndex, ranges"(t) {
    function App() {
      const ref = useRef<VirtuosoHandle>(null);
      return (
        <div>
          <Virtuoso
            ref={ref}
            style={{ height: 100 }}
            totalCount={500}
            itemContent={(i) => <div style={{ height: i % 2 ? 30 : 20 }}>item {i}</div>}
            rangeChanged={(r) => t.log("range", r.startIndex, r.endIndex)}
          />
          <button id="jump" onClick={() => ref.current?.scrollToIndex({ index: 250, align: "start" })}>
            jump
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(150);
    t.log("first", t.root.querySelector("[data-index]")?.textContent);
    t.$("#jump").click();
    await wait(300);
    t.log("first", t.root.querySelector("[data-index]")?.getAttribute("data-index"));
    await t.step("jumped");
  },

  // Drag and drop with the keyboard: lift an item with Space, move it with an arrow key, drop
  // it, and reorder the list in onDragEnd.
  async "@hello-pangea/dnd: keyboard drag to reorder"(t) {
    function App() {
      const [items, setItems] = useState(["one", "two", "three"]);
      return (
        <DragDropContext
          onDragStart={(s) => t.log("start", s.draggableId)}
          onDragEnd={(r) => {
            t.log("end", r.draggableId, r.destination?.index ?? -1);
            if (r.destination === null) return;
            const next = [...items];
            const [moved] = next.splice(r.source.index, 1);
            next.splice(r.destination.index, 0, moved!);
            setItems(next);
          }}
        >
          <Droppable droppableId="list">
            {(p) => (
              <ul ref={p.innerRef} {...p.droppableProps}>
                {items.map((item, i) => (
                  <PangeaDraggable key={item} draggableId={item} index={i}>
                    {(d) => (
                      <li ref={d.innerRef} {...d.draggableProps} {...d.dragHandleProps} id={"item-" + item}>
                        {item}
                      </li>
                    )}
                  </PangeaDraggable>
                ))}
                {p.placeholder}
              </ul>
            )}
          </Droppable>
        </DragDropContext>
      );
    }
    mount(t, <App />);
    await frames(2);
    const handle = t.$("#item-one");
    handle.focus();
    // The keyboard sensor reads keyCode: 32 is Space and 40 is ArrowDown.
    keyWithCode(handle, " ", 32);
    await frames(4);
    keyWithCode(handle, "ArrowDown", 40);
    await wait(400);
    keyWithCode(handle, " ", 32);
    await wait(400);
    await t.step("reordered");
    t.log("order", [...t.root.querySelectorAll("li")].map((li) => li.textContent).join(","));
  },
};

// #endregion
