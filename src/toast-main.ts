// yuzu-browser ダウンロードトースト用 webview のエントリ。
// chrome (UI) webview とは別の透明な小さい webview で動作し、
// ダウンロード進捗を右下に表示する。クリックでメインの chrome に
// "open-downloads-panel" イベントを emit してダウンロードパネルを開かせる。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";

interface DownloadItem {
  id: number;
  url: string;
  filename: string;
  path: string;
  total_bytes: number | null;
  bytes: number;
  status: string; // "in-progress" | "finished" | "failed" | "cancelled"
}

interface ProgressPayload {
  id: number;
  bytes: number;
  total: number | null;
}

const host = document.getElementById("toast-host") as HTMLDivElement;

const fmtBytes = (b: number | null | undefined): string => {
  if (b == null || !isFinite(b)) return "--";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtETA = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) return "--";
  if (sec < 60) return `${Math.ceil(sec)}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.ceil(sec % 60)}秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}時間${m}分`;
};

interface Sample {
  t: number;
  bytes: number;
}
interface ProgressToast {
  el: HTMLDivElement;
  body: HTMLSpanElement;
  bar: HTMLDivElement;
  pct: HTMLSpanElement;
  finished: boolean;
  filename: string;
  total: number | null;
  samples: Sample[];
}
const progressToasts = new Map<number, ProgressToast>();

// ---- webview サイズ調整 ----
let lastSize = { w: 1, h: 1, visible: false };
const applySize = (): void => {
  // 表示中トーストが 0 件なら隠す
  const visibleCount = host.children.length;
  if (visibleCount === 0) {
    if (lastSize.visible) {
      lastSize = { w: 1, h: 1, visible: false };
      void invoke("toast_hide").catch(() => {});
    }
    return;
  }
  // 実レンダリング後のサイズを採寸 (右と下に 8px の余白)
  const r = host.getBoundingClientRect();
  // 万一 width/height が 0 になるケースに備えて最小値を確保
  const w = Math.max(1, Math.ceil(r.width + 16));
  const h = Math.max(1, Math.ceil(r.height + 16));
  if (w === lastSize.w && h === lastSize.h && lastSize.visible) return;
  lastSize = { w, h, visible: true };
  void invoke("toast_set_size", { width: w, height: h }).catch(() => {});
};
const scheduleApply = (): void => {
  // 連続更新時の invoke 連射を抑制
  window.requestAnimationFrame(() => applySize());
};

const ro = new ResizeObserver(() => scheduleApply());
ro.observe(host);

const openDownloadsPanel = (): void => {
  void emit("open-downloads-panel");
};

const showToast = (
  title: string,
  body: string | undefined,
  variant: "info" | "finished" | "failed",
  durationMs: number,
): void => {
  const el = document.createElement("div");
  el.className = `dl-toast dl-toast-${variant}`;
  const t = document.createElement("div");
  t.className = "dl-toast-title";
  t.textContent = title;
  el.appendChild(t);
  if (body) {
    const b = document.createElement("div");
    b.className = "dl-toast-body";
    b.textContent = body;
    el.appendChild(b);
  }
  el.addEventListener("click", () => {
    openDownloadsPanel();
    el.remove();
    scheduleApply();
  });
  host.appendChild(el);
  scheduleApply();
  window.setTimeout(() => {
    el.classList.add("dl-toast-leave");
    window.setTimeout(() => {
      el.remove();
      scheduleApply();
    }, 260);
  }, durationMs);
};

const ensureProgressToast = (id: number, filename: string): ProgressToast => {
  const existing = progressToasts.get(id);
  if (existing && document.body.contains(existing.el)) return existing;
  const el = document.createElement("div");
  el.className = "dl-toast dl-toast-info dl-toast-progress";
  const t = document.createElement("div");
  t.className = "dl-toast-title";
  t.textContent = "⬇ ダウンロード中";
  el.appendChild(t);
  const fname = document.createElement("div");
  fname.className = "dl-toast-body";
  fname.textContent = filename;
  el.appendChild(fname);
  const barWrap = document.createElement("div");
  barWrap.className = "dl-toast-barwrap";
  const bar = document.createElement("div");
  bar.className = "dl-toast-bar";
  bar.style.width = "0%";
  barWrap.appendChild(bar);
  el.appendChild(barWrap);
  const meta = document.createElement("div");
  meta.className = "dl-toast-meta";
  const pct = document.createElement("span");
  pct.className = "dl-toast-pct";
  pct.textContent = "0%";
  const stats = document.createElement("span");
  stats.className = "dl-toast-stats";
  stats.textContent = "計測中...";
  meta.appendChild(pct);
  meta.appendChild(stats);
  el.appendChild(meta);
  el.addEventListener("click", () => openDownloadsPanel());
  host.appendChild(el);
  const rec: ProgressToast = {
    el,
    body: stats,
    bar,
    pct,
    finished: false,
    filename,
    total: null,
    samples: [],
  };
  progressToasts.set(id, rec);
  // 同時表示数を 3 件までに制限
  const MAX_VISIBLE = 3;
  const ongoing = Array.from(progressToasts.entries()).filter(
    ([, r]) => !r.finished,
  );
  if (ongoing.length > MAX_VISIBLE) {
    const overflow = ongoing.length - MAX_VISIBLE;
    for (let i = 0; i < overflow; i++) {
      const [oid, orec] = ongoing[i];
      orec.el.remove();
      progressToasts.delete(oid);
    }
  }
  scheduleApply();
  return rec;
};

