// uBlock Origin 相当のブロッカーを各タブ webview の起動時に走らせる。
// エンジンは @ghostery/adblocker (uBO のフィルタ構文を完全サポート、Brave/Ghostery 採用)。
// uBO の代表的フィルタリスト（EasyList + uBlock Origin filters + Privacy 等）を取得し、
//   - ネットワーク要求を fetch / XHR / sendBeacon / Image / WebSocket レベルでブロック
//   - 起動毎にコスメティックフィルタを CSS / scriptlet として注入
// する。エンジンのビルドは初回のみ重いので IndexedDB にシリアライズして再利用する。

import {
  FiltersEngine,
  Request,
  Resources,
  fullLists,
  fetchResources,
} from "@ghostery/adblocker";
import { getDomain } from "tldts";

declare global {
  interface Window {
    __yuzuUBOInstalled?: boolean;
    __TAURI_INTERNALS__?: unknown;
  }
}

if (typeof window !== "undefined" && !window.__yuzuUBOInstalled) {
  window.__yuzuUBOInstalled = true;
  void bootstrap().catch((e) => {
    // 失敗してもページ表示は継続させる。
    console.warn("[yuzu-ublock] bootstrap failed:", e);
  });
}

const DB_NAME = "yuzu-ublock";
const DB_STORE = "engine";
// v2: full lists + scriptlet resources + 正しいドメイン解決。
const DB_KEY = "engine-v2";
// uBO のリポジトリ定義に概ね揃え、6 時間ごとに再ビルドする。
const ENGINE_TTL_MS = 6 * 60 * 60 * 1000;

interface EngineRecord {
  data: Uint8Array;
  savedAt: number;
}

async function bootstrap(): Promise<void> {
  const engine = await loadOrBuildEngine();
  installNetworkHooks(engine);
  installCosmetics(engine);
}

async function loadOrBuildEngine(): Promise<FiltersEngine> {
  let engine: FiltersEngine | null = null;
  try {
    const cached = await idbGet();
    if (cached && Date.now() - cached.savedAt < ENGINE_TTL_MS) {
      engine = FiltersEngine.deserialize(cached.data);
    }
  } catch (_) {
    // キャッシュ読み出し失敗は致命的ではない。フォールバックして再構築。
  }
  if (!engine) {
    engine = await FiltersEngine.fromLists(
      fetch.bind(window),
      // EasyList + uBlock Origin filters + Privacy + Annoyances (sponsor 系含む)。
      fullLists,
    );
    try {
      const data = engine.serialize() as Uint8Array;
      await idbPut({ data, savedAt: Date.now() });
    } catch (_) {
      // 永続化失敗は無視。
    }
  }
  // uBO の scriptlets / redirect リソースを読み込む。これがないと
  // `+js(...)` フィルタや YouTube 用の細かいパッチが効かない。
  try {
    const resourcesText = await fetchResources(fetch.bind(window) as any);
    engine.resources = Resources.parse(resourcesText, { checksum: "" });
  } catch (_) {
    // 取得失敗時は CSS のみで動作。
  }
  return engine;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<EngineRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(DB_KEY);
    req.onsuccess = () =>
      resolve((req.result as EngineRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(rec: EngineRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(rec, DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- ネットワークブロック ----

type ResType =
  | "main_frame"
  | "sub_frame"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "object"
  | "xhr"
  | "ping"
  | "media"
  | "websocket"
  | "other";

function isBlocked(engine: FiltersEngine, url: string, type: ResType): boolean {
  try {
    const req = Request.fromRawDetails({
      url,
      sourceUrl: location.href,
      type,
    });
    const { match } = engine.match(req);
    return match;
  } catch (_) {
    return false;
  }
}

function installNetworkHooks(engine: FiltersEngine): void {
  // fetch
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isBlocked(engine, url, "xhr")) {
        return Promise.reject(new TypeError("blocked by yuzu-ublock"));
      }
      return origFetch(input as RequestInfo, init);
    };
  }

  // XHR
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (
      this: XMLHttpRequest & { __yuzuBlocked?: boolean },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const u = typeof url === "string" ? url : url.href;
      this.__yuzuBlocked = isBlocked(engine, u, "xhr");
      // 型を緩めて元の open を呼ぶ。
      return (origOpen as unknown as (...a: unknown[]) => void).apply(this, [
        method,
        u,
        ...rest,
      ]);
    } as typeof XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function (
      this: XMLHttpRequest & { __yuzuBlocked?: boolean },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      if (this.__yuzuBlocked) {
        // 何もしないで dispatch error にする。
        try {
          this.dispatchEvent(new Event("error"));
        } catch (_) {}
        return;
      }
      return origSend.call(
        this,
        body as Document | XMLHttpRequestBodyInit | null,
      );
    };
  }

  // sendBeacon
  if (navigator.sendBeacon) {
    const orig = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (
      url: string | URL,
      data?: BodyInit | null,
    ) {
      const u = typeof url === "string" ? url : url.href;
      if (isBlocked(engine, u, "ping")) return true;
      return orig(u, data ?? null);
    };
  }

  // Image (1x1 トラッキングピクセル)
  const OrigImage = window.Image;
  if (OrigImage) {
    function PatchedImage(this: HTMLImageElement, w?: number, h?: number) {
      const img = new OrigImage(w, h);
      const desc = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        "src",
      );
      if (desc?.set) {
        Object.defineProperty(img, "src", {
          configurable: true,
          enumerable: true,
          get: desc.get,
          set(v: string) {
            if (typeof v === "string" && isBlocked(engine, v, "image")) return;
            desc.set!.call(img, v);
          },
        });
      }
      return img;
    }
    PatchedImage.prototype = OrigImage.prototype;
    (window as unknown as { Image: typeof Image }).Image =
      PatchedImage as unknown as typeof Image;
  }

  // WebSocket
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    function PatchedWS(url: string | URL, protocols?: string | string[]) {
      const u = typeof url === "string" ? url : url.href;
      if (isBlocked(engine, u, "websocket")) {
        // 即時クローズの偽 WebSocket を返すと面倒なので例外。
        throw new DOMException("blocked by yuzu-ublock", "SecurityError");
      }
      return new OrigWS(u, protocols);
    }
    PatchedWS.prototype = OrigWS.prototype;
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      PatchedWS as unknown as typeof WebSocket;
  }
}

