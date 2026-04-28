// yuzu-browser backend.
// 1 つの Window に「UI webview」と「複数の view webview（タブ）」を並置する。
// アクティブタブの view だけを表示エリアに置き、それ以外は画面外に退避。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl, Window,
    WindowEvent,
};
use url::Url;

const TOOLBAR_HEIGHT: f64 = 50.0;
const TABBAR_HEIGHT: f64 = 36.0;
const BOOKMARKS_BAR_HEIGHT: f64 = 30.0;
const CHROME_HEIGHT: f64 = TOOLBAR_HEIGHT + TABBAR_HEIGHT + BOOKMARKS_BAR_HEIGHT;
const HOME_URL: &str = "https://duckduckgo.com/";
const OFFSCREEN_X: f64 = -20000.0;

const ADBLOCK_SCRIPT: &str = include_str!("../adblock.js");

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
/// `el.volume` を上書きすると動画プレイヤーの音量スライダー操作が無視されてしまうため、
/// ここでは `el.muted` のみを操作する（音量はサイト側に任せる）。
const VOLUME_SCRIPT: &str = r#"
(function () {
  if (window.__yuzuVolInstalled) return;
  window.__yuzuVolInstalled = true;
  if (typeof window.__yuzuMuted !== 'boolean') window.__yuzuMuted = false;
  function apply() {
    var m = !!window.__yuzuMuted;
    document.querySelectorAll('audio,video').forEach(function (el) {
      try { if (el.muted !== m) el.muted = m; } catch (_) {}
    });
  }
  window.__yuzuApplyVolume = apply;
  setInterval(apply, 800);
  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    new MutationObserver(apply).observe(document.body, { subtree: true, childList: true });
    apply();
  }
  start();
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
        window.__TAURI_INTERNALS__.invoke('tab_new', { url: href, background: true });
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
    /// 表示順を保持する。
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
    active: Option<u64>,
    next_id: u64,
    /// 閉じたタブの URL スタック（最新16件）。価として Ctrl+Shift+T で復元する。
    closed: Vec<String>,
}

impl TabState {
    fn summary(&self) -> Vec<TabInfo> {
        self.order
            .iter()
            .map(|id| TabInfo {
                id: *id,
                url: self.urls.get(id).cloned().unwrap_or_default(),
                title: self.titles.get(id).cloned().unwrap_or_default(),
                active: self.active == Some(*id),
                muted: self.volumes.get(id).copied().unwrap_or(1.0) <= 0.0001,
                audible: self.audibles.get(id).copied().unwrap_or(false),
                favicon: self.favicons.get(id).cloned().unwrap_or_default(),
            })
            .collect()
    }
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

/// 全 webview をウィンドウサイズに合わせて再配置する。
fn relayout(window: &Window, state: &TabState) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = match window.inner_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let logical = size.to_logical::<f64>(scale);
    let w = logical.width.max(1.0);
    let h = logical.height.max(1.0);

    if let Some(ui) = window.get_webview("ui") {
        let _ = ui.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = ui.set_size(LogicalSize::new(w, CHROME_HEIGHT));
    }

    let view_h = (h - CHROME_HEIGHT).max(1.0);

    // 白チラつき防止: まず active を表示エリアを覆うサイズにリサイズし、
    // その後で非 active をオフスクリーンへ退避させる。
    if let Some(active_id) = state.active {
        if let Some(view) = window.get_webview(&view_label(active_id)) {
            let _ = view.set_size(LogicalSize::new(w, view_h));
            let _ = view.set_position(LogicalPosition::new(0.0, CHROME_HEIGHT));
        }
    }
    for id in &state.order {
        if Some(*id) == state.active {
            continue;
        }
        if let Some(view) = window.get_webview(&view_label(*id)) {
            // 画面外へ退避（破棄せず保持）。
            let _ = view.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
            let _ = view.set_size(LogicalSize::new(1.0, 1.0));
        }
    }
}

fn emit_tabs(app: &AppHandle, state: &TabState) {
    let _ = app.emit_to("ui", "tabs-updated", state.summary());
}

