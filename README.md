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

> 💡 **建議搭配 [Voyager](https://github.com/voyager-crew/voyager) 2.x 使用。** 本套件會偵測 Voyager 並直接使用它提供的「Gemini 正在載入歷史」訊號，長對話的完整載入因此又快又不會漏。沒有 Voyager 也能運作，只是長對話要靠逾時判斷、較慢。Popup 的「當前對話狀態」會顯示是否已連動。

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
- 未安裝 Voyager 時，長對話的歷史載入只能靠逾時判斷，每個有變動的長對話結尾約多等 30 秒
- File System Access API 的資料夾授權在瀏覽器重啟後可能需要重新點擊備份按鈕以觸發重新授權
- 備份期間請勿關閉 Gemini 分頁

---

## Changelog

### v2.3.0 — 2026-10-22

以 Voyager 2.2.0 為主軸重構，並以實際帳號在 Chrome 上逐項實測。

#### 歷史載入改聽 Voyager 的請求訊號
Voyager 2.x 的 conversation-history-observer 會在 Gemini 每次抓更早的歷史（batchexecute `hNvQHb`）時發出 start / end 訊號，且不受 Voyager 其他設定影響。改為直接聽這個訊號：請求在飛就一定等；沒有請求、也沒有新內容，安靜滿 12 秒才判定到頂——與 Voyager 自己匯出時的判斷方式相同。

實測發現舊版的判斷會截斷備份：

```
單一請求耗時 1.3～30 秒（被節流時更慢）
舊版：8 秒沒變化 → 點最上方訊息 → 兩輪確認 ≈ 16 秒就判定「到頂」
```

對話區的 loading spinner 在請求期間全程不可見，舊的 spinner 偵測是死碼，慢請求一律被當成「已經到頂」。

- 最後一頁必定不足 10 則（實測 348 則的對話最後一頁 8 則、173 則的是 3 則）：上一頁不足 10 則時只做 3 秒確認。大多數對話不到 10 則，收尾由約 17 秒降為 **3 秒**
- 移除改以 Voyager 訊號取代的邏輯：spinner 偵測、模擬點擊最上方訊息、點擊導致整頁重載的重試、多容器捲動、Voyager timeline dot 點擊（`background.js` 淨減約 100 行）
- 沒裝 Voyager 仍可運作（內容指紋 + 30 秒安靜視窗，正確但慢）；Popup 顯示「已連動 Voyager / 未偵測到 Voyager」

#### 官方複製擷取誤點 Voyager 的按鈕
Voyager 在回覆操作列加了「複製回覆為圖片」，它的 aria-label 含「複製回覆」，被我們的備援規則命中——點下去拿到的是圖片、bridge 只收到空字串，連兩次後官方複製整段停用（實測 0/2 成功）。同時 Gemini 的複製鈕改包在 `<copy-button>` 元素內，原本的 `data-test-id="copy-button"` 已不存在。

- 優先匹配 `copy-button button`，並排除所有 `data-test-id="gv-*"` 的 Voyager 按鈕：實測 29/32 成功（其餘為含圖片的回覆，本來就走 DOM 轉換保留圖片連結）
- 停用條件由「累計 2 次失敗」改為「連續 2 次失敗」，個別無文字的回覆不再拖累整段對話

#### 對應 Gemini 2026-10 改版
- **側邊欄 jslog metadata 改為 base64**：舊解析 0/34 命中，釘選狀態與排序全部失效；改為先解碼再解析，34/34
- **釘選圖示改為 `.conversation-pin-icon`**：「前 N 個」模式原本把 10 個釘選算成一般對話，實際只備份 N−10 個
- **Gem 對話網址改為 `/gem/<gemId>/<chatId>`**（側邊欄 href 仍是 `/app/<chatId>`）：手動備份原本拿網址 hash 當 ID，會與全量備份存成兩份；Popup 也不顯示 Gem 對話的狀態卡
- Voyager 的「訊息時間」標籤（`.gv-timestamp`）插在使用者訊息內，排除於備份內文與尾端指紋之外，開關該功能不會讓 hash 變動

測試：94/94 通過（新增 11 項，涵蓋 base64 jslog、Gem 網址、Voyager 標籤排除）。

### v2.2.3 — 2026-08-23

以實際帳號（533 個對話）在 Chrome 上逐項實測驗證，修正三個會造成「漏備份」與「備份被截斷」的問題。

#### 全量備份只掃到 97 個對話
側邊欄捲動迴圈「計數一次沒變就結束」。Voyager 每批載入 20 個、批次間有 4～6 秒空窗，第一個空窗就讓掃描收工——實測穩定停在 97：

```
37 → 57 → 77 → 97 → 97 ← 這裡結束 → （實際還有 117 → 137 → … → 533）
```

- 改為等待 `.loading-content-spinner-container`（真正的「抓取中」訊號，舊版完全沒偵測），並要求**連續 8 輪無新增 + 捲軸確實在底部**才結束
- `isScrollable` 的 +50px 門檻會在 Angular 進場動畫期間誤判（該時點 `scrollHeight - clientHeight` 僅約 30px）而直接放棄捲動，改為 +4px，並從真實對話項目往上查找容器
- 先展開「近期對話」的 `expandable-section`（收合時項目不會 render）
- 分切片執行，掃描中途按「停止」立即生效，popup 顯示即時已載入數量

實測：**533 個對話約 36 輪 / 116～152 秒**，冷啟動重跑兩次結果一致。

#### 超過 20 則的長對話備份一次後就不再更新
快速略過的判斷是「畫面上的訊息數 ≤ 上次備份數」。但 Gemini 開啟對話只 render 最後 20 則，`20 ≤ 200` 對任何長對話恆成立——備份過一次之後新訊息就再也不會被抓到，「有新訊息」徽章也因為同一個比較而永遠不亮。

- 改用**尾端指紋**（最後一則使用者 + 模型訊息尾端 400 字的雜湊）。新訊息一定 append 在尾端，而尾端在初次 render 就存在，此判斷不受虛擬化 render 影響
- 升級前備份的對話沒有指紋，第一次會走完整流程並補上，之後即可快速略過

#### 備份檔會從最舊的訊息開始被啃掉
`scrollToLoadAllMessages` 的 `stopAtCount` 帶入上次備份的訊息數，用意是「不必每次都捲到最舊」。但 Gemini 是**從最新往回**載入，停在 `prevMsgCount` 拿到的是最新的 `prevMsgCount` 則：對話從 200 則增為 205 則時，DOM 內是第 6～205 則，而備份檔是整份覆寫的，最舊的 5 則就此消失。每次備份都再啃掉一點。

`currMsgCount < prevMsgCount` 的回退保護抓不到這種情況——`stopAtCount` 讓兩者剛好相等，判斷式永遠不成立。

- 移除該參數與兩處提前結束，改由迴圈自身的「連續無新內容」條件決定何時到頂
- 「沒有新訊息就不捲動」交由尾端指紋負責（且是完全不捲），因此有變動的對話捲完整份並不浪費——整份覆寫本來就需要完整歷史

#### 其他
- **歷史載入**：`.loading-history-spinner-container` 在 Voyager 已不存在（0 筆匹配），整段 spinner 偵測形同死碼，已補上現行 class；確認回合逾時由 8 秒降為 3.5 秒（實測一批約 1.2 秒載入完成），每個對話結尾約省 9 秒
- **側邊欄掃描**：改由 jslog metadata（`["c_<id>", null, <pinned>, <index>]`）取得釘選狀態與清單順序，取代猜測 `push_pin` icon；實測 36/36 解析成功、釘選數與 icon 判斷完全一致。並依該順序排序，備份順序與使用者所見一致
- **備份範圍可自訂**：原本最多只能選「前 30 個」，新增 50 / 100 與「自訂…」數字輸入（10 種語言）。超出範圍的輸入採夾回而非拒絕，按鈕文字不會與實際執行的數量不一致
- **設定範圍時提前結束掃描**：選「前 N 個」原本仍會捲完整個側邊欄再截取，改為載滿所需的非釘選數量即停——前 100 個由 36 輪 / 116 秒降為 **4 輪 / 13 秒**

測試：84/84 通過（新增 27 項，涵蓋 jslog metadata 解析、尾端指紋、備份範圍解析與存取往返）。

### v2.2.2 — 2026-07-14

移植自 PR #12（基於舊架構的改良，經重新實作至 v2.2.1 新架構）：

#### 停止備份立即生效
- 按下「停止備份」後 **< 500ms 內終止所有作業**（原本要等當前對話的長作業跑完）：
  - stop 時廣播 abort 旗標到所有 Gemini 分頁，頁面內長迴圈（歷史捲動、圖片下載、官方複製擷取）每輪輪詢都會檢查並立即跳出
  - 導航等待加入停止偵測（每 300ms），按停止立即中斷且不觸發導航重試
  - 圖片並行下載改用 `AbortController`，停止時中止所有 in-flight fetch
  - 新一輪備份開始時自動清除前次殘留的 stop / abort 旗標，避免誤殺

#### 歷史載入強化（實測修正）
- **真實可捲動性判斷**：實測 `#chat-history` 等容器為 `overflow:hidden`（設 scrollTop 無效），改以 `overflow-y` + `scrollHeight` 判斷真正可捲的容器，並支援從訊息元素向上查找可捲祖先
- **多容器觸發 + scroll 事件派發**：對所有候選容器捲頂並主動派發 scroll 事件（部分 listener 為 passive，不會被 scrollTop assignment 觸發）
- **spinner 訊號**：偵測 Gemini 內建的 `loading-history-spinner`，看到就等它消失再判定進度，timing 更準確
- **展開鈕修正**：`luminous-expand-button` 實為側邊欄按鈕（aria-label 同為「展開」），已從訊息展開清單排除；每圈重新展開新載入的 collapsed 區段
- **上限放寬**：80 圈 + 5 分鐘 wall-clock 雙保險，支援 800+ 則的超長對話；連續 2 圈無進度（中間 backoff 重試）才收工

#### 側邊欄
- **collapsed 自動展開**：Gemini 2026 改版後側邊欄預設 hover-to-expand，collapsed 時對話項目為空殼無法掃描；全量備份會自動點擊展開按鈕，失敗時給出明確指引而非默默漏備份
- 側邊欄捲動同樣改用真實可捲動性判斷 + scroll 事件派發

### v2.2.1 — 2026-07-14

#### 重大修正
- **修正增量偵測失效**：舊版 hash 計算包含「備份時間」，導致每次備份的 hash 必定不同、增量比對永遠不會命中。現改為只根據訊息內容計算的**穩定內容雜湊**，相同內容的對話會被真正跳過（不再重新捲動、擷取、寫檔）

#### 新增功能
- **官方複製擷取**：模型回覆優先透過 Gemini 官方的「複製回覆」功能取得 Google 官方生成的 Markdown（透過 MAIN world clipboard bridge 攔截，**不會污染使用者的真實剪貼簿**）；找不到按鈕或失敗時自動退回 DOM 轉換，含圖片的回覆維持 DOM 轉換以保留圖片連結。備份期間會暫時隱藏 Gemini 的「已複製到剪貼簿」提示，結束後恢復
- **本地備份索引重建**：每個備份檔尾嵌入 meta 註記（hash / 訊息數 / 對話 ID）；chrome.storage 遺失時（重裝擴充套件、清除資料），全量備份會自動掃描備份資料夾恢復索引，只做增量更新、不會整批重新備份。舊格式檔案（無 meta）也會以段落標題推回訊息數
- **KaTeX 數學式**：輸出原始 LaTeX（`$...$` / `$$...$$`），不再重複輸出 MathML 與 HTML 渲染文字
- **刪除線與巢狀清單**：`~~刪除線~~` 與多層清單縮排正確輸出

#### 因應 Gemini / Voyager 改版
- **完整歷史載入不再依賴 Gemini Voyager**：新版 Voyager (1.5+) 的 timeline dot 已虛擬化（只渲染可見範圍），舊的「數 dot」策略會誤判。改為「捲動至頂 + MutationObserver 內容指紋偵測」，捲動無效時模擬點擊最上方訊息觸發歷史載入（Voyager 1.5+ 驗證過的手法）；點擊觸發整頁重載時自動等待並重試
- **選擇器全面更新**：同步目前 Gemini DOM 的使用者 / 模型訊息、側邊欄、對話標題選擇器（參考 gemini-voyager 持續維護的清單），舊選擇器保留為 fallback
- **側邊欄掃描支援新版結構**：新版側邊欄項目（`data-test-id="conversation"`）可能沒有 `<a href>`，改為同時支援從 `jslog` 屬性擷取對話 ID
- **排除思考過程**：Gemini 的「顯示思路」(model-thoughts) 與 Deep Research 面板不再混入備份正文；來源引用、朗讀控制等 UI 元件也一併排除

#### 穩定性
- **Service Worker keepalive**：備份期間每 20 秒重置 MV3 閒置計時器，長時間全量備份不再被 Chrome 中途回收
- **導航自動重試**：對話頁載入逾時自動重試一次才記為失敗
- **快速略過真正生效**：已備份且無新訊息的對話完全跳過捲動與擷取（舊版仍會執行擷取），全量備份速度顯著提升
- **儲存索引遷移**：hash 索引由 URL-based 改為對話 ID-based（`chatHash_[convId]`），更新後自動清除舊索引；升級後第一次全量備份會重新寫入所有檔案（嵌入 meta 註記），之後恢復增量

### v2.2.0 — 2026-05-21

- 因應 Gemini 2026/5 大改版的選擇器升級（僅發布於 [Releases](https://github.com/pppeterlin/gemini-chat-auto-backup-tool/releases/tag/v2.2.0)，未併入 main；相關修正已由 v2.2.1 以新架構重新實作並涵蓋）

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

> 💡 **Recommended: use together with [Voyager](https://github.com/voyager-crew/voyager) 2.x.** The extension detects Voyager and listens to its "Gemini is loading history" signal, so long conversations load completely and quickly. It still works without Voyager, but long chats fall back to timeouts and are slower. The popup's current-chat card shows whether Voyager is linked.

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
- Without Voyager, history loading relies on timeouts: each changed long conversation waits about 30 extra seconds at the end
- The folder write permission granted via File System Access API may need to be re-confirmed after a browser restart (just click "Backup Now" again to trigger re-authorization)
- Do not close the Gemini tab while a backup is running

---

## License

MIT License
