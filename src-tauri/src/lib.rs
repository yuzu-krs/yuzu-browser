// yuzu-browser backend.
// 1 つの Window に「UI webview」と「複数の view webview（タブ）」を並置する。
// アクティブタブの view だけを表示エリアに置き、それ以外は画面外に退避。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::webview::{DownloadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl, Window,
    WindowEvent,
};
use url::Url;

mod adblock;

const TOOLBAR_HEIGHT: f64 = 50.0;
const TABBAR_HEIGHT: f64 = 36.0;
const ACTIONS_BAR_HEIGHT: f64 = 30.0;
const CHROME_HEIGHT: f64 = TOOLBAR_HEIGHT + TABBAR_HEIGHT + ACTIONS_BAR_HEIGHT;
const HOME_URL: &str = "https://duckduckgo.com/";
const OFFSCREEN_X: f64 = -20000.0;

// uBlock Origin 相当の広告/トラッカーブロッカー。
// `npm run build:ublock` が `@ghostery/adblocker`（uBO フィルタ構文互換エンジン）と
// 起動コードを IIFE バンドルし `src-tauri/ublock.bundle.js` を生成する。
// 各 view webview の初期化スクリプトとして注入される。
const UBLOCK_SCRIPT: &str = include_str!("../ublock.bundle.js");

// YouTube 等の動画広告は googlevideo.com から本編と同 CDN で来るため URL/hosts では
// 止められない。uBO と同じく JSON.parse / Response.json をフックして
// playerResponse から adPlacements / playerAds / adSlots / adBreakHeartbeatParams を
// 削り、SPF/embed の ytInitialPlayerResponse もスクリプト挿入時点で書き換える。
// document_start で同期実行する必要があるため独立スクリプトに切り出している。
const ADBLOCK_PRELUDE: &str = r#"
(function () {
  if (window.__yuzuAdPreludeInstalled) return;
  window.__yuzuAdPreludeInstalled = true;
  const AD_KEYS = [
    'adPlacements','playerAds','adSlots','adBreakHeartbeatParams',
    'adReasons','adRequestConfig','playbackTracking',
  ];
  function strip(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return obj;
    if (Array.isArray(obj)) { for (let i=0;i<obj.length;i++) strip(obj[i], depth+1); return obj; }
    for (const k of AD_KEYS) { if (k in obj) { try { delete obj[k]; } catch(_){} } }
    // YouTube 内部の adPlacements は playerResponse.adPlacements 直下と
    // playerResponse.playerAds の他、playerResponse.frameworkUpdates 内にも
    // 紛れることがあるので再帰的に潰す。
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') strip(v, depth+1);
    }
    return obj;
  }
  // 1) JSON.parse をフック
  const origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const r = origParse.call(this, text, reviver);
    try { strip(r, 0); } catch(_) {}
    return r;
  };
  // 2) Response.prototype.json をフック (fetch JSON 経路)
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = function () {
      return origJson.apply(this, arguments).then((r) => { try { strip(r, 0); } catch(_) {} return r; });
    };
  } catch (_) {}
  // 3) ytInitialPlayerResponse / ytInitialData をスクリプトタグ挿入時点で書き換える
  //    (YouTube は <script>var ytInitialPlayerResponse = {...};</script> を直書きする)
  const STRIP_RE = /("(?:adPlacements|playerAds|adSlots|adBreakHeartbeatParams|adReasons|adRequestConfig|playbackTracking)":)/g;
  function scrubText(src) {
    if (typeof src !== 'string' || src.indexOf('adPlacements') < 0 && src.indexOf('playerAds') < 0) return src;
    // 値を [] に潰す簡易置換 (uBO と同じ手口)。
    return src.replace(/"adPlacements":\[[^\]]*\]/g, '"adPlacements":[]')
              .replace(/"playerAds":\[[^\]]*\]/g, '"playerAds":[]')
              .replace(/"adSlots":\[[^\]]*\]/g, '"adSlots":[]');
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'textContent')
              || Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(HTMLScriptElement.prototype, 'textContent', {
        configurable: true, enumerable: true, get: desc.get,
        set(v) { try { v = scrubText(v); } catch(_) {} return origSet.call(this, v); },
      });
    }
  } catch (_) {}
  // 4) ytInitialPlayerResponse プロパティ自体を defineProperty で監視。
  try {
    let _ytipr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return _ytipr; },
      set(v) { try { strip(v, 0); } catch(_) {} _ytipr = v; },
    });
  } catch (_) {}
})();
"#;

const URL_WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuUrlWatchInstalled) return;
  window.__yuzuUrlWatchInstalled = true;
  let lastUrl = location.href;
  function notify() {
    const u = location.href;
    if (u === lastUrl) return;
    lastUrl = u;
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('browser_url_changed', { url: u });
      }
    } catch (e) { /* ignore */ }
  }
  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    notify();
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    notify();
    return r;
  };
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
  setInterval(notify, 1000);
  notify();
})();
"#;

const TITLE_WATCH_SCRIPT: &str = r#"
(function () {
  // サブフレーム (iframe) は独自の document.title を持ち、それだけでタブ名を上書き
  // されるとトップページのタイトルとずれる (例: YouTube の "Error 403" を表示する
  // 補助 iframe がタブ名を上書きしてしまう)。トップフレーム (メインドキュメント) だけ
  // を対象にする。
  try { if (window.top !== window) return; } catch (_) { return; }
  if (window.__yuzuTitleWatchInstalled) return;
  window.__yuzuTitleWatchInstalled = true;
  let lastTitle = '';
  function notify() {
    const t = document.title || '';
    if (t === lastTitle) return;
    lastTitle = t;
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('browser_title_changed', { title: t });
      }
    } catch (e) { /* ignore */ }
  }
  function install() {
    const titleEl = document.querySelector('head > title');
    if (titleEl) {
      new MutationObserver(notify).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    if (document.head) {
      new MutationObserver(() => {
        const t2 = document.querySelector('head > title');
        if (t2 && t2.__yuzuObserved !== true) {
          t2.__yuzuObserved = true;
          new MutationObserver(notify).observe(t2, { childList: true, characterData: true, subtree: true });
          notify();
        }
      }).observe(document.head, { childList: true });
    }
    notify();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
  setInterval(notify, 1500);
})();
"#;

/// 各 <audio>/<video> のミュート状態を `window.__yuzuMuted` で制御。
/// 主たるミュートは Rust 側の WebView2 ネイティブ SetIsMuted で行うため、
/// ここでは表示用の最低限の同期 (volume_boost のゲイン制御) だけを保持し、
/// HTMLMediaElement.muted/volume の setter フックや WebAudio connect の差し替えは
/// 行わない。これらは YouTube などの音量スライダー UI を破壊するため。
const VOLUME_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuVolInstalled) return;
  window.__yuzuVolInstalled = true;
  if (typeof window.__yuzuMuted !== 'boolean') window.__yuzuMuted = false;
  function apply() {
    var m = !!window.__yuzuMuted;
    // 音量ブーストで WebAudio の MediaElementSource → GainNode → destination という
    // 経路を作っているとき、それを GainNode.gain = 0 にしてサイレント化、
    // 解除時は元の gain を復帰させる。
    try {
      var gains = window.__yuzuGainNodes;
      if (gains && typeof window.__yuzuCurrentGain === 'number') {
        var media = document.querySelectorAll('audio,video');
        for (var i = 0; i < media.length; i++) {
          var n = gains.get(media[i]);
          if (n) n.gain.value = m ? 0 : window.__yuzuCurrentGain;
        }
      }
    } catch (_) {}
  }
  window.__yuzuApplyVolume = apply;
  try {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      window.__TAURI_INTERNALS__.invoke('tab_get_volume').then(function (v) {
        if (typeof v === 'number') { window.__yuzuMuted = (v <= 0.0001); apply(); }
      }).catch(function () {});
    }
  } catch (_) {}
})();
"#;

/// Ctrl+ホイール / Ctrl+0 / Ctrl++ / Ctrl+- でズーム。
/// 起動時にバックエンドから保存済みズームを取得して反映する。
const ZOOM_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuZoomInstalled) return;
  window.__yuzuZoomInstalled = true;
  function setZoom(z) {
    try { document.documentElement.style.zoom = String(z); } catch (_) {}
  }
  window.__yuzuApplyZoom = setZoom;
  function call(name, args) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke(name, args || {});
      }
    } catch (_) {}
    return Promise.resolve();
  }
  window.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    var delta = e.deltaY < 0 ? 0.1 : -0.1;
    call('browser_zoom_delta', { delta: delta });
  }, { passive: false, capture: true });
  window.addEventListener('keydown', function (e) {
    if (!e.ctrlKey) return;
    if (e.key === '0') { e.preventDefault(); call('browser_zoom_set', { zoom: 1.0 }); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); call('browser_zoom_delta', { delta: 0.1 }); }
    else if (e.key === '-') { e.preventDefault(); call('browser_zoom_delta', { delta: -0.1 }); }
  }, { capture: true });
  call('tab_get_zoom').then(function (z) {
    if (typeof z === 'number' && z > 0) setZoom(z);
  });
})();
"#;

/// <audio>/<video> の再生状態を監視し、「音が鳴っているか」をバックエンドに通知。
const AUDIO_WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuAudioWatchInstalled) return;
  window.__yuzuAudioWatchInstalled = true;
  var lastAudible = false;
  function isAudible() {
    var els = document.querySelectorAll('audio,video');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        if (!el.paused && !el.ended && el.currentTime > 0 && el.volume > 0 && !el.muted) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }
  function notify() {
    var a = isAudible();
    if (a === lastAudible) return;
    lastAudible = a;
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('browser_audible_changed', { audible: a });
      }
    } catch (_) {}
  }
  setInterval(notify, 800);
  document.addEventListener('play', notify, true);
  document.addEventListener('pause', notify, true);
  document.addEventListener('ended', notify, true);
  document.addEventListener('volumechange', notify, true);
})();
"#;

/// 現在のページの favicon URL を抽出してバックエンドに通知。
const FAVICON_WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuFaviconWatchInstalled) return;
  window.__yuzuFaviconWatchInstalled = true;
  var lastUrl = '';
  function pickFavicon() {
    var sels = [
      'link[rel~="icon"][sizes="any"]',
      'link[rel="shortcut icon"]',
      'link[rel="icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && el.href) return el.href;
    }
    try { return new URL('/favicon.ico', location.href).href; } catch (_) { return ''; }
  }
  function notify() {
    var u = pickFavicon();
    if (u === lastUrl) return;
    lastUrl = u;
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('browser_favicon_changed', { url: u });
      }
    } catch (_) {}
  }
  function start() {
    if (!document.head) { setTimeout(start, 50); return; }
    new MutationObserver(notify).observe(document.head, { subtree: true, childList: true, attributes: true });
    notify();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }
  setInterval(notify, 2000);
})();
"#;

/// Ctrl+クリック / 中クリック でリンクを新しいタブで開く。
const LINK_INTERCEPT_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuLinkInterceptInstalled) return;
  window.__yuzuLinkInterceptInstalled = true;
  function findAnchor(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A' && node.href) return node;
      node = node.parentNode;
    }
    return null;
  }
  function shouldOpenInNewTab(e, a) {
    if (!a) return false;
    var href = a.href || '';
    if (!href) return false;
    if (href.indexOf('javascript:') === 0) return false;
    if (href.indexOf('mailto:') === 0) return false;
    if (href.indexOf('#') === 0) return false;
    return true;
  }
  function openBg(href) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('tab_new', { url: href, background: true, lazy: true });
      }
    } catch (_) {}
  }
  // Ctrl+クリック (左ボタン)
  document.addEventListener('click', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.button !== 0) return;
    var a = findAnchor(e.target);
    if (!shouldOpenInNewTab(e, a)) return;
    e.preventDefault();
    e.stopPropagation();
    openBg(a.href);
  }, true);
  // 中クリック (auxclick だと一部サイトで取れないため mousedown でも保険)
  document.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var a = findAnchor(e.target);
    if (!shouldOpenInNewTab(e, a)) return;
    e.preventDefault();
    e.stopPropagation();
    openBg(a.href);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 1) return;
    var a = findAnchor(e.target);
    if (!shouldOpenInNewTab(e, a)) return;
    // 中クリックの自動スクロールを抑止
    e.preventDefault();
  }, true);
  // target=_blank も新しいタブで開く（window.open フック）
  var _open = window.open;
  window.open = function (url, name, features) {
    if (url) {
      openBg(String(url));
      return null;
    }
    return _open ? _open.apply(this, arguments) : null;
  };
})();
"#;

/// 動画などがフルスクリーンに入った/出たときにブラウザのクロームを退避させる。
const FULLSCREEN_WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuFullscreenWatchInstalled) return;
  window.__yuzuFullscreenWatchInstalled = true;
  function notify() {
    var fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('view_set_fullscreen', { fullscreen: fs });
      }
    } catch (_) {}
  }
  document.addEventListener('fullscreenchange', notify, true);
  document.addEventListener('webkitfullscreenchange', notify, true);
})();
"#;

#[derive(Default)]
struct TabState {
    /// 表示順を保持する（全ウィンドウ通しの順序。各 id はちょうど 1 ウィンドウに属する）。
    order: Vec<u64>,
    /// 各タブの最新 URL。
    urls: HashMap<u64, String>,
    /// 各タブの最新ページタイトル。
    titles: HashMap<u64, String>,
    /// 各タブの音量（0.0〜1.0）。未設定 = 1.0。
    volumes: HashMap<u64, f64>,
    /// 各タブのズーム倍率（0.25〜5.0）。未設定 = 1.0。
    zooms: HashMap<u64, f64>,
    /// 各タブで現在音が鳴っているか。
    audibles: HashMap<u64, bool>,
    /// 各タブの favicon URL。
    favicons: HashMap<u64, String>,
    /// 各タブが属するウィンドウラベル（例: "main", "main-2"）。
    window_of: HashMap<u64, String>,
    /// 「Ctrl/中クリック」等で背景に開いたタブのうち、まだ実際に navigate していない URL。
    /// アクティブ化されたタイミングで初めて navigate する（遅延ロード）。
    pending_urls: HashMap<u64, String>,
    /// ウィンドウごとの active タブ。
    active: HashMap<String, Option<u64>>,
    next_id: u64,
    /// ウィンドウごとに、閉じたタブの URL スタック（最新16件）。Ctrl+Shift+T で復元する。
    closed: HashMap<String, Vec<String>>,
    /// 切り離しウィンドウの連番（"main-2", "main-3", ...）。
    next_window_seq: u64,
    /// 各ウィンドウのダウンロードトースト webview の表示サイズ (幅, 高さ)。
    /// エントリが存在しない = 非表示。
    toast_sizes: HashMap<String, (f64, f64)>,
}

impl TabState {
    /// 既知のウィンドウラベル一覧。active マップのキーから取り出す。
    fn windows(&self) -> Vec<String> {
        self.active.keys().cloned().collect()
    }
    fn active_in(&self, win: &str) -> Option<u64> {
        self.active.get(win).copied().flatten()
    }
    fn set_active_in(&mut self, win: &str, id: Option<u64>) {
        self.active.insert(win.to_string(), id);
    }
    fn order_in(&self, win: &str) -> Vec<u64> {
        self.order
            .iter()
            .filter(|id| self.window_of.get(id).map(|w| w == win).unwrap_or(false))
            .copied()
            .collect()
    }
    fn push_closed(&mut self, win: &str, url: String) {
        let v = self.closed.entry(win.to_string()).or_default();
        v.push(url);
        if v.len() > 16 {
            v.remove(0);
        }
    }
    fn pop_closed(&mut self, win: &str) -> Option<String> {
        self.closed.get_mut(win).and_then(|v| v.pop())
    }
    fn summary_for(&self, win: &str) -> Vec<TabInfo> {
        let active = self.active_in(win);
        self.order_in(win)
            .iter()
            .map(|id| TabInfo {
                id: *id,
                url: self.urls.get(id).cloned().unwrap_or_default(),
                title: self.titles.get(id).cloned().unwrap_or_default(),
                active: active == Some(*id),
                muted: self.volumes.get(id).copied().unwrap_or(1.0) <= 0.0001,
                audible: self.audibles.get(id).copied().unwrap_or(false),
                favicon: self.favicons.get(id).cloned().unwrap_or_default(),
            })
            .collect()
    }
}

/// ウィンドウラベルからクローム webview のラベルを得る。
/// 既存の "main" は "ui" を使い、切り離しウィンドウ "main-N" は "ui-N" を使う。
fn chrome_label_for(window_label: &str) -> String {
    if window_label == "main" {
        "ui".to_string()
    } else if let Some(rest) = window_label.strip_prefix("main-") {
        format!("ui-{rest}")
    } else {
        format!("ui-{window_label}")
    }
}

/// ウィンドウラベルからダウンロードトースト webview のラベルを得る。
fn toast_label_for(window_label: &str) -> String {
    if window_label == "main" {
        "toast".to_string()
    } else if let Some(rest) = window_label.strip_prefix("main-") {
        format!("toast-{rest}")
    } else {
        format!("toast-{window_label}")
    }
}

/// ダウンロードトースト用 webview を遅延生成する。
/// 起動直後に chrome + 初期タブ + toast を同時生成すると Windows WebView2 の
/// 初期化レースで応答停止が起きるため、別タスクで少し待ってからメインスレッドで
/// add_child する。既に存在する場合は何もしない。
fn spawn_toast_webview(app: AppHandle, window_label: String) {
    tauri::async_runtime::spawn(async move {
        // ほかの webview の初期化が落ち着くまで待機。
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let label = toast_label_for(&window_label);
        let app_for_main = app.clone();
        let window_label_for_main = window_label.clone();
        let label_for_main = label.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = app_for_main.get_window(&window_label_for_main) else {
                return;
            };
            // 既に生成済みなら何もしない。
            if window.get_webview(&label_for_main).is_some() {
                return;
            }
            let res = window.add_child(
                WebviewBuilder::new(
                    &label_for_main,
                    WebviewUrl::App("toast.html".into()),
                )
                .additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MiddleClickAutoscroll",
                )
                .disable_drag_drop_handler()
                .transparent(true),
                LogicalPosition::new(OFFSCREEN_X, 0.0),
                LogicalSize::new(1.0, 1.0),
            );
            if let Err(e) = res {
                eprintln!("[toast] add_child failed for {label_for_main}: {e}");
            }
        });
    });
}

#[derive(Default)]
struct AppState(Mutex<TabState>);

#[derive(Serialize, Clone)]
struct TabInfo {
    id: u64,
    url: String,
    title: String,
    active: bool,
    muted: bool,
    audible: bool,
    favicon: String,
}

fn view_label(id: u64) -> String {
    format!("view-{id}")
}

fn parse_view_id(label: &str) -> Option<u64> {
    label.strip_prefix("view-").and_then(|s| s.parse().ok())
}

/// WebView2 のネイティブ `IsMuted` プロパティでタブ全体を OS レベルで消音する。
/// JS フック (HTMLMediaElement / WebAudio) は YouTube などの一部実装で抜けるため、
/// このネイティブミュートを最終手段として併用する。
#[cfg(windows)]
fn set_view_native_muted(view: &tauri::webview::Webview, muted: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows::core::Interface;
    let label = view.label().to_string();
    let r = view.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        match controller.CoreWebView2() {
            Ok(core) => match core.cast::<ICoreWebView2_8>() {
                Ok(c8) => match c8.SetIsMuted(muted) {
                    Ok(()) => {
                        eprintln!("[mute] {label} SetIsMuted({muted}) ok");
                    }
                    Err(e) => eprintln!("[mute] {label} SetIsMuted err: {e:?}"),
                },
                Err(e) => eprintln!("[mute] {label} cast ICoreWebView2_8 err: {e:?}"),
            },
            Err(e) => eprintln!("[mute] {label} CoreWebView2 err: {e:?}"),
        }
    });
    if let Err(e) = r {
        eprintln!("[mute] with_webview err: {e:?}");
    }
}

#[cfg(not(windows))]
fn set_view_native_muted(_view: &tauri::webview::Webview, _muted: bool) {}

/// view webview に WebView2 ネイティブの `WebResourceRequested` フックを仕掛けて、
/// `adblock::is_blocked` がヒットした URL のみ HTTP 403 で潰す。
///
/// JS 側 (`UBLOCK_SCRIPT`) は `<img>` や `<iframe>` 等パーサ由来のリクエストを
/// 捕まえられないので、ネイティブでこの段を併用しないと実効ブロックにならない。
#[cfg(windows)]
fn install_adblock_for_view(view: &tauri::webview::Webview) {
    use webview2_com::take_pwstr;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{Interface, HSTRING, PWSTR};

    let label = view.label().to_string();
    let r = view.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[adblock] {label} CoreWebView2 err: {e:?}");
                return;
            }
        };
        // `*` フィルタで全リクエストを拾う。
        let filter = HSTRING::from("*");
        let filter_pcwstr = windows::core::PCWSTR(filter.as_ptr());
        if let Ok(c22) = core.cast::<ICoreWebView2_22>() {
            if let Err(e) = c22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                filter_pcwstr,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            ) {
                eprintln!("[adblock] {label} AddFilterWithKinds err: {e:?}");
            }
        } else if let Err(e) =
            core.AddWebResourceRequestedFilter(filter_pcwstr, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
        {
            eprintln!("[adblock] {label} AddWebResourceRequestedFilter err: {e:?}");
            return;
        }

        // 403 応答を作るのに ICoreWebView2Environment が必要。
        let env = match core
            .cast::<ICoreWebView2_2>()
            .and_then(|c2| c2.Environment())
        {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[adblock] {label} Environment err: {e:?}");
                return;
            }
        };

        let label_for_handler = label.clone();
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let req = args.Request()?;
            let mut uri = PWSTR::null();
            req.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let host = url::Url::parse(&uri)
                .ok()
                .and_then(|u| u.host_str().map(|s| s.to_string()));
            let Some(host) = host else { return Ok(()) };
            if !crate::adblock::is_blocked(&host) {
                return Ok(());
            }
            let resp = env.CreateWebResourceResponse(
                None,
                403,
                &HSTRING::from("Blocked by yuzu-browser"),
                &HSTRING::from(""),
            )?;
            args.SetResponse(&resp)?;
            #[cfg(debug_assertions)]
            eprintln!("[adblock] {label_for_handler} blocked {host}");
            #[cfg(not(debug_assertions))]
            let _ = &label_for_handler;
            Ok(())
        }));

        let mut token = Default::default();
        if let Err(e) = core.add_WebResourceRequested(&handler, &mut token) {
            eprintln!("[adblock] {label} add_WebResourceRequested err: {e:?}");
        }
    });
    if let Err(e) = r {
        eprintln!("[adblock] with_webview err: {e:?}");
    }
}

#[cfg(not(windows))]
fn install_adblock_for_view(_view: &tauri::webview::Webview) {}

// ===== ウィンドウ間タブ転送 (TCP ループバック IPC) =====
//
// 各 yuzu-browser インスタンスが 127.0.0.1 のランダムポートで listen し、
// `%TEMP%/yuzu-browser/instances/<pid>.json` にポート番号を書き込む。
// タブをドラッグして他の yuzu ウィンドウへドロップしたとき、フロント側は
// `tab_drop_target_pid` でカーソル下のウィンドウの PID を取り、
// `tab_attach` でそのインスタンスへ URL を送って新規タブとして開かせる。
//
// プロトコル: 1 行 1 リクエストの JSON。改行で完結。
//   {"cmd":"open_tab","url":"https://..."}

fn ipc_dir() -> PathBuf {
    std::env::temp_dir().join("yuzu-browser").join("instances")
}

fn ipc_registry_path(pid: u32) -> PathBuf {
    ipc_dir().join(format!("{pid}.json"))
}

fn ipc_write_self_port(port: u16) -> std::io::Result<()> {
    let dir = ipc_dir();
    std::fs::create_dir_all(&dir)?;
    let path = ipc_registry_path(std::process::id());
    std::fs::write(path, format!("{{\"port\":{port}}}"))
}

fn ipc_remove_self_port() {
    let _ = std::fs::remove_file(ipc_registry_path(std::process::id()));
}

// ===== 異常終了からの復旧 =====
//
// ダウンロード中等にユーザがアプリを強制終了すると、
//   - 親 (yuzu-browser.exe) は死んだのに子 msedgewebview2.exe が残る
//   - EBWebView/Default に書きかけのセッション/ダウンロード状態が残る
// という状況になる。次回起動時、新しい WebView2 が同じ user_data_folder を
// 触ろうとしてヘルパープロセスのクラッシュリカバリ待ちで固まり、
// 「yuzu-browser (応答なし)」になる。
//
// 起動時に lock ファイルの有無で前回の異常終了を検出し、必要なら
// 残存ヘルパーを taskkill して、リカバリ用ファイルを掃除する。
// 正常終了 (RunEvent::Exit) で lock を消すので、誤発動はしない。

fn dirty_run_lock_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("running.lock"))
}

/// Tauri / WebView2 が初期化される**前**に main スレッドで呼ぶ。
/// AppHandle を使わずに環境変数からパスを算出する。
/// WebView2 がまだ起動していないので taskkill を同期実行しても安全。
#[cfg(target_os = "windows")]
fn pre_init_recover() {
    let bundle_id = "com.yuzu.browser";
    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => return,
    };
    let localappdata = std::env::var("LOCALAPPDATA").ok();
    let lock = PathBuf::from(&appdata).join(bundle_id).join("running.lock");
    // ロックなし → 前回クリーン終了。マーカーを書いて終わる。
    if !lock.exists() {
        if let Some(p) = lock.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::write(&lock, format!("{}", std::process::id()));
        return;
    }
    eprintln!("[recover] previous run did not exit cleanly; cleaning up WebView2 state");
    // dirty マーカーを先に消す (失敗しても次回ループしないように)。
    let _ = std::fs::remove_file(&lock);
    // WebView2 未起動なので同期 kill が安全。
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "msedgewebview2.exe"])
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .and_then(|mut c| c.wait());
    std::thread::sleep(std::time::Duration::from_millis(500));
    // EBWebView セッションファイルを掃除する。
    let mut udfs: Vec<PathBuf> = Vec::new();
    if let Some(local) = &localappdata {
        udfs.push(PathBuf::from(local).join(bundle_id).join("EBWebView"));
    }
    let roaming_udf = PathBuf::from(&appdata).join(bundle_id).join("EBWebView");
    if !udfs.contains(&roaming_udf) {
        udfs.push(roaming_udf);
    }
    for udf in &udfs {
        if udf.exists() {
            cleanup_webview2_recovery_files(udf);
        }
    }
    // 自分の PID でロックを書き直す。
    if let Some(p) = lock.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(&lock, format!("{}", std::process::id()));
}

#[cfg(not(target_os = "windows"))]
fn pre_init_recover() {}

fn recover_from_dirty_shutdown(app: &AppHandle) {
    // pre_init_recover() で既にリカバリ済み。ここではマーカーの書き直しのみ。
    if let Some(lock) = dirty_run_lock_path(app) {
        if let Some(p) = lock.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::write(&lock, format!("{}", std::process::id()));
    }
}

fn clear_dirty_run_marker(app: &AppHandle) {
    if let Some(p) = dirty_run_lock_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

fn cleanup_webview2_recovery_files(user_data_folder: &PathBuf) {
    // Chromium 系のセッション復元/ダウンロード復元のトリガになるファイル類。
    // 消しても Cookie/履歴/キャッシュは残るので、ユーザデータは失わない。
    let default_dir = user_data_folder.join("Default");
    let candidates: &[&str] = &[
        "Sessions",
        "Session Storage",
        "Current Session",
        "Current Tabs",
        "Last Session",
        "Last Tabs",
        "DownloadMetadata",
    ];
    for name in candidates {
        let p = default_dir.join(name);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(&p);
        } else if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    // 中途半端な partial download (.crdownload) も掃除する。
    if let Ok(rd) = std::fs::read_dir(&default_dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) == Some("crdownload") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

fn ipc_read_port_for_pid(pid: u32) -> Option<u16> {
    let txt = std::fs::read_to_string(ipc_registry_path(pid)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    v.get("port").and_then(|p| p.as_u64()).map(|p| p as u16)
}

/// 指定インスタンスへ「新規タブを開く」コマンドを送信。失敗したらレジストリから削除。
fn ipc_send_open_tab(pid: u32, url: &str) -> Result<(), String> {
    use std::io::Write;
    use std::net::TcpStream;
    use std::time::Duration;
    let port = ipc_read_port_for_pid(pid).ok_or_else(|| format!("no port for pid {pid}"))?;
    let addr = format!("127.0.0.1:{port}");
    match TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?,
        Duration::from_millis(500),
    ) {
        Ok(mut s) => {
            let _ = s.set_write_timeout(Some(Duration::from_millis(500)));
            let payload = serde_json::json!({ "cmd": "open_tab", "url": url }).to_string();
            s.write_all(payload.as_bytes())
                .and_then(|_| s.write_all(b"\n"))
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            // 連絡できないインスタンスのレジストリは消しておく。
            let _ = std::fs::remove_file(ipc_registry_path(pid));
            Err(format!("connect failed: {e}"))
        }
    }
}

/// TCP listener を起動して、受信した open_tab を UI に転送する。
fn ipc_spawn_listener(app: AppHandle) -> std::io::Result<u16> {
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    return;
                };
                let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
                if cmd == "open_tab" {
                    if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                        // ウィンドウを前面化してから UI 側に新規タブ要求を投げる。
                        if let Some(win) = app.get_window("main") {
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                        let _ = app.emit_to(
                            "ui",
                            "external-open-tab",
                            serde_json::json!({ "url": url }),
                        );
                    }
                }
            });
        }
    });
    Ok(port)
}

