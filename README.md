# Gemini Chat Auto Backup Tool

> ⚠️ **測試中（Beta）**：本套件目前仍在開發測試階段，部分功能可能因 Google Gemini 介面更新而需要調整。

自動將 [Google Gemini](https://gemini.google.com) 的對話紀錄備份到本地資料夾，並儲存為 Markdown 格式的 Chrome 擴充套件。

---

## 功能

- **本地資料夾備份**：透過 File System Access API 將對話存到你選擇的資料夾
- **排程自動備份**：每 1 小時、4 小時、8 小時或每天自動執行
- **手動立即備份**：一鍵觸發備份當前所有 Gemini 分頁
- **增量備份**：自動偵測內容變更，相同內容不重複寫入
- **Markdown 輸出**：保留標題、粗體、清單、程式碼塊等格式

## 安裝方式

目前尚未上架 Chrome Web Store，請使用開發者模式手動載入：

1. 下載或 Clone 本專案
2. 打開 Chrome，前往 `chrome://extensions/`
3. 開啟右上角「**開發人員模式**」
4. 點擊「**載入未封裝項目**」，選擇本專案資料夾
5. 點擊工具列的擴充套件圖示即可使用

## 使用方式

1. 點擊擴充套件圖示開啟 Popup
2. 點「**選擇資料夾**」，選擇本地備份目的地並授權寫入
3. 設定**備份頻率**（或保持關閉，僅手動備份）
4. 開啟 Gemini 對話頁面，點「**立即備份**」

備份檔案命名格式：`[對話標題]_[時間戳記].md`
例如：`Python學習筆記_20260407_1430.md`

## 檔案結構

```
├── manifest.json      # Manifest V3 套件設定
├── background.js      # Service Worker（排程、備份邏輯）
├── content.js         # DOM 擷取腳本（注入 Gemini 分頁）
├── popup.html         # Popup UI
├── popup.js           # Popup 互動邏輯
└── test/
    ├── test.html      # 瀏覽器互動測試頁
    └── run_tests.js   # 命令列測試腳本（需 JavaScriptCore）
```

## 執行測試

**命令列（macOS）：**
```bash
JSC=/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC test/run_tests.js
```

**瀏覽器：** 使用任意 HTTP 伺服器提供靜態檔案後，開啟 `test/test.html`，點擊「執行全部測試」。

目前測試覆蓋：`htmlToMarkdown`、`simpleHash`、增量備份偵測、時間戳記格式、檔名清理（共 51 個測試）。

## 已知限制

- Gemini 的 DOM 結構不定期更新，若備份失敗請回報 Issue
- File System Access API 的資料夾授權在瀏覽器重啟後可能需要重新授權
- 目前僅支援單一對話頁面擷取（不支援對話列表批次備份）

## 授權

MIT License
