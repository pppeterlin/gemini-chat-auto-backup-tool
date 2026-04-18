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
      // Expand any collapsed responses first
      document.querySelectorAll(
        'button[aria-label="Expand"], button[aria-label="展開"]'
      ).forEach(b => { try { b.click(); } catch (_) {} });

      const wait = ms => new Promise(r => setTimeout(r, ms));

      function countTurns() {
        return Math.max(
          document.querySelectorAll('user-query').length,
          document.querySelectorAll('model-response').length,
          document.querySelectorAll('.query-content').length,
          document.querySelectorAll('.response-content').length,
        );
      }

      // ── Strategy A: Voyager timeline dots ───────────────────────────────────
      const getFirstDot = () => document.querySelector('.timeline-dot[data-marker-index="0"]')
                              || document.querySelector('.timeline-dot');

      if (getFirstDot()) {
        for (let attempt = 0; attempt < 30; attempt++) {
          // 已載入足夠數量，提前停止
          if (stopAtCount > 0 && countTurns() >= stopAtCount) break;

          const dot = getFirstDot();
          if (!dot) break;

          const prevCount = document.querySelectorAll('.timeline-dot').length;
          dot.click(); // Jump to earliest loaded turn → Gemini fetches older history

          // Wait up to 8 s for new dots to appear (new turns = new dots)
          let newDotsFound = false;
          for (let t = 0; t < 16; t++) {
            await wait(500);
            if (document.querySelectorAll('.timeline-dot').length > prevCount) {
              newDotsFound = true;
              break;
            }
          }

          if (!newDotsFound) break; // Dot count stable → full history loaded
        }

        // Click the LAST dot to restore view to the most recent message
        const dots = document.querySelectorAll('.timeline-dot');
        if (dots.length) dots[dots.length - 1].click();
        await wait(500);
        return;
      }

      // ── Strategy B: Manual scroll fallback ──────────────────────────────────
      const scrollEl = [
        document.querySelector('.cdk-virtual-scroll-viewport'),
        document.querySelector('main'),
        document.querySelector('[data-scroll-container]'),
        document.scrollingElement,
        document.documentElement,
      ].find(el => el && el.scrollHeight > el.clientHeight + 50) || document.documentElement;

      // 已載入足夠數量，跳過捲動
      if (stopAtCount > 0 && countTurns() >= stopAtCount) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
        return;
      }

      let prevTurnCount = countTurns();

      for (let attempt = 0; attempt < 30; attempt++) {
        scrollEl.scrollTop = 0;
        window.scrollTo(0, 0);

        let newContentFound = false;
        for (let t = 0; t < 16; t++) {
          await wait(500);
          const curr = countTurns();
          if (scrollEl.scrollTop > 0 || curr > prevTurnCount) {
            prevTurnCount = Math.max(prevTurnCount, curr);
            newContentFound = true;
            break;
          }
        }

        if (!newContentFound) break;

        // 已載入足夠數量，提前停止往前捲動
        if (stopAtCount > 0 && prevTurnCount >= stopAtCount) break;
      }

      // Restore to bottom
      scrollEl.scrollTop = scrollEl.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await wait(500);
    },
    args: [stopAtCount],
  });
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

// 依有無圖片選擇儲存格式：
//   有圖片（或已是資料夾格式）→ [safeTitle]_[convId]/ 資料夾 + media/ 子目錄
//   純文字               → 與原本相同的單一 .md 檔案
// 回傳 { filename? } 或 { folderName? }，用於更新 chrome.storage
async function saveConversationFiles(dirHandle, safeTitle, convId, content, images, stored) {
  const hasImages = images && images.length > 0;
  const existingFolder = stored[`chatFolderName_${convId}`];

  if (hasImages || existingFolder) {
    const folderName = existingFolder || `${safeTitle}_${convId}`;
    const folderHandle = await dirHandle.getDirectoryHandle(folderName, { create: true });

    const mdHandle = await folderHandle.getFileHandle(`${safeTitle}.md`, { create: true });
    const mdWritable = await mdHandle.createWritable();
    await mdWritable.write(content);
    await mdWritable.close();

    if (hasImages) {
      const mediaHandle = await folderHandle.getDirectoryHandle('media', { create: true });
      for (const img of images) {
        try { await saveImageFromDataUrl(mediaHandle, img.filename, img.dataUrl); } catch (_) {}
      }
    }

    return { folderName };
  }

  // 純文字：沿用原有單檔格式
  const filename = stored[`chatFilename_${convId}`] || `${safeTitle}_${convId}.md`;
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  return { filename };
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

  if (stored[storageKey] === hash) {
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

      // Find the sidebar scroll container (try several known selectors)
      function findSidebarEl() {
        const candidates = [
          document.querySelector('.conversations-list'),
          document.querySelector('mat-sidenav .conversations'),
          document.querySelector('[data-test-id="sidebar"] [cdkvirtualscrollviewport]'),
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

      let prevCount = document.querySelectorAll('a[href*="/app/"]').length;

      for (let attempt = 0; attempt < 30; attempt++) {
        sidebarEl.scrollTop = sidebarEl.scrollHeight;
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

        const data = results?.[0]?.result;
        if (!data?.content) {
          if (convEntry) { convEntry.status = 'failed'; convEntry.reason = '無法擷取內容'; }
        } else {
          const { content, hash, url, messages, images } = data;
          const realStorageKey = `hash_${encodeURIComponent(url || conv.url)}`;

          // hash 一致 → 內容確認沒有變化，跳過
          if (stored[storageKey] === hash) {
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

        const data = results?.[0]?.result;
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