/// Win32 の WindowFromPoint でカーソル下のトップウィンドウの PID を取得する。
/// 自プロセスの場合と yuzu-browser 以外の場合は `None` を返す。
#[cfg(windows)]
fn ipc_pid_under_cursor() -> Option<u32> {
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    type HWND = *mut std::ffi::c_void;
    extern "system" {
        fn GetCursorPos(p: *mut POINT) -> i32;
        fn WindowFromPoint(p: POINT) -> HWND;
        fn GetAncestor(hwnd: HWND, ga: u32) -> HWND;
        fn GetWindowThreadProcessId(hwnd: HWND, lpdw: *mut u32) -> u32;
    }
    const GA_ROOT: u32 = 2;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        let hwnd = WindowFromPoint(pt);
        if hwnd.is_null() {
            return None;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.is_null() { hwnd } else { root };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(target, &mut pid);
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        // レジストリにこの PID が居るときだけ yuzu-browser とみなす。
        if ipc_read_port_for_pid(pid).is_some() {
            Some(pid)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn ipc_pid_under_cursor() -> Option<u32> {
    None
}

/// ドロップ先ウィンドウの PID を返す（同 yuzu-browser 別インスタンスのときのみ）。
#[tauri::command]
fn tab_drop_target_pid() -> Option<u32> {
    ipc_pid_under_cursor()
}

/// 指定 PID のインスタンスへ URL を送って新しいタブを開かせる。
#[tauri::command]
fn tab_attach(pid: u32, url: String) -> Result<(), String> {
    if url.is_empty() {
        return Err("url is empty".to_string());
    }
    ipc_send_open_tab(pid, &url)
}

/// カーソル下にある「自プロセスの別 yuzu ウィンドウ」のラベルを返す。
/// Firefox 風タブ D&D マージ用 (呼び出し元のウィンドウは除外)。
#[cfg(windows)]
#[tauri::command]
fn tab_drop_target_window(window: Window, app: AppHandle) -> Option<String> {
    use std::os::raw::c_void;
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    type HWND = *mut c_void;
    extern "system" {
        fn GetCursorPos(p: *mut POINT) -> i32;
        fn WindowFromPoint(p: POINT) -> HWND;
        fn GetAncestor(hwnd: HWND, ga: u32) -> HWND;
    }
    const GA_ROOT: u32 = 2;
    let source = window.label().to_string();
    let target_hwnd = unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        let h = WindowFromPoint(pt);
        if h.is_null() {
            return None;
        }
        let r = GetAncestor(h, GA_ROOT);
        if r.is_null() {
            h
        } else {
            r
        }
    };
    for (label, win) in app.windows() {
        if label == source {
            continue;
        }
        if let Ok(hwnd) = win.hwnd() {
            if hwnd.0 as *mut c_void == target_hwnd {
                return Some(label);
            }
        }
    }
    None
}

#[cfg(not(windows))]
#[tauri::command]
fn tab_drop_target_window(_window: Window, _app: AppHandle) -> Option<String> {
    None
}

/// 既存タブを別の自ウィンドウへ移し替える（reparent）。再生継続。
#[tauri::command]
async fn tab_reattach(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    target_window: String,
) -> Result<(), String> {
    use std::sync::mpsc;
    let src_label = window.label().to_string();
    if src_label == target_window {
        return Err("same window".into());
    }
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let owner = s.window_of.get(&id).cloned().unwrap_or_default();
        if owner != src_label {
            return Err("tab not in source window".into());
        }
        if app.get_window(&target_window).is_none() {
            return Err("target window not found".into());
        }
    }

    // メインスレッドで reparent。
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let app_clone = app.clone();
    let src_clone = src_label.clone();
    let tgt_clone = target_window.clone();
    let view_lbl = view_label(id);
    app.run_on_main_thread(move || {
        let res = (|| -> Result<(), String> {
            let src_win = app_clone
                .get_window(&src_clone)
                .ok_or_else(|| "source window gone".to_string())?;
            let tgt_win = app_clone
                .get_window(&tgt_clone)
                .ok_or_else(|| "target window gone".to_string())?;
            let view = src_win
                .get_webview(&view_lbl)
                .ok_or_else(|| "view not found".to_string())?;
            view.reparent(&tgt_win).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;

    // 状態更新: window_of 移動、active 切替。
    let close_src = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.window_of.insert(id, target_window.clone());
        // ターゲットでアクティブに。
        s.set_active_in(&target_window, Some(id));
        // ソースの active 更新。
        let next = s.order_in(&src_label).last().copied();
        s.set_active_in(&src_label, next);
        // ソースが空 & main でなければ閉じる。
        s.order_in(&src_label).is_empty() && src_label != "main"
    };

    if let Some(tgt_win) = app.get_window(&target_window) {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&tgt_win, &s);
        apply_active_title(&tgt_win, &s);
    }

    if close_src {
        // 重要: reparent 直後に src_win.close() すると、Tauri 内部の WebviewManager が
        // 「reparent 済み」を反映する前に旧ウィンドウの破棄処理が走り、
        // 移したばかりの webview まで一緒に破壊されてしまうことがある (タブが消える)。
        // 別スレッドで遅延させ、Tauri 側のブックキーピングが追いつくのを待ってから閉じる。
        // 併せて TabState の active マップから src のエントリを除去する。
        {
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            s.active.remove(&src_label);
            s.closed.remove(&src_label);
        }
        let app_c = app.clone();
        let src_c = src_label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let app_inner = app_c.clone();
            let _ = app_c.run_on_main_thread(move || {
                if let Some(w) = app_inner.get_window(&src_c) {
                    let _ = w.close();
                }
            });
        });
    } else {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
    }

    let s = state.0.lock().map_err(|e| e.to_string())?;
    emit_tabs(&app, &s);
    drop(s);
    // 保険: 受け側 chrome がロード未完なら chrome_ready で救うが、念のため遅延再 emit。
    schedule_emit_tabs(&app, &[150, 500, 1500]);
    Ok(())
}

/// 全 webview をウィンドウサイズに合わせて再配置する（指定ウィンドウ分のみ）。
fn relayout(window: &Window, state: &TabState) {
    let win_label = window.label().to_string();
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = match window.inner_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let logical = size.to_logical::<f64>(scale);
    let w = logical.width.max(1.0);
    let h = logical.height.max(1.0);

    let chrome = chrome_label_for(&win_label);
    let has_chrome = window.get_webview(&chrome).is_some();
    if let Some(ui) = window.get_webview(&chrome) {
        let _ = ui.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = ui.set_size(LogicalSize::new(w, CHROME_HEIGHT));
    }

    let chrome_h = if has_chrome { CHROME_HEIGHT } else { 0.0 };
    let view_h = (h - chrome_h).max(1.0);
    let active = state.active_in(&win_label);
    let order = state.order_in(&win_label);

    // 黒チラつき防止: 非 active も同じサイズにしておく。サイズ 1x1 のまま放置すると
    // タブ切替の瞬間に full-size へのリサイズ＆再レイアウトが走り、ページが
    // 描画し直されるまで黒い枠が見えてしまう。位置だけオフスクリーンへ退避し、
    // サイズはずっと表示エリアと同じに保つことで、切替時は座標移動だけで済み
    // 黒画面が挟まらない。
    if let Some(active_id) = active {
        if let Some(view) = window.get_webview(&view_label(active_id)) {
            let _ = view.set_size(LogicalSize::new(w, view_h));
            let _ = view.set_position(LogicalPosition::new(0.0, chrome_h));
        }
    }
    for id in &order {
        if Some(*id) == active {
            continue;
        }
        if let Some(view) = window.get_webview(&view_label(*id)) {
            // 画面外へ退避するが、サイズは表示エリアと同じに揃える。
            let _ = view.set_size(LogicalSize::new(w, view_h));
            let _ = view.set_position(LogicalPosition::new(OFFSCREEN_X, chrome_h));
        }
    }

    // ダウンロードトースト webview。表示中ならウィンドウ右下に再配置。
    let toast = toast_label_for(&win_label);
    if let Some(tv) = window.get_webview(&toast) {
        if let Some((tw, th)) = state.toast_sizes.get(&win_label).copied() {
            let tw = tw.max(1.0).min(w);
            let th = th.max(1.0).min(h);
            let x = (w - tw).max(0.0);
            let y = (h - th).max(0.0);
            let _ = tv.set_size(LogicalSize::new(tw, th));
            let _ = tv.set_position(LogicalPosition::new(x, y));
        } else {
            let _ = tv.set_size(LogicalSize::new(1.0, 1.0));
            let _ = tv.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
        }
    }
}

/// 全ウィンドウへ tabs-updated を配信する。
fn emit_tabs(app: &AppHandle, state: &TabState) {
    for win in state.windows() {
        let _ = app.emit_to(
            chrome_label_for(&win),
            "tabs-updated",
            state.summary_for(&win),
        );
    }
}

/// detach/reattach 直後の chrome WebView は dev サーバからのロードがまだ完了していない
/// ことがあり、emit_tabs を取りこぼす。フロント側 chrome_ready コマンドで本来は救えるが、
/// 何らかの理由で chrome_ready が届かなかったときの保険として、複数の遅延で再送する。
fn schedule_emit_tabs(app: &AppHandle, delays_ms: &[u64]) {
    for &d in delays_ms {
        let app_c = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(d));
            let s_state: State<'_, AppState> = app_c.state();
            let guard = s_state.0.lock();
            if let Ok(s) = guard {
                emit_tabs(&app_c, &s);
            }
        });
    }
}

/// active タブのタイトルをウィンドウタイトルに反映。
fn apply_active_title(window: &Window, state: &TabState) {
    let win_label = window.label().to_string();
    let title = match state.active_in(&win_label) {
        Some(id) => state
            .titles
            .get(&id)
            .cloned()
            .filter(|t| !t.is_empty())
            .or_else(|| state.urls.get(&id).cloned())
            .unwrap_or_else(|| "yuzu-browser".to_string()),
        None => "yuzu-browser".to_string(),
    };
    let display = if title == "yuzu-browser" {
        title
    } else {
        format!("{title} - yuzu-browser")
    };
    let _ = window.set_title(&display);
}

/// 新しい view webview をウィンドウに生やす。
fn create_view(window: &Window, app: &AppHandle, id: u64, url: &str) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let label = view_label(id);
    let app_for_nav = app.clone();
    let app_for_dl = app.clone();
    window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(parsed))
                // Windows WebView2 の middle-click autoscroll を無効化。
                // 有効だと UI WebView 上で中クリックしたときにメインスレッドの
                // メッセージループがマウスキャプチャに取られ、Tauri の
                // run_on_main_thread が走らずアプリ全体がフリーズする。
                // wry のデフォルト引数 (msWebOOUI 等の disable) も維持する必要がある。
                .additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MiddleClickAutoscroll",
                )
                .initialization_script(ADBLOCK_PRELUDE)
                .initialization_script(UBLOCK_SCRIPT)
                .initialization_script(URL_WATCH_SCRIPT)
                .initialization_script(TITLE_WATCH_SCRIPT)
                .initialization_script(VOLUME_SCRIPT)
                .initialization_script(ZOOM_SCRIPT)
                .initialization_script(AUDIO_WATCH_SCRIPT)
                .initialization_script(FAVICON_WATCH_SCRIPT)
                .initialization_script(LINK_INTERCEPT_SCRIPT)
                .initialization_script(FULLSCREEN_WATCH_SCRIPT)
                .on_navigation(move |u| {
                    let url_s = u.to_string();
                    // 注意: ここで AppState を blocking lock してはいけない。
                    // on_navigation は GUI スレッドで呼ばれるため、worker スレッド
                    // 側が AppState を保持したまま set_size 等で GUI スレッドを
                    // 待つと相互ロックでアプリ全体がフリーズする。try_lock で
                    // 取得できないときは諦めて、JS 側 browser_url_changed の
                    // 同期に任せる。
                    if let Some(app_state) = app_for_nav.try_state::<AppState>() {
                        if let Ok(mut s) = app_state.0.try_lock() {
                            s.urls.insert(id, url_s.clone());
                        }
                    }
                    let _ = app_for_nav.emit_to(
                        "ui",
                        "view-navigated",
                        serde_json::json!({ "id": id, "url": url_s }),
                    );
                    true
                })
                .on_download(move |_webview, event| {
                    handle_download_event(&app_for_dl, id, event)
                }),
            LogicalPosition::new(OFFSCREEN_X, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    // 生成直後の view にネイティブ広告ブロックフックを仕掛ける。
    if let Some(view) = window.get_webview(&label) {
        install_adblock_for_view(&view);
    }
    Ok(())
}

// ===== コマンド =====

/// `create_view` を main スレッドで同期実行するヘルパー。
/// Tauri のコマンドハンドラは worker スレッドで動くため、
/// webview 生成は main へディスパッチしないと動かないことがある。
fn create_view_on_main(app: &AppHandle, window: &Window, id: u64, url: &str) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let app_cloned = app.clone();
    let window_cloned = window.clone();
    let url_owned = url.to_string();
    app.run_on_main_thread(move || {
        let r = create_view(&window_cloned, &app_cloned, id, &url_owned);
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn tab_new(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    background: Option<bool>,
    lazy: Option<bool>,
) -> Result<u64, String> {
    let target = url.unwrap_or_else(|| HOME_URL.to_string());
    let bg = background.unwrap_or(false);
    // 「遅延ロード」モード: フォアグラウンドに切り替わるまでページを読み込まない。
    // background=true のときだけ意味があるのでフォアグラウンド時は無視。
    let lazy_load = bg && lazy.unwrap_or(false);
    let win_label = window.label().to_string();
    // 1) ID だけ確保してロックを即座に解放
    let id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        s.next_id
    };
    // 2) ロック外 + main スレッドで webview 作成。lazy のときは about:blank で生やす。
    let initial_url = if lazy_load {
        "about:blank".to_string()
    } else {
        target.clone()
    };
    create_view_on_main(&app, &window, id, &initial_url)?;
    // 3) 改めてロックして状態反映 → relayout → emit
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.push(id);
        s.window_of.insert(id, win_label.clone());
        s.urls.insert(id, target.clone());
        if lazy_load {
            // タイトル欄に URL を出しておくのでタブ名も埋まる。
            s.titles.insert(id, target.clone());
            s.pending_urls.insert(id, target);
        }
        if !bg {
            s.set_active_in(&win_label, Some(id));
        } else if s.active_in(&win_label).is_none() {
            // active が無いときは結局 active にしないと真っ黒なので。
            s.set_active_in(&win_label, Some(id));
        }
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(id)
}

/// タブをタブバーから切り離して新ウィンドウ (新プロセス) として開く。
/// yuzu-browser の現アーキテクチャは単一ウィンドウなので、別プロセスを起動して
/// 環境変数 `YUZU_INITIAL_URL` で初期 URL を渡す方式にする。
#[tauri::command]
async fn tab_detach(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    use std::sync::mpsc;
    let old_win_label = window.label().to_string();
    // 検証: そのタブが本当にこのウィンドウに属するか。最後の 1 枚は切り離さない。
    let new_label = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let owner = s.window_of.get(&id).cloned().unwrap_or_default();
        if owner != old_win_label {
            return Err("tab not in this window".into());
        }
        if s.order_in(&old_win_label).len() <= 1 && old_win_label == "main" {
            return Err("cannot detach last tab of main window".into());
        }
        s.next_window_seq += 1;
        format!("main-{}", s.next_window_seq)
    };

    // メインスレッドで新ウィンドウを生成し、既存 webview を reparent する。
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let app_clone = app.clone();
    let new_label_clone = new_label.clone();
    let old_win_label_clone = old_win_label.clone();
    let view_lbl = view_label(id);
    app.run_on_main_thread(move || {
        let res = (|| -> Result<(), String> {
            let old_window = app_clone
                .get_window(&old_win_label_clone)
                .ok_or_else(|| "old window gone".to_string())?;
            let scale = old_window.scale_factor().unwrap_or(1.0);
            let osize = old_window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            let new_window = WindowBuilder::new(&app_clone, &new_label_clone)
                .title("yuzu-browser")
                .inner_size(osize.width.max(400.0), osize.height.max(300.0))
                .background_color(tauri::window::Color(26, 26, 26, 255))
                .resizable(true)
                .build()
                .map_err(|e| e.to_string())?;
            // 新ウィンドウにもクローム (UI) を作る。ラベルは "ui-N"。
            let chrome_label = chrome_label_for(&new_label_clone);
            let app_for_chrome = app_clone.clone();
            new_window
                .add_child(
                    WebviewBuilder::new(&chrome_label, WebviewUrl::default())
                        .additional_browser_args(
                            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MiddleClickAutoscroll",
                        )
                        .disable_drag_drop_handler()
                        .on_page_load(move |wv, _payload| {
                            // chrome の DOM 準備完了直後に必ずタブ一覧を流し込む。
                            // フロント側の chrome_ready / 遅延再 emit に頼らず確実に届ける。
                            let win_label = wv.window().label().to_string();
                            let s_state: State<'_, AppState> = app_for_chrome.state();
                            let guard = s_state.0.lock();
                            if let Ok(s) = guard {
                                let summary = s.summary_for(&win_label);
                                eprintln!(
                                    "[on_page_load] chrome={} window={} -> emit {} tabs",
                                    wv.label(),
                                    win_label,
                                    summary.len()
                                );
                                let _ = app_for_chrome.emit_to(
                                    chrome_label_for(&win_label),
                                    "tabs-updated",
                                    summary,
                                );
                            }
                        })
                        .transparent(true),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(osize.width.max(400.0), CHROME_HEIGHT),
                )
                .map_err(|e| e.to_string())?;
            // ダウンロードトースト用 webview の生成は遅延する (起動レース対策)。
            // reparent 完了後に spawn_toast_webview で生やす。
            let _ = toast_label_for(&new_label_clone);
            let view = old_window
                .get_webview(&view_lbl)
                .ok_or_else(|| "view not found".to_string())?;
            view.reparent(&new_window).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;

    // 状態を更新。
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.window_of.insert(id, new_label.clone());
        s.set_active_in(&new_label, Some(id));
        // 旧ウィンドウの active を別のタブへ。
        let next = s.order_in(&old_win_label).last().copied();
        s.set_active_in(&old_win_label, next);
    }

    // 新ウィンドウのリサイズ追従とレイアウト。
    if let Some(new_window) = app.get_window(&new_label) {
        let win_clone = new_window.clone();
        let app_for_resize = app.clone();
        new_window.on_window_event(move |event| {
            if let WindowEvent::Resized(_) = event {
                let s_state: State<'_, AppState> = app_for_resize.state();
                let guard = s_state.0.lock();
                if let Ok(s) = guard {
                    relayout(&win_clone, &s);
                }
            }
        });
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&new_window, &s);
        apply_active_title(&new_window, &s);
    }

    // 旧ウィンドウも再レイアウト。
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    // 新ウィンドウの chrome がロード完了する前の取りこぼし対策。
    schedule_emit_tabs(&app, &[150, 500, 1500]);
    Ok(())
}

#[tauri::command]
async fn tab_close(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    // 進行中ダウンロードを抱えているタブは閉じさせない。
    // フロント側で確認ダイアログを出して `force=true` で再呼び出し可能にしたい
    // ところだが、現状の UI からは強制クローズは不要なので素直に拒否する。
    {
        let dl_state = app.state::<DownloadState>();
        let busy = dl_state
            .0
            .lock()
            .map(|s| {
                s.items
                    .iter()
                    .any(|i| i.tab_id == Some(id) && i.status == "in-progress")
            })
            .unwrap_or(false);
        if busy {
            return Err(
                "このタブはダウンロード中のため閉じられません。完了するか中止してください。"
                    .to_string(),
            );
        }
    }
    // 1) ロック内で状態を更新（webview close は別途）
    let close_window = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        // 閉じるタブの所属ウィンドウを使う（他のウィンドウのタブを閉じることもある）。
        let owner = s
            .window_of
            .get(&id)
            .cloned()
            .unwrap_or_else(|| win_label.clone());
        // 閉じるタブの URL をスタックに保存（復元用）。
        if let Some(u) = s.urls.get(&id).cloned() {
            if !u.is_empty() && u != HOME_URL {
                s.push_closed(&owner, u);
            }
        }
        s.order.retain(|x| *x != id);
        s.urls.remove(&id);
        s.titles.remove(&id);
        s.window_of.remove(&id);
        s.pending_urls.remove(&id);
        if s.active_in(&owner) == Some(id) {
            let next = s.order_in(&owner).last().copied();
            s.set_active_in(&owner, next);
        }
        // そのウィンドウのタブがゼロになったらウィンドウも閉じる。
        // 全ウィンドウが閉じれば Tauri が自動で終了する。
        s.order_in(&owner).is_empty()
    };
    // 2) ロック外で webview close
    if let Some(view) = window.get_webview(&view_label(id)) {
        let _ = view.close();
    }
    // 3) 最後のタブだったらウィンドウごと閉じる
    if close_window {
        let _ = window.close();
        return Ok(());
    }
    // 4) relayout + emit
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(())
}

#[tauri::command]
async fn tab_switch(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    // 遅延ロード対象なら初回アクティブ化のタイミングで navigate する。
    let pending = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        if !s.order.contains(&id) {
            return Err(format!("unknown tab id: {id}"));
        }
        s.set_active_in(&win_label, Some(id));
        s.pending_urls.remove(&id)
    };
    if let Some(url) = pending {
        if let Some(view) = window.get_webview(&view_label(id)) {
            if let Ok(parsed) = Url::parse(&url) {
                let _ = view.navigate(parsed);
            }
        }
    }
    let s = state.0.lock().map_err(|e| e.to_string())?;
    relayout(&window, &s);
    apply_active_title(&window, &s);
    emit_tabs(&app, &s);
    Ok(())
}

#[tauri::command]
fn tab_list(webview: Webview, state: State<'_, AppState>) -> Result<Vec<TabInfo>, String> {
    // chrome WebView の親ウィンドウラベルを明示取得。
    // Tauri 2 で multi-webview window の場合、Window 注入よりも
    // webview.window().label() の方が確実。
    let win_label = webview.window().label().to_string();
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let r = s.summary_for(&win_label);
    eprintln!(
        "[tab_list] webview={} window={} -> {} tabs",
        webview.label(),
        win_label,
        r.len()
    );
    Ok(r)
}

/// chrome WebView がマウント完了したことを通知。
/// バックエンドは即座に該当ウィンドウのタブ一覧を再 emit する。
/// detach/reattach の直後に chrome がまだロード中で
/// 最初の "tabs-updated" を取りこぼした場合の保険。
#[tauri::command]
fn chrome_ready(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let win_label = webview.window().label().to_string();
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let summary = s.summary_for(&win_label);
    eprintln!(
        "[chrome_ready] webview={} window={} -> emit {} tabs",
        webview.label(),
        win_label,
        summary.len()
    );
    let _ = app.emit_to(chrome_label_for(&win_label), "tabs-updated", summary);
    Ok(())
}

/// 指定タブを複製（同じ URL で新規タブを開く）。
#[tauri::command]
async fn tab_duplicate(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<u64, String> {
    let url = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.urls
            .get(&id)
            .cloned()
            .unwrap_or_else(|| HOME_URL.to_string())
    };
    let new_id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        s.next_id
    };
    create_view_on_main(&app, &window, new_id, &url)?;
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let win_label = window.label().to_string();
        // 元タブの直後に挿入
        let pos = s
            .order
            .iter()
            .position(|x| *x == id)
            .map(|p| p + 1)
            .unwrap_or(s.order.len());
        s.order.insert(pos, new_id);
        s.window_of.insert(new_id, win_label.clone());
        s.urls.insert(new_id, url);
        s.set_active_in(&win_label, Some(new_id));
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(new_id)
}

/// 直近に閉じたタブを復元（スタック LIFO）。
#[tauri::command]
async fn tab_reopen(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<u64>, String> {
    let win_label = window.label().to_string();
    let url = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.pop_closed(&win_label)
    };
    let url = match url {
        Some(u) => u,
        None => return Ok(None),
    };
    let id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        s.next_id
    };
    create_view_on_main(&app, &window, id, &url)?;
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.push(id);
        s.window_of.insert(id, win_label.clone());
        s.urls.insert(id, url);
        s.set_active_in(&win_label, Some(id));
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(Some(id))
}

/// 指定タブ以外を全て閉じる（同一ウィンドウ内のみ）。
#[tauri::command]
async fn tab_close_others(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    let to_close: Vec<u64> = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.order_in(&win_label)
            .into_iter()
            .filter(|x| *x != id)
            .collect()
    };
    for cid in to_close {
        {
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(u) = s.urls.get(&cid).cloned() {
                if !u.is_empty() && u != HOME_URL {
                    s.push_closed(&win_label, u);
                }
            }
            s.order.retain(|x| *x != cid);
            s.urls.remove(&cid);
            s.titles.remove(&cid);
            s.window_of.remove(&cid);
            s.pending_urls.remove(&cid);
        }
        if let Some(view) = window.get_webview(&view_label(cid)) {
            let _ = view.close();
        }
    }
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.set_active_in(&win_label, Some(id));
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(())
}

/// 指定タブの右側にあるタブを全て閉じる。
#[tauri::command]
async fn tab_close_right(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    let to_close: Vec<u64> = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let order = s.order_in(&win_label);
        match order.iter().position(|x| *x == id) {
            Some(pos) => order[pos + 1..].to_vec(),
            None => Vec::new(),
        }
    };
    for cid in to_close {
        {
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(u) = s.urls.get(&cid).cloned() {
                if !u.is_empty() && u != HOME_URL {
                    s.push_closed(&win_label, u);
                }
            }
            s.order.retain(|x| *x != cid);
            s.urls.remove(&cid);
            s.titles.remove(&cid);
            s.window_of.remove(&cid);
            s.pending_urls.remove(&cid);
            if s.active_in(&win_label) == Some(cid) {
                s.set_active_in(&win_label, Some(id));
            }
        }
        if let Some(view) = window.get_webview(&view_label(cid)) {
            let _ = view.close();
        }
    }
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
        emit_tabs(&app, &s);
    }
    Ok(())
}

/// タブを並び替える（id を to_index の位置へ移動）。
#[tauri::command]
fn tab_reorder(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    to_index: usize,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    // 同じウィンドウ内での並び替えだけを許可。
    if s.window_of.get(&id).map(|w| w.as_str()) != Some(win_label.as_str()) {
        return Err(format!("tab id {id} not in this window"));
    }
    let order_in = s.order_in(&win_label);
    let local_from = match order_in.iter().position(|x| *x == id) {
        Some(p) => p,
        None => return Err(format!("unknown tab id: {id}")),
    };
    let local_to = to_index.min(order_in.len().saturating_sub(1));
    if local_from == local_to {
        return Ok(());
    }
    // グローバル order 上での実位置を反映させる。
    // 計算: local_to 番目の要素の手前に id を挿し込む。
    s.order.retain(|x| *x != id);
    let target_global = if local_to >= order_in.len() - 1 {
        // 末尾へ: 同ウィンドウの最後の要素の次
        let last_id = order_in.iter().rev().find(|i| **i != id).copied();
        match last_id {
            Some(li) => s
                .order
                .iter()
                .position(|x| *x == li)
                .map(|p| p + 1)
                .unwrap_or(s.order.len()),
            None => s.order.len(),
        }
    } else {
        // local_to 番目のタブ id のグローバル位置の手前
        let after = order_in.iter().filter(|i| **i != id).nth(local_to).copied();
        match after {
            Some(a) => s
                .order
                .iter()
                .position(|x| *x == a)
                .unwrap_or(s.order.len()),
            None => s.order.len(),
        }
    };
    s.order.insert(target_global, id);
    emit_tabs(&app, &s);
    Ok(())
}

/// アクティブタブの view を URL 遷移させる。
#[tauri::command]
fn browser_navigate(window: Window, state: State<'_, AppState>, url: String) -> Result<(), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let id = s
        .active_in(&window.label())
        .ok_or_else(|| "no active tab".to_string())?;
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    view.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn browser_history(
    window: Window,
    state: State<'_, AppState>,
    action: String,
) -> Result<(), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let id = s
        .active_in(&window.label())
        .ok_or_else(|| "no active tab".to_string())?;
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        // Chromium ベースの WebView2 では `location.reload(true)` (deprecated forceReload)
        // がキャッシュをバイパスして再取得する。可能ならキャッシュも消しておく。
        "hard_reload" => {
            "(async()=>{try{if('caches' in self){const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));}}catch(e){}try{location.reload(true);}catch(e){location.reload();}})()"
        }
        other => return Err(format!("unknown action: {other}")),
    };
    view.eval(script).map_err(|e| e.to_string())?;
    Ok(())
}

/// 任意の JS を指定タブで実行 (ユーザースクリプト用)。
#[tauri::command]
fn tab_eval_script(window: Window, id: u64, script: String) -> Result<(), String> {
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| format!("view {id} not found"))?;
    view.eval(&script).map_err(|e| e.to_string())?;
    Ok(())
}

/// view 内 JS から呼ばれる。webview ラベルから tab id を逆引きして UI に通知。
#[tauri::command]
fn browser_url_changed(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view label: {label}"))?;
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.urls.insert(id, url.clone());
        // 新しいページに遷移したので audible / favicon をリセット。
        s.audibles.insert(id, false);
        s.favicons.remove(&id);
        emit_tabs(&app, &s);
    }
    let win_label = webview.window().label().to_string();
    app.emit_to(
        chrome_label_for(&win_label),
        "view-navigated",
        serde_json::json!({ "id": id, "url": url }),
    )
    .map_err(|e| e.to_string())?;
    // 履歴に記録
    record_history_visit(&app, id, &url);
    Ok(())
}

/// view 内 JS からタイトル変化を受け取り、active ならウィンドウタイトルを更新。
#[tauri::command]
fn browser_title_changed(
    webview: Webview,
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view label: {label}"))?;
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.titles.insert(id, title.clone());
    let win_label = window.label().to_string();
    if s.active_in(&win_label) == Some(id) {
        apply_active_title(&window, &s);
    }
    emit_tabs(&app, &s);
    drop(s);
    update_history_title(&app, id, &title);
    Ok(())
}

/// view 内 JS から「音が鳴っているか」の状態を受け取る。
#[tauri::command]
fn browser_audible_changed(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    audible: bool,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view label: {label}"))?;
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let prev = s.audibles.get(&id).copied().unwrap_or(false);
    if prev == audible {
        return Ok(());
    }
    s.audibles.insert(id, audible);
    emit_tabs(&app, &s);
    Ok(())
}

/// view 内 JS から favicon URL を受け取る。
#[tauri::command]
fn browser_favicon_changed(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view label: {label}"))?;
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let prev = s.favicons.get(&id).cloned().unwrap_or_default();
    if prev == url {
        return Ok(());
    }
    s.favicons.insert(id, url.clone());
    emit_tabs(&app, &s);
    drop(s);
    update_history_favicon(&app, id, &url);
    Ok(())
}

// ===== 音量 =====

#[tauri::command]
fn tab_get_volume(webview: Webview, state: State<'_, AppState>) -> Result<f64, String> {
    let label = webview.label().to_string();
    // UI からは同ウィンドウの active タブを対象に、view からは自身の id を対象にする。
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let win_label = webview.window().label().to_string();
    let id = parse_view_id(&label)
        .or_else(|| s.active_in(&win_label))
        .ok_or_else(|| "no tab".to_string())?;
    Ok(s.volumes.get(&id).copied().unwrap_or(1.0))
}

#[tauri::command]
fn tab_set_volume(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    volume: f64,
) -> Result<(), String> {
    let v = volume.clamp(0.0, 1.0);
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.volumes.insert(id, v);
    }
    if let Some(view) = window.get_webview(&view_label(id)) {
        let muted = v <= 0.0001;
        let _ = view.eval(&format!(
            "window.__yuzuMuted={};window.__yuzuApplyVolume&&window.__yuzuApplyVolume();",
            if muted { "true" } else { "false" }
        ));
        // ネイティブ WebView2 ミュートも併用（YouTube の WebAudio 経路を確実に止める）
        set_view_native_muted(&view, muted);
    }
    let _ = app.emit_to(
        chrome_label_for(&window.label()),
        "tab-volume-changed",
        serde_json::json!({ "id": id, "volume": v }),
    );
    // タブ一覧も更新（muted フラグをタブ UI に反映）。
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        emit_tabs(&app, &s);
    }
    Ok(())
}

// ===== ズーム =====

fn apply_zoom_to(window: &Window, id: u64, zoom: f64) {
    if let Some(view) = window.get_webview(&view_label(id)) {
        let _ = view.eval(&format!(
            "document.documentElement.style.zoom='{:.4}';",
            zoom
        ));
    }
}

#[tauri::command]
fn tab_get_zoom(webview: Webview, state: State<'_, AppState>) -> Result<f64, String> {
    let label = webview.label().to_string();
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let win_label = webview.window().label().to_string();
    let id = parse_view_id(&label)
        .or_else(|| s.active_in(&win_label))
        .ok_or_else(|| "no tab".to_string())?;
    Ok(s.zooms.get(&id).copied().unwrap_or(1.0))
}

#[tauri::command]
fn browser_zoom_delta(
    webview: Webview,
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    delta: f64,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view: {label}"))?;
    let new_zoom = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let cur = s.zooms.get(&id).copied().unwrap_or(1.0);
        let z = ((cur + delta) * 100.0).round() / 100.0;
        let z = z.clamp(0.25, 5.0);
        s.zooms.insert(id, z);
        z
    };
    apply_zoom_to(&window, id, new_zoom);
    let _ = app.emit_to(
        chrome_label_for(&window.label()),
        "tab-zoom-changed",
        serde_json::json!({ "id": id, "zoom": new_zoom }),
    );
    Ok(())
}

#[tauri::command]
fn browser_zoom_set(
    webview: Webview,
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    zoom: f64,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = parse_view_id(&label).ok_or_else(|| format!("not a view: {label}"))?;
    let z = zoom.clamp(0.25, 5.0);
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.zooms.insert(id, z);
    }
    apply_zoom_to(&window, id, z);
    let _ = app.emit_to(
        chrome_label_for(&window.label()),
        "tab-zoom-changed",
        serde_json::json!({ "id": id, "zoom": z }),
    );
    Ok(())
}

/// UI 側のショートカット用：active タブのズームを設定/相対変化させる。
#[tauri::command]
fn active_tab_zoom_delta(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    delta: f64,
) -> Result<(), String> {
    let win_label = window.label().to_string();
    let id_and_new = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let id = s
            .active_in(&win_label)
            .ok_or_else(|| "no active tab".to_string())?;
        let cur = s.zooms.get(&id).copied().unwrap_or(1.0);
        let z = ((cur + delta) * 100.0).round() / 100.0;
        let z = z.clamp(0.25, 5.0);
        s.zooms.insert(id, z);
        (id, z)
    };
    apply_zoom_to(&window, id_and_new.0, id_and_new.1);
    let _ = app.emit_to(
        chrome_label_for(&window.label()),
        "tab-zoom-changed",
        serde_json::json!({ "id": id_and_new.0, "zoom": id_and_new.1 }),
    );
    Ok(())
}

#[tauri::command]
fn active_tab_zoom_set(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    zoom: f64,
) -> Result<(), String> {
    let z = zoom.clamp(0.25, 5.0);
    let win_label = window.label().to_string();
    let id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let id = s
            .active_in(&win_label)
            .ok_or_else(|| "no active tab".to_string())?;
        s.zooms.insert(id, z);
        id
    };
    apply_zoom_to(&window, id, z);
    let _ = app.emit_to(
        chrome_label_for(&window.label()),
        "tab-zoom-changed",
        serde_json::json!({ "id": id, "zoom": z }),
    );
    Ok(())
}

/// タブの右クリックで呼ばれる。ネイティブのコンテキストメニューを表示し、
/// 選択結果は menu event ハンドラ経由で `tab-menu-action` イベントとして発行される。
#[tauri::command]
fn show_tab_context_menu(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let (has_others, has_right) = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let win_label = window.label().to_string();
        let order = s.order_in(&win_label);
        let len = order.len();
        let pos = order.iter().position(|&x| x == id);
        let has_right = pos.map(|p| p + 1 < len).unwrap_or(false);
        (len > 1, has_right)
    };

    let mk = |action: &str| format!("yuzu-tabmenu:{action}:{id}");

    let new_tab = MenuItemBuilder::with_id(mk("new"), "新規タブ")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let dup = MenuItemBuilder::with_id(mk("duplicate"), "タブを複製")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let reload = MenuItemBuilder::with_id(mk("reload"), "ページを再読み込み")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let reopen = MenuItemBuilder::with_id(mk("reopen"), "閉じたタブを復元")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let close_right = MenuItemBuilder::with_id(mk("close_right"), "右側のタブを全て閉じる")
        .enabled(has_right)
        .build(&app)
        .map_err(|e| e.to_string())?;
    let close_others = MenuItemBuilder::with_id(mk("close_others"), "他のタブを全て閉じる")
        .enabled(has_others)
        .build(&app)
        .map_err(|e| e.to_string())?;
    let close = MenuItemBuilder::with_id(mk("close"), "タブを閉じる")
        .build(&app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(&app)
        .items(&[
            &new_tab,
            &dup,
            &reload,
            &reopen,
            &sep,
            &close_right,
            &close_others,
            &close,
        ])
        .build()
        .map_err(|e| e.to_string())?;

    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// アクティブページの見た目をキャプチャして base64 PNG で返す。
#[derive(serde::Serialize)]
struct CaptureResult {
    data_url: String,
    title_bar_height: f64,
    logical_width: f64,
    logical_height: f64,
}
#[tauri::command]
fn capture_active_page(window: Window) -> Result<CaptureResult, String> {
    use base64::Engine;
    let scale = window.scale_factor().unwrap_or(1.0);
    let outer = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let inner = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let title_bar_height = (outer.height - inner.height).max(0.0);

    // xcap でウィンドウを特定: 自プロセスの PID と一致し、最大の窓を選ぶ。
    let my_pid = std::process::id();
    let xcap_wins = xcap::Window::all().map_err(|e| e.to_string())?;
    let mut candidates: Vec<xcap::Window> = xcap_wins
        .into_iter()
        .filter(|w| w.process_id() == my_pid && !w.is_minimized())
        .collect();
    // 面積が最大のものを採用（メインウィンドウ）
    candidates.sort_by_key(|w| -((w.width() as i64) * (w.height() as i64)));
    let xcap_win = candidates
        .into_iter()
        .next()
        .ok_or_else(|| format!("xcap window not found for pid={}", my_pid))?;
    let img = xcap_win.capture_image().map_err(|e| e.to_string())?;
    let logical_width = img.width() as f64 / scale;
    let logical_height = img.height() as f64 / scale;
    // PNG エンコード
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        PngEncoder::new(&mut png_bytes)
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ColorType::Rgba8.into(),
            )
            .map_err(|e| e.to_string())?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(CaptureResult {
        data_url: format!("data:image/png;base64,{}", b64),
        title_bar_height,
        logical_width,
        logical_height,
    })
}