/// active タブのタイトルをウィンドウタイトルに反映。
fn apply_active_title(window: &Window, state: &TabState) {
    let title = match state.active {
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
    window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(parsed))
                .initialization_script(ADBLOCK_SCRIPT)
                .initialization_script(URL_WATCH_SCRIPT)
                .initialization_script(TITLE_WATCH_SCRIPT)
                .initialization_script(VOLUME_SCRIPT)
                .initialization_script(ZOOM_SCRIPT)
                .initialization_script(AUDIO_WATCH_SCRIPT)
                .initialization_script(FAVICON_WATCH_SCRIPT)
                .initialization_script(LINK_INTERCEPT_SCRIPT)
                .initialization_script(FULLSCREEN_WATCH_SCRIPT)
                .on_navigation(move |u| {
                    let _ = app_for_nav.emit_to(
                        "ui",
                        "view-navigated",
                        serde_json::json!({ "id": id, "url": u.to_string() }),
                    );
                    true
                }),
            LogicalPosition::new(OFFSCREEN_X, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== コマンド =====

/// `create_view` を main スレッドで同期実行するヘルパー。
/// Tauri のコマンドハンドラは worker スレッドで動くため、
/// webview 生成は main へディスパッチしないと動かないことがある。
fn create_view_on_main(
    app: &AppHandle,
    window: &Window,
    id: u64,
    url: &str,
) -> Result<(), String> {
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
) -> Result<u64, String> {
    let target = url.unwrap_or_else(|| HOME_URL.to_string());
    let bg = background.unwrap_or(false);
    // 1) ID だけ確保してロックを即座に解放
    let id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        s.next_id
    };
    // 2) ロック外 + main スレッドで webview 作成
    create_view_on_main(&app, &window, id, &target)?;
    // 3) 改めてロックして状態反映 → relayout → emit
    let snapshot = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.push(id);
        s.urls.insert(id, target);
        if !bg {
            s.active = Some(id);
        } else if s.active.is_none() {
            // active が無いときは結局 active にしないと真っ黒なので。
            s.active = Some(id);
        }
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
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
    let url = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.urls.get(&id).cloned().unwrap_or_default()
    };
    if url.is_empty() {
        return Err("tab url not found".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // 子プロセス用に別の WebView2 ユーザーデータフォルダを用意する。
    // 同じフォルダを複数プロセスで共有するとロック競合でフリーズするため必須。
    let child_udf = {
        let base = std::env::temp_dir().join("yuzu-browser-detached");
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        base.join(unique)
    };
    let _ = std::fs::create_dir_all(&child_udf);
    let mut cmd = std::process::Command::new(&exe);
    cmd.env("YUZU_INITIAL_URL", &url)
        .env("WEBVIEW2_USER_DATA_FOLDER", &child_udf)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Windows: 子プロセスを別プロセスグループにして親の Ctrl+C などの影響を受けないようにする。
    // ※ DETACHED_PROCESS を付けると WebView2 の初期化に失敗してウィンドウが真っ黒になるため、
    //    付けない (GUI アプリは元々コンソールを持たないので CREATE_NEW_PROCESS_GROUP だけで十分)。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to spawn detached window: {e}"))?;
    tab_close(window, app, state, id).await
}

#[tauri::command]
async fn tab_close(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    // 1) ロック内で状態を更新（webview close は別途）
    let close_window = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        // 閉じるタブの URL をスタックに保存（復元用）。
        if let Some(u) = s.urls.get(&id).cloned() {
            if !u.is_empty() && u != HOME_URL {
                s.closed.push(u);
                if s.closed.len() > 16 {
                    s.closed.remove(0);
                }
            }
        }
        s.order.retain(|x| *x != id);
        s.urls.remove(&id);
        s.titles.remove(&id);
        if s.active == Some(id) {
            s.active = s.order.last().copied();
        }
        s.order.is_empty()
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
    let snapshot = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
    Ok(())
}

#[tauri::command]
fn tab_switch(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    if !s.order.contains(&id) {
        return Err(format!("unknown tab id: {id}"));
    }
    s.active = Some(id);
    relayout(&window, &s);
    apply_active_title(&window, &s);
    emit_tabs(&app, &s);
    Ok(())
}

#[tauri::command]
fn tab_list(state: State<'_, AppState>) -> Result<Vec<TabInfo>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.summary())
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
        s.urls.get(&id).cloned().unwrap_or_else(|| HOME_URL.to_string())
    };
    let new_id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.next_id += 1;
        s.next_id
    };
    create_view_on_main(&app, &window, new_id, &url)?;
    let snapshot = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        // 元タブの直後に挿入
        let pos = s.order.iter().position(|x| *x == id).map(|p| p + 1).unwrap_or(s.order.len());
        s.order.insert(pos, new_id);
        s.urls.insert(new_id, url);
        s.active = Some(new_id);
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
    Ok(new_id)
}

/// 直近に閉じたタブを復元（スタック LIFO）。
#[tauri::command]
async fn tab_reopen(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<u64>, String> {
    let url = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.closed.pop()
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
    let snapshot = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.push(id);
        s.urls.insert(id, url);
        s.active = Some(id);
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
    Ok(Some(id))
}

/// 指定タブ以外を全て閉じる。
#[tauri::command]
async fn tab_close_others(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let to_close: Vec<u64> = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.iter().copied().filter(|x| *x != id).collect()
    };
    for cid in to_close {
        {
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(u) = s.urls.get(&cid).cloned() {
                if !u.is_empty() && u != HOME_URL {
                    s.closed.push(u);
                    if s.closed.len() > 16 { s.closed.remove(0); }
                }
            }
            s.order.retain(|x| *x != cid);
            s.urls.remove(&cid);
            s.titles.remove(&cid);
        }
        if let Some(view) = window.get_webview(&view_label(cid)) {
            let _ = view.close();
        }
    }
    let snapshot = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.active = Some(id);
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
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
    let to_close: Vec<u64> = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        match s.order.iter().position(|x| *x == id) {
            Some(pos) => s.order[pos + 1..].to_vec(),
            None => Vec::new(),
        }
    };
    for cid in to_close {
        {
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(u) = s.urls.get(&cid).cloned() {
                if !u.is_empty() && u != HOME_URL {
                    s.closed.push(u);
                    if s.closed.len() > 16 { s.closed.remove(0); }
                }
            }
            s.order.retain(|x| *x != cid);
            s.urls.remove(&cid);
            s.titles.remove(&cid);
            if s.active == Some(cid) {
                s.active = Some(id);
            }
        }
        if let Some(view) = window.get_webview(&view_label(cid)) {
            let _ = view.close();
        }
    }
    let snapshot = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
        apply_active_title(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
    Ok(())
}

