// yuzu-browser UI — アドレスバー + タブバー専用 webview。
// 表示は別 view webview（タブごと）が担当し、こちらは Tauri の invoke で操作する。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const HOME_URL = "https://duckduckgo.com/";
const SEARCH_URL = "https://duckduckgo.com/?q=";

interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  muted: boolean;
  audible: boolean;
  favicon: string;
}

let input: HTMLInputElement;
let tabsEl: HTMLDivElement;
let userTyping = false;
let tabs: TabInfo[] = [];

/** 入力を URL に解決。URL らしくなければ DuckDuckGo 検索 URL にフォールバック。 */
function resolveQuery(raw: string): string {
  const q = raw.trim();
  if (!q) return HOME_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(q)) return "http://" + q;
  if (!/\s/.test(q) && /^[^\s/?#]+\.[a-z]{2,}([/:?#].*)?$/i.test(q)) {
    return "https://" + q;
  }
  return SEARCH_URL + encodeURIComponent(q);
}

function activeTab(): TabInfo | undefined {
  return tabs.find((t) => t.active);
}

async function navigate(url: string): Promise<void> {
  input.value = url;
  try {
    await invoke("browser_navigate", { url });
  } catch (e) {
    console.error("navigate failed:", e);
  }
}

async function history(action: "back" | "forward" | "reload"): Promise<void> {
  try {
    await invoke("browser_history", { action });
  } catch (e) {
    console.error("history failed:", e);
  }
}

async function tabNew(url?: string): Promise<void> {
  try {
    await invoke("tab_new", { url: url ?? HOME_URL });
  } catch (e) {
    console.error("tab_new failed:", e);
  }
}

async function tabClose(id: number): Promise<void> {
  try {
    await invoke("tab_close", { id });
  } catch (e) {
    console.error("tab_close failed:", e);
  }
}

async function tabSwitch(id: number): Promise<void> {
  try {
    await invoke("tab_switch", { id });
  } catch (e) {
    console.error("tab_switch failed:", e);
  }
}

async function tabDuplicate(id: number): Promise<void> {
  try {
    await invoke("tab_duplicate", { id });
  } catch (e) {
    console.error("tab_duplicate failed:", e);
  }
}

async function tabReopen(): Promise<void> {
  try {
    await invoke("tab_reopen");
  } catch (e) {
    console.error("tab_reopen failed:", e);
  }
}

async function tabCloseOthers(id: number): Promise<void> {
  try {
    await invoke("tab_close_others", { id });
  } catch (e) {
    console.error("tab_close_others failed:", e);
  }
}

async function tabCloseRight(id: number): Promise<void> {
  try {
    await invoke("tab_close_right", { id });
  } catch (e) {
    console.error("tab_close_right failed:", e);
  }
}

async function tabReorder(id: number, toIndex: number): Promise<void> {
  try {
    await invoke("tab_reorder", { id, toIndex });
  } catch (e) {
    console.error("tab_reorder failed:", e);
  }
}

/** 表示用のタブ名を作る。ページタイトルがあればそれ、なければホスト名。 */
function tabLabel(t: TabInfo): string {
  if (t.title && t.title.trim()) return t.title;
  return urlToTitle(t.url);
}

/** URL からタイトル文字列を作る（ホスト名）。 */
function urlToTitle(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname) return u.hostname.replace(/^www\./, "");
    return url;
  } catch {
    return url || "新しいタブ";
  }
}