/// UI webview をウィンドウ全面に広げる/通常サイズに戻す。
/// ブックマーク一覧などのオーバーレイ UI を表示するときに使う。
#[tauri::command]
fn ui_set_expanded(
    window: Window,
    state: State<'_, AppState>,
    expanded: bool,
) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let w = size.width.max(1.0);
    let h = size.height.max(1.0);
    let win_label = window.label().to_string();
    let chrome = chrome_label_for(&win_label);
    if expanded {
        if let Some(ui) = window.get_webview(&chrome) {
            let _ = ui.set_size(LogicalSize::new(w, h));
        }
        // active view も画面外に退避（クリックを UI 側だけで受け取る）。
        let s = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(active_id) = s.active_in(&win_label) {
            if let Some(view) = window.get_webview(&view_label(active_id)) {
                let _ = view.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
                let _ = view.set_size(LogicalSize::new(1.0, 1.0));
            }
        }
    } else {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
    }
    Ok(())
}

/// ダウンロード等のオーバーレイ表示中に、UI webview を上部帯の高さまで広げる。
/// active view はその下へ押し下げ、オーバーレイ領域と重ならないようにする。
#[tauri::command]
fn ui_set_popup_region(
    window: Window,
    _state: State<'_, AppState>,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let win_w = win_size.width.max(1.0);
    let win_h = win_size.height.max(1.0);
    // UIを全画面に展開するが、ページ WebView は動かさない。
    // UI WebView は transparent:true なので、クローム・パネル以外は透明になりページが透ける。
    if let Some(ui) = window.get_webview(&chrome_label_for(&window.label())) {
        let _ = ui.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = ui.set_size(LogicalSize::new(win_w, win_h));
    }
    Ok(())
}

/// ダウンロードトースト webview を右下の指定サイズで表示する。
/// 呼び出した webview のウィンドウに対して効く。
#[tauri::command]
fn toast_set_size(
    window: Window,
    webview: Webview,
    state: State<'_, AppState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let win_label = webview.window().label().to_string();
    // 念のため呼び出し元が toast webview であることを確認 (なくても動く)
    let _ = window;
    let scale = webview.window().scale_factor().unwrap_or(1.0);
    let size = webview
        .window()
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let win_w = size.width.max(1.0);
    let win_h = size.height.max(1.0);
    let tw = width.max(1.0).min(win_w);
    let th = height.max(1.0).min(win_h);
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.toast_sizes.insert(win_label.clone(), (tw, th));
    }
    if let Some(tv) = webview.window().get_webview(&toast_label_for(&win_label)) {
        let x = (win_w - tw).max(0.0);
        let y = (win_h - th).max(0.0);
        let _ = tv.set_size(LogicalSize::new(tw, th));
        let _ = tv.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

/// ダウンロードトースト webview をオフスクリーンに退避し、見えなくする。
#[tauri::command]
fn toast_hide(webview: Webview, state: State<'_, AppState>) -> Result<(), String> {
    let win_label = webview.window().label().to_string();
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.toast_sizes.remove(&win_label);
    }
    if let Some(tv) = webview.window().get_webview(&toast_label_for(&win_label)) {
        let _ = tv.set_size(LogicalSize::new(1.0, 1.0));
        let _ = tv.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
    }
    Ok(())
}

/// 動画フルスクリーン時にツールバー/タブバーを退避させ、active view をウィンドウ全面に広げる。
/// 解除時は通常レイアウトに戻す。
#[tauri::command]
fn view_set_fullscreen(
    window: Window,
    webview: Webview,
    state: State<'_, AppState>,
    fullscreen: bool,
) -> Result<(), String> {
    // 呼び出し元 view が active タブの場合だけ動かす（バックグラウンドタブからの誤動作防止）。
    let label = webview.label().to_string();
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let win_label = window.label().to_string();
    let active = match s.active_in(&win_label) {
        Some(id) => id,
        None => return Ok(()),
    };
    if label != view_label(active) {
        return Ok(());
    }
    drop(s);

    if fullscreen {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let w = size.width.max(1.0);
        let h = size.height.max(1.0);
        if let Some(ui) = window.get_webview(&chrome_label_for(&win_label)) {
            let _ = ui.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
            let _ = ui.set_size(LogicalSize::new(1.0, 1.0));
        }
        if let Some(view) = window.get_webview(&view_label(active)) {
            let _ = view.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = view.set_size(LogicalSize::new(w, h));
        }
    } else {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
    }
    Ok(())
}

/// アクティブタブの動画/音声要素に Web Audio API の GainNode を挟んで
/// 音量を 100% を超えてブーストする。`gain` は 1.0 == 100%。
/// ページ遷移/リロード時にはリセットされる (再適用が必要)。
#[tauri::command]
fn view_set_volume_boost(
    window: Window,
    state: State<'_, AppState>,
    gain: f64,
) -> Result<(), String> {
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active_in(&window.label())
            .ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    // 安全のため 0.0 - 16.0 にクランプ
    let g = if gain.is_finite() {
        gain.clamp(0.0, 16.0)
    } else {
        1.0
    };
    // gain が事実上 0 ならネイティブ WebView2 ミュートで完全消音、
    // それ以外はネイティブミュートを解除（タブ側の muted=true がない限り）。
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let tab_muted = s.volumes.get(&id).copied().unwrap_or(1.0) <= 0.0001;
        let want_muted = g <= 0.0001 || tab_muted;
        set_view_native_muted(&view, want_muted);
    }
    let script = format!(
        r#"(function() {{
  try {{
    var GAIN = {gain};
    var ctx = window.__yuzuAudioCtx;
    if (!ctx) {{
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      window.__yuzuAudioCtx = ctx;
      window.__yuzuGainNodes = new WeakMap();
    }}
    if (ctx.state === 'suspended') {{ try {{ ctx.resume(); }} catch (e) {{}} }}
    function attach(el) {{
      if (!el) return;
      var node = window.__yuzuGainNodes.get(el);
      if (!node) {{
        try {{
          var src = ctx.createMediaElementSource(el);
          var gainNode = ctx.createGain();
          src.connect(gainNode);
          gainNode.connect(ctx.destination);
          node = gainNode;
          window.__yuzuGainNodes.set(el, gainNode);
        }} catch (e) {{ return; }}
      }}
      node.gain.value = window.__yuzuMuted ? 0 : GAIN;
    }}
    var media = document.querySelectorAll('video, audio');
    for (var i = 0; i < media.length; i++) attach(media[i]);
    if (!window.__yuzuMediaObserver) {{
      var obs = new MutationObserver(function(muts) {{
        for (var i = 0; i < muts.length; i++) {{
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {{
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') attach(n);
            else if (n.querySelectorAll) {{
              var inner = n.querySelectorAll('video, audio');
              for (var k = 0; k < inner.length; k++) attach(inner[k]);
            }}
          }}
        }}
      }});
      obs.observe(document.documentElement || document.body, {{ subtree: true, childList: true }});
      window.__yuzuMediaObserver = obs;
    }}
    window.__yuzuCurrentGain = GAIN;
  }} catch (e) {{ console.error('volume boost failed:', e); }}
}})();"#,
        gain = g
    );
    view.eval(&script).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== ブックマーク =====
//
// シンプルな URL ブックマーク機能。`app_data_dir/bookmarks.json` に永続化し、
// フロントエンドから一覧取得 / 追加 / 削除 / 並べ替えを行う。

#[derive(Serialize, Deserialize, Clone)]
struct Bookmark {
    id: u64,
    url: String,
    title: String,
    #[serde(default)]
    favicon: String,
    #[serde(default)]
    added_at: i64,
}

#[derive(Default)]
struct BookmarkStoreInner {
    items: Vec<Bookmark>,
    next_id: u64,
    path: Option<PathBuf>,
}

impl BookmarkStoreInner {
    fn load(path: PathBuf) -> Self {
        let mut store = BookmarkStoreInner {
            items: Vec::new(),
            next_id: 1,
            path: Some(path.clone()),
        };
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(items) = serde_json::from_str::<Vec<Bookmark>>(&text) {
                let max_id = items.iter().map(|b| b.id).max().unwrap_or(0);
                store.items = items;
                store.next_id = max_id + 1;
            }
        }
        store
    }
    fn save(&self) -> Result<(), String> {
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let json = serde_json::to_string_pretty(&self.items).map_err(|e| e.to_string())?;
            std::fs::write(path, json).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct BookmarkStore(Mutex<BookmarkStoreInner>);

fn emit_bookmarks(app: &AppHandle, items: &[Bookmark]) {
    // 全 chrome ウィンドウへ配信。フロントは受信したら再描画する。
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(s) = state.0.lock() {
            for win in s.windows() {
                let _ = app.emit_to(chrome_label_for(&win), "bookmarks-updated", items);
            }
            return;
        }
    }
    let _ = app.emit_to("ui", "bookmarks-updated", items);
}

#[tauri::command]
fn bookmarks_list(state: State<'_, BookmarkStore>) -> Result<Vec<Bookmark>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.items.clone())
}

#[tauri::command]
fn bookmarks_add(
    app: AppHandle,
    state: State<'_, BookmarkStore>,
    url: String,
    title: String,
    favicon: Option<String>,
) -> Result<Bookmark, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("url is empty".to_string());
    }
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    // 同一 URL が既にあれば、その項目を返す（重複追加を抑止）。
    if let Some(existing) = s.items.iter().find(|b| b.url == url).cloned() {
        return Ok(existing);
    }
    let id = s.next_id;
    s.next_id += 1;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let bm = Bookmark {
        id,
        url,
        title: if title.trim().is_empty() {
            "(無題)".to_string()
        } else {
            title
        },
        favicon: favicon.unwrap_or_default(),
        added_at: now,
    };
    s.items.push(bm.clone());
    let _ = s.save();
    let items = s.items.clone();
    drop(s);
    emit_bookmarks(&app, &items);
    Ok(bm)
}

#[tauri::command]
fn bookmarks_remove(
    app: AppHandle,
    state: State<'_, BookmarkStore>,
    id: u64,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let before = s.items.len();
    s.items.retain(|b| b.id != id);
    if s.items.len() == before {
        return Ok(());
    }
    let _ = s.save();
    let items = s.items.clone();
    drop(s);
    emit_bookmarks(&app, &items);
    Ok(())
}

#[tauri::command]
fn bookmarks_remove_url(
    app: AppHandle,
    state: State<'_, BookmarkStore>,
    url: String,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let before = s.items.len();
    s.items.retain(|b| b.url != url);
    if s.items.len() == before {
        return Ok(());
    }
    let _ = s.save();
    let items = s.items.clone();
    drop(s);
    emit_bookmarks(&app, &items);
    Ok(())
}

#[tauri::command]
fn bookmarks_reorder(
    app: AppHandle,
    state: State<'_, BookmarkStore>,
    id: u64,
    to_index: usize,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let from = match s.items.iter().position(|b| b.id == id) {
        Some(i) => i,
        None => return Ok(()),
    };
    let item = s.items.remove(from);
    let dest = to_index.min(s.items.len());
    s.items.insert(dest, item);
    let _ = s.save();
    let items = s.items.clone();
    drop(s);
    emit_bookmarks(&app, &items);
    Ok(())
}

#[tauri::command]
fn bookmarks_update(
    app: AppHandle,
    state: State<'_, BookmarkStore>,
    id: u64,
    title: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let Some(item) = s.items.iter_mut().find(|b| b.id == id) else {
        return Ok(());
    };
    if let Some(t) = title {
        item.title = if t.trim().is_empty() {
            item.title.clone()
        } else {
            t
        };
    }
    if let Some(u) = url {
        let u = u.trim();
        if !u.is_empty() {
            item.url = u.to_string();
        }
    }
    let _ = s.save();
    let items = s.items.clone();
    drop(s);
    emit_bookmarks(&app, &items);
    Ok(())
}

// ===== 閲覧履歴 =====
//
// シンプルな閲覧履歴。`app_data_dir/history.json` に永続化し、
// 上限 5000 件、新しい順に保持する。同一 URL を 60 秒以内に再訪問した
// 場合は新規エントリを増やさず、最後のエントリを更新する。

#[derive(Serialize, Deserialize, Clone)]
struct HistoryEntry {
    id: u64,
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    favicon: String,
    /// 最終訪問時刻 (UNIX 秒)
    visited_at: i64,
    #[serde(default = "default_visit_count")]
    visit_count: u32,
}

fn default_visit_count() -> u32 {
    1
}

#[derive(Default)]
struct HistoryStoreInner {
    items: Vec<HistoryEntry>,
    next_id: u64,
    path: Option<PathBuf>,
    /// 最後に追加した entry の id (タイトル更新用)。tab_id 単位で保持。
    last_per_tab: std::collections::HashMap<u64, u64>,
}

const HISTORY_MAX_ITEMS: usize = 5000;

impl HistoryStoreInner {
    fn load(path: PathBuf) -> Self {
        let mut store = HistoryStoreInner {
            items: Vec::new(),
            next_id: 1,
            path: Some(path.clone()),
            last_per_tab: std::collections::HashMap::new(),
        };
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(items) = serde_json::from_str::<Vec<HistoryEntry>>(&text) {
                let max_id = items.iter().map(|b| b.id).max().unwrap_or(0);
                store.items = items;
                store.next_id = max_id + 1;
            }
        }
        store
    }
    fn save(&self) {
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string(&self.items) {
                let _ = std::fs::write(path, json);
            }
        }
    }
    fn trim(&mut self) {
        if self.items.len() > HISTORY_MAX_ITEMS {
            let drop_n = self.items.len() - HISTORY_MAX_ITEMS;
            // 古い順に並んでいる前提で先頭を切る
            self.items.drain(0..drop_n);
        }
    }
}

#[derive(Default)]
struct HistoryStore(Mutex<HistoryStoreInner>);

fn is_recordable_history_url(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() {
        return false;
    }
    if u.starts_with("about:") {
        return false;
    }
    if u.starts_with("data:") {
        return false;
    }
    if u.starts_with("blob:") {
        return false;
    }
    if u.starts_with("javascript:") {
        return false;
    }
    if u.starts_with("chrome-error://") {
        return false;
    }
    true
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// ページ遷移時に呼ばれる。重複抑止 + ファイル保存。
fn record_history_visit(app: &AppHandle, tab_id: u64, url: &str) {
    if !is_recordable_history_url(url) {
        return;
    }
    let Some(state) = app.try_state::<HistoryStore>() else {
        return;
    };
    let Ok(mut s) = state.0.lock() else {
        return;
    };
    let now = now_secs();
    // 直近 60 秒以内に同じ URL を最後に記録していたら、その entry の visited_at を更新するだけ。
    let recent_id = s
        .items
        .last()
        .filter(|last| last.url == url && (now - last.visited_at).abs() < 60)
        .map(|last| last.id);
    if let Some(rid) = recent_id {
        if let Some(last) = s.items.last_mut() {
            last.visited_at = now;
            last.visit_count = last.visit_count.saturating_add(1);
        }
        s.last_per_tab.insert(tab_id, rid);
        s.save();
        return;
    }
    let id = s.next_id;
    s.next_id += 1;
    s.items.push(HistoryEntry {
        id,
        url: url.to_string(),
        title: String::new(),
        favicon: String::new(),
        visited_at: now,
        visit_count: 1,
    });
    s.last_per_tab.insert(tab_id, id);
    s.trim();
    s.save();
}

/// タイトル変化時に呼ばれる。tab_id の直近 entry のタイトルを更新する。
fn update_history_title(app: &AppHandle, tab_id: u64, title: &str) {
    let t = title.trim();
    if t.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<HistoryStore>() else {
        return;
    };
    let Ok(mut s) = state.0.lock() else {
        return;
    };
    let Some(eid) = s.last_per_tab.get(&tab_id).copied() else {
        return;
    };
    let mut changed = false;
    if let Some(it) = s.items.iter_mut().find(|i| i.id == eid) {
        if it.title != t {
            it.title = t.to_string();
            changed = true;
        }
    }
    if changed {
        s.save();
    }
}

fn update_history_favicon(app: &AppHandle, tab_id: u64, favicon: &str) {
    if favicon.trim().is_empty() {
        return;
    }
    let Some(state) = app.try_state::<HistoryStore>() else {
        return;
    };
    let Ok(mut s) = state.0.lock() else {
        return;
    };
    let Some(eid) = s.last_per_tab.get(&tab_id).copied() else {
        return;
    };
    let mut changed = false;
    if let Some(it) = s.items.iter_mut().find(|i| i.id == eid) {
        if it.favicon != favicon {
            it.favicon = favicon.to_string();
            changed = true;
        }
    }
    if changed {
        s.save();
    }
}

#[tauri::command]
fn history_list(
    state: State<'_, HistoryStore>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(500).min(HISTORY_MAX_ITEMS);
    // 新しい順
    let mut v: Vec<HistoryEntry> = s.items.iter().rev().take(lim).cloned().collect();
    // フロントには新しい順で渡す
    v.shrink_to_fit();
    Ok(v)
}

#[tauri::command]
fn history_search(
    state: State<'_, HistoryStore>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let q = query.trim().to_lowercase();
    let lim = limit.unwrap_or(200).min(HISTORY_MAX_ITEMS);
    if q.is_empty() {
        let v: Vec<HistoryEntry> = s.items.iter().rev().take(lim).cloned().collect();
        return Ok(v);
    }
    let v: Vec<HistoryEntry> = s
        .items
        .iter()
        .rev()
        .filter(|it| it.url.to_lowercase().contains(&q) || it.title.to_lowercase().contains(&q))
        .take(lim)
        .cloned()
        .collect();
    Ok(v)
}

#[tauri::command]
fn history_delete(state: State<'_, HistoryStore>, id: u64) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let before = s.items.len();
    s.items.retain(|i| i.id != id);
    if s.items.len() != before {
        s.save();
    }
    Ok(())
}

#[tauri::command]
fn history_clear(state: State<'_, HistoryStore>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.items.clear();
    s.last_per_tab.clear();
    s.save();
    Ok(())
}

// ===== ツールボックス =====
//
// 拡張可能な「ツールボックス」UI 用のコマンド群。第 1 弾として yt-dlp を
// 使った動画ダウンロード機能を実装。yt-dlp 本体はユーザーが PATH か
// 設定で指定したパスから探す。設定は app_data_dir/toolbox.json に永続化。

#[derive(Serialize, Deserialize, Clone, Default)]
struct ToolboxSettings {
    /// ダウンロード保存先ディレクトリ。空ならユーザーの Downloads。
    #[serde(default)]
    download_dir: String,
}

impl ToolboxSettings {
    fn load(path: &PathBuf) -> Self {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(s) = serde_json::from_str::<ToolboxSettings>(&text) {
                return s;
            }
        }
        ToolboxSettings::default()
    }
    fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct ToolboxStateInner {
    settings: ToolboxSettings,
    path: Option<PathBuf>,
    /// 実行中の yt-dlp ジョブ id -> 子プロセス。Cancel 用。
    jobs: HashMap<u64, std::sync::Arc<Mutex<Option<std::process::Child>>>>,
    next_job_id: u64,
}

#[derive(Default)]
struct ToolboxState(Mutex<ToolboxStateInner>);

fn default_download_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("USERPROFILE") {
        let d = PathBuf::from(p).join("Downloads");
        if d.is_dir() {
            return Some(d);
        }
    }
    dirs_download()
}

#[cfg(target_os = "windows")]
fn dirs_download() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|p| PathBuf::from(p).join("Downloads"))
}
#[cfg(not(target_os = "windows"))]
fn dirs_download() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|p| PathBuf::from(p).join("Downloads"))
}

/// 同梱用 yt-dlp 実行ファイルの保存先 (app_data_dir/bin/yt-dlp.exe)。
fn managed_ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 取得失敗: {}", e))?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let name = "yt-dlp.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "yt-dlp";
    Ok(dir.join(name))
}

/// yt-dlp が無ければ GitHub から最新リリースをダウンロードする。
fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let path = managed_ytdlp_path(app)?;
    if path.exists() {
        return Ok(path);
    }
    #[cfg(target_os = "windows")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    #[cfg(target_os = "macos")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    #[cfg(all(unix, not(target_os = "macos")))]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

    let _ = app.emit_to(
        "ui",
        "toolbox-ytdlp-progress",
        YtdlpProgress {
            job_id: 0,
            line: format!("yt-dlp を初回ダウンロード中… ({})", url),
            kind: "info".to_string(),
        },
    );

    let resp = ureq::get(url)
        .call()
        .map_err(|e| format!("yt-dlp ダウンロード失敗: {}", e))?;
    let tmp = path.with_extension("download");
    {
        let mut file =
            std::fs::File::create(&tmp).map_err(|e| format!("一時ファイル作成失敗: {}", e))?;
        let mut reader = resp.into_reader();
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("yt-dlp 書き込み失敗: {}", e))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("yt-dlp 配置失敗: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    let _ = app.emit_to(
        "ui",
        "toolbox-ytdlp-progress",
        YtdlpProgress {
            job_id: 0,
            line: format!("yt-dlp を保存しました: {}", path.display()),
            kind: "info".to_string(),
        },
    );
    Ok(path)
}

#[tauri::command]
fn toolbox_settings_get(state: State<'_, ToolboxState>) -> Result<ToolboxSettings, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.settings.clone())
}

#[tauri::command]
fn toolbox_settings_set(
    state: State<'_, ToolboxState>,
    settings: ToolboxSettings,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.settings = settings;
    if let Some(p) = s.path.clone() {
        s.settings.save(&p)?;
    }
    Ok(())
}

#[tauri::command]
fn toolbox_default_download_dir() -> Result<String, String> {
    Ok(default_download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[tauri::command]
async fn toolbox_pick_download_dir(initial: Option<String>) -> Result<Option<String>, String> {
    let mut dlg = rfd::AsyncFileDialog::new().set_title("ダウンロード先フォルダを選択");
    if let Some(p) = initial.filter(|s| !s.is_empty()) {
        dlg = dlg.set_directory(p);
    }
    let chosen = dlg.pick_folder().await;
    Ok(chosen.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command]
fn toolbox_open_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct YtdlpProgress {
    job_id: u64,
    line: String,
    kind: String, // "stdout" | "stderr" | "info"
}

#[derive(Serialize, Clone)]
struct YtdlpDone {
    job_id: u64,
    success: bool,
    code: Option<i32>,
}

#[derive(Deserialize)]
struct YtdlpRunArgs {
    url: String,
    /// "video" | "audio"
    #[serde(default)]
    mode: String,
    /// 例: "best", "1080", "720", "480"
    #[serde(default)]
    quality: String,
}

/// `&list=...&index=...` のような再生リスト系クエリを取り除き、単一動画として扱える URL に
/// 整形する。`--no-playlist` だけでは消えないケース (watch?v=X&list=Y) があるため明示的に削る。
fn normalize_ytdlp_url(input: &str) -> String {
    let trimmed = input.trim();
    let parsed = match url::Url::parse(trimmed) {
        Ok(u) => u,
        Err(_) => return trimmed.to_string(),
    };
    // YouTube ホスト以外はそのまま返す
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let is_youtube = host.ends_with("youtube.com")
        || host.ends_with("youtube-nocookie.com")
        || host == "youtu.be"
        || host.ends_with(".youtu.be");
    if !is_youtube {
        return trimmed.to_string();
    }
    let mut out = parsed.clone();
    let drop = ["list", "index", "start_radio", "pp", "feature"];
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| !drop.iter().any(|d| k.eq_ignore_ascii_case(d)))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut q = out.query_pairs_mut();
        q.clear();
        for (k, v) in &kept {
            q.append_pair(k, v);
        }
    }
    if kept.is_empty() {
        out.set_query(None);
    }
    out.to_string()
}

#[tauri::command]
fn toolbox_ytdlp_run(
    app: AppHandle,
    state: State<'_, ToolboxState>,
    args: YtdlpRunArgs,
) -> Result<u64, String> {
    if args.url.trim().is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let download_dir = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.settings.download_dir.clone()
    };
    if download_dir.is_empty() {
        return Err("ダウンロード先が未設定です".to_string());
    }
    let ytdlp_pathbuf = ensure_ytdlp(&app)?;
    let exe = ytdlp_pathbuf.to_string_lossy().to_string();

    // YouTube などで `&list=…&index=…` が付いていると yt-dlp が再生リスト全体を
    // ダウンロードしてしまうので、関連するクエリを取り除いた URL を組み立てる。
    let normalized_url = normalize_ytdlp_url(&args.url);

    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--no-colors")
        .arg("--newline")
        .arg("--no-mtime")
        .arg("--no-playlist")
        .arg("-o")
        .arg(format!("{}/%(title)s [%(id)s].%(ext)s", download_dir));

    let mode = args.mode.as_str();
    if mode == "audio" {
        cmd.args(["-x", "--audio-format", "mp3"]);
    } else {
        let q = args.quality.as_str();
        let format = match q {
            "1080" => "bv*[height<=1080]+ba/b[height<=1080]".to_string(),
            "720" => "bv*[height<=720]+ba/b[height<=720]".to_string(),
            "480" => "bv*[height<=480]+ba/b[height<=480]".to_string(),
            _ => "bv*+ba/b".to_string(),
        };
        cmd.args(["-f", &format, "--merge-output-format", "mp4"]);
    }
    cmd.arg(&normalized_url);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("yt-dlp の起動に失敗: {} (実行ファイル: {})", e, exe))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let job_id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_job_id += 1;
        s.next_job_id
    };

    let child_arc = std::sync::Arc::new(Mutex::new(Some(child)));
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.jobs.insert(job_id, child_arc.clone());
    }

    // 起動メッセージ
    let _ = app.emit_to(
        "ui",
        "toolbox-ytdlp-progress",
        YtdlpProgress {
            job_id,
            line: format!("$ {} {}", exe, normalized_url),
            kind: "info".to_string(),
        },
    );

    // stdout 読み取りスレッド
    if let Some(out) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let r = BufReader::new(out);
            for line in r.lines().flatten() {
                let _ = app2.emit_to(
                    "ui",
                    "toolbox-ytdlp-progress",
                    YtdlpProgress {
                        job_id,
                        line,
                        kind: "stdout".to_string(),
                    },
                );
            }
        });
    }
    // stderr 読み取りスレッド
    if let Some(err) = stderr {
        let app2 = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let r = BufReader::new(err);
            for line in r.lines().flatten() {
                let _ = app2.emit_to(
                    "ui",
                    "toolbox-ytdlp-progress",
                    YtdlpProgress {
                        job_id,
                        line,
                        kind: "stderr".to_string(),
                    },
                );
            }
        });
    }
    // wait スレッド
    let app3 = app.clone();
    let child_arc2 = child_arc.clone();
    let state_handle = app.clone();
    std::thread::spawn(move || {
        // wait は &mut self が必要なので一旦取り出す
        let mut taken = {
            let mut g = child_arc2.lock().unwrap();
            g.take()
        };
        let result = if let Some(ref mut c) = taken {
            c.wait()
        } else {
            return;
        };
        let (success, code) = match result {
            Ok(status) => (status.success(), status.code()),
            Err(_) => (false, None),
        };
        let _ = app3.emit_to(
            "ui",
            "toolbox-ytdlp-done",
            YtdlpDone {
                job_id,
                success,
                code,
            },
        );
        // ジョブ表からも削除
        if let Some(state) = state_handle.try_state::<ToolboxState>() {
            if let Ok(mut s) = state.0.lock() {
                s.jobs.remove(&job_id);
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
fn toolbox_ytdlp_cancel(state: State<'_, ToolboxState>, job_id: u64) -> Result<(), String> {
    let arc = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.jobs.get(&job_id).cloned()
    };
    if let Some(arc) = arc {
        if let Ok(mut g) = arc.lock() {
            if let Some(child) = g.as_mut() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

// ===== ファイル形式コンバータ (ffmpeg) =====

/// 同梱用 ffmpeg 実行ファイルの保存先 (app_data_dir/bin/ffmpeg(.exe))。
fn managed_ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 取得失敗: {}", e))?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let name = "ffmpeg.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "ffmpeg";
    Ok(dir.join(name))
}

/// ffmpeg を必要に応じて zip からダウンロード・展開する (Windows 想定)。
fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let path = managed_ffmpeg_path(app)?;
    if path.exists() {
        return Ok(path);
    }
    #[cfg(target_os = "windows")]
    let url =
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
    #[cfg(target_os = "macos")]
    let url = "https://www.osxexperts.net/ffmpeg71arm.zip";
    #[cfg(all(unix, not(target_os = "macos")))]
    let url =
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

    let _ = app.emit_to(
        "ui",
        "toolbox-conv-progress",
        ConvProgress {
            job_id: 0,
            line: format!("ffmpeg を初回ダウンロード中… ({})", url),
            kind: "info".to_string(),
        },
    );

    let parent = path
        .parent()
        .ok_or_else(|| "親ディレクトリ無し".to_string())?;
    let zip_path = parent.join("ffmpeg-download.zip");
    {
        let resp = ureq::get(url)
            .call()
            .map_err(|e| format!("ffmpeg ダウンロード失敗: {}", e))?;
        let mut file =
            std::fs::File::create(&zip_path).map_err(|e| format!("一時ファイル作成失敗: {}", e))?;
        let mut reader = resp.into_reader();
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("ffmpeg 書き込み失敗: {}", e))?;
    }
    let _ = app.emit_to(
        "ui",
        "toolbox-conv-progress",
        ConvProgress {
            job_id: 0,
            line: "アーカイブを展開中…".to_string(),
            kind: "info".to_string(),
        },
    );

    #[cfg(target_os = "windows")]
    {
        let f = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("zip 展開失敗: {}", e))?;
        let mut found = false;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if name.ends_with("/bin/ffmpeg.exe") || name.ends_with("\\bin\\ffmpeg.exe") {
                let mut out = std::fs::File::create(&path)
                    .map_err(|e| format!("ffmpeg.exe 書き込み失敗: {}", e))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("ffmpeg.exe 取り出し失敗: {}", e))?;
                found = true;
                break;
            }
        }
        if !found {
            return Err("zip 内に ffmpeg.exe が見つかりませんでした".to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("このプラットフォームでは ffmpeg を自動取得できません".to_string());
    }

    let _ = std::fs::remove_file(&zip_path);
    let _ = app.emit_to(
        "ui",
        "toolbox-conv-progress",
        ConvProgress {
            job_id: 0,
            line: format!("ffmpeg を保存しました: {}", path.display()),
            kind: "info".to_string(),
        },
    );
    Ok(path)
}

#[derive(Clone, Serialize)]
struct ConvProgress {
    job_id: u64,
    line: String,
    kind: String,
}

#[derive(Clone, Serialize)]
struct ConvDone {
    job_id: u64,
    success: bool,
    code: Option<i32>,
    output_path: Option<String>,
}

#[derive(Deserialize)]
struct ConvertRunArgs {
    input: String,
    /// "png", "jpg", "webp", "gif", "bmp", "tiff", "ico", "avif",
    /// "mp4", "webm", "mkv", "mov", "avi", "gif-anim",
    /// "mp3", "wav", "ogg", "m4a", "flac", "opus"
    format: String,
    #[serde(default)]
    out_dir: String,
}

/// 出力 (拡張子, ffmpeg 引数) を返す。
fn ffmpeg_args_for(format: &str) -> Result<(&'static str, Vec<&'static str>), String> {
    let r: (&str, Vec<&str>) = match format {
        // 画像
        "png" => ("png", vec![]),
        "jpg" => ("jpg", vec!["-q:v", "2"]),
        "webp" => ("webp", vec![]),
        "gif" => ("gif", vec![]),
        "bmp" => ("bmp", vec![]),
        "tiff" => ("tiff", vec![]),
        "ico" => (
            "ico",
            vec!["-vf", "scale=256:256:force_original_aspect_ratio=decrease"],
        ),
        "avif" => ("avif", vec!["-c:v", "libaom-av1", "-still-picture", "1"]),
        // 動画
        "mp4" => (
            "mp4",
            vec!["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"],
        ),
        "webm" => ("webm", vec!["-c:v", "libvpx-vp9", "-c:a", "libopus"]),
        "mkv" => ("mkv", vec!["-c:v", "libx264", "-c:a", "aac"]),
        "mov" => ("mov", vec!["-c:v", "libx264", "-c:a", "aac"]),
        "avi" => ("avi", vec!["-c:v", "mpeg4", "-c:a", "libmp3lame"]),
        "gif-anim" => (
            "gif",
            vec!["-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0"],
        ),
        // 音声
        "mp3" => ("mp3", vec!["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
        "wav" => ("wav", vec!["-vn", "-c:a", "pcm_s16le"]),
        "ogg" => ("ogg", vec!["-vn", "-c:a", "libvorbis", "-q:a", "5"]),
        "m4a" => ("m4a", vec!["-vn", "-c:a", "aac", "-b:a", "192k"]),
        "flac" => ("flac", vec!["-vn", "-c:a", "flac"]),
        "opus" => ("opus", vec!["-vn", "-c:a", "libopus", "-b:a", "128k"]),
        _ => return Err(format!("未対応の形式: {}", format)),
    };
    Ok(r)
}

#[tauri::command]
async fn toolbox_pick_file(initial: Option<String>) -> Result<Option<String>, String> {
    let mut dlg = rfd::AsyncFileDialog::new()
        .add_filter(
            "メディアファイル",
            &[
                "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico", "avif", "heic",
                "heif", "mp4", "webm", "mkv", "mov", "avi", "m4v", "flv", "wmv", "mp3", "wav",
                "ogg", "m4a", "flac", "opus", "aac", "wma",
            ],
        )
        .add_filter("すべてのファイル", &["*"]);
    if let Some(p) = initial {
        let pb = PathBuf::from(&p);
        if let Some(parent) = pb.parent() {
            if parent.is_dir() {
                dlg = dlg.set_directory(parent);
            }
        }
    }
    let chosen = dlg.pick_file().await;
    Ok(chosen.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command]
fn toolbox_convert_run(
    app: AppHandle,
    state: State<'_, ToolboxState>,
    args: ConvertRunArgs,
) -> Result<u64, String> {
    let input = args.input.trim().to_string();
    if input.is_empty() {
        return Err("入力ファイルを指定してください".to_string());
    }
    let in_path = PathBuf::from(&input);
    if !in_path.is_file() {
        return Err(format!("入力ファイルが見つかりません: {}", input));
    }
    let (ext, extra) = ffmpeg_args_for(&args.format)?;

    let out_dir = if args.out_dir.trim().is_empty() {
        in_path
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "入力ファイルの親ディレクトリが取得できません".to_string())?
    } else {
        PathBuf::from(args.out_dir.trim())
    };
    if !out_dir.is_dir() {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力フォルダ作成失敗: {}", e))?;
    }
    let stem = in_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let mut out_path = out_dir.join(format!("{}.{}", stem, ext));
    // 既存があれば連番
    let mut n = 1;
    while out_path.exists() && out_path.canonicalize().ok() != in_path.canonicalize().ok() {
        out_path = out_dir.join(format!("{} ({}).{}", stem, n, ext));
        n += 1;
        if n > 999 {
            break;
        }
    }
    // 入力と出力が同じ場合は安全のためサフィックスを追加
    if out_path.canonicalize().ok() == in_path.canonicalize().ok() {
        out_path = out_dir.join(format!("{} (converted).{}", stem, ext));
    }

    let ffmpeg = ensure_ffmpeg(&app)?;
    let exe = ffmpeg.to_string_lossy().to_string();

    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-hide_banner").arg("-y").arg("-i").arg(&in_path);
    for a in &extra {
        cmd.arg(a);
    }
    cmd.arg(&out_path);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 起動失敗: {}", e))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let job_id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_job_id += 1;
        s.next_job_id
    };
    let child_arc = std::sync::Arc::new(Mutex::new(Some(child)));
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.jobs.insert(job_id, child_arc.clone());
    }

    let _ = app.emit_to(
        "ui",
        "toolbox-conv-progress",
        ConvProgress {
            job_id,
            line: format!(
                "$ {} -i \"{}\" {} \"{}\"",
                exe,
                in_path.display(),
                extra.join(" "),
                out_path.display()
            ),
            kind: "info".to_string(),
        },
    );

    if let Some(out) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(out).lines().flatten() {
                let _ = app2.emit_to(
                    "ui",
                    "toolbox-conv-progress",
                    ConvProgress {
                        job_id,
                        line,
                        kind: "stdout".to_string(),
                    },
                );
            }
        });
    }
    if let Some(err) = stderr {
        let app2 = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(err).lines().flatten() {
                let _ = app2.emit_to(
                    "ui",
                    "toolbox-conv-progress",
                    ConvProgress {
                        job_id,
                        line,
                        kind: "stderr".to_string(),
                    },
                );
            }
        });
    }
    let app3 = app.clone();
    let child_arc2 = child_arc.clone();
    let state_handle = app.clone();
    let out_path_str = out_path.to_string_lossy().to_string();
    std::thread::spawn(move || {
        let mut taken = {
            let mut g = child_arc2.lock().unwrap();
            g.take()
        };
        let result = if let Some(ref mut c) = taken {
            c.wait()
        } else {
            return;
        };
        let (success, code) = match result {
            Ok(status) => (status.success(), status.code()),
            Err(_) => (false, None),
        };
        let _ = app3.emit_to(
            "ui",
            "toolbox-conv-done",
            ConvDone {
                job_id,
                success,
                code,
                output_path: if success { Some(out_path_str) } else { None },
            },
        );
        if let Some(state) = state_handle.try_state::<ToolboxState>() {
            if let Ok(mut s) = state.0.lock() {
                s.jobs.remove(&job_id);
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
fn toolbox_convert_cancel(state: State<'_, ToolboxState>, job_id: u64) -> Result<(), String> {
    toolbox_ytdlp_cancel(state, job_id)
}

/// 指定 URL のページ HTML をダウンロードしてファイルに保存する。
/// JS 実行後の DOM ではなく、サーバから返される生の HTML を保存する。
#[tauri::command]
fn toolbox_save_page_html(url: String, dir: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL が不正です: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http/https の URL を指定してください".to_string());
    }
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("保存先が未設定です".to_string());
    }
    let dir_path = std::path::PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("保存先フォルダ作成失敗: {}", e))?;

    let resp = ureq::get(&url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) yuzu-browser/0.1",
        )
        .set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .call()
        .map_err(|e| format!("取得失敗: {}", e))?;

    let mut reader = resp.into_reader();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut reader, &mut bytes)
        .map_err(|e| format!("読み込み失敗: {}", e))?;

    let text = String::from_utf8_lossy(&bytes);
    let title = extract_title(&text);
    let base_name = title
        .as_deref()
        .map(sanitize_filename)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let host = parsed.host_str().unwrap_or("page").to_string();
            sanitize_filename(&host)
        });
    let mut base_name = base_name;
    if base_name.len() > 80 {
        let mut cut = 80;
        while cut > 0 && !base_name.is_char_boundary(cut) {
            cut -= 1;
        }
        base_name.truncate(cut);
    }

    let mut path = dir_path.join(format!("{}.html", base_name));
    let mut idx: u32 = 1;
    while path.exists() {
        path = dir_path.join(format!("{}_{}.html", base_name, idx));
        idx += 1;
        if idx > 9999 {
            return Err("ファイル名候補を使い切りました".to_string());
        }
    }
    // 取得した HTML に <base href="..."> を挿入し、相対パスのリソースが
    // ローカルで開いた時にも解決できるようにする。
    let text_with_base = inject_base_href(&text, parsed.as_str());
    std::fs::write(&path, text_with_base.as_bytes()).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after = &html[start..];
    let gt = after.find('>')?;
    let body = &after[gt + 1..];
    let lower_body = body.to_ascii_lowercase();
    let end = lower_body.find("</title>")?;
    let raw = body[..end].trim();
    if raw.is_empty() {
        None
    } else {
        Some(
            raw.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'"),
        )
    }
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_matches('.').to_string()
}

