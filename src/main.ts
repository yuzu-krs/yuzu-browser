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
