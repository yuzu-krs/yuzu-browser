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
      if (pe.button !== 0) return;
      if ((pe.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      startTabDrag(t.id, el, pe);
    });
    el.addEventListener("auxclick", (e) => {
      // 中クリックで閉じる
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        void tabClose(t.id);
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
  const bookmarksCloseBtn = document.getElementById(
    "bookmarks-close",
  ) as HTMLButtonElement | null;

  if (bookmarkToggleBtn) {
    bookmarkToggleBtn.addEventListener(
      "click",
      () => void toggleCurrentBookmark(),
    );
  }
  if (bookmarksOpenBtn) {
    bookmarksOpenBtn.addEventListener("click", () => void openBookmarksPanel());
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
  if (!bookmarkToggleBtn) return;
  const a = activeTab();
  const isMarked = !!a && bookmarks.some((b) => b.url === a.url);
  bookmarkToggleBtn.textContent = isMarked ? "★" : "☆";
  bookmarkToggleBtn.classList.toggle("is-bookmarked", isMarked);
  bookmarkToggleBtn.title = isMarked
    ? "このページのブックマークを削除 (Ctrl+D)"
    : "このページをブックマーク (Ctrl+D)";
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
