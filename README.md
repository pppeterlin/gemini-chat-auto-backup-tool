# Gemini Chat Auto Backup Tool

自動將 [Google Gemini](https://gemini.google.com) 的對話紀錄備份到本地資料夾，並儲存為 Markdown 格式的 Chrome 擴充套件。

> 📖 [English version below](#english)

---

## 功能

### 備份方式

| 方式 | 說明 |
|------|------|
| **手動備份** | 點「立即備份」，一次備份所有已開啟的 Gemini 分頁 |
| **單一對話備份** | 開啟任一對話頁面後點「立即備份」，即可備份該對話 |
| **全量歷史備份** | 點「同步所有歷史」，自動掃描側邊欄所有對話並逐一備份 |
| **自動排程備份** | 設定每 1 / 4 / 8 / 24 小時自動執行，無需手動操作 |

### 智慧偵測

- **未同步提示**：若當前對話自上次備份後新增了訊息，Popup 會顯示「有新訊息未同步」提醒
- **增量備份**：自動比對內容變更，相同內容不重複寫入，節省磁碟空間
- **訊息完整性保護**：若頁面捲動未完整載入，會保留訊息較多的現有備份，避免資料遺失

### 輸出格式

- **Markdown 輸出**：保留標題、粗體、斜體、清單、程式碼塊、表格等格式
- **固定檔名**：命名格式為 `[對話標題]_[chatId].md`，同一對話永遠對應同一個檔案，重複備份直接覆寫

### 即時狀態

- Popup 顯示當前對話的同步狀態：**未同步 / 有新訊息未同步 / 同步中 / 已同步**，並顯示上次備份時間
- 全量備份時即時顯示進度（已完成 / 總數 / 略過 / 目前處理中的對話）

---

## 安裝方式

目前尚未上架 Chrome Web Store，請使用開發者模式手動載入：

1. 下載或 Clone 本專案
2. 打開 Chrome，前往 `chrome://extensions/`
3. 開啟右上角「**開發人員模式**」
4. 點擊「**載入未封裝項目**」，選擇本專案資料夾
5. 點擊工具列的擴充套件圖示即可使用

---

## 使用方式

### 首次設定

1. 點擊擴充套件圖示開啟 Popup
2. 點「**選擇資料夾**」，選擇本地備份目的地並授權寫入
3. 設定**備份頻率**（或保持關閉，僅手動備份）

### 手動備份當前對話

開啟任一 Gemini 對話頁面，點「**立即備份**」即可。若同時開著多個 Gemini 分頁，會一次全部備份。

### 全量歷史備份

點「**同步所有歷史**」，擴充套件會自動：

1. 掃描側邊欄中的所有對話連結
2. 逐一開啟並捲動，觸發舊訊息載入
3. 備份完整對話內容，跳過已是最新的對話
4. 在 Popup 即時顯示進度

> 全量備份期間請勿關閉 Gemini 分頁。

### 自動備份

在 Popup 的「自動備份」下拉選單選擇頻率，擴充套件會在背景定期備份所有已開啟的 Gemini 分頁。

---

## 檔案結構

```
├── manifest.json         # Manifest V3 套件設定
├── background.js         # Service Worker（排程、備份邏輯）
├── content.js            # DOM 擷取腳本（注入 Gemini 分頁）
├── sidebar_scanner.js    # 側邊欄掃描腳本（全量備份用）
├── popup.html            # Popup UI
├── popup.js              # Popup 互動邏輯
├── icon.png              # 套件圖示
└── test/
    ├── test.html         # 瀏覽器互動測試頁
    └── run_tests.js      # 命令列測試腳本（需 JavaScriptCore）
```

---

## 執行測試

**命令列（macOS）：**
```bash
JSC=/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC test/run_tests.js
```

**瀏覽器：** 使用任意 HTTP 伺服器提供靜態檔案後，開啟 `test/test.html`，點擊「執行全部測試」。

---

## 已知限制

- Gemini 的 DOM 結構不定期更新，若備份失敗請回報 Issue
- File System Access API 的資料夾授權在瀏覽器重啟後可能需要重新點擊備份按鈕以觸發重新授權
- 全量備份期間請勿關閉 Gemini 分頁

---

## 授權

MIT License

---

<a name="english"></a>

# Gemini Chat Auto Backup Tool — English

A Chrome extension that automatically backs up your [Google Gemini](https://gemini.google.com) conversations to a local folder as Markdown files.

---

## Features

### Backup Modes

| Mode | Description |
|------|-------------|
| **Manual Backup** | Click "Backup Now" to back up all currently open Gemini tabs at once |
| **Single Chat Backup** | Open any conversation and click "Backup Now" to back up that chat |
| **Full History Backup** | Click "Sync All History" to scan the sidebar and back up every conversation automatically |
| **Scheduled Auto-Backup** | Set an interval (1 / 4 / 8 / 24 hours) to run backups automatically in the background |

### Smart Detection

- **Unsynced message alert**: If new messages have been added to the current conversation since the last backup, the popup shows a "New messages not backed up" warning
- **Incremental backup**: Content is hashed on each run — unchanged conversations are skipped to save disk space
- **Message integrity guard**: If the page didn't fully scroll to load all messages, the existing backup with more messages is preserved

### Output

- **Markdown format**: Preserves headings, bold, italic, lists, code blocks, tables, and links
- **Stable filenames**: Format is `[title]_[chatId].md` — the same conversation always maps to the same file; repeated backups overwrite in place

### Live Status

- The popup shows the sync status of the active conversation: **Never backed up / New messages / Syncing / Up to date**, along with the last backup timestamp
- Full history backup shows real-time progress (completed / total / skipped / currently processing)

---

## Installation

Not yet published to the Chrome Web Store. Load manually via Developer Mode:

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **"Load unpacked"** and select the project folder
5. Click the extension icon in the toolbar to open the popup

---

## Usage

### Initial Setup

1. Click the extension icon to open the popup
2. Click **"Select Folder"** to choose a local backup destination and grant write access
3. Optionally set a **backup frequency** (or leave it off for manual-only backups)

### Manual Backup (Current Chat)

Open any Gemini conversation, then click **"Backup Now"**. If multiple Gemini tabs are open, all of them will be backed up in one go.

### Full History Backup

Click **"Sync All History"**. The extension will automatically:

1. Scan the sidebar for all conversation links
2. Open each one and scroll to trigger full message loading
3. Back up each conversation, skipping ones that are already up to date
4. Show real-time progress in the popup

> Do not close the Gemini tab while a full history backup is running.

### Auto-Backup

Select an interval from the "Auto-backup" dropdown in the popup. The extension will periodically back up all open Gemini tabs in the background.

---

## File Structure

```
├── manifest.json         # Manifest V3 extension config
├── background.js         # Service Worker (scheduling, backup logic)
├── content.js            # DOM scraper (injected into Gemini tabs)
├── sidebar_scanner.js    # Sidebar scanner (used for full history backup)
├── popup.html            # Popup UI
├── popup.js              # Popup interaction logic
├── icon.png              # Extension icon
└── test/
    ├── test.html         # Browser-based interactive test page
    └── run_tests.js      # CLI test runner (requires JavaScriptCore)
```

---

## Running Tests

**CLI (macOS):**
```bash
JSC=/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC test/run_tests.js
```

**Browser:** Serve the files with any static HTTP server and open `test/test.html`, then click "Run All Tests".

---

## Known Limitations

- Gemini's DOM structure changes periodically — if backups fail, please open an Issue
- The folder write permission granted via File System Access API may need to be re-confirmed after a browser restart (just click "Backup Now" again to trigger re-authorization)
- Do not close the Gemini tab during a full history backup

---

## License

MIT License
