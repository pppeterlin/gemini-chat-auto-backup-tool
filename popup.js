// popup.js - Popup UI 邏輯
// 負責資料夾選擇、設定儲存、手動備份觸發、全量備份、當前對話同步狀態

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

async function saveHandleToDB(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(handle, 'directoryHandle');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getHandleFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get('directoryHandle');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function showStatus(msg, type = 'info') {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = type;
}

function clearStatus() {
  const el = document.getElementById('status-msg');
  el.className = '';
  el.textContent = '';
}

function setFolderUI(name, isBound) {
  const nameEl = document.getElementById('folder-name');
  const badge = document.getElementById('folder-badge');
  const reauthBtn = document.getElementById('btn-reauth');

  nameEl.textContent = name;
  nameEl.className = isBound ? 'bound' : '';

  if (isBound) {
    badge.textContent = '已綁定';
    badge.className = 'folder-badge';
    reauthBtn.style.display = 'inline-flex';
  } else {
    badge.textContent = '未設定';
    badge.className = 'folder-badge unset';
    reauthBtn.style.display = 'none';
  }
}

function setBackupBtnLoading(loading) {
  const btn = document.getElementById('btn-backup');
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 備份中…';
  } else {
    btn.disabled = false;
    btn.innerHTML = '&#9654; 立即備份';
  }
}

function formatBackupTime(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleString('zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return isoStr;
  }
}

// ── 當前對話同步狀態 UI ────────────────────────────────────────────────────────

function setSyncStatus(status, lastSyncTime) {
  // status: 'never' | 'syncing' | 'synced'
  const card = document.getElementById('current-chat-card');
  const badge = document.getElementById('sync-status-badge');
  const timeEl = document.getElementById('sync-status-time');

  card.style.display = '';

  badge.className = `sync-badge ${status}`;
  if (status === 'never') {
    badge.textContent = '未同步';
    timeEl.textContent = '';
  } else if (status === 'syncing') {
    badge.textContent = '同步中';
    timeEl.textContent = '';
  } else {
    badge.textContent = '已同步';
    timeEl.textContent = lastSyncTime ? `上次：${formatBackupTime(lastSyncTime)}` : '';
  }
}

// ── 全量備份進度 UI ────────────────────────────────────────────────────────────

function updateFullBackupUI(state) {
  const btn = document.getElementById('btn-full-backup');
  const progressDiv = document.getElementById('full-backup-progress');
  const progressText = document.getElementById('progress-text');
  const progressCurrent = document.getElementById('progress-current');
  const progressBar = document.getElementById('progress-bar');

  if (!state || (!state.inProgress && !state.completedAt && !state.fatalError)) {
    // Never run
    btn.disabled = false;
    btn.innerHTML = '&#128260; 同步所有歷史';
    progressDiv.style.display = 'none';
    return;
  }

  if (state.fatalError) {
    btn.disabled = false;
    btn.innerHTML = '&#128260; 同步所有歷史';
    progressDiv.style.display = 'block';
    progressText.textContent = `錯誤：${state.fatalError}`;
    progressText.style.color = '#c5221f';
    progressCurrent.textContent = '';
    progressBar.style.width = '0%';
    return;
  }

  if (state.inProgress) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 備份中…';
    progressDiv.style.display = 'block';
    progressText.style.color = '#5f6368';

    if (state.total === 0) {
      progressText.textContent = '正在掃描對話清單…';
      progressBar.style.width = '0%';
    } else {
      const pct = Math.round((state.done / state.total) * 100);
      const skippedNote = state.skipped > 0 ? `（略過已備份 ${state.skipped} 個）` : '';
      progressText.textContent = `${state.done} / ${state.total} 完成 ${skippedNote}`;
      progressBar.style.width = `${pct}%`;
    }

    progressCurrent.textContent = state.currentTitle ? `處理中：「${state.currentTitle}」` : '';
    return;
  }

  // Completed
  btn.disabled = false;
  btn.innerHTML = '&#128260; 同步所有歷史';
  progressDiv.style.display = 'block';
  progressText.style.color = '#188038';

  if (state.total === 0 && state.skipped > 0) {
    progressText.textContent = `全部 ${state.skipped} 個對話已是最新，無需備份`;
  } else {
    const errNote = state.errors?.length ? `，${state.errors.length} 個失敗` : '';
    const skippedNote = state.skipped > 0 ? `，略過 ${state.skipped} 個已備份` : '';
    progressText.textContent = `完成！備份 ${state.done} 個對話${skippedNote}${errNote}`;
  }
  progressCurrent.textContent = state.completedAt
    ? `完成時間：${formatBackupTime(state.completedAt)}`
    : '';
  progressBar.style.width = state.total > 0 ? '100%' : '0%';
}

// ── 查詢當前對話同步狀態 ──────────────────────────────────────────────────────

async function refreshCurrentChatStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('gemini.google.com/app/')) {
      document.getElementById('current-chat-card').style.display = 'none';
      return;
    }

    const result = await chrome.runtime.sendMessage({
      action: 'getChatSyncStatus',
      url: tab.url,
    });

    if (result.isSyncing) {
      setSyncStatus('syncing', null);
    } else if (result.isSynced) {
      setSyncStatus('synced', result.lastSyncTime);
    } else {
      setSyncStatus('never', null);
    }
  } catch (_) {
    document.getElementById('current-chat-card').style.display = 'none';
  }
}

// ── Initialise ─────────────────────────────────────────────────────────────────

