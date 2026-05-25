// background.js - Service Worker
// Handles alarms, backup orchestration, and IndexedDB for FileSystemDirectoryHandle

const ALARM_NAME = 'gemini-backup';
const DB_NAME = 'gemini-backup-db';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

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

// Load the full conversation history before extracting content.
//
// Strategy A – Voyager timeline (preferred):
//   Voyager injects `.timeline-dot` buttons; clicking the first one jumps to the
//   earliest loaded turn and triggers Gemini to fetch older history.
//   We repeat until the dot count stops increasing (= no more history).
//
// Strategy B – Manual scrollTop fallback (no Voyager):
//   Set scrollTop = 0, wait. When new messages are prepended the browser pushes
//   the viewport down (scrollTop > 0). Repeat until no shift detected.
// stopAtCount: 0 = 載入全部歷史（預設行為）
//              > 0 = 當 DOM 訊息數 >= stopAtCount 時提前停止，不再往前捲動
//
// 使用場景：對話已備份過（prevMsgCount > 0），只需捲回到上次備份的數量即可。
// 新訊息在頁面載入時就已在 DOM 底部，捲回到 prevMsgCount 後 DOM 即包含完整內容。
async function scrollToLoadAllMessages(tabId, stopAtCount = 0) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (stopAtCount) => {
      // ── 設定 ─────────────────────────────────────────────────────────────────
      const MAX_ITERATIONS = 80;          // 圈數上限（每圈約抓 10–20 則 → ~800–1600 則）
      const WALL_TIMEOUT_MS = 5 * 60_000; // 整體上限 5 分鐘，避免無限卡住
      const PROGRESS_TIMEOUT_MS = 12_000; // 每圈最多等 12 秒看是否有新內容
      const POLL_INTERVAL_MS = 250;       // 每圈內部的輪詢間隔
      const SPINNER_FINISH_WAIT_MS = 10_000; // 看到 spinner 後再等它消失的上限
      const STABILITY_RETRIES = 2;        // 連續 N 圈無進度才視為「真的到頂了」
      const RETRY_BACKOFF_MS = 1_500;     // 無進度後的等待，再做下一次嘗試

      const wait = ms => new Promise(r => setTimeout(r, ms));

      // ── DOM 查找輔助 ─────────────────────────────────────────────────────────
      function countTurns() {
        return Math.max(
          document.querySelectorAll('user-query').length,
          document.querySelectorAll('model-response').length,
          document.querySelectorAll('.query-content').length,
          document.querySelectorAll('.response-content').length,
        );
      }

      function findScrollEl() {
        // 嚴格過濾：必須真正可 scroll（scrollHeight > clientHeight + 50）
        // 並且 overflow-y 不能是 hidden（不然設 scrollTop 沒效果）
        // 實測 #chat-history 與 .chat-history-scroll-container 都是 overflow:hidden,
        // 只有 infinite-scroller[data-test-id="chat-history-container"] 真正可 scroll
        const isScrollable = el => {
          if (!el) return false;
          if (el.scrollHeight <= el.clientHeight + 50) return false;
          try {
            const oy = getComputedStyle(el).overflowY;
            return /(auto|scroll|overlay)/.test(oy);
          } catch (_) { return true; }
        };
        const candidates = [
          document.querySelector('infinite-scroller[data-test-id="chat-history-container"]'),
          document.querySelector('#chat-history'),
          document.querySelector('.chat-history-scroll-container'),
          document.querySelector('.cdk-virtual-scroll-viewport'),
          document.querySelector('main'),
          document.querySelector('[data-scroll-container]'),
        ];
        for (const c of candidates) {
          if (isScrollable(c)) return c;
        }
        // Fallback: 從首則訊息往上 walk 找最近可 scroll 祖先
        const firstMsg = document.querySelector('user-query, model-response');
        if (firstMsg) {
          let el = firstMsg.parentElement;
          while (el && el !== document.body) {
            if (isScrollable(el)) return el;
            el = el.parentElement;
          }
        }
        return document.scrollingElement || document.documentElement;
      }

      function getFirstDot() {
        return document.querySelector('.timeline-dot[data-marker-index="0"]')
            || document.querySelector('.timeline-dot');
      }

      // Gemini 內建 spinner — 抓更早歷史時顯示。判斷實際可見而非僅在 DOM。
      function isSpinnerVisible() {
        const candidates = document.querySelectorAll(
          '[data-test-id="loading-history-spinner"], .loading-history-spinner-container mat-progress-spinner, .loading-history-spinner-container mat-spinner'
        );
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cs = getComputedStyle(el);
            if (cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0) {
              return true;
            }
          }
        }
        return false;
      }

      function expandAllCollapsed() {
        // 訊息展開鈕（aria-label="展開" / "Expand"）— 但 sidebar 的
        // [data-test-id="luminous-expand-button"] 也有相同 aria-label，
        // 點到會干擾側邊欄狀態，必須排除。
        document.querySelectorAll(
          'button[aria-label="Expand"], button[aria-label="展開"]'
        ).forEach(b => {
          // 排除 sidebar 相關按鈕
          if (b.getAttribute('data-test-id') === 'luminous-expand-button') return;
          if (b.closest('bard-sidenav, [data-test-id="bard-sidenav-container"]')) return;
          try { b.click(); } catch (_) {}
        });
      }

      // ── 主流程 ───────────────────────────────────────────────────────────────
      const LOG_PREFIX = '[Gemini Backup]';
      const log = (...a) => console.log(LOG_PREFIX, ...a);
      const isAborted = () => !!window.__geminiBackupAborted;

      // 進入新一輪 — 清掉上一次的 abort flag（避免殘留誤殺）
      window.__geminiBackupAborted = false;

      expandAllCollapsed();

      let scrollEl = findScrollEl();
      const startTime = Date.now();
      let consecutiveNoProgress = 0;
      log(`history load start — initialCount=${countTurns()} stopAtCount=${stopAtCount}`);

      // 已載入足夠數量，跳過所有捲動
      if (stopAtCount > 0 && countTurns() >= stopAtCount) {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        return;
      }

      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        if (isAborted()) { log('aborted by user'); return; }
        if (Date.now() - startTime > WALL_TIMEOUT_MS) break;

        scrollEl = findScrollEl();
        const prevCount = countTurns();
        const prevHeight = scrollEl?.scrollHeight || 0;

        // 提前停止：已達目標數量
        if (stopAtCount > 0 && prevCount >= stopAtCount) break;

        // ── 多重觸發：盡量讓 Gemini 抓更早歷史 ────────────────────────────
        // 經實測，單純 scrollEl.scrollTop = 0 在某些容器上不會觸發 Gemini 的
        // infinite-scroller listener（畫面有閃動但沒 fetch）。對所有候選
        // 容器都觸發，並補上 scroll event dispatch 確保 listener 被叫到。
        const dot = getFirstDot();
        if (dot) { try { dot.click(); } catch (_) {} }

        // 對所有可能的 scroll container 都試一次
        const scrollTargets = [
          document.querySelector('#chat-history'),
          document.querySelector('.chat-history-scroll-container'),
          document.querySelector('infinite-scroller[data-test-id="chat-history-container"]'),
          document.querySelector('infinite-scroller'),
          document.querySelector('.cdk-virtual-scroll-viewport'),
          scrollEl,
        ].filter(Boolean);
        const seenTargets = new Set();
        for (const t of scrollTargets) {
          if (seenTargets.has(t)) continue;
          seenTargets.add(t);
          try {
            t.scrollTop = 0;
            // 主動派發 scroll event — 某些 listener 用 passive、不會被
            // scrollTop assignment 自動觸發
            t.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch (_) {}
        }
        window.scrollTo(0, 0);

        // ── 等待新內容出現（任一訊號達成即算進度）──────────────────────
        const deadline = Date.now() + PROGRESS_TIMEOUT_MS;
        let progressed = false;
        let sawSpinner = false;

        while (Date.now() < deadline) {
          await wait(POLL_INTERVAL_MS);
          if (isAborted()) { log('aborted by user'); return; }
          if (isSpinnerVisible()) sawSpinner = true;

          // scrollEl 有可能在重 render 時被替換
          scrollEl = findScrollEl();
          const curr = countTurns();
          const currHeight = scrollEl?.scrollHeight || 0;

          if (curr > prevCount || currHeight > prevHeight + 50) {
            progressed = true;
            break;
          }
        }

        // 看到 spinner 就再等它消失（同一 chunk 全部 render 完才算數）
        if (sawSpinner) {
          const spinnerDeadline = Date.now() + SPINNER_FINISH_WAIT_MS;
          while (Date.now() < spinnerDeadline && isSpinnerVisible()) {
            await wait(POLL_INTERVAL_MS);
            if (isAborted()) { log('aborted by user'); return; }
          }
        }

        // 新載入的訊息可能含 collapsed 區段 — 每圈都重新展開
        expandAllCollapsed();

        const currCount = countTurns();
        log(`iter=${iter} count ${prevCount}→${currCount} progressed=${progressed} sawSpinner=${sawSpinner}`);

        if (progressed) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= STABILITY_RETRIES) break; // 真的到頂
          await wait(RETRY_BACKOFF_MS); // 給網路 / API 一點喘息再試一次
          if (isAborted()) { log('aborted by user'); return; }
        }
      }

      log(`history load done — finalCount=${countTurns()} elapsed=${Math.round((Date.now()-startTime)/1000)}s`);

      // ── 收尾：捲回底部，恢復使用者視角 ──────────────────────────────────
      scrollEl = findScrollEl();
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      // Voyager：點最後一個 dot 跳到最新訊息
      const dots = document.querySelectorAll('.timeline-dot');
      if (dots.length) { try { dots[dots.length - 1].click(); } catch (_) {} }
      window.scrollTo(0, document.body.scrollHeight);
      await wait(500);
    },
    args: [stopAtCount],
  });
}

