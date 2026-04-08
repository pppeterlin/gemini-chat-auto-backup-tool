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
async function scrollToLoadAllMessages(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      // Expand any collapsed responses first
      document.querySelectorAll(
        'button[aria-label="Expand"], button[aria-label="展開"]'
      ).forEach(b => { try { b.click(); } catch (_) {} });

      const wait = ms => new Promise(r => setTimeout(r, ms));

      // ── Strategy A: Voyager timeline dots ───────────────────────────────────
      const getFirstDot = () => document.querySelector('.timeline-dot[data-marker-index="0"]')
                              || document.querySelector('.timeline-dot');

      if (getFirstDot()) {
        for (let attempt = 0; attempt < 30; attempt++) {
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

      function countTurns() {
        return Math.max(
          document.querySelectorAll('user-query').length,
          document.querySelectorAll('model-response').length,
          document.querySelectorAll('.query-content').length,
          document.querySelectorAll('.response-content').length,
        );
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
      }

      // Restore to bottom
      scrollEl.scrollTop = scrollEl.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await wait(500);
    },
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
        // Extra wait for dynamic content to render
        setTimeout(resolve, extraWaitMs);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
}

// ── Single-conversation backup ─────────────────────────────────────────────────

async function backupSingleTab(tab, dirHandle) {
  // Scroll to top first so lazy-loaded older messages are in the DOM
  await scrollToLoadAllMessages(tab.id);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });

  const data = results?.[0]?.result;
  if (!data || !data.content) {
    return { skipped: true, reason: '無法擷取對話內容（頁面可能不是對話頁）' };
  }

  const { title, content, hash, url, messages } = data;
  const convId = stableConvId(url);          // always a non-null stable string
  const storageKey = `hash_${encodeURIComponent(url)}`;
  const stored = await chrome.storage.local.get([
    storageKey,
    `chatFilename_${convId}`,
    `chatMsgCount_${convId}`,
  ]);

  if (stored[storageKey] === hash) {
    return { skipped: true, reason: '無新內容' };
  }

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';
  // One stable file per conversation — never timestamped
  const filename = stored[`chatFilename_${convId}`] || `${safeTitle}_${convId}.md`;

  const prevMsgCount = stored[`chatMsgCount_${convId}`] || 0;
  const currMsgCount = messages ? messages.length : 0;
  const now = new Date().toISOString();

  // Safety guard: if we loaded fewer messages than last time, scroll didn't complete.
  // Keep the more-complete existing backup instead of overwriting with partial data.
  if (prevMsgCount > 0 && currMsgCount < prevMsgCount) {
    return {
      skipped: true,
      reason: `捲動未完整載入（${currMsgCount} / ${prevMsgCount} 條訊息），保留現有備份`,
    };
  }

  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();

  await chrome.storage.local.set({
    [storageKey]: hash,
    [`chatFilename_${convId}`]: filename,
    [`chatMsgCount_${convId}`]: currMsgCount,
    [`chatSyncTime_${convId}`]: now,
  });

  return { saved: true, filename };
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

// ── Full history backup ────────────────────────────────────────────────────────

async function performFullHistoryBackup() {
  // Prevent duplicate runs
  const { fullBackupState: running } = await chrome.storage.local.get('fullBackupState');
  if (running?.inProgress) return;

  const state = {
    inProgress: true,
    total: 0,
    done: 0,
    skipped: 0,
    currentTitle: '',
    currentUrl: '',
    startedAt: new Date().toISOString(),
    errors: [],
    fatalError: null,
  };
  await chrome.storage.local.set({ fullBackupState: state });

  async function saveState() {
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

    // Identify which conversations have never been backed up
    const allKeys = conversations.map(c => `hash_${encodeURIComponent(c.url)}`);
    const existingHashes = await chrome.storage.local.get(allKeys);
    const toProcess = conversations.filter(c => !existingHashes[`hash_${encodeURIComponent(c.url)}`]);

    state.total = toProcess.length;
    state.skipped = conversations.length - toProcess.length;
    await saveState();

    if (toProcess.length === 0) {
      state.inProgress = false;
      state.completedAt = new Date().toISOString();
      await saveState();
      return;
    }

    for (const conv of toProcess) {
      state.currentTitle = conv.title;
      state.currentUrl = conv.url;
      await saveState();

      try {
        await navigateAndWait(tabId, conv.url, 2500);
        // Scroll to load all lazy-loaded messages after page settles
        await scrollToLoadAllMessages(tabId);

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });

        const data = results?.[0]?.result;
        if (!data?.content) {
          state.errors.push(`${conv.title}: 無法擷取內容`);
        } else {
          const { title, content, hash, url, messages } = data;
          const storageKey = `hash_${encodeURIComponent(url)}`;
          const convId = stableConvId(url || conv.url);
          const safeTitle = (title || conv.title).replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';
          const filename = `${safeTitle}_${convId}.md`; // always stable, never timestamped

          const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();

          const now = new Date().toISOString();
          await chrome.storage.local.set({
            [storageKey]: hash,
            [`chatFilename_${convId}`]: filename,
            [`chatMsgCount_${convId}`]: messages ? messages.length : 0,
            [`chatSyncTime_${convId}`]: now,
          });
        }
      } catch (err) {
        state.errors.push(`${conv.title}: ${err.message}`);
        console.error('[FullBackup] Conversation error:', err);
      }

      state.done++;
      await saveState();
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
    performFullHistoryBackup(); // fire-and-forget; progress tracked in storage
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'getChatSyncStatus') {
    const { url } = message;
    const convId = stableConvId(url);
    const storageKey = `hash_${encodeURIComponent(url)}`;

    chrome.storage.local.get([storageKey, `chatSyncTime_${convId}`, 'fullBackupState'], (data) => {
      const isSynced = !!data[storageKey];
      const lastSyncTime = data[`chatSyncTime_${convId}`] || null;
      const fullState = data.fullBackupState;
      const isSyncing = !!(fullState?.inProgress && fullState?.currentUrl === url);
      sendResponse({ isSynced, isSyncing, lastSyncTime });
    });
    return true;
  }
});

// Restore alarm on service worker restart
chrome.runtime.onStartup.addListener(async () => {
  const { backupInterval } = await chrome.storage.local.get('backupInterval');
  if (backupInterval) await setupAlarm(backupInterval);
});