// ---- コスメティックフィルタ ----

function installCosmetics(engine: FiltersEngine): void {
  let lastUrl = "";
  const apply = () => {
    try {
      if (lastUrl === location.href) return;
      lastUrl = location.href;
      const hostname = location.hostname;
      // engine は domain (= eTLD+1) と hostname を別々に要求する。
      // ここを誤ると uBO の `youtube.com##...` 形式の hostname-bound
      // フィルタが一切マッチしない。
      const domain = getDomain(hostname) ?? hostname;
      const result = engine.getCosmeticsFilters({
        url: location.href,
        hostname,
        domain,
      }) as { styles?: string; scripts?: string[] };
      if (result.styles) {
        let style = document.querySelector<HTMLStyleElement>(
          'style[data-yuzu-ublock="1"]',
        );
        if (!style) {
          style = document.createElement("style");
          style.setAttribute("data-yuzu-ublock", "1");
          (document.head || document.documentElement).appendChild(style);
        }
        // 既存ルールに追記。重複セレクタは CSS エンジンが平坦化する。
        style.textContent = (style.textContent || "") + "\n" + result.styles;
      }
      if (result.scripts) {
        for (const code of result.scripts) {
          try {
            const s = document.createElement("script");
            s.textContent = code;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
          } catch (_) {}
        }
      }
    } catch (_) {}
  };
  apply();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  }
  // SPA 内の URL 変化に追従。
  const wrap = (orig: typeof history.pushState) =>
    function (this: History, ...args: Parameters<typeof history.pushState>) {
      const r = orig.apply(this, args);
      lastUrl = ""; // 強制再適用。
      queueMicrotask(apply);
      return r;
    } as typeof history.pushState;
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener("popstate", () => {
    lastUrl = "";
    apply();
  });
  // 安全網: location.href が SPA で書き変わったが pushState を経由しない
  // (replace で URL が同一など) ケース対策に短い間隔でチェック。
  setInterval(apply, 1500);
}