/// タブを並び替える（id を to_index の位置へ移動）。
#[tauri::command]
fn tab_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    to_index: usize,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let from = match s.order.iter().position(|x| *x == id) {
        Some(p) => p,
        None => return Err(format!("unknown tab id: {id}")),
    };
    let removed = s.order.remove(from);
    let dst = to_index.min(s.order.len());
    s.order.insert(dst, removed);
    emit_tabs(&app, &s);
    Ok(())
}

/// アクティブタブの view を URL 遷移させる。
#[tauri::command]
fn browser_navigate(
    window: Window,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let id = s.active.ok_or_else(|| "no active tab".to_string())?;
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
    let id = s.active.ok_or_else(|| "no active tab".to_string())?;
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
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
    app.emit_to(
        "ui",
        "view-navigated",
        serde_json::json!({ "id": id, "url": url }),
    )
    .map_err(|e| e.to_string())
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
    s.titles.insert(id, title);
    if s.active == Some(id) {
        apply_active_title(&window, &s);
    }
    emit_tabs(&app, &s);
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
    s.favicons.insert(id, url);
    emit_tabs(&app, &s);
    Ok(())
}

// ===== 音量 =====

#[tauri::command]
fn tab_get_volume(webview: Webview, state: State<'_, AppState>) -> Result<f64, String> {
    let label = webview.label().to_string();
    // UI からは active タブを対象に、view からは自身の id を対象にする。
    let s = state.0.lock().map_err(|e| e.to_string())?;
    let id = parse_view_id(&label).or(s.active).ok_or_else(|| "no tab".to_string())?;
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
    }
    let _ = app.emit_to(
        "ui",
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
    let id = parse_view_id(&label).or(s.active).ok_or_else(|| "no tab".to_string())?;
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
        "ui",
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
        "ui",
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
    let id_and_new = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let id = s.active.ok_or_else(|| "no active tab".to_string())?;
        let cur = s.zooms.get(&id).copied().unwrap_or(1.0);
        let z = ((cur + delta) * 100.0).round() / 100.0;
        let z = z.clamp(0.25, 5.0);
        s.zooms.insert(id, z);
        (id, z)
    };
    apply_zoom_to(&window, id_and_new.0, id_and_new.1);
    let _ = app.emit_to(
        "ui",
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
    let id = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        let id = s.active.ok_or_else(|| "no active tab".to_string())?;
        s.zooms.insert(id, z);
        id
    };
    apply_zoom_to(&window, id, z);
    let _ = app.emit_to(
        "ui",
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
        let len = s.order.len();
        let pos = s.order.iter().position(|&x| x == id);
        let has_right = pos.map(|p| p + 1 < len).unwrap_or(false);
        (len > 1, has_right)
    };

    let mk = |action: &str| format!("yuzu-tabmenu:{action}:{id}");

    let new_tab = MenuItemBuilder::with_id(mk("new"), "新規タブ").build(&app).map_err(|e| e.to_string())?;
    let dup = MenuItemBuilder::with_id(mk("duplicate"), "タブを複製").build(&app).map_err(|e| e.to_string())?;
    let reload = MenuItemBuilder::with_id(mk("reload"), "ページを再読み込み").build(&app).map_err(|e| e.to_string())?;
    let reopen = MenuItemBuilder::with_id(mk("reopen"), "閉じたタブを復元").build(&app).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let close_right = MenuItemBuilder::with_id(mk("close_right"), "右側のタブを全て閉じる")
        .enabled(has_right)
        .build(&app).map_err(|e| e.to_string())?;
    let close_others = MenuItemBuilder::with_id(mk("close_others"), "他のタブを全て閉じる")
        .enabled(has_others)
        .build(&app).map_err(|e| e.to_string())?;
    let close = MenuItemBuilder::with_id(mk("close"), "タブを閉じる").build(&app).map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(&app)
        .items(&[&new_tab, &dup, &reload, &reopen, &sep, &close_right, &close_others, &close])
        .build()
        .map_err(|e| e.to_string())?;

    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== ブックマーク =====
//
// プライバシーを重視するため履歴は永続化しないが、ブックマークだけはユーザーが
// 明示的に保存したものなので JSON ファイルに永続化する。

#[derive(Serialize, Deserialize, Clone, Default)]
struct Bookmark {
    id: u64,
    url: String,
    title: String,
    favicon: String,
}