const updateProgressToast = (
  id: number,
  bytes: number,
  total: number | null,
): void => {
  const rec = progressToasts.get(id);
  if (!rec || rec.finished) return;
  const now = performance.now();
  rec.samples.push({ t: now, bytes });
  // 直近 5 秒だけ残す
  while (rec.samples.length > 1 && now - rec.samples[0].t > 5000) {
    rec.samples.shift();
  }
  let speed = 0;
  if (rec.samples.length >= 2) {
    const first = rec.samples[0];
    const last = rec.samples[rec.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt > 0) speed = (last.bytes - first.bytes) / dt;
  }
  if (total != null) rec.total = total;
  if (rec.total && rec.total > 0) {
    const ratio = Math.min(1, bytes / rec.total);
    rec.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
    rec.pct.textContent = `${(ratio * 100).toFixed(1)}%`;
    const remain = rec.total - bytes;
    const eta = speed > 0 ? remain / speed : Infinity;
    rec.body.textContent = `${fmtBytes(bytes)} / ${fmtBytes(rec.total)} · ${
      speed > 0 ? `${fmtBytes(speed)}/s` : "--"
    } · 残り ${fmtETA(eta)}`;
  } else {
    rec.bar.style.width = "100%";
    rec.bar.classList.add("dl-toast-bar-indet");
    rec.pct.textContent = "—";
    rec.body.textContent = `${fmtBytes(bytes)} · ${
      speed > 0 ? `${fmtBytes(speed)}/s` : "--"
    }`;
  }
};

const finishProgressToast = (
  id: number,
  status: string,
  filename: string,
  totalBytes?: number | null,
): void => {
  const rec = progressToasts.get(id);
  const lower = (status || "").toLowerCase();
  if (!rec) {
    if (lower === "failed") {
      showToast("✗ ダウンロード失敗", filename, "failed", 5000);
    } else if (lower === "cancelled" || lower === "canceled") {
      showToast("⊘ キャンセルされました", filename, "failed", 4000);
    } else {
      showToast("✓ ダウンロード完了", filename, "finished", 4000);
    }
    return;
  }
  rec.finished = true;
  rec.el.classList.remove("dl-toast-info");
  rec.bar.classList.remove("dl-toast-bar-indet");
  if (lower === "failed") {
    rec.el.classList.add("dl-toast-failed");
    const t = rec.el.querySelector(".dl-toast-title");
    if (t) t.textContent = "✗ ダウンロード失敗";
    rec.body.textContent = filename;
  } else if (lower === "cancelled" || lower === "canceled") {
    rec.el.classList.add("dl-toast-failed");
    const t = rec.el.querySelector(".dl-toast-title");
    if (t) t.textContent = "⊘ キャンセルされました";
    rec.body.textContent = filename;
  } else {
    rec.el.classList.add("dl-toast-finished");
    const t = rec.el.querySelector(".dl-toast-title");
    if (t) t.textContent = "✓ ダウンロード完了";
    rec.bar.style.width = "100%";
    rec.pct.textContent = "100%";
    if (totalBytes && totalBytes > 0) {
      rec.body.textContent = `${filename} · ${fmtBytes(totalBytes)}`;
    } else {
      rec.body.textContent = filename;
    }
  }
  const lingerMs =
    lower === "failed" || lower === "cancelled" || lower === "canceled"
      ? 6000
      : 4000;
  window.setTimeout(() => {
    rec.el.classList.add("dl-toast-leave");
    window.setTimeout(() => {
      rec.el.remove();
      progressToasts.delete(id);
      scheduleApply();
    }, 260);
  }, lingerMs);
  scheduleApply();
};

// ---- イベント購読 ----
void listen<DownloadItem>("download-started", (ev) => {
  const it = ev.payload;
  if (!it || !it.filename) return;
  // 開始時点で進捗トーストを用意
  ensureProgressToast(it.id, it.filename);
});
void listen<ProgressPayload>("download-progress", (ev) => {
  const p = ev.payload;
  if (!p) return;
  updateProgressToast(p.id, p.bytes, p.total);
});
void listen<DownloadItem>("download-finished", (ev) => {
  const it = ev.payload;
  if (!it) return;
  finishProgressToast(
    it.id,
    it.status,
    it.filename || "(unknown)",
    it.total_bytes,
  );
});

// 初期は隠す (念のため)
void invoke("toast_hide").catch(() => {});
