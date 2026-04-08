// i18n.js - 多語言系統
// 支援語言：zh-TW, zh-CN, en, ja, ko, fr, es, pt, ar, ru

class I18n {
  constructor() {
    this.messages = {};
    this.currentLang = 'zh-TW';
    this.defaultLang = 'zh-TW';
    this.supportedLangs = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'fr', 'es', 'pt', 'ar', 'ru'];
  }

  async init() {
    // 從 i18n/messages.json 載入翻譯
    try {
      const response = await fetch(chrome.runtime.getURL('i18n/messages.json'));
      this.messages = await response.json();
    } catch (err) {
      console.error('[i18n] Failed to load messages:', err);
      return;
    }

    // 從 storage 恢復用戶語言偏好
    const { userLanguage } = await chrome.storage.local.get('userLanguage');
    if (userLanguage && this.supportedLangs.includes(userLanguage)) {
      this.currentLang = userLanguage;
    } else {
      // 根據瀏覽器語言自動選擇
      const browserLang = this.detectBrowserLang();
      if (this.supportedLangs.includes(browserLang)) {
        this.currentLang = browserLang;
      }
    }
  }

  // 偵測瀏覽器語言，並對應到支援的語言
  detectBrowserLang() {
    const lang = navigator.language || navigator.userLanguage;
    if (this.supportedLangs.includes(lang)) return lang;

    // 嘗試匹配主語言碼（e.g., 'en' for 'en-US'）
    const mainLang = lang.split('-')[0];
    const match = this.supportedLangs.find(l => l.startsWith(mainLang));
    return match || this.defaultLang;
  }

  // 獲取翻譯字符串
  get(key) {
    if (!this.messages[this.currentLang]) {
      console.warn(`[i18n] Language not loaded: ${this.currentLang}`);
      return key;
    }
    return this.messages[this.currentLang][key] || `[${key}]`;
  }

  // 設定當前語言並保存
  setLanguage(lang) {
    if (!this.supportedLangs.includes(lang)) {
      console.warn(`[i18n] Unsupported language: ${lang}`);
      return;
    }
    this.currentLang = lang;
    chrome.storage.local.set({ userLanguage: lang });
  }

  // 取得當前語言
  getCurrentLanguage() {
    return this.currentLang;
  }

  // 取得所有支援語言及其顯示名稱
  getLanguageList() {
    return [
      { code: 'zh-TW', name: '繁體中文' },
      { code: 'zh-CN', name: '简体中文' },
      { code: 'en', name: 'English' },
      { code: 'ja', name: '日本語' },
      { code: 'ko', name: '한국어' },
      { code: 'fr', name: 'Français' },
      { code: 'es', name: 'Español' },
      { code: 'pt', name: 'Português' },
      { code: 'ar', name: 'العربية' },
      { code: 'ru', name: 'Русский' },
    ];
  }
}

// 全域 i18n 實例
const i18n = new I18n();
