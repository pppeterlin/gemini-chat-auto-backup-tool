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
  // Gemini 把釘選圖示直接放在 <a> 內的 .trailing-icon-container：
  //   pinned   → 含 <mat-icon data-mat-icon-name="push_pin">
  //   unpinned → trailing-icon-container 為空
  // 所以只要在 link 自身範圍內找 push_pin icon 即可，不需往上找 list item
  // （往上找會誤抓 sibling 對話的「更多選項」選單裡的 Pin 動作圖示）。
  function isPinned(linkEl) {
    if (!linkEl) return false;
    if (linkEl.querySelector('.trailing-icon-container [data-mat-icon-name="push_pin"]')) return true;
    if (linkEl.querySelector('.trailing-icon-container [fonticon="push_pin"]')) return true;
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
