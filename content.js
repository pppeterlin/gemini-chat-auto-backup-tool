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
      if (['script', 'style', 'svg', 'noscript'].includes(tag)) return '';

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
            .map(li => `- ${convert(li).trim()}`)
            .join('\n');
          return `\n${items}\n`;
        }
        case 'ol': {
          const items = Array.from(node.children)
            .filter(c => c.tagName === 'LI')
            .map((li, i) => `${i + 1}. ${convert(li).trim()}`)
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

    return convert(rootEl)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Gemini UI 冗餘標籤清除 ────────────────────────────────────────────────────
  // 「你說了」可能出現在圖片 ref 後面（圖片在 DOM 前面），用全域 replace
  function cleanUserMd(md) {
    return md.replace(/你說了[\s\n]+/g, '').trim();
  }

  function cleanModelMd(md) {
    return md.replace(/^(##\s*)?Gemini\s*說了[\s\n]+/, '').trim();
  }

  // ── 簡單雜湊（用於增量備份偵測）────────────────────────────────────────────────
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  // ── 擷取對話標題 ──────────────────────────────────────────────────────────────
  function getTitle() {
    const testIdEl = document.querySelector('[data-test-id="conversation-title"]');
    if (testIdEl?.textContent?.trim()) return testIdEl.textContent.trim();

    for (const sel of ['.conversation-title', '[data-conversation-title]', '.chat-title']) {
      const el = queryShadowAll(document, sel)[0];
      if (el?.textContent?.trim()) return el.textContent.trim();
    }

    for (const el of queryShadowAll(document, 'a[href*="/app/"]')) {
      if (el.getAttribute('aria-current') === 'page' ||
          el.getAttribute('aria-selected') === 'true') {
        const ariaLabel = el.getAttribute('aria-label')?.trim();
        if (ariaLabel && ariaLabel.length >= 2 && ariaLabel.length <= 200) return ariaLabel;
        const text = el.textContent?.trim();
        if (text && text.length >= 2 && text.length <= 120) return text;
      }
    }

    return document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').trim() || '未命名對話';
  }

  // ── 擷取訊息清單 ──────────────────────────────────────────────────────────────
  function findMessages() {
    const userSelectors = [
      'user-query',
      '.user-query-content',
      '.query-content',
      '[data-message-author-role="user"]',
      '.human-turn',
    ];

    const modelSelectors = [
      'model-response',
      '.model-response-text',
      'response-container .response-content',
      '[data-message-author-role="model"]',
      '.ai-response',
    ];

    let userEls = [];
    let modelEls = [];

    for (const sel of userSelectors) {
      const found = queryShadowAll(document, sel);
      if (found.length) { userEls = found; break; }
    }
    for (const sel of modelSelectors) {
      const found = queryShadowAll(document, sel);
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
  const { userEls, modelEls } = findMessages();

  if (!userEls.length && !modelEls.length) {
    return { title, content: null, hash: '', url: conversationUrl };
  }

  const backupTime = new Date().toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  let md = `# ${title}\n\n`;
  md += `> **備份時間：** ${backupTime}  \n`;
  md += `> **對話連結：** ${conversationUrl}\n\n`;
  md += '---\n\n';

  const messages = [];
  const maxLen = Math.max(userEls.length, modelEls.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < userEls.length) {
      const userMd = cleanUserMd(htmlToMarkdown(userEls[i]));
      messages.push({ role: 'user', markdown: userMd });
      md += `## 使用者\n\n${userMd}\n\n`;
    }
    if (i < modelEls.length) {
      const modelMd = cleanModelMd(htmlToMarkdown(modelEls[i]));
      messages.push({ role: 'model', markdown: modelMd });
      md += `## Gemini\n\n${modelMd}\n\n`;
    }
    if (i < maxLen - 1) md += '---\n\n';
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

  // Phase 2: 並行 fetch — 所有圖片同時下載
  const fetchedImages = (await Promise.all(
    downloadQueue.map(async ({ img, fetchUrl }) => {
      try {
        const resp = await fetch(fetchUrl, { credentials: 'include' });
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
        return null; // 下載失敗：markdown 保留佔位，但不存檔
      }
    })
  )).filter(Boolean);

  return {
    title,
    content: md,
    hash: simpleHash(md),
    url: conversationUrl,
    messages,
    images: fetchedImages, // [{ filename, dataUrl }]
  };
})();
