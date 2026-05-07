// 広告/トラッカードメインの hosts ブロックリスト管理。
//
// - 起動時に %APPDATA%/yuzu-browser/adblock_hosts.txt を読み込む。
// - キャッシュが古い (7 日超) または存在しなければ、
//   StevenBlack の統合 hosts ファイルを HTTPS 取得して上書き保存する。
// - `is_blocked(host)` でホスト名 (とその親ドメイン) がリストに含まれるか判定。
//
// 実際のブロック (HTTP 応答 403 化) は WebView2 の `WebResourceRequested`
// イベントから呼び出される (`webview_filter` モジュール)。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

const SOURCES: &[&str] = &[
    // StevenBlack 統合 hosts (広告 + マルウェア)。
    "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
];
const TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CACHE_FILENAME: &str = "adblock_hosts.txt";

/// プロセス全体で共有するブロックリスト。Arc<HashSet<...>> を載せ替えるだけにして、
/// hot-path の `is_blocked` ではロックを最小限 (read のみ) にする。
static BLOCKLIST: RwLock<Option<Arc<HashSet<String>>>> = RwLock::new(None);

/// 即時ロード可能な最小限のフォールバック (ネット未取得時用)。
const FALLBACK: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.google.com",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "amazon-adsystem.com",
    "adnxs.com",
    "criteo.com",
    "criteo.net",
    "scorecardresearch.com",
    "quantserve.com",
    "outbrain.com",
    "taboola.com",
    "moatads.com",
    "adsafeprotected.com",
    "rubiconproject.com",
    "openx.net",
    "pubmatic.com",
    "facebook.net",
    "connect.facebook.net",
    "hotjar.com",
    "mixpanel.com",
    "segment.io",
    "segment.com",
    "fullstory.com",
    "branch.io",
    "appsflyer.com",
    "chartbeat.com",
    "newrelic.com",
    "nr-data.net",
    "doubleverify.com",
    "yieldmo.com",
    "smartadserver.com",
    "adform.net",
    "casalemedia.com",
    "indexww.com",
    "33across.com",
    "sharethrough.com",
    "media.net",
    "contextweb.com",
    "spotxchange.com",
    "yahoo.co.jp/adgam",
];

/// アプリ起動時に呼ぶ。フォールバックを即時セット → バックグラウンドで再取得。
pub fn init(cache_dir: PathBuf) {
    install(Arc::new(FALLBACK.iter().map(|s| s.to_string()).collect()));
    std::thread::spawn(move || {
        let path = cache_dir.join(CACHE_FILENAME);
        let _ = std::fs::create_dir_all(&cache_dir);

        // キャッシュが新しければそれを使う。
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(modified) = meta.modified() {
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO);
                if age < TTL {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        let set = parse_hosts(&text);
                        if !set.is_empty() {
                            install(Arc::new(set));
                            return;
                        }
                    }
                }
            }
        }

        // 取得 → ディスクに保存 → 適用。
        for src in SOURCES {
            match fetch(src) {
                Ok(text) => {
                    let set = parse_hosts(&text);
                    if !set.is_empty() {
                        let _ = std::fs::write(&path, &text);
                        eprintln!("[adblock] loaded {} hosts from {}", set.len(), src);
                        install(Arc::new(set));
                        return;
                    }
                }
                Err(e) => eprintln!("[adblock] fetch {} failed: {}", src, e),
            }
        }

        // 全失敗 → 既存 (古い) キャッシュがあれば、それでも使う。
        if let Ok(text) = std::fs::read_to_string(&path) {
            let set = parse_hosts(&text);
            if !set.is_empty() {
                eprintln!("[adblock] using stale cache: {} hosts", set.len());
                install(Arc::new(set));
            }
        }
    });
}

fn install(list: Arc<HashSet<String>>) {
    if let Ok(mut g) = BLOCKLIST.write() {
        *g = Some(list);
    }
}

fn fetch(url: &str) -> Result<String, String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?;
    resp.into_string().map_err(|e| e.to_string())
}

fn parse_hosts(text: &str) -> HashSet<String> {
    let mut set = HashSet::with_capacity(text.len() / 32);
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        // hosts 形式: "0.0.0.0 example.com" / "127.0.0.1 example.com" / 単純なドメイン名のみ
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap_or("");
        let host = match first {
            "0.0.0.0" | "127.0.0.1" | "::" | "::1" => parts.next().unwrap_or(""),
            _ => first,
        };
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() || host == "localhost" || host == "broadcasthost" {
            continue;
        }
        // ホスト名以外の文字を含む行は捨てる。
        if !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            continue;
        }
        set.insert(host);
    }
    set
}

/// `host` 自体、または親ドメインがリストに登録されていれば true。
pub fn is_blocked(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    let guard = match BLOCKLIST.read() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let Some(set) = guard.as_ref() else {
        return false;
    };
    let mut cur = host.as_str();
    loop {
        if set.contains(cur) {
            return true;
        }
        match cur.find('.') {
            Some(i) => cur = &cur[i + 1..],
            None => return false,
        }
    }
}