/** バックエンドが favicon を取得できていないときの推測 URL。 */
function faviconFallback(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function renderTabs(): void {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.active ? " active" : "");
    el.dataset.id = String(t.id);
    el.title = t.url;
    el.draggable = true;

    // favicon
    const fav = document.createElement("img");
    fav.className = "tab-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    fav.src = t.favicon || faviconFallback(t.url);
    fav.addEventListener("error", () => {
      // 取得失敗時はデフォルトアイコンへ
      fav.classList.add("is-fallback");
      fav.removeAttribute("src");
    });
    el.appendChild(fav);

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tabLabel(t);
    el.appendChild(title);

    // タブ内ミュートボタン：「音が鳴っている」または「ミュート中」のときだけ表示。
    if (t.audible || t.muted) {
      const mute = document.createElement("button");
      mute.className = "tab-mute" + (t.muted ? " is-muted" : "");
      mute.type = "button";
      mute.textContent = t.muted ? "🔇" : "🔊";
      mute.title = t.muted ? "ミュートを解除" : "このタブをミュート";
      mute.addEventListener("click", (e) => {
        e.stopPropagation();
        void invoke("tab_set_volume", {
          id: t.id,
          volume: t.muted ? 1.0 : 0.0,
        }).catch((err) => console.error("tab_set_volume failed:", err));
      });
      el.appendChild(mute);
    }

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "タブを閉じる";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void tabClose(t.id);
    });
    el.appendChild(close);

    el.addEventListener("click", () => void tabSwitch(t.id));
    el.addEventListener("auxclick", (e) => {
      // 中クリックで閉じる
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        void tabClose(t.id);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // ネイティブメニューを Rust 側に出してもらう（UI webview の矩形外にも描画できる）
      void invoke("show_tab_context_menu", { id: t.id }).catch((err) =>
        console.error("show_tab_context_menu failed:", err),
      );
    });

    // --- ドラッグ＆ドロップで並び替え ---
    el.addEventListener("dragstart", (e) => {
      el.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-yuzu-tab", String(t.id));
      }
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      document
        .querySelectorAll(".tab.drop-before, .tab.drop-after")
        .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = el.getBoundingClientRect();
      const before = (e as DragEvent).clientX < rect.left + rect.width / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drop-before", "drop-after");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = Number(e.dataTransfer?.getData("text/x-yuzu-tab") ?? "");
      el.classList.remove("drop-before", "drop-after");
      if (!fromId || fromId === t.id) return;
      const rect = el.getBoundingClientRect();
      const before = (e as DragEvent).clientX < rect.left + rect.width / 2;
      const targetIdx = tabs.findIndex((x) => x.id === t.id);
      const fromIdx = tabs.findIndex((x) => x.id === fromId);
      if (targetIdx < 0 || fromIdx < 0) return;
      let to = before ? targetIdx : targetIdx + 1;
      if (fromIdx < to) to -= 1; // 削除される分訿正
      void tabReorder(fromId, to);
    });

    tabsEl.appendChild(el);
  }
}

/** ネイティブコンテキストメニューの選択結果を処理。 */
function handleTabMenuAction(action: string, id: number): void {
  switch (action) {
    case "new":
      void tabNew();
      break;
    case "duplicate":
      void tabDuplicate(id);
      break;
    case "reload":
      void tabSwitch(id).then(() => history("reload"));
      break;
    case "reopen":
      void tabReopen();
      break;
    case "close_right":
      void tabCloseRight(id);
      break;
    case "close_others":
      void tabCloseOthers(id);
      break;
    case "close":
      void tabClose(id);
      break;
  }
}

/** view webview が遷移したら、対応タブが active のときだけアドレスバーへ反映。 */
function onViewNavigated(payload: { id: number; url: string }): void {
  const t = tabs.find((x) => x.id === payload.id);
  if (t) t.url = payload.url;
  renderTabs();
  const active = activeTab();
  if (active && active.id === payload.id && !userTyping) {
    input.value = payload.url;
  }
}

function onTabsUpdated(next: TabInfo[]): void {
  tabs = next;
  renderTabs();
  const active = activeTab();
  if (active && !userTyping) {
    input.value = active.url;
  }
  // 音量・ズーム表示を active タブに同期
  if (active) {
    void syncControlsForTab(active.id);
  }
}

/** 指定タブのズームをツールバー UI に反映。 */
async function syncControlsForTab(_id: number): Promise<void> {
  try {
    const z = await invoke<number>("tab_get_zoom");
    if (zoomDisplayEl) zoomDisplayEl.textContent = Math.round(z * 100) + "%";
  } catch (_) {
    /* ignore */
  }
}

let zoomDisplayEl: HTMLSpanElement | null = null;

