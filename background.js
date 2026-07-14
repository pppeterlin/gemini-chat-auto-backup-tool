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
//   1. 將最上方的使用者訊息捲入視野 + 容器捲到頂端，觸發 infinite scroller 載入
//   2. 用 MutationObserver 指紋（訊息數 + 最上方訊息文字）偵測是否有新內容
//   3. 捲動沒反應時，模擬點擊最上方的使用者訊息（Voyager 1.5+ 驗證過的手法，
//      會促使 Gemini 載入更早的歷史）
//   4. 連續無新內容 → 歷史已完整載入
//
// stopAtCount: 0 = 載入全部歷史（預設）
//              > 0 = 當 DOM 訊息數 >= stopAtCount 時提前停止
async function scrollToLoadAllMessages(tabId, stopAtCount = 0) {
  const run = () => chrome.scripting.executeScript({
    target: { tabId },
    func: async (stopAtCount, userSelectors, modelSelectors) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));

      // Expand any collapsed responses first
      // v2: button uses data-test-id="luminous-expand-button"; older UI used aria-label
      document.querySelectorAll(
        '[data-test-id="luminous-expand-button"], button[aria-label="Expand"], button[aria-label="展開"]'
      ).forEach(b => { try { b.click(); } catch (_) {} });

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

      function getScrollEl() {
        // v2 (2026 redesign, 實測): #chat-history.chat-history-scroll-container 是外層
        // scroller；infinite-scroller[data-test-id="chat-history-container"] 在其內
        return [
          document.querySelector('#chat-history'),
          document.querySelector('.chat-history-scroll-container'),
          document.querySelector('infinite-scroller[data-test-id="chat-history-container"]'),
          document.querySelector('infinite-scroller.chat-history'),
          document.querySelector('infinite-scroller'),
          document.querySelector('.chat-history'),
          document.querySelector('.cdk-virtual-scroll-viewport'),
          document.querySelector('main'),
          document.querySelector('[data-scroll-container]'),
          document.scrollingElement,
          document.documentElement,
        ].find(el => el && el.scrollHeight > el.clientHeight + 50) || document.documentElement;
      }

      // 內容指紋：訊息數 + 最上方使用者訊息的文字片段。
      // 新歷史載入時兩者至少會變其一（單看數量在虛擬化 DOM 下不可靠）。
      function fingerprint() {
        const top = getTopUserEl();
        const sample = top ? (top.textContent || '').slice(0, 200) : '';
        return `${countTurns()}|${sample}`;
      }

      // MutationObserver + 輪詢等待內容變化，比固定 sleep 更快也更可靠
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
          const check = () => { if (fingerprint() !== before) finish(true); };
          try {
            obs = new MutationObserver(check);
            obs.observe(document.body, { childList: true, subtree: true });
          } catch (_) {}
          poll = setInterval(check, 300);
          tm = setTimeout(() => finish(false), timeoutMs);
        });
      }

      // 已載入足夠數量 → 直接回到底部
      if (stopAtCount > 0 && countTurns() >= stopAtCount) {
        const el = getScrollEl();
        el.scrollTop = el.scrollHeight;
        return;
      }

      let clickTried = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const before = fingerprint();
        const scrollEl = getScrollEl();
        const topUser = getTopUserEl();

        // 捲到最頂端，觸發載入更早的歷史
        try { topUser?.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
        scrollEl.scrollTop = 0;
        window.scrollTo(0, 0);

        const changed = await waitForChange(before, 6000);
        if (changed) {
          clickTried = false;
          if (stopAtCount > 0 && countTurns() >= stopAtCount) break;
          await wait(250);
          continue;
        }

        // 捲動沒有觸發載入：點擊最上方的使用者訊息一次（Voyager 1.5+ 的手法）
        if (!clickTried && topUser) {
          clickTried = true;
          try {
            const opts = { bubbles: true, cancelable: true, view: window };
            topUser.dispatchEvent(new MouseEvent('mousedown', opts));
            topUser.dispatchEvent(new MouseEvent('mouseup', opts));
            topUser.click();
          } catch (_) {}
          const clickChanged = await waitForChange(fingerprint(), 6000);
          if (clickChanged) continue;
        }

        break; // 兩種策略都沒有新內容 → 歷史已完整載入
      }

      // Restore to bottom
      const el = getScrollEl();
      el.scrollTop = el.scrollHeight;
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
function navigateAndWait(tabId, url, extraWaitMs = 2500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('頁面載入逾時（30 秒）'));
    }, 30000);

    let hasStartedLoading = false;

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') hasStartedLoading = true;
      if (hasStartedLoading && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Extra wait for dynamic content to render (±30% jitter to look more human)
        setTimeout(resolve, extraWaitMs * (0.7 + Math.random() * 0.6));
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
}