#[derive(Default)]
struct BookmarkStore {
    next_id: u64,
    items: Vec<Bookmark>,
    path: Option<PathBuf>,
}

impl BookmarkStore {
    fn load(path: PathBuf) -> Self {
        let mut store = BookmarkStore { next_id: 0, items: Vec::new(), path: Some(path.clone()) };
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(items) = serde_json::from_str::<Vec<Bookmark>>(&text) {
                store.next_id = items.iter().map(|b| b.id).max().unwrap_or(0);
                store.items = items;
            }
        }
        store
    }

    fn save(&self) -> Result<(), String> {
        let path = match &self.path {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&self.items).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct BookmarksState(Mutex<BookmarkStore>);

#[tauri::command]
fn bookmark_list(state: State<'_, BookmarksState>) -> Result<Vec<Bookmark>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.items.clone())
}

#[tauri::command]
fn bookmark_add(
    app: AppHandle,
    state: State<'_, BookmarksState>,
    tab_state: State<'_, AppState>,
    url: Option<String>,
    title: Option<String>,
    favicon: Option<String>,
) -> Result<Bookmark, String> {
    // 引数が無ければ active タブの情報を使う。
    let (resolved_url, resolved_title, resolved_favicon) = {
        let ts = tab_state.0.lock().map_err(|e| e.to_string())?;
        let active = ts.active;
        let u = url.or_else(|| active.and_then(|id| ts.urls.get(&id).cloned())).unwrap_or_default();
        let t = title.or_else(|| active.and_then(|id| ts.titles.get(&id).cloned())).unwrap_or_default();
        let f = favicon.or_else(|| active.and_then(|id| ts.favicons.get(&id).cloned())).unwrap_or_default();
        (u, t, f)
    };
    if resolved_url.is_empty() {
        return Err("URL is empty".to_string());
    }
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    // 既に同じ URL が登録済みなら何もしない。
    if let Some(existing) = s.items.iter().find(|b| b.url == resolved_url).cloned() {
        return Ok(existing);
    }
    s.next_id += 1;
    let bm = Bookmark {
        id: s.next_id,
        url: resolved_url,
        title: resolved_title,
        favicon: resolved_favicon,
    };
    s.items.push(bm.clone());
    s.save()?;
    let _ = app.emit_to("ui", "bookmarks-updated", s.items.clone());
    Ok(bm)
}

#[tauri::command]
fn bookmark_remove(
    app: AppHandle,
    state: State<'_, BookmarksState>,
    id: u64,
) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    s.items.retain(|b| b.id != id);
    s.save()?;
    let _ = app.emit_to("ui", "bookmarks-updated", s.items.clone());
    Ok(())
}

#[tauri::command]
fn bookmark_reorder(
    app: AppHandle,
    state: State<'_, BookmarksState>,
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
    s.save()?;
    let _ = app.emit_to("ui", "bookmarks-updated", s.items.clone());
    Ok(())
}

