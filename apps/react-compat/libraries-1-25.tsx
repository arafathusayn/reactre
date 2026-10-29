// Scenarios with the first 25 of the React libraries npm downloads most (weekly downloads, one
// package per project, libraries an app imports itself; not dependencies of other libraries,
// frameworks, renderers, build or test tools):
//
//   2026-10-27, the first ten: lucide-react, @radix-ui/react-dialog, zustand,
//   @tanstack/react-query, react-router, framer-motion, recharts, react-hook-form, sonner and
//   react-transition-group.
//   2026-10-29, the next fifteen: react-redux, react-markdown, react-day-picker, cmdk,
//   @dnd-kit/core, @tanstack/react-virtual, @sentry/react, @floating-ui/react, vaul, next-themes,
//   @tanstack/react-table, react-resizable-panels, embla-carousel-react, input-otp and
//   @emotion/react.
//
// They run like the scenarios in ./cases.tsx: the same code on React 19 and on each runtime, with
// every log and step compared. The libraries come from ./package.json and import `react` like
// any app code, so they get the runtime under test.
//
// Real libraries use React in ways a hand-written scenario does not anticipate, so they catch
// gaps the API-level scenarios miss. Several steps wait a fixed time first, because the libraries
// themselves schedule work on timers and animation frames.

import { DndContext, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { ClassNames, Global, jsx as emotionJsx, keyframes, ThemeProvider, useTheme } from "@emotion/react";
import { FloatingPortal, useClick, useDismiss, useFloating, useInteractions, useRole } from "@floating-ui/react";
import * as Dialog from "@radix-ui/react-dialog";
import { configureStore, createSlice } from "@reduxjs/toolkit";
import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Command } from "cmdk";
import useEmblaCarousel from "embla-carousel-react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { OTPInput } from "input-otp";
import { Camera, Check, Trash2 } from "lucide-react";
import { ThemeProvider as NextThemes, useTheme as useNextTheme } from "next-themes";
import { Suspense, useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import { useForm } from "react-hook-form";
import Markdown from "react-markdown";
import { connect, Provider, useDispatch, useSelector } from "react-redux";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  createMemoryRouter,
  Link,
  MemoryRouter,
  Outlet,
  Route,
  RouterProvider,
  Routes,
  useLoaderData,
  useNavigate,
  useParams,
} from "react-router";
import { CSSTransition, TransitionGroup } from "react-transition-group";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { toast, Toaster } from "sonner";
import { Drawer } from "vaul";
import { create } from "zustand";

import { type T, type } from "./cases.tsx";
import { active, frames, key, mount, wait } from "./helpers.tsx";

// #region Scenarios

