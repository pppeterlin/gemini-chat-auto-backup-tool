// popup.js - Popup UI 邏輯
// 負責資料夾選擇、設定儲存、手動備份觸發

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

// ── Initialise ─────────────────────────────────────────────────────────────────

async function init() {
  // 1. 讀取儲存的設定
  const { backupInterval, lastBackupTime } =
    await chrome.storage.local.get(['backupInterval', 'lastBackupTime']);

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
        // 有 handle 但需要重新授權
        setFolderUI(handle.name + '（需要重新授權）', false);
        document.getElementById('btn-reauth').style.display = 'inline-flex';
      }
    } else {
      setFolderUI('尚未選擇資料夾', false);
    }
  } catch (_) {
    setFolderUI('尚未選擇資料夾', false);
  }
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
        // 在 user-gesture context 中請求授權
        await handle.requestPermission({ mode: 'readwrite' });
      }
    }

    const result = await chrome.runtime.sendMessage({ action: 'manualBackup' });

    if (result?.success) {
      showStatus(result.message, 'success');
      if (result.errors?.length) {
        console.warn('[Backup] Partial errors:', result.errors);
      }
      // 更新上次備份時間
      const { lastBackupTime } = await chrome.storage.local.get('lastBackupTime');
      document.getElementById('last-backup-time').textContent =
        formatBackupTime(lastBackupTime);
    } else {
      showStatus(result?.error || '備份失敗，請重試', 'error');
    }
  } catch (err) {
    showStatus(`備份失敗：${err.message}`, 'error');
  } finally {
    setBackupBtnLoading(false);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

init();
