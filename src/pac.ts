// Powly Anti-Cheat (PAC), the game's side. After `Powly.init()` the SDK reports to the Powly page
// every few seconds over its private port: the game's clocks (Powly compares them with its own and
// the server's to catch speed hacks), browser functions that were replaced (speed hack scripts and
// extensions patch timers), traces of automated browsers, and how input arrives (scripted events,
// clicks without pointer movement as AI agents make them, machine-regular timing as macros and
// auto-clickers make them), and whether the player plays at all (any trusted input, gamepads
// included: Powly closes games nobody plays). Nothing is sent anywhere else, and nothing here
// reads what the player types: only event counts and timings.
//
// In real players' runs (not developer mode) the SDK also guards the game's code against being
// copied (`guard`): the browser's context menu and its view-source, save-page and developer-tools
// shortcuts don't open over the game (the game still gets the events), and a debugger trap both
// detects open developer tools and pauses the game whenever someone inspects it.
//
// None of this is a security boundary (the game runs in the player's browser). The Powly server
// decides what a reading means (apps/web/lib/server/pac/). `detectAutomation` and
// `tamperedFunctions` are shared with the Powly page (apps/web/components/player/pac-sensor.ts).

/** How often the SDK reports (ms). */
export const PAC_SAMPLE_MS = 5000;

export type PacSample = {
  type: "pac";
  /** The game's performance.now() and Date.now() when sampled. */
  clock: number;
  date: number;
  /** The largest jump of Date.now() against performance.now() since the last sample (ms). */
  dateJump: number;
  /** Developer tools were open on the game (the debugger trap fired). */
  devtools: boolean;
  tampered: string[];
  automation: string[];
  input: {
    trusted: number;
    synthetic: number;
    clicks: number;
    teleportClicks: number;
    keyIntervals: number;
    keyIntervalSd: number | null;
    clickIntervals: number;
    clickIntervalSd: number | null;
    /** Every trusted interaction: key presses, clicks, taps, pointer movement, wheel, gamepads. */
    activity: number;
  };
};

/** A gamepad axis past this counts as input (sticks rest a little off centre). */
const GAMEPAD_DEADZONE = 0.3;

export const isPacSample = (data: unknown): data is PacSample =>
  typeof data === "object" &&
  data !== null &&
  (data as PacSample).type === "pac" &&
  typeof (data as PacSample).clock === "number" &&
  typeof (data as PacSample).input === "object";

const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;

type AnyFunction = (...args: never[]) => unknown;

/**
 * Whether `fn` is the browser's own function. Known wrappers that keep the original (error
 * trackers, Zone.js) count as native when what they wrap is.
 */
function isNative(fn: unknown, fnToString: (this: AnyFunction) => string): boolean {
  if (typeof fn !== "function") return false;
  try {
    if (NATIVE.test(fnToString.call(fn as AnyFunction))) return true;
  } catch {
    return false;
  }
  const wrapped = fn as AnyFunction & {
    __sentry_original__?: unknown;
    __zone_symbol__OriginalDelegate?: unknown;
  };
  const original = wrapped.__sentry_original__ ?? wrapped.__zone_symbol__OriginalDelegate;
  return original !== undefined && original !== fn && isNative(original, fnToString);
}

/**
 * Browser functions a speed hack or cheat script replaces, by name, when they aren't the
 * browser's own. The clocks ("performance.now", "Date.now") and Function.prototype.toString (which
 * hides patches) are what PAC treats as critical.
 */
export function tamperedFunctions(win: Window & typeof globalThis): string[] {
  const found: string[] = [];
  const fnToString = win.Function.prototype.toString as (this: AnyFunction) => string;
  // Checked with itself first: a replaced toString could vouch for everything else.
  if (!NATIVE.test(fnToString.call(fnToString as unknown as AnyFunction))) {
    found.push("Function.prototype.toString");
  }
  const checks: [string, unknown][] = [
    ["performance.now", win.performance?.now],
    ["Date.now", win.Date.now],
    ["Date", win.Date],
    ["requestAnimationFrame", win.requestAnimationFrame],
    ["setTimeout", win.setTimeout],
    ["setInterval", win.setInterval],
  ];
  for (const [name, fn] of checks) if (!isNative(fn, fnToString)) found.push(name);
  // The browser's own `now` lives on Performance.prototype; a patch puts one on the instance.
  if (win.performance && Object.hasOwn(win.performance, "now")) found.push("performance.now");
  return [...new Set(found)];
}