async function init() {
  // 1. 讀取儲存的設定
  const { backupInterval, lastBackupTime, fullBackupState } =
    await chrome.storage.local.get(['backupInterval', 'lastBackupTime', 'fullBackupState']);

  // 設定頻率下拉選單
  const select = document.getElementById('interval-select');
  if (backupInterval !== undefined) {
    select.value = String(backupInterval);
  }

  // 上次備份時間
  document.getElementById('last-backup-time').textContent =
    formatBackupTime(lastBackupTime);

  // 2. 讀取已儲存的 FileSystemDirectoryHandle
  try {
    const handle = await getHandleFromDB();
    if (handle) {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        setFolderUI(handle.name, true);
      } else {
        setFolderUI(handle.name + '（需要重新授權）', false);
        document.getElementById('btn-reauth').style.display = 'inline-flex';
      }
    } else {
      setFolderUI('尚未選擇資料夾', false);
    }
  } catch (_) {
    setFolderUI('尚未選擇資料夾', false);
  }

  // 3. 全量備份進度
  updateFullBackupUI(fullBackupState);

  // 4. 當前對話同步狀態
  await refreshCurrentChatStatus();

  // 5. 監聽 storage 變更，即時更新進度和同步狀態
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.fullBackupState) {
      updateFullBackupUI(changes.fullBackupState.newValue);
    }
    // Re-check current chat status if relevant keys changed
    const syncKeys = Object.keys(changes).filter(
      k => k.startsWith('hash_') || k.startsWith('chatSyncTime_')
    );
    if (syncKeys.length) refreshCurrentChatStatus();
  });
}

// ── Event: 選擇資料夾 ──────────────────────────────────────────────────────────

document.getElementById('btn-select-folder').addEventListener('click', async () => {
  clearStatus();
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveHandleToDB(dirHandle);
    await chrome.storage.local.set({ folderName: dirHandle.name });
    setFolderUI(dirHandle.name, true);
    showStatus(`已選擇資料夾：${dirHandle.name}`, 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      showStatus(`選擇資料夾失敗：${err.message}`, 'error');
    }
  }
});

// ── Event: 重新授權 ────────────────────────────────────────────────────────────

document.getElementById('btn-reauth').addEventListener('click', async () => {
  clearStatus();
  try {
    const handle = await getHandleFromDB();
    if (!handle) {
      showStatus('找不到已儲存的資料夾，請重新選擇', 'error');
      return;
    }
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      setFolderUI(handle.name, true);
      showStatus('授權成功！', 'success');
    } else {
      showStatus('授權被拒絕，請再試一次', 'error');
    }
  } catch (err) {
    showStatus(`授權失敗：${err.message}`, 'error');
  }
});

// ── Event: 備份頻率變更 ────────────────────────────────────────────────────────

document.getElementById('interval-select').addEventListener('change', async (e) => {
  const intervalHours = Number(e.target.value);
  await chrome.storage.local.set({ backupInterval: intervalHours });
  await chrome.runtime.sendMessage({ action: 'updateAlarm', intervalHours });

  if (intervalHours === 0) {
    showStatus('已關閉自動備份', 'info');
  } else {
    showStatus(`已設定每 ${intervalHours} 小時自動備份`, 'success');
  }
  setTimeout(clearStatus, 2500);
});

// ── Event: 立即備份 ────────────────────────────────────────────────────────────

document.getElementById('btn-backup').addEventListener('click', async () => {
  clearStatus();
  setBackupBtnLoading(true);

  try {
    // 先確認資料夾授權（需要在 popup 的 user-gesture context 中執行）
    const handle = await getHandleFromDB();
    if (handle) {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'prompt') {
        await handle.requestPermission({ mode: 'readwrite' });
      }
    }

    const result = await chrome.runtime.sendMessage({ action: 'manualBackup' });

    if (result?.success) {
      showStatus(result.message, 'success');
      if (result.errors?.length) {
        console.warn('[Backup] Partial errors:', result.errors);
      }
      const { lastBackupTime } = await chrome.storage.local.get('lastBackupTime');
      document.getElementById('last-backup-time').textContent =
        formatBackupTime(lastBackupTime);
      // 更新當前對話同步狀態
      await refreshCurrentChatStatus();
    } else {
      showStatus(result?.error || '備份失敗，請重試', 'error');
    }
  } catch (err) {
    showStatus(`備份失敗：${err.message}`, 'error');
  } finally {
    setBackupBtnLoading(false);
  }
});

// ── Event: 同步所有歷史 ────────────────────────────────────────────────────────

document.getElementById('btn-full-backup').addEventListener('click', async () => {
  clearStatus();

  // 確認資料夾授權（user-gesture context）
  try {
    const handle = await getHandleFromDB();
    if (!handle) {
      showStatus('請先選擇備份資料夾', 'error');
      return;
    }
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'prompt') {
      await handle.requestPermission({ mode: 'readwrite' });
    }
    if (permission === 'denied') {
      showStatus('資料夾存取被拒絕，請重新授權', 'error');
      return;
    }
  } catch (err) {
    showStatus(`授權失敗：${err.message}`, 'error');
    return;
  }

  showStatus('已開始同步所有歷史，請勿關閉 Gemini 分頁', 'info');
  setTimeout(clearStatus, 4000);

  await chrome.runtime.sendMessage({ action: 'startFullBackup' });
});

// ── Start ──────────────────────────────────────────────────────────────────────

init();