/// active タブが既にブックマークされているかを返す。
#[tauri::command]
fn bookmark_is_current(
    state: State<'_, BookmarksState>,
    tab_state: State<'_, AppState>,
) -> Result<bool, String> {
    let url = {
        let ts = tab_state.0.lock().map_err(|e| e.to_string())?;
        match ts.active.and_then(|id| ts.urls.get(&id).cloned()) {
            Some(u) => u,
            None => return Ok(false),
        }
    };
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.items.iter().any(|b| b.url == url))
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
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let w = size.width.max(1.0);
    let h = size.height.max(1.0);
    if expanded {
        if let Some(ui) = window.get_webview("ui") {
            let _ = ui.set_size(LogicalSize::new(w, h));
        }
        // active view も画面外に退避（クリックを UI 側だけで受け取る）。
        let s = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(active_id) = s.active {
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
    let active = match s.active {
        Some(id) => id,
        None => return Ok(()),
    };
    if label != view_label(active) {
        return Ok(());
    }
    drop(s);

    if fullscreen {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let w = size.width.max(1.0);
        let h = size.height.max(1.0);
        if let Some(ui) = window.get_webview("ui") {
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
        s.active.ok_or_else(|| "no active tab".to_string())?
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
      node.gain.value = GAIN;
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
    std::env::var("USERPROFILE").ok().map(|p| PathBuf::from(p).join("Downloads"))
}
#[cfg(not(target_os = "windows"))]
fn dirs_download() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|p| PathBuf::from(p).join("Downloads"))
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
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| format!("一時ファイル作成失敗: {}", e))?;
        let mut reader = resp.into_reader();
        std::io::copy(&mut reader, &mut file)
            .map_err(|e| format!("yt-dlp 書き込み失敗: {}", e))?;
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

    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--no-colors")
        .arg("--newline")
        .arg("--no-mtime")
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
    cmd.arg(&args.url);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("yt-dlp の起動に失敗: {} (実行ファイル: {})", e, exe)
    })?;
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
            line: format!("$ {} {}", exe, args.url),
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
                    YtdlpProgress { job_id, line, kind: "stdout".to_string() },
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
                    YtdlpProgress { job_id, line, kind: "stderr".to_string() },
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
            YtdlpDone { job_id, success, code },
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

    let parent = path.parent().ok_or_else(|| "親ディレクトリ無し".to_string())?;
    let zip_path = parent.join("ffmpeg-download.zip");
    {
        let resp = ureq::get(url)
            .call()
            .map_err(|e| format!("ffmpeg ダウンロード失敗: {}", e))?;
        let mut file = std::fs::File::create(&zip_path)
            .map_err(|e| format!("一時ファイル作成失敗: {}", e))?;
        let mut reader = resp.into_reader();
        std::io::copy(&mut reader, &mut file)
            .map_err(|e| format!("ffmpeg 書き込み失敗: {}", e))?;
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
        "ico" => ("ico", vec!["-vf", "scale=256:256:force_original_aspect_ratio=decrease"]),
        "avif" => ("avif", vec!["-c:v", "libaom-av1", "-still-picture", "1"]),
        // 動画
        "mp4" => ("mp4", vec!["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]),
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
                "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico", "avif",
                "heic", "heif", "mp4", "webm", "mkv", "mov", "avi", "m4v", "flv", "wmv",
                "mp3", "wav", "ogg", "m4a", "flac", "opus", "aac", "wma",
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
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("出力フォルダ作成失敗: {}", e))?;
    }
    let stem = in_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let mut out_path = out_dir.join(format!("{}.{}", stem, ext));
    // 既存があれば連番
    let mut n = 1;
    while out_path.exists()
        && out_path.canonicalize().ok() != in_path.canonicalize().ok()
    {
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
    cmd.arg("-hide_banner")
        .arg("-y")
        .arg("-i")
        .arg(&in_path);
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ffmpeg 起動失敗: {}", e))?;
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
                    ConvProgress { job_id, line, kind: "stdout".to_string() },
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
                    ConvProgress { job_id, line, kind: "stderr".to_string() },
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
fn toolbox_convert_cancel(
    state: State<'_, ToolboxState>,
    job_id: u64,
) -> Result<(), String> {
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
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("保存先フォルダ作成失敗: {}", e))?;

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
        base_name.truncate(80);
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
    std::fs::write(&path, &bytes).map_err(|e| format!("書き込み失敗: {}", e))?;
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
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || ch.is_control()
        {
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
    function score(el){
      var ps = el.getElementsByTagName('p');
      var len = 0;
      for (var i=0;i<ps.length;i++) len += (ps[i].innerText||'').length;
      return len;
    }
    var candidates = [];
    var tags = ['article','main','[role=\"main\"]','#main','#content','.content','.post','.entry'];
    for (var t=0;t<tags.length;t++){
      var nodes = document.querySelectorAll(tags[t]);
      for (var i=0;i<nodes.length;i++) candidates.push(nodes[i]);
    }
    if (candidates.length===0) {
      var all = document.body.querySelectorAll('div,section');
      for (var i=0;i<all.length;i++) candidates.push(all[i]);
    }
    var best=null, bestScore=0;
    for (var i=0;i<candidates.length;i++){
      var s = score(candidates[i]);
      if (s>bestScore){ bestScore=s; best=candidates[i]; }
    }
    if (!best || bestScore < 200) best = document.body;
    var title = (document.querySelector('h1') && document.querySelector('h1').innerText) || document.title || '';
    var content = best.cloneNode(true);
    // スクリプト/スタイル/ナビ/サイドバー/フッタ/iframeを除去
    var rm = content.querySelectorAll('script,style,nav,aside,header,footer,iframe,noscript,form,button,input,svg');
    for (var i=0;i<rm.length;i++) rm[i].remove();
    var overlay = document.createElement('div');
    overlay.id = '__yuzu-reader-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#1a1814;color:#e8e3d8;overflow:auto;padding:48px 24px;font-family:Georgia,\"Hiragino Mincho ProN\",\"Yu Mincho\",serif;font-size:18px;line-height:1.85;';
    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:720px;margin:0 auto;';
    var h = document.createElement('h1');
    h.textContent = title;
    h.style.cssText = 'font-size:28px;line-height:1.3;margin:0 0 24px 0;color:#fff;border-bottom:1px solid #3a352c;padding-bottom:12px;';
    inner.appendChild(h);
    var article = document.createElement('article');
    article.appendChild(content);
    var imgs = article.querySelectorAll('img');
    for (var i=0;i<imgs.length;i++){ imgs[i].style.maxWidth='100%'; imgs[i].style.height='auto'; }
    var links = article.querySelectorAll('a');
    for (var i=0;i<links.length;i++){ links[i].style.color='#7eb6ff'; }
    inner.appendChild(article);
    overlay.appendChild(inner);
    document.documentElement.appendChild(overlay);
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
        s.active.ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;
    let script = if enabled { READER_ON_JS } else { READER_OFF_JS };
    view.eval(script).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== スクリーンショット =====

#[tauri::command]
fn toolbox_screenshot(
    window: Window,
    state: State<'_, AppState>,
    dir: String,
) -> Result<String, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("保存先が未設定です".to_string());
    }
    let id = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        s.active.ok_or_else(|| "no active tab".to_string())?
    };
    let view = window
        .get_webview(&view_label(id))
        .ok_or_else(|| "active view not found".to_string())?;

    let inner_pos = window.inner_position().map_err(|e| e.to_string())?;
    let view_pos = view.position().map_err(|e| e.to_string())?;
    let view_size = view.size().map_err(|e| e.to_string())?;
    let abs_x = inner_pos.x + view_pos.x;
    let abs_y = inner_pos.y + view_pos.y;

    let monitor = xcap::Monitor::from_point(abs_x, abs_y)
        .map_err(|e| format!("モニタ取得失敗: {}", e))?;
    let mx = monitor.x();
    let my = monitor.y();
    let mw = monitor.width();
    let mh = monitor.height();
    let img = monitor
        .capture_image()
        .map_err(|e| format!("画面キャプチャ失敗: {}", e))?;

    let local_x = (abs_x - mx).max(0) as u32;
    let local_y = (abs_y - my).max(0) as u32;
    let max_w = mw.saturating_sub(local_x);
    let max_h = mh.saturating_sub(local_y);
    let crop_w = view_size.width.min(max_w).max(1);
    let crop_h = view_size.height.min(max_h).max(1);
    let cropped =
        image::imageops::crop_imm(&img, local_x, local_y, crop_w, crop_h).to_image();

    let dir_path = std::path::PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("保存先フォルダ作成失敗: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir_path.join(format!("screenshot_{}.png", ts));
    cropped
        .save(&path)
        .map_err(|e| format!("保存失敗: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// ===== スクレイピング =====

#[derive(serde::Serialize)]
struct ScrapeResult {
    status: u16,
    content_type: String,
    body: String,
    bytes: usize,
}

#[tauri::command]
fn toolbox_scrape_fetch(
    url: String,
    user_agent: Option<String>,
) -> Result<ScrapeResult, String> {
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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) yuzu-browser/0.1"
                .to_string()
        });
    let resp = ureq::get(&url)
        .set("User-Agent", &ua)
        .set("Accept", "text/html,*/*;q=0.8")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("取得失敗: {}", e))?;
    let status = resp.status();
    let content_type = resp.content_type().to_string();
    let mut reader = resp.into_reader();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)
            .map_err(|e| format!("読込失敗: {}", e))?;
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
    SevenZ,
    Gz,
    Bz2,
    Xz,
    Zst,
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
    } else if n.ends_with(".tar") {
        ArchiveFormat::Tar
    } else if n.ends_with(".zip") {
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
    } else {
        ArchiveFormat::Unknown
    }
}