// Navigate a tab to url and wait for it to finish loading
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
        if (stopBackupRequested) settle(reject, new Error('使用者已取消備份'));
      } catch (_) {}
    }, 300);

    let hasStartedLoading = false;

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') hasStartedLoading = true;
      if (hasStartedLoading && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Extra wait for dynamic content to render (±30% jitter to look more human)
        const extraDelay = extraWaitMs * (0.7 + Math.random() * 0.6);
        setTimeout(() => settle(resolve), extraDelay);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
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

// ── Single-conversation backup ─────────────────────────────────────────────────

async function backupSingleTab(tab, dirHandle) {
  // 先取得上次備份的訊息數，再決定捲動深度。
  // 若已備份過（prevMsgCount > 0），捲到 prevMsgCount 即可停止——
  // 新訊息已在頁面底部，舊訊息捲回到 prevMsgCount 後 DOM 即包含完整內容。
  const convId = stableConvId(tab.url);
  const preStored = await chrome.storage.local.get([
    `hash_${encodeURIComponent(tab.url)}`,
    `chatFilename_${convId}`,
    `chatFolderName_${convId}`,
    `chatMsgCount_${convId}`,
  ]);
  const prevMsgCount = preStored[`chatMsgCount_${convId}`] || 0;

  await scrollToLoadAllMessages(tab.id, prevMsgCount);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });

  const data = results?.[0]?.result;
  if (!data || !data.content) {
    return { skipped: true, reason: '無法擷取對話內容（頁面可能不是對話頁）' };
  }

  const { title, content, hash, url, messages, images } = data;
  const realConvId = stableConvId(url);
  const storageKey = `hash_${encodeURIComponent(url)}`;
  // 若 tab.url 和 content.js 拿到的 url 相同，直接複用 preStored；否則重新查詢
  const stored = realConvId === convId ? preStored : await chrome.storage.local.get([
    storageKey,
    `chatFilename_${realConvId}`,
    `chatFolderName_${realConvId}`,
    `chatMsgCount_${realConvId}`,
  ]);

  // hash 相同且已有資料夾備份 → 真正略過；hash 相同但只有舊 .md → 繼續以遷移至資料夾格式
  const alreadyFolder = !!stored[`chatFolderName_${realConvId}`];
  if (stored[storageKey] === hash && alreadyFolder) {
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
    [storageKey]: hash,
    [`chatMsgCount_${realConvId}`]: currMsgCount,
    [`chatSyncTime_${realConvId}`]: now,
  };
  if (saveKeys.filename) storageUpdate[`chatFilename_${realConvId}`] = saveKeys.filename;
  if (saveKeys.folderName) storageUpdate[`chatFolderName_${realConvId}`] = saveKeys.folderName;
  await chrome.storage.local.set(storageUpdate);

  return { saved: true, filename: saveKeys.folderName || saveKeys.filename };
}

