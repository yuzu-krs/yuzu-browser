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
const CHROME_HEIGHT: f64 = TOOLBAR_HEIGHT + TABBAR_HEIGHT;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(BookmarksState::default())
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
            bookmark_list,
            bookmark_add,
            bookmark_remove,
            bookmark_is_current,
            ui_set_expanded,
            view_set_fullscreen,
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
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::default()),
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