fn extract_zip(src: &std::path::Path, dest: &std::path::Path) -> Result<(usize, u64), String> {
    let file = std::fs::File::open(src).map_err(|e| format!("読込失敗: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("zip 読込失敗: {}", e))?;
    let mut count = 0usize;
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {}: {}", i, e))?;
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
        }
    }
    Ok((count, total))
}

fn extract_tar_reader<R: std::io::Read>(
    reader: R,
    dest: &std::path::Path,
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
                ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.zstd",
            ] {
                if lower.ends_with(ext) {
                    return n[..n.len() - ext.len()].to_string() + ".tar";
                }
            }
            for ext in [".tgz", ".tbz2", ".tbz", ".txz", ".tzst"] {
                if lower.ends_with(ext) {
                    return n[..n.len() - ext.len()].to_string() + ".tar";
                }
            }
            for ext in [".gz", ".bz2", ".xz", ".lzma", ".zst", ".zstd"] {
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
    let mut out =
        std::fs::File::create(&outpath).map_err(|e| format!("create: {}", e))?;
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
        _ => return Err("単体形式ではありません".to_string()),
    };
    Ok((1, n, outpath))
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

#[tauri::command]
fn toolbox_extract_archive(
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

    let fmt = detect_format(&src);
    let (count, bytes, format) = match fmt {
        ArchiveFormat::Zip => {
            let (c, b) = extract_zip(&src, &dest)?;
            (c, b, "zip")
        }
        ArchiveFormat::Tar => {
            let (c, b) = extract_tar_reader(buffered_file(&src)?, &dest)?;
            (c, b, "tar")
        }
        ArchiveFormat::TarGz => {
            let r = flate2::read::GzDecoder::new(buffered_file(&src)?);
            let (c, b) = extract_tar_reader(r, &dest)?;
            (c, b, "tar.gz")
        }
        ArchiveFormat::TarBz2 => {
            let r = bzip2_rs::DecoderReader::new(buffered_file(&src)?);
            let (c, b) = extract_tar_reader(r, &dest)?;
            (c, b, "tar.bz2")
        }
        ArchiveFormat::TarXz => {
            let v = xz_to_vec(&src)?;
            let (c, b) = extract_tar_reader(std::io::Cursor::new(v), &dest)?;
            (c, b, "tar.xz")
        }
        ArchiveFormat::TarZst => {
            let r = ruzstd::StreamingDecoder::new(buffered_file(&src)?)
                .map_err(|e| format!("zstd: {}", e))?;
            let (c, b) = extract_tar_reader(r, &dest)?;
            (c, b, "tar.zst")
        }
        ArchiveFormat::SevenZ => {
            let before = count_dir(&dest);
            sevenz_rust::decompress_file(&src, &dest)
                .map_err(|e| format!("7z: {}", e))?;
            let after = count_dir(&dest);
            (
                after.0.saturating_sub(before.0),
                after.1.saturating_sub(before.1),
                "7z",
            )
        }
        ArchiveFormat::Gz | ArchiveFormat::Bz2 | ArchiveFormat::Xz | ArchiveFormat::Zst => {
            let (c, b, _p) = extract_single(&src, &dest, fmt)?;
            let label = match fmt {
                ArchiveFormat::Gz => "gz",
                ArchiveFormat::Bz2 => "bz2",
                ArchiveFormat::Xz => "xz",
                _ => "zst",
            };
            (c, b, label)
        }
        ArchiveFormat::Unknown => {
            return Err(
                "対応していない拡張子です (zip/tar/tar.gz/tar.bz2/tar.xz/tar.zst/7z/gz/bz2/xz/zst)"
                    .to_string(),
            )
        }
    };

    Ok(ExtractResult {
        files: count,
        bytes,
        dest: dest.to_string_lossy().to_string(),
        format: format.to_string(),
    })
}

