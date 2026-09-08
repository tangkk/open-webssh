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
  | { type: "error"; message: string };

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
        <div><strong>Web SSH</strong><small id="status">准备设备密钥</small></div>
      </div>
      <button class="icon-button" id="device-button" aria-label="设备密钥">密钥</button>
    </header>
    <div class="terminal-wrap" id="terminal-wrap">
      <div class="tab-bar" id="tab-bar" hidden>
        <button class="tab-add" id="tab-add" type="button" aria-label="新建 terminal">＋</button>
        <button class="tab-theme" id="theme-toggle" type="button" aria-label="选择主题" aria-expanded="false" title="Theme">◐</button>
      </div>
      <div class="theme-menu" id="theme-menu" role="menu" aria-label="终端主题" hidden></div>
      <div id="terminal"></div>
      <section class="onboarding" id="onboarding">
        <p class="eyebrow">PRIVATE SSH ACCESS</p>
        <div class="title-row"><h1>Web SSH</h1><span class="target-badge"><i></i>${appConfig.targetLabel}</span></div>
        <p class="lede">一个简洁的 ${appConfig.targetLabel} 终端入口。SSH 私钥只保存在这台设备的浏览器中；${appConfig.gatewayLabel} 只转发会话，不保存私钥。</p>
        <div class="key-card">
          <span>此设备公钥指纹</span>
          <code id="fingerprint">正在生成…</code>
        </div>
        <button class="primary" id="connect" disabled>连接 ${appConfig.targetLabel}</button>
        <button class="secondary" id="copy-key" disabled>复制公钥以授权此设备</button>
        <p class="hint" id="hint">首次使用需要将公钥加入 ${appConfig.targetLabel}。</p>
      </section>
    </div>
    <div class="command-bar" id="command-bar" aria-label="终端控制栏">
      <div class="command-row command-row-commands">
        <button class="control-key agent-key" id="codex-resume" type="button" aria-label="发送 codex resume --all --no-alt-screen" title="Codex">C</button>
        <button class="control-key agent-key" id="hermes-sessions" type="button" aria-label="进入 Hermes 并列出 sessions" title="Hermes">H</button>
        <button class="control-key agent-key" id="openclaw-sessions" type="button" aria-label="进入 OpenClaw 并列出 sessions" title="OpenClaw">O</button>
        <button class="control-key agent-key" id="tmux-attach" type="button" aria-label="连接 tmux ${appConfig.tmuxSession} session" title="tmux ${appConfig.tmuxSession}">T</button>
        <button class="control-key agent-key" id="agent-commands" type="button" aria-label="打开当前 agent 常用命令" aria-expanded="false" title="Agent commands">⋯</button>
        <button class="control-key copy-key" id="copy-selection" type="button" aria-label="复制选中文字" disabled>⧉</button>
        <button class="control-key" id="paste" type="button" aria-label="粘贴剪贴板内容">⎘</button>
        <button class="control-key" id="clear-screen" type="button" aria-label="清屏">⌧</button>
        <button class="control-key" id="page-up" type="button" aria-label="向上翻屏">⇞</button>
        <button class="control-key" id="page-down" type="button" aria-label="向下翻屏">⇟</button>
      </div>
      <div class="command-row command-row-keys">
        <button class="exit-key" id="exit-ssh" type="button" aria-label="Logout">⏻</button>
        <button class="control-key" id="escape-key" type="button" aria-label="发送 Escape">⎋</button>
        <button class="control-key" id="tab-key" type="button" aria-label="发送 Tab">⇥</button>
        <button class="control-key arrow-key" id="arrow-up" type="button" aria-label="发送向上箭头">↑</button>
        <button class="control-key arrow-key" id="arrow-down" type="button" aria-label="发送向下箭头">↓</button>
        <button class="control-key cursor-key" id="cursor-location" type="button" aria-label="回到终端光标处">⌖</button>
        <button class="control-key keyboard-open-key" id="keyboard-open" type="button" aria-label="打开键盘">⌨</button>
        <button class="control-key" id="ctrl-d" type="button" aria-label="键盘缩短：打空格才缩短" title="键盘缩短开关">⇄</button>
        <button class="control-key" id="ctrl-c" type="button" aria-label="发送 Ctrl-C">␃</button>
        <button class="control-key enter-key" id="enter-key" type="button" aria-label="发送回车">↵</button>
      </div>
      <div class="slash-menu" id="agent-command-menu" role="menu" aria-label="当前 agent 常用命令" hidden></div>
    </div>
    <dialog id="device-dialog">
      <form method="dialog">
        <div class="dialog-head"><strong>此设备密钥</strong><button aria-label="关闭">完成</button></div>
        <p>私钥不可导出，保存在当前浏览器。清除网站数据后需要重新注册。</p>
        <label>公钥指纹</label><code id="dialog-fingerprint"></code>
        <label>OpenSSH 公钥</label><textarea id="public-key" readonly></textarea>
        <button type="button" class="primary compact" id="dialog-copy">复制公钥</button>
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