// ===== リーディングモード =====

const READER_ON_JS: &str = r#"(function(){
  try {
    if (window.__yuzuReaderActive) return;
    function isVisible(el){
      if (!el || !el.getBoundingClientRect) return false;
      var s = window.getComputedStyle(el);
      if (!s) return true;
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return true;
    }
    function textLen(el){ return ((el.innerText || el.textContent || '').replace(/\s+/g,' ').trim()).length; }
    function score(el){
      if (!isVisible(el)) return 0;
      var ps = el.querySelectorAll('p,li,blockquote,pre');
      var pLen = 0;
      for (var i=0;i<ps.length;i++) pLen += textLen(ps[i]);
      var total = textLen(el);
      var links = el.querySelectorAll('a');
      var linkLen = 0;
      for (var i=0;i<links.length;i++) linkLen += textLen(links[i]);
      var linkDensity = total > 0 ? (linkLen / total) : 1;
      // テキストの密度を考慮（リンクだらけのナビは除外）
      var base = pLen * 1.2 + total * 0.3;
      return base * (1 - Math.min(linkDensity, 0.95));
    }
    var candidates = [];
    var tags = ['article','main','[role=\"main\"]','#main','#content','#primary','.content','.post','.entry','.article','.story'];
    for (var t=0;t<tags.length;t++){
      var nodes = document.querySelectorAll(tags[t]);
      for (var i=0;i<nodes.length;i++) candidates.push(nodes[i]);
    }
    if (candidates.length===0) {
      var all = document.body ? document.body.querySelectorAll('div,section') : [];
      for (var i=0;i<all.length;i++) candidates.push(all[i]);
    }
    var best=null, bestScore=0;
    for (var i=0;i<candidates.length;i++){
      var s = score(candidates[i]);
      if (s>bestScore){ bestScore=s; best=candidates[i]; }
    }
    var title = (document.querySelector('h1') && document.querySelector('h1').innerText) || document.title || '';
    var overlay = document.createElement('div');
    overlay.id = '__yuzu-reader-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#1a1814;color:#e8e3d8;overflow:auto;padding:48px 24px;font-family:Georgia,\"Hiragino Mincho ProN\",\"Yu Mincho\",serif;font-size:18px;line-height:1.85;';
    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:720px;margin:0 auto;';
    var h = document.createElement('h1');
    h.textContent = title;
    h.style.cssText = 'font-size:28px;line-height:1.3;margin:0 0 24px 0;color:#fff;border-bottom:1px solid #3a352c;padding-bottom:12px;';
    inner.appendChild(h);

    var MIN_SCORE = 150;
    if (!best || bestScore < MIN_SCORE) {
      // 抽出に失敗した場合はメッセージのみ表示（真っ黒な空ページを避ける）
      var msg = document.createElement('div');
      msg.style.cssText = 'background:#2a261f;border:1px solid #3a352c;border-radius:8px;padding:20px;color:#d4cdb8;';
      var p1 = document.createElement('p');
      p1.style.cssText = 'margin:0 0 8px 0;font-weight:bold;color:#ffd27a;';
      p1.textContent = 'このページからは本文を抽出できませんでした。';
      var p2 = document.createElement('p');
      p2.style.cssText = 'margin:0;font-size:15px;line-height:1.7;color:#bdb6a3;';
      p2.textContent = '記事ページなど、長い文章のあるページで「現在のタブに適用」を再度お試しください。「解除」ボタンで元の表示に戻せます。';
      msg.appendChild(p1);
      msg.appendChild(p2);
      inner.appendChild(msg);
    } else {
      var content = best.cloneNode(true);
      // 不要な要素を除去（h1-h6 や figure/img など読み物に必要な要素は残す）
      var rm = content.querySelectorAll('script,style,nav,aside,iframe,noscript,form,button,input,select,textarea,svg,canvas,video,audio,object,embed');
      for (var i=0;i<rm.length;i++) rm[i].remove();
      // ページ最上部の重複タイトル h1 を除去
      var dupH1 = content.querySelector('h1');
      if (dupH1 && dupH1.innerText && title && dupH1.innerText.trim() === title.trim()) {
        dupH1.remove();
      }
      var article = document.createElement('article');
      article.appendChild(content);
      var imgs = article.querySelectorAll('img');
      for (var i=0;i<imgs.length;i++){ imgs[i].style.maxWidth='100%'; imgs[i].style.height='auto'; imgs[i].removeAttribute('width'); imgs[i].removeAttribute('height'); }
      var links = article.querySelectorAll('a');
      for (var i=0;i<links.length;i++){ links[i].style.color='#7eb6ff'; }
      // 抽出後のテキストが極端に少ない場合もメッセージに置換
      if (textLen(article) < 80) {
        article.innerHTML = '';
        var msg = document.createElement('p');
        msg.style.cssText = 'color:#bdb6a3;';
        msg.textContent = '本文を十分に抽出できませんでした。';
        article.appendChild(msg);
      }
      inner.appendChild(article);
    }
    overlay.appendChild(inner);
    (document.body || document.documentElement).appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    window.__yuzuReaderActive = true;
  } catch (e) { console.error('reader failed:', e); }
})();"#;

const READER_OFF_JS: &str = r#"(function(){
  try {
    var o = document.getElementById('__yuzu-reader-overlay');
    if (o) o.remove();
    document.documentElement.style.overflow = '';
    window.__yuzuReaderActive = false;
  } catch(e) {}
})();"#;

#[tauri::command]
fn view_set_reader_mode(
    window: Window,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active_in(&window.label())
            .ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    let script = if enabled { READER_ON_JS } else { READER_OFF_JS };
    view.eval(script).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== スクリーンショット =====

#[derive(Default)]
struct ScreenshotState(Mutex<Option<PageMetrics>>);

#[derive(Clone, Copy, Debug)]
struct PageMetrics {
    scroll_height: f64,
    inner_height: f64,
}

/// ページ webview から呼ばれる：撮影前にページ寸法を報告する。
#[tauri::command]
fn report_page_metrics(
    state: State<'_, ScreenshotState>,
    scroll_height: f64,
    inner_height: f64,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    *s = Some(PageMetrics {
        scroll_height,
        inner_height,
    });
    Ok(())
}

/// 指定座標を含むモニタを返す。`Monitor::from_point` が失敗した場合は
/// 全モニタを列挙して矩形に含むもの・なければ最も近いものへフォールバックする。
fn find_monitor_at(x: i32, y: i32) -> Result<xcap::Monitor, String> {
    if let Ok(m) = xcap::Monitor::from_point(x, y) {
        return Ok(m);
    }
    let monitors = xcap::Monitor::all().map_err(|e| format!("モニタ列挙失敗: {}", e))?;
    if monitors.is_empty() {
        return Err("利用可能なモニタが見つかりません".to_string());
    }
    for m in &monitors {
        let mx = m.x();
        let my = m.y();
        let mw = m.width() as i32;
        let mh = m.height() as i32;
        if x >= mx && x < mx + mw && y >= my && y < my + mh {
            return Ok(m.clone());
        }
    }
    let mut best = monitors[0].clone();
    let mut best_d: i64 = i64::MAX;
    for m in &monitors {
        let cx = m.x() + (m.width() as i32) / 2;
        let cy = m.y() + (m.height() as i32) / 2;
        let dx = (cx - x) as i64;
        let dy = (cy - y) as i64;
        let d = dx * dx + dy * dy;
        if d < best_d {
            best_d = d;
            best = m.clone();
        }
    }
    Ok(best)
}

fn find_xcap_window_for_tauri(window: &Window) -> Result<xcap::Window, String> {
    let my_pid = std::process::id();
    let outer_pos = window.outer_position().ok();
    let outer_size = window.outer_size().ok();
    let candidates: Vec<xcap::Window> = xcap::Window::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|w| w.process_id() == my_pid && !w.is_minimized())
        .collect();
    if candidates.is_empty() {
        return Err(format!("xcap window not found for pid={}", my_pid));
    }
    // 1) outer_pos と一致 (許容 8px) かつ最大面積を最優先。
    if let (Some(p), Some(s)) = (outer_pos, outer_size) {
        let mut matched: Vec<xcap::Window> = candidates
            .iter()
            .filter(|w| {
                (w.x() - p.x).abs() <= 8
                    && (w.y() - p.y).abs() <= 8
                    && (w.width() as i32 - s.width as i32).abs() <= 16
                    && (w.height() as i32 - s.height as i32).abs() <= 16
            })
            .cloned()
            .collect();
        if !matched.is_empty() {
            matched.sort_by_key(|w| -((w.width() as i64) * (w.height() as i64)));
            return Ok(matched.remove(0));
        }
    }
    // 2) フォールバック: 最大面積を採用。
    let mut sorted = candidates;
    sorted.sort_by_key(|w| -((w.width() as i64) * (w.height() as i64)));
    Ok(sorted.remove(0))
}

fn crop_rgba_checked(
    img: &image::RgbaImage,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    if width == 0 || height == 0 {
        return Err("キャプチャ対象のサイズが 0 です".to_string());
    }
    let x = x.max(0) as u32;
    let y = y.max(0) as u32;
    if x >= img.width() || y >= img.height() {
        return Err(format!(
            "キャプチャ範囲が画像外です: x={}, y={}, image={}x{}",
            x,
            y,
            img.width(),
            img.height()
        ));
    }
    let crop_w = width.min(img.width().saturating_sub(x));
    let crop_h = height.min(img.height().saturating_sub(y));
    if crop_w == 0 || crop_h == 0 {
        return Err("キャプチャ範囲が空です".to_string());
    }
    Ok(image::imageops::crop_imm(img, x, y, crop_w, crop_h).to_image())
}

/// アクティブ view の表示領域を画面からキャプチャする。
fn capture_view_viewport(window: &Window, view: &Webview) -> Result<image::RgbaImage, String> {
    let inner_pos = window.inner_position().map_err(|e| e.to_string())?;
    let outer_pos = window.outer_position().map_err(|e| e.to_string())?;
    let view_pos = view.position().map_err(|e| e.to_string())?;
    let view_size = view.size().map_err(|e| e.to_string())?;

    // 1) xcap でウィンドウごとキャプチャして切り抜く。
    if let Ok(xcap_win) = find_xcap_window_for_tauri(window) {
        if let Ok(img) = xcap_win.capture_image() {
            // xcap ウィンドウ画像は outer 記点。
            // クライアント (inner) は outer から (inner-outer) シフト、view は client 記点。
            let local_x = (inner_pos.x - outer_pos.x) + view_pos.x;
            let local_y = (inner_pos.y - outer_pos.y) + view_pos.y;
            if let Ok(cropped) =
                crop_rgba_checked(&img, local_x, local_y, view_size.width, view_size.height)
            {
                if cropped.width() >= view_size.width / 2
                    && cropped.height() >= view_size.height / 2
                {
                    return Ok(cropped);
                }
            }
        }
    }

    // 2) フォールバック: モニタキャプチャ + 絶対座標で切り抜く。
    let abs_x = inner_pos.x + view_pos.x;
    let abs_y = inner_pos.y + view_pos.y;

    let monitor = find_monitor_at(abs_x, abs_y).map_err(|e| format!("モニタ取得失敗: {}", e))?;
    let mx = monitor.x();
    let my = monitor.y();
    let img = monitor
        .capture_image()
        .map_err(|e| format!("画面キャプチャ失敗: {}", e))?;

    crop_rgba_checked(
        &img,
        abs_x - mx,
        abs_y - my,
        view_size.width,
        view_size.height,
    )
}

fn rgba_to_png_data_url(img: &image::RgbaImage) -> Result<String, String> {
    use base64::Engine;
    use image::ImageEncoder;
    let mut buf: Vec<u8> = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    encoder
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("PNG エンコード失敗: {}", e))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/// 表示領域のみキャプチャして PNG data URL を返す。
#[tauri::command]
async fn toolbox_screenshot(window: Window, state: State<'_, AppState>) -> Result<String, String> {
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active_in(&window.label())
            .ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;

    // ツールボックス展開中は active view が LogicalSize(1,1) offscreen になっているため
    // キャプチャ前だけ通常位置に戻す。UI webview は transparent なので
    // ブラウザコンテンツが透過部分から見える。
    let scale = window.scale_factor().unwrap_or(1.0);
    let inner_logi = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let view_w = inner_logi.width.max(1.0);
    let view_h = (inner_logi.height - CHROME_HEIGHT).max(1.0);

    let raw_size = view.size().map_err(|e| e.to_string())?;
    let was_offscreen = raw_size.width < 32 || raw_size.height < 32;
    if was_offscreen {
        let _ = view.set_size(LogicalSize::new(view_w, view_h));
        let _ = view.set_position(LogicalPosition::new(0.0, CHROME_HEIGHT));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    let result = capture_view_viewport(&window, &view).and_then(|img| rgba_to_png_data_url(&img));

    if was_offscreen {
        let _ = view.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
        let _ = view.set_size(LogicalSize::new(1.0, 1.0));
    }

    result
}

/// ページ全体をスクロールしながらキャプチャして連結した PNG data URL を返す。
#[tauri::command]
async fn toolbox_screenshot_full_page(
    window: Window,
    state: State<'_, AppState>,
    screenshot_state: State<'_, ScreenshotState>,
) -> Result<String, String> {
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active_in(&window.label())
            .ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;

    // ツールボックス展開中は view が LogicalSize(1,1) offscreen。
    // JS の window.innerHeight も 1 になるため metrics が狂う。通常位置に一時復帰。
    let scale_pre = window.scale_factor().unwrap_or(1.0);
    let inner_logi_pre = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale_pre);
    let view_w_pre = inner_logi_pre.width.max(1.0);
    let view_h_pre = (inner_logi_pre.height - CHROME_HEIGHT).max(1.0);
    let raw_size_pre = view.size().map_err(|e| e.to_string())?;
    let was_offscreen_fp = raw_size_pre.width < 32 || raw_size_pre.height < 32;
    if was_offscreen_fp {
        let _ = view.set_size(LogicalSize::new(view_w_pre, view_h_pre));
        let _ = view.set_position(LogicalPosition::new(0.0, CHROME_HEIGHT));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    // 古い指標をクリア
    {
        let mut s = screenshot_state.0.lock().map_err(|e| e.to_string())?;
        *s = None;
    }

    // 元のスクロール位置を保存し、ページ寸法を invoke で報告させる
    let metrics_script = r#"
    (function () {
      try {
        window.__yuzuOldScrollX = window.scrollX;
        window.__yuzuOldScrollY = window.scrollY;
        window.__yuzuOldScrollBehavior = document.documentElement.style.scrollBehavior || '';
        document.documentElement.style.scrollBehavior = 'auto';
        var d = document.documentElement;
        var b = document.body;
        var h = Math.max(
          d.scrollHeight, d.offsetHeight, d.clientHeight,
          b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
        );
        if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
          window.__TAURI_INTERNALS__.invoke('report_page_metrics', {
            scrollHeight: h,
            innerHeight: window.innerHeight
          });
        }
      } catch (_) {}
    })();
    "#;
    view.eval(metrics_script).map_err(|e| e.to_string())?;

    // ポーリングして寸法を受け取る
    let mut metrics: Option<PageMetrics> = None;
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        if let Ok(s) = screenshot_state.0.lock() {
            if let Some(m) = *s {
                metrics = Some(m);
                break;
            }
        }
    }
    let metrics = metrics.ok_or_else(|| "ページ情報の取得に失敗しました".to_string())?;

    let view_size = view.size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let viewport_h_logical = metrics.inner_height.max(1.0);
    // 安全のため大きすぎるページは制限（最大 16000px logical）。
    // 16000 × DPR=1.5 = 24000px の PNG でもメモリ ~370MB なので
    // これより大きいと体感的に「終わらない」になる。
    let total_h_logical = metrics.scroll_height.min(16000.0).max(viewport_h_logical);
    let total_h_px = ((total_h_logical * scale) as u32).max(1);
    let total_w_px = view_size.width.max(1);

    let mut stitched = image::RgbaImage::new(total_w_px, total_h_px);

    let mut y_logical = 0.0_f64;
    let mut iter = 0;
    // タイル数上限。viewport_h=600 でも 60 タイル = 36000px までカバー。
    let max_iter = 60_u32;
    while y_logical < total_h_logical && iter < max_iter {
        let script = format!(
            "window.scrollTo({{left:0,top:{},behavior:'auto'}});",
            y_logical
        );
        view.eval(&script).map_err(|e| e.to_string())?;
        // レイアウト・再描画を待つ (短めにして体感を改善)。
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        let tile = capture_view_viewport(&window, &view)?;
        let dest_y_px = (y_logical * scale) as i64;
        image::imageops::replace(&mut stitched, &tile, 0, dest_y_px);

        y_logical += viewport_h_logical;
        iter += 1;
    }

    // スクロール位置と scroll-behavior を復元
    let restore = r#"
    (function () {
      try {
        window.scrollTo({
          left: window.__yuzuOldScrollX || 0,
          top: window.__yuzuOldScrollY || 0,
          behavior: 'auto'
        });
        document.documentElement.style.scrollBehavior =
          window.__yuzuOldScrollBehavior || '';
      } catch (_) {}
    })();
    "#;
    let _ = view.eval(restore);

    // フルページキャプチャ完了。offscreen に戻す。
    if was_offscreen_fp {
        let _ = view.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
        let _ = view.set_size(LogicalSize::new(1.0, 1.0));
    }

    rgba_to_png_data_url(&stitched)
}

/// 編集後の PNG (data URL) を保存先ディレクトリに書き出す。
#[tauri::command]
fn toolbox_save_data_url(dir: String, data_url: String) -> Result<String, String> {
    use base64::Engine;
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("保存先が未設定です".to_string());
    }
    let prefix = "data:image/png;base64,";
    let b64 = data_url
        .strip_prefix(prefix)
        .ok_or_else(|| "data URL 形式が不正です".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 デコード失敗: {}", e))?;
    let dir_path = std::path::PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("保存先フォルダ作成失敗: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir_path.join(format!("screenshot_{}.png", ts));
    std::fs::write(&path, &bytes).map_err(|e| format!("保存失敗: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// ===== アクティブタブの HTML 取得 =====

/// `view_get_active_html` が完了通知を待つためのバッファ。
/// req_id -> (html, url).
#[derive(Default)]
struct ActiveHtmlState(Mutex<HashMap<u64, (String, String)>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportActiveHtmlArgs {
    req_id: u64,
    html: String,
    #[serde(default)]
    url: String,
}

#[tauri::command]
fn report_active_html(
    state: State<'_, ActiveHtmlState>,
    args: ReportActiveHtmlArgs,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.insert(args.req_id, (args.html, args.url));
    Ok(())
}

/// アクティブタブの webview から `document.documentElement.outerHTML` と `location.href` を
/// 取得して返す。`<base href>` を head に挿入し、相対 URL のリソースが開いた時に解決できるようにする。
async fn fetch_active_html_inner(
    window: &Window,
    state: &State<'_, AppState>,
    html_state: &State<'_, ActiveHtmlState>,
) -> Result<(String, String), String> {
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active_in(&window.label())
            .ok_or_else(|| "アクティブなタブがありません".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "アクティブなビューが見つかりません".to_string())?;
    let req_id: u64 = {
        // 単純なミリ秒タイムスタンプを id 代わりに使う
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0)
    };
    let script = format!(
        r#"(function(){{
  try {{
    var html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    var url = location.href;
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
      window.__TAURI_INTERNALS__.invoke('report_active_html', {{
        args: {{ reqId: {req_id}, html: html, url: url }}
      }});
    }}
  }} catch (e) {{
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
      window.__TAURI_INTERNALS__.invoke('report_active_html', {{
        args: {{ reqId: {req_id}, html: '', url: '' }}
      }});
    }}
  }}
}})();"#,
        req_id = req_id
    );
    view.eval(&script).map_err(|e| e.to_string())?;
    for _ in 0..120 {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        if let Ok(mut s) = html_state.0.lock() {
            if let Some(entry) = s.remove(&req_id) {
                if entry.0.is_empty() {
                    return Err("ページの HTML を取得できませんでした".to_string());
                }
                return Ok(entry);
            }
        }
    }
    Err("ページの HTML 取得がタイムアウトしました".to_string())
}

#[tauri::command]
async fn view_get_active_html(
    window: Window,
    state: State<'_, AppState>,
    html_state: State<'_, ActiveHtmlState>,
) -> Result<ActiveHtmlPayload, String> {
    let (html, url) = fetch_active_html_inner(&window, &state, &html_state).await?;
    Ok(ActiveHtmlPayload { html, url })
}

#[derive(serde::Serialize)]
struct ActiveHtmlPayload {
    html: String,
    url: String,
}

/// `<head>` の先頭 (charset の直後あたり) に `<base href>` を差し込む。
fn inject_base_href(html: &str, base_url: &str) -> String {
    if base_url.is_empty() || html.contains("<base ") {
        return html.to_string();
    }
    let lower = html.to_ascii_lowercase();
    let tag = format!("<base href=\"{}\">", base_url.replace('"', "&quot;"));
    if let Some(pos) = lower.find("<head") {
        if let Some(close) = lower[pos..].find('>') {
            let insert_at = pos + close + 1;
            let mut out = String::with_capacity(html.len() + tag.len());
            out.push_str(&html[..insert_at]);
            out.push_str(&tag);
            out.push_str(&html[insert_at..]);
            return out;
        }
    }
    // <head> が無い場合は先頭に挿入
    format!("{}\n{}", tag, html)
}

/// アクティブタブの描画済み HTML を保存する。SPA でも実描画後の DOM を取れる。
#[tauri::command]
async fn toolbox_save_active_page_html(
    window: Window,
    state: State<'_, AppState>,
    html_state: State<'_, ActiveHtmlState>,
    dir: String,
) -> Result<String, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("保存先が未設定です".to_string());
    }
    let (html, url) = fetch_active_html_inner(&window, &state, &html_state).await?;
    let parsed = url::Url::parse(&url).ok();
    let title = extract_title(&html);
    let base_name = title
        .as_deref()
        .map(sanitize_filename)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            parsed
                .as_ref()
                .and_then(|u| u.host_str().map(|h| sanitize_filename(h)))
                .unwrap_or_else(|| "page".to_string())
        });
    let mut base_name = base_name;
    if base_name.len() > 80 {
        let mut cut = 80;
        while cut > 0 && !base_name.is_char_boundary(cut) {
            cut -= 1;
        }
        base_name.truncate(cut);
    }
    let dir_path = std::path::PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("保存先フォルダ作成失敗: {}", e))?;
    let mut path = dir_path.join(format!("{}.html", base_name));
    let mut idx: u32 = 1;
    while path.exists() {
        path = dir_path.join(format!("{}_{}.html", base_name, idx));
        idx += 1;
        if idx > 9999 {
            return Err("ファイル名候補を使い切りました".to_string());
        }
    }
    let final_html = inject_base_href(&html, &url);
    std::fs::write(&path, final_html.as_bytes()).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// ===== スクレイピング =====

#[derive(serde::Serialize)]
struct ScrapeResult {
    status: u16,
    content_type: String,
    body: String,
    bytes: usize,
    /// レスポンスヘッダ (key は小文字化)。技術プロファイラ等で利用。
    headers: Vec<(String, String)>,
    /// Set-Cookie の "name" 部分のみを抽出 (cookie 本体や値は捨てる)。
    cookies: Vec<String>,
}

#[tauri::command]
fn toolbox_scrape_fetch(url: String, user_agent: Option<String>) -> Result<ScrapeResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL が不正です: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http/https を指定してください".to_string());
    }
    let ua = user_agent
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            // 一般的な Chrome の UA を装う。yuzu-browser/0.1 を直接送ると
            // YouTube などのサイトで古いブラウザ扱いされ、軽量版や同意ページに
            // リダイレクトされて技術スタックが正しく検出できないため。
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                .to_string()
        });
    let resp = ureq::get(&url)
        .set("User-Agent", &ua)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("Accept-Language", "ja,en-US;q=0.7,en;q=0.3")
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Mode", "navigate")
        .set("Sec-Fetch-Site", "none")
        .set("Sec-Fetch-User", "?1")
        .set("Upgrade-Insecure-Requests", "1")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("取得失敗: {}", e))?;
    let status = resp.status();
    let content_type = resp.content_type().to_string();
    // ヘッダと Set-Cookie 名を収集
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut cookies: Vec<String> = Vec::new();
    for name in resp.headers_names() {
        if let Some(val) = resp.header(&name) {
            let key = name.to_ascii_lowercase();
            if key == "set-cookie" {
                // "name=value; ..." の name 部分のみ
                if let Some(eq) = val.find('=') {
                    cookies.push(val[..eq].trim().to_string());
                }
            }
            headers.push((key, val.to_string()));
        }
    }
    let mut reader = resp.into_reader();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        let n =
            std::io::Read::read(&mut reader, &mut buf).map_err(|e| format!("読込失敗: {}", e))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        if bytes.len() > 20 * 1024 * 1024 {
            break;
        }
    }
    let len = bytes.len();
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(ScrapeResult {
        status,
        content_type,
        body,
        bytes: len,
        headers,
        cookies,
    })
}

// ===== ZIP 解凍 =====

#[derive(serde::Serialize)]
struct ExtractResult {
    files: usize,
    bytes: u64,
    dest: String,
    format: String,
}

#[derive(Clone, Copy)]
enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    TarZst,
    TarLz4,
    SevenZ,
    Gz,
    Bz2,
    Xz,
    Zst,
    Lz4,
    Cab,
    Ar,
    Unknown,
}

