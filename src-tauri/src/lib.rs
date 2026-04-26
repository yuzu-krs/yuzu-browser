// yuzu-browser backend.
// 1 つの Window に「UI webview」と「複数の view webview（タブ）」を並置する。
// アクティブタブの view だけを表示エリアに置き、それ以外は画面外に退避。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
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

#[derive(Default)]
struct TabState {
    /// 表示順を保持する。
    order: Vec<u64>,
    /// 各タブの最新 URL。
    urls: HashMap<u64, String>,
    active: Option<u64>,
    next_id: u64,
}

impl TabState {
    fn summary(&self) -> Vec<TabInfo> {
        self.order
            .iter()
            .map(|id| TabInfo {
                id: *id,
                url: self.urls.get(id).cloned().unwrap_or_default(),
                active: self.active == Some(*id),
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
    active: bool,
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
) -> Result<u64, String> {
    let target = url.unwrap_or_else(|| HOME_URL.to_string());
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
        s.active = Some(id);
        relayout(&window, &s);
        s.summary()
    };
    let _ = app.emit_to("ui", "tabs-updated", snapshot);
    Ok(id)
}

#[tauri::command]
async fn tab_close(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    // 1) ロック内で状態を更新（webview close は別途）
    let (need_new_tab, new_id_opt) = {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.order.retain(|x| *x != id);
        s.urls.remove(&id);
        if s.active == Some(id) {
            s.active = s.order.last().copied();
        }
        if s.order.is_empty() {
            s.next_id += 1;
            (true, Some(s.next_id))
        } else {
            (false, None)
        }
    };
    // 2) ロック外で webview close
    if let Some(view) = window.get_webview(&view_label(id)) {
        let _ = view.close();
    }
    // 3) 必要なら新規タブを作成（ロック外、main スレッド）
    if need_new_tab {
        if let Some(new_id) = new_id_opt {
            create_view_on_main(&app, &window, new_id, HOME_URL)?;
            let mut s = state.0.lock().map_err(|e| e.to_string())?;
            s.order.push(new_id);
            s.urls.insert(new_id, HOME_URL.to_string());
            s.active = Some(new_id);
        }
    }
    // 4) relayout + emit
    let snapshot = {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        relayout(&window, &s);
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
    emit_tabs(&app, &s);
    Ok(())
}

#[tauri::command]
fn tab_list(state: State<'_, AppState>) -> Result<Vec<TabInfo>, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.summary())
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
    }
    app.emit_to(
        "ui",
        "view-navigated",
        serde_json::json!({ "id": id, "url": url }),
    )
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            tab_new,
            tab_close,
            tab_switch,
            tab_list,
            browser_navigate,
            browser_history,
            browser_url_changed,
        ])
        .setup(|app| {
            let initial_w: f64 = 1100.0;
            let initial_h: f64 = 720.0;

            let window = WindowBuilder::new(app, "main")
                .title("yuzu-browser")
                .inner_size(initial_w, initial_h)
                .background_color(tauri::window::Color(26, 26, 26, 255))
                .resizable(true)
                .build()?;

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
                create_view(&window, &app_handle, id, HOME_URL).expect("create initial view");
                s.order.push(id);
                s.urls.insert(id, HOME_URL.to_string());
                s.active = Some(id);
                relayout(&window, &s);
            }

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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
