# yuzu-browser

A lightweight, fast, and minimal web browser built for simplicity and performance.

Tauri 2 + Rust + Vanilla TypeScript で実装した最小ブラウザ。アドレスバーから URL 直接遷移、または DuckDuckGo 検索が可能。

## 機能（MVP）

- アドレスバー（URL or 検索クエリの自動判定）
- 既定検索エンジン: **DuckDuckGo**（匿名性配慮）
- 戻る / 進む / 再読み込み
- 履歴は永続化しない（メモリのみ）

> 制約: 表示は `<iframe>` ベースのため、`X-Frame-Options: DENY` を返すサイト（Google, X など）は表示できません。

## 必要環境

- Rust (stable, MSVC toolchain): `rustup default stable-x86_64-pc-windows-msvc`
- Node.js 18+
- Visual Studio 2022 Build Tools（C++ ワークロード + Windows SDK）
- WebView2 Runtime（Windows 11 は標準搭載）

## 開発起動

Windows (PowerShell):

```powershell
# 初回のみ
npm install

# 起動（vcvars64 を取り込んで tauri dev を実行）
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

シェル PATH に MSVC が既に通っていれば `npm run tauri dev` 直接でも可。

## ビルド

```powershell
powershell -Command "& { . scripts\dev-env.ps1; npm run tauri build }"
```

（`scripts\dev.ps1` を `npm run tauri dev` → `npm run tauri build` に置き換えるか、自前のラッパを用意）

## ライセンス

TBD
