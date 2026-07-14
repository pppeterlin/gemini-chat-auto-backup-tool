// sidebar_scanner.js - 掃描側邊欄，取得所有對話連結
// 透過 chrome.scripting.executeScript({ files: ['sidebar_scanner.js'] }) 注入
// 回傳格式：{ chatId, url, title, pinned }
//   pinned: true 代表位於 Gemini 側邊欄的「已釘選」區塊
//
// 新版 Gemini 側邊欄項目為 [data-test-id="conversation"]，對話 ID 可能只存在
// jslog 屬性（c_xxxx）而沒有 <a href>；舊版則是 a[href*="/app/"]。
// 兩種來源都掃描後以 chatId 去重合併。
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

  function extractChatIdFromHref(href) {
    const match = (href || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // jslog 屬性內含 "c_<chatId>" 形式的對話 ID
  function extractChatIdFromJslog(value) {
    const match = String(value || '').match(/\bc_([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // Try to extract a meaningful title from a conversation element.
  // For regular chats: link text is the conversation title.
  // For Gem chats: link text may just be the Gem name; try to find a more
  // specific label from child elements or aria attributes.
  function extractTitle(el) {
    // 1. Prefer a child element that looks like a conversation-specific title
    for (const sel of [
      '.title-text',                            // v2 (2026 redesign) — primary
      '[data-test-id="conversation-title"]',
      '.conversation-title-text',
      '.conversation-title',
      '.gds-label-l',
      '.chat-title',
      '.item-title',
      '.title',
      'h3',
    ]) {
      const child = el.querySelector(sel);
      if (child?.textContent?.trim()) return child.textContent.trim();
    }

    // 2. aria-label often contains the full descriptive title
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim() && ariaLabel.trim().length > 1) return ariaLabel.trim();

    // 3. Full element text (works for regular chats, fallback for Gem chats)
    const text = el.textContent?.trim();
    if (text && text.length >= 1) return text;

    return '未命名對話';
  }

  // 判斷單一對話元素是否為「已釘選」。
  // Gemini 把釘選圖示直接放在項目內的 .trailing-icon-container：
  //   pinned   → 含 <mat-icon data-mat-icon-name="push_pin">
  //   unpinned → trailing-icon-container 為空
  // 所以只要在項目自身範圍內找 push_pin icon 即可，不需往上找 list item
  // （往上找會誤抓 sibling 對話的「更多選項」選單裡的 Pin 動作圖示）。
  function isPinned(el) {
    if (!el) return false;
    if (el.querySelector('.trailing-icon-container [data-mat-icon-name="push_pin"]')) return true;
    if (el.querySelector('.trailing-icon-container [fonticon="push_pin"]')) return true;
    if (el.querySelector('[data-mat-icon-name="keep"], [fonticon="keep"]')) return true;
    return false;
  }

  const conversations = [];
  const seen = new Set();

  function addConversation(chatId, url, scopeEl) {
    if (!chatId || seen.has(chatId)) return;
    seen.add(chatId);
    conversations.push({
      chatId,
      url,
      title: extractTitle(scopeEl),
      pinned: isPinned(scopeEl),
    });
  }

  // ── 來源 1：新版側邊欄項目 [data-test-id="conversation"] ─────────────────────
  for (const scope of queryShadowAll(document, '[data-test-id="conversation"]')) {
    const link = scope.matches?.('a[href]') ? scope : scope.querySelector?.('a[href]');
    const href = link?.getAttribute('href') || link?.href || '';
    const chatId =
      extractChatIdFromHref(href) ||
      extractChatIdFromJslog(scope.getAttribute('jslog')) ||
      extractChatIdFromJslog(link?.getAttribute('jslog'));
    if (!chatId) continue;

    const fullUrl = href
      ? (href.startsWith('http') ? href : `https://gemini.google.com${href}`)
      : `https://gemini.google.com/app/${chatId}`;
    addConversation(chatId, fullUrl, scope);
  }

  // ── 來源 2：傳統對話連結 a[href*="/app/"]（含 Gem 對話 /gem/xxx/app/[chatId]）──
  for (const el of queryShadowAll(document, 'a[href*="/app/"]')) {
    const href = el.getAttribute('href') || el.href || '';
    const chatId = extractChatIdFromHref(href);
    if (!chatId) continue;

    const fullUrl = href.startsWith('http')
      ? href
      : `https://gemini.google.com${href}`;
    // pinned 判斷需要涵蓋整個列表項目，優先用外層 conversation scope
    const scope = el.closest('[data-test-id="conversation"]') || el;
    addConversation(chatId, fullUrl, scope);
  }

  return conversations;
})();
