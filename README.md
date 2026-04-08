# Gemini Chat Auto Backup Tool

自動將 [Google Gemini](https://gemini.google.com) 的對話紀錄備份到本地資料夾，並儲存為 Markdown 格式的 Chrome 擴充套件。

---

## 功能

- **本地資料夾備份**：透過 File System Access API 將對話存到你選擇的資料夾
- **排程自動備份**：每 1 小時、4 小時、8 小時或每天自動執行
- **手動立即備份**：一鍵備份當前所有已開啟的 Gemini 分頁
- **全量歷史備份**：自動掃描側邊欄中所有對話，逐一備份，並即時顯示進度
- **增量備份**：自動偵測內容變更，相同內容不重複寫入；同一對話固定對應同一個備份檔案
- **當前對話同步狀態**：Popup 顯示當前分頁的備份狀態（未同步 / 同步中 / 已同步）及上次備份時間
- **Markdown 輸出**：保留標題、粗體、清單、程式碼塊等格式
- **Voyager 整合**：若安裝 [Voyager](https://chromewebstore.google.com/detail/voyager-for-gemini/...) 擴充套件，全量備份時可自動捲動載入所有歷史訊息

## 安裝方式

目前尚未上架 Chrome Web Store，請使用開發者模式手動載入：

1. 下載或 Clone 本專案
2. 打開 Chrome，前往 `chrome://extensions/`
3. 開啟右上角「**開發人員模式**」
4. 點擊「**載入未封裝項目**」，選擇本專案資料夾
5. 點擊工具列的擴充套件圖示即可使用

## 使用方式

### 首次設定

1. 點擊擴充套件圖示開啟 Popup
2. 點「**選擇資料夾**」，選擇本地備份目的地並授權寫入
3. 設定**備份頻率**（或保持關閉，僅手動備份）

### 備份當前對話

開啟任一 Gemini 對話頁面，點「**立即備份**」，即可備份所有已開啟的 Gemini 分頁。

### 全量歷史備份

點「**同步所有歷史**」，擴充套件會自動：

1. 掃描側邊欄中的所有對話連結
2. 逐一開啟並捲動至最頂端，觸發舊訊息載入（若有安裝 Voyager，會使用 timeline dot 機制）
3. 備份完整對話內容，跳過已是最新的對話
4. 在 Popup 即時顯示進度

### 備份檔案

- 命名格式：`[對話標題]_[chatId].md`（每個對話唯一，重複備份會覆寫同一檔案）
- 內容格式：Markdown，含備份時間、對話連結、使用者與 Gemini 的完整訊息

## 檔案結構

```
├── manifest.json         # Manifest V3 套件設定
├── background.js         # Service Worker（排程、備份邏輯）
├── content.js            # DOM 擷取腳本（注入 Gemini 分頁）
├── sidebar_scanner.js    # 側邊欄掃描腳本（全量備份用）
├── popup.html            # Popup UI
├── popup.js              # Popup 互動邏輯
└── test/
    ├── test.html         # 瀏覽器互動測試頁
    └── run_tests.js      # 命令列測試腳本（需 JavaScriptCore）
```

## 執行測試

**命令列（macOS）：**
```bash
JSC=/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC test/run_tests.js
```

**瀏覽器：** 使用任意 HTTP 伺服器提供靜態檔案後，開啟 `test/test.html`，點擊「執行全部測試」。

## 已知限制

- Gemini 的 DOM 結構不定期更新，若備份失敗請回報 Issue
- File System Access API 的資料夾授權在瀏覽器重啟後可能需要重新點擊備份按鈕以觸發重新授權
- 全量備份期間請勿關閉 Gemini 分頁

## 授權

MIT License