// iOS 中文 IME 会把全角标点（，。！？等）和全角空格通过 beforeinput 直接
// 提交，不触发 composition 流程，xterm 6 会丢失这些字符。这里只转发
// 「非合成、非刚提交」的非 ASCII 文本；合成中的汉字交给 xterm 的 composition
// 处理，且完全不碰 ASCII（英文空格由 xterm 的 keydown 处理），避免重复发送。
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
  // compositionend 后 iOS 可能补发同一个合成文本（insertText），跳过避免 double。
  if (event.data === lastCommittedText) return;
  // 全角空格 U+3000：iOS 上 xterm 6 会丢失。只在非合成时转发；合成中的交给
  // xterm 的 composition 流程，避免和它的 compositionend 异步发送撞车 double。
  if (event.data.includes("\u3000")) {
    if (imeComposing || event.isComposing || imeJustCommitted) return;
    event.preventDefault();
    sendTerminalInput(event.data);
    return;
  }
  if (imeComposing || event.isComposing || imeJustCommitted) return;
  // 只兜底「直接插入」的 insertText（全角标点，。！？走这个 inputType）。
  // insertCompositionText 是合成文本，交给 xterm 的 compositionend 处理——
  // 它的 preventDefault 在 iOS 上不可靠，转发了会和 xterm 异步发送重复（double）。
  if (event.inputType !== "insertText") return;
  if (![...event.data].some((character) => character.codePointAt(0)! > 0x7f)) return;
  event.preventDefault();
  sendTerminalInput(event.data);
});

// xterm 6 的 iOS 合成 bug：中文提交会触发多条发送路径——点选候选词时 input 事件
// （_inputEvent，因无 keydown 故 keyDownSeen=false）会发一次，按空格/回车时 keydown
// （_finalizeComposition(false)）会发一次，紧接着 compositionend 又异步发一次 → double。
// 这里在 document 捕获阶段拦截合成期间发往终端输入框的 keydown 和 input，只
// stopImmediatePropagation 阻止 xterm 的处理、不 preventDefault（iOS 候选确认照常），
// 让合成统一走 compositionend 路径单次发送。
document.addEventListener("keydown", (event) => {
  if (event.target === terminalInput) imeLog("keydown", `key=${event.key} keyCode=${event.keyCode} imeComposing=${imeComposing}`);
  if (event.target !== terminalInput) return;
  // 合成期间：阻止 xterm 的 keydown 处理（_finalizeComposition(false) 会提前发送）。
  // keyCode 229 / key "Process" 是 iOS IME 标记，阻止 xterm 的 _handleAnyTextareaChanges
  // （它会在 compositionend 后重复发送 textarea 新增 → double）。
  if (imeComposing || event.keyCode === 229 || event.key === "Process") {
    event.stopImmediatePropagation();
  }
}, { capture: true });
document.addEventListener("input", (event) => {
  if (event.target === terminalInput) imeLog("input", `data=${JSON.stringify((event as InputEvent).data)} inputType=${(event as InputEvent).inputType}`);
  if (event.target !== terminalInput) return;
  if (imeComposing) { event.stopImmediatePropagation(); return; }
  // compositionend 后 iOS 补发的同一个合成文本：阻止 xterm 的 _inputEvent 再发一次。
  if (lastCommittedText && (event as InputEvent).data === lastCommittedText) {
    event.stopImmediatePropagation();
    lastCommittedText = "";
  }
}, { capture: true });
// iOS 在正常 compositionend（data 非空）提交后，可能再补发一次空 compositionend
// （data=""）。xterm 的 _finalizeComposition 不清空 textarea、也不更新 _dataAlreadySent
// （那些本该由 _handleAnyTextareaChanges 做，但已被上面的 keydown/input 拦截挡住），
// 所以空 compend 会让它把 textarea 里残留的上一个合成文本再发一次 → double。
// 空 compend 本就不该发送任何内容，这里在 capture 阶段统一拦掉 xterm 的处理。
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

