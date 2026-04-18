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
| **部分歷史備份** | 選擇「前 5 / 10 / 20 / 30 個」，僅備份最近 N 則對話（Pinned 對話永遠包含在內） |
| **自動排程備份** | 設定每 1 / 4 / 8 / 24 小時自動執行，無需手動操作 |

### 智慧偵測

- **未同步提示**：若當前對話自上次備份後新增了訊息，Popup 會顯示「有新訊息未同步」提醒
- **增量備份**：自動比對內容變更，相同內容不重複寫入，節省磁碟空間
- **訊息完整性保護**：若頁面捲動未完整載入，會保留訊息較多的現有備份，避免資料遺失
- **快速略過最佳化**：全量備份時先快速計算可見訊息數，若無新訊息則跳過耗時捲動，顯著提升備份速度
- **Pinned 對話自動識別**：部分備份模式下，Pinned 對話自動加入備份範圍，不受 N 個限制影響

### 輸出格式

- **Markdown 輸出**：保留標題、粗體、斜體、清單、程式碼塊、表格等格式
- **圖片導出**：含使用者上傳圖片的對話會自動輸出為資料夾格式，圖片以原始尺寸與原始檔名儲存於 `media/` 子目錄
  ```
  [對話標題]_[chatId]/
  ├── [對話標題].md
  └── media/
      ├── 51282.jpg
      └── photo.png
  ```
- **純文字對話**：無圖片時維持原有單一 `.md` 檔案，不影響現有備份
- **固定命名**：同一對話永遠對應同一個檔案或資料夾，重複備份直接覆寫

### 即時狀態

- Popup 顯示當前對話的同步狀態：**未同步 / 有新訊息未同步 / 同步中 / 已同步**，並顯示上次備份時間
- 全量備份時即時顯示進度（已完成 / 總數 / 略過 / 目前處理中的對話）

---

## 安裝方式

目前尚未上架 Chrome Web Store，請使用開發者模式手動載入：

**方法一：下載 ZIP（推薦）**

