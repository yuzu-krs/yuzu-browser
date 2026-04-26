// yuzu-browser UI — アドレスバー + タブバー専用 webview。
// 表示は別 view webview（タブごと）が担当し、こちらは Tauri の invoke で操作する。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const HOME_URL = "https://duckduckgo.com/";
const SEARCH_URL = "https://duckduckgo.com/?q=";

interface TabInfo {
  id: number;
  url: string;
  active: boolean;
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

function renderTabs(): void {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.active ? " active" : "");
    el.dataset.id = String(t.id);
    el.title = t.url;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = urlToTitle(t.url);
    el.appendChild(title);

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
    tabsEl.appendChild(el);
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
}

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

  // ショートカット
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      void tabNew();
    } else if (e.ctrlKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      const a = activeTab();
      if (a) void tabClose(a.id);
    } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      input.focus();
    }
  });

  void listen<{ id: number; url: string }>("view-navigated", (event) => {
    onViewNavigated(event.payload);
  });
  void listen<TabInfo[]>("tabs-updated", (event) => {
    onTabsUpdated(event.payload);
  });

  // 初期タブリスト取得
  void invoke<TabInfo[]>("tab_list")
    .then(onTabsUpdated)
    .catch((e) => {
      console.error("tab_list failed:", e);
    });
});