#[tauri::command]
async fn toolbox_pick_archive(initial: Option<String>) -> Result<Option<String>, String> {
    let mut dlg = rfd::AsyncFileDialog::new()
        .add_filter(
            "アーカイブ",
            &[
                "zip", "tar", "tgz", "tbz", "tbz2", "txz", "tzst", "7z", "gz", "bz2", "xz",
                "lzma", "zst", "zstd",
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

#[tauri::command]
fn toolbox_get_audio_tags(path: String) -> Result<AudioTagData, String> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, ItemKey};
    let p = std::path::PathBuf::from(path.trim());
    let tagged = lofty::read_from_path(&p).map_err(|e| format!("音声読込失敗: {}", e))?;
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
            data.picture_mime = Some(format!("{:?}", pic.mime_type()));
            data.picture_size = Some(pic.data().len());
        }
    }
    Ok(data)
}

fn audio_set_or_remove(
    tag: &mut lofty::tag::Tag,
    key: lofty::tag::ItemKey,
    v: &Option<String>,
) {
    match v {
        Some(s) if !s.is_empty() => {
            tag.insert_text(key, s.clone());
        }
        _ => {
            tag.remove_key(&key);
        }
    }
}

#[tauri::command]
fn toolbox_save_audio_tags(path: String, data: AudioTagData) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::tag::{Accessor, ItemKey, Tag, TagExt};
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("音声読込失敗: {}", e))?;
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

    tag.save_to_path(&p, WriteOptions::default())
        .map_err(|e| format!("書込失敗: {}", e))?;
    Ok(())
}

#[tauri::command]
fn toolbox_clear_audio_tags(path: String) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::tag::TagExt;
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("音声読込失敗: {}", e))?;
    let types: Vec<_> = tagged.tags().iter().map(|t| t.tag_type()).collect();
    for t in types {
        let _ = tagged.remove(t);
    }
    // タグが全て無くなった状態を保存。空の primary を作って書き出す
    let primary_type = tagged.primary_tag_type();
    let empty = lofty::tag::Tag::new(primary_type);
    empty
        .save_to_path(&p, WriteOptions::default())
        .map_err(|e| format!("書込失敗: {}", e))?;
    Ok(())
}

#[tauri::command]
fn toolbox_set_audio_picture(audio_path: String, image_path: String) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::tag::{Tag, TagExt};
    let p = std::path::PathBuf::from(audio_path.trim());
    let img_path = std::path::PathBuf::from(image_path.trim());
    let bytes = std::fs::read(&img_path).map_err(|e| format!("画像読込失敗: {}", e))?;
    let ext = img_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    let mime = match ext.as_deref() {
        Some("jpg") | Some("jpeg") => MimeType::Jpeg,
        Some("png") => MimeType::Png,
        Some("gif") => MimeType::Gif,
        Some("bmp") => MimeType::Bmp,
        Some("tiff") | Some("tif") => MimeType::Tiff,
        _ => MimeType::Jpeg,
    };
    let pic = Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes);
    let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("音声読込失敗: {}", e))?;
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
    tag.save_to_path(&p, WriteOptions::default())
        .map_err(|e| format!("書込失敗: {}", e))?;
    Ok(())
}

