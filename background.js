// background.js - Service Worker
// Handles alarms, backup orchestration, and IndexedDB for FileSystemDirectoryHandle

const ALARM_NAME = 'gemini-backup';
const DB_NAME = 'gemini-backup-db';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

// ── 訊息選擇器（與 content.js 保持同步）───────────────────────────────────────────
// 參考 gemini-voyager 持續維護的清單，涵蓋新舊版 Gemini DOM
const USER_TURN_SELECTORS = [
  'user-query',
  '.user-query-bubble-with-background',
  '.user-query-bubble-container',
  '.user-query-container',
  '.user-query-content',
  '.query-content',
  'div[aria-label="User message"]',
  'article[data-turn="user"]',
  '[data-message-author-role="user"]',
  '.human-turn',
];

const MODEL_TURN_SELECTORS = [
  'model-response',
  '[aria-label="Gemini response"]',
  '.model-response-text',
  'response-container .response-content',
  '.presented-response-container',
  'article[data-turn="model"]',
  '[data-message-author-role="model"]',
  '[data-message-author-role="assistant"]',
  '.ai-response',
];

// ── IndexedDB helpers ──────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFromDB(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Alarm management ───────────────────────────────────────────────────────────

async function setupAlarm(intervalHours) {
  await chrome.alarms.clear(ALARM_NAME);
  if (intervalHours > 0) {
    const periodMinutes = intervalHours * 60;
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: periodMinutes,
      periodInMinutes: periodMinutes,
    });
    console.log(`[Backup] Alarm set: every ${intervalHours}h`);
  }
}

// ── Service worker keepalive ───────────────────────────────────────────────────
// MV3 service worker 閒置 30 秒會被 Chrome 回收；長時間的全量備份過程中，
// 每 20 秒呼叫一次極輕量的擴充 API 重置閒置計時器，避免備份中途被殺掉。
let keepaliveTimer = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ── Utility functions ──────────────────────────────────────────────────────────

