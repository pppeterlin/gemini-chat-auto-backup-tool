// content.js - 在 Gemini 分頁中執行，擷取對話內容並回傳給 background.js
// 透過 chrome.scripting.executeScript({ files: ['content.js'] }) 注入
// 最後一個表達式的值會作為 executeScript 的 result 回傳

(function scrapeGeminiConversation() {
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
      if (['script', 'style', 'button', 'svg', 'noscript'].includes(tag)) return '';

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
        default: return inner();
      }
    }

    return convert(rootEl)
      .replace(/\n{3,}/g, '\n\n')
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

  // ── 擷取對話標題 ──────────────────────────────────────────────────────────────
  function getTitle() {
    // 1. Gemini 的 data-test-id（最穩定，確認存在於實際 DOM）
    const testIdEl = document.querySelector('[data-test-id="conversation-title"]');
    if (testIdEl?.textContent?.trim()) return testIdEl.textContent.trim();

    // 2. 其他明確的對話標題選擇器（穿透 Shadow DOM）
    for (const sel of ['.conversation-title', '[data-conversation-title]', '.chat-title']) {
      const el = queryShadowAll(document, sel)[0];
      if (el?.textContent?.trim()) return el.textContent.trim();
    }

    // 3. 側邊欄中目前選取的對話連結（對 Gem 對話最可靠，避免抓到 Gem 名稱）
    //    優先 aria-label（通常包含完整對話標題），再 fallback 到 textContent
    for (const el of queryShadowAll(document, 'a[href*="/app/"]')) {
      if (el.getAttribute('aria-current') === 'page' ||
          el.getAttribute('aria-selected') === 'true') {
        const ariaLabel = el.getAttribute('aria-label')?.trim();
        if (ariaLabel && ariaLabel.length >= 2 && ariaLabel.length <= 200) return ariaLabel;
        const text = el.textContent?.trim();
        if (text && text.length >= 2 && text.length <= 120) return text;
      }
    }

    // 4. Fallback: 從 <title> 移除 " - Gemini" 後綴
    return document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').trim() || '未命名對話';
  }

  // ── 擷取訊息清單 ──────────────────────────────────────────────────────────────
  function findMessages() {
    // 使用者訊息選擇器（依可能性排序）
    const userSelectors = [
      'user-query',
      '.user-query-content',
      '.query-content',
      '[data-message-author-role="user"]',
      '.human-turn',
    ];

    // Gemini 回應選擇器
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

    // Fallback：嘗試尋找含有 conversation-turn 結構的容器
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
      const userMd = htmlToMarkdown(userEls[i]);
      messages.push({ role: 'user', markdown: userMd });
      md += `## 使用者\n\n${userMd}\n\n`;
    }
    if (i < modelEls.length) {
      const modelMd = htmlToMarkdown(modelEls[i]);
      messages.push({ role: 'model', markdown: modelMd });
      md += `## Gemini\n\n${modelMd}\n\n`;
    }
    if (i < maxLen - 1) md += '---\n\n';
  }

  return {
    title,
    content: md,
    hash: simpleHash(md),
    url: conversationUrl,
    messages,
  };
})();