#[tauri::command]
fn toolbox_remove_audio_picture(path: String) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::tag::TagExt;
    let p = std::path::PathBuf::from(path.trim());
    let mut tagged = lofty::read_from_path(&p).map_err(|e| format!("音声読込失敗: {}", e))?;
    if let Some(tag) = tagged.primary_tag_mut() {
        while !tag.pictures().is_empty() {
            let _ = tag.remove_picture(0);
        }
        tag.save_to_path(&p, WriteOptions::default())
            .map_err(|e| format!("書込失敗: {}", e))?;
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
                    if matches!(m, 0xFEEDFACE | 0xFEEDFACF | 0xCEFAEDFE | 0xCFFAEDFE | 0xCAFEBABE) {
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
    "Title", "Author", "Subject", "Keywords", "Creator", "Producer",
    "CreationDate", "ModDate",
];

fn read_pdf_meta(path: &std::path::Path) -> Result<GenericMeta, String> {
    let doc = lopdf::Document::load(path).map_err(|e| format!("PDF 読込失敗: {}", e))?;
    let mut fields = Vec::new();
    let info_id = doc.trailer.get(b"Info").ok().and_then(|v| v.as_reference().ok());
    if let Some(id) = info_id {
        if let Ok(obj) = doc.get_object(id) {
            if let Ok(dict) = obj.as_dict() {
                for k in PDF_INFO_KEYS {
                    let v = dict.get(k.as_bytes()).ok().and_then(|o| match o {
                        lopdf::Object::String(s, _) => {
                            String::from_utf8(s.clone()).ok()
                        }
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
    let info = format!("PDF version: {}\nPages: {}", doc.version, doc.get_pages().len());
    Ok(GenericMeta {
        kind: "pdf".to_string(),
        editable: true,
        fields,
        info,
    })
}

fn write_pdf_meta(
    path: &std::path::Path,
    fields: &[GenericField],
) -> Result<(), String> {
    let mut doc = lopdf::Document::load(path).map_err(|e| format!("PDF 読込失敗: {}", e))?;
    let info_id = doc.trailer.get(b"Info").ok().and_then(|v| v.as_reference().ok());
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
            e.read_to_end(&mut buf).map_err(|e| format!("read: {}", e))?;
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
                zw.write_all(new_content).map_err(|e| format!("write: {}", e))?;
                wrote_target = true;
            } else {
                zw.start_file(name, opts).map_err(|e| format!("start: {}", e))?;
                std::io::copy(&mut e, &mut zw).map_err(|e| format!("copy: {}", e))?;
            }
        }
        if !wrote_target {
            zw.start_file(target_name.to_string(), opts)
                .map_err(|e| format!("start: {}", e))?;
            use std::io::Write;
            zw.write_all(new_content).map_err(|e| format!("write: {}", e))?;
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
        let (px, lc) = if local == prefix { ("", local) } else { (prefix, local) };
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
    let xml_bytes = zip_read_entry(path, &opf)?
        .ok_or_else(|| "OPF が見つかりません".to_string())?;
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
    let bytes = zip_read_entry(path, &opf)?
        .ok_or_else(|| "OPF が見つかりません".to_string())?;
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
        let end = after.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(after.len());
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
        if let Ok(tagged) = lofty::read_from_path(path) {
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
    f.read_exact(&mut head).map_err(|e| format!("Mach-O: {}", e))?;
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
    f.read_exact(&mut buf).map_err(|e| format!("ISO read: {}", e))?;
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
fn toolbox_save_generic_meta(
    path: String,
    fields: Vec<GenericField>,
) -> Result<(), String> {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(BookmarksState::default())
        .manage(ToolboxState::default())
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
            bookmark_list,
            bookmark_add,
            bookmark_remove,
            bookmark_reorder,
            bookmark_is_current,
            ui_set_expanded,
            view_set_fullscreen,
            view_set_volume_boost,
            toolbox_settings_get,
            toolbox_settings_set,
            toolbox_pick_download_dir,
            toolbox_default_download_dir,
            toolbox_ytdlp_run,
            toolbox_ytdlp_cancel,
            toolbox_open_path,
            toolbox_pick_file,
            toolbox_convert_run,
            toolbox_convert_cancel,
            toolbox_save_page_html,
            view_set_reader_mode,
            toolbox_screenshot,
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
            toolbox_remove_audio_picture,
            toolbox_get_generic_meta,
            toolbox_save_generic_meta,
        ])
        .setup(|app| {
            // ブックマークを app data dir からロード。
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("bookmarks.json");
                let store = BookmarkStore::load(path);
                let state: State<'_, BookmarksState> = app.state();
                if let Ok(mut s) = state.0.lock() {
                    *s = store;
                };
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
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::default())
                    .disable_drag_drop_handler(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(initial_w, CHROME_HEIGHT),
            )?;

            // 初期タブを 1 つ作成。
            let app_handle = app.handle().clone();
            let state: State<'_, AppState> = app.state();
            {
                let mut s = state.0.lock().expect("state poisoned");
                s.next_id += 1;
                let id = s.next_id;
                // 切り離しウィンドウなど、外部から URL が指定されていればそれを使う。
                let initial_url = std::env::var("YUZU_INITIAL_URL")
                    .ok()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| HOME_URL.to_string());
                create_view(&window, &app_handle, id, &initial_url).expect("create initial view");
                s.order.push(id);
                s.urls.insert(id, initial_url);
                s.active = Some(id);
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