// 導航失敗（逾時等）自動重試一次，第二次失敗才往外拋
async function navigateAndWaitRetry(tabId, url, extraWaitMs = 2500) {
  try {
    await navigateAndWait(tabId, url, extraWaitMs);
  } catch (_) {
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
  ]);
  const prevMsgCount = preStored[`chatMsgCount_${convId}`] || 0;

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
// Gemini's sidebar uses CDK virtual scroll — older conversations are only in the
// DOM once you scroll down far enough.  We scroll the sidebar container to the
// bottom, wait for new links, and repeat until the count stabilises.

async function scrollSidebarToLoadAll(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));

      // Find the sidebar scroll container (try several known selectors)
      function findSidebarEl() {
        const candidates = [
          // v2 (2026 redesign)
          document.querySelector('conversations-list[data-test-id="all-conversations"]'),
          document.querySelector('[data-test-id="bard-sidenav-container"] infinite-scroller'),
          document.querySelector('[data-test-id="bard-sidenav-container"]'),
          // legacy
          document.querySelector('.conversations-list'),
          document.querySelector('mat-sidenav .conversations'),
          document.querySelector('[data-test-id="sidebar"] [cdkvirtualscrollviewport]'),
          document.querySelector('[data-test-id="all-conversations"]'),
          document.querySelector('[data-test-id="overflow-container"]'),
          document.querySelector('infinite-scroller'),
          document.querySelector('.conversation-list'),
          document.querySelector('nav'),
          // Broadest fallback: leftmost tall scrollable element
          ...Array.from(document.querySelectorAll('*')).filter(el => {
            const r = el.getBoundingClientRect();
            return r.left < 300 && r.height > 400 && el.scrollHeight > el.clientHeight + 100;
          }),
        ].filter(Boolean);
        return candidates[0] || null;
      }

      const sidebarEl = findSidebarEl();
      if (!sidebarEl) return; // Can't find sidebar — give up gracefully

      function countConversationItems() {
        return Math.max(
          document.querySelectorAll('a[href*="/app/"]').length,
          document.querySelectorAll('[data-test-id="conversation"]').length,
        );
      }

      let prevCount = countConversationItems();

      for (let attempt = 0; attempt < 30; attempt++) {
        sidebarEl.scrollTop = sidebarEl.scrollHeight;
        await wait(1200);

        const newCount = countConversationItems();
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

// limitCount: 0 = 全部；> 0 = 僅備份非 Pinned 的前 N 個（Pinned 永遠全備份）
async function performFullHistoryBackup(limitCount = 0) {
  // Prevent duplicate runs
  const { fullBackupState: running } = await chrome.storage.local.get('fullBackupState');
  if (running?.inProgress) return;

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

        // 先取出已儲存的 hash 和 msg count（不需要等 navigation）
        const stored = await chrome.storage.local.get([
          `chatHash_${convId}`,
          `chatFolderName_${convId}`,
          `chatMsgCount_${convId}`,
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

        if (hasPrevBackup && alreadyFolder) {
          try {
            const [countResult] = await chrome.scripting.executeScript({
              target: { tabId },
              func: countMessagesOnPage,
              args: [USER_TURN_SELECTORS, MODEL_TURN_SELECTORS],
            });
            const quickCount = countResult?.result || 0;
            if (quickCount > 0 && quickCount <= prevMsgCount) {
              // 沒有新訊息 → 完全跳過捲動與擷取（真正的快速略過）
              if (convEntry) convEntry.status = 'skipped';
              state.skipped++;
              state.done++;
              await saveState();
              await randomDelay(800, 1600);
              continue;
            }
          } catch (_) {} // 計數失敗就照常走完整流程
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
      [`chatHash_${convId}`, `chatSyncTime_${convId}`, `chatMsgCount_${convId}`, 'fullBackupState'],
      async (data) => {
        // chatSyncTime 兼容舊版：升級後 chatHash 尚未寫入前，舊備份仍視為已同步
        const isSynced = !!(data[`chatHash_${convId}`] || data[`chatSyncTime_${convId}`]);
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
              args: [USER_TURN_SELECTORS, MODEL_TURN_SELECTORS],
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