1. 前往 [Releases](https://github.com/pppeterlin/gemini-chat-auto-backup-tool/releases/latest)，下載最新版本的 `gemini-chat-backup-vX.X.X.zip`
2. 解壓縮到任一資料夾
3. 打開 Chrome，前往 `chrome://extensions/`
4. 開啟右上角「**開發人員模式**」
5. 點擊「**載入未封裝項目**」，選擇剛才解壓縮的資料夾
6. 點擊工具列的擴充套件圖示即可使用

**方法二：Clone 原始碼**

1. Clone 本專案：`git clone https://github.com/pppeterlin/gemini-chat-auto-backup-tool.git`
2. 打開 Chrome，前往 `chrome://extensions/`
3. 開啟右上角「**開發人員模式**」
4. 點擊「**載入未封裝項目**」，選擇專案資料夾
5. 點擊工具列的擴充套件圖示即可使用

---

## 使用方式

### 首次設定

1. 點擊擴充套件圖示開啟 Popup
2. 點「**選擇資料夾**」，選擇本地備份目的地並授權寫入
3. 設定**備份頻率**（或保持關閉，僅手動備份）

### 手動備份當前對話

開啟任一 Gemini 對話頁面，點「**立即備份**」即可。若同時開著多個 Gemini 分頁，會一次全部備份。

### 全量 / 部分歷史備份

在「歷史備份」區塊：

1. 從「備份範圍」下拉選單選擇要備份的數量（**全部** 或**前 5 / 10 / 20 / 30 個**）
2. 點「**同步所有歷史**」（按鈕文字會隨選擇動態變化）
3. 擴充套件會自動：
   - 掃描側邊欄對話清單（Pinned 對話永遠包含在備份範圍內）
   - 逐一開啟對話，智慧判斷是否有新訊息
   - 備份有更新的對話，跳過已是最新的對話
   - 在 Popup 即時顯示進度
4. 備份進行中可點「**停止備份**」隨時中止

> 備份期間請勿關閉 Gemini 分頁。

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
├── i18n.js               # 多語言系統
├── i18n/
│   └── messages.json     # 翻譯字串（10 種語言）
├── icon.svg              # 圖示向量原始檔
├── icon.png              # 套件圖示（128×128）
├── pack.sh               # 打包腳本（產生 zip）
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
- 備份期間請勿關閉 Gemini 分頁

---

## Changelog

### v2.1.0 — 2026-04-18

#### 新增功能
- **圖片導出**：自動擷取使用者上傳的圖片，以原始尺寸與原始檔名儲存於 `media/` 子目錄；含圖片的對話改為資料夾格式輸出，純文字對話維持原有 `.md` 單檔格式
- **全尺寸圖片**：自動點擊燈箱取得原始全尺寸檔案（而非縮圖），並從對話框標題取得原始檔名（如 `photo.jpg`）

#### 改善
- **文字清理**：備份內容自動移除 Gemini UI 注入的冗餘標籤（「你說了」、「Gemini 說了」），輸出更乾淨
- **圖片下載提速**：改為兩階段下載（循序點燈箱取 URL → 並行 fetch 所有圖片），多圖對話速度顯著提升；燈箱關閉改用輪詢取代固定等待，縮短單次延遲
- **全量備份反偵測**：換頁後加入 1.2–2.8 秒隨機延遲，每 10 個對話額外休息 3–6 秒；導航等待時間加入 ±30% jitter，避免高頻規律操作被 Google 偵測為自動化機器人

### v2.0.0 — 2026-04-18

#### UI 全面重設計
- **新視覺風格**：低飽和度 × 高對比色系（米白底、近黑字、珊瑚色品牌色），Header 去漸層改白底
- **卡片分區**：資料夾、備份頻率、歷史備份各自獨立卡片，功能邊界一目了然
- **CTA 金字塔**：「立即備份」為唯一主色按鈕，其餘降為 outline/ghost
- **全新貓咪 Icon**：加菲貓形象，圓臉 + 招牌圓眉 + 黑色眼睛；提供 SVG 向量原始檔

#### 修正
- 修正 `updateUIText()` 使用舊 selector 導致 `init()` 中途崩潰，連帶造成資料夾持久化失效、全量備份進度不顯示、語言切換無效

#### 其他
- 新增 `pack.sh` 打包腳本，Release 頁面提供 zip 下載

### v1.1.0 — 2026-04-16

#### 新增功能
- **部分歷史備份**：新增「備份範圍」選單，可選擇僅備份最近 5 / 10 / 20 / 30 個對話，不必每次全量掃描
- **Pinned 對話優先備份**：部分備份模式下，已釘選（Pinned）的對話自動納入備份範圍，不受 N 個限制影響
- **手動停止備份**：備份進行中可隨時點「停止備份」中止程序
- **異常狀態自動復原**：瀏覽器重啟或 Service Worker 中斷後，重開 Popup 會自動偵測並清除卡住的備份狀態

#### 效能改善
- **全量備份大幅提速**：對已備份過的對話，先快速計算可見訊息數量；若無新訊息則直接跳過耗時的全頁捲動，速度可提升數倍
- 修正：全量備份之前只備份「從未備份過」的對話，導致有新訊息的舊對話被遺漏

### v1.0.0 — 2026-04-08

- 初始發布
- 支援手動備份、全量歷史備份、自動排程備份
- 多語言介面（繁中 / 簡中 / 英 / 日 / 韓 / 法 / 西 / 葡 / 阿 / 俄）
- 增量備份、訊息完整性保護

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
| **Partial History Backup** | Choose "Latest 5 / 10 / 20 / 30" to back up only the most recent N conversations (Pinned chats are always included) |
| **Scheduled Auto-Backup** | Set an interval (1 / 4 / 8 / 24 hours) to run backups automatically in the background |

### Smart Detection

- **Unsynced message alert**: If new messages have been added to the current conversation since the last backup, the popup shows a "New messages not backed up" warning
- **Incremental backup**: Content is hashed on each run — unchanged conversations are skipped to save disk space
- **Message integrity guard**: If the page didn't fully scroll to load all messages, the existing backup with more messages is preserved
- **Fast-skip optimization**: During full history backup, the extension quickly counts visible messages before triggering a full scroll — if no new messages are detected, the expensive scroll is skipped entirely, making backups significantly faster
- **Pinned chat detection**: In partial backup mode, Pinned conversations are automatically included regardless of the N-chat limit

### Output

- **Markdown format**: Preserves headings, bold, italic, lists, code blocks, tables, and links
- **Image export**: Conversations with user-uploaded images are saved as a folder containing the markdown file and a `media/` subdirectory with full-size images at their original filenames
  ```
  [title]_[chatId]/
  ├── [title].md
  └── media/
      ├── photo.jpg
      └── screenshot.png
  ```
- **Text-only chats**: Saved as a single `.md` file as before — no change to existing backups
- **Stable naming**: The same conversation always maps to the same file or folder; repeated backups overwrite in place

### Live Status

- The popup shows the sync status of the active conversation: **Never backed up / New messages / Syncing / Up to date**, along with the last backup timestamp
- Full history backup shows real-time progress (completed / total / skipped / currently processing)

---

## Installation

Not yet published to the Chrome Web Store. Load manually via Developer Mode:

**Option A: Download ZIP (recommended)**

1. Go to [Releases](https://github.com/pppeterlin/gemini-chat-auto-backup-tool/releases/latest) and download the latest `gemini-chat-backup-vX.X.X.zip`
2. Unzip to any folder
3. Open Chrome and go to `chrome://extensions/`
4. Enable **Developer mode** (top-right toggle)
5. Click **"Load unpacked"** and select the unzipped folder
6. Click the extension icon in the toolbar to open the popup

**Option B: Clone the repository**

1. `git clone https://github.com/pppeterlin/gemini-chat-auto-backup-tool.git`
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **"Load unpacked"** and select the cloned folder
5. Click the extension icon in the toolbar to open the popup

---

## Usage

### Initial Setup

1. Click the extension icon to open the popup
2. Click **"Select Folder"** to choose a local backup destination and grant write access
3. Optionally set a **backup frequency** (or leave it off for manual-only backups)

### Manual Backup (Current Chat)

Open any Gemini conversation, then click **"Backup Now"**. If multiple Gemini tabs are open, all of them will be backed up in one go.

### Full / Partial History Backup

In the "History Backup" section:

1. Choose a **backup scope** from the dropdown (**All** or **Latest 5 / 10 / 20 / 30**)
2. Click the sync button (its label updates to match your selection)
3. The extension will automatically:
   - Scan the sidebar for conversation links (Pinned chats are always included)
   - Open each conversation and intelligently check for new messages
   - Back up updated conversations, skipping ones already up to date
   - Show real-time progress in the popup
4. Click **"Stop Backup"** at any time to cancel

> Do not close the Gemini tab while a backup is running.

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
├── i18n.js               # Internationalization system
├── i18n/
│   └── messages.json     # Translation strings (10 languages)
├── icon.svg              # Icon source (vector)
├── icon.png              # Extension icon (128×128)
├── pack.sh               # Packaging script (produces release zip)
├── dev/                  # Development utilities (not included in extension)
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
- Do not close the Gemini tab while a backup is running

---

## License

MIT License