// xterm 6 的滚动是虚拟的（Scrollable 模型 + 自绘滚动条）：.xterm-viewport 没有
// 原生滚动空间，改 scrollTop 是空操作。scrollLines 接受小数值，模型内部保留
// 亚行精度，自绘滚动条滑块同步移动——手指滑动 1:1 映射到滚动条。
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
  // 触摸落在 xterm 自绘滚动条上：交给 xterm 自己的滑块拖拽，不做自定义滑动。
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
  tabSocket.addEventListener("message", async (event) => { const message = JSON.parse(String(event.data)) as ServerMessage; if (message.type === "sign_request") { try { const signature = await signAgentChallenge(identity, base64ToBytes(message.data)); if (tabSocket.readyState === WebSocket.OPEN) tabSocket.send(JSON.stringify({ type: "sign_response", id: message.id, signature })); } catch (error) { if (tabSocket.readyState === WebSocket.OPEN) tabSocket.send(JSON.stringify({ type: "sign_response", id: message.id, error: String(error) })); } return; } if (message.type === "output") tab.terminal.write(base64ToBytes(message.data)); if (message.type === "status" && tab === activeTab) { if (message.status === "connecting") setStatus(message.message || "SSH 验证中…", "working"); if (message.status === "connected") { setStatus(`已连接 · ${appConfig.targetLabel}`, "online"); fitTerminal(); } if (message.status === "closed") setStatus(message.message || "连接已断开", "error"); } });
  tabSocket.addEventListener("close", () => { tab.socket = undefined; if (tab === activeTab) { socket = undefined; setStatus("已断开", "error"); } });
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
  hint.textContent = "公钥已复制。授权后回到这里连接。";
  copyButton.textContent = "已复制";
  setTimeout(() => (copyButton.textContent = "复制公钥以授权此设备"), 1600);
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
// 键盘缩短方式开关：true=纯 CSS（打空格才缩短，无重绘，默认）；false=fit（立即缩短，有重绘）。
let keyboardCssMode = true;

// 这台 iOS 设备会把 visualViewport 的高度更新延迟到键盘上第一次输入才发布，
// resize 监听和轮询都拿不到及时值。因此打开键盘时立刻按「预估键盘高度」主动
// 缩短 shell（只改 CSS 容器尺寸，xterm 与远端 PTY 行数不变、不重绘），等真实
// 视口高度到达后再修正。实测键盘高度按横竖屏缓存，第二次起预估即实测值。
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
  // 已预留键盘空间、但实测仍是全高：通常是键盘动画期间 iOS 在发布真实高度前
  // 触发的杂散 resize，不能让它把预留高度覆盖回去。但若焦点已不在终端上，
  // 说明键盘其实已消失（后台切换可能丢 blur），撤销预留并按全高恢复。
  if (keyboardReserved && !keyboardOpen) {
    if (document.activeElement === terminalInput) return;
    keyboardReserved = false;
    document.documentElement.classList.remove("keyboard-requested");
  }
  if (keyboardOpen) rememberKeyboardHeight(maximumViewportHeight - height);
  document.documentElement.style.setProperty("--viewport-height", `${height}px`);
  document.documentElement.style.setProperty("--viewport-top", `${top}px`);
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  // 纯 CSS 模式（默认）：只在键盘关闭后 fit 恢复全高；键盘打开时只缩容器（打空格才缩短，无重绘）。
  // fit 模式：键盘开合期间都 fit 重排行数并同步远端 resize（立即缩短，Codex 重绘）。
  if (shouldFit && (!keyboardCssMode || !keyboardOpen)) fitTerminal(false);
}