// 隨機延遲，防止被 Google 偵測為自動化機器人
function randomDelay(minMs, maxMs) {
  return new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

function formatTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}`;
}

function extractChatId(url) {
  // Match /app/[chatId] anywhere in the URL (handles standard and Gem chat URLs)
  const match = (url || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// Always returns a stable string ID for a conversation, even when chatId is absent.
// Used as the key for per-conversation storage entries and the filename suffix.
function stableConvId(url) {
  const chatId = extractChatId(url);
  if (chatId) return chatId;
  // URL hash as last resort (deterministic, no timestamp drift)
  let h = 0;
  for (let i = 0; i < (url || '').length; i++) {
    h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// 解析備份檔尾的 meta 註記（content.js 寫入）：
// <!-- gemini-backup:v1 hash=xxxx msgs=NN id=yyy -->
function parseBackupMeta(mdText) {
  const m = (mdText || '').match(
    /<!--\s*gemini-backup:v1\s+hash=([0-9a-f]+)\s+msgs=(\d+)(?:\s+id=([a-zA-Z0-9_-]*))?\s*-->/
  );
  if (!m) return null;
  return { hash: m[1], msgs: parseInt(m[2], 10) || 0, id: m[3] || '' };
}

// ── 立即停止：page-side abort flag ─────────────────────────────────────────────
// storage 的 stopBackupRequested 只在背景迴圈的 checkpoint 之間被檢查，
// 但最耗時的作業（歷史捲動、圖片下載）都在頁面內執行。廣播
// window.__geminiBackupAborted 到所有 Gemini 分頁，頁面內的長迴圈每次輪詢
// 都會檢查它，使用者按下「停止」後 < 500ms 內所有作業即可終止。
async function broadcastAbortFlag(value) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    await Promise.all((tabs || []).map(t =>
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: (v) => { window.__geminiBackupAborted = v; },
        args: [value],
      }).catch(() => {})
    ));
  } catch (_) {}
}

// 清除上一次備份留下的殘留狀態（stop flag、page-side abort flag），
// 避免「按停止後重新備份」時舊狀態誤殺新作業
async function clearStaleAbortState() {
  await chrome.storage.local.remove('stopBackupRequested');
  await broadcastAbortFlag(false);
}

// ── MAIN world clipboard bridge ────────────────────────────────────────────────
// 注入頁面主世界，攔截 navigator.clipboard 寫入。content.js 點擊 Gemini 官方的
// 「複製回覆」按鈕時，官方生成的 markdown 會被寫進 bridge 元素（不污染使用者的
// 真實剪貼簿），content.js 再從 bridge 讀出。這讓備份能拿到 Google 官方導出格式。
function installClipboardBridge() {
  try {
    if (window.__gcbBridgeInstalled) return;
    window.__gcbBridgeInstalled = true;

    const el = document.createElement('div');
    el.id = '__gcb-clip-bridge';
    el.style.display = 'none';
    el.setAttribute('data-seq', '0');
    el.setAttribute('data-capture', '0');
    document.documentElement.appendChild(el);

    const capturing = () => el.getAttribute('data-capture') === '1';
    const deliver = (text) => {
      el.textContent = String(text || '');
      el.setAttribute('data-seq', String(Number(el.getAttribute('data-seq') || '0') + 1));
    };

    const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    const origWrite = navigator.clipboard.write.bind(navigator.clipboard);

    navigator.clipboard.writeText = function (text) {
      if (capturing()) { deliver(text); return Promise.resolve(); }
      return origWriteText(text);
    };

    navigator.clipboard.write = function (items) {
      if (!capturing()) return origWrite(items);
      (async () => {
        try {
          for (const it of (items || [])) {
            if (it.types && it.types.includes('text/plain')) {
              const blob = await it.getType('text/plain');
              deliver(await blob.text());
              return;
            }
          }
          deliver('');
        } catch (_) { deliver(''); }
      })();
      return Promise.resolve();
    };

    // execCommand('copy') fallback：頁面透過 copy 事件寫剪貼簿時攔截
    window.addEventListener('copy', (e) => {
      if (!capturing()) return;
      try {
        const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (t) { deliver(t); e.preventDefault(); }
      } catch (_) {}
    }, false);
  } catch (_) {}
}

// 注入 clipboard bridge（失敗不影響備份，content.js 會退回 DOM 轉換）再執行擷取
async function extractConversation(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installClipboardBridge,
    });
  } catch (_) {}

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  return results?.[0]?.result;
}

// ── 完整歷史載入 ───────────────────────────────────────────────────────────────
//
// Gemini 開啟長對話時只載入最近的訊息，需要往上捲動才會載入更早的歷史。
// 策略（自 v2.2 起不再依賴 Gemini Voyager 的 timeline dot——新版 Voyager
// 已將 dot 虛擬化，數量不再等於訊息數）：
//   1. 對所有候選容器捲到頂端並主動派發 scroll 事件（實測部分容器為
//      overflow:hidden，單一容器 scrollTop=0 不會觸發 Gemini 的 listener）
//   2. 用 MutationObserver 指紋（訊息數 + 最上方訊息文字）偵測是否有新內容；
//      看到 Gemini 內建的 loading-history-spinner 就等它消失再判定
//   3. 捲動沒反應時，模擬點擊最上方的使用者訊息（Voyager 1.5+ 驗證過的手法，
//      會促使 Gemini 載入更早的歷史）
//   4. 連續 2 圈無新內容（中間 backoff 重試）→ 歷史已完整載入
//   5. 使用者按「停止」→ window.__geminiBackupAborted 旗標，任何等待中立即返回
//
// stopAtCount: 0 = 載入全部歷史（預設）
//              > 0 = 當 DOM 訊息數 >= stopAtCount 時提前停止
async function scrollToLoadAllMessages(tabId, stopAtCount = 0) {
  const run = () => chrome.scripting.executeScript({
    target: { tabId },
    func: async (stopAtCount, userSelectors, modelSelectors) => {
      const MAX_ITERATIONS = 80;             // 每圈約載入 10–20 則 → 支援 800+ 則長對話
      const WALL_TIMEOUT_MS = 5 * 60000;     // 整體上限 5 分鐘，避免無限卡住
      const PROGRESS_TIMEOUT_MS = 8000;      // 每圈最多等 8 秒看是否有新內容
      // 確認回合用較短的逾時：實測一批歷史約 1.2 秒就載入完，
      // 走到確認階段代表多半已經到頂，沒必要每次都空等滿 8 秒。
      // 每個對話結尾可省下約 9 秒 —— 500+ 對話的全量備份差距超過一小時。
      const CONFIRM_TIMEOUT_MS = 3500;
      const SPINNER_FINISH_WAIT_MS = 10000;  // 看到 spinner 後等它消失的上限
      const STABILITY_RETRIES = 2;           // 連續 N 圈無進度才視為「真的到頂」
      const RETRY_BACKOFF_MS = 1500;         // 無進度後的喘息時間

      const wait = ms => new Promise(r => setTimeout(r, ms));
      const isAborted = () => !!window.__geminiBackupAborted;

      function countBySelectors(selectors) {
        for (const sel of selectors) {
          try {
            const n = document.querySelectorAll(sel).length;
            if (n) return n;
          } catch (_) {}
        }
        return 0;
      }

      // 與 chatMsgCount 相同口徑：使用者訊息 + 模型回覆總數
      function countTurns() {
        return countBySelectors(userSelectors) + countBySelectors(modelSelectors);
      }

      function getTopUserEl() {
        for (const sel of userSelectors) {
          try {
            const els = document.querySelectorAll(sel);
            if (els.length) return els[0];
          } catch (_) {}
        }
        return null;
      }

      // 嚴格判斷「真正可捲動」：實測 #chat-history 與 .chat-history-scroll-container
      // 是 overflow:hidden（設 scrollTop 沒效果），只有
      // infinite-scroller[data-test-id="chat-history-container"] 真正可捲
      function isScrollable(el) {
        if (!el) return false;
        if (el.scrollHeight <= el.clientHeight + 50) return false;
        try {
          const oy = getComputedStyle(el).overflowY;
          return /(auto|scroll|overlay)/.test(oy);
        } catch (_) { return true; }
      }

      function getScrollEl() {
        const candidates = [
          document.querySelector('infinite-scroller[data-test-id="chat-history-container"]'),
          document.querySelector('#chat-history'),
          document.querySelector('.chat-history-scroll-container'),
          document.querySelector('infinite-scroller.chat-history'),
          document.querySelector('infinite-scroller'),
          document.querySelector('.chat-history'),
          document.querySelector('.cdk-virtual-scroll-viewport'),
          document.querySelector('main'),
          document.querySelector('[data-scroll-container]'),
        ];
        for (const c of candidates) {
          if (isScrollable(c)) return c;
        }
        // Fallback: 從首則訊息往上找最近可捲動的祖先
        const firstMsg = getTopUserEl();
        if (firstMsg) {
          let el = firstMsg.parentElement;
          while (el && el !== document.body) {
            if (isScrollable(el)) return el;
            el = el.parentElement;
          }
        }
        return document.scrollingElement || document.documentElement;
      }

      // Gemini 內建 spinner — 抓更早歷史時顯示。判斷實際可見而非僅存在 DOM。
      // 2026-08 實測：舊的 loading-history-spinner / .loading-history-spinner-container
      // 在 Voyager 已不存在（querySelectorAll 全部 0 筆），現行 class 是
      // .loading-content-spinner-container，漏掉它等於整段 spinner 偵測是死碼。
      function isSpinnerVisible() {
        const candidates = document.querySelectorAll(
          '[data-test-id="loading-history-spinner"], ' +
          '.loading-content-spinner-container, ' +
          '.loading-history-spinner-container mat-progress-spinner, ' +
          '.loading-history-spinner-container mat-spinner'
        );
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cs = getComputedStyle(el);
            if (cs.visibility !== 'hidden' && cs.display !== 'none' &&
                parseFloat(cs.opacity || '1') > 0) {
              return true;
            }
          }
        }
        return false;
      }

      // 展開 collapsed 回覆。注意排除 [data-test-id="luminous-expand-button"]——
      // 它是側邊欄的展開鈕（aria-label 同為「展開」），點到會干擾側邊欄狀態。
      function expandAllCollapsed() {
        document.querySelectorAll(
          'button[aria-label="Expand"], button[aria-label="展開"]'
        ).forEach(b => {
          if (b.getAttribute('data-test-id') === 'luminous-expand-button') return;
          if (b.closest('bard-sidenav, [data-test-id="bard-sidenav-container"]')) return;
          try { b.click(); } catch (_) {}
        });
      }

      // 內容指紋：訊息數 + 最上方使用者訊息的文字片段。
      // 新歷史載入時兩者至少會變其一（單看數量在虛擬化 DOM 下不可靠）。
      function fingerprint() {
        const top = getTopUserEl();
        const sample = top ? (top.textContent || '').slice(0, 200) : '';
        return `${countTurns()}|${sample}`;
      }

      // MutationObserver + 輪詢等待內容變化；abort 時立即返回 false
      function waitForChange(before, timeoutMs) {
        return new Promise(resolve => {
          let done = false;
          let obs = null;
          let poll = null;
          let tm = null;
          const finish = (changed) => {
            if (done) return;
            done = true;
            try { obs?.disconnect(); } catch (_) {}
            clearInterval(poll);
            clearTimeout(tm);
            resolve(changed);
          };
          const check = () => {
            if (isAborted()) { finish(false); return; }
            if (fingerprint() !== before) finish(true);
          };
          try {
            obs = new MutationObserver(check);
            obs.observe(document.body, { childList: true, subtree: true });
          } catch (_) {}
          poll = setInterval(check, 250);
          tm = setTimeout(() => finish(false), timeoutMs);
        });
      }

      // 觸發載入更早的歷史：對所有候選容器捲到頂 + 派發 scroll 事件
      //（某些 listener 是 passive，scrollTop assignment 不會自動觸發）
      function triggerLoadOlder() {
        const topUser = getTopUserEl();
        try { topUser?.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
        const targets = [
          document.querySelector('infinite-scroller[data-test-id="chat-history-container"]'),
          document.querySelector('#chat-history'),
          document.querySelector('.chat-history-scroll-container'),
          document.querySelector('infinite-scroller'),
          document.querySelector('.cdk-virtual-scroll-viewport'),
          getScrollEl(),
        ].filter(Boolean);
        const seen = new Set();
        for (const t of targets) {
          if (seen.has(t)) continue;
          seen.add(t);
          try {
            t.scrollTop = 0;
            t.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch (_) {}
        }
        window.scrollTo(0, 0);
      }

      expandAllCollapsed();

      // 已載入足夠數量 → 直接回到底部
      if (stopAtCount > 0 && countTurns() >= stopAtCount) {
        const el = getScrollEl();
        if (el) el.scrollTop = el.scrollHeight;
        return;
      }

      const startTime = Date.now();
      let noProgress = 0;
      let clickTried = false;

      for (let attempt = 0; attempt < MAX_ITERATIONS; attempt++) {
        if (isAborted()) return;
        if (Date.now() - startTime > WALL_TIMEOUT_MS) break;

        const before = fingerprint();
        triggerLoadOlder();

        let changed = await waitForChange(
          before, noProgress > 0 ? CONFIRM_TIMEOUT_MS : PROGRESS_TIMEOUT_MS
        );
        if (isAborted()) return;

        // spinner 還在轉表示 Gemini 正在抓歷史 — 等它消失再重新判定
        if (!changed && isSpinnerVisible()) {
          const spinnerDeadline = Date.now() + SPINNER_FINISH_WAIT_MS;
          while (Date.now() < spinnerDeadline && isSpinnerVisible()) {
            await wait(250);
            if (isAborted()) return;
          }
          changed = fingerprint() !== before;
        }

        // 新載入的訊息可能含 collapsed 區段 — 每圈都重新展開
        expandAllCollapsed();

        if (changed) {
          noProgress = 0;
          clickTried = false;
          if (stopAtCount > 0 && countTurns() >= stopAtCount) break;
          await wait(250);
          continue;
        }

        // 捲動沒有觸發載入：點擊最上方的使用者訊息一次（Voyager 1.5+ 的手法）
        if (!clickTried) {
          clickTried = true;
          const topUser = getTopUserEl();
          if (topUser) {
            try {
              const opts = { bubbles: true, cancelable: true, view: window };
              topUser.dispatchEvent(new MouseEvent('mousedown', opts));
              topUser.dispatchEvent(new MouseEvent('mouseup', opts));
              topUser.click();
            } catch (_) {}
            const clickChanged = await waitForChange(fingerprint(), CONFIRM_TIMEOUT_MS);
            if (isAborted()) return;
            if (clickChanged) { noProgress = 0; continue; }
          }
        }

        // 兩種策略都沒有新內容：backoff 後再確認一次，連續無進度才收工
        noProgress++;
        if (noProgress >= STABILITY_RETRIES) break;
        await wait(RETRY_BACKOFF_MS);
        if (isAborted()) return;
      }

      // Restore to bottom（Voyager 存在時點最後一個 dot 跳到最新訊息）
      const el = getScrollEl();
      if (el) el.scrollTop = el.scrollHeight;
      const dots = document.querySelectorAll('.timeline-dot');
      if (dots.length) { try { dots[dots.length - 1].click(); } catch (_) {} }
      window.scrollTo(0, document.body.scrollHeight);
      await wait(400);
    },
    args: [stopAtCount, USER_TURN_SELECTORS, MODEL_TURN_SELECTORS],
  });

  try {
    await run();
  } catch (_) {
    // 點擊最上方訊息偶爾會觸發整頁重載（Voyager 亦有相同情況），
    // 此時 executeScript 會中斷；等頁面重新載入完成後重跑一次。
    await waitForTabComplete(tabId, 20000);
    await new Promise(r => setTimeout(r, 2500));
    await run();
  }
}

// 等待分頁進入 complete 狀態（輪詢，最長 timeoutMs）
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch (_) { return; }
    await new Promise(r => setTimeout(r, 500));
  }
}

// Navigate a tab to url and wait for it to finish loading
const NAVIGATION_CANCELLED_MSG = '使用者已取消備份';

function navigateAndWait(tabId, url, extraWaitMs = 2500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(stopPoll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(arg);
    };

    const timeout = setTimeout(
      () => settle(reject, new Error('頁面載入逾時（30 秒）')),
      30000
    );

    // 停止偵測：使用者按下「停止」時提早中斷 navigation 等待
    const stopPoll = setInterval(async () => {
      try {
        const { stopBackupRequested } = await chrome.storage.local.get('stopBackupRequested');
        if (stopBackupRequested) settle(reject, new Error(NAVIGATION_CANCELLED_MSG));
      } catch (_) {}
    }, 300);

    let hasStartedLoading = false;

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') hasStartedLoading = true;
      if (hasStartedLoading && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Extra wait for dynamic content to render (±30% jitter to look more human)
        setTimeout(() => settle(resolve), extraWaitMs * (0.7 + Math.random() * 0.6));
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
}

// 導航失敗（逾時等）自動重試一次，第二次失敗才往外拋；使用者取消不重試
async function navigateAndWaitRetry(tabId, url, extraWaitMs = 2500) {
  try {
    await navigateAndWait(tabId, url, extraWaitMs);
  } catch (err) {
    if (err?.message === NAVIGATION_CANCELLED_MSG) throw err;
    await randomDelay(2000, 4000);
    await navigateAndWait(tabId, url, extraWaitMs);
  }
}

// ── 圖片儲存 helpers ───────────────────────────────────────────────────────────

// 將 data URL 解碼為 Uint8Array 並寫入 mediaHandle 下的 filename
async function saveImageFromDataUrl(mediaHandle, filename, dataUrl) {
  const [, base64] = dataUrl.split(',');
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const imgHandle = await mediaHandle.getFileHandle(filename, { create: true });
  const writable = await imgHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

// 所有對話統一輸出為資料夾格式：[safeTitle]_[convId]/ + [safeTitle].md
// 有圖片時額外建立 media/ 子目錄
// 回傳 { folderName }，用於更新 chrome.storage
async function saveConversationFiles(dirHandle, safeTitle, convId, content, images, stored) {
  const folderName = stored[`chatFolderName_${convId}`] || `${safeTitle}_${convId}`;
  const folderHandle = await dirHandle.getDirectoryHandle(folderName, { create: true });

  const mdHandle = await folderHandle.getFileHandle(`${safeTitle}.md`, { create: true });
  const mdWritable = await mdHandle.createWritable();
  await mdWritable.write(content);
  await mdWritable.close();

  if (images && images.length > 0) {
    const mediaHandle = await folderHandle.getDirectoryHandle('media', { create: true });
    for (const img of images) {
      try { await saveImageFromDataUrl(mediaHandle, img.filename, img.dataUrl); } catch (_) {}
    }
  }

  return { folderName };
}

// 確認本地備份是否真的存在（storage 說有備份、但使用者可能手動刪除了資料夾）
async function localBackupExists(dirHandle, folderName) {
  if (!folderName) return false;
  try {
    await dirHandle.getDirectoryHandle(folderName);
    return true;
  } catch (_) {
    return false;
  }
}

// ── 本地備份索引重建 ────────────────────────────────────────────────────────────
// chrome.storage 遺失時（擴充套件重裝、儲存空間被清除），直接掃描備份資料夾、
// 讀取檔尾 meta 註記恢復 hash / msgCount / folderName，讓增量判斷不必依賴
// storage 的存續——備份資料夾本身就是索引的真實來源。
async function seedStorageFromLocalBackups(dirHandle, convs) {
  // 1. 找出 storage 中缺少索引資料的對話
  const missing = [];
  for (const conv of convs) {
    const convId = stableConvId(conv.url);
    const keys = [`chatHash_${convId}`, `chatFolderName_${convId}`, `chatMsgCount_${convId}`];
    const stored = await chrome.storage.local.get(keys);
    if (!stored[`chatHash_${convId}`] || !stored[`chatFolderName_${convId}`] ||
        !stored[`chatMsgCount_${convId}`]) {
      missing.push({ convId, stored });
    }
  }
  if (!missing.length) return 0;

  // 2. 列舉備份資料夾（一次），之後逐一比對
  const entries = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      entries.push({ name, handle });
    }
  } catch (_) {
    return 0;
  }

  let seeded = 0;
  for (const { convId, stored } of missing) {
    let mdText = null;
    let folderName = null;

    const dirEntry = entries.find(
      e => e.handle.kind === 'directory' && e.name.endsWith(`_${convId}`)
    );
    if (dirEntry) {
      folderName = dirEntry.name;
      try {
        for await (const [fname, fh] of dirEntry.handle.entries()) {
          if (fh.kind === 'file' && fname.endsWith('.md')) {
            mdText = await (await fh.getFile()).text();
            break;
          }
        }
      } catch (_) {}
    } else {
      // 舊版單檔格式 [title]_[convId].md
      const fileEntry = entries.find(
        e => e.handle.kind === 'file' && e.name.endsWith(`_${convId}.md`)
      );
      if (fileEntry) {
        try { mdText = await (await fileEntry.handle.getFile()).text(); } catch (_) {}
      }
    }

    if (mdText === null && !folderName) continue;

    const update = {};
    if (folderName && !stored[`chatFolderName_${convId}`]) {
      update[`chatFolderName_${convId}`] = folderName;
    }
    if (mdText !== null) {
      const meta = parseBackupMeta(mdText);
      if (meta) {
        if (meta.hash && !stored[`chatHash_${convId}`]) {
          update[`chatHash_${convId}`] = meta.hash;
        }
        if (meta.msgs > 0 && !stored[`chatMsgCount_${convId}`]) {
          update[`chatMsgCount_${convId}`] = meta.msgs;
        }
      } else if (!stored[`chatMsgCount_${convId}`]) {
        // 舊格式檔案沒有 meta 註記：從段落標題推回訊息數（hash 未知，之後會重新擷取一次）
        const count = (mdText.match(/^## (使用者|Gemini)$/gm) || []).length;
        if (count > 0) update[`chatMsgCount_${convId}`] = count;
      }
    }
    if (Object.keys(update).length) {
      await chrome.storage.local.set(update);
      seeded++;
    }
  }
  return seeded;
}

// ── Single-conversation backup ─────────────────────────────────────────────────

async function backupSingleTab(tab, dirHandle) {
  // 先取得上次備份的訊息數，再決定捲動深度。
  // 若已備份過（prevMsgCount > 0），捲到 prevMsgCount 即可停止——
  // 新訊息已在頁面底部，舊訊息捲回到 prevMsgCount 後 DOM 即包含完整內容。
  const convId = stableConvId(tab.url);
  const preStored = await chrome.storage.local.get([
    `chatHash_${convId}`,
    `chatFolderName_${convId}`,
    `chatMsgCount_${convId}`,
    `chatTailSig_${convId}`,
  ]);
  const prevMsgCount = preStored[`chatMsgCount_${convId}`] || 0;

  // 尾端指紋相同 → 沒有新訊息，連捲動都不必做（長對話可省下數十秒）
  const prevTailSig = preStored[`chatTailSig_${convId}`] || '';
  if (prevTailSig && preStored[`chatHash_${convId}`]) {
    const sig = await readTailSignature(tab.id);
    if (sig?.tail && sig.tail === prevTailSig) {
      const folderStillThere = await localBackupExists(
        dirHandle, preStored[`chatFolderName_${convId}`]
      );
      if (folderStillThere) return { skipped: true, reason: '無新內容' };
    }
  }

  await scrollToLoadAllMessages(tab.id, prevMsgCount);

  const data = await extractConversation(tab.id);
  if (!data || !data.content) {
    return { skipped: true, reason: '無法擷取對話內容（頁面可能不是對話頁）' };
  }

  const { title, content, hash, url, messages, images } = data;
  const realConvId = stableConvId(url);
  // 若 tab.url 和 content.js 拿到的 url 相同，直接複用 preStored；否則重新查詢
  const stored = realConvId === convId ? preStored : await chrome.storage.local.get([
    `chatHash_${realConvId}`,
    `chatFolderName_${realConvId}`,
    `chatMsgCount_${realConvId}`,
    `chatTailSig_${realConvId}`,
  ]);

  // hash 相同且本地資料夾確實存在 → 真正略過；否則重新寫入
  //（涵蓋舊 .md 遷移與使用者手動刪除資料夾的情況）
  const alreadyFolder = await localBackupExists(
    dirHandle, stored[`chatFolderName_${realConvId}`]
  );
  if (stored[`chatHash_${realConvId}`] === hash && alreadyFolder) {
    return { skipped: true, reason: '無新內容' };
  }

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';
  const currMsgCount = messages ? messages.length : 0;
  const now = new Date().toISOString();

  // Safety guard: if we loaded fewer messages than last time, scroll didn't complete.
  if (prevMsgCount > 0 && currMsgCount < prevMsgCount) {
    return {
      skipped: true,
      reason: `捲動未完整載入（${currMsgCount} / ${prevMsgCount} 條訊息），保留現有備份`,
    };
  }

  const saveKeys = await saveConversationFiles(
    dirHandle, safeTitle, realConvId, content, images || [], stored
  );

  const storageUpdate = {
    [`chatHash_${realConvId}`]: hash,
    [`chatMsgCount_${realConvId}`]: currMsgCount,
    [`chatSyncTime_${realConvId}`]: now,
  };
  const newSig = await readTailSignature(tab.id);
  if (newSig?.tail) storageUpdate[`chatTailSig_${realConvId}`] = newSig.tail;
  if (saveKeys.folderName) storageUpdate[`chatFolderName_${realConvId}`] = saveKeys.folderName;
  await chrome.storage.local.set(storageUpdate);

  return { saved: true, filename: saveKeys.folderName };
}

// ── Core backup logic (current open tabs) ──────────────────────────────────────

async function performBackup() {
  startKeepalive();
  try {
    const dirHandle = await getFromDB('directoryHandle');
    if (!dirHandle) {
      return { success: false, error: '尚未設定備份資料夾，請先在 Popup 中選擇資料夾' };
    }

    const permission = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      return { success: false, error: '資料夾存取權限已遺失，請開啟 Popup 重新授權' };
    }

    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs.length === 0) {
      return { success: false, error: '沒有開啟中的 Gemini 分頁' };
    }

    let backupCount = 0;
    const errors = [];

    for (const tab of tabs) {
      try {
        const result = await backupSingleTab(tab, dirHandle);
        if (result.saved) backupCount++;
        else if (result.skipped && result.reason !== '無新內容') {
          errors.push(`Tab ${tab.id}: ${result.reason}`);
        }
      } catch (err) {
        errors.push(`Tab ${tab.id}: ${err.message}`);
        console.error('[Backup] Tab error:', err);
      }
    }

    const now = new Date().toISOString();
    await chrome.storage.local.set({ lastBackupTime: now });

    const message = backupCount > 0
      ? `成功備份 ${backupCount} 個對話`
      : '所有對話皆無新內容，略過備份';

    return { success: true, message, errors };
  } catch (err) {
    console.error('[Backup] Fatal error:', err);
    return { success: false, error: err.message };
  } finally {
    stopKeepalive();
  }
}

// ── Scroll sidebar to load all conversation links ─────────────────────────────
//
// Gemini 2026 (Voyager) 側邊欄以 <infinite-scroller> 分批載入對話，每批 20 個。
// 2026-08 實測（533 個對話的帳號）記錄下列行為，本實作針對這些行為設計：
//
//   1. 批次之間有「無新增」的空窗期 — 觀測到連續 5～7 輪（約 4～6 秒）計數不變，
//      之後才又跳一批。舊版「計數一次沒變就 break」因此固定停在 97 個。
//   2. 真正權威的「還在抓」訊號是 infinite-scroller 內的
//      .loading-content-spinner-container（display:none 時代表閒置）。
//   3. 剛載入頁面、Angular 動畫未結束時，scroller 的
//      scrollHeight - clientHeight 可能只有 ~30px，用 +50 當門檻會判定
//      「不可捲」而整個放棄捲動。門檻必須放寬。
//   4. 「近期對話」是 <expandable-section>；收合時對話項目不會 render。
//   5. 載入 533 個對話：等 spinner 的版本約 36 輪 / 152 秒，不等 spinner 的
//      盲捲版本要 88 輪 — 舊版上限 30 輪無論如何都不夠。
//
// 結束條件：連續 STABLE_ROUNDS 輪沒有新增、spinner 已停、且捲軸確實在底部。

const SIDEBAR_SLICE_ROUNDS = 5;          // 每次注入執行的捲動輪數（切片以便中途檢查停止）
const SIDEBAR_MAX_SLICES = 100;          // 5 × 100 = 500 輪，可涵蓋 3000+ 對話
const SIDEBAR_STABLE_ROUNDS = 8;         // 連續 N 輪無新增才視為載入完畢
const SIDEBAR_WALL_TIMEOUT_MS = 8 * 60000;

// 在頁面內執行一個「切片」：捲動數輪並回報進度。
// 跨切片的狀態掛在 window.__gcbSidebarScan，由 driver 先行重置。
async function sidebarScanSlice(rounds, stableTarget) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const aborted = () => !!window.__geminiBackupAborted;

  const st = window.__gcbSidebarScan || (window.__gcbSidebarScan = { prev: -1, stable: 0, rounds: 0 });

  const sidenav = () =>
    document.querySelector('bard-sidenav, [data-test-id="bard-sidenav-container"]');

  // 「近期對話」收合時項目不會 render — 先確保展開
  function ensureChatsExpanded() {
    const root = sidenav();
    if (!root) return false;
    for (const sec of root.querySelectorAll('expandable-section')) {
      const isChats =
        sec.getAttribute('data-test-id') === 'chats-expandable-section' ||
        !!sec.querySelector('conversations-list, [data-test-id="conversation"]');
      if (!isChats) continue;
      const toggle = sec.querySelector('[data-test-id="expandable-section-toggle"]');
      if (!toggle) continue;
      const expanded =
        sec.classList.contains('expanded') || toggle.getAttribute('aria-expanded') === 'true';
      if (!expanded) {
        try { toggle.click(); } catch (_) {}
        return true; // 有實際展開動作，呼叫端應多等一下
      }
    }
    return false;
  }

  // 找出真正裝著對話清單、且真的可捲動的容器。
  // 優先從「實際存在的對話項目」往上找 — 比猜選擇器可靠得多。
  function findScrollEl() {
    const root = sidenav();
    const canScroll = (el, minDelta) => {
      if (!el || !el.isConnected) return false;
      if (el.scrollHeight <= el.clientHeight + minDelta) return false;
      try {
        return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
      } catch (_) { return true; }
    };

    const item = (root || document).querySelector(
      '[data-test-id="conversation"], a[href*="/app/"]'
    );
    if (item) {
      let el = item.parentElement;
      while (el && el !== document.body) {
        if (canScroll(el, 4)) return el;
        el = el.parentElement;
      }
    }

    if (root) {
      // 清單還沒撐開高度時，只要 overflow-y 允許捲動就先接受（門檻 0）
      for (const el of root.querySelectorAll('infinite-scroller')) {
        if (canScroll(el, 4)) return el;
      }
      for (const el of root.querySelectorAll('infinite-scroller')) {
        try {
          if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) return el;
        } catch (_) {}
      }
    }

    for (const sel of [
      'conversations-list[data-test-id="all-conversations"]',
      '.cdk-virtual-scroll-viewport',
      '.conversations-list',
      '.conversation-list',
    ]) {
      const el = document.querySelector(sel);
      if (canScroll(el, 4)) return el;
    }
    return null;
  }

  // Gemini 正在向後端抓下一批的訊號
  function isLoadingMore() {
    const root = sidenav();
    if (!root) return false;
    const els = root.querySelectorAll(
      '.loading-content-spinner-container, mat-progress-spinner, mat-spinner, [role="progressbar"]'
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0) {
        return true;
      }
    }
    return false;
  }

  function countItems() {
    const root = sidenav() || document;
    return Math.max(
      root.querySelectorAll('[data-test-id="conversation"]').length,
      root.querySelectorAll('a[href*="/app/"]').length
    );
  }

  if (aborted()) return { aborted: true, count: countItems(), rounds: st.rounds };

  if (ensureChatsExpanded()) await wait(600);

  const sc = findScrollEl();
  window.__gcbSidebarScrollEl = sc; // driver 結束時用來捲回頂端
  if (!sc) {
    // 對話少到不需捲動，或側邊欄結構已變 — 交給 scanner 掃現有的，不算錯誤
    return { scrollerFound: false, done: true, count: countItems(), rounds: st.rounds };
  }

  for (let i = 0; i < rounds; i++) {
    if (aborted()) return { aborted: true, count: countItems(), rounds: st.rounds };

    sc.scrollTop = sc.scrollHeight;
    // 主動派發 — 部分 listener 為 passive，assignment 不會觸發
    try { sc.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
    await wait(500);

    // 等 Gemini 抓完這一批（spinner 消失），最多 20 秒
    let waited = 0;
    while (isLoadingMore() && waited < 20000) {
      await wait(300);
      waited += 300;
      if (aborted()) return { aborted: true, count: countItems(), rounds: st.rounds };
    }
    await wait(350); // 讓 Angular render 完新項目

    st.rounds++;
    const n = countItems();
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8;

    if (n > st.prev) {
      st.prev = n;
      st.stable = 0;
    } else {
      st.stable++;
    }

    if (st.stable >= stableTarget && atBottom && !isLoadingMore()) {
      return { scrollerFound: true, done: true, count: n, rounds: st.rounds, atBottom };
    }
  }

  return {
    scrollerFound: true,
    done: false,
    count: countItems(),
    rounds: st.rounds,
    stable: st.stable,
  };
}

// driver：分批注入 sidebarScanSlice，切片之間檢查停止旗標並回報進度。
// onProgress(count) 由呼叫端用來更新 UI。
async function scrollSidebarToLoadAll(tabId, onProgress) {
  const started = Date.now();
  let last = { count: 0, rounds: 0 };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.__gcbSidebarScan = { prev: -1, stable: 0, rounds: 0 }; },
    });
  } catch (_) {}

  for (let slice = 0; slice < SIDEBAR_MAX_SLICES; slice++) {
    if (Date.now() - started > SIDEBAR_WALL_TIMEOUT_MS) break;

    const { stopBackupRequested } = await chrome.storage.local.get('stopBackupRequested');
    if (stopBackupRequested) return { ...last, aborted: true };

    let r;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: sidebarScanSlice,
        args: [SIDEBAR_SLICE_ROUNDS, SIDEBAR_STABLE_ROUNDS],
      });
      r = res?.result;
    } catch (err) {
      console.warn('[Sidebar] scan slice failed:', err);
      break;
    }
    if (!r) break;

    last = r;
    if (onProgress) { try { await onProgress(r.count || 0); } catch (_) {} }

    if (r.aborted) return { ...r, aborted: true };
    if (r.done) break;
  }

  // 捲回頂端，讓側邊欄回到使用者習慣的樣子
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = window.__gcbSidebarScrollEl;
        const root = document.querySelector('bard-sidenav');
        const sc = el?.isConnected ? el : root?.querySelector('infinite-scroller');
        if (sc) sc.scrollTop = 0;
      },
    });
  } catch (_) {}

  return last;
}

// ── Full history backup ────────────────────────────────────────────────────────

// limitCount: 0 = 全部；> 0 = 僅備份非 Pinned 的前 N 個（Pinned 永遠全備份）
async function performFullHistoryBackup(limitCount = 0) {
  // Prevent duplicate runs
  const { fullBackupState: running } = await chrome.storage.local.get('fullBackupState');
  if (running?.inProgress) return;

  // 啟動新一輪備份 — 清除前次「按停止」殘留的 stop / abort 旗標，避免誤殺本次作業
  await clearStaleAbortState();

  const state = {
    inProgress: true,
    total: 0,
    done: 0,
    skipped: 0,       // 已有備份、hash 吻合，跳過
    excluded: 0,      // 超出 N 個限制、本次不處理（不是真的遺漏）
    pinnedCount: 0,
    selectedLimit: limitCount,
    currentTitle: '',
    currentUrl: '',
    scanCount: 0,     // 側邊欄捲動階段已載入的對話數（給 popup 顯示進度用）
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    conversations: [], // 所有候選對話及其狀態 {url, title, status, reason}
    fatalError: null,
    stoppedByUser: false,
  };
  await chrome.storage.local.set({ fullBackupState: state });

  async function saveState() {
    state.lastUpdated = new Date().toISOString();
    await chrome.storage.local.set({ fullBackupState: { ...state } });
  }

  startKeepalive();
  try {
    const dirHandle = await getFromDB('directoryHandle');
    if (!dirHandle) {
      state.inProgress = false;
      state.fatalError = '尚未設定備份資料夾，請先選擇資料夾';
      await saveState();
      return;
    }

    const permission = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      state.inProgress = false;
      state.fatalError = '資料夾存取權限已遺失，請開啟 Popup 重新授權';
      await saveState();
      return;
    }

    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (!tabs.length) {
      state.inProgress = false;
      state.fatalError = '請先開啟 Gemini 分頁，並確認側邊欄已展開';
      await saveState();
      return;
    }

    const tab = tabs[0];
    const tabId = tab.id;
    const originalUrl = tab.url;

    // ── 主動展開 sidebar（若為 collapsed 狀態）──────────────────────────────
    // Gemini 2026 改版後 sidebar 預設為 hover-to-expand (collapsed) 模式，
    // 此狀態下對話項目全為空殼，無法掃描。實測
    // [data-test-id="side-nav-sparkle-button"]（aria-label="開啟側欄"）
    // 是真正的展開按鈕 — 程式化 click 即可展開並 render 完整對話清單。
    try {
      const [openResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const wait = ms => new Promise(r => setTimeout(r, ms));
          const sn = document.querySelector('bard-sidenav');
          const wasCollapsed = sn?.classList?.contains('collapsed') || false;

          if (wasCollapsed) {
            const openBtn = document.querySelector('[data-test-id="side-nav-sparkle-button"]');
            if (openBtn) {
              try { openBtn.click(); } catch (_) {}
              // 等候 sidebar 展開、virtual scroll 完成 render
              for (let i = 0; i < 20; i++) {
                await wait(250);
                if (document.querySelectorAll('a[href*="/app/"]').length >= 5) break;
              }
            }
          }

          const navItems = document.querySelectorAll(
            'gem-nav-list-item[data-test-id="conversation"], [data-test-id="conversation"]'
          ).length;
          const links = document.querySelectorAll('a[href*="/app/"]').length;
          const stillCollapsed =
            document.querySelector('bard-sidenav')?.classList?.contains('collapsed') || false;
          const ratio = navItems > 0 ? links / navItems : 1;
          const mostlyEmpty = navItems >= 10 && ratio < 0.3;
          return { wasCollapsed, stillCollapsed, navItems, links, mostlyEmpty };
        },
      });
      const r = openResult?.result;
      if (r && r.wasCollapsed && (r.stillCollapsed || r.mostlyEmpty)) {
        state.inProgress = false;
        state.fatalError =
          `無法展開對話側邊欄（共 ${r.navItems} 個項目，僅 ${r.links} 個已 render）。\n` +
          `請手動點 Gemini 左上角的 ✨ 圖示展開側邊欄，看到完整對話清單後再執行全量備份。`;
        await saveState();
        return;
      }
    } catch (_) {} // 偵測失敗就照常繼續，sidebar_scanner 結果為空時有既有錯誤處理

    // 先捲側邊欄把「所有」對話載進 DOM（Voyager 每批 20 個，需捲很多輪）。
    // 期間把已載入數量回報到 state，讓 popup 顯示「正在掃描（N）」而不是空轉。
    let scanResult = null;
    try {
      scanResult = await scrollSidebarToLoadAll(tabId, async (count) => {
        state.scanCount = count;
        await saveState();
      });
    } catch (_) {} // Non-fatal — scan whatever is visible if this fails

    // 載入 500+ 對話可能要好幾分鐘，期間按停止要能立刻收工
    if (scanResult?.aborted) {
      await chrome.storage.local.remove('stopBackupRequested');
      state.inProgress = false;
      state.stoppedByUser = true;
      state.completedAt = new Date().toISOString();
      await saveState();
      try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}
      return;
    }

    // Scan sidebar for conversation list
    let conversations;
    try {
      const scanResults = await chrome.scripting.executeScript({
        target: { tabId },
        files: ['sidebar_scanner.js'],
      });
      conversations = scanResults?.[0]?.result;
    } catch (err) {
      state.inProgress = false;
      state.fatalError = `無法掃描側邊欄：${err.message}`;
      await saveState();
      return;
    }

    if (!conversations?.length) {
      state.inProgress = false;
      state.fatalError = '無法讀取對話清單，請確認 Gemini 側邊欄已展開';
      await saveState();
      return;
    }

    // 分離 Pinned 與非 Pinned 對話
    // Pinned 對話永遠全備份；非 Pinned 依 limitCount 截取前 N 個（0 = 全部）
    const pinnedConvs = conversations.filter(c => c.pinned);
    const nonPinnedConvs = conversations.filter(c => !c.pinned);
    const limitedNonPinned = limitCount > 0 ? nonPinnedConvs.slice(0, limitCount) : nonPinnedConvs;
    const candidateConvs = [...pinnedConvs, ...limitedNonPinned];

    state.pinnedCount = pinnedConvs.length;
    // 超出 limit 的非 Pinned 對話（本次不處理，但不是錯誤）
    state.excluded = conversations.length - candidateConvs.length;

    state.total = candidateConvs.length;
    state.skipped = 0;
    // 從一開始就建立完整清單，status=pending；手動停止時未處理的也看得到
    state.conversations = candidateConvs.map(c => ({
      url: c.url, title: c.title, status: 'pending', reason: null,
    }));
    await saveState();

    // storage 缺索引時，從備份資料夾的 meta 註記恢復（增量判斷不依賴 storage 存續）
    try {
      const seeded = await seedStorageFromLocalBackups(dirHandle, candidateConvs);
      if (seeded > 0) console.log(`[FullBackup] 從本地備份重建 ${seeded} 筆索引`);
    } catch (err) {
      console.warn('[FullBackup] 本地索引重建失敗（不影響備份）:', err);
    }

    // ── 手動停止 helper ───────────────────────────────────────────────────────────
    // 清除停止旗標、更新狀態、導回原始頁面
    async function handleStop() {
      await chrome.storage.local.remove('stopBackupRequested');
      state.inProgress = false;
      state.stoppedByUser = true;
      state.currentTitle = '';
      state.currentUrl = '';
      state.completedAt = new Date().toISOString();
      await saveState();
      try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}
    }

    for (const conv of candidateConvs) {
      // ── Stop check #1：每次迭代開始前確認 ──
      { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
        if (s) { await handleStop(); return; } }

      state.currentTitle = conv.title;
      state.currentUrl = conv.url;
      await saveState();

      const convEntry = state.conversations.find(c => c.url === conv.url);

      try {
        const convId = stableConvId(conv.url);

        // 先取出已儲存的 hash / msg count / 尾端指紋（不需要等 navigation）
        const stored = await chrome.storage.local.get([
          `chatHash_${convId}`,
          `chatFolderName_${convId}`,
          `chatMsgCount_${convId}`,
          `chatTailSig_${convId}`,
        ]);

        const isGemChat = conv.url.includes('/gem/');
        await navigateAndWaitRetry(tabId, conv.url, isGemChat ? 4000 : 2500);

        // ── Stop check #2：navigate 完成後立即確認（navigate 本身耗時 2~4 秒）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        // ── 快速比對：若曾備份過，先數可見訊息數量決定是否需要 scroll / 擷取 ──
        const prevMsgCount = stored[`chatMsgCount_${convId}`] || 0;
        const prevHash = stored[`chatHash_${convId}`];
        // storage 有紀錄還不夠——本地資料夾必須真的存在才能跳過
        //（使用者手動刪除備份資料夾後，該對話應重新備份而不是永遠被略過）
        const alreadyFolder = await localBackupExists(
          dirHandle, stored[`chatFolderName_${convId}`]
        );
        const hasPrevBackup = !!prevHash && prevMsgCount > 0;

        // ── 快速略過：比對尾端指紋 ────────────────────────────────────────
        // 新訊息一定 append 在對話尾端，而尾端在初次 render 就已存在，
        // 所以尾端指紋相同 = 沒有新訊息，可以完全跳過捲動與擷取。
        // 舊版改用「畫面訊息數 <= 上次備份數」，對 20 則以上的對話恆為真
        //（實測 Gemini 初次只 render 20 則），會把有新訊息的長對話一起略過
        // —— 這是 v2.2.3 修掉的漏備份主因。
        // 沒有尾端指紋（升級前備份的對話）就照常走完整流程，寧可慢也不漏。
        const prevTailSig = stored[`chatTailSig_${convId}`] || '';
        if (hasPrevBackup && alreadyFolder && prevTailSig) {
          const sig = await readTailSignature(tabId);
          if (sig && sig.tail && sig.tail === prevTailSig) {
            if (convEntry) convEntry.status = 'skipped';
            state.skipped++;
            state.done++;
            await saveState();
            await randomDelay(800, 1600);
            continue;
          }
        }

        // ── Stop check #3：scroll 前確認（scroll 可能是最耗時的步驟）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        // 傳入 prevMsgCount：捲回到上次備份數量後即可停止，不需要捲到最舊
        // prevMsgCount = 0 表示從未備份，會退回為全量捲動
        await scrollToLoadAllMessages(tabId, prevMsgCount);

        // ── Stop check #4：scroll 完成後、extract 前 ──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        const data = await extractConversation(tabId);

        // ── Stop check #5：content.js 執行完後立即確認（圖片下載可能耗時 10+ 秒）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }
        if (data?.aborted) { await handleStop(); return; } // content.js 內部偵測到 abort

        if (!data?.content) {
          if (convEntry) { convEntry.status = 'failed'; convEntry.reason = '無法擷取內容'; }
        } else {
          const { content, hash, messages, images } = data;

          // hash 相同且已有資料夾備份 → 略過；只有舊 .md → 繼續遷移
          if (prevHash === hash && alreadyFolder) {
            if (convEntry) convEntry.status = 'skipped';
            state.skipped++;
            state.done++;
            await saveState();
            continue;
          }

          // msg count 回退保護（scroll 未完整載入）
          const currMsgCount = messages ? messages.length : 0;
          if (prevMsgCount > 0 && currMsgCount < prevMsgCount) {
            if (convEntry) convEntry.status = 'skipped';
            state.skipped++;
            state.done++;
            await saveState();
            continue;
          }

          // Prefer sidebar title for filename (more reliable for Gem chats)
          const filenameTitle = conv.title || data.title || '未命名對話';
          const safeTitle = filenameTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';

          const saveKeys = await saveConversationFiles(
            dirHandle, safeTitle, convId, content, images || [], stored
          );

          if (convEntry) convEntry.status = 'done';

          const now = new Date().toISOString();
          const storageUpdate = {
            [`chatHash_${convId}`]: hash,
            [`chatMsgCount_${convId}`]: currMsgCount,
            [`chatSyncTime_${convId}`]: now,
          };
          // 記下尾端指紋供下次增量判斷（此時歷史已完整載入，尾端是真正的最後一則）
          const newSig = await readTailSignature(tabId);
          if (newSig?.tail) storageUpdate[`chatTailSig_${convId}`] = newSig.tail;
          if (saveKeys.folderName) storageUpdate[`chatFolderName_${convId}`] = saveKeys.folderName;
          await chrome.storage.local.set(storageUpdate);
        }
      } catch (err) {
        if (convEntry) { convEntry.status = 'failed'; convEntry.reason = err.message; }
        console.error('[FullBackup] Conversation error:', err);
      }

      state.done++;
      await saveState();

      // 每次換頁後隨機休息，避免高頻操作被 Google 偵測為機器人
      await randomDelay(1200, 2800);
      // 每 10 個對話額外休息一次（模擬人類暫停）
      if (state.done % 10 === 0) await randomDelay(3000, 6000);
    }

    // Navigate back to where we started
    try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}

    state.inProgress = false;
    state.currentTitle = '';
    state.currentUrl = '';
    state.completedAt = new Date().toISOString();
    await saveState();

  } catch (err) {
    console.error('[FullBackup] Fatal error:', err);
    state.inProgress = false;
    state.fatalError = err.message;
    await chrome.storage.local.set({ fullBackupState: state });
  } finally {
    stopKeepalive();
  }
}

// ── 重試失敗項目 ───────────────────────────────────────────────────────────────

async function performRetryFailedBackup() {
  const { fullBackupState: currentState } = await chrome.storage.local.get('fullBackupState');
  if (currentState?.inProgress) return;

  // 重試目標：failed（失敗）或 pending（手動停止前未處理）
  const retryTargets = (currentState?.conversations || []).filter(
    c => c.status === 'failed' || c.status === 'pending'
  );
  if (!retryTargets.length) return;

  // 啟動重試前清除殘留 stop / abort 狀態（與全量備份對齊）
  await clearStaleAbortState();

  // 將重試目標 status 全部重設為 pending，保留其餘已完成的紀錄
  const resetConversations = (currentState.conversations || []).map(c =>
    (c.status === 'failed' || c.status === 'pending')
      ? { ...c, status: 'pending', reason: null }
      : c
  );

  const state = {
    ...currentState,
    inProgress: true,
    total: retryTargets.length,
    done: 0,
    skipped: 0,
    conversations: resetConversations,
    currentTitle: '',
    currentUrl: '',
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    completedAt: null,
    stoppedByUser: false,
    fatalError: null,
    isRetrying: true,
  };
  await chrome.storage.local.set({ fullBackupState: state });

  async function saveState() {
    state.lastUpdated = new Date().toISOString();
    await chrome.storage.local.set({ fullBackupState: { ...state } });
  }

  startKeepalive();
  try {
    const dirHandle = await getFromDB('directoryHandle');
    if (!dirHandle) {
      state.inProgress = false;
      state.fatalError = '尚未設定備份資料夾，請先選擇資料夾';
      await saveState();
      return;
    }

    const permission = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      state.inProgress = false;
      state.fatalError = '資料夾存取權限已遺失，請開啟 Popup 重新授權';
      await saveState();
      return;
    }

    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (!tabs.length) {
      state.inProgress = false;
      state.fatalError = '請先開啟 Gemini 分頁，並確認側邊欄已展開';
      await saveState();
      return;
    }

    const tab = tabs[0];
    const tabId = tab.id;
    const originalUrl = tab.url;

    for (const target of retryTargets) {
      { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
        if (s) {
          await chrome.storage.local.remove('stopBackupRequested');
          state.inProgress = false;
          state.stoppedByUser = true;
          state.currentTitle = '';
          state.currentUrl = '';
          state.completedAt = new Date().toISOString();
          await saveState();
          try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}
          return;
        }
      }

      state.currentTitle = target.title;
      state.currentUrl = target.url;
      await saveState();

      const convEntry = state.conversations.find(c => c.url === target.url);

      try {
        const convId = stableConvId(target.url);
        const stored = await chrome.storage.local.get([
          `chatHash_${convId}`,
          `chatFolderName_${convId}`,
          `chatMsgCount_${convId}`,
        ]);

        const isGemChat = target.url.includes('/gem/');
        await navigateAndWaitRetry(tabId, target.url, isGemChat ? 4000 : 2500);

        // 重試時不信任舊的 msgCount，做完整 scroll
        await scrollToLoadAllMessages(tabId, 0);

        const data = await extractConversation(tabId);

        // Stop check：content.js 執行完後立即確認（圖片下載可能耗時 10+ 秒）
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) {
            await chrome.storage.local.remove('stopBackupRequested');
            state.inProgress = false;
            state.stoppedByUser = true;
            state.currentTitle = '';
            state.currentUrl = '';
            state.completedAt = new Date().toISOString();
            await saveState();
            try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}
            return;
          }
        }
        if (data?.aborted) {
          state.inProgress = false;
          state.stoppedByUser = true;
          state.currentTitle = '';
          state.currentUrl = '';
          state.completedAt = new Date().toISOString();
          await saveState();
          try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}
          return;
        }

        if (!data?.content) {
          if (convEntry) { convEntry.status = 'failed'; convEntry.reason = '無法擷取內容'; }
        } else {
          const { content, hash, messages, images } = data;

          const filenameTitle = target.title || data.title || '未命名對話';
          const safeTitle = filenameTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';

          const saveKeys = await saveConversationFiles(
            dirHandle, safeTitle, convId, content, images || [], stored
          );

          if (convEntry) convEntry.status = 'done';

          const currMsgCount = messages ? messages.length : 0;
          const now = new Date().toISOString();
          const storageUpdate = {
            [`chatHash_${convId}`]: hash,
            [`chatMsgCount_${convId}`]: currMsgCount,
            [`chatSyncTime_${convId}`]: now,
          };
          // 記下尾端指紋供下次增量判斷（此時歷史已完整載入，尾端是真正的最後一則）
          const newSig = await readTailSignature(tabId);
          if (newSig?.tail) storageUpdate[`chatTailSig_${convId}`] = newSig.tail;
          if (saveKeys.folderName) storageUpdate[`chatFolderName_${convId}`] = saveKeys.folderName;
          await chrome.storage.local.set(storageUpdate);
        }
      } catch (err) {
        if (convEntry) { convEntry.status = 'failed'; convEntry.reason = err.message; }
        console.error('[RetryBackup] Conversation error:', err);
      }

      state.done++;
      await saveState();

      await randomDelay(1200, 2800);
      if (state.done % 10 === 0) await randomDelay(3000, 6000);
    }

    try { await chrome.tabs.update(tabId, { url: originalUrl }); } catch (_) {}

    state.inProgress = false;
    state.currentTitle = '';
    state.currentUrl = '';
    state.completedAt = new Date().toISOString();
    await saveState();

  } catch (err) {
    console.error('[RetryBackup] Fatal error:', err);
    state.inProgress = false;
    state.fatalError = err.message;
    await chrome.storage.local.set({ fullBackupState: state });
  } finally {
    stopKeepalive();
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[Backup] Alarm triggered');
    const result = await performBackup();
    console.log('[Backup] Result:', result);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'manualBackup') {
    performBackup().then(sendResponse);
    return true;
  }

  if (message.action === 'updateAlarm') {
    setupAlarm(message.intervalHours).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'getStatus') {
    chrome.storage.local.get(['lastBackupTime'], (data) => {
      sendResponse({ lastBackupTime: data.lastBackupTime || null });
    });
    return true;
  }

  if (message.action === 'startFullBackup') {
    const limitCount = message.limitCount || 0;
    performFullHistoryBackup(limitCount); // fire-and-forget; progress tracked in storage
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'stopFullBackup') {
    chrome.storage.local.set({ stopBackupRequested: true });
    // 同步廣播 page-side abort flag — 頁面內的長迴圈（歷史捲動、圖片下載、
    // 官方複製擷取）每次輪詢都會檢查，立即跳出而不必等到下一個背景 checkpoint
    broadcastAbortFlag(true);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'retryFailedBackup') {
    performRetryFailedBackup(); // fire-and-forget; progress tracked in storage
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'resetFullBackupState') {
    chrome.storage.local.remove(['stopBackupRequested', 'fullBackupState'], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'getChatSyncStatus') {
    const { url, tabId } = message;
    const convId = stableConvId(url);

    chrome.storage.local.get(
      [`chatHash_${convId}`, `chatSyncTime_${convId}`, `chatMsgCount_${convId}`,
       `chatTailSig_${convId}`, 'fullBackupState'],
      async (data) => {
        // chatSyncTime 兼容舊版：升級後 chatHash 尚未寫入前，舊備份仍視為已同步
        const isSynced = !!(data[`chatHash_${convId}`] || data[`chatSyncTime_${convId}`]);
        const lastSyncTime = data[`chatSyncTime_${convId}`] || null;
        const storedMsgCount = data[`chatMsgCount_${convId}`] || 0;
        const fullState = data.fullBackupState;
        const isSyncing = !!(fullState?.inProgress && fullState?.currentUrl === url);

        // 「有新訊息」徽章：優先比對尾端指紋。
        // 舊版比 currentCount > storedMsgCount，但 Gemini 初次只 render 20 則，
        // 20 > 200 永遠不成立 —— 長對話的徽章因此從來不會亮。
        const storedTailSig = data[`chatTailSig_${convId}`] || '';
        let hasNewMessages = false;
        if (isSynced && !isSyncing && tabId) {
          try {
            if (storedTailSig) {
              const sig = await readTailSignature(tabId);
              hasNewMessages = !!(sig?.tail && sig.tail !== storedTailSig);
            } else if (storedMsgCount > 0) {
              // 升級前備份、還沒有指紋 → 沿用舊的計數比對（只會少報不會誤報）
              const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: countMessagesOnPage,
                args: [USER_TURN_SELECTORS, MODEL_TURN_SELECTORS],
              });
              hasNewMessages = (result?.result || 0) > storedMsgCount;
            }
          } catch (_) {}
        }

        sendResponse({ isSynced, isSyncing, lastSyncTime, hasNewMessages });
      }
    );
    return true;
  }
});

// ── 輕量計數函式（注入頁面）────────────────────────────────────────────────────
// 使用與 content.js 相同的選擇器（由 args 傳入），快速計算當前頁面訊息總數
function countMessagesOnPage(userSelectors, modelSelectors) {
  function queryShadowAll(root, selector) {
    const results = [];
    const visited = new WeakSet();
    function traverse(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      try {
        Array.from(node.querySelectorAll(selector)).forEach(el => results.push(el));
        Array.from(node.querySelectorAll('*')).forEach(el => {
          if (el.shadowRoot) traverse(el.shadowRoot);
        });
      } catch (_) {}
    }
    traverse(root);
    return results;
  }

  let userCount = 0;
  for (const sel of userSelectors) {
    const found = queryShadowAll(document, sel);
    if (found.length) { userCount = found.length; break; }
  }
  let modelCount = 0;
  for (const sel of modelSelectors) {
    const found = queryShadowAll(document, sel);
    if (found.length) { modelCount = found.length; break; }
  }
  return userCount + modelCount;
}

// ── 對話「尾端指紋」──────────────────────────────────────────────────────────
//
// 為什麼需要它：Gemini 開啟長對話時「只 render 最後 20 則」，其餘要往上捲才載入。
// 舊版增量判斷用「目前畫面上的訊息數 <= 上次備份數」來略過，對超過 20 則的對話
// 永遠成立（20 <= 200），結果是長對話一旦備份過就再也不會更新 —— 新訊息被靜默漏掉。
// 2026-08 於 Voyager 實測確認：初次 render 固定 20 則，且「最後一則」一定在 DOM 裡
// （捲到底後尾端內容不變）。因此改用尾端內容當指紋：新訊息一律 append 在尾端，
// 尾端沒變就代表沒有新訊息，這個判斷不受虛擬化 render 影響。
function computeTailSignatureOnPage(userSelectors, modelSelectors) {
  function queryShadowAll(root, selector) {
    const results = [];
    const visited = new WeakSet();
    function traverse(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      try {
        Array.from(node.querySelectorAll(selector)).forEach(el => results.push(el));
        Array.from(node.querySelectorAll('*')).forEach(el => {
          if (el.shadowRoot) traverse(el.shadowRoot);
        });
      } catch (_) {}
    }
    traverse(root);
    return results;
  }

  function lastText(selectors) {
    for (const sel of selectors) {
      const found = queryShadowAll(document, sel);
      if (found.length) {
        const el = found[found.length - 1];
        return (el.innerText || el.textContent || '').trim();
      }
    }
    return '';
  }

  const userTail = lastText(userSelectors);
  const modelTail = lastText(modelSelectors);
  const rendered =
    (function () {
      let u = 0, m = 0;
      for (const sel of userSelectors) { const f = queryShadowAll(document, sel); if (f.length) { u = f.length; break; } }
      for (const sel of modelSelectors) { const f = queryShadowAll(document, sel); if (f.length) { m = f.length; break; } }
      return u + m;
    })();

  // 只取尾端 400 字做指紋 —— 足以辨識「有沒有新訊息」，又不必搬運整篇內容
  const raw = `${userTail.slice(-400)}\u0000${modelTail.slice(-400)}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;

  return { rendered, tail: raw ? `${raw.length}:${(h >>> 0).toString(36)}` : '' };
}

