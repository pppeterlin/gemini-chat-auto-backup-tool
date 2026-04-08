// sidebar_scanner.js - 掃描側邊欄，取得所有對話連結
// 透過 chrome.scripting.executeScript({ files: ['sidebar_scanner.js'] }) 注入
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

  const conversations = [];
  const seen = new Set();

  // Gemini 對話連結的 URL 符合 /app/[chatId] 格式
  const linkEls = queryShadowAll(document, 'a[href*="/app/"]');

  for (const el of linkEls) {
    const href = el.getAttribute('href') || el.href || '';
    const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
    if (!match) continue;

    const chatId = match[1];
    if (seen.has(chatId)) continue;
    seen.add(chatId);

    const title = el.textContent.trim() || el.getAttribute('aria-label') || '未命名對話';
    const fullUrl = href.startsWith('http')
      ? href
      : `https://gemini.google.com${href}`;

    conversations.push({ chatId, url: fullUrl, title });
  }

  return conversations;
})();
