// content.js - 在 Gemini 分頁中執行，擷取對話內容並回傳給 background.js
// 透過 chrome.scripting.executeScript({ files: ['content.js'] }) 注入
// Chrome 111+ 支援 async IIFE 回傳 Promise，executeScript 會等待 resolve

(async function scrapeGeminiConversation() {
  // ── Shadow DOM 穿透查詢 ───────────────────────────────────────────────────────
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

  // ── 訊息過濾 helpers ──────────────────────────────────────────────────────────
  // Gemini 的「顯示思路」(model-thoughts) 與 Deep Research 側面板不屬於對話正文
  const THOUGHTS_SELECTOR = 'model-thoughts, .thoughts-container, .thoughts-content';

  function isInExcludedRegion(el) {
    return !!el.closest?.('deep-research-immersive-panel');
  }

  // 同一選擇器可能同時匹配巢狀的父子元素，只保留最外層
  function filterTopLevel(elements, selector) {
    return elements.filter(el => {
      const parent = el.parentElement;
      return !(parent && parent.closest(selector));
    });
  }

  // ── 圖片追蹤（跨 htmlToMarkdown 呼叫共用）──────────────────────────────────────
  const imageList = []; // { filename, src, buttonEl? }
  let imgCounter = 0;

  // ── HTML → Markdown 轉換器 ────────────────────────────────────────────────────
  function htmlToMarkdown(rootEl) {
    if (!rootEl) return '';

    function convert(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const style = node.style;

      // 忽略隱藏元素和無意義標籤
      if (style && style.display === 'none') return '';
      if ([
        'script', 'style', 'svg', 'noscript', 'mat-icon',
        // Gemini UI 附屬元件：思考過程、來源引用、朗讀控制等，不屬於對話正文
        'model-thoughts', 'source-footnote', 'sources-carousel',
        'sources-carousel-inline', 'source-inline-chip', 'tts-control',
        'message-actions', 'sensitive-memories-banner',
      ].includes(tag)) return '';
      if (node.classList) {
        if (node.classList.contains('thoughts-container') ||
            node.classList.contains('thoughts-content')) return '';
        // KaTeX 數學式：優先取原始 LaTeX，避免 mathml + html 重複輸出
        if (node.classList.contains('katex-display')) {
          const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          if (tex) return `\n$$\n${tex.trim()}\n$$\n`;
        }
        if (node.classList.contains('katex')) {
          const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          if (tex) return `$${tex.trim()}$`;
        }
      }

      const inner = () => Array.from(node.childNodes).map(convert).join('');

      switch (tag) {
        case 'h1': return `\n# ${inner().trim()}\n`;
        case 'h2': return `\n## ${inner().trim()}\n`;
        case 'h3': return `\n### ${inner().trim()}\n`;
        case 'h4':
        case 'h5':
        case 'h6': return `\n#### ${inner().trim()}\n`;
        case 'strong':
        case 'b': {
          const text = inner().trim();
          return text ? `**${text}**` : '';
        }
        case 'em':
        case 'i': {
          const text = inner().trim();
          return text ? `*${text}*` : '';
        }
        case 'del':
        case 's':
        case 'strike': {
          const text = inner().trim();
          return text ? `~~${text}~~` : '';
        }
        case 'p': return `\n${inner()}\n`;
        case 'br': return '\n';
        case 'hr': return '\n---\n';
        case 'pre': {
          const codeEl = node.querySelector('code');
          const lang = (codeEl?.className || '').match(/language-(\w+)/)?.[1] || '';
          const code = (codeEl ?? node).textContent;
          return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
        }
        case 'code': {
          if (node.closest('pre')) return node.textContent;
          return `\`${node.textContent}\``;
        }
        case 'ul': {
          const items = Array.from(node.children)
            .filter(c => c.tagName === 'LI')
            .map(li => renderListItem(li, '- '))
            .join('\n');
          return `\n${items}\n`;
        }
        case 'ol': {
          const items = Array.from(node.children)
            .filter(c => c.tagName === 'LI')
            .map((li, i) => renderListItem(li, `${i + 1}. `))
            .join('\n');
          return `\n${items}\n`;
        }
        case 'li': return inner();
        case 'a': {
          const href = node.getAttribute('href');
          const text = inner().trim();
          if (!href || href.startsWith('javascript:')) return text;
          return `[${text}](${href})`;
        }
        case 'blockquote': {
          return `\n> ${inner().trim().replace(/\n/g, '\n> ')}\n`;
        }
        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (!rows.length) return inner();
          const lines = rows.map((row, i) => {
            const cells = Array.from(row.querySelectorAll('th, td'))
              .map(c => c.textContent.trim().replace(/\|/g, '\\|'));
            const line = `| ${cells.join(' | ')} |`;
            if (i === 0) return `${line}\n| ${cells.map(() => '---').join(' | ')} |`;
            return line;
          });
          return `\n${lines.join('\n')}\n`;
        }
        case 'button': {
          // Gemini 用 button 包住圖片預覽；只取出 <img>，跳過按鈕文字標籤
          // 同時記錄 buttonEl，之後可點擊燈箱取得原始檔
          const imgs = Array.from(node.querySelectorAll('img'));
          if (!imgs.length) return '';
          return imgs.map(img => {
            const beforeLen = imageList.length;
            const mdStr = convert(img);
            if (imageList.length > beforeLen) {
              // 將 button 元素存入最後推入的 imageList entry
              imageList[imageList.length - 1].buttonEl = node;
            }
            return mdStr;
          }).join('');
        }
        case 'img': {
          const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
          // 跳過空 src 或已內嵌的 data URL
          if (!src || src.startsWith('data:')) return '';
          const alt = node.getAttribute('alt') || '';
          imgCounter++;
          const urlPath = src.split('?')[0].split('#')[0];
          const extMatch = urlPath.match(/\.(\w{2,4})$/i);
          const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
          const filename = `image_${imgCounter}.${ext}`;
          imageList.push({ filename, src });
          return `\n![${alt}](media/${filename})\n`;
        }
        default: return inner();
      }
    }

    // 巢狀清單：li 內含子清單時，第一行掛清單標記，其餘行縮排兩格
    function renderListItem(li, marker) {
      const lines = convert(li).trim().split('\n');
      const first = `${marker}${lines[0]}`;
      if (lines.length === 1) return first;
      const rest = lines.slice(1).map(l => (l ? `  ${l}` : l)).join('\n');
      return `${first}\n${rest}`;
    }

    return convert(rootEl)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Gemini UI 冗餘標籤清除 ────────────────────────────────────────────────────
  // 「你說了」可能出現在圖片 ref 後面（圖片在 DOM 前面），用全域 replace
  function cleanUserMd(md) {
    return md
      .replace(/你說了[\s\n]+/g, '')
      .replace(/^You said[\s\n]+/g, '')
      .trim();
  }

  function cleanModelMd(md) {
    return md
      .replace(/^(##\s*)?Gemini\s*(說了|said)[\s\n]+/, '')
      .trim();
  }

  // ── 簡單雜湊（用於增量備份偵測）────────────────────────────────────────────────
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  // 穩定內容雜湊：只根據訊息本文計算，不含備份時間戳與圖片檔名，
  // 同一對話內容在不同時間備份會得到相同 hash，增量偵測才能真正生效。
  function stableContentHash(messages) {
    return simpleHash(messages.map(m => `${m.role} ${m.markdown}`).join(''));
  }

  // ── 擷取對話標題 ──────────────────────────────────────────────────────────────
  function getTitle() {
    // v2 (2026 redesign): no global title element — derive from the active sidebar item
    for (const el of queryShadowAll(document, 'a[href*="/app/"]')) {
      if (el.getAttribute('aria-current') === 'page' ||
          el.getAttribute('aria-selected') === 'true' ||
          el.classList?.contains('is-active')) {
        const titleSpan = el.querySelector?.('.title-text, .gv-conversation-title');
        const spanText = titleSpan?.textContent?.trim();
        if (spanText && spanText.length >= 1 && spanText.length <= 200) return spanText;
        const ariaLabel = el.getAttribute('aria-label')?.trim();
        if (ariaLabel && ariaLabel.length >= 1 && ariaLabel.length <= 200) return ariaLabel;
        const text = el.textContent?.trim();
        if (text && text.length >= 1 && text.length <= 120) return text;
      }
    }

    // Legacy fallback (pre-v2 UI)
    const testIdEl = document.querySelector('[data-test-id="conversation-title"]');
    if (testIdEl?.textContent?.trim()) return testIdEl.textContent.trim();
    for (const sel of ['.conversation-title', '[data-conversation-title]', '.chat-title']) {
      const el = queryShadowAll(document, sel)[0];
      if (el?.textContent?.trim()) return el.textContent.trim();
    }

    return document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').trim() || '未命名對話';
  }

  // ── 擷取訊息清單 ──────────────────────────────────────────────────────────────
  // 選擇器同步自目前 Gemini DOM（參考 gemini-voyager 持續維護的清單），
  // 舊版選擇器保留在後面作為 fallback。
  function findMessages() {
    const userSelectors = [
      'user-query',
      '.user-query-bubble-with-background',
      '.user-query-bubble-container',
      '.user-query-container',
      '.user-query-content',
      '.query-content',
      'div[aria-label="User message"]',
      'article[data-turn="user"]',
      '[data-message-author-role="user"]',
      '.human-turn',
    ];

    const modelSelectors = [
      'model-response',
      '[aria-label="Gemini response"]',
      '.model-response-text',
      'response-container .response-content',
      '.presented-response-container',
      'article[data-turn="model"]',
      '[data-message-author-role="model"]',
      '[data-message-author-role="assistant"]',
      '.ai-response',
    ];

    let userEls = [];
    let modelEls = [];

    for (const sel of userSelectors) {
      const found = filterTopLevel(
        queryShadowAll(document, sel).filter(el => !isInExcludedRegion(el)), sel
      );
      if (found.length) { userEls = found; break; }
    }
    for (const sel of modelSelectors) {
      const found = filterTopLevel(
        queryShadowAll(document, sel).filter(el => !isInExcludedRegion(el)), sel
      );
      if (found.length) { modelEls = found; break; }
    }

    if (!userEls.length && !modelEls.length) {
      const turnSelectors = ['conversation-turn', '.conversation-turn', '[data-turn-index]'];
      for (const sel of turnSelectors) {
        const turns = queryShadowAll(document, sel);
        if (!turns.length) continue;
        turns.forEach(turn => {
          const u = turn.querySelector?.('.query-text, .user-text, .human-message');
          const m = turn.querySelector?.('.response-text, .model-text, .ai-message');
          if (u) userEls.push(u);
          if (m) modelEls.push(m);
        });
        if (userEls.length || modelEls.length) break;
      }
    }

    return { userEls, modelEls };
  }

  // 模型回覆的正文容器：優先取 message-content / .markdown（排除思考過程），
  // 找不到才退回整個回覆元素。
  function pickModelContentRoot(modelEl) {
    function outsideThoughts(sel) {
      const candidates = modelEl.querySelectorAll?.(sel) || [];
      for (const c of candidates) {
        if (!c.closest(THOUGHTS_SELECTOR)) return c;
      }
      return null;
    }
    return outsideThoughts('message-content')
        || outsideThoughts('.markdown, .markdown-main-panel')
        || outsideThoughts('.response-content')
        || modelEl;
  }

  // ── 官方複製擷取（Gemini 官方導出格式）─────────────────────────────────────────
  // background.js 已在 MAIN world 注入 clipboard bridge（攔截 navigator.clipboard），
  // 點擊 Gemini 官方的「複製回覆」按鈕時，官方生成的 markdown 會被 bridge 捕捉、
  // 不會寫入使用者真正的剪貼簿。取得的內容比 DOM 轉換更貼近原始格式。
  // 找不到按鈕或連續失敗時自動退回 DOM 轉換，不影響備份。
  let officialCopyStrikes = 0;

  // 點擊複製按鈕時 Gemini 會跳出「已複製到剪貼簿」snackbar；
  // 備份期間暫時隱藏，結束後移除樣式恢復正常。
  function suppressCopyToast() {
    if (document.getElementById('__gcb-hide-toast')) return;
    const style = document.createElement('style');
    style.id = '__gcb-hide-toast';
    style.textContent = `
      .cdk-overlay-container .mat-mdc-snack-bar-container,
      .cdk-overlay-container .mat-snack-bar-container,
      .cdk-overlay-container snack-bar-container,
      .cdk-overlay-container simple-snack-bar,
      .cdk-overlay-container message-snackbar {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function restoreCopyToast() {
    document.getElementById('__gcb-hide-toast')?.remove();
  }

  // 注意：必須排除程式碼區塊的「複製程式碼」按鈕（在 code-block / pre 內），
  // 誤抓會導致整則回覆被替換成單一程式碼片段。
  function isCodeBlockButton(btn) {
    return !!btn.closest('code-block, pre, .code-block');
  }

  function findCopyButton(modelEl) {
    const container = modelEl.closest?.(
      'response-container, .response-container, .presented-response-container'
    ) || modelEl;
    const directCandidates = Array.from(container.querySelectorAll?.(
      '[data-test-id="copy-button"] button, button[data-test-id="copy-button"], [data-test-id="copy-button"]'
    ) || []);
    const direct = directCandidates.find(b => !isCodeBlockButton(b));
    if (direct) return direct;
    // aria-label 必須同時含「複製」與「回覆/回應」語意，避免抓到其他複製按鈕
    const byLabel = Array.from(container.querySelectorAll?.('button[aria-label]') || [])
      .find(b => {
        if (isCodeBlockButton(b)) return false;
        const label = b.getAttribute('aria-label') || '';
        return /copy response|copy answer|複製回覆|複製回應|复制回复|回答をコピー|回覆/i.test(label) ||
               (/copy|複製|复制/i.test(label) && /response|answer|回覆|回應|回复|回答/i.test(label));
      });
    return byLabel || null;
  }

  async function harvestOfficialMarkdown(modelEl) {
    if (officialCopyStrikes >= 2) return null;
    const bridge = document.getElementById('__gcb-clip-bridge');
    if (!bridge) return null;
    const btn = findCopyButton(modelEl);
    if (!btn) return null;

    const prevSeq = bridge.getAttribute('data-seq') || '0';
    bridge.setAttribute('data-capture', '1');
    suppressCopyToast();
    try {
      btn.click();
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
        if ((bridge.getAttribute('data-seq') || '0') !== prevSeq) {
          const text = (bridge.textContent || '').trim();
          if (text) return text;
          break;
        }
      }
      officialCopyStrikes++;
      return null;
    } catch (_) {
      officialCopyStrikes++;
      return null;
    } finally {
      bridge.setAttribute('data-capture', '0');
    }
  }

  // ── 燈箱操作：點擊圖片預覽按鈕，取得原始圖 URL 與原始檔名 ─────────────────────────
  function openLightboxAndGetInfo(buttonEl) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(result);
      };

      const observer = new MutationObserver(() => {
        const trustedImg = document.querySelector('[data-test-id="trusted-image"]');
        if (!trustedImg?.src) return;
        const titleEl = document.querySelector(
          'expansion-dialog .title, .image-title .title, .dialog-title .title'
        );
        finish({
          imageUrl: trustedImg.src,
          originalName: titleEl?.textContent?.trim() || null,
        });
      });

      // childList 偵測對話框插入，attributes 偵測 src 延遲設定
      observer.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['src'],
      });

      const timer = setTimeout(() => finish(null), 5000);
      buttonEl.click();
    });
  }

  async function closeLightbox() {
    const closeBtn = document.querySelector(
      '[mat-dialog-close], button[aria-label="關閉"], button[aria-label="Close"]'
    );
    if (!closeBtn) return;
    closeBtn.click();
    // 輪詢直到對話框消失，通常 100–200ms；上限 800ms
    const deadline = Date.now() + 800;
    while (document.querySelector('[data-test-id="trusted-image"]') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  // ── 主邏輯 ─────────────────────────────────────────────────────────────────────
  const title = getTitle();
  const conversationUrl = window.location.href;

  // 使用者按下「停止」時 background 會在 window.__geminiBackupAborted 設旗標。
  // 長迴圈（訊息擷取、燈箱、圖片下載）每輪都檢查，偵測到就回報 aborted，
  // 由 background 立即終止整個備份流程。
  const isAborted = () => !!window.__geminiBackupAborted;
  const abortedResult = () => (
    { title, content: null, hash: '', url: conversationUrl, aborted: true }
  );

  const { userEls, modelEls } = findMessages();

  if (!userEls.length && !modelEls.length) {
    return { title, content: null, hash: '', url: conversationUrl };
  }

  const backupTime = new Date().toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // 先建立訊息清單（模型回覆優先嘗試官方複製，失敗退回 DOM 轉換）
  const messages = [];
  const maxLen = Math.max(userEls.length, modelEls.length);
  try {
    for (let i = 0; i < maxLen; i++) {
      if (isAborted()) return abortedResult();
      if (i < userEls.length) {
        const userMd = cleanUserMd(htmlToMarkdown(userEls[i]));
        messages.push({ role: 'user', markdown: userMd });
      }
      if (i < modelEls.length) {
        const domMd = cleanModelMd(htmlToMarkdown(pickModelContentRoot(modelEls[i])));
        let modelMd = domMd;
        // 只有在 DOM 版本不含圖片參照時才可安全替換為官方複製內容
        // （官方複製是純文字，換掉會遺失圖片連結）
        if (!domMd.includes('](media/')) {
          const official = await harvestOfficialMarkdown(modelEls[i]);
          if (official) modelMd = official;
        }
        messages.push({ role: 'model', markdown: modelMd });
      }
    }
  } finally {
    restoreCopyToast(); // 備份結束（或中途出錯）都要恢復 snackbar 顯示
  }

  // 組裝 Markdown 全文
  let md = `# ${title}\n\n`;
  md += `> **備份時間：** ${backupTime}  \n`;
  md += `> **對話連結：** ${conversationUrl}\n\n`;
  md += '---\n\n';

  let turnIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (turnIndex > 0) md += '---\n\n';
      md += `## 使用者\n\n${msg.markdown}\n\n`;
      turnIndex++;
    } else {
      md += `## Gemini\n\n${msg.markdown}\n\n`;
    }
  }

  // ── 圖片下載（兩階段）────────────────────────────────────────────────────────
  // Phase 1（循序）：點擊燈箱取得 blob URL + 原始檔名，更新 md 參照
  // Phase 2（並行）：Promise.all 同時 fetch 所有圖片，縮短總等待時間
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
  const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/avif': 'avif',
  };

  // Phase 1: 循序點擊燈箱，收集每張圖的最終 fetchUrl
  const downloadQueue = []; // { img, fetchUrl }
  for (const img of imageList) {
    if (isAborted()) return abortedResult();
    let fetchUrl = img.src;
    if (img.buttonEl) {
      const info = await openLightboxAndGetInfo(img.buttonEl);
      if (info) {
        if (info.imageUrl) fetchUrl = info.imageUrl;
        if (info.originalName && /\.\w{2,4}$/.test(info.originalName)) {
          const newFilename = info.originalName;
          md = md.replace(`media/${img.filename}`, `media/${newFilename}`);
          img.filename = newFilename;
        }
      }
      await closeLightbox();
    }
    downloadQueue.push({ img, fetchUrl });
  }

  if (isAborted()) return abortedResult();

  // Phase 2: 並行 fetch — 所有圖片同時下載
  // AbortController 串接：使用者按停止會立即中止所有 in-flight fetch
  const fetchAborter = new AbortController();
  const abortPoll = setInterval(() => {
    if (isAborted()) { fetchAborter.abort(); clearInterval(abortPoll); }
  }, 200);

  const fetchedImages = (await Promise.all(
    downloadQueue.map(async ({ img, fetchUrl }) => {
      try {
        const resp = await fetch(fetchUrl, { credentials: 'include', signal: fetchAborter.signal });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        if (blob.size > MAX_IMAGE_BYTES) return null;

        // 依實際 MIME type 修正副檔名（各 img.filename 唯一，無競爭條件）
        const realExt = MIME_TO_EXT[blob.type];
        if (realExt && !img.filename.endsWith(`.${realExt}`)) {
          const newFilename = img.filename.replace(/\.\w+$/, `.${realExt}`);
          md = md.replace(`media/${img.filename}`, `media/${newFilename}`);
          img.filename = newFilename;
        }

        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return { filename: img.filename, dataUrl };
      } catch (_) {
        return null; // 下載失敗或被 abort：markdown 保留佔位，但不存檔
      }
    })
  )).filter(Boolean);
  clearInterval(abortPoll);

  // Phase 2 結束後再確認一次 — 被中斷就回報給 background
  if (isAborted()) return abortedResult();

  // ── 穩定 hash 與檔內 meta 註記 ─────────────────────────────────────────────────
  // meta 註記寫在檔尾，讓 background.js 之後可以直接從備份資料夾重建索引
  //（例如擴充套件重裝、chrome.storage 被清除後，仍能正確做增量判斷）。
  const hash = stableContentHash(messages);
  const chatIdMatch = conversationUrl.match(/\/app\/([a-zA-Z0-9_-]+)/);
  const metaId = chatIdMatch ? chatIdMatch[1] : '';
  md += `\n<!-- gemini-backup:v1 hash=${hash} msgs=${messages.length} id=${metaId} -->\n`;

  return {
    title,
    content: md,
    hash,
    url: conversationUrl,
    messages,
    images: fetchedImages, // [{ filename, dataUrl }]
  };
})();
