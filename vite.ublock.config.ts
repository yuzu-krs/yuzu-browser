// uBlock Origin 相当のブロッカーを単一 IIFE バンドルに固める専用ビルド。
// 出力は `src-tauri/ublock.bundle.js` で、Rust 側が `include_str!` で取り込み、
// 各 view webview の初期化スクリプトとして注入する。

import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/ublock/inject.ts"),
      formats: ["iife"],
      name: "YuzuUBlock",
      fileName: () => "ublock.bundle.js",
    },
    outDir: "src-tauri",
    emptyOutDir: false,
    minify: true,
    target: "es2020",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // IIFE は ESM 動的 import を使えないので警告を抑制。
      },
    },
  },
});