// 讀取目前分頁的尾端指紋；失敗回傳 null（呼叫端退回完整流程，不會誤略過）
async function readTailSignature(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: computeTailSignatureOnPage,
      args: [USER_TURN_SELECTORS, MODEL_TURN_SELECTORS],
    });
    return res?.result || null;
  } catch (_) {
    return null;
  }
}

// Restore alarm on service worker restart
// Also clear any stuck inProgress state — if the service worker restarted,
// the backup loop is definitely no longer running.
chrome.runtime.onStartup.addListener(async () => {
  const { backupInterval, fullBackupState } = await chrome.storage.local.get(['backupInterval', 'fullBackupState']);
  if (backupInterval) await setupAlarm(backupInterval);
  if (fullBackupState?.inProgress) {
    await chrome.storage.local.set({
      fullBackupState: {
        ...fullBackupState,
        inProgress: false,
        stoppedByUser: false,
        fatalError: 'browserRestart',
      },
    });
  }
  // Clear any leftover stop flag
  await chrome.storage.local.remove('stopBackupRequested');
});

// 安裝 / 更新時：
// 1. 重新設定排程（擴充套件更新會清掉 alarms）
// 2. 清除 v2.1 以前的 URL-based hash 索引（其計算包含備份時間戳，永遠不會命中，
//    v2.2 起改用 chatHash_[convId] 的穩定內容雜湊）
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { backupInterval } = await chrome.storage.local.get('backupInterval');
    if (backupInterval) await setupAlarm(backupInterval);

    const all = await chrome.storage.local.get(null);
    const legacyKeys = Object.keys(all).filter(k => k.startsWith('hash_'));
    if (legacyKeys.length) {
      await chrome.storage.local.remove(legacyKeys);
      console.log(`[Backup] 已清除 ${legacyKeys.length} 筆舊版 hash 索引`);
    }
  } catch (err) {
    console.warn('[Backup] onInstalled migration error:', err);
  }
});