function reserveForKeyboard() {
  const full = maximumViewportHeight || window.innerHeight;
  const reserved = Math.max(Math.round(full * 0.25), full - estimatedKeyboardHeight());
  keyboardReserved = true;
  document.documentElement.classList.add("keyboard-requested");
  document.documentElement.style.setProperty("--viewport-height", `${reserved}px`);
  document.documentElement.style.setProperty("--viewport-top", "0px");
  // fit 模式：立即 fit 重排行数（canvas 真实 resize 逼 iOS 提交画面），同步远端 resize。
  if (!keyboardCssMode) fitTerminal(false);
  requestAnimationFrame(flushTerminalPaint);
  window.setTimeout(flushTerminalPaint, 350);
}

// fit 已通过 canvas resize 逼 iOS 提交画面；这里再 refresh 一遍 xterm 并把 shell
// 提升为独立合成层作为双保险，确保当帧可见。不改任何额外几何。
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
  // 收起动画期间视口高度未必已恢复，立刻刷新一次，动画结束后再校对两次。
  updateVisualViewport(true);
  flushTerminalPaint();
  window.setTimeout(() => { updateVisualViewport(true); flushTerminalPaint(); }, 250);
  window.setTimeout(() => { updateVisualViewport(true); flushTerminalPaint(); }, 700);
}

// iOS 会延迟 visualViewport 的 resize 事件，直到第一次按键才触发。键盘展开后
// 主动轮询视口高度：变化时立即缩短 terminal，稳定后补一次 fit 重排行数。
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
  setStatus(`连接 ${appConfig.gatewayLabel}…`, "working");
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
        setStatus(`已连接 · ${appConfig.targetLabel}`, "online");
      } else if (message.status === "connecting") {
        setStatus(message.message || "SSH 验证中…", "working");
      } else {
        setStatus(message.message || "连接已断开", "error");
        connectButton.disabled = false;
      }
    }
  });

  socket.addEventListener("close", () => {
    socket = undefined;
    setStatus("已断开，可重新连接", "error");
    connectButton.disabled = false;
  });

  socket.addEventListener("error", () => setStatus(`无法连接 ${appConfig.gatewayLabel}`, "error"));
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
    keyboardCssMode ? "键盘缩短：打空格才缩短（无重绘）" : "键盘缩短：立即缩短（有重绘）",
  );
  ctrlDButton?.setAttribute(
    "title",
    keyboardCssMode ? "点按切换为立即缩短模式" : "点按切换为无重绘模式",
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
    { command: "/status", description: "会话与用量" },
    { command: "/model", description: "查看或切换模型" },
    { command: "/compact", description: "压缩当前上下文" },
    { command: "/help", description: "查看可用命令" },
  ],
  hermes: [
    { command: "/status", description: "会话、模型与上下文" },
    { command: "/model", description: "查看或切换模型" },
    { command: "/sessions", description: "浏览历史会话" },
    { command: "/resume", description: "恢复历史会话" },
    { command: "/compress", description: "压缩当前上下文" },
    { command: "/help", description: "查看可用命令" },
  ],
  openclaw: [
    { command: "/status", description: "运行状态与用量" },
    { command: "/model", description: "查看或切换模型" },
    { command: "/sessions", description: "浏览历史会话" },
    { command: "/compact", description: "压缩当前上下文" },
    { command: "/help", description: "查看可用命令" },
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
    agentCommandsButton.title = "请先通过 C、H 或 O 打开 agent";
    agentCommandMenu.replaceChildren();
    return;
  }
  const label = agentLabels[agent];
  agentCommandsButton.title = `${label} commands`;
  agentCommandsButton.setAttribute("aria-label", `打开 ${label} 常用命令`);
  agentCommandMenu.setAttribute("aria-label", `${label} 常用命令`);
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
document.querySelector("#tmux-attach")?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  tmuxAttached = true;
  if (activeTab) activeTab.tmuxAttached = true;
  setActiveAgent("codex");
  sendTerminalInput(`tmux attach-session -t ${appConfig.tmuxSession}\r`);
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
  // iOS 拒绝了程序化 focus（键盘没弹出来）时撤销预留，避免白留白一块。
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
    setStatus("已退出 SSH");
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
    setStatus("设备密钥就绪");
  })
  .catch((error) => {
    hint.textContent = error instanceof Error ? error.message : String(error);
    setStatus("浏览器不支持设备密钥", "error");
  });
