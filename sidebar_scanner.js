// sidebar_scanner.js - 掃描側邊欄，取得所有對話連結
// 透過 chrome.scripting.executeScript({ files: ['sidebar_scanner.js'] }) 注入
// 回傳格式：{ chatId, url, title, pinned }
//   pinned: true 代表位於 Gemini 側邊欄的「已釘選」區塊
(function scanSidebar() {
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

  // Try to extract a meaningful title from a conversation link element.
  // For regular chats: link text is the conversation title.
  // For Gem chats: link text may just be the Gem name; try to find a more
  // specific label from child elements or aria attributes.
  function extractTitle(el) {
    // 1. Prefer a child element that looks like a conversation-specific title
    for (const sel of [
      '[data-test-id="conversation-title"]',
      '.conversation-title',
      '.chat-title',
      '.item-title',
      '.title',
    ]) {
      const child = el.querySelector(sel);
      if (child?.textContent?.trim()) return child.textContent.trim();
    }

    // 2. aria-label often contains the full descriptive title
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim() && ariaLabel.trim().length > 1) return ariaLabel.trim();

    // 3. Full link text (works for regular chats, fallback for Gem chats)
    const text = el.textContent?.trim();
    if (text && text.length >= 1) return text;

    return '未命名對話';
  }

  // 判斷單一對話連結元素是否為「已釘選」。
  // Gemini 不使用 section header 區分 Pinned，而是在每個釘選項目旁邊顯示釘子圖示。
  // 策略：往上找 list item 容器，再在其中搜尋釘子相關線索。
  function isPinned(linkEl) {
    // 向上最多走 8 層，找到最近的 list item 容器
    let item = linkEl.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!item) return false;
      const tag = item.tagName?.toLowerCase() || '';
      const role = item.getAttribute?.('role') || '';
      if (tag === 'li' || tag === 'mat-list-item' || role === 'listitem' ||
          item.classList?.toString().match(/\bconversation[-_]?item\b/i)) {
        break;
      }
      item = item.parentElement;
    }
    if (!item) return false;

    // Strategy 1: mat-icon 的文字內容（Angular Material 的 push_pin 圖示）
    for (const icon of item.querySelectorAll('mat-icon')) {
      const t = icon.textContent?.trim().toLowerCase();
      if (t === 'push_pin' || t === 'keep') return true;
    }

    // Strategy 2: SVG data-mat-icon-name 屬性（Angular Material 的另一種寫法）
    for (const el of item.querySelectorAll('[data-mat-icon-name]')) {
      if (el.getAttribute('data-mat-icon-name') === 'push_pin') return true;
    }

    // Strategy 3: aria-label 含有 unpin / 取消釘選 等關鍵字（釘選項目才有「取消」選項）
    const UNPIN_KEYWORDS = ['unpin', 'remove pin', '取消釘選', '取消固定', 'désépingler', 'lösen'];
    for (const el of item.querySelectorAll('[aria-label], [title]')) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
      if (UNPIN_KEYWORDS.some(k => label.includes(k))) return true;
    }

    // Strategy 4: data-test-id 含有 pin（Gemini 的 E2E 測試 ID）
    for (const el of item.querySelectorAll('[data-test-id]')) {
      const id = el.getAttribute('data-test-id')?.toLowerCase() || '';
      if (id.includes('pin') && !id.includes('unpin-false')) return true;
    }

    // Strategy 5: CSS class 含有 pinned（最後手段）
    if (item.classList?.toString().toLowerCase().includes('pinned')) return true;
    for (const el of item.querySelectorAll('[class]')) {
      if (el.classList?.toString().toLowerCase().includes('pinned')) return true;
    }

    return false;
  }

  const conversations = [];
  const seen = new Set();

  // Gemini 對話連結的 URL 符合 /app/[chatId] 格式（含 Gem 對話 /gem/xxx/app/[chatId]）
  const linkEls = queryShadowAll(document, 'a[href*="/app/"]');

  for (const el of linkEls) {
    const href = el.getAttribute('href') || el.href || '';
    const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
    if (!match) continue;

    const chatId = match[1];
    if (seen.has(chatId)) continue;
    seen.add(chatId);

    const title = extractTitle(el);
    const fullUrl = href.startsWith('http')
      ? href
      : `https://gemini.google.com${href}`;

    conversations.push({ chatId, url: fullUrl, title, pinned: isPinned(el) });
  }

  return conversations;
})();