// ── Core backup logic (current open tabs) ──────────────────────────────────────

async function performBackup() {
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
  }
}

// ── Scroll sidebar to load all conversation links ─────────────────────────────
//
// Gemini's sidebar uses CDK virtual scroll — older conversations are only in the
// DOM once you scroll down far enough.  We scroll the sidebar container to the
// bottom, wait for new links, and repeat until the count stabilises.

async function scrollSidebarToLoadAll(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));

      // Find the sidebar's TRULY scrollable container.
      // v2 (2026 redesign) 重要修正：conversations-list 的 scrollHeight == clientHeight，
      // 不能 scroll！真正可 scroll 的是包在 sidebar 內、不同於 chat-history 的另一個
      // <infinite-scroller>。要靠 scrollHeight > clientHeight + 50 + 排除 chat 區
      // 來區分。
      function findSidebarScrollEl() {
        const isScrollable = el => {
          if (!el) return false;
          if (el.scrollHeight <= el.clientHeight + 50) return false;
          try {
            const oy = getComputedStyle(el).overflowY;
            return /(auto|scroll|overlay)/.test(oy);
          } catch (_) { return true; }
        };
        // 候選：先 sidebar root 範圍內找 <infinite-scroller>
        const root = document.querySelector('bard-sidenav, [data-test-id="bard-sidenav-container"]');
        if (root) {
          const innerIS = root.querySelector('infinite-scroller');
          if (isScrollable(innerIS)) return innerIS;
        }
        // 從第一個對話連結往上走，找最近的可 scroll 祖先（最可靠的 fallback）
        const firstLink = document.querySelector('a[href*="/app/"]');
        if (firstLink) {
          let el = firstLink.parentElement;
          while (el && el !== document.body) {
            if (isScrollable(el)) return el;
            el = el.parentElement;
          }
        }
        // legacy fallbacks
        for (const sel of ['.cdk-virtual-scroll-viewport', 'mat-sidenav .conversations', '.conversations-list', '.conversation-list']) {
          const el = document.querySelector(sel);
          if (isScrollable(el)) return el;
        }
        return null;
      }

      const sidebarEl = findSidebarScrollEl();
      if (!sidebarEl) {
        // 找不到可 scroll 的容器 — 可能 sidebar 結構已變，或對話本來就少不需 scroll
        // 不算錯誤，後續 scanner 仍會掃描已 render 的對話
        return;
      }

      let prevCount = document.querySelectorAll('a[href*="/app/"]').length;

      for (let attempt = 0; attempt < 30; attempt++) {
        sidebarEl.scrollTop = sidebarEl.scrollHeight;
        // 主動派發 scroll 事件 — 某些 listener 是 passive 不會自動觸發
        try { sidebarEl.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
        await wait(1200);

        const newCount = document.querySelectorAll('a[href*="/app/"]').length;
        if (newCount === prevCount) break; // Stable — all conversations loaded
        prevCount = newCount;
      }

      // Scroll back to top so the sidebar looks normal for the user
      sidebarEl.scrollTop = 0;
      await wait(300);
    },
  });
}

