// popup.js - Popup UI 邏輯
// 負責資料夾選擇、設定儲存、手動備份觸發、全量備份、當前對話同步狀態、多語言

const DB_NAME = 'gemini-backup-db';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

// ── i18n 輔助函式 ─────────────────────────────────────────────────────────────

function i18nText(key) {
  return i18n.get(key);
}

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

function setFolderUI(name, isBound, showReauth = false) {
  const nameEl = document.getElementById('folder-name');
  const badge = document.getElementById('folder-badge');
  const reauthBtn = document.getElementById('btn-reauth');

  nameEl.textContent = name;
  nameEl.className = isBound ? 'bound' : '';

  if (isBound) {
    badge.textContent = i18nText('bound');
    badge.className = 'folder-badge';
    reauthBtn.style.display = showReauth ? 'inline-flex' : 'none';
  } else {
    badge.textContent = i18nText('notSet');
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
    const currentLang = i18n.getCurrentLanguage();
    return new Date(isoStr).toLocaleString(currentLang, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return isoStr;
  }
}

// ── 當前對話同步狀態 UI ────────────────────────────────────────────────────────

function setSyncStatus(status, lastSyncTime) {
  // status: 'never' | 'syncing' | 'synced' | 'has-new'
  const card = document.getElementById('current-chat-card');
  const badge = document.getElementById('sync-status-badge');
  const timeEl = document.getElementById('sync-status-time');

  card.style.display = '';

  badge.className = `sync-badge ${status}`;
  if (status === 'never') {
    badge.textContent = i18nText('neverBackup');
    timeEl.textContent = '';
  } else if (status === 'syncing') {
    badge.textContent = i18nText('backing');
    timeEl.textContent = '';
  } else if (status === 'has-new') {
    badge.textContent = i18nText('hasNew');
    timeEl.textContent = lastSyncTime ? `${i18nText('lastBackup')}${formatBackupTime(lastSyncTime)}` : '';
  } else {
    badge.textContent = i18nText('backed');
    timeEl.textContent = lastSyncTime ? `${i18nText('lastBackup')}${formatBackupTime(lastSyncTime)}` : '';
  }
}

// ── 全量備份進度 UI ────────────────────────────────────────────────────────────

function renderFailedList(failed, pending) {
  const container = document.getElementById('failed-list');
  const total = (failed?.length ?? 0) + (pending?.length ?? 0);
  if (!total) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  const failedItems = (failed || []).map(c => {
    const reason = c.reason ? `<span class="fail-reason"> — ${c.reason}</span>` : '';
    return `<li>${c.title || c.url || i18nText('unknownChat')}${reason}</li>`;
  }).join('');
  const pendingItems = (pending || []).map(c =>
    `<li>${c.title || c.url || i18nText('unknownChat')}<span class="fail-reason"> — ${i18nText('notProcessed')}</span></li>`
  ).join('');
  container.innerHTML = `<details><summary>${i18nText('failedList').replace('{n}', total)}</summary><ul>${failedItems}${pendingItems}</ul></details>`;
  container.style.display = 'block';
}

function updateFullBackupUI(state) {
  const btn = document.getElementById('btn-full-backup');
  const stopBtn = document.getElementById('btn-stop-backup');
  const retryBtn = document.getElementById('btn-retry-failed');
  const progressDiv = document.getElementById('full-backup-progress');
  const progressText = document.getElementById('progress-text');
  const progressCurrent = document.getElementById('progress-current');
  const progressBar = document.getElementById('progress-bar');

  // 回到「可開始」狀態：隱藏停止按鈕、恢復備份按鈕
  function resetToIdle() {
    btn.disabled = false;
    updateFullBackupBtnText();
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;
    stopBtn.textContent = `⏹ ${i18nText('stopBackup')}`;
    retryBtn.style.display = 'none';
  }

  if (!state || (!state.inProgress && !state.completedAt && !state.fatalError && !state.stoppedByUser)) {
    // Never run
    resetToIdle();
    progressDiv.style.display = 'none';
    return;
  }

  if (state.fatalError) {
    resetToIdle();
    progressDiv.style.display = 'block';
    // 特殊錯誤碼對應 i18n 文字，其餘顯示原始訊息
    const knownErrors = ['browserRestart', 'stuckReset'];
    const errMsg = knownErrors.includes(state.fatalError)
      ? i18nText(state.fatalError)
      : `${i18nText('error')}：${state.fatalError}`;
    progressText.textContent = errMsg;
    progressText.style.color = '#c5221f';
    progressCurrent.textContent = '';
    progressBar.style.width = '0%';
    renderFailedList([], []);
    return;
  }

  if (state.inProgress) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${state.isRetrying ? i18nText('retryingFailed') : i18nText('backingUp')}`;
    stopBtn.style.display = '';
    retryBtn.style.display = 'none';
    progressDiv.style.display = 'block';
    progressText.style.color = '#5f6368';
    renderFailedList([], []);

    if (state.total === 0) {
      progressText.textContent = i18nText('scanning');
      progressBar.style.width = '0%';
    } else {
      const pct = Math.round((state.done / state.total) * 100);
      const skippedNote = state.skipped > 0 ? `（${i18nText('skipped')}${state.skipped}${i18nText('dialogCount')}）` : '';
      // 若有限制數量且偵測到 Pinned，顯示 Pinned 計數備註
      const pinnedNote = (state.pinnedCount > 0 && state.selectedLimit > 0)
        ? `，${i18nText('pinnedNote').replace('{n}', state.pinnedCount)}`
        : '';
      progressText.textContent = `${state.done} / ${state.total} ${i18nText('done')} ${skippedNote}${pinnedNote}`;
      progressBar.style.width = `${pct}%`;
    }

    progressCurrent.textContent = state.currentTitle ? `${i18nText('processing')}「${state.currentTitle}」` : '';
    return;
  }

  // 從 conversations 派生 failed / pending 清單
  const failedConvs  = (state.conversations || []).filter(c => c.status === 'failed');
  const pendingConvs = (state.conversations || []).filter(c => c.status === 'pending');
  const hasRetryTargets = failedConvs.length > 0 || pendingConvs.length > 0;

  // 使用者手動停止
  if (state.stoppedByUser) {
    resetToIdle();
    progressDiv.style.display = 'block';
    progressText.style.color = '#5f6368';
    progressText.textContent = `${i18nText('stoppedByUser')}（${i18nText('done')} ${state.done} ${i18nText('dialogCount')}）`;
    progressCurrent.textContent = state.completedAt
      ? `${i18nText('completedTime')}${formatBackupTime(state.completedAt)}`
      : '';
    progressBar.style.width = state.total > 0
      ? `${Math.round((state.done / state.total) * 100)}%`
      : '0%';
    renderFailedList(failedConvs, pendingConvs);
    if (hasRetryTargets) retryBtn.style.display = '';
    return;
  }

  // 正常完成
  resetToIdle();
  progressDiv.style.display = 'block';
  progressText.style.color = failedConvs.length ? '#b06000' : '#188038';

  // excluded = 超出 N 個 limit 的對話（全量備份時為 0）
  const excludedNote = state.excluded > 0
    ? `，${i18nText('excluded')} ${state.excluded} ${i18nText('excludedSuffix')}`
    : '';

  if (state.total === 0 && state.skipped > 0) {
    progressText.textContent = `${i18nText('allDone')} ${state.skipped} ${i18nText('dialogCount')} ${i18nText('noNeedBackup')}${excludedNote}`;
  } else {
    const errNote = failedConvs.length ? `，${failedConvs.length} ${i18nText('failures')}` : '';
    const skippedNote = state.skipped > 0 ? `，${i18nText('skipped')} ${state.skipped} ${i18nText('dialogCount')}` : '';
    const pinnedNote = (state.pinnedCount > 0 && state.selectedLimit > 0)
      ? `（${i18nText('pinnedNote').replace('{n}', state.pinnedCount)}）`
      : '';
    progressText.textContent = `${i18nText('completed')} ${state.done} ${i18nText('dialogCount')}${pinnedNote}${skippedNote}${excludedNote}${errNote}`;
  }
  progressCurrent.textContent = state.completedAt
    ? `${i18nText('completedTime')}${formatBackupTime(state.completedAt)}`
    : '';
  progressBar.style.width = state.total > 0 ? '100%' : '0%';
  renderFailedList(failedConvs, []);
  if (hasRetryTargets) retryBtn.style.display = '';
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
      tabId: tab.id,
    });

    if (result.isSyncing) {
      setSyncStatus('syncing', null);
    } else if (result.isSynced && result.hasNewMessages) {
      setSyncStatus('has-new', result.lastSyncTime);
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
  // 0. 初始化多語言
  await i18n.init();
  initLanguageSelector();
  updateUIText();

  // 1. 讀取儲存的設定
  const { backupInterval, lastBackupTime, fullBackupState, folderName } =
    await chrome.storage.local.get(['backupInterval', 'lastBackupTime', 'fullBackupState', 'folderName']);

  // 設定頻率下拉選單
  const select = document.getElementById('interval-select');
  if (backupInterval !== undefined) {
    select.value = String(backupInterval);
  }

  // 還原全量備份範圍設定
  const { fullBackupLimit } = await chrome.storage.local.get('fullBackupLimit');
  const limitSelectEl = document.getElementById('full-backup-limit');
  if (fullBackupLimit !== undefined) {
    limitSelectEl.value = String(fullBackupLimit);
  }
  limitSelectEl.addEventListener('change', updateFullBackupBtnText);

  // 上次備份時間
  document.getElementById('last-backup-time').textContent =
    formatBackupTime(lastBackupTime);

  // 2. 顯示資料夾名稱
  //    Chrome 的 File System Access API permission 在每次 popup 重開後可能被重設，
  //    在 init() 裡呼叫 requestPermission() 不可靠（async 操作消耗 user activation）。
  //    改為：用 chrome.storage 快速顯示已儲存的資料夾名稱，
  //    實際 permission 在使用者點擊備份按鈕時（有 user gesture）再處理。
  try {
    const storedName = folderName || null;
    if (storedName) {
      setFolderUI(storedName, true);
    } else {
      const handle = await getHandleFromDB();
      if (handle) {
        setFolderUI(handle.name, true);
        await chrome.storage.local.set({ folderName: handle.name });
      } else {
        setFolderUI(i18nText('folderNotSelected'), false);
      }
    }
  } catch (_) {
    setFolderUI('尚未選擇資料夾', false);
  }

  // 3. 全量備份進度（含 stale state 偵測）
  // Service worker 被 Chrome 殺掉後 inProgress 會卡住；3 分鐘沒有心跳視為異常，自動重置。
  let resolvedState = fullBackupState;
  if (fullBackupState?.inProgress && fullBackupState?.lastUpdated) {
    const ageMs = Date.now() - new Date(fullBackupState.lastUpdated).getTime();
    if (ageMs > 3 * 60 * 1000) {
      resolvedState = { ...fullBackupState, inProgress: false, fatalError: 'stuckReset' };
      await chrome.storage.local.set({ fullBackupState: resolvedState });
      await chrome.storage.local.remove('stopBackupRequested');
    }
  }
  updateFullBackupUI(resolvedState);

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

// ── 語言選擇器初始化 ──────────────────────────────────────────────────────────

function initLanguageSelector() {
  const dropdown = document.getElementById('lang-dropdown');
  const toggle = document.getElementById('lang-toggle');

  // 填充語言選項
  const langs = i18n.getLanguageList();
  langs.forEach(lang => {
    const option = document.createElement('div');
    option.className = `lang-option ${lang.code === i18n.getCurrentLanguage() ? 'active' : ''}`;
    option.textContent = lang.name;
    option.dataset.lang = lang.code;
    option.addEventListener('click', () => {
      selectLanguage(lang.code);
    });
    dropdown.appendChild(option);
  });

  // 切換下拉菜單
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('show');
  });

  // 點擊外部關閉
  document.addEventListener('click', () => {
    dropdown.classList.remove('show');
  });
}

async function selectLanguage(lang) {
  i18n.setLanguage(lang);
  updateUIText();

  // 重新生成備份狀態文本（如果有進行中或完成的備份）
  const { fullBackupState } = await chrome.storage.local.get('fullBackupState');
  if (fullBackupState) {
    updateFullBackupUI(fullBackupState);
  }

  // 更新 folder UI 文本
  const { folderName } = await chrome.storage.local.get('folderName');
  if (folderName) {
    setFolderUI(folderName, true);
  } else {
    setFolderUI(i18nText('folderNotSelected'), false);
  }

  // 更新當前對話同步狀態文本
  await refreshCurrentChatStatus();

  // 更新 active 狀態
  document.querySelectorAll('.lang-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.lang === lang);
  });

  // 關閉下拉菜單
  document.getElementById('lang-dropdown').classList.remove('show');
}

// 根據目前選取的備份範圍，更新「同步」按鈕文字
function updateFullBackupBtnText() {
  const btn = document.getElementById('btn-full-backup');
  if (btn.disabled) return; // 備份進行中，不覆蓋 loading 文字
  const limitCount = Number(document.getElementById('full-backup-limit').value) || 0;
  if (limitCount === 0) {
    btn.innerHTML = `🔄 ${i18nText('syncAll')}`;
  } else {
    btn.innerHTML = `🔄 ${i18nText('syncLatestPrefix')} ${limitCount} ${i18nText('dialogCount')}`;
  }
}

// 更新所有 UI 文本
function updateUIText() {
  // Header & labels
  document.querySelector('.header h1').textContent = i18nText('appName');
  document.querySelector('.header p').textContent = i18nText('appDesc');

  // Folder card
  document.querySelectorAll('.card-label')[0].textContent = i18nText('backupFolder');
  document.getElementById('btn-select-folder').textContent = `📁 ${i18nText('selectFolder')}`;
  document.getElementById('btn-reauth').textContent = `🔐 ${i18nText('reauth')}`;

  // Backup frequency card
  document.querySelectorAll('.card-label')[1].textContent = i18nText('backupFreq');
  document.querySelector('.select-row label').textContent = i18nText('autoBackup');

  const select = document.getElementById('interval-select');
  select.querySelector('option[value="0"]').textContent = i18nText('off');
  select.querySelector('option[value="1"]').textContent = i18nText('every1h');
  select.querySelector('option[value="4"]').textContent = i18nText('every4h');
  select.querySelector('option[value="8"]').textContent = i18nText('every8h');
  select.querySelector('option[value="24"]').textContent = i18nText('every24h');

  // Current chat status
  document.querySelectorAll('.card-label')[2].textContent = i18nText('currentStatus');

  // Buttons
  document.getElementById('btn-backup').textContent = `▶ ${i18nText('backupNow')}`;
  document.querySelectorAll('.card-label')[3].textContent = i18nText('fullBackup');

  // Full backup limit select
  document.querySelector('label[for="full-backup-limit"]').textContent = i18nText('backupLimit');
  const limitSelect = document.getElementById('full-backup-limit');
  limitSelect.querySelector('option[value="0"]').textContent = i18nText('limitAll');
  limitSelect.querySelector('option[value="5"]').textContent = i18nText('limitTop5');
  limitSelect.querySelector('option[value="10"]').textContent = i18nText('limitTop10');
  limitSelect.querySelector('option[value="20"]').textContent = i18nText('limitTop20');
  limitSelect.querySelector('option[value="30"]').textContent = i18nText('limitTop30');

  updateFullBackupBtnText();

  // Stop button (only update text if not currently stopping)
  const stopBtn = document.getElementById('btn-stop-backup');
  if (!stopBtn.disabled) {
    stopBtn.textContent = `⏹ ${i18nText('stopBackup')}`;
  }

  // Retry button
  document.getElementById('btn-retry-failed').textContent = `↻ ${i18nText('retryFailed')}`;

  // Last backup
  document.querySelector('.last-backup').innerHTML =
    `<span>⏰ ${i18nText('lastBackupTime')}</span><span id="last-backup-time">—</span>`;
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

  const limitCount = Number(document.getElementById('full-backup-limit').value) || 0;
  await chrome.storage.local.set({ fullBackupLimit: limitCount });
  await chrome.runtime.sendMessage({ action: 'startFullBackup', limitCount });
});

// ── Event: 重試失敗項目 ────────────────────────────────────────────────────────

document.getElementById('btn-retry-failed').addEventListener('click', async () => {
  clearStatus();

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

  await chrome.runtime.sendMessage({ action: 'retryFailedBackup' });
});

// ── Event: 停止全量備份 ────────────────────────────────────────────────────────

document.getElementById('btn-stop-backup').addEventListener('click', async () => {
  const stopBtn = document.getElementById('btn-stop-backup');
  stopBtn.disabled = true;
  stopBtn.textContent = i18nText('stopping');
  try {
    await chrome.runtime.sendMessage({ action: 'stopFullBackup' });
  } catch (_) {
    // Service worker 可能已不在執行；直接強制重置 storage
    const { fullBackupState } = await chrome.storage.local.get('fullBackupState');
    if (fullBackupState?.inProgress) {
      const resetState = { ...fullBackupState, inProgress: false, fatalError: 'stuckReset' };
      await chrome.storage.local.set({ fullBackupState: resetState });
      await chrome.storage.local.remove('stopBackupRequested');
      updateFullBackupUI(resetState);
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

init();