// Globals and attributes that drivers of automated browsers leave behind.
const AUTOMATION_GLOBALS: [RegExp, string][] = [
  [
    /^\$?cdc_|^\$wdc_|^__webdriver|^__driver_|^__fxdriver|^__selenium|^_selenium|^callSelenium|^_Selenium_IDE/,
    "selenium",
  ],
  [/^__playwright|^__pw_/, "playwright"],
  [/^__puppeteer/, "puppeteer"],
  [/^callPhantom$|^_phantom$|^__phantomas$/, "phantom"],
  [/^__nightmare$/, "nightmare"],
  [/^domAutomation(Controller)?$/, "chrome-automation"],
  [/^__lastWatirAlert|^__lastWatirConfirm|^__lastWatirPrompt/, "watir"],
];

/** Traces of an automated browser (WebDriver, DevTools Protocol drivers, headless browsers). */
export function detectAutomation(win: Window & typeof globalThis): string[] {
  const found = new Set<string>();
  const nav = win.navigator;
  try {
    if (nav.webdriver) found.add("webdriver");
    // The browser defines `webdriver` on Navigator.prototype; stealth plugins hide it on the
    // instance instead.
    if (Object.getOwnPropertyDescriptor(nav, "webdriver")) found.add("webdriver-hidden");
  } catch {}
  if (/HeadlessChrome|PhantomJS|SlimerJS|HtmlUnit/i.test(nav.userAgent)) found.add("headless");
  const names = [...Object.getOwnPropertyNames(win), ...Object.getOwnPropertyNames(win.document)];
  for (const name of names) {
    for (const [pattern, label] of AUTOMATION_GLOBALS) if (pattern.test(name)) found.add(label);
  }
  const root = win.document.documentElement;
  for (const attribute of ["webdriver", "selenium", "driver"]) {
    if (root?.hasAttribute(attribute)) found.add("selenium");
  }
  return [...found];
}

/** Standard deviation of the intervals between `times` (ms), or null for too few. */
function intervalSd(times: number[]) {
  if (times.length < 3) return null;
  const intervals = times.slice(1).map((time, index) => time - (times[index] ?? time));
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  // Only paced input (macros, auto-clickers) is interesting, not held keys or pauses.
  if (mean < 20 || mean > 2000) return null;
  const variance =
    intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  return Math.sqrt(variance);
}

/**
 * Shortcuts that open view-source, save the page or open developer tools: F12, Ctrl+U/S,
 * Ctrl+Shift+I/J/C, and their Cmd(+Option) versions on macOS.
 */
export function isInspectShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
) {
  if (event.key === "F12") return true;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return false;
  const key = event.code.replace(/^Key/, "").toUpperCase();
  if (key === "U") return true;
  if (key === "S") return !event.shiftKey;
  return (event.shiftKey || event.altKey) && (key === "I" || key === "J" || key === "C");
}

/** A paused debugger stops the clock for at least this long (ms) when developer tools are open. */
const TRAP_PAUSE_MS = 100;

/**
 * The debugger trap: does nothing unless developer tools are open, where it pauses. Built at run
 * time so minifiers that drop `debugger` statements (terser's default) keep it; games whose own
 * Content-Security-Policy forbids that simply go without.
 */
function makeTrap(win: Window & typeof globalThis): (() => void) | null {
  try {
    return new win.Function("debugger") as () => void;
  } catch {
    return null;
  }
}

/** How many recent key presses and clicks the timing check looks at. */
const TIMING_WINDOW = 40;

/**
 * Starts reporting to the Powly page over `port`. Returns a function that stops it.
 */