fn detect_format(path: &std::path::Path) -> ArchiveFormat {
    let n = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        ArchiveFormat::TarGz
    } else if n.ends_with(".tar.bz2") || n.ends_with(".tbz2") || n.ends_with(".tbz") {
        ArchiveFormat::TarBz2
    } else if n.ends_with(".tar.xz") || n.ends_with(".txz") {
        ArchiveFormat::TarXz
    } else if n.ends_with(".tar.zst") || n.ends_with(".tar.zstd") || n.ends_with(".tzst") {
        ArchiveFormat::TarZst
    } else if n.ends_with(".tar.lz4") || n.ends_with(".tlz4") {
        ArchiveFormat::TarLz4
    } else if n.ends_with(".tar") {
        ArchiveFormat::Tar
    } else if n.ends_with(".zip")
        // zip 互換コンテナ
        || n.ends_with(".jar")
        || n.ends_with(".war")
        || n.ends_with(".ear")
        || n.ends_with(".apk")
        || n.ends_with(".aab")
        || n.ends_with(".ipa")
        || n.ends_with(".xpi")
        || n.ends_with(".crx")
        || n.ends_with(".whl")
        || n.ends_with(".epub")
        || n.ends_with(".cbz")
        || n.ends_with(".odt")
        || n.ends_with(".ods")
        || n.ends_with(".odp")
        || n.ends_with(".odg")
        || n.ends_with(".docx")
        || n.ends_with(".xlsx")
        || n.ends_with(".pptx")
        || n.ends_with(".vsix")
        || n.ends_with(".nupkg")
    {
        ArchiveFormat::Zip
    } else if n.ends_with(".7z") {
        ArchiveFormat::SevenZ
    } else if n.ends_with(".gz") {
        ArchiveFormat::Gz
    } else if n.ends_with(".bz2") {
        ArchiveFormat::Bz2
    } else if n.ends_with(".xz") || n.ends_with(".lzma") {
        ArchiveFormat::Xz
    } else if n.ends_with(".zst") || n.ends_with(".zstd") {
        ArchiveFormat::Zst
    } else if n.ends_with(".lz4") {
        ArchiveFormat::Lz4
    } else if n.ends_with(".cab") {
        ArchiveFormat::Cab
    } else if n.ends_with(".ar") || n.ends_with(".deb") || n.ends_with(".a") {
        ArchiveFormat::Ar
    } else {
        ArchiveFormat::Unknown
    }
}

fn extract_zip(
    src: &std::path::Path,
    dest: &std::path::Path,
    progress: &dyn Fn(usize, u64, Option<usize>, Option<&str>),
) -> Result<(usize, u64), String> {
    let file = std::fs::File::open(src).map_err(|e| format!("読込失敗: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 読込失敗: {}", e))?;
    let total_entries = archive.len();
    let mut count = 0usize;
    let mut total = 0u64;
    progress(0, 0, Some(total_entries), None);
    for i in 0..total_entries {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {}: {}", i, e))?;
        let entry_name = entry.name().to_string();
        let outpath = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| format!("dir: {}", e))?;
        } else {
            if let Some(p) = outpath.parent() {
                std::fs::create_dir_all(p).map_err(|e| format!("dir: {}", e))?;
            }
            let mut out = std::fs::File::create(&outpath)
                .map_err(|e| format!("create {}: {}", outpath.display(), e))?;
            let n = std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy: {}", e))?;
            total += n;
            count += 1;
            progress(count, total, Some(total_entries), Some(&entry_name));
        }
    }
    Ok((count, total))
}

fn extract_tar_reader<R: std::io::Read>(
    reader: R,
    dest: &std::path::Path,
    progress: &dyn Fn(usize, u64, Option<usize>, Option<&str>),
) -> Result<(usize, u64), String> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(false);
    archive.set_overwrite(true);
    let mut count = 0usize;
    let mut total = 0u64;
    let entries = archive.entries().map_err(|e| format!("tar: {}", e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar entry: {}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar path: {}", e))?
            .into_owned();
        // パストラバーサル対策
        if path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let outpath = dest.join(&path);
        let header = entry.header();
        let etype = header.entry_type();
        if etype.is_dir() {
            std::fs::create_dir_all(&outpath).ok();
        } else if etype.is_file() {
            if let Some(p) = outpath.parent() {
                std::fs::create_dir_all(p).map_err(|e| format!("dir: {}", e))?;
            }
            let mut out = std::fs::File::create(&outpath)
                .map_err(|e| format!("create {}: {}", outpath.display(), e))?;
            let n = std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy: {}", e))?;
            total += n;
            count += 1;
            progress(count, total, None, path.to_str());
        }
        // symlink/hardlink などは無視
    }
    Ok((count, total))
}

fn buffered_file(src: &std::path::Path) -> Result<std::io::BufReader<std::fs::File>, String> {
    Ok(std::io::BufReader::new(
        std::fs::File::open(src).map_err(|e| format!("読込失敗: {}", e))?,
    ))
}

fn xz_to_vec(src: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut input = buffered_file(src)?;
    let mut out = Vec::new();
    lzma_rs::xz_decompress(&mut input, &mut out).map_err(|e| format!("xz: {}", e))?;
    Ok(out)
}

fn extract_single(
    src: &std::path::Path,
    dest_dir: &std::path::Path,
    fmt: ArchiveFormat,
) -> Result<(usize, u64, std::path::PathBuf), String> {
    // 拡張子を除いたファイル名を出力名とする
    let stem = src
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            for ext in [
                ".tar.gz",
                ".tar.bz2",
                ".tar.xz",
                ".tar.zst",
                ".tar.zstd",
                ".tar.lz4",
            ] {
                if lower.ends_with(ext) {
                    return n[..n.len() - ext.len()].to_string() + ".tar";
                }
            }
            for ext in [".tgz", ".tbz2", ".tbz", ".txz", ".tzst", ".tlz4"] {
                if lower.ends_with(ext) {
                    return n[..n.len() - ext.len()].to_string() + ".tar";
                }
            }
            for ext in [".gz", ".bz2", ".xz", ".lzma", ".zst", ".zstd", ".lz4"] {
                if lower.ends_with(ext) {
                    return n[..n.len() - ext.len()].to_string();
                }
            }
            n.to_string()
        })
        .unwrap_or_else(|| "output.bin".to_string());
    let outpath = dest_dir.join(&stem);
    if let Some(p) = outpath.parent() {
        std::fs::create_dir_all(p).ok();
    }
    let mut out = std::fs::File::create(&outpath).map_err(|e| format!("create: {}", e))?;
    let n = match fmt {
        ArchiveFormat::Gz => {
            let r = flate2::read::GzDecoder::new(buffered_file(src)?);
            std::io::copy(&mut std::io::BufReader::new(r), &mut out)
                .map_err(|e| format!("gz: {}", e))?
        }
        ArchiveFormat::Bz2 => {
            let r = bzip2_rs::DecoderReader::new(buffered_file(src)?);
            std::io::copy(&mut std::io::BufReader::new(r), &mut out)
                .map_err(|e| format!("bz2: {}", e))?
        }
        ArchiveFormat::Xz => {
            let v = xz_to_vec(src)?;
            std::io::copy(&mut std::io::Cursor::new(&v), &mut out)
                .map_err(|e| format!("xz: {}", e))?
        }
        ArchiveFormat::Zst => {
            let mut r = ruzstd::StreamingDecoder::new(buffered_file(src)?)
                .map_err(|e| format!("zstd: {}", e))?;
            std::io::copy(&mut r, &mut out).map_err(|e| format!("zstd: {}", e))?
        }
        ArchiveFormat::Lz4 => {
            let mut r = lz4_flex::frame::FrameDecoder::new(buffered_file(src)?);
            std::io::copy(&mut r, &mut out).map_err(|e| format!("lz4: {}", e))?
        }
        _ => return Err("単体形式ではありません".to_string()),
    };
    Ok((1, n, outpath))
}

fn extract_cab(
    src: &std::path::Path,
    dest: &std::path::Path,
    progress: &dyn Fn(usize, u64, Option<usize>, Option<&str>),
) -> Result<(usize, u64), String> {
    let f = std::fs::File::open(src).map_err(|e| format!("読込失敗: {}", e))?;
    let mut cab = cab::Cabinet::new(f).map_err(|e| format!("cab: {}", e))?;
    // 先にファイル名一覧を収集 (借用を避けるため)
    let names: Vec<String> = cab
        .folder_entries()
        .flat_map(|fo| fo.file_entries().map(|fi| fi.name().to_string()))
        .collect();
    let total_entries = names.len();
    progress(0, 0, Some(total_entries), None);
    let mut count = 0usize;
    let mut total = 0u64;
    for name in names {
        // パストラバーサル対策: バックスラッシュを '/' に正規化し相対化
        let rel = name.replace('\\', "/");
        let rel_path = std::path::PathBuf::from(&rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let outpath = dest.join(&rel_path);
        if let Some(p) = outpath.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("dir: {}", e))?;
        }
        let mut reader = cab
            .read_file(&name)
            .map_err(|e| format!("cab read: {}", e))?;
        let mut out = std::fs::File::create(&outpath)
            .map_err(|e| format!("create {}: {}", outpath.display(), e))?;
        let n = std::io::copy(&mut reader, &mut out).map_err(|e| format!("copy: {}", e))?;
        total += n;
        count += 1;
        progress(count, total, Some(total_entries), Some(&rel));
    }
    Ok((count, total))
}

fn extract_ar(
    src: &std::path::Path,
    dest: &std::path::Path,
    progress: &dyn Fn(usize, u64, Option<usize>, Option<&str>),
) -> Result<(usize, u64), String> {
    let f = std::fs::File::open(src).map_err(|e| format!("読込失敗: {}", e))?;
    let mut archive = ar::Archive::new(std::io::BufReader::new(f));
    let mut count = 0usize;
    let mut total = 0u64;
    while let Some(entry) = archive.next_entry() {
        let mut entry = entry.map_err(|e| format!("ar entry: {}", e))?;
        let name = String::from_utf8_lossy(entry.header().identifier()).to_string();
        // パストラバーサル対策
        if name.is_empty() || name.contains("..") || name.starts_with('/') || name.contains('\\') {
            continue;
        }
        let outpath = dest.join(&name);
        if let Some(p) = outpath.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("dir: {}", e))?;
        }
        let mut out = std::fs::File::create(&outpath)
            .map_err(|e| format!("create {}: {}", outpath.display(), e))?;
        let n = std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy: {}", e))?;
        total += n;
        count += 1;
        progress(count, total, None, Some(&name));
    }
    Ok((count, total))
}

fn count_dir(p: &std::path::Path) -> (usize, u64) {
    let mut c = 0usize;
    let mut b = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                let (c2, b2) = count_dir(&path);
                c += c2;
                b += b2;
            } else if let Ok(md) = e.metadata() {
                c += 1;
                b += md.len();
            }
        }
    }
    (c, b)
}

#[derive(Clone, serde::Serialize)]
struct ExtractProgressPayload {
    files: usize,
    bytes: u64,
    total_files: Option<usize>,
    total_bytes: Option<u64>,
    current_file: Option<String>,
}

#[tauri::command]
async fn toolbox_extract_archive(
    app: AppHandle,
    archive_path: String,
    dest_dir: String,
) -> Result<ExtractResult, String> {
    // UI スレッドをブロックしないように blocking pool で実行する
    tauri::async_runtime::spawn_blocking(move || {
        toolbox_extract_archive_blocking(app, archive_path, dest_dir)
    })
    .await
    .map_err(|e| format!("非同期タスク失敗: {}", e))?
}

fn toolbox_extract_archive_blocking(
    app: AppHandle,
    archive_path: String,
    dest_dir: String,
) -> Result<ExtractResult, String> {
    let src = std::path::PathBuf::from(archive_path.trim());
    if !src.is_file() {
        return Err("アーカイブが見つかりません".to_string());
    }
    let dest = std::path::PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("出力先を指定してください".to_string());
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("出力先作成失敗: {}", e))?;

    // 進捗イベントを emit するクロージャ。50ms 程度の間隔でスロットルする。
    let last = std::cell::Cell::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
    let app_clone = app.clone();
    let progress =
        move |files: usize, bytes: u64, total_files: Option<usize>, current_file: Option<&str>| {
            let now = std::time::Instant::now();
            let force = total_files.map_or(false, |t| files == 0 || files == t);
            if !force && now.duration_since(last.get()) < std::time::Duration::from_millis(50) {
                return;
            }
            last.set(now);
            let _ = app_clone.emit(
                "toolbox-extract-progress",
                ExtractProgressPayload {
                    files,
                    bytes,
                    total_files,
                    total_bytes: None,
                    current_file: current_file.map(|s| s.to_string()),
                },
            );
        };

    let fmt = detect_format(&src);
    let (count, bytes, format) = match fmt {
        ArchiveFormat::Zip => {
            let (c, b) = extract_zip(&src, &dest, &progress)?;
            (c, b, "zip")
        }
        ArchiveFormat::Tar => {
            let (c, b) = extract_tar_reader(buffered_file(&src)?, &dest, &progress)?;
            (c, b, "tar")
        }
        ArchiveFormat::TarGz => {
            let r = flate2::read::GzDecoder::new(buffered_file(&src)?);
            let (c, b) = extract_tar_reader(r, &dest, &progress)?;
            (c, b, "tar.gz")
        }
        ArchiveFormat::TarBz2 => {
            let r = bzip2_rs::DecoderReader::new(buffered_file(&src)?);
            let (c, b) = extract_tar_reader(r, &dest, &progress)?;
            (c, b, "tar.bz2")
        }
        ArchiveFormat::TarXz => {
            let v = xz_to_vec(&src)?;
            let (c, b) = extract_tar_reader(std::io::Cursor::new(v), &dest, &progress)?;
            (c, b, "tar.xz")
        }
        ArchiveFormat::TarZst => {
            let r = ruzstd::StreamingDecoder::new(buffered_file(&src)?)
                .map_err(|e| format!("zstd: {}", e))?;
            let (c, b) = extract_tar_reader(r, &dest, &progress)?;
            (c, b, "tar.zst")
        }
        ArchiveFormat::TarLz4 => {
            let r = lz4_flex::frame::FrameDecoder::new(buffered_file(&src)?);
            let (c, b) = extract_tar_reader(r, &dest, &progress)?;
            (c, b, "tar.lz4")
        }
        ArchiveFormat::SevenZ => {
            let (c, b) = extract_7z(&src, &dest, &progress)?;
            (c, b, "7z")
        }
        ArchiveFormat::Cab => {
            let (c, b) = extract_cab(&src, &dest, &progress)?;
            (c, b, "cab")
        }
        ArchiveFormat::Ar => {
            let (c, b) = extract_ar(&src, &dest, &progress)?;
            (c, b, "ar")
        }
        ArchiveFormat::Gz
        | ArchiveFormat::Bz2
        | ArchiveFormat::Xz
        | ArchiveFormat::Zst
        | ArchiveFormat::Lz4 => {
            let (c, b, _p) = extract_single(&src, &dest, fmt)?;
            let label = match fmt {
                ArchiveFormat::Gz => "gz",
                ArchiveFormat::Bz2 => "bz2",
                ArchiveFormat::Xz => "xz",
                ArchiveFormat::Zst => "zst",
                _ => "lz4",
            };
            (c, b, label)
        }
        ArchiveFormat::Unknown => return Err("対応していない拡張子です".to_string()),
    };

    // 完了イベント
    let _ = app.emit(
        "toolbox-extract-progress",
        ExtractProgressPayload {
            files: count,
            bytes,
            total_files: Some(count),
            total_bytes: Some(bytes),
            current_file: None,
        },
    );

    Ok(ExtractResult {
        files: count,
        bytes,
        dest: dest.to_string_lossy().to_string(),
        format: format.to_string(),
    })
}

/// 7z 展開。sevenz_rust2 でファイル全体を展開する。
/// 解凍中はバックグラウンドスレッドで dest ディレクトリを定期ポーリングし、進捗を通知する。
fn extract_7z(
    src: &std::path::Path,
    dest: &std::path::Path,
    progress: &dyn Fn(usize, u64, Option<usize>, Option<&str>),
) -> Result<(usize, u64), String> {
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    progress(0, 0, None, Some("(7z 解凍中…)"));
    let before = count_dir(dest);
    let stop = Arc::new(AtomicBool::new(false));
    let cur_count = Arc::new(AtomicUsize::new(0));
    let cur_bytes = Arc::new(AtomicU64::new(0));
    let stop_t = stop.clone();
    let cur_count_t = cur_count.clone();
    let cur_bytes_t = cur_bytes.clone();
    let dest_t = dest.to_path_buf();
    let before_count = before.0;
    let before_bytes = before.1;
    // dest を 600ms 毎にポーリングして bytes/count を共有変数に書き込む
    let poll_handle = std::thread::spawn(move || {
        while !stop_t.load(Ordering::Relaxed) {
            let (c, b) = count_dir(&dest_t);
            cur_count_t.store(c.saturating_sub(before_count), Ordering::Relaxed);
            cur_bytes_t.store(b.saturating_sub(before_bytes), Ordering::Relaxed);
            // sleep を細切れにして停止に反応しやすくする
            for _ in 0..6 {
                if stop_t.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    });
    // メインスレッドでも 700ms 間隔で progress を発火させる別スレッド
    let stop_e = stop.clone();
    let cur_count_e = cur_count.clone();
    let cur_bytes_e = cur_bytes.clone();
    // progress クロージャはスレッド間で動かせないため、emit はメイン側でループ…
    // → decompress_file はブロッキングなので、別スレッドで decompress を回し、メインは emit を担当する。
    let src_owned = src.to_path_buf();
    let dest_owned = dest.to_path_buf();
    let work = std::thread::spawn(move || -> Result<(), String> {
        sevenz_rust2::decompress_file(&src_owned, &dest_owned).map_err(|e| format!("7z: {}", e))
    });
    let mut last_emit_count = 0usize;
    let mut last_emit_bytes = 0u64;
    while !work.is_finished() {
        std::thread::sleep(std::time::Duration::from_millis(700));
        let c = cur_count_e.load(Ordering::Relaxed);
        let b = cur_bytes_e.load(Ordering::Relaxed);
        if c != last_emit_count || b != last_emit_bytes {
            progress(c, b, None, Some("(7z 解凍中…)"));
            last_emit_count = c;
            last_emit_bytes = b;
        } else {
            // 変化が無くても heartbeat で死活を伝える
            progress(c, b, None, Some("(7z 解凍中…)"));
        }
        let _ = stop_e.clone(); // keep alive
    }
    stop.store(true, Ordering::Relaxed);
    let _ = poll_handle.join();
    let result = work.join().map_err(|_| "7z: thread panic".to_string())?;
    result?;
    let after = count_dir(dest);
    let count = after.0.saturating_sub(before.0);
    let bytes = after.1.saturating_sub(before.1);
    progress(count, bytes, Some(count), None);
    Ok((count, bytes))
}

#[tauri::command]
async fn toolbox_pick_archive(initial: Option<String>) -> Result<Option<String>, String> {
    let mut dlg = rfd::AsyncFileDialog::new()
        .add_filter(
            "アーカイブ",
            &[
                "zip", "jar", "war", "ear", "apk", "aab", "ipa", "xpi", "crx", "whl", "epub",
                "cbz", "odt", "ods", "odp", "odg", "docx", "xlsx", "pptx", "vsix", "nupkg", "tar",
                "tgz", "tbz", "tbz2", "txz", "tzst", "tlz4", "7z", "gz", "bz2", "xz", "lzma",
                "zst", "zstd", "lz4", "cab", "ar", "deb",
            ],
        )
        .add_filter("すべて", &["*"]);
    if let Some(p) = initial {
        let pb = std::path::PathBuf::from(&p);
        if let Some(parent) = pb.parent() {
            if parent.is_dir() {
                dlg = dlg.set_directory(parent);
            }
        }
    }
    Ok(dlg
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string()))
}

// ===== ファイルメタデータ =====

#[derive(serde::Serialize)]
struct MetaEntry {
    label: String,
    value: String,
}

#[derive(serde::Serialize)]
struct FileMetaInfo {
    path: String,
    size: u64,
    mtime: Option<i64>,
    atime: Option<i64>,
    ctime: Option<i64>,
    image_info: Vec<MetaEntry>,
}

#[tauri::command]
fn toolbox_get_file_meta(path: String) -> Result<FileMetaInfo, String> {
    let p = std::path::PathBuf::from(path.trim());
    let md = std::fs::metadata(&p).map_err(|e| format!("メタ取得失敗: {}", e))?;
    fn to_unix(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
        t.ok()
            .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
    }
    let mut img = Vec::new();
    if md.len() < 64 * 1024 * 1024 {
        if let Ok(buf) = std::fs::read(&p) {
            let lower = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            match lower.as_deref() {
                Some("png") => parse_png_meta(&buf, &mut img),
                Some("jpg") | Some("jpeg") => parse_jpeg_meta(&buf, &mut img),
                _ => {}
            }
        }
    }
    Ok(FileMetaInfo {
        path: p.to_string_lossy().to_string(),
        size: md.len(),
        mtime: to_unix(md.modified()),
        atime: to_unix(md.accessed()),
        ctime: to_unix(md.created()),
        image_info: img,
    })
}

fn parse_png_meta(buf: &[u8], out: &mut Vec<MetaEntry>) {
    if buf.len() < 8 || &buf[0..8] != b"\x89PNG\r\n\x1a\n" {
        return;
    }
    let mut i = 8usize;
    while i + 12 <= buf.len() {
        let len = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let typ = &buf[i + 4..i + 8];
        let data_start = i + 8;
        let data_end = match data_start.checked_add(len) {
            Some(v) => v,
            None => break,
        };
        if data_end + 4 > buf.len() {
            break;
        }
        let data = &buf[data_start..data_end];
        match typ {
            b"tEXt" => {
                if let Some(zero) = data.iter().position(|&b| b == 0) {
                    let key = String::from_utf8_lossy(&data[..zero]).to_string();
                    let val = String::from_utf8_lossy(&data[zero + 1..]).to_string();
                    out.push(MetaEntry {
                        label: format!("tEXt:{}", key),
                        value: val,
                    });
                }
            }
            b"iTXt" => {
                if let Some(zero) = data.iter().position(|&b| b == 0) {
                    let key = String::from_utf8_lossy(&data[..zero]).to_string();
                    out.push(MetaEntry {
                        label: format!("iTXt:{}", key),
                        value: format!("({} bytes)", data.len()),
                    });
                }
            }
            b"zTXt" => out.push(MetaEntry {
                label: "zTXt".to_string(),
                value: format!("({} bytes)", data.len()),
            }),
            b"tIME" if data.len() == 7 => {
                let y = u16::from_be_bytes([data[0], data[1]]);
                out.push(MetaEntry {
                    label: "tIME".to_string(),
                    value: format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                        y, data[2], data[3], data[4], data[5], data[6]
                    ),
                });
            }
            b"eXIf" => out.push(MetaEntry {
                label: "eXIf".to_string(),
                value: format!("({} bytes)", data.len()),
            }),
            b"IEND" => break,
            _ => {}
        }
        i = data_end + 4;
    }
}

fn parse_jpeg_meta(buf: &[u8], out: &mut Vec<MetaEntry>) {
    if buf.len() < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return;
    }
    let mut i = 2usize;
    while i + 4 < buf.len() {
        if buf[i] != 0xFF {
            break;
        }
        let mut j = i;
        while j < buf.len() && buf[j] == 0xFF {
            j += 1;
        }
        if j >= buf.len() {
            break;
        }
        let marker = buf[j];
        let header_end = j + 1;
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if (0xD0..=0xD7).contains(&marker) {
            i = header_end;
            continue;
        }
        if header_end + 2 > buf.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([buf[header_end], buf[header_end + 1]]) as usize;
        if seg_len < 2 || header_end + seg_len > buf.len() {
            break;
        }
        let data = &buf[header_end + 2..header_end + seg_len];
        let label = match marker {
            0xE0..=0xEF => format!("APP{}", marker - 0xE0),
            0xFE => "COM".to_string(),
            _ => format!("0x{:02X}", marker),
        };
        if marker == 0xE1 && data.len() > 6 && &data[..6] == b"Exif\0\0" {
            out.push(MetaEntry {
                label: "EXIF".to_string(),
                value: format!("({} bytes)", data.len()),
            });
        } else if (0xE0..=0xEF).contains(&marker) || marker == 0xFE {
            let sample: String = data
                .iter()
                .take(60)
                .map(|&b| {
                    if b.is_ascii_graphic() || b == b' ' {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect();
            out.push(MetaEntry {
                label,
                value: format!("{} bytes: {}", data.len(), sample),
            });
        }
        i = header_end + seg_len;
    }
}

#[tauri::command]
fn toolbox_set_file_times(
    path: String,
    mtime: Option<i64>,
    atime: Option<i64>,
) -> Result<(), String> {
    let p = std::path::PathBuf::from(path.trim());
    let md = std::fs::metadata(&p).map_err(|e| format!("メタ取得失敗: {}", e))?;
    let cur_m = filetime::FileTime::from_last_modification_time(&md);
    let cur_a = filetime::FileTime::from_last_access_time(&md);
    let nm = mtime
        .map(|s| filetime::FileTime::from_unix_time(s, 0))
        .unwrap_or(cur_m);
    let na = atime
        .map(|s| filetime::FileTime::from_unix_time(s, 0))
        .unwrap_or(cur_a);
    filetime::set_file_times(&p, na, nm).map_err(|e| format!("時刻設定失敗: {}", e))?;
    Ok(())
}

#[tauri::command]
fn toolbox_strip_image_meta(path: String, dest: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(path.trim());
    let dst = std::path::PathBuf::from(dest.trim());
    if dst.as_os_str().is_empty() {
        return Err("出力先を指定してください".to_string());
    }
    let buf = std::fs::read(&p).map_err(|e| format!("読込失敗: {}", e))?;
    let lower = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    let cleaned = match lower.as_deref() {
        Some("png") => strip_png(&buf)?,
        Some("jpg") | Some("jpeg") => strip_jpeg(&buf)?,
        _ => return Err("対応形式は PNG / JPEG のみです".to_string()),
    };
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    std::fs::write(&dst, &cleaned).map_err(|e| format!("書込失敗: {}", e))?;
    Ok(dst.to_string_lossy().to_string())
}

fn strip_png(buf: &[u8]) -> Result<Vec<u8>, String> {
    if buf.len() < 8 || &buf[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("PNG ではありません".to_string());
    }
    let mut out = Vec::with_capacity(buf.len());
    out.extend_from_slice(&buf[0..8]);
    let drop: &[&[u8]] = &[b"tEXt", b"iTXt", b"zTXt", b"tIME", b"eXIf", b"iCCP"];
    let mut i = 8usize;
    while i + 12 <= buf.len() {
        let len = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let chunk_total = 4 + 4 + len + 4;
        if i + chunk_total > buf.len() {
            break;
        }
        let typ = &buf[i + 4..i + 8];
        let keep = !drop.iter().any(|d| *d == typ);
        if keep {
            out.extend_from_slice(&buf[i..i + chunk_total]);
        }
        i += chunk_total;
        if typ == b"IEND" {
            break;
        }
    }
    Ok(out)
}

fn strip_jpeg(buf: &[u8]) -> Result<Vec<u8>, String> {
    if buf.len() < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return Err("JPEG ではありません".to_string());
    }
    let mut out = Vec::with_capacity(buf.len());
    out.extend_from_slice(&[0xFF, 0xD8]);
    let mut i = 2usize;
    while i < buf.len() {
        if buf[i] != 0xFF {
            break;
        }
        let mut j = i;
        while j < buf.len() && buf[j] == 0xFF {
            j += 1;
        }
        if j >= buf.len() {
            break;
        }
        let marker = buf[j];
        let header_end = j + 1;
        if marker == 0xD9 {
            out.push(0xFF);
            out.push(0xD9);
            return Ok(out);
        }
        if marker == 0xDA {
            // SOS 以降は生データ、そのままコピー
            out.extend_from_slice(&buf[i..]);
            return Ok(out);
        }
        if (0xD0..=0xD7).contains(&marker) {
            out.push(0xFF);
            out.push(marker);
            i = header_end;
            continue;
        }
        if header_end + 2 > buf.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([buf[header_end], buf[header_end + 1]]) as usize;
        if seg_len < 2 || header_end + seg_len > buf.len() {
            break;
        }
        let drop = matches!(marker, 0xE0..=0xEF | 0xFE);
        if !drop {
            out.push(0xFF);
            out.push(marker);
            out.extend_from_slice(&buf[header_end..header_end + seg_len]);
        }
        i = header_end + seg_len;
    }
    Ok(out)
}

// ===== 音声タグ (lofty: MP3 / WAV / FLAC / OGG / Opus / M4A / AAC / AIFF / APE) =====

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AudioTagData {
    format: String,
    tag_type: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    year: Option<u32>,
    genre: Option<String>,
    composer: Option<String>,
    publisher: Option<String>,
    track: Option<u32>,
    total_tracks: Option<u32>,
    disc: Option<u32>,
    total_discs: Option<u32>,
    bpm: Option<String>,
    key: Option<String>,
    lang: Option<String>,
    isrc: Option<String>,
    encoded_by: Option<String>,
    encoder_settings: Option<String>,
    copyright: Option<String>,
    grouping: Option<String>,
    subtitle: Option<String>,
    conductor: Option<String>,
    remixer: Option<String>,
    orig_artist: Option<String>,
    orig_album: Option<String>,
    url: Option<String>,
    comment: Option<String>,
    lyrics: Option<String>,
    has_picture: bool,
    picture_mime: Option<String>,
    picture_size: Option<usize>,
    duration_secs: Option<u64>,
    bitrate: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
}

fn audio_get_str(tag: &lofty::tag::Tag, key: &lofty::tag::ItemKey) -> Option<String> {
    tag.get_string(key).map(|s| s.to_string())
}

fn mime_to_string(m: Option<&lofty::picture::MimeType>) -> String {
    match m {
        Some(mt) => mt.to_string(),
        None => "application/octet-stream".to_string(),
    }
}

#[tauri::command]
fn toolbox_get_audio_tags(path: String) -> Result<AudioTagData, String> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, ItemKey};
    let p = std::path::PathBuf::from(path.trim());
    let tagged = lofty_read_relaxed(&p)?;
    let mut data = AudioTagData::default();
    data.format = format!("{:?}", tagged.file_type());
    let props = tagged.properties();
    data.duration_secs = Some(props.duration().as_secs());
    data.bitrate = props.audio_bitrate();
    data.sample_rate = props.sample_rate();
    data.channels = props.channels();
    let tag_opt = tagged.primary_tag().or_else(|| tagged.first_tag());
    if let Some(tag) = tag_opt {
        data.tag_type = format!("{:?}", tag.tag_type());
        data.title = tag.title().map(|s| s.to_string());
        data.artist = tag.artist().map(|s| s.to_string());
        data.album = tag.album().map(|s| s.to_string());
        data.genre = tag.genre().map(|s| s.to_string());
        data.year = tag.year();
        data.track = tag.track();
        data.total_tracks = tag.track_total();
        data.disc = tag.disk();
        data.total_discs = tag.disk_total();
        data.comment = tag.comment().map(|s| s.to_string());
        data.album_artist = audio_get_str(tag, &ItemKey::AlbumArtist);
        data.composer = audio_get_str(tag, &ItemKey::Composer);
        data.publisher = audio_get_str(tag, &ItemKey::Publisher);
        data.bpm = audio_get_str(tag, &ItemKey::Bpm);
        data.key = audio_get_str(tag, &ItemKey::InitialKey);
        data.lang = audio_get_str(tag, &ItemKey::Language);
        data.isrc = audio_get_str(tag, &ItemKey::Isrc);
        data.encoded_by = audio_get_str(tag, &ItemKey::EncodedBy);
        data.encoder_settings = audio_get_str(tag, &ItemKey::EncoderSettings);
        data.copyright = audio_get_str(tag, &ItemKey::CopyrightMessage);
        data.grouping = audio_get_str(tag, &ItemKey::ContentGroup);
        data.subtitle = audio_get_str(tag, &ItemKey::TrackSubtitle);
        data.conductor = audio_get_str(tag, &ItemKey::Conductor);
        data.remixer = audio_get_str(tag, &ItemKey::Remixer);
        data.orig_artist = audio_get_str(tag, &ItemKey::OriginalArtist);
        data.orig_album = audio_get_str(tag, &ItemKey::OriginalAlbumTitle);
        data.url = audio_get_str(tag, &ItemKey::AudioFileUrl);
        data.lyrics = audio_get_str(tag, &ItemKey::Lyrics);
        if let Some(pic) = tag.pictures().first() {
            data.has_picture = true;
            data.picture_mime = Some(mime_to_string(pic.mime_type()));
            data.picture_size = Some(pic.data().len());
        }
    }
    Ok(data)
}

fn audio_set_or_remove(tag: &mut lofty::tag::Tag, key: lofty::tag::ItemKey, v: &Option<String>) {
    match v {
        Some(s) if !s.is_empty() => {
            tag.insert_text(key, s.clone());
        }
        _ => {
            tag.remove_key(&key);
        }
    }
}

/// Tag/ピクチャ保存後に Windows Explorer のサムネイルキャッシュを失効させるため
/// ファイルの mtime を now に上書きしてシェルハンドラに再抽出を促す。
fn touch_mtime(p: &std::path::Path) {
    let ft = filetime::FileTime::from_system_time(std::time::SystemTime::now());
    let _ = filetime::set_file_mtime(p, ft);
}

