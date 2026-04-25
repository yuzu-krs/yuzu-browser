// yuzu-browser backend.
// 1 つの Window に 2 つの Webview（UI 用 / コンテンツ表示用）を並置することで、
// iframe では表示できないサイト（X-Frame-Options: DENY 等）も表示可能にする。

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WindowEvent};
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use url::Url;

const TOOLBAR_HEIGHT: f64 = 50.0;
const HOME_URL: &str = "https://duckduckgo.com/";

/// View Webview の URL を変更する。
#[tauri::command]
fn browser_navigate(window: tauri::Window, url: String) -> Result<(), String> {
    let view = window
        .get_webview("view")
        .ok_or_else(|| "view webview not found".to_string())?;
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    view.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// View 内で history.back() / forward() / reload() を実行する。
#[tauri::command]
fn browser_history(window: tauri::Window, action: String) -> Result<(), String> {
    let view = window
        .get_webview("view")
        .ok_or_else(|| "view webview not found".to_string())?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown action: {other}")),
    };
    view.eval(script).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![browser_navigate, browser_history])
        .setup(|app| {
            let initial_w: f64 = 1100.0;
            let initial_h: f64 = 720.0;

            let window = WindowBuilder::new(app, "main")
                .title("yuzu-browser")
                .inner_size(initial_w, initial_h)
                .resizable(true)
                .build()?;

            // UI（アドレスバー等）。frontend は Vite/dist のデフォルト URL を使う。
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::default()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(initial_w, TOOLBAR_HEIGHT),
            )?;

            // コンテンツ表示用 Webview。
            let home: Url = HOME_URL.parse().expect("valid home url");
            window.add_child(
                WebviewBuilder::new("view", WebviewUrl::External(home)),
                LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
                LogicalSize::new(initial_w, (initial_h - TOOLBAR_HEIGHT).max(1.0)),
            )?;

            // ウィンドウのリサイズに追従させる。
            let win = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(size) = event {
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical::<f64>(scale);
                    if let Some(ui) = win.get_webview("ui") {
                        let _ = ui.set_position(LogicalPosition::new(0.0, 0.0));
                        let _ = ui.set_size(LogicalSize::new(logical.width, TOOLBAR_HEIGHT));
                    }
                    if let Some(view) = win.get_webview("view") {
                        let _ = view.set_position(LogicalPosition::new(0.0, TOOLBAR_HEIGHT));
                        let _ = view.set_size(LogicalSize::new(
                            logical.width,
                            (logical.height - TOOLBAR_HEIGHT).max(1.0),
                        ));
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