/** The library scenarios by name, run after ./cases.tsx's. */
export const libraries1To25: Record<string, (t: T) => Promise<void>> = {
  // Portals into a container, focus moves and returns, Escape handling, and controlled open state.
  async "@radix-ui/react-dialog: open, focus, escape, controlled"(t) {
    function App() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Dialog.Root>
            <Dialog.Trigger id="trigger">Open</Dialog.Trigger>
            <Dialog.Portal container={t.other}>
              <Dialog.Overlay className="overlay" />
              <Dialog.Content className="content">
                <Dialog.Title>Title</Dialog.Title>
                <Dialog.Description>Description</Dialog.Description>
                <input id="field" />
                <Dialog.Close id="close">Close</Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Dialog.Root open={open} onOpenChange={(o) => (t.log("controlled change", o), setOpen(o))}>
            <Dialog.Trigger id="trigger2">Controlled {String(open)}</Dialog.Trigger>
            <Dialog.Portal container={t.other}>
              <Dialog.Content aria-describedby={undefined}>
                <Dialog.Title>Second</Dialog.Title>
                <Dialog.Close id="close2">x</Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("closed");
    t.$("#trigger").click();
    await wait(50);
    await t.step("open");
    t.log("focus", active());
    key(t.$(".content"), "Escape");
    await wait(50);
    await t.step("escaped");
    t.log("focus", active());
    t.$("#trigger").click();
    await wait(50);
    t.$("#close").click();
    await wait(50);
    await t.step("closed by button");
    t.$("#trigger2").click();
    await wait(50);
    await t.step("controlled open");
    t.$("#close2").click();
    await wait(50);
    await t.step("controlled closed");
  },

  // useSyncExternalStore with selectors: only components whose slice changed render again.
  async "zustand: slices, selectors, updates from outside React"(t) {
    const useStore = create<{ count: number; name: string; inc(): void; rename(n: string): void }>((set) => ({
      count: 0,
      name: "ann",
      inc: () => set((s) => ({ count: s.count + 1 })),
      rename: (name) => set({ name }),
    }));
    const renders: string[] = [];
    function Count() {
      const count = useStore((s) => s.count);
      const inc = useStore((s) => s.inc);
      renders.push("count");
      return (
        <button id="inc" onClick={inc}>
          {count}
        </button>
      );
    }
    function Name() {
      const name = useStore((s) => s.name);
      renders.push("name");
      return <b>{name}</b>;
    }
    mount(
      t,
      <p>
        <Count />
        <Name />
      </p>,
    );
    t.$("#inc").click();
    t.$("#inc").click();
    await t.step("clicked twice");
    t.log(renders.splice(0).join(" "));
    useStore.getState().rename("bob");
    await t.step("renamed outside");
    t.log(renders.splice(0).join(" "));
    useStore.setState({ count: 10, name: "cy" });
    await t.step("set both");
    t.log(renders.splice(0).join(" "));
  },

  // Async state from outside React: pending and loaded renders, Suspense queries, invalidation.
  async "@tanstack/react-query: queries, refetch, mutations, suspense"(t) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    let n = 0;
    const releases: (() => void)[] = [];
    const fetchTodo = (id: number) =>
      new Promise<string>((resolve) => releases.push(() => resolve(`todo ${id} v${++n}`)));
    const release = async () => {
      releases.shift()?.();
      await wait(20);
    };
    function Todo({ id }: { id: number }) {
      const q = useQuery({ queryKey: ["todo", id], queryFn: () => fetchTodo(id) });
      return (
        <li>
          {q.status}/{q.fetchStatus}: {q.data ?? "-"}
        </li>
      );
    }
    function Save() {
      const m = useMutation({
        mutationFn: async (v: string) => {
          await wait(5);
          return v.toUpperCase();
        },
        onSuccess: () => client.invalidateQueries({ queryKey: ["todo", 1] }),
      });
      return (
        <button id="save" onClick={() => m.mutate("saved")}>
          {m.status}:{m.data ?? ""}
        </button>
      );
    }
    function Sus() {
      const q = useSuspenseQuery({ queryKey: ["sus"], queryFn: () => fetchTodo(9) });
      return <em>{q.data}</em>;
    }
    mount(
      t,
      <QueryClientProvider client={client}>
        <ul>
          <Todo id={1} />
          <Todo id={1} />
          <Todo id={2} />
        </ul>
        <Save />
        <Suspense fallback={<i>suspended</i>}>
          <Sus />
        </Suspense>
      </QueryClientProvider>,
    );
    await t.step("pending");
    // The suspense query fetches during render, first. React reveals
    // suspended content up to 300 ms late, so steps after it wait that out.
    await release();
    await wait(400);
    await t.step("suspense loaded");
    await release();
    await release();
    await t.step("todos loaded");
    t.$("#save").click();
    await wait(30);
    await t.step("mutated, refetching");
    await release();
    await t.step("refetched");
  },

  // Routing through context: loaders, links, params and programmatic navigation.
  async "react-router: data router with loaders, links, params, navigation"(t) {
    function Layout() {
      return (
        <div>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/users/42" id="to-user">
              User
            </Link>
          </nav>
          <Outlet />
        </div>
      );
    }
    function User() {
      const { id } = useParams();
      const data = useLoaderData() as { name: string };
      const navigate = useNavigate();
      return (
        <section>
          user {id}: {data.name}
          <button id="back" onClick={() => navigate("/")}>
            back
          </button>
        </section>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <Layout />,
          children: [
            { index: true, element: <h1>home</h1> },
            { path: "users/:id", element: <User />, loader: async ({ params }) => ({ name: "user-" + params["id"] }) },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    mount(t, <RouterProvider router={router} />);
    await wait(20);
    await t.step("home");
    t.$("#to-user").click();
    await wait(50);
    await t.step("user");
    t.log("location", router.state.location.pathname);
    t.$("#back").click();
    await wait(50);
    await t.step("back home");
  },

  // Route matching from children elements, and nested routes through Outlet.
  async "react-router: declarative routes"(t) {
    function Page({ name }: { name: string }) {
      const navigate = useNavigate();
      return (
        <button id={"go-" + name} onClick={() => navigate(name === "a" ? "/b/7" : "/a")}>
          {name}
        </button>
      );
    }
    function B() {
      return <i>b {useParams()["n"]}</i>;
    }
    mount(
      t,
      <MemoryRouter initialEntries={["/a"]}>
        <Routes>
          <Route path="/a" element={<Page name="a" />} />
          <Route
            path="/b/:n"
            element={
              <>
                <B />
                <Page name="b" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await t.step("a");
    t.$("#go-a").click();
    await wait(20);
    await t.step("b");
    t.$("#go-b").click();
    await wait(20);
    await t.step("a again");
  },

  // Mount animations, variants, and exit animations that keep removed children until they end.
  async "framer-motion: animate, presence, variants"(t) {
    function App() {
      const [items, setItems] = useState(["x", "y", "z"]);
      const [on, setOn] = useState(false);
      return (
        <MotionConfig transition={{ duration: 0 }}>
          <motion.div id="box" initial={{ opacity: 0, x: 0 }} animate={{ opacity: on ? 0.5 : 1, x: on ? 100 : 0 }} />
          <button id="toggle" onClick={() => setOn(!on)}>
            toggle
          </button>
          <button id="drop" onClick={() => setItems(items.slice(1))}>
            drop
          </button>
          <ul>
            <AnimatePresence onExitComplete={() => t.log("exit complete")}>
              {items.map((i) => (
                <motion.li key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {i}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </MotionConfig>
      );
    }
    mount(t, <App />);
    await wait(100);
    await t.step("mounted");
    t.$("#toggle").click();
    await wait(100);
    await t.step("toggled");
    t.$("#drop").click();
    await wait(200);
    await t.step("dropped");
  },

  // forwardRef components that render SVG, with props passed through and refs to SVG nodes.
  async "lucide-react: icons, props, refs"(t) {
    function App() {
      const [big, setBig] = useState(false);
      const ref = useRef<SVGSVGElement>(null);
      return (
        <p>
          <Camera size={big ? 48 : 24} color={big ? "red" : "currentColor"} />
          <Check strokeWidth={big ? 3 : 2} className="ok" ref={ref} aria-label="done" />
          <Trash2 absoluteStrokeWidth size={32} />
          <button
            id="grow"
            onClick={() => (setBig(!big), t.log("ref", ref.current?.nodeName, ref.current?.namespaceURI))}
          >
            grow
          </button>
        </p>
      );
    }
    mount(t, <App />);
    await t.step("small");
    t.$("#grow").click();
    await t.step("big");
  },

  // Large SVG trees built from data, and redrawn when the data changes.
  async "recharts: line and bar charts, data updates"(t) {
    function App() {
      const [data, setData] = useState([
        { name: "a", uv: 4, pv: 2 },
        { name: "b", uv: 3, pv: 5 },
        { name: "c", uv: 6, pv: 1 },
      ]);
      return (
        <div>
          <LineChart width={300} height={200} data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Line dataKey="uv" stroke="#8884d8" isAnimationActive={false} />
          </LineChart>
          <BarChart width={300} height={200} data={data}>
            <XAxis dataKey="name" />
            <Bar dataKey="pv" fill="#82ca9d" isAnimationActive={false} />
          </BarChart>
          <button id="more" onClick={() => setData([...data, { name: "d", uv: 8, pv: 7 }])}>
            more
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(100);
    await t.step("drawn");
    t.$("#more").click();
    await wait(100);
    await t.step("more data");
  },

  // Uncontrolled fields through ref callbacks, validation state, watch subscriptions and reset.
  async "react-hook-form: register, validate, watch, reset"(t) {
    function App() {
      const {
        register,
        handleSubmit,
        watch,
        reset,
        formState: { errors, isSubmitSuccessful },
      } = useForm<{ name: string; age: string }>({ defaultValues: { name: "", age: "1" } });
      const name = watch("name");
      return (
        <form onSubmit={handleSubmit((v) => t.log("submitted", v))}>
          <input
            id="name"
            {...register("name", { required: "name is required", minLength: { value: 3, message: "too short" } })}
          />
          <input id="age" {...register("age", { pattern: { value: /^\d+$/, message: "digits only" } })} />
          <p>
            watch: {name} | {errors.name?.message ?? "-"} | {errors.age?.message ?? "-"} | {String(isSubmitSuccessful)}
          </p>
          <button id="submit">go</button>
          <button id="clear" type="button" onClick={() => reset()}>
            reset
          </button>
        </form>
      );
    }
    mount(t, <App />);
    await t.step("empty");
    t.$("#submit").click();
    await wait(20);
    await t.step("required");
    for (const [id, v] of [
      ["#name", "al"],
      ["#age", "x"],
    ] as const) {
      const el = t.$(id) as HTMLInputElement;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    t.$("#submit").click();
    await wait(20);
    await t.step("invalid");
    // Typed for real: the native setter, as a keystroke leaves the field
    // (the plain assignments above go through React's value tracker and
    // cause no onChange).
    for (const [id, v] of [
      ["#name", "alice"],
      ["#age", "42"],
    ] as const) {
      const el = t.$(id) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    t.$("#submit").click();
    await wait(20);
    await t.step("valid");
    t.$("#clear").click();
    await wait(20);
    await t.step("reset");
    t.log("fields", (t.$("#name") as HTMLInputElement).value, (t.$("#age") as HTMLInputElement).value);
  },

  // State updates from outside React (a toast store), timers and enter and exit transitions.
  async "sonner: toasts, promise toasts, dismiss"(t) {
    mount(
      t,
      <div>
        <Toaster duration={Number.POSITIVE_INFINITY} />
      </div>,
    );
    await wait(20);
    await t.step("empty");
    const id = toast("Saved", { description: "all good" });
    toast.success("Done");
    await wait(100);
    t.log("toasts", t.root.querySelectorAll("[data-sonner-toast]").length);
    t.log("titles", [...t.root.querySelectorAll("[data-title]")].map((e) => e.textContent).join(","));
    let resolve!: (v: string) => void;
    toast.promise(new Promise<string>((r) => (resolve = r)), {
      loading: "Loading",
      success: (v) => "Got " + v,
      error: "Failed",
    });
    await wait(50);
    t.log("titles", [...t.root.querySelectorAll("[data-title]")].map((e) => e.textContent).join(","));
    resolve("it");
    await wait(50);
    t.log("titles", [...t.root.querySelectorAll("[data-title]")].map((e) => e.textContent).join(","));
    toast.dismiss(id);
    await wait(600);
    t.log("after dismiss", [...t.root.querySelectorAll("[data-title]")].map((e) => e.textContent).join(","));
  },

  // Timed class changes through nodeRef, and children kept mounted until their exit finishes.
  async "react-transition-group: CSSTransition and TransitionGroup"(t) {
    function Item({ text, ...props }: { text: string; [k: string]: unknown }) {
      const ref = useRef<HTMLLIElement>(null);
      return (
        <CSSTransition {...props} nodeRef={ref} timeout={300} classNames="fade" onExited={() => t.log("exited", text)}>
          <li ref={ref}>{text}</li>
        </CSSTransition>
      );
    }
    function App() {
      const [items, setItems] = useState(["a", "b"]);
      const [show, setShow] = useState(false);
      const box = useRef<HTMLDivElement>(null);
      return (
        <div>
          <CSSTransition
            in={show}
            nodeRef={box}
            timeout={300}
            classNames="box"
            unmountOnExit
            onEntered={() => t.log("entered")}
          >
            <div ref={box}>box</div>
          </CSSTransition>
          <TransitionGroup component="ul">
            {items.map((i) => (
              <Item key={i} text={i} />
            ))}
          </TransitionGroup>
          <button id="show" onClick={() => setShow(!show)}>
            show
          </button>
          <button id="swap" onClick={() => setItems(["b", "c"])}>
            swap
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("mounted");
    t.$("#show").click();
    await t.step("entering");
    await wait(600);
    await t.step("entered");
    t.$("#swap").click();
    await t.step("swapping");
    await wait(600);
    await t.step("swapped");
    t.$("#show").click();
    await wait(600);
    await t.step("hidden");
  },

  // useSyncExternalStore through a store context: selectors, dispatches from inside and outside
  // React, and connect(), the higher-order component older code still uses.
  async "react-redux: store, selectors, dispatch, connect"(t) {
    const counter = createSlice({
      name: "counter",
      initialState: { value: 0, label: "ann" },
      reducers: {
        inc: (s) => void (s.value += 1),
        rename: (s, a: { payload: string }) => void (s.label = a.payload),
      },
    });
    const store = configureStore({ reducer: { counter: counter.reducer } });
    type State = ReturnType<typeof store.getState>;
    const renders: string[] = [];
    function Count() {
      const value = useSelector((s: State) => s.counter.value);
      const dispatch = useDispatch();
      renders.push("count");
      return (
        <button id="inc" onClick={() => dispatch(counter.actions.inc())}>
          {value}
        </button>
      );
    }
    function LabelView({ label }: { label: string }) {
      renders.push("label");
      return <b>{label}</b>;
    }
    const Label = connect((s: State) => ({ label: s.counter.label }))(LabelView);
    mount(
      t,
      <Provider store={store}>
        <Count />
        <Label />
      </Provider>,
    );
    await t.step("mounted");
    t.log(renders.splice(0).join(" "));
    t.$("#inc").click();
    t.$("#inc").click();
    await t.step("clicked twice");
    t.log(renders.splice(0).join(" "));
    store.dispatch(counter.actions.rename("bob"));
    await t.step("renamed outside");
    t.log(renders.splice(0).join(" "));
  },

  // A parsed tree of elements from markdown, custom components for some tags, and a new source.
  async "react-markdown: render, components, update"(t) {
    function App() {
      const [src, setSrc] = useState("# Title\n\nSome *emphasis*, a [link](https://example.com) and `code`.");
      return (
        <div>
          <Markdown components={{ h1: ({ children }) => <h1 className="custom">{children}</h1> }}>{src}</Markdown>
          <button id="next" onClick={() => setSrc("## List\n\n- one\n- **two**\n\n> quoted")}>
            next
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("first source");
    t.$("#next").click();
    await t.step("second source");
  },

  // A calendar grid: controlled single selection, month navigation and keyboard focus. The dates
  // are fixed so the grid is the same on every run.
  async "react-day-picker: select, navigate, focus"(t) {
    const dayButton = (n: string) =>
      [...t.root.querySelectorAll<HTMLButtonElement>("td button")].find((b) => b.textContent === n)!;
    function App() {
      const [selected, setSelected] = useState<Date | undefined>(undefined);
      return (
        <div>
          <DayPicker
            mode="single"
            defaultMonth={new Date(2026, 0, 1)}
            today={new Date(2026, 0, 15)}
            selected={selected}
            onSelect={(d) => (t.log("select", d?.toDateString() ?? "none"), setSelected(d))}
          />
          <p id="picked">{selected ? selected.toDateString() : "none"}</p>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("january");
    dayButton("10").click();
    await t.step("selected 10");
    dayButton("10").focus();
    key(dayButton("10"), "ArrowRight");
    await wait(20);
    t.log("focus", active());
    t.$("button[aria-label*='next' i]").click();
    await t.step("february");
  },

  // A command menu: filtering as the user types, arrow-key selection and Enter to run an item.
  async "cmdk: filter, arrow keys, select"(t) {
    function App() {
      const [ran, setRan] = useState("nothing");
      return (
        <div>
          <Command label="Commands">
            <Command.Input />
            <Command.List>
              <Command.Empty>No results</Command.Empty>
              <Command.Group heading="Files">
                <Command.Item onSelect={() => setRan("new file")}>New file</Command.Item>
                <Command.Item onSelect={() => setRan("open file")}>Open file</Command.Item>
              </Command.Group>
              <Command.Item onSelect={() => setRan("settings")}>Settings</Command.Item>
            </Command.List>
          </Command>
          <p id="ran">{ran}</p>
        </div>
      );
    }
    mount(t, <App />);
    await frames(3);
    await t.step("all items");
    type(t.$("[cmdk-input]"), "file");
    await frames(3);
    await t.step("filtered");
    key(t.$("[cmdk-input]"), "ArrowDown");
    await t.step("second selected");
    key(t.$("[cmdk-input]"), "Enter");
    await t.step("ran");
    type(t.$("[cmdk-input]"), "zzz");
    await frames(3);
    await t.step("empty");
  },

  // Drag and drop with the keyboard sensor: pick up with Space, move with arrows, drop with Space.
  // Collision detection reads layout, which both runtimes share in the same browser.
  async "@dnd-kit/core: keyboard drag onto a droppable"(t) {
    function Item() {
      const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: "item" });
      return (
        <button
          id="drag"
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          style={{
            width: 40,
            height: 40,
            transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
          }}
        >
          item
        </button>
      );
    }
    function Zone({ id, x }: { id: string; x: number }) {
      const { isOver, setNodeRef } = useDroppable({ id });
      return (
        <div
          ref={setNodeRef}
          style={{ position: "absolute", left: x, top: 0, width: 100, height: 100 }}
          data-over={String(isOver)}
        >
          {id}
        </div>
      );
    }
    function App() {
      const [dropped, setDropped] = useState("none");
      const sensors = useSensors(useSensor(KeyboardSensor));
      return (
        <DndContext
          sensors={sensors}
          onDragStart={(e) => t.log("start", e.active.id)}
          onDragEnd={(e) => (t.log("end", e.over?.id ?? null), setDropped(String(e.over?.id ?? "none")))}
        >
          <div style={{ position: "relative", height: 120 }}>
            <Zone id="left" x={0} />
            <Zone id="right" x={200} />
          </div>
          <Item />
          <p id="dropped">{dropped}</p>
        </DndContext>
      );
    }
    mount(t, <App />);
    await t.step("idle");
    const drag = t.$("#drag");
    drag.focus();
    key(drag, " ");
    await wait(50);
    await t.step("picked up");
    for (let i = 0; i < 9; i++) {
      key(drag, "ArrowRight");
      await wait(10);
    }
    for (let i = 0; i < 4; i++) {
      key(drag, "ArrowUp");
      await wait(10);
    }
    await wait(50);
    await t.step("moved");
    key(drag, " ");
    await wait(50);
    await t.step("dropped");
  },

  // A virtual list: only the rows in view exist, and scrolling swaps them. Measured through
  // ResizeObserver and scroll events.
  async "@tanstack/react-virtual: window of rows, scroll"(t) {
    function App() {
      const parent = useRef<HTMLDivElement>(null);
      const v = useVirtualizer({ count: 1000, getScrollElement: () => parent.current, estimateSize: () => 20 });
      return (
        <div id="scroller" ref={parent} style={{ height: 100, overflow: "auto" }}>
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((item) => (
              <div
                key={item.key}
                style={{ position: "absolute", top: 0, height: 20, transform: `translateY(${item.start}px)` }}
              >
                row {item.index}
              </div>
            ))}
          </div>
        </div>
      );
    }
    mount(t, <App />);
    await wait(50);
    await t.step("top");
    const scroller = t.$("#scroller");
    scroller.scrollTop = 5000;
    scroller.dispatchEvent(new Event("scroll"));
    await wait(50);
    await t.step("scrolled to row 250");
  },

  // An error boundary from an error monitoring SDK (a class component inside), with a fallback
  // that resets it. No DSN is configured, so nothing is sent.
  async "@sentry/react: error boundary, fallback, reset"(t) {
    function Bomb({ explode }: { explode: boolean }) {
      if (explode) throw new Error("boom");
      return <p>fine</p>;
    }
    function App() {
      const [explode, setExplode] = useState(false);
      return (
        <div>
          <Sentry.ErrorBoundary
            onError={(e) => t.log("onError", (e as Error).message)}
            onReset={() => (t.log("reset"), setExplode(false))}
            fallback={({ error, resetError }) => (
              <button id="reset" onClick={resetError}>
                failed: {(error as Error).message}
              </button>
            )}
          >
            <Bomb explode={explode} />
          </Sentry.ErrorBoundary>
          <button id="explode" onClick={() => setExplode(true)}>
            explode
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await t.step("fine");
    t.$("#explode").click();
    await t.step("fallback");
    t.$("#reset").click();
    await t.step("reset");
  },

  // A popover positioned against its reference, portaled, opened by click and dismissed by Escape
  // and outside presses, with the ARIA wiring useRole adds.
  async "@floating-ui/react: click, position, dismiss, portal"(t) {
    function App() {
      const [open, setOpen] = useState(false);
      const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: (o) => (t.log("open change", o), setOpen(o)),
        placement: "bottom-start",
      });
      const { getReferenceProps, getFloatingProps } = useInteractions([
        useClick(context),
        useDismiss(context),
        useRole(context),
      ]);
      return (
        <div>
          <button id="ref" ref={refs.setReference} {...getReferenceProps()}>
            toggle
          </button>
          {open && (
            <FloatingPortal root={t.other}>
              <div id="pop" ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()}>
                popover
              </div>
            </FloatingPortal>
          )}
        </div>
      );
    }
    mount(t, <App />);
    await t.step("closed");
    t.$("#ref").click();
    await wait(50);
    await t.step("open");
    key(t.$("#pop"), "Escape");
    await wait(50);
    await t.step("escaped");
    t.$("#ref").click();
    await wait(50);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await wait(50);
    await t.step("outside press");
  },

  // A drawer built on Radix Dialog: portal, open and close with transitions on timers.
  async "vaul: drawer open and close"(t) {
    function App() {
      return (
        <Drawer.Root onOpenChange={(o) => t.log("open change", o)}>
          <Drawer.Trigger id="open">Open drawer</Drawer.Trigger>
          <Drawer.Portal container={t.other}>
            <Drawer.Overlay className="overlay" />
            <Drawer.Content className="content" aria-describedby={undefined}>
              <Drawer.Title>Drawer</Drawer.Title>
              <Drawer.Close id="close">Close</Drawer.Close>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      );
    }
    mount(t, <App />);
    await t.step("closed");
    t.$("#open").click();
    await wait(600);
    await t.step("open");
    t.log("focus", active());
    t.$("#close").click();
    await wait(600);
    await t.step("closed again");
  },

  // Theme state kept on <html> and in localStorage, set from a component.
  async "next-themes: provider, setTheme, html class"(t) {
    localStorage.removeItem("compat-theme");
    document.documentElement.className = "";
    function Toggle() {
      const { theme, setTheme } = useNextTheme();
      return (
        <button id="toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme ?? "unset"}
        </button>
      );
    }
    mount(
      t,
      <NextThemes attribute="class" storageKey="compat-theme" defaultTheme="light" enableSystem={false}>
        <Toggle />
      </NextThemes>,
    );
    await wait(20);
    await t.step("light");
    t.log("html", document.documentElement.className, "stored", localStorage.getItem("compat-theme"));
    t.$("#toggle").click();
    await wait(20);
    await t.step("dark");
    t.log("html", document.documentElement.className, "stored", localStorage.getItem("compat-theme"));
    localStorage.removeItem("compat-theme");
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  },

  // A headless table: rows and headers from a store-backed table instance, sorting on header
  // clicks.
  async "@tanstack/react-table: rows, headers, sorting"(t) {
    type Person = { name: string; age: number };
    const features = tableFeatures({
      rowSortingFeature,
      sortedRowModel: createSortedRowModel(),
      sortFns: { alphanumeric: sortFn_alphanumeric },
    });
    const columns = createColumnHelper<typeof features, Person>();
    const defs = columns.columns([
      columns.accessor("name", { header: "Name", sortFn: "alphanumeric" }),
      columns.accessor("age", { header: "Age", sortFn: "alphanumeric" }),
    ]);
    const data: Person[] = [
      { name: "cy", age: 30 },
      { name: "ann", age: 41 },
      { name: "bob", age: 25 },
    ];
    function App() {
      const table = useTable({ features, columns: defs, data });
      return (
        <table>
          <thead>
            {table.getHeaderGroups().map((g) => (
              <tr key={g.id}>
                {g.headers.map((h) => (
                  <th key={h.id} id={"h-" + h.id} onClick={h.column.getToggleSortingHandler()}>
                    <table.FlexRender header={h} /> {String(h.column.getIsSorted())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id}>
                {r.getAllCells().map((c) => (
                  <td key={c.id}>
                    <table.FlexRender cell={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    mount(t, <App />);
    await t.step("unsorted");
    t.$("#h-name").click();
    await t.step("by name");
    t.$("#h-age").click();
    await t.step("by age");
    t.$("#h-age").click();
    await t.step("by age, descending");
  },

  // Resizable panels: layout from the group's size, a resize through the imperative handle, and a
  // keyboard resize on the separator.
  async "react-resizable-panels: layout, imperative resize, keyboard"(t) {
    function App() {
      const left = usePanelRef();
      return (
        <div style={{ width: 400, height: 100 }}>
          <Group
            orientation="horizontal"
            onLayoutChange={(layout) => t.log("layout", JSON.stringify(layout))}
            style={{ width: 400, height: 100 }}
          >
            <Panel id="left" panelRef={left} defaultSize="50%" minSize="10%">
              left
            </Panel>
            <Separator id="sep" />
            <Panel id="right" minSize="10%">
              right
            </Panel>
          </Group>
          <button id="resize" onClick={() => left.current?.resize("30%")}>
            30%
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(50);
    await t.step("half");
    t.$("#resize").click();
    await wait(50);
    await t.step("resized to 30%");
    const sep = t.$("#sep");
    sep.focus();
    key(sep, "ArrowRight");
    await wait(50);
    await t.step("keyboard");
  },

  // A carousel engine driven through its API: jumps without animation, and its select event.
  async "embla-carousel-react: api, jump, select event"(t) {
    function App() {
      const [ref, api] = useEmblaCarousel({ duration: 10 });
      const [index, setIndex] = useState(0);
      useEffect(() => {
        if (!api) return;
        const onSelect = () => (t.log("select", api.selectedScrollSnap()), setIndex(api.selectedScrollSnap()));
        api.on("select", onSelect);
        return () => void api.off("select", onSelect);
      }, [api]);
      return (
        <div>
          <div ref={ref} style={{ overflow: "hidden", width: 300 }}>
            <div style={{ display: "flex" }}>
              {["a", "b", "c"].map((s) => (
                <div key={s} style={{ flex: "0 0 100%" }}>
                  slide {s}
                </div>
              ))}
            </div>
          </div>
          <p id="index">{index}</p>
          <button id="jump" onClick={() => api?.scrollTo(2, true)}>
            jump
          </button>
          <button id="prev" onClick={() => api?.scrollPrev(true)}>
            prev
          </button>
        </div>
      );
    }
    mount(t, <App />);
    await wait(50);
    t.log("snaps", document.querySelectorAll("#root [style*='flex: 0 0 100%']").length);
    t.$("#jump").click();
    await wait(100);
    await t.step("slide c");
    t.$("#prev").click();
    await wait(100);
    await t.step("slide b");
  },

  // A one-time code field: slots rendered from the input's state, typing, and completion.
  async "input-otp: slots, typing, complete"(t) {
    function App() {
      const [value, setValue] = useState("");
      return (
        <OTPInput
          id="otp"
          maxLength={4}
          value={value}
          onChange={setValue}
          onComplete={(v: string) => t.log("complete", v)}
          render={({ slots }) => (
            <div>
              {slots.map((s, i) => (
                <span key={i} className={s.isActive ? "slot active" : "slot"}>
                  {s.char ?? "_"}
                </span>
              ))}
            </div>
          )}
        />
      );
    }
    mount(t, <App />);
    await t.step("empty");
    type(t.$("#otp"), "12");
    await wait(20);
    await t.step("two digits");
    type(t.$("#otp"), "1234");
    await wait(20);
    await t.step("complete");
  },

  // CSS-in-JS: the css prop through Emotion's jsx, a theme from context, global styles,
  // keyframes and ClassNames. The class names are content hashes, the same on both runtimes.
  async "@emotion/react: css prop, theme, global, ClassNames"(t) {
    const spin = keyframes`from { opacity: 0 } to { opacity: 1 }`;
    function Themed() {
      const theme = useTheme() as { color: string };
      return emotionJsx("p", { id: "themed", css: { color: theme.color, animation: `${spin} 1s` } }, "themed");
    }
    function App() {
      const [color, setColor] = useState("rgb(255, 0, 0)");
      return (
        <ThemeProvider theme={{ color }}>
          <Global styles={{ ".global-marked": { fontWeight: 700 } }} />
          <Themed />
          <ClassNames>
            {({ css, cx }) => (
              <span id="cn" className={cx("global-marked", css({ textDecoration: "underline" }))}>
                class names
              </span>
            )}
          </ClassNames>
          <button id="blue" onClick={() => setColor("rgb(0, 0, 255)")}>
            blue
          </button>
        </ThemeProvider>
      );
    }
    mount(t, <App />);
    await t.step("red");
    const style = (sel: string, prop: string) => getComputedStyle(t.$(sel)).getPropertyValue(prop);
    t.log("color", style("#themed", "color"), "weight", style("#cn", "font-weight"));
    t.log("decoration", style("#cn", "text-decoration-line"));
    t.$("#blue").click();
    await t.step("blue");
    t.log("color", style("#themed", "color"));
  },
};

// #endregion