/// 既定の書き込みオプション。lofty 0.22 では `use_id3v23(true)` を MP3 に強制すると
/// 既存タグに含まれる UTF-16 文字列 (日本語タイトル等) が再読み込み時に壊れる
/// 既知の不具合があったため、v2.4 のままにしている。Windows Explorer も
/// ID3v2.4 + JPEG カバーは正常に扱えるので問題はない。
fn write_options_for(_p: &std::path::Path) -> lofty::config::WriteOptions {
    lofty::config::WriteOptions::default()
}

/// `lofty::read_from_path` は厳格モードで読むため、不正な TDRC 年フォーマット等で
/// 既存ファイルが弾かれてしまう (例: tagmp3.net 由来の MP3 で
/// "invalid year length" エラー)。Relaxed パースで読み直してユーザーの編集を許可する。
fn lofty_read_relaxed(p: &std::path::Path) -> Result<lofty::file::TaggedFile, String> {
    use lofty::config::{ParseOptions, ParsingMode};
    use lofty::probe::Probe;
    let opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    Probe::open(p)
        .map_err(|e| format!("音声読込失敗: {}", e))?
        .options(opts)
        .read()
        .map_err(|e| format!("音声読込失敗: {}", e))
}

/// 画像バイトを JPEG に再エンコードする。Windows Explorer の MP3 サムネイルシェルハンドラは
/// PNG カバーを表示しないため、一律に JPEG に揃えておくと互換性が高い。
fn reencode_to_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("画像デコード失敗: {}", e))?;
    // RGBA だと JPEG エンコーダがエラーを出すため RGB に落とす
    let rgb = img.to_rgb8();
    let mut out = std::io::Cursor::new(Vec::<u8>::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG エンコード失敗: {}", e))?;
    Ok(out.into_inner())
}

#[tauri::command]
fn toolbox_save_audio_tags(path: String, data: AudioTagData) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::{Accessor, ItemKey, Tag, TagExt};
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty_read_relaxed(&p)?;
    let primary_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        let _ = tagged.insert_tag(Tag::new(primary_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "タグ作成失敗".to_string())?;

    // Accessor 経由のフィールド
    match &data.title {
        Some(s) if !s.is_empty() => tag.set_title(s.clone()),
        _ => {
            tag.remove_title();
        }
    }
    match &data.artist {
        Some(s) if !s.is_empty() => tag.set_artist(s.clone()),
        _ => {
            tag.remove_artist();
        }
    }
    match &data.album {
        Some(s) if !s.is_empty() => tag.set_album(s.clone()),
        _ => {
            tag.remove_album();
        }
    }
    match &data.genre {
        Some(s) if !s.is_empty() => tag.set_genre(s.clone()),
        _ => {
            tag.remove_genre();
        }
    }
    match data.year {
        Some(y) => tag.set_year(y),
        _ => {
            tag.remove_year();
        }
    }
    match data.track {
        Some(n) => tag.set_track(n),
        _ => {
            tag.remove_track();
        }
    }
    match data.total_tracks {
        Some(n) => tag.set_track_total(n),
        _ => {
            tag.remove_track_total();
        }
    }
    match data.disc {
        Some(n) => tag.set_disk(n),
        _ => {
            tag.remove_disk();
        }
    }
    match data.total_discs {
        Some(n) => tag.set_disk_total(n),
        _ => {
            tag.remove_disk_total();
        }
    }
    match &data.comment {
        Some(s) if !s.is_empty() => tag.set_comment(s.clone()),
        _ => {
            tag.remove_comment();
        }
    }

    // ItemKey 経由のフィールド
    audio_set_or_remove(tag, ItemKey::AlbumArtist, &data.album_artist);
    audio_set_or_remove(tag, ItemKey::Composer, &data.composer);
    audio_set_or_remove(tag, ItemKey::Publisher, &data.publisher);
    audio_set_or_remove(tag, ItemKey::Bpm, &data.bpm);
    audio_set_or_remove(tag, ItemKey::InitialKey, &data.key);
    audio_set_or_remove(tag, ItemKey::Language, &data.lang);
    audio_set_or_remove(tag, ItemKey::Isrc, &data.isrc);
    audio_set_or_remove(tag, ItemKey::EncodedBy, &data.encoded_by);
    audio_set_or_remove(tag, ItemKey::EncoderSettings, &data.encoder_settings);
    audio_set_or_remove(tag, ItemKey::CopyrightMessage, &data.copyright);
    audio_set_or_remove(tag, ItemKey::ContentGroup, &data.grouping);
    audio_set_or_remove(tag, ItemKey::TrackSubtitle, &data.subtitle);
    audio_set_or_remove(tag, ItemKey::Conductor, &data.conductor);
    audio_set_or_remove(tag, ItemKey::Remixer, &data.remixer);
    audio_set_or_remove(tag, ItemKey::OriginalArtist, &data.orig_artist);
    audio_set_or_remove(tag, ItemKey::OriginalAlbumTitle, &data.orig_album);
    audio_set_or_remove(tag, ItemKey::AudioFileUrl, &data.url);
    audio_set_or_remove(tag, ItemKey::Lyrics, &data.lyrics);

    tag.save_to_path(&p, write_options_for(&p))
        .map_err(|e| format!("書込失敗: {}", e))?;
    touch_mtime(&p);
    Ok(())
}

#[tauri::command]
fn toolbox_clear_audio_tags(path: String) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::TagExt;
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty_read_relaxed(&p)?;
    let types: Vec<_> = tagged.tags().iter().map(|t| t.tag_type()).collect();
    for t in types {
        let _ = tagged.remove(t);
    }
    // タグが全て無くなった状態を保存。空の primary を作って書き出す
    let primary_type = tagged.primary_tag_type();
    let empty = lofty::tag::Tag::new(primary_type);
    empty
        .save_to_path(&p, write_options_for(&p))
        .map_err(|e| format!("書込失敗: {}", e))?;
    touch_mtime(&p);
    Ok(())
}

#[tauri::command]
fn toolbox_set_audio_picture(audio_path: String, image_path: String) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::tag::{Tag, TagExt};
    let p = std::path::PathBuf::from(audio_path.trim());
    let img_path = std::path::PathBuf::from(image_path.trim());
    let raw_bytes = std::fs::read(&img_path).map_err(|e| format!("画像読込失敗: {}", e))?;

    // Windows Explorer の MP3 サムネイルシェルハンドラは JPEG のみ確実に表示されるため
    // クロスフォーマット互換を優先して PNG/GIF/BMP/TIFF/WebP も全て JPEG に再エンコードして埋め込む。
    let ext = img_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    let is_mp3 = matches!(
        p.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("mp3") | Some("mp2") | Some("mpga")
    );
    let (bytes, mime) = if is_mp3 && !matches!(ext.as_deref(), Some("jpg") | Some("jpeg")) {
        // MP3 は JPEG に揃える
        (reencode_to_jpeg(&raw_bytes)?, MimeType::Jpeg)
    } else {
        let m = match ext.as_deref() {
            Some("jpg") | Some("jpeg") => MimeType::Jpeg,
            Some("png") => MimeType::Png,
            Some("gif") => MimeType::Gif,
            Some("bmp") => MimeType::Bmp,
            Some("tiff") | Some("tif") => MimeType::Tiff,
            _ => MimeType::Jpeg,
        };
        (raw_bytes, m)
    };
    let pic = Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes);
    let mut tagged = lofty_read_relaxed(&p)?;
    let primary_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        let _ = tagged.insert_tag(Tag::new(primary_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "タグ作成失敗".to_string())?;
    // 既存画像をすべて削除してから追加
    while !tag.pictures().is_empty() {
        let _ = tag.remove_picture(0);
    }
    tag.push_picture(pic);
    tag.save_to_path(&p, write_options_for(&p))
        .map_err(|e| format!("書込失敗: {}", e))?;
    touch_mtime(&p);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPicture {
    data_url: String,
    mime: String,
    size: usize,
}

#[tauri::command]
fn toolbox_get_audio_picture(path: String) -> Result<Option<AudioPicture>, String> {
    use base64::Engine;
    use lofty::file::TaggedFileExt;
    let p = std::path::PathBuf::from(path.trim());
    let tagged = lofty_read_relaxed(&p)?;
    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None => return Ok(None),
    };
    let pic = match tag.pictures().first() {
        Some(p) => p,
        None => return Ok(None),
    };
    let mime = mime_to_string(pic.mime_type());
    let bytes = pic.data();
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(AudioPicture {
        data_url: format!("data:{};base64,{}", mime, b64),
        mime,
        size: bytes.len(),
    }))
}

#[tauri::command]
fn toolbox_remove_audio_picture(path: String) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::TagExt;
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty_read_relaxed(&p)?;
    if let Some(tag) = tagged.primary_tag_mut() {
        while !tag.pictures().is_empty() {
            let _ = tag.remove_picture(0);
        }
        tag.save_to_path(&p, write_options_for(&p))
            .map_err(|e| format!("書込失敗: {}", e))?;
        touch_mtime(&p);
    }
    Ok(())
}

// ===== 汎用メタデータ (PDF / OOXML / EPUB / HTML / 動画概要 / PE / ELF / Mach-O / APK / ISO) =====

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GenericField {
    key: String,
    value: String,
    #[serde(default)]
    editable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenericMeta {
    kind: String,
    editable: bool,
    fields: Vec<GenericField>,
    info: String,
}

fn detect_generic_kind(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("pdf") => "pdf",
        Some("docx") => "docx",
        Some("xlsx") => "xlsx",
        Some("pptx") => "pptx",
        Some("epub") => "epub",
        Some("html") | Some("htm") | Some("xhtml") => "html",
        Some("mp4") | Some("m4v") | Some("mov") => "mp4",
        Some("mkv") | Some("webm") => "mkv",
        Some("exe") | Some("dll") | Some("sys") | Some("ocx") => "pe",
        Some("apk") => "apk",
        Some("iso") => "iso",
        _ => {
            // マジックナンバーで判定 (拡張子が無い ELF / Mach-O 用)
            if let Ok(mut f) = std::fs::File::open(path) {
                use std::io::Read;
                let mut head = [0u8; 16];
                if f.read(&mut head).is_ok() {
                    if head.starts_with(&[0x7f, b'E', b'L', b'F']) {
                        return "elf";
                    }
                    let m = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
                    if matches!(
                        m,
                        0xFEEDFACE | 0xFEEDFACF | 0xCEFAEDFE | 0xCFFAEDFE | 0xCAFEBABE
                    ) {
                        return "macho";
                    }
                }
            }
            "unknown"
        }
    }
}

// ---- PDF (lopdf) ----

const PDF_INFO_KEYS: &[&str] = &[
    "Title",
    "Author",
    "Subject",
    "Keywords",
    "Creator",
    "Producer",
    "CreationDate",
    "ModDate",
];

fn read_pdf_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let doc = lopdf::Document::load(path).map_err(|e| format!("PDF 読込失敗: {}", e))?;
    let mut fields = Vec::new();
    let info_id = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|v| v.as_reference().ok());
    if let Some(id) = info_id {
        if let Ok(obj) = doc.get_object(id) {
            if let Ok(dict) = obj.as_dict() {
                for k in PDF_INFO_KEYS {
                    let v = dict.get(k.as_bytes()).ok().and_then(|o| match o {
                        lopdf::Object::String(s, _) => String::from_utf8(s.clone()).ok(),
                        _ => None,
                    });
                    fields.push(GenericField {
                        key: k.to_string(),
                        value: v.unwrap_or_default(),
                        editable: true,
                    });
                }
            }
        }
    } else {
        for k in PDF_INFO_KEYS {
            fields.push(GenericField {
                key: k.to_string(),
                value: String::new(),
                editable: true,
            });
        }
    }
    let info = format!(
        "PDF version: {}\nPages: {}",
        doc.version,
        doc.get_pages().len()
    );
    Ok(GenericMeta {
        kind: "pdf".to_string(),
        editable: true,
        fields,
        info,
    })
}

fn write_pdf_meta(path: &std::path::Path, fields: &[GenericField]) -> Result<(), String> {
    let mut doc = lopdf::Document::load(path).map_err(|e| format!("PDF 読込失敗: {}", e))?;
    let info_id = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|v| v.as_reference().ok());
    let new_id = if let Some(id) = info_id {
        if let Ok(obj) = doc.get_object_mut(id) {
            if let Ok(dict) = obj.as_dict_mut() {
                for f in fields {
                    if f.value.is_empty() {
                        dict.remove(f.key.as_bytes());
                    } else {
                        dict.set(
                            f.key.as_bytes().to_vec(),
                            lopdf::Object::string_literal(f.value.clone()),
                        );
                    }
                }
            }
        }
        id
    } else {
        let mut dict = lopdf::Dictionary::new();
        for f in fields {
            if !f.value.is_empty() {
                dict.set(
                    f.key.as_bytes().to_vec(),
                    lopdf::Object::string_literal(f.value.clone()),
                );
            }
        }
        let id = doc.add_object(lopdf::Object::Dictionary(dict));
        doc.trailer.set("Info", lopdf::Object::Reference(id));
        id
    };
    let _ = new_id;
    doc.save(path).map_err(|e| format!("PDF 書込失敗: {}", e))?;
    Ok(())
}

// ---- ZIP コンテナ共通 (OOXML / EPUB) ----

fn zip_read_entry(path: &std::path::Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("zip: {}", e))?;
    let mut buf = Vec::new();
    let found = match z.by_name(name) {
        Ok(mut e) => {
            use std::io::Read;
            e.read_to_end(&mut buf)
                .map_err(|e| format!("read: {}", e))?;
            true
        }
        Err(_) => false,
    };
    if found {
        Ok(Some(buf))
    } else {
        Ok(None)
    }
}

fn zip_replace_entry(
    path: &std::path::Path,
    target_name: &str,
    new_content: &[u8],
) -> Result<(), String> {
    let f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut src = zip::ZipArchive::new(f).map_err(|e| format!("zip: {}", e))?;
    let tmp = path.with_extension("yuzu_tmp.zip");
    {
        let out = std::fs::File::create(&tmp).map_err(|e| format!("tmp: {}", e))?;
        let mut zw = zip::ZipWriter::new(out);
        let opts: zip::write::FileOptions =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut wrote_target = false;
        for i in 0..src.len() {
            let mut e = src.by_index(i).map_err(|e| format!("entry: {}", e))?;
            let name = e.name().to_string();
            if name == target_name {
                zw.start_file(name.clone(), opts)
                    .map_err(|e| format!("start: {}", e))?;
                use std::io::Write;
                zw.write_all(new_content)
                    .map_err(|e| format!("write: {}", e))?;
                wrote_target = true;
            } else {
                zw.start_file(name, opts)
                    .map_err(|e| format!("start: {}", e))?;
                std::io::copy(&mut e, &mut zw).map_err(|e| format!("copy: {}", e))?;
            }
        }
        if !wrote_target {
            zw.start_file(target_name.to_string(), opts)
                .map_err(|e| format!("start: {}", e))?;
            use std::io::Write;
            zw.write_all(new_content)
                .map_err(|e| format!("write: {}", e))?;
        }
        zw.finish().map_err(|e| format!("finish: {}", e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

// XML 内 <ns:tag>...</ns:tag> または <tag>...</tag> の中身を抜き出す簡易パーサ
fn xml_extract_text(xml: &str, local_name: &str) -> Option<String> {
    // <... local_name>VALUE</... local_name>
    let needle = format!("{}>", local_name);
    let mut from = 0;
    while let Some(open) = xml[from..].find(&needle) {
        let abs = from + open + needle.len();
        // タグ閉じ '>' の直前が '/' (self-closing) の場合スキップ
        let before = &xml[..from + open + local_name.len()];
        if before.ends_with('/') {
            from = abs;
            continue;
        }
        // 終了タグを探す
        let close_needle = format!("</");
        if let Some(close_rel) = xml[abs..].find(&close_needle) {
            let close_abs = abs + close_rel;
            // 閉じタグが local_name と一致するか確認
            let tail = &xml[close_abs..];
            if tail.contains(&format!("{}>", local_name)) {
                return Some(decode_xml_entities(&xml[abs..close_abs]));
            }
        }
        from = abs;
    }
    None
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn encode_xml_entities(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// 既存の <ns:local>...</ns:local> を新値で置換、無ければ末尾の </root> 直前に追加
fn xml_set_text(xml: &str, ns_prefix: &str, local: &str, value: &str) -> String {
    let opening_tag = format!("{}:{}", ns_prefix, local);
    // まず ns 付き、なければローカルのみ
    let candidates = if !ns_prefix.is_empty() {
        vec![opening_tag.clone(), local.to_string()]
    } else {
        vec![local.to_string()]
    };
    for cand in &candidates {
        let needle = format!("<{}", cand);
        if let Some(start) = xml.find(&needle) {
            // タグ閉じ '>' を探す
            if let Some(rel_close) = xml[start..].find('>') {
                let after_open = start + rel_close + 1;
                let before_open = &xml[start..after_open];
                if before_open.ends_with("/>") {
                    // self-closing: 置換
                    let new_tag = if value.is_empty() {
                        format!("<{}/>", cand)
                    } else {
                        format!("<{}>{}</{}>", cand, encode_xml_entities(value), cand)
                    };
                    let mut out = String::new();
                    out.push_str(&xml[..start]);
                    out.push_str(&new_tag);
                    out.push_str(&xml[after_open..]);
                    return out;
                }
                let close_needle = format!("</{}>", cand);
                if let Some(rel_end) = xml[after_open..].find(&close_needle) {
                    let end_abs = after_open + rel_end;
                    let close_end = end_abs + close_needle.len();
                    let mut out = String::new();
                    out.push_str(&xml[..after_open]);
                    out.push_str(&encode_xml_entities(value));
                    out.push_str(&xml[end_abs..close_end]);
                    out.push_str(&xml[close_end..]);
                    return out;
                }
            }
        }
    }
    // 無ければ最後の閉じタグ直前に挿入
    let tag_to_add = if ns_prefix.is_empty() {
        local.to_string()
    } else {
        opening_tag
    };
    if value.is_empty() {
        return xml.to_string();
    }
    if let Some(last_close) = xml.rfind("</") {
        let mut out = String::new();
        out.push_str(&xml[..last_close]);
        out.push_str(&format!(
            "<{}>{}</{}>",
            tag_to_add,
            encode_xml_entities(value),
            tag_to_add
        ));
        out.push_str(&xml[last_close..]);
        return out;
    }
    xml.to_string()
}

const OOXML_CORE_KEYS: &[(&str, &str)] = &[
    ("dc:title", "title"),
    ("dc:subject", "subject"),
    ("dc:creator", "creator"),
    ("dc:description", "description"),
    ("cp:keywords", "keywords"),
    ("cp:lastModifiedBy", "lastModifiedBy"),
    ("cp:category", "category"),
    ("cp:contentStatus", "contentStatus"),
    ("cp:revision", "revision"),
    ("dcterms:created", "created"),
    ("dcterms:modified", "modified"),
];

fn read_ooxml_meta(path: &std::path::Path, kind: &str) -> Result<GenericMeta, String> {
    let xml_bytes = zip_read_entry(path, "docProps/core.xml")?
        .ok_or_else(|| "docProps/core.xml が見つかりません".to_string())?;
    let xml = String::from_utf8_lossy(&xml_bytes).to_string();
    let mut fields = Vec::new();
    for (full, local) in OOXML_CORE_KEYS {
        let v = xml_extract_text(&xml, full)
            .or_else(|| xml_extract_text(&xml, local))
            .unwrap_or_default();
        fields.push(GenericField {
            key: full.to_string(),
            value: v,
            editable: true,
        });
    }
    Ok(GenericMeta {
        kind: kind.to_string(),
        editable: true,
        fields,
        info: "OOXML core.xml".to_string(),
    })
}

fn write_ooxml_meta(path: &std::path::Path, fields: &[GenericField]) -> Result<(), String> {
    let mut xml = match zip_read_entry(path, "docProps/core.xml")? {
        Some(b) => String::from_utf8_lossy(&b).to_string(),
        None => {
            // 最低限の core.xml スケルトン
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>"#
                .to_string()
        }
    };
    for f in fields {
        let mut parts = f.key.splitn(2, ':');
        let prefix = parts.next().unwrap_or("");
        let local = parts.next().unwrap_or(prefix);
        let (px, lc) = if local == prefix {
            ("", local)
        } else {
            (prefix, local)
        };
        xml = xml_set_text(&xml, px, lc, &f.value);
    }
    zip_replace_entry(path, "docProps/core.xml", xml.as_bytes())
}

// ---- EPUB ----

fn epub_opf_path(path: &std::path::Path) -> Result<String, String> {
    let container = zip_read_entry(path, "META-INF/container.xml")?
        .ok_or_else(|| "META-INF/container.xml が見つかりません".to_string())?;
    let s = String::from_utf8_lossy(&container);
    // <rootfile full-path="..." 属性
    if let Some(idx) = s.find("full-path=\"") {
        let start = idx + "full-path=\"".len();
        if let Some(end_rel) = s[start..].find('"') {
            return Ok(s[start..start + end_rel].to_string());
        }
    }
    Err("OPF の場所が判定できません".to_string())
}

const EPUB_KEYS: &[&str] = &[
    "title",
    "creator",
    "language",
    "publisher",
    "description",
    "subject",
    "rights",
    "date",
    "identifier",
];

fn read_epub_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let opf = epub_opf_path(path)?;
    let xml_bytes =
        zip_read_entry(path, &opf)?.ok_or_else(|| "OPF が見つかりません".to_string())?;
    let xml = String::from_utf8_lossy(&xml_bytes).to_string();
    let mut fields = Vec::new();
    for k in EPUB_KEYS {
        let dc = format!("dc:{}", k);
        let v = xml_extract_text(&xml, &dc).unwrap_or_default();
        fields.push(GenericField {
            key: dc,
            value: v,
            editable: true,
        });
    }
    Ok(GenericMeta {
        kind: "epub".to_string(),
        editable: true,
        fields,
        info: format!("OPF: {}", opf),
    })
}

fn write_epub_meta(path: &std::path::Path, fields: &[GenericField]) -> Result<(), String> {
    let opf = epub_opf_path(path)?;
    let bytes = zip_read_entry(path, &opf)?.ok_or_else(|| "OPF が見つかりません".to_string())?;
    let mut xml = String::from_utf8_lossy(&bytes).to_string();
    for f in fields {
        let local = f.key.strip_prefix("dc:").unwrap_or(&f.key);
        xml = xml_set_text(&xml, "dc", local, &f.value);
    }
    zip_replace_entry(path, &opf, xml.as_bytes())
}

// ---- HTML <meta> ----

fn read_html_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut fields = Vec::new();
    // <title>...</title>
    if let Some(t) = xml_extract_text(&s, "title") {
        fields.push(GenericField {
            key: "title".to_string(),
            value: t,
            editable: true,
        });
    } else {
        fields.push(GenericField {
            key: "title".to_string(),
            value: String::new(),
            editable: true,
        });
    }
    // <meta name="..." content="..."> と <meta property="..." content="...">
    let lower = s.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<meta") {
        let start = from + rel;
        if let Some(end_rel) = s[start..].find('>') {
            let tag = &s[start..start + end_rel + 1];
            let name = extract_attr(tag, "name").or_else(|| extract_attr(tag, "property"));
            let content = extract_attr(tag, "content");
            if let (Some(n), Some(c)) = (name, content) {
                fields.push(GenericField {
                    key: format!("meta:{}", n),
                    value: c,
                    editable: true,
                });
            }
            from = start + end_rel + 1;
        } else {
            break;
        }
    }
    Ok(GenericMeta {
        kind: "html".to_string(),
        editable: true,
        fields,
        info: format!("{} 文字", s.len()),
    })
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}=", attr);
    let pos = lower.find(&needle)?;
    let after = &tag[pos + needle.len()..];
    let chars: Vec<char> = after.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let q = chars[0];
    if q == '"' || q == '\'' {
        let rest: String = chars.iter().skip(1).collect();
        let end = rest.find(q)?;
        Some(decode_xml_entities(&rest[..end]))
    } else {
        // 引用符なし
        let end = after
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(after.len());
        Some(decode_xml_entities(&after[..end]))
    }
}

fn write_html_meta(path: &std::path::Path, fields: &[GenericField]) -> Result<(), String> {
    let mut s = std::fs::read_to_string(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut new_metas: Vec<(String, String)> = Vec::new();
    for f in fields {
        if f.key == "title" {
            // <title> 置換 / 挿入
            let rebuilt = xml_set_text(&s, "", "title", &f.value);
            s = rebuilt;
        } else if let Some(n) = f.key.strip_prefix("meta:") {
            // 既存 <meta name=n ...> を削除、新値があれば追加
            s = remove_meta_with_name(&s, n);
            if !f.value.is_empty() {
                new_metas.push((n.to_string(), f.value.clone()));
            }
        }
    }
    if !new_metas.is_empty() {
        let inject: String = new_metas
            .iter()
            .map(|(n, v)| {
                format!(
                    "<meta name=\"{}\" content=\"{}\">",
                    encode_xml_entities(n),
                    encode_xml_entities(v)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        // </head> 直前 / なければ先頭
        if let Some(idx) = s.to_ascii_lowercase().find("</head>") {
            let mut out = String::new();
            out.push_str(&s[..idx]);
            out.push_str(&inject);
            out.push('\n');
            out.push_str(&s[idx..]);
            s = out;
        } else {
            s = format!("{}\n{}", inject, s);
        }
    }
    std::fs::write(path, s).map_err(|e| format!("書込失敗: {}", e))?;
    Ok(())
}

fn remove_meta_with_name(html: &str, name: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::new();
    let mut from = 0;
    let target = name.to_ascii_lowercase();
    loop {
        let rel = match lower[from..].find("<meta") {
            Some(p) => p,
            None => {
                out.push_str(&html[from..]);
                return out;
            }
        };
        let start = from + rel;
        let end = match html[start..].find('>') {
            Some(p) => start + p + 1,
            None => {
                out.push_str(&html[from..]);
                return out;
            }
        };
        let tag = &html[start..end];
        let n = extract_attr(tag, "name")
            .or_else(|| extract_attr(tag, "property"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if n == target {
            // タグを丸ごと削除 (前の改行も食う)
            out.push_str(&html[from..start]);
            // 直後の改行を1つ食う
            let mut tail_start = end;
            if html[tail_start..].starts_with("\r\n") {
                tail_start += 2;
            } else if html[tail_start..].starts_with('\n') {
                tail_start += 1;
            }
            from = tail_start;
        } else {
            out.push_str(&html[from..end]);
            from = end;
        }
    }
}

// ---- 動画 (MP4/MOV は lofty 経由、MKV/WebM は概要のみ) ----

fn read_video_meta(path: &std::path::Path, kind: &str) -> Result<GenericMeta, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("メタ取得失敗: {}", e))?;
    let mut info = format!("Size: {} bytes\n", md.len());
    if kind == "mp4" {
        // lofty 試行
        if let Ok(tagged) = lofty_read_relaxed(path.as_ref()) {
            use lofty::file::{AudioFile, TaggedFileExt};
            let props = tagged.properties();
            info.push_str(&format!("Duration: {} sec\n", props.duration().as_secs()));
            if let Some(b) = props.audio_bitrate() {
                info.push_str(&format!("Audio bitrate: {} kbps\n", b));
            }
            if let Some(c) = props.channels() {
                info.push_str(&format!("Channels: {}\n", c));
            }
            // 音声タグ側で編集可能
            info.push_str("\nMP4 のタイトル等は上の「音声タグ」パネルで編集できます。");
            let tag_type = tagged
                .primary_tag()
                .map(|t| format!("{:?}", t.tag_type()))
                .unwrap_or_else(|| "(none)".to_string());
            info.push_str(&format!("\nTag: {}", tag_type));
        }
    } else {
        // MKV/WebM: EBML ヘッダから簡易情報
        if let Ok(mut f) = std::fs::File::open(path) {
            use std::io::Read;
            let mut buf = vec![0u8; 4096.min(md.len() as usize)];
            let _ = f.read(&mut buf);
            // タイトル (Segment Information の Title 0x7BA9) を超簡易検索
            for win in buf.windows(2) {
                if win == [0x7B, 0xA9] {
                    info.push_str("Title 要素を含む (詳細パースは未実装)\n");
                    break;
                }
            }
            info.push_str("MKV/WebM の編集は未対応 (読み取りのみ)。");
        }
    }
    Ok(GenericMeta {
        kind: kind.to_string(),
        editable: false,
        fields: Vec::new(),
        info,
    })
}

// ---- PE EXE/DLL (pelite で VS_VERSION_INFO を読み取り) ----

macro_rules! collect_pe_vi {
    ($pe:expr, $fields:expr, $info:expr) => {{
        if let Ok(resources) = $pe.resources() {
            if let Ok(vi) = resources.version_info() {
                if let Some(fixed) = vi.fixed() {
                    let v = fixed.dwFileVersion;
                    $info.push_str(&format!(
                        "FileVersion: {}.{}.{}.{}\n",
                        v.Major, v.Minor, v.Patch, v.Build
                    ));
                    let p = fixed.dwProductVersion;
                    $info.push_str(&format!(
                        "ProductVersion: {}.{}.{}.{}\n",
                        p.Major, p.Minor, p.Patch, p.Build
                    ));
                }
                for lang in vi.translation() {
                    $info.push_str(&format!(
                        "Lang: {:04x}-{:04x}\n",
                        lang.lang_id, lang.charset_id
                    ));
                    vi.strings(*lang, |k, v| {
                        $fields.push(GenericField {
                            key: k.to_string(),
                            value: v.to_string(),
                            editable: false,
                        });
                    });
                }
            } else {
                $info.push_str("VersionInfo なし\n");
            }
        } else {
            $info.push_str("リソースなし\n");
        }
    }};
}

fn read_pe_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("PE 読込失敗: {}", e))?;
    let mut fields = Vec::new();
    let mut info = String::new();
    match pelite::PeFile::from_bytes(&bytes) {
        Ok(pelite::Wrap::T64(pe)) => {
            info.push_str("Format: PE32+\n");
            use pelite::pe64::Pe;
            collect_pe_vi!(pe, fields, info);
        }
        Ok(pelite::Wrap::T32(pe)) => {
            info.push_str("Format: PE32\n");
            use pelite::pe32::Pe;
            collect_pe_vi!(pe, fields, info);
        }
        Err(e) => {
            info.push_str(&format!("PE パース失敗: {}\n", e));
        }
    }
    Ok(GenericMeta {
        kind: "pe".to_string(),
        editable: false,
        fields,
        info,
    })
}

// ---- ELF / Mach-O / APK / ISO 簡易表示 ----

fn read_elf_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut head = [0u8; 20];
    f.read_exact(&mut head).map_err(|e| format!("ELF: {}", e))?;
    let class = if head[4] == 1 { "ELF32" } else { "ELF64" };
    let endian = if head[5] == 1 { "little" } else { "big" };
    let osabi = head[7];
    let etype = u16::from_le_bytes([head[16], head[17]]);
    let machine = u16::from_le_bytes([head[18], head[19]]);
    let etype_s = match etype {
        1 => "REL",
        2 => "EXEC",
        3 => "DYN",
        4 => "CORE",
        _ => "?",
    };
    let info = format!(
        "{} ({} endian)\nOS/ABI: {}\nType: {}\nMachine: 0x{:04x}",
        class, endian, osabi, etype_s, machine
    );
    Ok(GenericMeta {
        kind: "elf".to_string(),
        editable: false,
        fields: Vec::new(),
        info,
    })
}

fn read_macho_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    let mut head = [0u8; 16];
    f.read_exact(&mut head)
        .map_err(|e| format!("Mach-O: {}", e))?;
    let magic = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    let kind = match magic {
        0xFEEDFACE => "Mach-O 32 BE",
        0xFEEDFACF => "Mach-O 64 BE",
        0xCEFAEDFE => "Mach-O 32 LE",
        0xCFFAEDFE => "Mach-O 64 LE",
        0xCAFEBABE => "FAT (Universal)",
        _ => "Unknown",
    };
    Ok(GenericMeta {
        kind: "macho".to_string(),
        editable: false,
        fields: Vec::new(),
        info: format!("Magic: 0x{:08X} ({})", magic, kind),
    })
}

fn read_apk_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    let z = zip::ZipArchive::new(f).map_err(|e| format!("apk: {}", e))?;
    let mut info = format!("Entries: {}\n", z.len());
    let names: Vec<String> = (0..z.len().min(20))
        .filter_map(|i| {
            let mut z = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
            z.by_index(i).ok().map(|e| e.name().to_string())
        })
        .collect();
    info.push_str("先頭エントリ:\n");
    for n in names {
        info.push_str(&format!("  {}\n", n));
    }
    info.push_str("\nAndroidManifest.xml は AXML バイナリ形式のため、現状は未パースです。");
    Ok(GenericMeta {
        kind: "apk".to_string(),
        editable: false,
        fields: Vec::new(),
        info,
    })
}

fn read_iso_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("読込失敗: {}", e))?;
    // Primary Volume Descriptor は 16 セクタ目 (32768)
    f.seek(SeekFrom::Start(32768))
        .map_err(|e| format!("ISO seek: {}", e))?;
    let mut buf = [0u8; 256];
    f.read_exact(&mut buf)
        .map_err(|e| format!("ISO read: {}", e))?;
    let info = if &buf[1..6] == b"CD001" {
        let vol_id = String::from_utf8_lossy(&buf[40..72]).trim().to_string();
        format!("ISO 9660\nVolume ID: {}", vol_id)
    } else {
        "ISO 9660 シグネチャが見つかりません".to_string()
    };
    Ok(GenericMeta {
        kind: "iso".to_string(),
        editable: false,
        fields: Vec::new(),
        info,
    })
}