// ── Full history backup ────────────────────────────────────────────────────────

// 清除上一次備份留下的殘留狀態（stop flag、page-side abort flag）
// 避免「按停止後重新備份」時舊狀態誤殺新作業
async function clearStaleAbortState() {
  // 1. 清除 storage 的 stop flag
  await chrome.storage.local.remove('stopBackupRequested');

  // 2. 重設所有 Gemini 分頁的 page-side abort flag
  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    await Promise.all((tabs || []).map(t =>
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => { window.__geminiBackupAborted = false; },
      }).catch(() => {})
    ));
  } catch (_) {}
}

// limitCount: 0 = 全部；> 0 = 僅備份非 Pinned 的前 N 個（Pinned 永遠全備份）
async function performFullHistoryBackup(limitCount = 0) {
  // Prevent duplicate runs
  const { fullBackupState: running } = await chrome.storage.local.get('fullBackupState');
  if (running?.inProgress) return;

  // 啟動新一輪全量備份 — 無條件清除前次殘留狀態：
  // - stopBackupRequested (storage flag)
  // - window.__geminiBackupAborted (page flag) on all Gemini tabs
  // - 整份舊的 fullBackupState（包含 failed/pending 紀錄）
  // 這樣前次「按停止」或「失敗中斷」的殘留不會影響本次掃描與處理
  await clearStaleAbortState();
  await chrome.storage.local.remove('fullBackupState');

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

    // ── 主動展開 sidebar（若為 collapsed 狀態）────────────────────────────
    // Gemini 2026 改版後 sidebar 預設為 hover-to-expand (collapsed) 模式，
    // 此狀態下 gem-nav-list-item 全為空殼，無法掃描對話清單。
    // 實測 [data-test-id="side-nav-sparkle-button"] (aria-label="開啟側欄")
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
              // 等候 sidebar 展開、CDK virtual scroll 完成 render
              for (let i = 0; i < 20; i++) {
                await wait(250);
                const links = document.querySelectorAll('a[href*="/app/"]').length;
                if (links >= 5) break;
              }
            }
          }

          const navItems = document.querySelectorAll('gem-nav-list-item[data-test-id="conversation"]').length;
          const links = document.querySelectorAll('a[href*="/app/"]').length;
          const stillCollapsed = document.querySelector('bard-sidenav')?.classList?.contains('collapsed') || false;
          const ratio = navItems > 0 ? links / navItems : 1;
          const mostlyEmpty = navItems >= 10 && ratio < 0.3;
          return { wasCollapsed, stillCollapsed, navItems, links, mostlyEmpty };
        },
      });
      const r = openResult?.result;
      if (r && (r.stillCollapsed || r.mostlyEmpty)) {
        state.inProgress = false;
        state.fatalError =
          `無法展開對話側邊欄（共 ${r.navItems} 個項目，僅 ${r.links} 個已 render）。\n` +
          `請手動點 Gemini 左上角的 ✨ Gemini 圖示展開側邊欄，看到完整對話清單後再執行全量備份。`;
        await saveState();
        return;
      }
    } catch (_) {} // 偵測本身失敗就 fallback 繼續，sidebar_scanner 結果若為空會被下方錯誤處理

    // Scroll sidebar first to load ALL conversations (CDK virtual scroll)
    try {
      await scrollSidebarToLoadAll(tabId);
    } catch (_) {} // Non-fatal — scan whatever is visible if this fails

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

    // 全部候選對話都需要導航過去比對 hash——
    // 不能在這裡預先過濾「已備份」，因為對話可能自上次備份後有新訊息。
    // 真正的「跳過」判斷在導航後拿到 content.js 結果再比對。
    state.total = candidateConvs.length;
    state.skipped = 0;
    // 從一開始就建立完整清單，status=pending；手動停止時未處理的也看得到
    state.conversations = candidateConvs.map(c => ({
      url: c.url, title: c.title, status: 'pending', reason: null,
    }));
    await saveState();

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
        const storageKey = `hash_${encodeURIComponent(conv.url)}`;

        // 先取出已儲存的 hash 和 msg count（不需要等 navigation）
        const stored = await chrome.storage.local.get([
          storageKey,
          `chatFilename_${convId}`,
          `chatFolderName_${convId}`,
          `chatMsgCount_${convId}`,
        ]);

        const isGemChat = conv.url.includes('/gem/');
        await navigateAndWait(tabId, conv.url, isGemChat ? 4000 : 2500);

        // ── Stop check #2：navigate 完成後立即確認（navigate 本身耗時 2~4 秒）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        // ── 快速比對：若曾備份過，先數可見訊息數量決定是否需要 scroll ──
        // scrollToLoadAllMessages 很耗時，盡量跳過
        const prevMsgCount = stored[`chatMsgCount_${convId}`] || 0;
        const hasPrevBackup = !!stored[storageKey] && prevMsgCount > 0;

        let needFullScroll = !hasPrevBackup; // 從未備份過 → 一定要 scroll

        if (hasPrevBackup) {
          try {
            const [countResult] = await chrome.scripting.executeScript({
              target: { tabId },
              func: countMessagesOnPage,
            });
            const quickCount = countResult?.result || 0;
            if (quickCount > prevMsgCount) {
              needFullScroll = true; // 有新訊息，需要 scroll 才能全量擷取
            }
            // quickCount <= prevMsgCount → 沒有新訊息，跳過 scroll
          } catch (_) {
            needFullScroll = true; // 計數失敗就保守地做完整 scroll
          }
        }

        // ── Stop check #3：scroll 前確認（scroll 可能是最耗時的步驟）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        if (needFullScroll) {
          // 傳入 prevMsgCount：捲回到上次備份數量後即可停止，不需要捲到最舊
          // prevMsgCount = 0 表示從未備份，會退回為全量捲動
          await scrollToLoadAllMessages(tabId, prevMsgCount);
        }

        // ── Stop check #4：scroll 完成後、extract 前 ──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });

        // ── Stop check #5：content.js 執行完後立即確認（圖片下載可能耗時 10+ 秒）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        const data = results?.[0]?.result;
        if (data?.aborted) {
          // content.js 自己偵測到 abort flag — 直接停止整個流程
          await handleStop();
          return;
        }
        if (!data?.content) {
          if (convEntry) { convEntry.status = 'failed'; convEntry.reason = '無法擷取內容'; }
        } else {
          const { content, hash, url, messages, images } = data;
          const realStorageKey = `hash_${encodeURIComponent(url || conv.url)}`;

          // hash 相同且已有資料夾備份 → 略過；只有舊 .md → 繼續遷移
          const alreadyFolder = !!stored[`chatFolderName_${convId}`];
          if (stored[storageKey] === hash && alreadyFolder) {
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
            [realStorageKey]: hash,
            [`chatMsgCount_${convId}`]: currMsgCount,
            [`chatSyncTime_${convId}`]: now,
          };
          if (saveKeys.filename) storageUpdate[`chatFilename_${convId}`] = saveKeys.filename;
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

  // 將重試目標 status 全部重設為 pending，保留其餘已完成的紀錄
  const resetConversations = (currentState.conversations || []).map(c =>
    (c.status === 'failed' || c.status === 'pending')
      ? { ...c, status: 'pending', reason: null }
      : c
  );

  // 啟動重試前清除殘留 stop / abort 狀態（與全量備份對齊）
  await clearStaleAbortState();

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
        const storageKey = `hash_${encodeURIComponent(target.url)}`;
        const stored = await chrome.storage.local.get([
          storageKey,
          `chatFilename_${convId}`,
          `chatFolderName_${convId}`,
          `chatMsgCount_${convId}`,
        ]);

        const isGemChat = target.url.includes('/gem/');
        await navigateAndWait(tabId, target.url, isGemChat ? 4000 : 2500);

        // 重試時不信任舊的 msgCount，做完整 scroll
        await scrollToLoadAllMessages(tabId, 0);

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });

        // ── Stop check #5：content.js 執行完後立即確認（圖片下載可能耗時 10+ 秒）──
        { const { stopBackupRequested: s } = await chrome.storage.local.get('stopBackupRequested');
          if (s) { await handleStop(); return; } }

        const data = results?.[0]?.result;
        if (data?.aborted) {
          // content.js 自己偵測到 abort flag — 直接停止整個流程
          await handleStop();
          return;
        }
        if (!data?.content) {
          if (convEntry) { convEntry.status = 'failed'; convEntry.reason = '無法擷取內容'; }
        } else {
          const { content, hash, url, messages, images } = data;
          const realStorageKey = `hash_${encodeURIComponent(url || target.url)}`;

          const filenameTitle = target.title || data.title || '未命名對話';
          const safeTitle = filenameTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';

          const saveKeys = await saveConversationFiles(
            dirHandle, safeTitle, convId, content, images || [], stored
          );

          if (convEntry) convEntry.status = 'done';

          const currMsgCount = messages ? messages.length : 0;
          const now = new Date().toISOString();
          const storageUpdate = {
            [realStorageKey]: hash,
            [`chatMsgCount_${convId}`]: currMsgCount,
            [`chatSyncTime_${convId}`]: now,
          };
          if (saveKeys.filename) storageUpdate[`chatFilename_${convId}`] = saveKeys.filename;
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
    // 對所有 Gemini 分頁注入 abort flag — 長迴圈 (scrollToLoadAllMessages /
    // content.js 圖片下載) 每次輪詢都會檢查它，立即跳出
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
      for (const t of tabs || []) {
        chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: () => { window.__geminiBackupAborted = true; },
        }).catch(() => {});
      }
    });
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
    const storageKey = `hash_${encodeURIComponent(url)}`;

    chrome.storage.local.get(
      [storageKey, `chatSyncTime_${convId}`, `chatMsgCount_${convId}`, 'fullBackupState'],
      async (data) => {
        const isSynced = !!data[storageKey];
        const lastSyncTime = data[`chatSyncTime_${convId}`] || null;
        const storedMsgCount = data[`chatMsgCount_${convId}`] || 0;
        const fullState = data.fullBackupState;
        const isSyncing = !!(fullState?.inProgress && fullState?.currentUrl === url);

        let hasNewMessages = false;
        if (isSynced && !isSyncing && tabId && storedMsgCount > 0) {
          try {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId },
              func: countMessagesOnPage,
            });
            const currentCount = result?.result || 0;
            hasNewMessages = currentCount > storedMsgCount;
          } catch (_) {}
        }

        sendResponse({ isSynced, isSyncing, lastSyncTime, hasNewMessages });
      }
    );
    return true;
  }
});

// ── 輕量計數函式（注入頁面）────────────────────────────────────────────────────
// 使用與 content.js 相同的選擇器，快速計算當前頁面訊息總數
function countMessagesOnPage() {
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

  const userSelectors = [
    'user-query', '.user-query-content', '.query-content',
    '[data-message-author-role="user"]', '.human-turn',
  ];
  const modelSelectors = [
    'model-response', '.model-response-text',
    'response-container .response-content',
    '[data-message-author-role="model"]', '.ai-response',
  ];

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
