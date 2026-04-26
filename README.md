# yuzu-browser

A lightweight, privacy-oriented desktop web browser built with **Tauri 2**, **Rust**, and **TypeScript**.

> **Status:** Early development — contributions and feedback are very welcome!

---

## Concept

yuzu-browser is built around three core principles:

### 🪶 Lightweight
No Electron, no heavy runtime. yuzu-browser is powered by **Tauri 2 + WebView2**, which means it uses the OS-native webview instead of bundling a full Chromium. The result is a small binary, low memory footprint, and fast startup — even on modest hardware.

### 🔒 Privacy-first
By default, nothing is persisted. No browsing history, no cookies carried between sessions, no telemetry. The default search engine is **DuckDuckGo**. A built-in ad-blocking initialization script prevents common trackers from loading. The goal is a browser where anonymous, low-footprint browsing is the default — not an opt-in.

### 🛠️ Developer-focused
yuzu-browser is designed to be **hackable**. The entire UI is plain TypeScript and CSS, the backend is straightforward Rust, and the architecture is intentionally minimal. Whether you want to add a custom userscript injector, a request interceptor, or a completely different UI, the codebase stays out of your way. It is also an ideal sandboxed environment for testing web applications during development.

---

## Features

- **Multi-tab browsing** — open, close, reorder (drag & drop), duplicate, and restore closed tabs
- **Address bar** — smart input that auto-detects URLs vs. search queries
- **Default search engine: DuckDuckGo** — privacy-first out of the box
- **Tab context menu** — native OS menu with duplicate, reload, close-others, and more
- **Per-tab zoom** — Ctrl+Scroll, Ctrl++/-, Ctrl+0 to reset
- **Per-tab mute** — mute/unmute any tab independently; indicator shown only when audio is playing
- **Favicon display** — fetches and shows the site favicon for each tab
- **Ad blocking** — built-in initialization script blocks common ad domains
- **No persistent history** — browsing history is kept in memory only; nothing is written to disk
- **Dark UI** — minimal, dark-themed chrome

## Architecture

```
yuzu-browser/
├── src/             # Frontend (TypeScript + CSS)
│   ├── main.ts      # Tab management, address bar, keyboard shortcuts
│   └── styles.css
├── src-tauri/       # Rust backend (Tauri 2)
│   ├── src/
│   │   └── lib.rs   # Commands, state, webview layout
│   └── tauri.conf.json
└── index.html       # UI webview (toolbar + tab bar)
```

**Runtime layout:** One native window hosts two layers of WebView2 webviews:

- `ui` — renders the toolbar and tab bar at the top
- `view-{id}` — one per tab, positioned below the UI chrome; inactive tabs are moved off-screen (not destroyed), preserving their state

## Keyboard Shortcuts

| Shortcut                      | Action                  |
| ----------------------------- | ----------------------- |
| `Ctrl+T`                      | New tab                 |
| `Ctrl+W`                      | Close tab               |
| `Ctrl+Shift+T`                | Reopen last closed tab  |
| `Ctrl+Shift+D`                | Duplicate current tab   |
| `Ctrl+L`                      | Focus address bar       |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs              |
| `Ctrl+1`–`8`                  | Jump to tab by position |
| `Ctrl+9`                      | Jump to last tab        |
| `Ctrl+R` / `F5`               | Reload                  |
| `Alt+←` / `Alt+→`             | Back / Forward          |
| `Ctrl++` / `Ctrl+-`           | Zoom in / out           |
| `Ctrl+0`                      | Reset zoom              |

## Requirements

- **Windows 10/11** (WebView2 is required; Windows 11 includes it by default)
- [Rust](https://rustup.rs/) — stable, MSVC toolchain: `rustup default stable-x86_64-pc-windows-msvc`
- [Node.js](https://nodejs.org/) 18+
- [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with:
  - **MSVC v143 C++ build tools**
  - **Windows 11 SDK (10.0.22621 or later)**
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 11)

## Getting Started

```powershell
# 1. Clone the repository
git clone https://github.com/your-username/yuzu-browser.git
cd yuzu-browser

# 2. Install Node dependencies
npm install

# 3. Start the development server
#    (loads MSVC environment variables automatically)
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

If the MSVC toolchain is already on your `PATH`, you can run directly:

```powershell
npm run tauri dev
```

## Building a Release

```powershell
powershell -Command "& { . scripts\dev-env.ps1; npm run tauri build }"
```

The installer and binaries will be placed under `src-tauri/target/release/bundle/`.

## Contributing

Contributions of all kinds are welcome — bug reports, feature requests, pull requests, and ideas.

1. Fork the repository and create a branch (`git checkout -b feat/your-feature`)
2. Make your changes and verify with `cargo check` + `npm run build`
3. Open a pull request with a clear description of what you changed and why

Please keep pull requests focused on a single concern. For large changes, open an issue first to discuss the approach.

## Roadmap Ideas

- [ ] macOS / Linux support
- [ ] Bookmark manager
- [ ] Persistent session / history (opt-in)
- [ ] Extension / userscript support
- [ ] Custom search engine configuration
- [ ] Download manager
- [ ] Dark / light theme toggle

## License

MIT