#[tauri::command]
fn toolbox_get_generic_meta(path: String) -> Result<GenericMeta, String> {
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_file() {
        return Err("ファイルが見つかりません".to_string());
    }
    let kind = detect_generic_kind(&p);
    match kind {
        "pdf" => read_pdf_meta(&p),
        "docx" | "xlsx" | "pptx" => read_ooxml_meta(&p, kind),
        "epub" => read_epub_meta(&p),
        "html" => read_html_meta(&p),
        "mp4" | "mkv" => read_video_meta(&p, kind),
        "pe" => read_pe_meta(&p),
        "elf" => read_elf_meta(&p),
        "macho" => read_macho_meta(&p),
        "apk" => read_apk_meta(&p),
        "iso" => read_iso_meta(&p),
        _ => Ok(GenericMeta {
            kind: "unknown".to_string(),
            editable: false,
            fields: Vec::new(),
            info: "対応していない形式です (上の他パネルで扱える可能性があります)".to_string(),
        }),
    }
}

#[tauri::command]
fn toolbox_save_generic_meta(path: String, fields: Vec<GenericField>) -> Result<(), String> {
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_file() {
        return Err("ファイルが見つかりません".to_string());
    }
    let kind = detect_generic_kind(&p);
    match kind {
        "pdf" => write_pdf_meta(&p, &fields),
        "docx" | "xlsx" | "pptx" => write_ooxml_meta(&p, &fields),
        "epub" => write_epub_meta(&p, &fields),
        "html" => write_html_meta(&p, &fields),
        _ => Err("この形式は書き込み未対応です".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 が起動する前に前回の異常終了状態を掃除する。
    // setup クロージャ内では WebView2 の初期化が進行中のため、
    // そこで taskkill すると新しいヘルパーを殺してフリーズする。
    pre_init_recover();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(BookmarkStore::default())
        .manage(HistoryStore::default())
        .manage(ToolboxState::default())
        .manage(TerminalState::default())
        .manage(DownloadState::default())
        .manage(ScreenshotState::default())
        .manage(ActiveHtmlState::default())
        .invoke_handler(tauri::generate_handler![
            tab_new,
            tab_close,
            tab_switch,
            tab_list,
            tab_duplicate,
            tab_reopen,
            tab_close_others,
            tab_close_right,
            tab_reorder,
            tab_detach,
            tab_drop_target_pid,
            tab_attach,
            tab_drop_target_window,
            tab_reattach,
            chrome_ready,
            show_tab_context_menu,
            browser_navigate,
            browser_history,
            browser_url_changed,
            browser_title_changed,
            browser_audible_changed,
            browser_favicon_changed,
            tab_get_volume,
            tab_set_volume,
            tab_get_zoom,
            browser_zoom_delta,
            browser_zoom_set,
            active_tab_zoom_delta,
            active_tab_zoom_set,
            tab_eval_script,
            capture_active_page,
            ui_set_expanded,
            ui_set_popup_region,
            toast_set_size,
            toast_hide,
            view_set_fullscreen,
            view_set_volume_boost,
            toolbox_settings_get,
            toolbox_settings_set,
            bookmarks_list,
            bookmarks_add,
            bookmarks_remove,
            bookmarks_remove_url,
            bookmarks_reorder,
            bookmarks_update,
            history_list,
            history_search,
            history_delete,
            history_clear,
            toolbox_pick_download_dir,
            toolbox_default_download_dir,
            toolbox_ytdlp_run,
            toolbox_ytdlp_cancel,
            toolbox_open_path,
            toolbox_pick_file,
            toolbox_convert_run,
            toolbox_convert_cancel,
            toolbox_save_page_html,
            toolbox_save_active_page_html,
            view_get_active_html,
            report_active_html,
            view_set_reader_mode,
            toolbox_screenshot,
            toolbox_screenshot_full_page,
            toolbox_save_data_url,
            report_page_metrics,
            toolbox_scrape_fetch,
            toolbox_extract_archive,
            toolbox_pick_archive,
            toolbox_get_file_meta,
            toolbox_set_file_times,
            toolbox_strip_image_meta,
            toolbox_get_audio_tags,
            toolbox_save_audio_tags,
            toolbox_clear_audio_tags,
            toolbox_set_audio_picture,
            toolbox_get_audio_picture,
            toolbox_remove_audio_picture,
            toolbox_get_generic_meta,
            toolbox_save_generic_meta,
            pentest_port_scan,
            pentest_http_request,
            speedtest_download,
            speedtest_upload,
            speedtest_ping,
            terminal_spawn,
            terminal_write,
            terminal_kill,
            terminal_list,
            terminal_spawn_command,
            ssh_list_keys,
            ssh_read_pubkey,
            ssh_generate_key,
            ssh_import_key,
            ssh_delete_key,
            ssh_list_hosts,
            ssh_save_host,
            ssh_delete_host,
            ssh_open_dir,
            downloads_list,
            downloads_clear,
            downloads_remove,
            downloads_open_file,
            downloads_show_in_folder,
            downloads_open_folder,
            downloads_compute_hash,
            downloads_save_url,
            downloads_curl_for,
            downloads_hex_preview,
            downloads_verify_hash,
        ])
        .setup(|app| {
            recover_from_dirty_shutdown(app.handle());

            // ウィンドウ間タブ転送用の TCP IPC を起動する。
            match ipc_spawn_listener(app.handle().clone()) {
                Ok(port) => {
                    if let Err(e) = ipc_write_self_port(port) {
                        eprintln!("ipc registry write failed: {e}");
                    }
                }
                Err(e) => eprintln!("ipc listener bind failed: {e}"),
            }
            // 広告ブロック用 hosts リストをバックグラウンドでロード/取得。
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                crate::adblock::init(dir);
            }
            // ツールボックス設定をロード。
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("toolbox.json");
                let mut settings = ToolboxSettings::load(&path);
                if settings.download_dir.is_empty() {
                    if let Some(d) = default_download_dir() {
                        settings.download_dir = d.to_string_lossy().to_string();
                    }
                }
                let state: State<'_, ToolboxState> = app.state();
                if let Ok(mut s) = state.0.lock() {
                    s.settings = settings;
                    s.path = Some(path);
                };
            }
            // ダウンロード履歴をロード。
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("downloads.json");
                let store = DownloadStateInner::load(path);
                let state: State<'_, DownloadState> = app.state();
                if let Ok(mut s) = state.0.lock() {
                    *s = store;
                };
            }
            // ブックマークをロード。
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("bookmarks.json");
                let store = BookmarkStoreInner::load(path);
                let state: State<'_, BookmarkStore> = app.state();
                if let Ok(mut s) = state.0.lock() {
                    *s = store;
                };
            }
            // 閑覧履歴をロード。
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("history.json");
                let store = HistoryStoreInner::load(path);
                let state: State<'_, HistoryStore> = app.state();
                if let Ok(mut s) = state.0.lock() {
                    *s = store;
                };
            }

            let initial_w: f64 = 1100.0;
            let initial_h: f64 = 720.0;

            let window = WindowBuilder::new(app, "main")
                .title("yuzu-browser")
                .inner_size(initial_w, initial_h)
                .background_color(tauri::window::Color(26, 26, 26, 255))
                .resizable(true)
                .build()?;
            // ウィンドウアイコンは tauri.conf.json の bundle.icon （icons/yuzu-browser.ico）から
            // ビルド時に exe に焼き込まれ、Windows ではそれが自動的にウィンドウアイコンになる。

            // UI（アドレスバー＋タブバー）。
            // disable_drag_drop_handler() で Tauri の OS ドラッグ&ドロップ横取りを止め、
            // HTML5 の dragover/drop イベントを JS 側に届くようにする (タブバーへの URL ドロップ用)。
            let app_for_chrome = app.handle().clone();
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::default())
                    .additional_browser_args(
                        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MiddleClickAutoscroll",
                    )
                    .disable_drag_drop_handler()
                    .on_page_load(move |wv, _payload| {
                        let win_label = wv.window().label().to_string();
                        let s_state: State<'_, AppState> = app_for_chrome.state();
                        // try_lock: setup が AppState を保持中でも deadlock しない。
                        let guard = s_state.0.try_lock();
                        if let Ok(s) = guard {
                            let summary = s.summary_for(&win_label);
                            eprintln!(
                                "[on_page_load] chrome={} window={} -> emit {} tabs",
                                wv.label(),
                                win_label,
                                summary.len()
                            );
                            let _ = app_for_chrome.emit_to(
                                chrome_label_for(&win_label),
                                "tabs-updated",
                                summary,
                            );
                        }
                    })
                    .transparent(true),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(initial_w, CHROME_HEIGHT),
            )?;

            // ダウンロードトースト用 webview の生成は起動後に遅延する。
            // 起動時に chrome + 初期タブ + toast を同時に作ると、Windows の
            // WebView2 が初期化レースで応答停止する事象があるため、
            // 初期タブが落ち着いてからメインスレッドで生やす。
            // create は後段の setup 末尾で `spawn_toast_webview` を呼ぶ。

            // 初期タブを 1 つ作成。
            // ★ 重要: AppState ロックを保持したまま add_child (create_view) を呼ぶと、
            //   add_child 中に "ui" chrome の on_page_load が発火し、そこで
            //   AppState.lock() を取ろうとしてデッドロックする。
            //   id と url だけ先にロック内で確定 → ロック解放 → create_view → 再ロックで更新。
            let app_handle = app.handle().clone();
            let state: State<'_, AppState> = app.state();
            let (initial_id, initial_url) = {
                let mut s = state.0.lock().expect("state poisoned");
                s.next_id += 1;
                let id = s.next_id;
                let url = std::env::var("YUZU_INITIAL_URL")
                    .ok()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| HOME_URL.to_string());
                (id, url)
                // ← ここでロック解放
            };
            create_view(&window, &app_handle, initial_id, &initial_url).expect("create initial view");
            {
                let mut s = state.0.lock().expect("state poisoned");
                s.order.push(initial_id);
                s.urls.insert(initial_id, initial_url);
                s.window_of.insert(initial_id, "main".to_string());
                s.set_active_in("main", Some(initial_id));
                relayout(&window, &s);
            }
            // 子プロセスに引き継がれないように消す。
            std::env::remove_var("YUZU_INITIAL_URL");

            // ウィンドウのリサイズに追従。
            let win = window.clone();
            let app_for_resize = app_handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    let s_state: State<'_, AppState> = app_for_resize.state();
                    let guard = s_state.0.lock();
                    if let Ok(s) = guard {
                        relayout(&win, &s);
                    }
                }
            });

            // ネイティブのタブコンテキストメニュー選択イベントをフロントへ転送。
            let app_for_menu = app_handle.clone();
            app.on_menu_event(move |_app, event| {
                let id_str = event.id().0.as_str();
                if let Some(rest) = id_str.strip_prefix("yuzu-tabmenu:") {
                    let mut parts = rest.splitn(2, ':');
                    if let (Some(action), Some(tab_id_str)) = (parts.next(), parts.next()) {
                        if let Ok(tab_id) = tab_id_str.parse::<u64>() {
                            let _ = app_for_menu.emit(
                                "tab-menu-action",
                                serde_json::json!({ "action": action, "id": tab_id }),
                            );
                        }
                    }
                }
            });

            // トースト用 webview は廃止。DL ボタン自体の発光で代替。
            let _ = spawn_toast_webview;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                ipc_remove_self_port();
                clear_dirty_run_marker(_app);
            }
        });
}

// ===== ペネトレーションテスト ツール =====

#[derive(serde::Serialize)]
struct PortScanResult {
    port: u16,
    open: bool,
    banner: Option<String>,
}

#[tauri::command]
async fn pentest_port_scan(
    host: String,
    ports: Vec<u16>,
    timeout_ms: Option<u64>,
    grab_banner: Option<bool>,
) -> Result<Vec<PortScanResult>, String> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("ホスト名を入力してください".to_string());
    }
    if ports.is_empty() {
        return Err("ポート番号を入力してください".to_string());
    }
    if ports.len() > 2000 {
        return Err("一度にスキャンできるのは 2000 ポートまでです".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(800).clamp(50, 10_000));
    let grab = grab_banner.unwrap_or(false);

    // ホスト名を解決
    let probe = format!("{}:{}", host, ports[0]);
    let resolved = probe
        .to_socket_addrs()
        .map_err(|e| format!("ホスト解決失敗: {}", e))?
        .next()
        .ok_or_else(|| "ホストが解決できません".to_string())?;
    let ip = resolved.ip();

    let results: Arc<Mutex<Vec<PortScanResult>>> = Arc::new(Mutex::new(Vec::new()));
    let chunks: Vec<Vec<u16>> = ports.chunks(64).map(|c| c.to_vec()).collect();

    let mut handles = Vec::new();
    for chunk in chunks {
        let ip = ip;
        let results = Arc::clone(&results);
        let h = thread::spawn(move || {
            for port in chunk {
                let addr = SocketAddr::new(ip, port);
                match TcpStream::connect_timeout(&addr, timeout) {
                    Ok(mut stream) => {
                        let mut banner = None;
                        if grab {
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
                            // HTTPっぽいポートには軽くプローブ
                            if matches!(port, 80 | 8000 | 8080 | 8888 | 3000 | 5000) {
                                let _ = stream.write_all(
                                    format!("HEAD / HTTP/1.0\r\nHost: {}\r\n\r\n", ip).as_bytes(),
                                );
                            }
                            let mut buf = [0u8; 256];
                            if let Ok(n) = stream.read(&mut buf) {
                                if n > 0 {
                                    let s = String::from_utf8_lossy(&buf[..n])
                                        .to_string()
                                        .replace('\r', "")
                                        .lines()
                                        .next()
                                        .unwrap_or("")
                                        .to_string();
                                    if !s.is_empty() {
                                        banner = Some(s);
                                    }
                                }
                            }
                        }
                        if let Ok(mut g) = results.lock() {
                            g.push(PortScanResult {
                                port,
                                open: true,
                                banner,
                            });
                        }
                    }
                    Err(_) => {
                        // 閉じているポートは結果に含めない
                    }
                }
            }
        });
        handles.push(h);
    }
    for h in handles {
        let _ = h.join();
    }
    let mut out = Arc::try_unwrap(results)
        .map_err(|_| "並列処理エラー".to_string())?
        .into_inner()
        .map_err(|e| format!("ロックエラー: {}", e))?;
    out.sort_by_key(|r| r.port);
    Ok(out)
}

#[derive(serde::Serialize)]
struct HttpReqResult {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    bytes: usize,
    content_type: String,
    time_ms: u64,
    final_url: String,
}

#[tauri::command]
fn pentest_http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    follow_redirects: Option<bool>,
) -> Result<HttpReqResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL が不正です: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http/https を指定してください".to_string());
    }
    let method_up = method.trim().to_uppercase();
    if method_up.is_empty() {
        return Err("メソッドが空です".to_string());
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(500, 60_000));
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(if follow_redirects.unwrap_or(true) {
            5
        } else {
            0
        })
        .build();
    let mut req = agent.request(&method_up, &url);
    let mut has_ua = false;
    let mut has_ct = false;
    for (k, v) in &headers {
        let kt = k.trim();
        if kt.is_empty() {
            continue;
        }
        if kt.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        if kt.eq_ignore_ascii_case("content-type") {
            has_ct = true;
        }
        req = req.set(kt, v);
    }
    if !has_ua {
        req = req.set("User-Agent", "Mozilla/5.0 (yuzu-browser pentest tool)");
    }
    if body.is_some() && !has_ct {
        req = req.set("Content-Type", "application/x-www-form-urlencoded");
    }
    let start = std::time::Instant::now();
    let resp_result = match body {
        Some(b) if !b.is_empty() => req.send_string(&b),
        _ => req.call(),
    };
    let resp = match resp_result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("リクエスト失敗: {}", e)),
    };
    let status = resp.status();
    let status_text = resp.status_text().to_string();
    let content_type = resp.content_type().to_string();
    let final_url = resp.get_url().to_string();
    let mut hdrs: Vec<(String, String)> = Vec::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            hdrs.push((name, v.to_string()));
        }
    }
    let mut reader = resp.into_reader();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        let n =
            std::io::Read::read(&mut reader, &mut buf).map_err(|e| format!("読込失敗: {}", e))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        if bytes.len() > 5 * 1024 * 1024 {
            break;
        }
    }
    let elapsed = start.elapsed().as_millis() as u64;
    let len = bytes.len();
    let body_str = String::from_utf8_lossy(&bytes).to_string();
    Ok(HttpReqResult {
        status,
        status_text,
        headers: hdrs,
        body: body_str,
        bytes: len,
        content_type,
        time_ms: elapsed,
        final_url,
    })
}

#[derive(serde::Serialize)]
struct SpeedDownloadResult {
    bytes: u64,
    time_ms: u64,
    mbps: f64,
    status: u16,
    final_url: String,
}

#[tauri::command]
fn speedtest_download(
    url: String,
    max_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<SpeedDownloadResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL が不正です: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http/https を指定してください".to_string());
    }
    let cap = max_bytes
        .unwrap_or(25 * 1024 * 1024)
        .clamp(64 * 1024, 200 * 1024 * 1024);
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(5)
        .build();
    let req = agent
        .get(&url)
        .set("User-Agent", "Mozilla/5.0 (yuzu-browser speedtest)")
        .set("Cache-Control", "no-cache")
        .set("Pragma", "no-cache");
    let start = std::time::Instant::now();
    let resp = req.call().map_err(|e| format!("接続失敗: {}", e))?;
    let status = resp.status();
    let final_url = resp.get_url().to_string();
    let mut reader = resp.into_reader();
    let mut total: u64 = 0;
    let mut buf = [0u8; 65536];
    loop {
        if start.elapsed() >= timeout {
            break;
        }
        let n = match std::io::Read::read(&mut reader, &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        total += n as u64;
        if total >= cap {
            break;
        }
    }
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    let secs = elapsed.as_secs_f64().max(0.000_001);
    let mbps = (total as f64 * 8.0) / secs / 1_000_000.0;
    Ok(SpeedDownloadResult {
        bytes: total,
        time_ms: elapsed_ms,
        mbps,
        status,
        final_url,
    })
}

#[derive(serde::Serialize)]
struct SpeedUploadResult {
    bytes: u64,
    time_ms: u64,
    mbps: f64,
    status: u16,
}

#[tauri::command]
fn speedtest_upload(
    url: String,
    size_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<SpeedUploadResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL を入力してください".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL が不正です: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http/https を指定してください".to_string());
    }
    let size = size_bytes
        .unwrap_or(2 * 1024 * 1024)
        .clamp(16 * 1024, 50 * 1024 * 1024) as usize;
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(5)
        .build();
    let payload = vec![b'A'; size];
    let start = std::time::Instant::now();
    let resp = agent
        .post(&url)
        .set("User-Agent", "Mozilla/5.0 (yuzu-browser speedtest)")
        .set("Content-Type", "application/octet-stream")
        .send_bytes(&payload);
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("送信失敗: {}", e)),
    };
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    let secs = elapsed.as_secs_f64().max(0.000_001);
    let mbps = (size as f64 * 8.0) / secs / 1_000_000.0;
    Ok(SpeedUploadResult {
        bytes: size as u64,
        time_ms: elapsed_ms,
        mbps,
        status: resp.status(),
    })
}

#[derive(serde::Serialize)]
struct SpeedPingResult {
    samples_ms: Vec<f64>,
    success: u32,
    failed: u32,
    avg_ms: f64,
    min_ms: f64,
    max_ms: f64,
    jitter_ms: f64,
}

