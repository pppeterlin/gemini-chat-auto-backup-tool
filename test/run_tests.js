// run_tests.js - 使用 JavaScriptCore (jsc) 執行測試邏輯
// 執行: jsc test/run_tests.js

// ══════════════════════════════════════════════════════════════════════════════
// 模擬瀏覽器環境（jsc 無 DOM）
// ══════════════════════════════════════════════════════════════════════════════

// Mock Node type constants
const Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// Minimal DOM implementation for testing htmlToMarkdown
function createEl(tag, attrs = {}) {
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: Node.ELEMENT_NODE,
    style: {},
    className: attrs.className || '',
    textContent: '',
    children: [],
    childNodes: children,
    getAttribute(name) { return attrs[name] ?? null; },
    querySelector(sel) {
      // Simple: match by tag name only
      const tag = sel.replace(/\..+/, '');
      for (const c of children) {
        if (c.tagName === tag.toUpperCase()) return c;
        if (c.querySelector) { const r = c.querySelector(sel); if (r) return r; }
      }
      return null;
    },
    querySelectorAll(sel) { return []; },
    closest(sel) { return null; },
    appendChild(child) {
      children.push(child);
      el.children.push(child);
      // Update textContent
      el.textContent = children
        .map(c => c.textContent ?? c.nodeValue ?? '')
        .join('');
      return child;
    },
  };
  return el;
}

function createText(text) {
  return { nodeType: Node.TEXT_NODE, textContent: text, nodeValue: text };
}

function createCode(text, lang) {
  const el = createEl('code', { className: lang ? `language-${lang}` : '' });
  el.childNodes.push(createText(text));
  el.textContent = text;
  return el;
}

function createPre(codeText, lang) {
  const pre = createEl('pre');
  const code = createCode(codeText, lang);
  pre.appendChild(code);
  pre.querySelector = (sel) => sel === 'code' ? code : null;
  return pre;
}

// ══════════════════════════════════════════════════════════════════════════════
// 複製 content.js 核心函式（需手動與 content.js 保持同步）
// ══════════════════════════════════════════════════════════════════════════════

function htmlToMarkdown(rootEl) {
  if (!rootEl) return '';
  function convert(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (node.style && node.style.display === 'none') return '';
    if ([
      'script', 'style', 'button', 'svg', 'noscript', 'mat-icon',
      'model-thoughts', 'source-footnote', 'sources-carousel',
      'sources-carousel-inline', 'source-inline-chip', 'tts-control',
      'message-actions', 'sensitive-memories-banner',
    ].includes(tag)) return '';
    const inner = () => Array.from(node.childNodes).map(convert).join('');
    switch (tag) {
      case 'h1': return `\n# ${inner().trim()}\n`;
      case 'h2': return `\n## ${inner().trim()}\n`;
      case 'h3': return `\n### ${inner().trim()}\n`;
      case 'h4': case 'h5': case 'h6': return `\n#### ${inner().trim()}\n`;
      case 'strong': case 'b': { const t = inner().trim(); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = inner().trim(); return t ? `*${t}*` : ''; }
      case 'del': case 's': case 'strike': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }
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
        const items = Array.from(node.children).filter(c => c.tagName === 'LI')
          .map(li => renderListItem(li, '- ')).join('\n');
        return `\n${items}\n`;
      }
      case 'ol': {
        const items = Array.from(node.children).filter(c => c.tagName === 'LI')
          .map((li, i) => renderListItem(li, `${i + 1}. `)).join('\n');
        return `\n${items}\n`;
      }
      case 'li': return inner();
      case 'a': {
        const href = node.getAttribute('href');
        const text = inner().trim();
        if (!href || href.startsWith('javascript:')) return text;
        return `[${text}](${href})`;
      }
      case 'blockquote': return `\n> ${inner().trim().replace(/\n/g, '\n> ')}\n`;
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
  return convert(rootEl).replace(/\n{3,}/g, '\n\n').trim();
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return (hash >>> 0).toString(16);
}

function formatTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}`;
}

function sanitizeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 60).trim() || '未命名對話';
}

// 穩定內容雜湊（同 content.js）：只根據訊息本文計算，不含備份時間戳
function stableContentHash(messages) {
  return simpleHash(messages.map(m => `${m.role} ${m.markdown}`).join(''));
}

// 備份檔尾 meta 註記解析（同 background.js）
function parseBackupMeta(mdText) {
  const m = (mdText || '').match(
    /<!--\s*gemini-backup:v1\s+hash=([0-9a-f]+)\s+msgs=(\d+)(?:\s+id=([a-zA-Z0-9_-]*))?\s*-->/
  );
  if (!m) return null;
  return { hash: m[1], msgs: parseInt(m[2], 10) || 0, id: m[3] || '' };
}

// 對話 ID 擷取（同 background.js / sidebar_scanner.js）
function extractChatId(url) {
  const match = (url || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractChatIdFromJslog(value) {
  const match = String(value || '').match(/\bc_([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 測試框架
// ══════════════════════════════════════════════════════════════════════════════

let passed = 0, failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      print(`  ✅  ${label}`);
      passed++;
    } else {
      print(`  ❌  ${label}`);
      print(`       Got: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (e) {
    print(`  ❌  ${label} — threw: ${e.message}`);
    failed++;
  }
}

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    print(`  ✅  ${label}`);
    passed++;
  } else {
    print(`  ❌  ${label}`);
    print(`       Expected: ${JSON.stringify(expected)}`);
    print(`       Got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(label, str, needle) {
  if (typeof str === 'string' && str.includes(needle)) {
    print(`  ✅  ${label}`);
    passed++;
  } else {
    print(`  ❌  ${label}`);
    print(`       Expected to contain: "${needle}"`);
    print(`       Got: "${String(str).substring(0, 80)}..."`);
    failed++;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 測試案例
// ══════════════════════════════════════════════════════════════════════════════

print('\n══════════════════════════════════════════');
print('  Gemini Chat Backup - 測試套件 (jsc)');
print('══════════════════════════════════════════\n');

// ── Test 1: htmlToMarkdown ─────────────────────────────────────────────────
print('【T1】htmlToMarkdown 轉換器');

const b = createEl('b'); b.childNodes.push(createText('Bold')); b.textContent = 'Bold';
assertEqual('粗體 <b>', htmlToMarkdown(b), '**Bold**');

const em = createEl('em'); em.childNodes.push(createText('ital')); em.textContent = 'ital';
assertEqual('斜體 <em>', htmlToMarkdown(em), '*ital*');

const h2 = createEl('h2'); h2.childNodes.push(createText('Section')); h2.textContent = 'Section';
assertContains('標題 <h2>', htmlToMarkdown(h2), '## Section');

const pre = createPre('print("hi")', 'python');
assertContains('程式碼塊語言標記', htmlToMarkdown(pre), '```python');
assertContains('程式碼塊內容', htmlToMarkdown(pre), 'print("hi")');

const ul = createEl('ul');
['A','B','C'].forEach(t => {
  const li = createEl('li'); li.childNodes.push(createText(t)); li.textContent = t;
  ul.appendChild(li);
});
const mdList = htmlToMarkdown(ul);
assertContains('無序清單 - A', mdList, '- A');
assertContains('無序清單 - C', mdList, '- C');

const ol = createEl('ol');
['First','Second'].forEach(t => {
  const li = createEl('li'); li.childNodes.push(createText(t)); li.textContent = t;
  ol.appendChild(li);
});
const mdOl = htmlToMarkdown(ol);
assertContains('有序清單 1.', mdOl, '1. First');
assertContains('有序清單 2.', mdOl, '2. Second');

const a = createEl('a', { href: 'https://example.com' });
a.childNodes.push(createText('Click')); a.textContent = 'Click';
assertEqual('連結', htmlToMarkdown(a), '[Click](https://example.com)');

const hidden = createEl('div'); hidden.style.display = 'none';
hidden.childNodes.push(createText('secret')); hidden.textContent = 'secret';
assertEqual('隱藏元素忽略', htmlToMarkdown(hidden), '');

const script = createEl('script'); script.childNodes.push(createText('alert(1)')); script.textContent = 'alert(1)';
assertEqual('script 標籤忽略', htmlToMarkdown(script), '');

// ── Test 2: simpleHash ─────────────────────────────────────────────────────
print('\n【T2】simpleHash 雜湊函式');

const h1 = simpleHash('hello world');
const h2_ = simpleHash('hello world');
const h3 = simpleHash('hello world!');

assertEqual('相同輸入→相同雜湊', h1, h2_);
test('不同輸入→不同雜湊', () => h1 !== h3);
test('空字串不崩潰', () => typeof simpleHash('') === 'string');
test('回傳十六進位字串', () => /^[0-9a-f]+$/.test(h1));
test('中文字元', () => typeof simpleHash('測試中文') === 'string');

// ── Test 3: 增量備份偵測 ────────────────────────────────────────────────────
print('\n【T3】增量備份偵測');

const c1 = '# 對話\n\n使用者：你好\n\nGemini：你好！';
const c2 = '# 對話\n\n使用者：你好\n\nGemini：你好！';
const c3 = '# 對話\n\n使用者：你好\n\nGemini：你好！有什麼需要幫忙？';

const stored = {};
function shouldBackup(url, content) {
  const h = simpleHash(content);
  if (stored[url] === h) return false;
  stored[url] = h;
  return true;
}
const url = 'https://gemini.google.com/app/abc123';
test('第一次備份觸發', () => shouldBackup(url, c1) === true);
test('相同內容不重複備份', () => shouldBackup(url, c2) === false);
test('有新訊息後觸發', () => shouldBackup(url, c3) === true);
test('再次相同不觸發', () => shouldBackup(url, c3) === false);

// ── Test 4: formatTimestamp ─────────────────────────────────────────────────
print('\n【T4】formatTimestamp 時間戳記');

const d1 = new Date(2026, 3, 7, 9, 5);
assertEqual('基本格式', formatTimestamp(d1), '20260407_0905');
test('符合正規表達式', () => /^\d{8}_\d{4}$/.test(formatTimestamp(d1)));

const d2 = new Date(2026, 11, 31, 23, 59);
assertEqual('12月31日邊界', formatTimestamp(d2), '20261231_2359');

const d3 = new Date(2026, 0, 5, 8, 3);
assertEqual('個位數補零', formatTimestamp(d3), '20260105_0803');

// ── Test 5: sanitizeFilename ────────────────────────────────────────────────
print('\n【T5】特殊字元檔名清理');

assertEqual('正常標題不變', sanitizeFilename('Python 學習筆記'), 'Python 學習筆記');
assertEqual('斜線→底線', sanitizeFilename('Node.js/Express'), 'Node.js_Express');
assertEqual('冒號→底線', sanitizeFilename('Part 1: Intro'), 'Part 1_ Intro');
assertEqual('問號→底線', sanitizeFilename('What is AI?'), 'What is AI_');
assertEqual('空白→預設值', sanitizeFilename(''), '未命名對話');
test('超長截斷為 60 字元', () => sanitizeFilename('A'.repeat(80)).length === 60);

// ── Test 6: simpleHash collision resistance ─────────────────────────────────
print('\n【T6】雜湊碰撞測試');

const samples = [
  '短訊息', '較長的對話內容，包含很多文字和格式',
  '```python\nprint("hello")\n```', '# 標題\n\n段落內容',
  'A', 'B', 'a', '',
];
const hashes = samples.map(s => simpleHash(s));
const unique = new Set(hashes);
test(`${samples.length} 個不同樣本產生 ${unique.size} 個不同雜湊`, () => unique.size === samples.length);

// ── Test 7: 新增格式（刪除線 / 巢狀清單 / UI 元件忽略）──────────────────────────
print('\n【T7】新增格式轉換');

const del = createEl('del'); del.childNodes.push(createText('gone')); del.textContent = 'gone';
assertEqual('刪除線 <del>', htmlToMarkdown(del), '~~gone~~');

const s = createEl('s'); s.childNodes.push(createText('old')); s.textContent = 'old';
assertEqual('刪除線 <s>', htmlToMarkdown(s), '~~old~~');

// 巢狀清單：ul > li('A' + ul > li('B1'))
const nestedInner = createEl('ul');
const bLi = createEl('li'); bLi.childNodes.push(createText('B1')); bLi.textContent = 'B1';
nestedInner.appendChild(bLi);
const outerLi = createEl('li');
outerLi.childNodes.push(createText('A'));
outerLi.childNodes.push(nestedInner);
outerLi.textContent = 'A';
const outerUl = createEl('ul');
outerUl.appendChild(outerLi);
const nestedMd = htmlToMarkdown(outerUl);
assertContains('巢狀清單外層', nestedMd, '- A');
assertContains('巢狀清單內層縮排', nestedMd, '  - B1');

const thoughts = createEl('model-thoughts');
thoughts.childNodes.push(createText('內部思考過程'));
thoughts.textContent = '內部思考過程';
assertEqual('思考過程 model-thoughts 忽略', htmlToMarkdown(thoughts), '');

const icon = createEl('mat-icon');
icon.childNodes.push(createText('edit'));
icon.textContent = 'edit';
assertEqual('mat-icon 忽略', htmlToMarkdown(icon), '');

// ── Test 8: 穩定內容雜湊（增量判斷核心）─────────────────────────────────────────
print('\n【T8】穩定內容雜湊');

const msgsA = [
  { role: 'user', markdown: '你好' },
  { role: 'model', markdown: '你好！有什麼需要幫忙？' },
];
const msgsB = [
  { role: 'user', markdown: '你好' },
  { role: 'model', markdown: '你好！有什麼需要幫忙？' },
];
const msgsC = [
  ...msgsA,
  { role: 'user', markdown: '再問一個問題' },
];

test('相同訊息（不同時間備份）→ 相同雜湊', () =>
  stableContentHash(msgsA) === stableContentHash(msgsB));
test('新增訊息 → 雜湊改變', () =>
  stableContentHash(msgsA) !== stableContentHash(msgsC));
test('角色不同 → 雜湊不同', () =>
  stableContentHash([{ role: 'user', markdown: 'x' }]) !==
  stableContentHash([{ role: 'model', markdown: 'x' }]));
test('空訊息清單不崩潰', () => typeof stableContentHash([]) === 'string');

// ── Test 9: 備份檔 meta 註記 ────────────────────────────────────────────────────
print('\n【T9】meta 註記解析（本地索引重建）');

const sampleHash = stableContentHash(msgsA);
const metaLine = `<!-- gemini-backup:v1 hash=${sampleHash} msgs=2 id=abc123DEF -->`;
const sampleMd = `# 標題\n\n## 使用者\n\n你好\n\n## Gemini\n\n哈囉\n\n${metaLine}\n`;

const parsed = parseBackupMeta(sampleMd);
test('解析成功', () => parsed !== null);
assertEqual('hash 正確', parsed?.hash, sampleHash);
assertEqual('msgs 正確', parsed?.msgs, 2);
assertEqual('id 正確', parsed?.id, 'abc123DEF');
test('無 meta 註記回傳 null', () => parseBackupMeta('# 只有標題\n\n內文') === null);
test('meta 損毀回傳 null', () => parseBackupMeta('<!-- gemini-backup:v1 hash= -->') === null);

// 舊格式檔案（無 meta）：以段落標題推回訊息數
const legacyMd = '# 舊備份\n\n## 使用者\n\n嗨\n\n## Gemini\n\n嗨！\n\n## 使用者\n\n再見\n';
const headingCount = (legacyMd.match(/^## (使用者|Gemini)$/gm) || []).length;
assertEqual('舊格式訊息數推算', headingCount, 3);

// ── Test 10: 對話 ID 擷取與資料夾匹配 ──────────────────────────────────────────
print('\n【T10】對話 ID 擷取與資料夾匹配');

assertEqual('標準 URL', extractChatId('https://gemini.google.com/app/abc123'), 'abc123');
assertEqual('Gem 對話 URL', extractChatId('https://gemini.google.com/gem/xyz/app/def456'), 'def456');
assertEqual('URL 帶 query', extractChatId('https://gemini.google.com/app/abc123?hl=zh-TW'), 'abc123');
test('非對話 URL 回傳 null', () => extractChatId('https://gemini.google.com/') === null);

assertEqual('jslog 擷取', extractChatIdFromJslog('186014; track:generic_click; BardVeMetadataKey:[["c_9a8b7c6d","r_x"]]'), '9a8b7c6d');
test('jslog 無 ID 回傳 null', () => extractChatIdFromJslog('186014; track:generic_click') === null);

// 資料夾後綴匹配（標題含底線也不誤判）
const folderName = '學習筆記_Part_2_abc123';
test('資料夾後綴匹配 convId', () => folderName.endsWith('_abc123'));
test('不匹配其他 convId', () => !folderName.endsWith('_def456'));

// ── Summary ─────────────────────────────────────────────────────────────────
print('\n══════════════════════════════════════════');
const total = passed + failed;
if (failed === 0) {
  print(`  ✅  全部通過：${passed}/${total} 個測試`);
} else {
  print(`  ❌  ${failed} 個失敗，${passed} 個通過，共 ${total} 個`);
}
print('══════════════════════════════════════════\n');