window.addEventListener("DOMContentLoaded", () => {
  input = document.getElementById("address") as HTMLInputElement;
  tabsEl = document.getElementById("tabs") as HTMLDivElement;
  const form = document.getElementById("address-form") as HTMLFormElement;
  const backBtn = document.getElementById("back") as HTMLButtonElement;
  const forwardBtn = document.getElementById("forward") as HTMLButtonElement;
  const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
  const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    userTyping = false;
    void navigate(resolveQuery(input.value));
  });
  input.addEventListener("input", () => {
    userTyping = true;
  });
  input.addEventListener("blur", () => {
    userTyping = false;
  });
  input.addEventListener("focus", () => {
    input.select();
  });

  backBtn.addEventListener("click", () => void history("back"));
  forwardBtn.addEventListener("click", () => void history("forward"));
  reloadBtn.addEventListener("click", () => void history("reload"));
  newTabBtn.addEventListener("click", () => void tabNew());

  // ズームコントロール
  zoomDisplayEl = document.getElementById(
    "zoom-display",
  ) as HTMLSpanElement | null;
  const zoomInBtn = document.getElementById(
    "zoom-in",
  ) as HTMLButtonElement | null;
  const zoomOutBtn = document.getElementById(
    "zoom-out",
  ) as HTMLButtonElement | null;
  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      void invoke("active_tab_zoom_delta", { delta: 0.1 }).catch((e) =>
        console.error("zoom_delta failed:", e),
      );
    });
  }
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      void invoke("active_tab_zoom_delta", { delta: -0.1 }).catch((e) =>
        console.error("zoom_delta failed:", e),
      );
    });
  }
  if (zoomDisplayEl) {
    zoomDisplayEl.addEventListener("click", () => {
      void invoke("active_tab_zoom_set", { zoom: 1.0 }).catch((e) =>
        console.error("zoom_set failed:", e),
      );
    });
  }

  // UI webview 上での Ctrl+ホイール（ツールバー上など）もズームに使う
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      void invoke("active_tab_zoom_delta", { delta }).catch(() => {});
    },
    { passive: false },
  );

  // ショートカット
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === "t") {
      e.preventDefault();
      void tabNew();
    } else if (e.ctrlKey && e.shiftKey && k === "t") {
      e.preventDefault();
      void tabReopen();
    } else if (e.ctrlKey && k === "w") {
      e.preventDefault();
      const a = activeTab();
      if (a) void tabClose(a.id);
    } else if (e.ctrlKey && k === "l") {
      e.preventDefault();
      input.focus();
    } else if (e.ctrlKey && k === "d" && e.shiftKey) {
      // Ctrl+Shift+D でタブ複製
      e.preventDefault();
      const a = activeTab();
      if (a) void tabDuplicate(a.id);
    } else if (e.ctrlKey && k === "tab") {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.active);
      if (idx < 0 || tabs.length === 0) return;
      const next = e.shiftKey
        ? (idx - 1 + tabs.length) % tabs.length
        : (idx + 1) % tabs.length;
      void tabSwitch(tabs[next].id);
    } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      // Ctrl+1..8 で番号タブ、Ctrl+9 で最後のタブ
      e.preventDefault();
      const n = Number(e.key);
      const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (target) void tabSwitch(target.id);
    } else if (e.ctrlKey && e.key === "0") {
      e.preventDefault();
      void invoke("active_tab_zoom_set", { zoom: 1.0 }).catch(() => {});
    } else if (e.ctrlKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      void invoke("active_tab_zoom_delta", { delta: 0.1 }).catch(() => {});
    } else if (e.ctrlKey && e.key === "-") {
      e.preventDefault();
      void invoke("active_tab_zoom_delta", { delta: -0.1 }).catch(() => {});
    }
  });

  void listen<{ id: number; zoom: number }>("tab-zoom-changed", (event) => {
    const a = activeTab();
    if (!a || a.id !== event.payload.id) return;
    if (zoomDisplayEl)
      zoomDisplayEl.textContent = Math.round(event.payload.zoom * 100) + "%";
  });

  void listen<{ id: number; url: string }>("view-navigated", (event) => {
    onViewNavigated(event.payload);
  });
  void listen<TabInfo[]>("tabs-updated", (event) => {
    onTabsUpdated(event.payload);
  });
  void listen<{ action: string; id: number }>("tab-menu-action", (event) => {
    handleTabMenuAction(event.payload.action, event.payload.id);
  });

  // 初期タブリスト取得
  void invoke<TabInfo[]>("tab_list")
    .then(onTabsUpdated)
    .catch((e) => {
      console.error("tab_list failed:", e);
    });
});