#[tauri::command]
fn speedtest_ping(
    host: String,
    port: Option<u16>,
    count: Option<u32>,
) -> Result<SpeedPingResult, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("ホストを入力してください".to_string());
    }
    let port = port.unwrap_or(443);
    let count = count.unwrap_or(5).clamp(1, 50);
    let addr = format!("{}:{}", host, port);
    use std::net::ToSocketAddrs;
    let socket_addr = addr
        .to_socket_addrs()
        .map_err(|e| format!("名前解決失敗: {}", e))?
        .next()
        .ok_or_else(|| "アドレス取得失敗".to_string())?;
    let mut samples: Vec<f64> = Vec::new();
    let mut failed: u32 = 0;
    for _ in 0..count {
        let start = std::time::Instant::now();
        match std::net::TcpStream::connect_timeout(
            &socket_addr,
            std::time::Duration::from_millis(2_000),
        ) {
            Ok(_) => {
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                samples.push(ms);
            }
            Err(_) => failed += 1,
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let success = samples.len() as u32;
    let (avg, min, max, jitter) = if samples.is_empty() {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        let sum: f64 = samples.iter().sum();
        let avg = sum / samples.len() as f64;
        let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let var: f64 =
            samples.iter().map(|x| (x - avg).powi(2)).sum::<f64>() / samples.len() as f64;
        (avg, min, max, var.sqrt())
    };
    Ok(SpeedPingResult {
        samples_ms: samples,
        success,
        failed,
        avg_ms: avg,
        min_ms: min,
        max_ms: max,
        jitter_ms: jitter,
    })
}

// ===== ターミナル (Tabby 風 シンプル PTY なし版) =====
//
// portable-pty の追加を避けるため std::process::Command + Stdio::piped() で実装。
// 行バッファされたシェル (cmd / pwsh / bash) で対話的なコマンドを実行可能。
// stdout/stderr は別スレッドで読み出して "terminal-output" イベントで JS へ送る。
// 終了は "terminal-exit" イベント。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

struct TerminalSession {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct TerminalState(Mutex<HashMap<u64, TerminalSession>>);

static TERMINAL_NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct TerminalChunk {
    session_id: u64,
    stream: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    session_id: u64,
    code: Option<i32>,
}

fn resolve_shell(spec: &str) -> Result<(String, Vec<String>), String> {
    let s = spec.trim().to_lowercase();
    #[cfg(target_os = "windows")]
    let v = match s.as_str() {
        "cmd" | "" => (
            "cmd.exe".to_string(),
            vec![
                "/Q".to_string(),
                "/K".to_string(),
                "prompt $P$G".to_string(),
            ],
        ),
        "powershell" | "ps" => (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
        ),
        "pwsh" => (
            "pwsh.exe".to_string(),
            vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
        ),
        "bash" | "wsl" => (
            "wsl.exe".to_string(),
            vec!["bash".to_string(), "-i".to_string()],
        ),
        "git-bash" => (
            "C:\\Program Files\\Git\\bin\\bash.exe".to_string(),
            vec!["-i".to_string()],
        ),
        other => (other.to_string(), vec![]),
    };
    #[cfg(not(target_os = "windows"))]
    let v = match s.as_str() {
        "" | "bash" => ("bash".to_string(), vec!["-i".to_string()]),
        "zsh" => ("zsh".to_string(), vec!["-i".to_string()]),
        "sh" => ("sh".to_string(), vec!["-i".to_string()]),
        other => (other.to_string(), vec![]),
    };
    Ok(v)
}

#[tauri::command]
fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    shell: String,
    cwd: Option<String>,
) -> Result<u64, String> {
    let (program, args) = resolve_shell(&shell)?;
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(dir) = cwd.as_ref() {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            cmd.current_dir(trimmed);
        }
    }
    // Windows でコンソールウィンドウが瞬間表示されないように。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("プロセス起動失敗 ({}): {}", program, e))?;
    let id = TERMINAL_NEXT_ID.fetch_add(1, Ordering::SeqCst);

    if let Some(stdout) = child.stdout.take() {
        let app_h = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = [0u8; 4096];
            use std::io::Read;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_h.emit(
                            "terminal-output",
                            TerminalChunk {
                                session_id: id,
                                stream: "stdout".into(),
                                data: s,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_h = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let _ = app_h.emit(
                            "terminal-output",
                            TerminalChunk {
                                session_id: id,
                                stream: "stderr".into(),
                                data: line.clone(),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let stdin = child.stdin.take();
    let session = TerminalSession { child, stdin };
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);

    // exit watcher
    {
        let app_h = app.clone();
        let state_arc = app.state::<TerminalState>();
        let _ = state_arc; // just to ensure type
        std::thread::spawn(move || {
            // 100ms ポーリング
            loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let s: State<'_, TerminalState> = app_h.state();
                let mut map = match s.0.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                let entry = match map.get_mut(&id) {
                    Some(e) => e,
                    None => break,
                };
                match entry.child.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code();
                        map.remove(&id);
                        drop(map);
                        let _ = app_h.emit(
                            "terminal-exit",
                            TerminalExit {
                                session_id: id,
                                code,
                            },
                        );
                        break;
                    }
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    Ok(id)
}

#[tauri::command]
fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: u64,
    data: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let entry = map
        .get_mut(&session_id)
        .ok_or_else(|| "セッションがありません".to_string())?;
    if let Some(stdin) = entry.stdin.as_mut() {
        stdin
            .write_all(data.as_bytes())
            .map_err(|e| format!("書き込み失敗: {}", e))?;
        stdin.flush().map_err(|e| format!("flush 失敗: {}", e))?;
        Ok(())
    } else {
        Err("stdin が閉じています".to_string())
    }
}

#[tauri::command]
fn terminal_kill(state: State<'_, TerminalState>, session_id: u64) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut entry) = map.remove(&session_id) {
        // stdin を閉じる
        entry.stdin.take();
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn terminal_list(state: State<'_, TerminalState>) -> Result<Vec<u64>, String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let mut ids: Vec<u64> = map.keys().copied().collect();
    ids.sort();
    Ok(ids)
}

// ===== 任意コマンドを TerminalSession として起動 =====
// SSH ツールなど、ターミナル機構を使って任意プロセスを子として動かしたい場合に使う。
#[tauri::command]
fn terminal_spawn_command(
    app: AppHandle,
    state: State<'_, TerminalState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<u64, String> {
    let prog = program.trim();
    if prog.is_empty() {
        return Err("program が空です".to_string());
    }
    let mut cmd = Command::new(prog);
    cmd.args(&args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(dir) = cwd.as_ref() {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            cmd.current_dir(trimmed);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("プロセス起動失敗 ({}): {}", prog, e))?;
    let id = TERMINAL_NEXT_ID.fetch_add(1, Ordering::SeqCst);

    if let Some(stdout) = child.stdout.take() {
        let app_h = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = [0u8; 4096];
            use std::io::Read;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_h.emit(
                            "terminal-output",
                            TerminalChunk {
                                session_id: id,
                                stream: "stdout".into(),
                                data: s,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_h = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            use std::io::Read;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_h.emit(
                            "terminal-output",
                            TerminalChunk {
                                session_id: id,
                                stream: "stderr".into(),
                                data: s,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }
    let stdin = child.stdin.take();
    let session = TerminalSession { child, stdin };
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    {
        let app_h = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let s: State<'_, TerminalState> = app_h.state();
            let mut map = match s.0.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            let entry = match map.get_mut(&id) {
                Some(e) => e,
                None => break,
            };
            match entry.child.try_wait() {
                Ok(Some(status)) => {
                    let _ = app_h.emit(
                        "terminal-exit",
                        TerminalExit {
                            session_id: id,
                            code: status.code(),
                        },
                    );
                    map.remove(&id);
                    break;
                }
                Ok(None) => continue,
                Err(_) => break,
            }
        });
    }
    Ok(id)
}

// ===== SSH 鍵 / 接続管理 =====

fn home_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    let h = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE 取得失敗".to_string())?;
    #[cfg(not(windows))]
    let h = std::env::var("HOME").map_err(|_| "HOME 取得失敗".to_string())?;
    Ok(std::path::PathBuf::from(h))
}

fn ssh_dir() -> Result<std::path::PathBuf, String> {
    let mut p = home_dir()?;
    p.push(".ssh");
    if !p.exists() {
        std::fs::create_dir_all(&p).map_err(|e| format!(".ssh 作成失敗: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(p)
}

#[cfg(unix)]
fn set_private_perm(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn set_private_perm(_path: &std::path::Path) {}

#[derive(Serialize)]
struct SshKeyInfo {
    name: String,
    private_path: String,
    public_path: String,
    has_private: bool,
    has_public: bool,
    key_type: String,
    comment: String,
    fingerprint: String,
}

fn parse_pubkey(content: &str) -> (String, String) {
    // "<type> <base64> <comment...>"
    let trimmed = content.trim();
    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let kt = parts.next().unwrap_or("").to_string();
    let _ = parts.next();
    let comment = parts.next().unwrap_or("").to_string();
    (kt, comment)
}

fn fingerprint_pub(content: &str) -> String {
    use base64::Engine;
    let trimmed = content.trim();
    let mut parts = trimmed.split_whitespace();
    let _kt = parts.next().unwrap_or("");
    let b64 = parts.next().unwrap_or("");
    if b64.is_empty() {
        return String::new();
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let b = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    format!("SHA256:{}", b)
}

#[tauri::command]
fn ssh_list_keys() -> Result<Vec<SshKeyInfo>, String> {
    let dir = ssh_dir()?;
    let mut out: Vec<SshKeyInfo> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let fname = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            // 公開鍵 (.pub) ベースで列挙
            if fname.ends_with(".pub") {
                let base = fname.trim_end_matches(".pub").to_string();
                if seen.contains(&base) {
                    continue;
                }
                seen.insert(base.clone());
                let priv_path = dir.join(&base);
                let pub_path = p.clone();
                let pub_content = std::fs::read_to_string(&pub_path).unwrap_or_default();
                let (kt, comment) = parse_pubkey(&pub_content);
                let fp = fingerprint_pub(&pub_content);
                out.push(SshKeyInfo {
                    name: base,
                    private_path: priv_path.to_string_lossy().to_string(),
                    public_path: pub_path.to_string_lossy().to_string(),
                    has_private: priv_path.is_file(),
                    has_public: true,
                    key_type: kt,
                    comment,
                    fingerprint: fp,
                });
            }
        }
    }
    // 公開鍵が無い秘密鍵 (id_rsa など) も拾う
    let candidates = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
    for c in candidates {
        let priv_path = dir.join(c);
        if priv_path.is_file() && !seen.contains(c) {
            seen.insert(c.to_string());
            out.push(SshKeyInfo {
                name: c.to_string(),
                private_path: priv_path.to_string_lossy().to_string(),
                public_path: dir.join(format!("{}.pub", c)).to_string_lossy().to_string(),
                has_private: true,
                has_public: false,
                key_type: String::new(),
                comment: String::new(),
                fingerprint: String::new(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
fn ssh_read_pubkey(name: String) -> Result<String, String> {
    let dir = ssh_dir()?;
    let p = dir.join(format!("{}.pub", sanitize_key_name(&name)?));
    std::fs::read_to_string(&p).map_err(|e| format!("読込失敗: {}", e))
}

fn sanitize_key_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("鍵名が空です".to_string());
    }
    if n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err("鍵名に / \\ .. は使用できません".to_string());
    }
    if n.ends_with(".pub") {
        return Err("名前に .pub を含めないでください".to_string());
    }
    Ok(n.to_string())
}

#[tauri::command]
fn ssh_generate_key(
    name: String,
    key_type: String,
    comment: Option<String>,
    overwrite: Option<bool>,
) -> Result<SshKeyInfo, String> {
    let n = sanitize_key_name(&name)?;
    let kt = match key_type.trim().to_lowercase().as_str() {
        "" | "ed25519" => "ed25519".to_string(),
        "rsa" => "rsa".to_string(),
        "ecdsa" => "ecdsa".to_string(),
        other => return Err(format!("未対応の鍵種別: {}", other)),
    };
    let dir = ssh_dir()?;
    let priv_path = dir.join(&n);
    let pub_path = dir.join(format!("{}.pub", n));
    if priv_path.exists() || pub_path.exists() {
        if overwrite.unwrap_or(false) {
            let _ = std::fs::remove_file(&priv_path);
            let _ = std::fs::remove_file(&pub_path);
        } else {
            return Err("同名の鍵が既に存在します".to_string());
        }
    }
    let mut cmd = Command::new("ssh-keygen");
    cmd.arg("-t").arg(&kt);
    if kt == "rsa" {
        cmd.arg("-b").arg("4096");
    }
    cmd.arg("-f").arg(&priv_path);
    cmd.arg("-N").arg(""); // パスフレーズ無し
    cmd.arg("-q");
    if let Some(c) = comment.as_ref() {
        let c = c.trim();
        if !c.is_empty() {
            cmd.arg("-C").arg(c);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("ssh-keygen 起動失敗 (OpenSSH クライアントが必要): {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ssh-keygen 失敗: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    set_private_perm(&priv_path);
    // 結果取得
    let pub_content = std::fs::read_to_string(&pub_path).unwrap_or_default();
    let (kt2, comment2) = parse_pubkey(&pub_content);
    let fp = fingerprint_pub(&pub_content);
    Ok(SshKeyInfo {
        name: n.clone(),
        private_path: priv_path.to_string_lossy().to_string(),
        public_path: pub_path.to_string_lossy().to_string(),
        has_private: true,
        has_public: true,
        key_type: kt2,
        comment: comment2,
        fingerprint: fp,
    })
}

#[tauri::command]
fn ssh_import_key(
    name: String,
    private_pem: String,
    public_pem: Option<String>,
    overwrite: Option<bool>,
) -> Result<SshKeyInfo, String> {
    let n = sanitize_key_name(&name)?;
    let dir = ssh_dir()?;
    let priv_path = dir.join(&n);
    let pub_path = dir.join(format!("{}.pub", n));
    if (priv_path.exists() || pub_path.exists()) && !overwrite.unwrap_or(false) {
        return Err("同名の鍵が既に存在します".to_string());
    }
    let priv_text = private_pem.trim().to_string();
    if !priv_text.contains("BEGIN") || !priv_text.contains("PRIVATE KEY") {
        return Err("秘密鍵の形式が不正です (PEM 形式を貼り付けてください)".to_string());
    }
    // 末尾改行を保証
    let mut priv_out = priv_text;
    if !priv_out.ends_with('\n') {
        priv_out.push('\n');
    }
    std::fs::write(&priv_path, priv_out.as_bytes())
        .map_err(|e| format!("秘密鍵書き込み失敗: {}", e))?;
    set_private_perm(&priv_path);

    let pub_text = public_pem.unwrap_or_default().trim().to_string();
    if !pub_text.is_empty() {
        let mut p = pub_text;
        if !p.ends_with('\n') {
            p.push('\n');
        }
        std::fs::write(&pub_path, p.as_bytes())
            .map_err(|e| format!("公開鍵書き込み失敗: {}", e))?;
    } else {
        // ssh-keygen -y で公開鍵を再生成
        let mut cmd = Command::new("ssh-keygen");
        cmd.arg("-y").arg("-f").arg(&priv_path);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let mut s = String::from_utf8_lossy(&out.stdout).to_string();
                if !s.ends_with('\n') {
                    s.push('\n');
                }
                let _ = std::fs::write(&pub_path, s.as_bytes());
            }
        }
    }
    let pub_content = std::fs::read_to_string(&pub_path).unwrap_or_default();
    let (kt2, comment2) = parse_pubkey(&pub_content);
    let fp = fingerprint_pub(&pub_content);
    Ok(SshKeyInfo {
        name: n,
        private_path: priv_path.to_string_lossy().to_string(),
        public_path: pub_path.to_string_lossy().to_string(),
        has_private: true,
        has_public: pub_path.is_file(),
        key_type: kt2,
        comment: comment2,
        fingerprint: fp,
    })
}

#[tauri::command]
fn ssh_delete_key(name: String) -> Result<(), String> {
    let n = sanitize_key_name(&name)?;
    let dir = ssh_dir()?;
    let _ = std::fs::remove_file(dir.join(&n));
    let _ = std::fs::remove_file(dir.join(format!("{}.pub", n)));
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct SshHostEntry {
    alias: String,
    hostname: String,
    user: String,
    port: u16,
    identity_file: String,
    extra: String,
}

fn parse_ssh_config(text: &str) -> Vec<SshHostEntry> {
    let mut out: Vec<SshHostEntry> = Vec::new();
    let mut cur: Option<SshHostEntry> = None;
    let mut extra_lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.splitn(2, char::is_whitespace);
        let key = it.next().unwrap_or("").to_lowercase();
        let val = it.next().unwrap_or("").trim().to_string();
        if key == "host" {
            if let Some(mut e) = cur.take() {
                e.extra = extra_lines.join("\n");
                if !e.alias.is_empty() {
                    out.push(e);
                }
            }
            extra_lines.clear();
            // Host A B C → 最初のエイリアスのみ取り扱う (yuzu 管理対象は単一)
            let alias = val.split_whitespace().next().unwrap_or("").to_string();
            cur = Some(SshHostEntry {
                alias,
                ..Default::default()
            });
        } else if let Some(e) = cur.as_mut() {
            match key.as_str() {
                "hostname" => e.hostname = val,
                "user" => e.user = val,
                "port" => e.port = val.parse().unwrap_or(0),
                "identityfile" => e.identity_file = val,
                _ => extra_lines.push(format!("{} {}", key, val)),
            }
        }
    }
    if let Some(mut e) = cur.take() {
        e.extra = extra_lines.join("\n");
        if !e.alias.is_empty() {
            out.push(e);
        }
    }
    out
}

fn render_ssh_config(entries: &[SshHostEntry]) -> String {
    let mut s = String::new();
    s.push_str("# Managed by yuzu-browser\n");
    for e in entries {
        s.push_str(&format!("Host {}\n", e.alias));
        if !e.hostname.is_empty() {
            s.push_str(&format!("    HostName {}\n", e.hostname));
        }
        if !e.user.is_empty() {
            s.push_str(&format!("    User {}\n", e.user));
        }
        if e.port != 0 && e.port != 22 {
            s.push_str(&format!("    Port {}\n", e.port));
        }
        if !e.identity_file.is_empty() {
            s.push_str(&format!("    IdentityFile {}\n", e.identity_file));
        }
        for ex in e.extra.lines() {
            let l = ex.trim();
            if !l.is_empty() {
                s.push_str("    ");
                s.push_str(l);
                s.push('\n');
            }
        }
        s.push('\n');
    }
    s
}

#[tauri::command]
fn ssh_list_hosts() -> Result<Vec<SshHostEntry>, String> {
    let dir = ssh_dir()?;
    let p = dir.join("config");
    if !p.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("読込失敗: {}", e))?;
    Ok(parse_ssh_config(&text))
}

#[tauri::command]
fn ssh_save_host(entry: SshHostEntry) -> Result<(), String> {
    let alias = entry.alias.trim().to_string();
    if alias.is_empty() {
        return Err("Host エイリアスを入力してください".to_string());
    }
    if alias.contains(char::is_whitespace) {
        return Err("Host エイリアスに空白は使えません".to_string());
    }
    let dir = ssh_dir()?;
    let p = dir.join("config");
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let mut entries = parse_ssh_config(&text);
    let mut new_entry = entry;
    new_entry.alias = alias.clone();
    if let Some(idx) = entries.iter().position(|e| e.alias == alias) {
        entries[idx] = new_entry;
    } else {
        entries.push(new_entry);
    }
    let rendered = render_ssh_config(&entries);
    std::fs::write(&p, rendered.as_bytes()).map_err(|e| format!("書き込み失敗: {}", e))?;
    set_private_perm(&p);
    Ok(())
}

#[tauri::command]
fn ssh_delete_host(alias: String) -> Result<(), String> {
    let alias = alias.trim().to_string();
    if alias.is_empty() {
        return Err("alias 空".to_string());
    }
    let dir = ssh_dir()?;
    let p = dir.join("config");
    if !p.is_file() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let mut entries = parse_ssh_config(&text);
    entries.retain(|e| e.alias != alias);
    let rendered = render_ssh_config(&entries);
    std::fs::write(&p, rendered.as_bytes()).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(())
}

#[tauri::command]
fn ssh_open_dir() -> Result<String, String> {
    let dir = ssh_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

// ===== ダウンロードマネージャー =====

use sha2::Digest as _Sha2Digest;

#[derive(Serialize, Deserialize, Clone)]
struct DownloadItem {
    id: u64,
    url: String,
    filename: String,
    path: String,
    bytes: u64,
    started_at: u64,
    finished_at: Option<u64>,
    status: String, // "in-progress" | "completed" | "failed" | "cancelled"
    mime: Option<String>,
    sha256: Option<String>,
    md5: Option<String>,
    referrer: Option<String>,
    tab_id: Option<u64>,
    user_agent: Option<String>,
}

#[derive(Default)]
struct DownloadStateInner {
    items: Vec<DownloadItem>,
    next_id: u64,
    path: Option<PathBuf>,
}

impl DownloadStateInner {
    fn save(&self) {
        if let Some(p) = &self.path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // 直近 500 件まで残す
            let trimmed: Vec<&DownloadItem> = self.items.iter().rev().take(500).collect();
            let mut out: Vec<DownloadItem> = trimmed.into_iter().rev().cloned().collect();
            // in-progress は永続化時に failed 扱い
            for it in out.iter_mut() {
                if it.status == "in-progress" {
                    it.status = "failed".into();
                }
            }
            if let Ok(json) = serde_json::to_string_pretty(&out) {
                let _ = std::fs::write(p, json);
            }
        }
    }
    fn load(path: PathBuf) -> Self {
        let mut s = Self::default();
        s.path = Some(path.clone());
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(items) = serde_json::from_str::<Vec<DownloadItem>>(&text) {
                s.next_id = items.iter().map(|i| i.id).max().unwrap_or(0);
                s.items = items;
            }
        }
        s
    }
}

#[derive(Default)]
struct DownloadState(Mutex<DownloadStateInner>);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10000 {
        let p = dir.join(format!("{} ({}){}", stem, n, ext));
        if !p.exists() {
            return p;
        }
    }
    candidate
}

fn guess_filename_from_url(url: &str) -> String {
    if let Ok(u) = url::Url::parse(url) {
        if let Some(seg) = u.path_segments().and_then(|mut s| s.next_back()) {
            let decoded = percent_decode(seg);
            if !decoded.is_empty() {
                return sanitize_filename(&decoded);
            }
        }
    }
    "download".to_string()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn sniff_mime(path: &PathBuf) -> Option<String> {
    let mut buf = [0u8; 16];
    let n = std::fs::File::open(path)
        .ok()
        .and_then(|mut f| std::io::Read::read(&mut f, &mut buf).ok())?;
    let b = &buf[..n];
    let m = if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        "image/gif"
    } else if b.starts_with(b"RIFF") && b.len() > 11 && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(&[0x25, 0x50, 0x44, 0x46]) {
        "application/pdf"
    } else if b.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
        "application/zip"
    } else if b.starts_with(&[0x1F, 0x8B]) {
        "application/gzip"
    } else if b.starts_with(b"7z\xBC\xAF\x27\x1C") {
        "application/x-7z-compressed"
    } else if b.starts_with(&[0x52, 0x61, 0x72, 0x21]) {
        "application/vnd.rar"
    } else if b.starts_with(b"%!PS") {
        "application/postscript"
    } else if b.starts_with(b"\x7FELF") {
        "application/x-elf"
    } else if b.starts_with(b"MZ") {
        "application/x-msdownload"
    } else if b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) {
        "audio/mpeg"
    } else if b.starts_with(b"OggS") {
        "audio/ogg"
    } else if b.starts_with(b"fLaC") {
        "audio/flac"
    } else if b.len() > 11 && &b[4..8] == b"ftyp" {
        "video/mp4"
    } else if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "video/x-matroska"
    } else {
        return None;
    };
    Some(m.to_string())
}

fn handle_download_event(app: &AppHandle, tab_id: u64, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            // 設定の download_dir を使う
            let url_str = url.to_string();
            let mut name = guess_filename_from_url(&url_str);
            // 拡張子が無く destination に拡張子があれば借用
            if !name.contains('.') {
                if let Some(ext) = destination.extension().and_then(|e| e.to_str()) {
                    name.push('.');
                    name.push_str(ext);
                }
            }
            let dir = {
                let st: State<'_, ToolboxState> = app.state();
                let g = st.0.lock();
                g.ok()
                    .and_then(|s| {
                        if s.settings.download_dir.is_empty() {
                            None
                        } else {
                            Some(PathBuf::from(&s.settings.download_dir))
                        }
                    })
                    .or_else(default_download_dir)
                    .unwrap_or_else(|| PathBuf::from("."))
            };
            let _ = std::fs::create_dir_all(&dir);
            let final_path = unique_path(&dir, &name);
            *destination = final_path.clone();

            let dl_state: State<'_, DownloadState> = app.state();
            let item = if let Ok(mut s) = dl_state.0.lock() {
                s.next_id += 1;
                let it = DownloadItem {
                    id: s.next_id,
                    url: url_str.clone(),
                    filename: final_path
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| name.clone()),
                    path: final_path.to_string_lossy().to_string(),
                    bytes: 0,
                    started_at: now_ms(),
                    finished_at: None,
                    status: "in-progress".into(),
                    mime: None,
                    sha256: None,
                    md5: None,
                    referrer: None,
                    tab_id: Some(tab_id),
                    user_agent: None,
                };
                s.items.push(it.clone());
                s.save();
                Some(it)
            } else {
                None
            };
            if let Some(it) = item {
                let _ = app.emit("download-started", &it);
                // WebView2 のネイティブ DownloadEvent は環境によって
                // `Finished` を吐かないことがある。ファイルサイズを
                // 監視して進捗イベントを生成し、停止検知で完了扱いにする。
                spawn_native_download_watchdog(
                    app.clone(),
                    it.id,
                    final_path.clone(),
                    url_str.clone(),
                );
            }
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let url_str = url.to_string();
            let dl_state: State<'_, DownloadState> = app.state();
            let mut updated: Option<DownloadItem> = None;
            if let Ok(mut s) = dl_state.0.lock() {
                if let Some(it) = s
                    .items
                    .iter_mut()
                    .rev()
                    .find(|i| i.url == url_str && i.status == "in-progress")
                {
                    it.status = if success {
                        "completed".into()
                    } else {
                        "failed".into()
                    };
                    it.finished_at = Some(now_ms());
                    if let Some(p) = &path {
                        it.path = p.to_string_lossy().to_string();
                        if let Ok(meta) = std::fs::metadata(p) {
                            it.bytes = meta.len();
                        }
                        it.mime = sniff_mime(p);
                    }
                    updated = Some(it.clone());
                }
                s.save();
            }
            if let Some(it) = updated {
                let _ = app.emit("download-finished", &it);
            }
            true
        }
        _ => true,
    }
}

/// WebView2 ネイティブダウンロードの伴走スレッド。
/// 一定間隔で対象ファイル (本体 or `*.crdownload`) のサイズを計測し、
/// `download-progress` を emit する。サイズが伸びなくなったら完了扱いにする。
/// `DownloadEvent::Finished` が先に来た場合はそちらが状態を更新するので、
/// このスレッドは「もう in-progress ではない」を観測した時点で離脱する。
fn spawn_native_download_watchdog(app: AppHandle, id: u64, final_path: PathBuf, url: String) {
    std::thread::spawn(move || {
        // crdownload と本体の両方をチェック (どちらに書かれているかは環境依存)。
        let crdownload = {
            let mut p = final_path.clone();
            let new_ext = match p.extension().and_then(|e| e.to_str()) {
                Some(e) => format!("{}.crdownload", e),
                None => "crdownload".to_string(),
            };
            p.set_extension(new_ext);
            p
        };
        let measure = || -> u64 {
            let a = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            let b = std::fs::metadata(&crdownload).map(|m| m.len()).unwrap_or(0);
            a.max(b)
        };
        // HEAD で総サイズ取得 (取れない場合は None のまま)
        let total_bytes: std::sync::Arc<std::sync::Mutex<Option<u64>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        {
            let total_bytes = total_bytes.clone();
            let url = url.clone();
            std::thread::spawn(move || {
                let agent = ureq::AgentBuilder::new()
                    .timeout(std::time::Duration::from_secs(8))
                    .build();
                if let Ok(resp) = agent.head(&url).call() {
                    if let Some(len) = resp
                        .header("Content-Length")
                        .and_then(|s| s.parse::<u64>().ok())
                    {
                        if let Ok(mut g) = total_bytes.lock() {
                            *g = Some(len);
                        }
                    }
                }
            });
        }
        let mut last_bytes: u64 = 0;
        let mut last_change = std::time::Instant::now();
        // 完了とみなす停滞時間。ネット詰まりも考慮して 10 秒。
        let stall_timeout = std::time::Duration::from_secs(10);
        // 念のための上限 (24 時間)。
        let hard_deadline = std::time::Instant::now() + std::time::Duration::from_secs(86_400);

        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            // 本体の状態を確認。完了済みになっていたら抜ける。
            let still_in_progress = {
                if let Some(dl_state) = app.try_state::<DownloadState>() {
                    if let Ok(s) = dl_state.0.lock() {
                        s.items
                            .iter()
                            .find(|i| i.id == id)
                            .map(|i| i.status == "in-progress")
                            .unwrap_or(false)
                    } else {
                        true
                    }
                } else {
                    return;
                }
            };
            if !still_in_progress {
                return;
            }

            let bytes = measure();
            if bytes != last_bytes {
                last_bytes = bytes;
                last_change = std::time::Instant::now();
                let total_val = total_bytes.lock().ok().and_then(|g| *g);
                if let Some(dl_state) = app.try_state::<DownloadState>() {
                    if let Ok(mut s) = dl_state.0.lock() {
                        if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                            it.bytes = bytes;
                        }
                    }
                }
                let total_json = total_val
                    .map(|v| serde_json::Value::Number(v.into()))
                    .unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "download-progress",
                    serde_json::json!({
                        "id": id,
                        "bytes": bytes,
                        "total": total_json,
                    }),
                );
            }

            let stalled = last_change.elapsed() > stall_timeout;
            let timed_out = std::time::Instant::now() > hard_deadline;
            if !stalled && !timed_out {
                continue;
            }

            // 停滞 → 完了/失敗を確定する。
            // `*.crdownload` が消えて本体が残っていれば完了。
            // どちらも残っていれば失敗 (中断) として扱う。
            let body_exists = final_path.exists();
            let part_exists = crdownload.exists();
            let final_bytes = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            let success = body_exists && !part_exists && final_bytes > 0;

            let mut updated: Option<DownloadItem> = None;
            if let Some(dl_state) = app.try_state::<DownloadState>() {
                if let Ok(mut s) = dl_state.0.lock() {
                    if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                        if it.status == "in-progress" {
                            it.status = if success {
                                "completed".into()
                            } else {
                                "failed".into()
                            };
                            it.finished_at = Some(now_ms());
                            it.bytes = final_bytes;
                            if success {
                                it.mime = sniff_mime(&final_path);
                            }
                            updated = Some(it.clone());
                        }
                    }
                    s.save();
                }
            }
            if let Some(it) = updated {
                let _ = app.emit("download-finished", &it);
            }
            return;
        }
    });
}

#[tauri::command]
fn downloads_list(state: State<'_, DownloadState>) -> Result<Vec<DownloadItem>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.items.clone())
}

#[tauri::command]
fn downloads_clear(state: State<'_, DownloadState>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.items.retain(|i| i.status == "in-progress");
    s.save();
    Ok(())
}

#[tauri::command]
fn downloads_remove(id: u64, state: State<'_, DownloadState>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.items.retain(|i| i.id != id);
    s.save();
    Ok(())
}

#[tauri::command]
fn downloads_open_file(id: u64, state: State<'_, DownloadState>) -> Result<(), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let it = s.items.iter().find(|i| i.id == id).ok_or("not found")?;
    open_with_default(&PathBuf::from(&it.path))
}

#[tauri::command]
fn downloads_show_in_folder(id: u64, state: State<'_, DownloadState>) -> Result<(), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let it = s.items.iter().find(|i| i.id == id).ok_or("not found")?;
    show_in_folder(&PathBuf::from(&it.path))
}

#[tauri::command]
fn downloads_open_folder(state: State<'_, DownloadState>, app: AppHandle) -> Result<(), String> {
    let st: State<'_, ToolboxState> = app.state();
    let dir = if let Ok(g) = st.0.lock() {
        if !g.settings.download_dir.is_empty() {
            PathBuf::from(&g.settings.download_dir)
        } else {
            default_download_dir().unwrap_or_else(|| PathBuf::from("."))
        }
    } else {
        default_download_dir().unwrap_or_else(|| PathBuf::from("."))
    };
    let _ = state;
    open_with_default(&dir)
}

fn open_with_default(p: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &p.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

fn show_in_folder(p: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &p.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &p.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(parent) = p.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
}

#[derive(Serialize)]
struct HashResult {
    sha256: String,
    md5: String,
    bytes: u64,
}

#[tauri::command]
fn downloads_compute_hash(id: u64, state: State<'_, DownloadState>) -> Result<HashResult, String> {
    let path = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let it = s.items.iter().find(|i| i.id == id).ok_or("not found")?;
        it.path.clone()
    };
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut sha = sha2::Sha256::new();
    let mut md5 = md5::Md5::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        md5.update(&buf[..n]);
        total += n as u64;
    }
    let sha_hex = format!("{:x}", sha.finalize());
    let md5_hex = format!("{:x}", md5.finalize());
    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
            it.sha256 = Some(sha_hex.clone());
            it.md5 = Some(md5_hex.clone());
        }
        s.save();
    }
    Ok(HashResult {
        sha256: sha_hex,
        md5: md5_hex,
        bytes: total,
    })
}

#[tauri::command]
fn downloads_verify_hash(
    id: u64,
    expected: String,
    state: State<'_, DownloadState>,
) -> Result<bool, String> {
    let h = downloads_compute_hash(id, state)?;
    let exp = expected.trim().to_lowercase();
    Ok(exp == h.sha256 || exp == h.md5)
}

/// 任意の URL を手動でダウンロード（Engineer モード: ヘッダ指定可）
#[derive(Deserialize, Clone)]
struct SaveUrlOpts {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default = "default_true")]
    parallel: bool,
    #[serde(default = "default_connections")]
    connections: usize,
}
fn default_true() -> bool {
    true
}
fn default_connections() -> usize {
    8
}

#[tauri::command]
fn downloads_save_url(
    opts: SaveUrlOpts,
    app: AppHandle,
    state: State<'_, DownloadState>,
    tb: State<'_, ToolboxState>,
) -> Result<u64, String> {
    let dir = {
        let g = tb.0.lock().map_err(|e| e.to_string())?;
        if g.settings.download_dir.is_empty() {
            default_download_dir().unwrap_or_else(|| PathBuf::from("."))
        } else {
            PathBuf::from(&g.settings.download_dir)
        }
    };
    let _ = std::fs::create_dir_all(&dir);
    let name = opts
        .filename
        .clone()
        .filter(|s| !s.is_empty())
        .map(|s| sanitize_filename(&s))
        .unwrap_or_else(|| guess_filename_from_url(&opts.url));
    let final_path = unique_path(&dir, &name);

    let (id, started_item) = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        let it = DownloadItem {
            id: s.next_id,
            url: opts.url.clone(),
            filename: final_path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or(name.clone()),
            path: final_path.to_string_lossy().to_string(),
            bytes: 0,
            started_at: now_ms(),
            finished_at: None,
            status: "in-progress".into(),
            mime: None,
            sha256: None,
            md5: None,
            referrer: opts.referrer.clone(),
            tab_id: None,
            user_agent: opts.user_agent.clone(),
        };
        s.items.push(it.clone());
        s.save();
        (it.id, it)
    };
    let _ = app.emit("download-started", &started_item);

    let url = opts.url.clone();
    let final_path_thread = final_path.clone();
    let app_thread = app.clone();
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(60))
            .build();

        // 並列ダウンロードを試行
        if opts.parallel && opts.connections >= 2 {
            if let Some((total_size, mime)) = probe_range_support(&agent, &url, &opts) {
                if total_size > 1_000_000 {
                    if parallel_download(
                        &agent,
                        &url,
                        &opts,
                        &final_path_thread,
                        total_size,
                        mime.clone(),
                        &app_thread,
                        id,
                    )
                    .is_ok()
                    {
                        return;
                    }
                }
            }
        }

        // フォールバック: 単一接続
        let mut req = agent.get(&url);
        if let Some(ua) = &opts.user_agent {
            req = req.set("User-Agent", ua);
        } else {
            req = req.set("User-Agent", "yuzu-browser/1.0");
        }
        if let Some(r) = &opts.referrer {
            req = req.set("Referer", r);
        }
        for (k, v) in &opts.headers {
            req = req.set(k, v);
        }
        let res = req.call();
        let dl_state: State<'_, DownloadState> = app_thread.state();
        match res {
            Ok(resp) => {
                let total_hint: Option<u64> =
                    resp.header("Content-Length").and_then(|s| s.parse().ok());
                let mime = resp.header("Content-Type").map(|s| s.to_string());
                let mut reader = resp.into_reader();
                let file = std::fs::File::create(&final_path_thread);
                if let Err(e) = file {
                    if let Ok(mut s) = dl_state.0.lock() {
                        if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                            it.status = "failed".into();
                            it.finished_at = Some(now_ms());
                            let _ = app_thread.emit("download-finished", &it.clone());
                        }
                        s.save();
                    }
                    let _ = e;
                    return;
                }
                let mut file = file.unwrap();
                let mut buf = vec![0u8; 64 * 1024];
                let mut total: u64 = 0;
                let mut last_emit = std::time::Instant::now();
                loop {
                    let n = match std::io::Read::read(&mut reader, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => {
                            if let Ok(mut s) = dl_state.0.lock() {
                                if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                                    it.status = "failed".into();
                                    it.finished_at = Some(now_ms());
                                    let _ = app_thread.emit("download-finished", &it.clone());
                                }
                                s.save();
                            }
                            return;
                        }
                    };
                    if std::io::Write::write_all(&mut file, &buf[..n]).is_err() {
                        break;
                    }
                    total += n as u64;
                    if last_emit.elapsed().as_millis() > 250 {
                        last_emit = std::time::Instant::now();
                        if let Ok(mut s) = dl_state.0.lock() {
                            if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                                it.bytes = total;
                            }
                        }
                        let _ = app_thread.emit(
                            "download-progress",
                            serde_json::json!({
                                "id": id,
                                "bytes": total,
                                "total": total_hint,
                            }),
                        );
                    }
                }
                if let Ok(mut s) = dl_state.0.lock() {
                    if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                        it.status = "completed".into();
                        it.finished_at = Some(now_ms());
                        it.bytes = total;
                        it.mime = mime.or_else(|| sniff_mime(&final_path_thread));
                        let _ = app_thread.emit("download-finished", &it.clone());
                    }
                    s.save();
                }
            }
            Err(e) => {
                if let Ok(mut s) = dl_state.0.lock() {
                    if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                        it.status = "failed".into();
                        it.finished_at = Some(now_ms());
                        let _ = app_thread.emit("download-finished", &it.clone());
                    }
                    s.save();
                }
                let _ = e;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
fn downloads_curl_for(id: u64, state: State<'_, DownloadState>) -> Result<String, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let it = s.items.iter().find(|i| i.id == id).ok_or("not found")?;
    let mut out = String::from("curl -L");
    if let Some(ua) = &it.user_agent {
        out.push_str(&format!(" -A {}", shell_quote(ua)));
    }
    if let Some(r) = &it.referrer {
        out.push_str(&format!(" -e {}", shell_quote(r)));
    }
    out.push_str(&format!(" -o {}", shell_quote(&it.filename)));
    out.push(' ');
    out.push_str(&shell_quote(&it.url));
    Ok(out)
}

fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-/:".contains(c))
    {
        return s.into();
    }
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

#[derive(Serialize)]
struct HexPreview {
    hex: String,
    ascii: String,
    truncated: bool,
    bytes: u64,
}

#[tauri::command]
fn downloads_hex_preview(id: u64, state: State<'_, DownloadState>) -> Result<HexPreview, String> {
    let path = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        let it = s.items.iter().find(|i| i.id == id).ok_or("not found")?;
        it.path.clone()
    };
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let total = meta.len();
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 512];
    let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| e.to_string())?;
    let bytes = &buf[..n];
    let mut hex_lines = String::new();
    let mut ascii_lines = String::new();
    for (i, chunk) in bytes.chunks(16).enumerate() {
        hex_lines.push_str(&format!("{:08x}  ", i * 16));
        for (j, b) in chunk.iter().enumerate() {
            hex_lines.push_str(&format!("{:02x} ", b));
            if j == 7 {
                hex_lines.push(' ');
            }
        }
        for _ in chunk.len()..16 {
            hex_lines.push_str("   ");
        }
        hex_lines.push_str("  |");
        for b in chunk {
            let c = *b as char;
            hex_lines.push(if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '.'
            });
        }
        hex_lines.push_str("|\n");
        for b in chunk {
            let c = *b as char;
            ascii_lines.push(if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '.'
            });
        }
    }
    Ok(HexPreview {
        hex: hex_lines,
        ascii: ascii_lines,
        truncated: total > n as u64,
        bytes: total,
    })
}

// ===== 並列ダウンロード =====

fn apply_headers(mut req: ureq::Request, opts: &SaveUrlOpts) -> ureq::Request {
    if let Some(ua) = &opts.user_agent {
        req = req.set("User-Agent", ua);
    } else {
        req = req.set("User-Agent", "yuzu-browser/1.0");
    }
    if let Some(r) = &opts.referrer {
        req = req.set("Referer", r);
    }
    for (k, v) in &opts.headers {
        req = req.set(k, v);
    }
    req
}

/// HEAD リクエストで Range サポートと Content-Length を確認
fn probe_range_support(
    agent: &ureq::Agent,
    url: &str,
    opts: &SaveUrlOpts,
) -> Option<(u64, Option<String>)> {
    // まず HEAD を試す
    let req = apply_headers(agent.head(url), opts);
    if let Ok(resp) = req.call() {
        let accept = resp
            .header("Accept-Ranges")
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let len: Option<u64> = resp.header("Content-Length").and_then(|s| s.parse().ok());
        let mime = resp.header("Content-Type").map(|s| s.to_string());
        if accept.contains("bytes") {
            if let Some(l) = len {
                return Some((l, mime));
            }
        }
        // HEAD で範囲不明な場合は Range リクエストを直接試す
    }
    // Range: bytes=0-0 で確認
    let req = apply_headers(agent.get(url), opts).set("Range", "bytes=0-0");
    if let Ok(resp) = req.call() {
        if resp.status() == 206 {
            // Content-Range: bytes 0-0/<total>
            if let Some(cr) = resp.header("Content-Range") {
                if let Some(slash) = cr.rfind('/') {
                    if let Ok(total) = cr[slash + 1..].trim().parse::<u64>() {
                        let mime = resp.header("Content-Type").map(|s| s.to_string());
                        return Some((total, mime));
                    }
                }
            }
        }
    }
    None
}

/// HTTP Range で N 分割して並列ダウンロード
fn parallel_download(
    agent: &ureq::Agent,
    url: &str,
    opts: &SaveUrlOpts,
    final_path: &PathBuf,
    total_size: u64,
    mime: Option<String>,
    app: &AppHandle,
    id: u64,
) -> Result<(), ()> {
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    let n = opts.connections.max(2).min(32) as u64;
    let chunk_size = total_size / n;
    if chunk_size == 0 {
        return Err(());
    }
    // ファイルを事前作成し total_size に拡張
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(final_path)
    {
        Ok(f) => f,
        Err(_) => return Err(()),
    };
    if file.set_len(total_size).is_err() {
        return Err(());
    }
    drop(file);

    let progress = Arc::new(AtomicU64::new(0));
    let aborted = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();

    for i in 0..n {
        let start = i * chunk_size;
        let end = if i == n - 1 {
            total_size - 1
        } else {
            (start + chunk_size) - 1
        };
        let url_c = url.to_string();
        let opts_c = opts.clone();
        let path_c = final_path.clone();
        let agent_c = agent.clone();
        let progress_c = progress.clone();
        let aborted_c = aborted.clone();

        let h = std::thread::spawn(move || -> Result<(), ()> {
            let req = apply_headers(agent_c.get(&url_c), &opts_c)
                .set("Range", &format!("bytes={}-{}", start, end));
            let resp = match req.call() {
                Ok(r) => r,
                Err(_) => {
                    aborted_c.store(true, Ordering::SeqCst);
                    return Err(());
                }
            };
            if resp.status() != 206 && resp.status() != 200 {
                aborted_c.store(true, Ordering::SeqCst);
                return Err(());
            }
            let mut reader = resp.into_reader();
            let mut file = match std::fs::OpenOptions::new().write(true).open(&path_c) {
                Ok(f) => f,
                Err(_) => {
                    aborted_c.store(true, Ordering::SeqCst);
                    return Err(());
                }
            };
            if file.seek(SeekFrom::Start(start)).is_err() {
                aborted_c.store(true, Ordering::SeqCst);
                return Err(());
            }
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                if aborted_c.load(Ordering::SeqCst) {
                    return Err(());
                }
                let n = match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => {
                        aborted_c.store(true, Ordering::SeqCst);
                        return Err(());
                    }
                };
                if file.write_all(&buf[..n]).is_err() {
                    aborted_c.store(true, Ordering::SeqCst);
                    return Err(());
                }
                progress_c.fetch_add(n as u64, Ordering::Relaxed);
            }
            Ok(())
        });
        handles.push(h);
    }

    // 進捗エミットスレッド
    let progress_emit = progress.clone();
    let aborted_emit = aborted.clone();
    let app_emit = app.clone();
    let emitter = std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let cur = progress_emit.load(Ordering::Relaxed);
        if let Some(dl_state) = app_emit.try_state::<DownloadState>() {
            if let Ok(mut s) = dl_state.0.lock() {
                if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                    it.bytes = cur;
                }
            }
        }
        let _ = app_emit.emit(
            "download-progress",
            serde_json::json!({"id": id, "bytes": cur, "total": total_size}),
        );
        if aborted_emit.load(Ordering::SeqCst) || cur >= total_size {
            break;
        }
    });

    let mut all_ok = true;
    for h in handles {
        if h.join().map(|r| r.is_err()).unwrap_or(true) {
            all_ok = false;
        }
    }
    aborted.store(true, Ordering::SeqCst);
    let _ = emitter.join();

    let dl_state: State<'_, DownloadState> = app.state();
    if !all_ok {
        let _ = std::fs::remove_file(final_path);
        if let Ok(mut s) = dl_state.0.lock() {
            if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
                it.status = "failed".into();
                it.finished_at = Some(now_ms());
                let _ = app.emit("download-finished", &it.clone());
            }
            s.save();
        }
        return Err(());
    }
    if let Ok(mut s) = dl_state.0.lock() {
        if let Some(it) = s.items.iter_mut().find(|i| i.id == id) {
            it.status = "completed".into();
            it.finished_at = Some(now_ms());
            it.bytes = total_size;
            it.mime = mime.or_else(|| sniff_mime(final_path));
            let _ = app.emit("download-finished", &it.clone());
        }
        s.save();
    }
    Ok(())
}
