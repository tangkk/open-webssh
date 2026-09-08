import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  base64ToBytes,
  bytesToBase64,
  getOrCreateIdentity,
  signAgentChallenge,
  type DeviceIdentity,
} from "./identity";
import { appConfig } from "./config";
import "./styles.css";

type ServerMessage =
  | { type: "status"; status: "connecting" | "connected" | "closed"; message?: string }
  | { type: "output"; data: string }
  | { type: "sign_request"; id: string; data: string }
  | { type: "tmux_sessions"; sessions: TmuxSession[]; error?: string }
  | { type: "error"; message: string };

type TmuxSession = { name: string; windows: number; attached: boolean };

type ThemeName = "signal" | "tokyo-night" | "catppuccin-mocha" | "gruvbox-dark" | "github-light" | "catppuccin-latte" | "gruvbox-light";
type ThemeDefinition = {
  name: ThemeName;
  label: string;
  preview: [string, string, string];
  xterm: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    brightRed: string;
    scrollbarSliderBackground: string;
    scrollbarSliderHoverBackground: string;
    scrollbarSliderActiveBackground: string;
  };
};

const THEME_STORAGE_KEY = "webssh.theme.v1";
const themes: Record<ThemeName, ThemeDefinition> = {
  signal: {
    name: "signal", label: "Signal", preview: ["#0b0d0c", "#33d17a", "#e4332a"],
    xterm: { background: "#0b0d0c", foreground: "#e8e8e8", cursor: "#e4332a", selectionBackground: "#343434", black: "#141715", red: "#e4332a", brightRed: "#ff625a", scrollbarSliderBackground: "rgba(232, 232, 232, 0.3)", scrollbarSliderHoverBackground: "rgba(232, 232, 232, 0.45)", scrollbarSliderActiveBackground: "rgba(51, 209, 122, 0.55)" },
  },
  "tokyo-night": {
    name: "tokyo-night", label: "Tokyo Night", preview: ["#1a1b26", "#7aa2f7", "#bb9af7"],
    xterm: { background: "#1a1b26", foreground: "#c0caf5", cursor: "#7aa2f7", selectionBackground: "#33467c", black: "#15161e", red: "#f7768e", brightRed: "#ff9eae", scrollbarSliderBackground: "rgba(192, 202, 245, 0.3)", scrollbarSliderHoverBackground: "rgba(192, 202, 245, 0.48)", scrollbarSliderActiveBackground: "rgba(122, 162, 247, 0.66)" },
  },
  "catppuccin-mocha": {
    name: "catppuccin-mocha", label: "Catppuccin Mocha", preview: ["#1e1e2e", "#cba6f7", "#f5c2e7"],
    xterm: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5c2e7", selectionBackground: "#45475a", black: "#181825", red: "#f38ba8", brightRed: "#f5a0b8", scrollbarSliderBackground: "rgba(205, 214, 244, 0.3)", scrollbarSliderHoverBackground: "rgba(205, 214, 244, 0.48)", scrollbarSliderActiveBackground: "rgba(203, 166, 247, 0.68)" },
  },
  "gruvbox-dark": {
    name: "gruvbox-dark", label: "Gruvbox Dark", preview: ["#282828", "#fabd2f", "#b8bb26"],
    xterm: { background: "#282828", foreground: "#ebdbb2", cursor: "#fabd2f", selectionBackground: "#504945", black: "#1d2021", red: "#fb4934", brightRed: "#ff6b55", scrollbarSliderBackground: "rgba(235, 219, 178, 0.3)", scrollbarSliderHoverBackground: "rgba(235, 219, 178, 0.48)", scrollbarSliderActiveBackground: "rgba(250, 189, 47, 0.68)" },
  },
  "github-light": {
    name: "github-light", label: "GitHub Light", preview: ["#ffffff", "#0969da", "#cf222e"],
    xterm: { background: "#ffffff", foreground: "#24292f", cursor: "#0969da", selectionBackground: "#b6e3ff", black: "#24292f", red: "#cf222e", brightRed: "#a40e26", scrollbarSliderBackground: "rgba(36, 41, 47, 0.24)", scrollbarSliderHoverBackground: "rgba(36, 41, 47, 0.38)", scrollbarSliderActiveBackground: "rgba(9, 105, 218, 0.62)" },
  },
  "catppuccin-latte": {
    name: "catppuccin-latte", label: "Catppuccin Latte", preview: ["#eff1f5", "#8839ef", "#dc8a78"],
    xterm: { background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", selectionBackground: "#ccd0da", black: "#5c5f77", red: "#d20f39", brightRed: "#e64553", scrollbarSliderBackground: "rgba(76, 79, 105, 0.24)", scrollbarSliderHoverBackground: "rgba(76, 79, 105, 0.38)", scrollbarSliderActiveBackground: "rgba(136, 57, 239, 0.58)" },
  },
  "gruvbox-light": {
    name: "gruvbox-light", label: "Gruvbox Light", preview: ["#fbf1c7", "#d65d0e", "#98971a"],
    xterm: { background: "#fbf1c7", foreground: "#3c3836", cursor: "#d65d0e", selectionBackground: "#d5c4a1", black: "#3c3836", red: "#cc241d", brightRed: "#9d0006", scrollbarSliderBackground: "rgba(60, 56, 54, 0.24)", scrollbarSliderHoverBackground: "rgba(60, 56, 54, 0.38)", scrollbarSliderActiveBackground: "rgba(214, 93, 14, 0.58)" },
  },
};

function storedTheme(): ThemeName {
  try {
    const candidate = localStorage.getItem(THEME_STORAGE_KEY);
    if (candidate && candidate in themes) return candidate as ThemeName;
  } catch {
    // Default remains available when storage is unavailable.
  }
  return "signal";
}

let activeTheme = storedTheme();

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <section class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="signal" id="signal"></span>
        <div><strong>Web SSH</strong><small id="status">Preparing device key</small></div>
      </div>
      <button class="icon-button" id="device-button" aria-label="Device key">Key</button>
    </header>
    <div class="terminal-wrap" id="terminal-wrap">
      <div class="tab-bar" id="tab-bar" hidden>
        <button class="tab-add" id="tab-add" type="button" aria-label="New terminal">＋</button>
        <button class="tab-theme" id="theme-toggle" type="button" aria-label="Choose theme" aria-expanded="false" title="Theme">◐</button>
      </div>
      <div class="theme-menu" id="theme-menu" role="menu" aria-label="Terminal theme" hidden></div>
      <div id="terminal"></div>
      <section class="onboarding" id="onboarding">
        <p class="eyebrow">PRIVATE SSH ACCESS</p>
        <div class="title-row"><h1>Web SSH</h1><span class="target-badge"><i></i>${appConfig.targetLabel}</span></div>
        <p class="lede">A focused terminal gateway for ${appConfig.targetLabel}. The SSH private key stays in this device's browser; ${appConfig.gatewayLabel} only relays the session and never stores the private key.</p>
        <div class="key-card">
          <span>This device's public-key fingerprint</span>
          <code id="fingerprint">Generating…</code>
        </div>
        <button class="primary" id="connect" disabled>Connect to ${appConfig.targetLabel}</button>
        <button class="secondary" id="copy-key" disabled>Copy public key to authorize this device</button>
        <p class="hint" id="hint">On first use, add this public key to ${appConfig.targetLabel}.</p>
      </section>
    </div>
    <div class="command-bar" id="command-bar" aria-label="Terminal controls">
      <div class="command-row command-row-commands">
        <button class="control-key agent-key" id="codex-resume" type="button" aria-label="Send codex resume --all --no-alt-screen" title="Codex">C</button>
        <button class="control-key agent-key" id="hermes-sessions" type="button" aria-label="Open Hermes and list sessions" title="Hermes">H</button>
        <button class="control-key agent-key" id="openclaw-sessions" type="button" aria-label="Open OpenClaw and list sessions" title="OpenClaw">O</button>
        <button class="control-key agent-key" id="tmux-attach" type="button" aria-label="Choose a tmux session" aria-expanded="false" title="tmux sessions">T</button>
        <button class="control-key agent-key" id="agent-commands" type="button" aria-label="Open common commands for the current agent" aria-expanded="false" title="Agent commands">⋯</button>
        <button class="control-key copy-key" id="copy-selection" type="button" aria-label="Copy selected text" disabled>⧉</button>
        <button class="control-key" id="paste" type="button" aria-label="Paste clipboard contents">⎘</button>
        <button class="control-key" id="clear-screen" type="button" aria-label="Clear screen">⌧</button>
        <button class="control-key" id="page-up" type="button" aria-label="Page up">⇞</button>
        <button class="control-key" id="page-down" type="button" aria-label="Page down">⇟</button>
      </div>
      <div class="command-row command-row-keys">
        <button class="exit-key" id="exit-ssh" type="button" aria-label="Logout">⏻</button>
        <button class="control-key" id="escape-key" type="button" aria-label="Send Escape">⎋</button>
        <button class="control-key" id="tab-key" type="button" aria-label="Send Tab">⇥</button>
        <button class="control-key arrow-key" id="arrow-up" type="button" aria-label="Send arrow up">↑</button>
        <button class="control-key arrow-key" id="arrow-down" type="button" aria-label="Send arrow down">↓</button>
        <button class="control-key cursor-key" id="cursor-location" type="button" aria-label="Return to terminal cursor">⌖</button>
        <button class="control-key keyboard-open-key" id="keyboard-open" type="button" aria-label="Open keyboard">⌨</button>
        <button class="control-key" id="ctrl-d" type="button" aria-label="Keyboard resize: resize on space" title="Keyboard resize toggle">⇄</button>
        <button class="control-key" id="ctrl-c" type="button" aria-label="Send Ctrl-C">␃</button>
        <button class="control-key enter-key" id="enter-key" type="button" aria-label="Send Enter">↵</button>
      </div>
      <div class="slash-menu" id="agent-command-menu" role="menu" aria-label="Common commands for the current agent" hidden></div>
      <div class="slash-menu" id="tmux-session-menu" role="menu" aria-label="Tmux sessions" hidden></div>
    </div>
    <dialog id="device-dialog">
      <form method="dialog">
        <div class="dialog-head"><strong>This device's key</strong><button aria-label="Close">Done</button></div>
        <p>The private key is non-exportable and stored in this browser. Clearing site data requires re-enrollment.</p>
        <label>Public-key fingerprint</label><code id="dialog-fingerprint"></code>
        <label>OpenSSH public key</label><textarea id="public-key" readonly></textarea>
        <button type="button" class="primary compact" id="dialog-copy">Copy public key</button>
      </form>
    </dialog>
  </section>
`;

let terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "bar",
  fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.18,
  scrollback: 4000,
  disableStdin: false,
  theme: themes[activeTheme].xterm,
});
let fit = new FitAddon();
terminal.loadAddon(fit);
let terminalHost = document.querySelector<HTMLElement>("#terminal")!;
terminal.open(terminalHost);
terminal.onScroll(() => updateScrollbarVisibility());
terminal.buffer.onBufferChange(() => updateScrollbarVisibility());
let terminalInput = terminalHost.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let allowTerminalFocus = false;
const keyboardGuardedTextareas = new WeakSet<HTMLTextAreaElement>();
terminalHost.addEventListener("pointerdown", () => {
  if (!isMobileDevice) terminal.focus();
});
function bindTextareaKeyboardGuards(textarea: HTMLTextAreaElement | null) {
  if (!textarea || keyboardGuardedTextareas.has(textarea)) return;
  keyboardGuardedTextareas.add(textarea);
  textarea.addEventListener("focus", () => {
    if (!isMobileDevice) return;
    if (allowTerminalFocus) {
      allowTerminalFocus = false;
      return;
    }
    terminal.blur();
  });
  textarea.addEventListener("blur", () => {
    releaseKeyboardReservation();
  });
}
bindTextareaKeyboardGuards(terminalInput);
terminalInput?.setAttribute("lang", "zh-CN");
terminalInput?.setAttribute("autocomplete", "off");
terminalInput?.setAttribute("autocorrect", "off");
terminalInput?.setAttribute("autocapitalize", "none");
terminalInput?.setAttribute("spellcheck", "false");

// iOS Chinese IME submits full-width punctuation and spaces directly through
// beforeinput without a composition flow, which xterm 6 can drop. Forward only
// non-ASCII text that is neither composing nor freshly committed; let xterm
// handle composing CJK text, and leave ASCII to its keydown path to avoid duplicates.
let imeComposing = false;
let imeJustCommitted = false;
let lastCommittedText = "";
terminalInput?.addEventListener("compositionstart", () => {
  imeLog("compstart");
  imeComposing = true;
  imeJustCommitted = false;
  lastCommittedText = "";
});
terminalInput?.addEventListener("beforeinput", (event) => {
  imeLog("beforeinput", `data=${JSON.stringify(event.data)} inputType=${event.inputType} isComposing=${event.isComposing}`);
  if (!event.data) return;
  // iOS may resend the same composed text as insertText after compositionend; skip it.
  if (event.data === lastCommittedText) return;
  // Full-width space U+3000 can be dropped by xterm 6 on iOS. Forward it only
  // outside composition; during composition, let xterm handle it asynchronously.
  if (event.data.includes("\u3000")) {
    if (imeComposing || event.isComposing || imeJustCommitted) return;
    event.preventDefault();
    sendTerminalInput(event.data);
    return;
  }
  if (imeComposing || event.isComposing || imeJustCommitted) return;
  // Handle only direct insertText as a fallback (full-width punctuation uses this inputType).
  // insertCompositionText is handled by xterm at compositionend; preventDefault is
  // unreliable on iOS, and forwarding it here would duplicate xterm's asynchronous send.
  if (event.inputType !== "insertText") return;
  if (![...event.data].some((character) => character.codePointAt(0)! > 0x7f)) return;
  event.preventDefault();
  sendTerminalInput(event.data);
});

// iOS composition bug in xterm 6: committing Chinese text can trigger multiple
// send paths. Candidate selection may send through input, space/Enter may send
// through keydown, and compositionend may send again. During composition, stop
// xterm's keydown/input handlers at the document capture phase without preventing
// default, so the compositionend path sends the text exactly once.
document.addEventListener("keydown", (event) => {
  if (event.target === terminalInput) imeLog("keydown", `key=${event.key} keyCode=${event.keyCode} imeComposing=${imeComposing}`);
  if (event.target !== terminalInput) return;
  // During composition, block xterm keydown handling, which would send early.
  // keyCode 229 / key "Process" marks the iOS IME; block xterm's textarea-change
  // handler too, because it can resend the textarea delta after compositionend.
  if (imeComposing || event.keyCode === 229 || event.key === "Process") {
    event.stopImmediatePropagation();
  }
}, { capture: true });
document.addEventListener("input", (event) => {
  if (event.target === terminalInput) imeLog("input", `data=${JSON.stringify((event as InputEvent).data)} inputType=${(event as InputEvent).inputType}`);
  if (event.target !== terminalInput) return;
  if (imeComposing) { event.stopImmediatePropagation(); return; }
  // Block xterm's input event when iOS resends the same composed text after compositionend.
  if (lastCommittedText && (event as InputEvent).data === lastCommittedText) {
    event.stopImmediatePropagation();
    lastCommittedText = "";
  }
}, { capture: true });
// After a normal non-empty compositionend, iOS may emit an extra empty compositionend.
// xterm's finalize path can then resend stale textarea content because the normal
// textarea-change handler was blocked above. An empty compositionend should send
// nothing, so block xterm's handling during capture.
document.addEventListener("compositionend", (event) => {
  if (event.target !== terminalInput) return;
  const data = (event as CompositionEvent).data || "";
  imeLog("compend", JSON.stringify(data));
  imeComposing = false;
  imeJustCommitted = true;
  lastCommittedText = data;
  window.setTimeout(() => { imeJustCommitted = false; }, 0);
  if (!data) {
    event.stopImmediatePropagation();
  }
}, { capture: true });

let touchLastY = 0;
let touchLastTime = 0;
let touchVelocity = 0;
let touchMoved = false;
let longPressActive = false;
let longPressTimer: number | undefined;
let selectionStart: { column: number; row: number } | undefined;
let selectionRange: { from: { column: number; row: number }; to: { column: number; row: number } } | undefined;
let inertiaFrame: number | undefined;
let fitFrame: number | undefined;

// xterm 6 scrolling is virtual (a Scrollable model with a custom scrollbar):
// .xterm-viewport has no native scroll space, so changing scrollTop is a no-op.
// scrollLines accepts fractional values and preserves sub-line precision internally.
function scrollTerminalPixels(pixels: number) {
  const rowHeight = Number(terminal.options.fontSize || 12) * Number(terminal.options.lineHeight || 1.18);
  terminal.scrollLines(pixels / rowHeight);
}

function updateScrollbarVisibility() {
  terminalHost.classList.toggle("has-scrollback", terminal.buffer.active.baseY > 0);
}

function isScrollbarTouch(event: TouchEvent) {
  return event.target instanceof HTMLElement && event.target.closest(".scrollbar") !== null;
}

function terminalCellAt(clientX: number, clientY: number) {
  const screen = terminalHost.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return undefined;
  const bounds = screen.getBoundingClientRect();
  const cellWidth = bounds.width / terminal.cols;
  const cellHeight = bounds.height / terminal.rows;
  const column = Math.max(0, Math.min(terminal.cols - 1, Math.floor((clientX - bounds.left) / cellWidth)));
  const visibleRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((clientY - bounds.top) / cellHeight)));
  // xterm.select() expects the absolute buffer row.
  return { column, row: terminal.buffer.active.viewportY + visibleRow };
}

function selectTerminalRange(from: { column: number; row: number }, to: { column: number; row: number }) {
  selectionRange = { from, to };
  const start = from.row * terminal.cols + from.column;
  const end = to.row * terminal.cols + to.column;
  if (end >= start) terminal.select(from.column, from.row, end - start + 1);
  else terminal.select(to.column, to.row, start - end + 1);
}

terminalHost.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1) return;
  // Touches on xterm's custom scrollbar are left to xterm's own thumb dragging.
  if (isScrollbarTouch(event)) return;
  terminal.blur();
  if (inertiaFrame !== undefined) cancelAnimationFrame(inertiaFrame);
  inertiaFrame = undefined;
  if (longPressTimer !== undefined) clearTimeout(longPressTimer);
  longPressActive = false;
  selectionRange = undefined;
  copySelectionButton?.setAttribute("disabled", "");
  selectionStart = terminalCellAt(event.touches[0].clientX, event.touches[0].clientY);
  longPressTimer = window.setTimeout(() => {
    longPressActive = true;
    if (selectionStart) terminal.select(selectionStart.column, selectionStart.row, 1);
  }, 650);
  touchLastY = event.touches[0].clientY;
  touchLastTime = performance.now();
  touchVelocity = 0;
  touchMoved = false;
}, { passive: true, capture: true });

terminalHost.addEventListener("touchmove", (event) => {
  if (event.touches.length !== 1) return;
  if (isScrollbarTouch(event)) return;
  if (longPressActive) {
    event.preventDefault();
    event.stopPropagation();
    const current = terminalCellAt(event.touches[0].clientX, event.touches[0].clientY);
    if (selectionStart && current) selectTerminalRange(selectionStart, current);
    return;
  }
  const now = performance.now();
  const currentY = event.touches[0].clientY;
  const delta = touchLastY - currentY;
  const elapsed = Math.max(1, now - touchLastTime);
  event.preventDefault();
  event.stopPropagation();
  if (Math.abs(delta) > 6) {
    touchMoved = true;
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  }
  if (touchMoved) {
    scrollTerminalPixels(delta);
    const instantVelocity = delta / elapsed;
    touchVelocity = touchVelocity * 0.65 + instantVelocity * 0.35;
  }
  touchLastY = currentY;
  touchLastTime = now;
}, { passive: false, capture: true });

terminalHost.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "touch" || !longPressActive) return;
  event.preventDefault();
  event.stopPropagation();
  const current = terminalCellAt(event.clientX, event.clientY);
  if (selectionStart && current) selectTerminalRange(selectionStart, current);
}, { passive: false, capture: true });

terminalHost.addEventListener("touchend", (event) => {
  if (isScrollbarTouch(event)) return;
  if (longPressTimer !== undefined) clearTimeout(longPressTimer);
  longPressTimer = undefined;
  if (longPressActive) {
    longPressActive = false;
    selectionStart = undefined;
    touchMoved = false;
    return;
  }
  if (!touchMoved || Math.abs(touchVelocity) < 0.08) return;
  let velocity = Math.max(-2.4, Math.min(2.4, touchVelocity));
  let previous = performance.now();
  const coast = (now: number) => {
    const elapsed = Math.min(32, now - previous);
    previous = now;
    scrollTerminalPixels(velocity * elapsed);
    velocity *= Math.pow(0.92, elapsed / 16);
    if (Math.abs(velocity) >= 0.025) inertiaFrame = requestAnimationFrame(coast);
    else inertiaFrame = undefined;
  };
  inertiaFrame = requestAnimationFrame(coast);
}, { passive: true, capture: true });

terminalHost.addEventListener("touchcancel", () => {
  if (longPressTimer !== undefined) clearTimeout(longPressTimer);
  longPressTimer = undefined;
  longPressActive = false;
  selectionStart = undefined;
  touchMoved = false;
  touchVelocity = 0;
}, { passive: true, capture: true });

const onboarding = document.querySelector<HTMLElement>("#onboarding")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy-key")!;
const signal = document.querySelector<HTMLElement>("#signal")!;
const status = document.querySelector<HTMLElement>("#status")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const dialog = document.querySelector<HTMLDialogElement>("#device-dialog")!;
const commandBar = document.querySelector<HTMLElement>("#command-bar")!;
let identity: DeviceIdentity;
let socket: WebSocket | undefined;
let shouldReconnect = false;
let tmuxAttached = false;
type AgentKind = "shell" | "codex" | "hermes" | "openclaw";
type TerminalTab = { id: number; name: string; host: HTMLElement; terminal: Terminal; fit: FitAddon; socket?: WebSocket; tmuxAttached: boolean; agent: AgentKind };
const tabBar = document.querySelector<HTMLElement>("#tab-bar")!;
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const themeMenu = document.querySelector<HTMLElement>("#theme-menu")!;
const panels = document.querySelector<HTMLElement>("#terminal-wrap")!;
const tabs: TerminalTab[] = [];
let activeTab: TerminalTab | undefined;
let nextTabId = 1;

function renderTabs() {
  tabBar.hidden = onboarding.hidden === false;
  tabBar.querySelectorAll(".terminal-tab").forEach((node) => node.remove());
  const add = document.querySelector<HTMLButtonElement>("#tab-add")!;
  tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.className = "terminal-tab";
    button.type = "button";
    button.dataset.active = String(tab === activeTab);
    button.textContent = tab.name;
    button.addEventListener("click", () => activateTab(tab));
    tabBar.insertBefore(button, add);
  });
}

function renderThemeMenu() {
  const choices = Object.values(themes).map((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.dataset.theme = theme.name;
    button.setAttribute("aria-checked", String(theme.name === activeTheme));
    const preview = document.createElement("span");
    preview.className = "theme-preview";
    theme.preview.forEach((color) => {
      const swatch = document.createElement("i");
      swatch.style.background = color;
      preview.appendChild(swatch);
    });
    const label = document.createElement("span");
    label.textContent = theme.label;
    button.append(preview, label);
    return button;
  });
  themeMenu.replaceChildren(...choices);
}

function setThemeMenu(open: boolean) {
  themeMenu.hidden = !open;
  themeToggle.setAttribute("aria-expanded", String(open));
}

function applyTheme(themeName: ThemeName) {
  activeTheme = themeName;
  document.documentElement.dataset.theme = themeName;
  const xtermTheme = themes[themeName].xterm;
  tabs.forEach((tab) => {
    tab.terminal.options.theme = xtermTheme;
    tab.terminal.refresh(0, tab.terminal.rows - 1);
  });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeName);
  } catch {
    // The active theme still applies for this session.
  }
  renderThemeMenu();
}

function activateTab(tab: TerminalTab) {
  activeTab = tab;
  terminal = tab.terminal;
  fit = tab.fit;
  terminalHost = tab.host;
  terminalInput = terminalHost.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  bindTextareaKeyboardGuards(terminalInput);
  socket = tab.socket;
  tmuxAttached = tab.tmuxAttached;
  setAgentCommandMenu(false);
  renderAgentCommandMenu();
  tabs.forEach((item) => { item.host.hidden = item !== tab; });
  renderTabs();
  onboarding.hidden = true;
  document.querySelector(".shell")?.classList.add("connected");
  commandBar.classList.add("visible");
  fitTerminal();
  updateScrollbarVisibility();
  if (!isMobileDevice) terminal.focus();
}

function createAdditionalTab() {
  const host = document.createElement("div");
  host.className = "terminal-panel";
  host.hidden = true;
  panels.appendChild(host);
  const nextTerminal = new Terminal({ cursorBlink: true, cursorStyle: "bar", fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace', fontSize: 12, lineHeight: 1.18, scrollback: 4000, disableStdin: false, theme: themes[activeTheme].xterm });
  const nextFit = new FitAddon(); nextTerminal.loadAddon(nextFit); nextTerminal.open(host);
  const tab: TerminalTab = { id: nextTabId++, name: `Terminal ${nextTabId - 1}`, host, terminal: nextTerminal, fit: nextFit, tmuxAttached: false, agent: "shell" };
  tabs.push(tab);
  nextTerminal.onData((data) => { if (tab.socket?.readyState === WebSocket.OPEN) tab.socket.send(JSON.stringify({ type: "input", data: bytesToBase64(new TextEncoder().encode(data)) })); });
  nextTerminal.onScroll(() => { if (activeTab === tab) updateScrollbarVisibility(); });
  nextTerminal.buffer.onBufferChange(() => { if (activeTab === tab) updateScrollbarVisibility(); });
  host.addEventListener("pointerdown", () => { if (!isMobileDevice && activeTab === tab) nextTerminal.focus(); });
  activateTab(tab);
  connectTab(tab);
}

function connectTab(tab: TerminalTab) {
  const tabSocket = new WebSocket(websocketUrl()); tab.socket = tabSocket;
  tabSocket.addEventListener("open", () => { tab.socket = tabSocket; if (activeTab === tab) socket = tabSocket; sendToTab(tab, { type: "hello", keyBlob: bytesToBase64(identity.keyBlob), publicKey: identity.authorizedKey, fingerprint: identity.fingerprint, cols: tab.terminal.cols, rows: tab.terminal.rows }); });
  tabSocket.addEventListener("message", async (event) => { const message = JSON.parse(String(event.data)) as ServerMessage; if (message.type === "sign_request") { try { const signature = await signAgentChallenge(identity, base64ToBytes(message.data)); if (tabSocket.readyState === WebSocket.OPEN) tabSocket.send(JSON.stringify({ type: "sign_response", id: message.id, signature })); } catch (error) { if (tabSocket.readyState === WebSocket.OPEN) tabSocket.send(JSON.stringify({ type: "sign_response", id: message.id, error: String(error) })); } return; } if (message.type === "output") tab.terminal.write(base64ToBytes(message.data)); if (message.type === "tmux_sessions" && tab === activeTab) renderTmuxSessionMenu(message.sessions, message.error); if (message.type === "status" && tab === activeTab) { if (message.status === "connecting") setStatus(message.message || "Authenticating SSH…", "working"); if (message.status === "connected") { setStatus(`Connected · ${appConfig.targetLabel}`, "online"); fitTerminal(); } if (message.status === "closed") setStatus(message.message || "Connection closed", "error"); } });
  tabSocket.addEventListener("close", () => { tab.socket = undefined; if (tab === activeTab) { socket = undefined; setStatus("Disconnected", "error"); } });
}

const initialTab: TerminalTab = { id: nextTabId++, name: "Terminal 1", host: terminalHost, terminal, fit, tmuxAttached: false, agent: "shell" };
tabs.push(initialTab);
activeTab = initialTab;
renderTabs();

function setStatus(value: string, state: "idle" | "working" | "online" | "error" = "idle") {
  status.textContent = value;
  signal.dataset.state = state;
}

async function copyPublicKey() {
  await navigator.clipboard.writeText(identity.authorizedKey);
  hint.textContent = "Public key copied. Authorize this device, then return here to connect.";
  copyButton.textContent = "Copied";
  setTimeout(() => (copyButton.textContent = "Copy public key to authorize this device"), 1600);
}

function send(message: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendToTab(tab: TerminalTab, message: object) {
  if (tab.socket?.readyState === WebSocket.OPEN) tab.socket.send(JSON.stringify(message));
}

function sendTerminalInput(value: string) {
  send({ type: "input", data: bytesToBase64(new TextEncoder().encode(value)) });
}

function fitTerminal(keepRemoteRows = false) {
  if (!onboarding.hidden) return;
  if (fitFrame !== undefined) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = undefined;
    const previousScrollLine = terminal.buffer.active.viewportY;
    const wasAtBottom = previousScrollLine >= terminal.buffer.active.baseY;
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    fit.fit();
    updateScrollbarVisibility();
    if (wasAtBottom) terminal.scrollToBottom();
    else terminal.scrollToLine(previousScrollLine);
    if (terminal.cols !== previousCols || (!keepRemoteRows && terminal.rows !== previousRows)) {
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    }
  });
}

let outputQueue: Uint8Array[] = [];
let outputFrame: number | undefined;
function queueTerminalOutput(data: Uint8Array) {
  outputQueue.push(data);
  if (outputFrame !== undefined) return;
  outputFrame = requestAnimationFrame(() => {
    outputFrame = undefined;
    const restoreDesktopFocus = () => {
      if (!isMobileDevice && document.activeElement === document.body) terminal.focus();
    };
    if (outputQueue.length === 1) {
      terminal.write(outputQueue[0], restoreDesktopFocus);
    } else if (outputQueue.length > 1) {
      const length = outputQueue.reduce((total, chunk) => total + chunk.length, 0);
      const combined = new Uint8Array(length);
      let offset = 0;
      for (const chunk of outputQueue) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      terminal.write(combined, restoreDesktopFocus);
    }
    outputQueue = [];
  });
}

let maximumViewportHeight = window.visualViewport?.height || window.innerHeight;
let keyboardOpen = false;
let keyboardReserved = false;
// Keyboard resize mode: true = CSS-only (resize on space, no redraw, default);
// false = fit (resize immediately with a redraw).
let keyboardCssMode = true;

// This iOS device delays publishing the visualViewport height until the first
// keyboard input, so resize listeners and polling cannot react in time. When the
// keyboard opens, reserve an estimated keyboard height immediately by changing
// only the shell CSS; xterm and the remote PTY keep their size. Correct it once
// the real viewport height arrives. The estimate is cached per orientation.
const KEYBOARD_HEIGHT_STORAGE_KEY = "webssh.keyboardHeight.v1";
let cachedKeyboardHeights: { portrait?: number; landscape?: number } = {};
try {
  cachedKeyboardHeights = JSON.parse(localStorage.getItem(KEYBOARD_HEIGHT_STORAGE_KEY) || "{}");
} catch {
  cachedKeyboardHeights = {};
}

function currentOrientation(): "portrait" | "landscape" {
  return window.innerWidth > window.innerHeight ? "landscape" : "portrait";
}

function estimatedKeyboardHeight(): number {
  const full = maximumViewportHeight || window.innerHeight;
  const cached = cachedKeyboardHeights[currentOrientation()];
  if (cached && cached > 150) return Math.min(cached, Math.round(full * 0.75));
  return Math.round(full * (currentOrientation() === "landscape" ? 0.7 : 0.45));
}

function rememberKeyboardHeight(measured: number) {
  if (measured <= 150) return;
  cachedKeyboardHeights[currentOrientation()] = Math.round(measured);
  try {
    localStorage.setItem(KEYBOARD_HEIGHT_STORAGE_KEY, JSON.stringify(cachedKeyboardHeights));
  } catch {
    // storage unavailable: estimation still works for this session
  }
}

function updateVisualViewport(shouldFit = true) {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const top = viewport?.offsetTop || 0;
  if (height > maximumViewportHeight) maximumViewportHeight = height;
  keyboardOpen = height < maximumViewportHeight - 100;
  // If keyboard space is reserved but the measured viewport is still full height,
  // this is usually a stray resize during the iOS keyboard animation. Do not let
  // it overwrite the reservation. If focus left the terminal, the keyboard is
  // actually gone, so release the reservation and restore full height.
  if (keyboardReserved && !keyboardOpen) {
    if (document.activeElement === terminalInput) return;
    keyboardReserved = false;
    document.documentElement.classList.remove("keyboard-requested");
  }
  if (keyboardOpen) rememberKeyboardHeight(maximumViewportHeight - height);
  document.documentElement.style.setProperty("--viewport-height", `${height}px`);
  document.documentElement.style.setProperty("--viewport-top", `${top}px`);
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  // CSS-only mode (default): fit back to full height only after keyboard close;
  // while open, resize the container without redrawing (space triggers resize).
  // Fit mode redraws and syncs the remote PTY during keyboard transitions.
  if (shouldFit && (!keyboardCssMode || !keyboardOpen)) fitTerminal(false);
}

function reserveForKeyboard() {
  const full = maximumViewportHeight || window.innerHeight;
  const reserved = Math.max(Math.round(full * 0.25), full - estimatedKeyboardHeight());
  keyboardReserved = true;
  document.documentElement.classList.add("keyboard-requested");
  document.documentElement.style.setProperty("--viewport-height", `${reserved}px`);
  document.documentElement.style.setProperty("--viewport-top", "0px");
  // Fit mode: immediately resize rows (a real canvas resize forces iOS to commit
  // the frame) and synchronize the remote PTY.
  if (!keyboardCssMode) fitTerminal(false);
  requestAnimationFrame(flushTerminalPaint);
  window.setTimeout(flushTerminalPaint, 350);
}

  // Fit already forces a frame through canvas resize. Refresh xterm once more and
  // promote the shell to its own compositing layer as a second safeguard.
let shellLayerPromoted = false;
function flushTerminalPaint() {
  terminal.refresh(0, terminal.rows - 1);
  const shell = document.querySelector<HTMLElement>(".shell");
  if (shell && !shellLayerPromoted) {
    shellLayerPromoted = true;
    shell.style.transform = "translateZ(0)";
  }
}

function releaseKeyboardReservation() {
  if (!keyboardReserved) return;
  keyboardReserved = false;
  document.documentElement.classList.remove("keyboard-requested");
  // The viewport may not have recovered during the close animation. Refresh now,
  // then verify twice after the animation ends.
  updateVisualViewport(true);
  flushTerminalPaint();
  window.setTimeout(() => { updateVisualViewport(true); flushTerminalPaint(); }, 250);
  window.setTimeout(() => { updateVisualViewport(true); flushTerminalPaint(); }, 700);
}

// iOS delays visualViewport resize events until the first keypress. After the
// keyboard opens, poll the viewport: resize the terminal on changes and fit once
// the height stabilizes.
function pollViewportUntilStable() {
  let lastHeight = window.visualViewport?.height ?? window.innerHeight;
  let stableFrames = 0;
  let frames = 0;
  let sawChange = false;
  const tick = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    if (height !== lastHeight) {
      lastHeight = height;
      sawChange = true;
      stableFrames = 0;
      updateVisualViewport(false);
    } else {
      stableFrames += 1;
    }
    frames += 1;
    if (sawChange && stableFrames >= 8) {
      updateVisualViewport(true);
      return;
    }
    if (frames < 150) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function websocketUrl() {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}

function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  shouldReconnect = true;
  connectButton.disabled = true;
  setStatus(`Connecting to ${appConfig.gatewayLabel}…`, "working");
  socket = new WebSocket(websocketUrl());
  initialTab.socket = socket;

  socket.addEventListener("open", () => {
    send({
      type: "hello",
      keyBlob: bytesToBase64(identity.keyBlob),
      publicKey: identity.authorizedKey,
      fingerprint: identity.fingerprint,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.type === "sign_request") {
      try {
        const signature = await signAgentChallenge(identity, base64ToBytes(message.data));
        send({ type: "sign_response", id: message.id, signature });
      } catch (error) {
        send({ type: "sign_response", id: message.id, error: String(error) });
      }
      return;
    }
    if (message.type === "output") {
      const output = base64ToBytes(message.data);
      if (activeTab === initialTab) queueTerminalOutput(output);
      else initialTab.terminal.write(output);
      return;
    }
    if (message.type === "tmux_sessions") {
      renderTmuxSessionMenu(message.sessions, message.error);
      return;
    }
    if (message.type === "error") {
      setStatus(message.message, "error");
      hint.textContent = message.message;
      connectButton.disabled = false;
      return;
    }
    if (message.type === "status") {
      if (message.status === "connected") {
        onboarding.hidden = true;
        document.querySelector(".shell")?.classList.add("connected");
        document.documentElement.classList.add("connected");
        commandBar.classList.add("visible");
        renderTabs();
        requestAnimationFrame(() => {
          fit.fit();
          send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
          if (!isMobileDevice) terminal.focus();
        });
        setStatus(`Connected · ${appConfig.targetLabel}`, "online");
      } else if (message.status === "connecting") {
        setStatus(message.message || "Authenticating SSH…", "working");
      } else {
        setStatus(message.message || "Connection closed", "error");
        connectButton.disabled = false;
      }
    }
  });

  socket.addEventListener("close", () => {
    socket = undefined;
    setStatus("Disconnected; ready to reconnect", "error");
    connectButton.disabled = false;
  });

  socket.addEventListener("error", () => setStatus(`Unable to connect to ${appConfig.gatewayLabel}`, "error"));
}

terminal.onData((data) => {
  imeLog("SEND", JSON.stringify(data));
  sendTerminalInput(data);
});
window.addEventListener("resize", () => { updateVisualViewport(true); });
window.visualViewport?.addEventListener("resize", () => { updateVisualViewport(true); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldReconnect && !socket) connect();
  if (document.visibilityState === "visible") updateVisualViewport();
});
document.querySelector("#ctrl-c")?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  sendTerminalInput("\u0003");
  terminal.scrollToBottom();
});
const ctrlDButton = document.querySelector<HTMLButtonElement>("#ctrl-d");
function updateKeyboardFitButton() {
  ctrlDButton?.classList.toggle("keyboard-css-off", !keyboardCssMode);
  ctrlDButton?.setAttribute(
    "aria-label",
    keyboardCssMode ? "Keyboard resize: resize on space (no redraw)" : "Keyboard resize: resize immediately (redraw)",
  );
  ctrlDButton?.setAttribute(
    "title",
    keyboardCssMode ? "Tap to switch to immediate resize mode" : "Tap to switch to no-redraw mode",
  );
}
ctrlDButton?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  keyboardCssMode = !keyboardCssMode;
  updateKeyboardFitButton();
});
updateKeyboardFitButton();
function bindControlKey(selector: string, sequence: string) {
  document.querySelector(selector)?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    sendTerminalInput(sequence);
  });
}
bindControlKey("#escape-key", "\u001b");
bindControlKey("#tab-key", "\t");
bindControlKey("#arrow-up", "\u001b[A");
bindControlKey("#arrow-down", "\u001b[B");
bindControlKey("#enter-key", "\r");
type AgentCommand = { command: string; description: string };
const agentCommands: Record<Exclude<AgentKind, "shell">, AgentCommand[]> = {
  codex: [
    { command: "/status", description: "Session and usage" },
    { command: "/model", description: "View or switch model" },
    { command: "/compact", description: "Compact the current context" },
    { command: "/help", description: "Show available commands" },
  ],
  hermes: [
    { command: "/status", description: "Session, model, and context" },
    { command: "/model", description: "View or switch model" },
    { command: "/sessions", description: "Browse past sessions" },
    { command: "/resume", description: "Resume a past session" },
    { command: "/compress", description: "Compress the current context" },
    { command: "/help", description: "Show available commands" },
  ],
  openclaw: [
    { command: "/status", description: "Runtime status and usage" },
    { command: "/model", description: "View or switch model" },
    { command: "/sessions", description: "Browse past sessions" },
    { command: "/compact", description: "Compact the current context" },
    { command: "/help", description: "Show available commands" },
  ],
};
const agentLabels: Record<Exclude<AgentKind, "shell">, string> = {
  codex: "Codex",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};
const agentCommandsButton = document.querySelector<HTMLButtonElement>("#agent-commands");
const agentCommandMenu = document.querySelector<HTMLElement>("#agent-command-menu");
function setAgentCommandMenu(open: boolean) {
  if (!agentCommandMenu || !agentCommandsButton) return;
  agentCommandMenu.hidden = !open;
  agentCommandsButton.setAttribute("aria-expanded", String(open));
}
function renderAgentCommandMenu() {
  if (!agentCommandMenu || !agentCommandsButton) return;
  const agent = activeTab?.agent ?? "shell";
  agentCommandsButton.disabled = agent === "shell";
  if (agent === "shell") {
    agentCommandsButton.title = "Open an agent first with C, H, or O";
    agentCommandMenu.replaceChildren();
    return;
  }
  const label = agentLabels[agent];
  agentCommandsButton.title = `${label} commands`;
  agentCommandsButton.setAttribute("aria-label", `Open common ${label} commands`);
  agentCommandMenu.setAttribute("aria-label", `${label} common commands`);
  const heading = document.createElement("div");
  heading.className = "slash-menu-heading";
  heading.textContent = `${label} Commands`;
  const items = agentCommands[agent].map(({ command, description }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.command = command;
    const code = document.createElement("code");
    code.textContent = command;
    const detail = document.createElement("small");
    detail.textContent = description;
    button.append(code, detail);
    return button;
  });
  agentCommandMenu.replaceChildren(heading, ...items);
}
function setActiveAgent(agent: AgentKind) {
  if (!activeTab) return;
  activeTab.agent = agent;
  renderAgentCommandMenu();
}
function bindAgentLaunch(selector: string, agent: Exclude<AgentKind, "shell">, command: string) {
  document.querySelector(selector)?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    setActiveAgent(agent);
    sendTerminalInput(command);
  });
}
agentCommandsButton?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (activeTab?.agent === "shell") return;
  setAgentCommandMenu(agentCommandMenu?.hidden ?? true);
});
agentCommandMenu?.addEventListener("pointerdown", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-command]");
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  sendTerminalInput(`${item.dataset.command}\r`);
  setAgentCommandMenu(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!agentCommandMenu || agentCommandMenu.hidden) return;
  if (agentCommandMenu.contains(event.target as Node) || agentCommandsButton?.contains(event.target as Node)) return;
  setAgentCommandMenu(false);
});
bindAgentLaunch("#codex-resume", "codex", "codex resume --all --no-alt-screen\r");
const tmuxAttachButton = document.querySelector<HTMLButtonElement>("#tmux-attach");
const tmuxSessionMenu = document.querySelector<HTMLElement>("#tmux-session-menu");
function setTmuxSessionMenu(open: boolean) {
  if (!tmuxSessionMenu || !tmuxAttachButton) return;
  tmuxSessionMenu.hidden = !open;
  tmuxAttachButton.setAttribute("aria-expanded", String(open));
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
function attachTmuxSession(sessionName: string) {
  tmuxAttached = true;
  if (activeTab) activeTab.tmuxAttached = true;
  setActiveAgent("codex");
  sendTerminalInput(`tmux attach-session -t -- ${shellQuote(sessionName)}\r`);
  setTmuxSessionMenu(false);
}
function renderTmuxSessionMenu(sessions?: TmuxSession[], error?: string) {
  if (!tmuxSessionMenu) return;
  const heading = document.createElement("div");
  heading.className = "slash-menu-heading";
  heading.textContent = "Tmux Sessions";
  if (!sessions) {
    const loading = document.createElement("button");
    loading.type = "button";
    loading.disabled = true;
    loading.textContent = "Loading sessions…";
    tmuxSessionMenu.replaceChildren(heading, loading);
    setTmuxSessionMenu(true);
    return;
  }
  const items = sessions.map((session) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tmuxSession = session.name;
    const name = document.createElement("code");
    name.textContent = session.name;
    const detail = document.createElement("small");
    detail.textContent = `${session.windows} window${session.windows === 1 ? "" : "s"}${session.attached ? " · attached" : ""}`;
    button.append(name, detail);
    return button;
  });
  if (items.length === 0) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.disabled = true;
    empty.textContent = error || "No tmux sessions found";
    items.push(empty);
  }
  tmuxSessionMenu.replaceChildren(heading, ...items);
  setTmuxSessionMenu(true);
}
tmuxAttachButton?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setAgentCommandMenu(false);
  renderTmuxSessionMenu();
  send({ type: "tmux_sessions" });
});
tmuxSessionMenu?.addEventListener("pointerdown", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tmux-session]");
  if (!item?.dataset.tmuxSession) return;
  event.preventDefault();
  event.stopPropagation();
  attachTmuxSession(item.dataset.tmuxSession);
});
document.addEventListener("pointerdown", (event) => {
  if (!tmuxSessionMenu || tmuxSessionMenu.hidden) return;
  if (tmuxSessionMenu.contains(event.target as Node) || tmuxAttachButton?.contains(event.target as Node)) return;
  setTmuxSessionMenu(false);
});
function bindInteractiveCommand(selector: string, agent: Exclude<AgentKind, "shell">, entryCommand: string, followupCommand: string, delayMs = 2500) {
  document.querySelector(selector)?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    setActiveAgent(agent);
    sendTerminalInput(entryCommand);
    window.setTimeout(() => sendTerminalInput(followupCommand), delayMs);
  });
}
bindInteractiveCommand("#hermes-sessions", "hermes", "hermes chat\r", "/sessions\r");
bindInteractiveCommand("#openclaw-sessions", "openclaw", "openclaw tui\r", "/sessions\r");
renderAgentCommandMenu();
bindControlKey("#clear-screen", "clear\r");
const copySelectionButton = document.querySelector<HTMLButtonElement>("#copy-selection")!;
terminal.onSelectionChange(() => {
  copySelectionButton.disabled = !selectionRange && !terminal.hasSelection();
});
function selectedTerminalText() {
  if (!selectionRange) return terminal.getSelection();
  const first = selectionRange.from.row * terminal.cols + selectionRange.from.column <=
    selectionRange.to.row * terminal.cols + selectionRange.to.column ? selectionRange.from : selectionRange.to;
  const last = first === selectionRange.from ? selectionRange.to : selectionRange.from;
  const lines: string[] = [];
  for (let row = first.row; row <= last.row; row += 1) {
    const line = terminal.buffer.active.getLine(row)?.translateToString(true) || "";
    const start = row === first.row ? first.column : 0;
    const end = row === last.row ? last.column + 1 : line.length;
    lines.push(line.slice(start, end));
  }
  return lines.join("\n");
}
copySelectionButton.addEventListener("click", async (event) => {
  event.preventDefault();
  const selection = selectedTerminalText();
  if (!selection) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(selection);
    } else {
      throw new Error("Clipboard API unavailable");
    }
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = selection;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "fixed";
    fallback.style.left = "-9999px";
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
});
document.querySelector("#paste")?.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const text = await navigator.clipboard.readText();
    if (text) terminal.paste(text);
  } catch {
    // clipboard read failed or denied; ignore
  }
});
const cursorLocationButton = document.querySelector<HTMLButtonElement>("#cursor-location")!;
cursorLocationButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (tmuxAttached) {
    // tmux owns the scrollback after T is attached; scroll its copy mode
    // back to the live pane instead of moving xterm's local buffer.
    sendTerminalInput("\u001b[<65;1;1M".repeat(200));
    return;
  }
  const buffer = terminal.buffer.active;
  terminal.scrollToLine(buffer.baseY + buffer.cursorY);
});
document.querySelector("#keyboard-open")?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  // iOS can dismiss the software keyboard while leaving xterm's hidden textarea
  // as document.activeElement. Focusing an already-focused textarea is a no-op,
  // so force a fresh synchronous blur -> focus cycle inside this user gesture.
  if (document.activeElement === terminalInput) {
    terminal.blur();
  }
  reserveForKeyboard();
  allowTerminalFocus = true;
  terminal.focus();
  pollViewportUntilStable();
  // If iOS rejects programmatic focus and the keyboard does not open, release the
  // reservation to avoid leaving an empty gap.
  window.setTimeout(() => {
    if (document.activeElement !== terminalInput) releaseKeyboardReservation();
  }, 600);
});
document.querySelector("#page-up")?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (tmuxAttached) {
    sendTerminalInput("\u001b[<64;1;1M".repeat(Math.max(1, Math.round(terminal.rows / 16))));
  } else {
    terminal.scrollLines(-Math.round(terminal.rows / 2));
  }
});
document.querySelector("#page-down")?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (tmuxAttached) {
    sendTerminalInput("\u001b[<65;1;1M".repeat(Math.max(1, Math.round(terminal.rows / 16))));
  } else {
    terminal.scrollLines(Math.round(terminal.rows / 2));
  }
});
document.querySelector("#exit-ssh")?.addEventListener("click", () => {
  const closingTab = activeTab;
  if (!closingTab) return;
  shouldReconnect = false;
  tmuxAttached = false;
  closingTab.agent = "shell";
  closingTab.socket?.close(1000, "user requested exit");
  closingTab.socket = undefined;
  closingTab.terminal.reset();
  const closingIndex = tabs.indexOf(closingTab);
  if (tabs.length === 1) {
    socket = undefined;
    activeTab = closingTab;
    terminal = closingTab.terminal;
    terminalHost = closingTab.host;
    document.querySelector(".shell")?.classList.remove("connected");
    document.documentElement.classList.remove("connected");
    onboarding.hidden = false;
    commandBar.classList.remove("visible");
    tabBar.hidden = true;
    setStatus("SSH session exited");
    return;
  }
  if (closingIndex >= 0) tabs.splice(closingIndex, 1);
  closingTab.terminal.dispose();
  closingTab.host.remove();
  const nextTab = tabs[Math.min(closingIndex, tabs.length - 1)];
  activateTab(nextTab);
});
document.querySelector("#tab-add")?.addEventListener("click", () => { if (tabs.length < 4) createAdditionalTab(); });
themeToggle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setThemeMenu(themeMenu.hidden);
});
themeMenu.addEventListener("pointerdown", (event) => {
  const choice = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme]");
  if (!choice) return;
  event.preventDefault();
  event.stopPropagation();
  applyTheme(choice.dataset.theme as ThemeName);
  setThemeMenu(false);
});
document.addEventListener("pointerdown", (event) => {
  if (themeMenu.hidden || themeMenu.contains(event.target as Node) || themeToggle.contains(event.target as Node)) return;
  setThemeMenu(false);
});
connectButton.addEventListener("click", connect);
copyButton.addEventListener("click", () => void copyPublicKey());
document.querySelector("#dialog-copy")?.addEventListener("click", () => void copyPublicKey());
document.querySelector("#device-button")?.addEventListener("click", () => dialog.showModal());

const imeDebugLines: string[] = [];
function imeLog(label: string, detail?: string) {
  const line = `[${Math.round(performance.now())}] ${label}${detail ? " " + detail : ""}`;
  imeDebugLines.push(line);
  console.log("[ime]", line);
  if (imeDebugLines.length > 400) imeDebugLines.shift();
  const list = document.getElementById("ime-debug-list");
  if (list) list.textContent = imeDebugLines.join("\n");
}
document.documentElement.dataset.theme = activeTheme;
renderThemeMenu();
updateVisualViewport();

getOrCreateIdentity()
  .then((value) => {
    identity = value;
    document.querySelector("#fingerprint")!.textContent = value.fingerprint;
    document.querySelector("#dialog-fingerprint")!.textContent = value.fingerprint;
    (document.querySelector("#public-key") as HTMLTextAreaElement).value = value.authorizedKey;
    connectButton.disabled = false;
    copyButton.disabled = false;
    setStatus("Device key ready");
  })
  .catch((error) => {
    hint.textContent = error instanceof Error ? error.message : String(error);
    setStatus("This browser does not support device keys", "error");
  });
