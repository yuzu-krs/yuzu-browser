// yuzu-browser UI — アドレスバー専用 webview。
// 表示は別 webview ("view") が担当し、こちらは Tauri の invoke で URL を渡すだけ。

import { invoke } from "@tauri-apps/api/core";

const HOME_URL = "https://duckduckgo.com/";
const SEARCH_URL = "https://duckduckgo.com/?q=";

let input: HTMLInputElement;

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

window.addEventListener("DOMContentLoaded", () => {
  input = document.getElementById("address") as HTMLInputElement;
  const form = document.getElementById("address-form") as HTMLFormElement;
  const backBtn = document.getElementById("back") as HTMLButtonElement;
  const forwardBtn = document.getElementById("forward") as HTMLButtonElement;
  const reloadBtn = document.getElementById("reload") as HTMLButtonElement;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void navigate(resolveQuery(input.value));
  });

  backBtn.addEventListener("click", () => void history("back"));
  forwardBtn.addEventListener("click", () => void history("forward"));
  reloadBtn.addEventListener("click", () => void history("reload"));

  // 初期は Rust 側で home URL がセット済み。アドレスバーだけ同期。
  input.value = HOME_URL;
  input.focus();
});
