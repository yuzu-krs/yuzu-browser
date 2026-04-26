// yuzu-browser 内蔵アドブロッカー（uBO 相当の最小実装）。
// view webview の初期化スクリプトとして注入される。
// - ネットワーク: fetch / XHR / sendBeacon / Image / Worker のブロックリスト判定
// - コスメティック: 既知広告セレクタを display:none で隠す
(function () {
  if (window.__yuzuAdblockInstalled) return;
  window.__yuzuAdblockInstalled = true;

  // 軽量ブロックリスト（広告/トラッカー主要ドメイン）。
  // 拡張時は EasyList 等を fetch して BLOCKED_HOSTS を更新する想定。
  const BLOCKED_HOSTS = new Set([
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.google.com",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "adsystem.com",
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
    "yahoo.co.jp/adgam", // 部分一致用ダミー（hostname 比較なのでマッチしない、参考）
    "yieldmo.com",
    "smartadserver.com",
    "krxd.net",
    "demdex.net",
    "everesttech.net",
    "adobedtm.com",
    "omtrdc.net",
  ]);

  function isBlockedUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname.toLowerCase();
      if (BLOCKED_HOSTS.has(host)) return true;
      // サブドメインも遮断（example.com は ads.example.com もブロック）
      for (const h of BLOCKED_HOSTS) {
        if (host.endsWith("." + h)) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // --- fetch ---
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : (input && input.url) || "";
      if (isBlockedUrl(url)) {
        return Promise.resolve(
          new Response("", {
            status: 204,
            statusText: "Blocked by yuzu-adblock",
          }),
        );
      }
      return _fetch.apply(this, arguments);
    };
  }

  // --- XHR ---
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__yuzuBlocked = isBlockedUrl(url);
    return _open.apply(this, arguments);
  };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__yuzuBlocked) {
      // 何もしない（コールバックは呼ばれないが多くのスクリプトは耐性あり）
      return;
    }
    return _send.apply(this, arguments);
  };

  // --- sendBeacon ---
  if (navigator.sendBeacon) {
    const _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (isBlockedUrl(url)) return true;
      return _beacon(url, data);
    };
  }

  // --- Image (1x1 ピクセルトラッカー対策) ---
  const _ImageSrc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "src",
  );
  if (_ImageSrc && _ImageSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: true,
      get: _ImageSrc.get,
      set(v) {
        if (isBlockedUrl(v)) return;
        return _ImageSrc.set.call(this, v);
      },
    });
  }

  // --- Worker ---
  const _Worker = window.Worker;
  if (_Worker) {
    window.Worker = function (url, opts) {
      if (isBlockedUrl(url)) {
        // ダミー Worker
        return {
          postMessage() {},
          terminate() {},
          addEventListener() {},
          removeEventListener() {},
        };
      }
      return new _Worker(url, opts);
    };
    window.Worker.prototype = _Worker.prototype;
  }

  // --- コスメティックフィルタ ---
  const COSMETIC_SELECTORS = [
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="adservice"]',
    "ins.adsbygoogle",
    'div[id^="google_ads_"]',
    'div[id^="div-gpt-ad"]',
    'div[class*="ad-banner"]',
    'div[class*="advertisement"]',
    'div[class*="-ad-"]',
    'div[class*="sponsored"]',
    'aside[aria-label*="広告"]',
    'aside[aria-label*="advert" i]',
    "[data-ad-client]",
    "[data-ad-slot]",
    // --- YouTube ---
    "ytd-display-ad-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-compact-promoted-video-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-ad-slot-renderer",
    "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
    "ytd-reel-video-renderer:has(.ytd-ad-slot-renderer)",
    "#masthead-ad",
    ".ytp-ad-module",
    ".ytp-ad-overlay-slot",
    ".ytp-ad-image-overlay",
    ".video-ads",
    "tp-yt-paper-dialog:has(yt-mealbar-promo-renderer)",
    "ytmusic-mealbar-promo-renderer",
    // --- DuckDuckGo 検索広告 ---
    'li[data-layout="ad"]',
    'article[data-testid="ad"]',
    ".result--ad",
    ".result--ad-v2",
    ".badge--ad",
    "div.results--ads",
    "div.results--ads--main",
    // --- Google 検索広告 ---
    "#tads",
    "#tadsb",
    "#bottomads",
    "[data-text-ad]",
    ".commercial-unit-desktop-top",
    ".commercial-unit-desktop-rhs",
    'div[aria-label="広告"]',
    'div[aria-label="Ads"]',
    // --- Bing 検索広告 ---
    ".b_ad",
    "li.b_adTop",
    "li.b_adBottom",
  ];
  const style = document.createElement("style");
  style.id = "yuzu-adblock-cosmetic";
  style.textContent =
    COSMETIC_SELECTORS.join(",") +
    "{display:none !important;visibility:hidden !important;height:0 !important;}";
  function injectStyle() {
    const target = document.head || document.documentElement;
    if (target && !document.getElementById("yuzu-adblock-cosmetic")) {
      target.appendChild(style);
    }
  }
  injectStyle();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStyle, { once: true });
  }

  // ===== YouTube 専用アドブロック =====
  // YouTube の広告は同一オリジンから配信されるためホスト名ブロックでは止まらない。
  // uBO 相当の対策として:
  //  (A) Object.prototype セッターで adPlacements/adSlots/playerAds 等の代入を全階層で無効化
  //  (B) ytInitialPlayerResponse / fetch レスポンスから広告フィールドを再帰的に削除
  //  (C) 広告再生中は muted で playbackRate を最大化し、スキップボタンを自動クリック
  //  (D) 広告関連 DOM を MutationObserver で除去
  if (
    /(^|\.)youtube(-nocookie)?\.com$/i.test(location.hostname) ||
    /(^|\.)youtube\.com$/i.test(location.hostname)
  ) {
    // ---- (A) Object.prototype セッター乗っ取り（uBO の "set, ..., undefined" 相当） ----
    // どの階層のオブジェクトに代入されても無視させる。
    const KILL_KEYS = [
      "adPlacements",
      "adSlots",
      "playerAds",
      "adBreakHeartbeatParams",
      "playerLegacyDesktopWatchAdsRenderer",
      "adServerSideStreamingDataReceiver",
    ];
    for (const key of KILL_KEYS) {
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          set() {
            /* 代入を黙殺 */
          },
          get() {
            return undefined;
          },
        });
      } catch (_) {}
    }

    // ---- (B) プレイヤーレスポンスから広告フィールドを再帰的に削除 ----
    function stripAds(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 10) return obj;
      try {
        for (const k of KILL_KEYS) {
          if (k in obj) {
            try {
              delete obj[k];
            } catch (_) {}
          }
        }
        if (Array.isArray(obj)) {
          for (const v of obj) stripAds(v, depth + 1);
        } else {
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v && typeof v === "object") stripAds(v, depth + 1);
          }
        }
      } catch (_) {}
      return obj;
    }

    // window.ytInitialPlayerResponse をプロパティ定義で監視
    let _ytipr;
    try {
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true,
        get() {
          return _ytipr;
        },
        set(v) {
          _ytipr = stripAds(v, 0);
        },
      });
    } catch (_) {}
    let _ytid;
    try {
      Object.defineProperty(window, "ytInitialData", {
        configurable: true,
        get() {
          return _ytid;
        },
        set(v) {
          _ytid = stripAds(v, 0);
        },
      });
    } catch (_) {}

    // YouTube 内部の fetch (ytInitialData / next 等) のレスポンスから広告剥がし
    const _ytFetch = window.fetch;
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : (input && input.url) || "";
      // /api/stats/ads (広告計測ビーコン) と pagead をブロック
      if (
        /\/api\/stats\/ads/.test(url) ||
        /\/pagead\//.test(url) ||
        /\/get_midroll_/.test(url)
      ) {
        return Promise.resolve(new Response("", { status: 204 }));
      }
      const p = _ytFetch.apply(this, arguments);
      if (/\/youtubei\/v1\/(player|next|browse|search)/.test(url)) {
        return p.then((res) => {
          if (!res || !res.ok) return res;
          return res
            .clone()
            .json()
            .then((data) => {
              stripAds(data, 0);
              return new Response(JSON.stringify(data), {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              });
            })
            .catch(() => res);
        });
      }
      return p;
    };

    // (B) 広告再生中の自動スキップ
    function killVideoAd() {
      const player = document.querySelector(".html5-video-player");
      if (!player) return;
      const isAd =
        player.classList.contains("ad-showing") ||
        player.classList.contains("ad-interrupting");
      if (!isAd) return;

      // スキップボタンを総当たりでクリック
      const skipSelectors = [
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        ".ytp-skip-ad-button",
        ".ytp-ad-survey-answer-button",
      ];
      for (const sel of skipSelectors) {
        const btn = player.querySelector(sel);
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
        }
      }

      // 動画自体を末尾までシーク + 速度最大化 + ミュート
      const video = player.querySelector("video");
      if (video) {
        try {
          video.muted = true;
          video.playbackRate = 16;
          if (isFinite(video.duration) && video.duration > 0) {
            video.currentTime = video.duration;
          }
        } catch (_) {}
      }
    }
    setInterval(killVideoAd, 250);

    // (C) 広告 DOM を能動的に削除
    const AD_DOM_SELECTORS = [
      ".ytp-ad-overlay-container",
      ".ytp-ad-overlay-slot",
      ".ytp-ad-text-overlay",
      "ytd-ad-slot-renderer",
      "ytd-banner-promo-renderer",
      "ytd-statement-banner-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "ytd-promoted-video-renderer",
      "ytd-display-ad-renderer",
      "#masthead-ad",
    ];
    function purgeAds(root) {
      for (const sel of AD_DOM_SELECTORS) {
        root.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }
    const mo = new MutationObserver(() => purgeAds(document));
    function startObserver() {
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true });
        purgeAds(document);
      } else {
        setTimeout(startObserver, 100);
      }
    }
    startObserver();
  }
})();