export function startPacSensor(
  port: MessagePort,
  { guard = false }: { guard?: boolean } = {},
  win: Window & typeof globalThis = window,
) {
  const input = {
    trusted: 0,
    synthetic: 0,
    clicks: 0,
    teleportClicks: 0,
    activity: 0,
  };
  const keyTimes: number[] = [];
  const clickTimes: number[] = [];
  // The pointer's last known position, from any pointer event, and whether it moved since.
  let pointer: { x: number; y: number } | null = null;

  const remember = (list: number[], time: number) => {
    list.push(time);
    if (list.length > TIMING_WINDOW) list.shift();
  };

  const onInput = (event: Event) => {
    const counted = event.type === "keydown" || event.type === "pointerdown";
    if (!event.isTrusted) {
      if (counted) input.synthetic += 1;
      return;
    }
    input.activity += 1;
    if (event.type === "wheel") return;
    if (event.type === "pointermove" || event.type === "pointerover") {
      const move = event as PointerEvent;
      pointer = { x: move.clientX, y: move.clientY };
      return;
    }
    if (!counted) return;
    input.trusted += 1;
    if (event.type === "keydown") {
      if (!(event as KeyboardEvent).repeat) remember(keyTimes, event.timeStamp);
      return;
    }
    const down = event as PointerEvent;
    if (down.pointerType !== "mouse") return;
    input.clicks += 1;
    remember(clickTimes, event.timeStamp);
    // A real mouse moves to where it clicks, and the frame hears that; a driver that clicks at
    // coordinates doesn't. Only a click somewhere else than the pointer last was counts.
    if (pointer && Math.hypot(down.clientX - pointer.x, down.clientY - pointer.y) > 4) {
      input.teleportClicks += 1;
    }
    pointer = { x: down.clientX, y: down.clientY };
  };

  const types = ["keydown", "pointerdown", "pointermove", "pointerover", "wheel"];

  // Gamepads send no events: a pressed button or a pushed stick, looked at a few times a second.
  const watchGamepads = () => {
    let pads: (Gamepad | null)[];
    try {
      pads = [...(win.navigator.getGamepads?.() ?? [])];
    } catch {
      return;
    }
    for (const pad of pads) {
      if (!pad?.connected) continue;
      if (
        pad.buttons.some((button) => button.pressed) ||
        pad.axes.some((axis) => Math.abs(axis) > GAMEPAD_DEADZONE)
      ) {
        input.activity += 1;
        return;
      }
    }
  };
  for (const type of types) {
    win.addEventListener(type, onInput, { capture: true, passive: true });
  }

  // The guard: only the browser's own action is prevented; the game's listeners still run.
  const onGuardKey = (event: KeyboardEvent) => {
    if (isInspectShortcut(event)) event.preventDefault();
  };
  const onContextMenu = (event: Event) => event.preventDefault();
  if (guard) {
    win.addEventListener("keydown", onGuardKey, { capture: true });
    win.addEventListener("contextmenu", onContextMenu, { capture: true });
  }
  const trap = guard ? makeTrap(win) : null;
  let devtools = false;
  const springTrap = () => {
    if (!trap) return;
    const start = win.performance.now();
    trap();
    if (win.performance.now() - start > TRAP_PAUSE_MS) devtools = true;
  };

  const now = () => win.performance.now();
  let lastClock = now();
  let lastDate = win.Date.now();
  let dateJump = 0;
  let automation = detectAutomation(win);

  // The date is compared with the monotonic clock more often than reports go out, so a jump in
  // between isn't averaged away.
  const watchDate = () => {
    const clock = now();
    const date = win.Date.now();
    const jump = Math.abs(date - lastDate - (clock - lastClock));
    if (jump > dateJump) dateJump = jump;
    lastClock = clock;
    lastDate = date;
  };

  const report = () => {
    watchDate();
    // Drivers can attach after the game started.
    automation = [...new Set([...automation, ...detectAutomation(win)])];
    const sample: PacSample = {
      type: "pac",
      clock: now(),
      date: win.Date.now(),
      dateJump: Math.round(dateJump),
      devtools,
      tampered: tamperedFunctions(win),
      automation,
      input: {
        ...input,
        keyIntervals: Math.max(keyTimes.length - 1, 0),
        keyIntervalSd: intervalSd(keyTimes),
        clickIntervals: Math.max(clickTimes.length - 1, 0),
        clickIntervalSd: intervalSd(clickTimes),
      },
    };
    try {
      port.postMessage(sample);
    } catch {}
    input.trusted = 0;
    input.synthetic = 0;
    input.clicks = 0;
    input.teleportClicks = 0;
    input.activity = 0;
    dateJump = 0;
    devtools = false;
  };

  // The browser's own timers, taken before anything could replace them later.
  const setInterval = win.setInterval.bind(win);
  const clearInterval = win.clearInterval.bind(win);
  const dateTimer = setInterval(watchDate, 1000);
  const reportTimer = setInterval(report, PAC_SAMPLE_MS);
  const gamepadTimer = setInterval(watchGamepads, 250);
  const trapTimer = trap ? setInterval(springTrap, 1500) : undefined;
  report();

  return () => {
    clearInterval(dateTimer);
    clearInterval(reportTimer);
    clearInterval(gamepadTimer);
    if (trapTimer !== undefined) clearInterval(trapTimer);
    for (const type of types) win.removeEventListener(type, onInput, { capture: true });
    win.removeEventListener("keydown", onGuardKey, { capture: true });
    win.removeEventListener("contextmenu", onContextMenu, { capture: true });
  };
}
