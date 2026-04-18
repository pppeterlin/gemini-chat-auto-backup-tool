# **✨Gemini 對話擷取器（一鍵導出txt）**

Created by [kumatei](https://www.threads.com/@kumatei16)

**TL;DR**：把這段 JavaScript 存成書籤 → 打開 Gemini 對話 → 點書籤 → 整段對話就會自動下載成 .txt。記得先從頭滑到尾，確保全部訊息都載入。

---

### **💻 首次使用設定方法**

**電腦版 (Chrome, Safari 均可)：**

1. 打開瀏覽器 → 進入 Gemini 網頁版 對話頁面 
⚠️ 一定要先把對話從頭滑到尾，確保每一則訊息都有載入。
2. 在上方選單列，點 **Bookmarks → Bookmark manager**
    
    （中文介面：**書籤 → 書籤管理員**）
    
3. 然後點右上角三點 **Add new bookmark（新增書籤）**，名稱可自訂，例如：Gemini 對話擷取器
4. 在「網址」欄位貼上下方程式碼→ **Save (儲存)**
5. 回到 Gemini 對話頁面，點該書籤 → 系統自動擷取對話，下載成 txt
    
    *書籤只需儲存一次，以後每個對話都可以用。*
    

---

### **📜 Gemini 對話擷取器－程式碼**

```jsx
javascript:(function() {
    /*
     * Author: kumatei
     * Created on: 2025-09-08
     * Description: A bookmarklet to export Gemini conversations.
     */

    const expandButtonSelector = 'button[aria-label="Expand"]';
    const expandButtons = document.querySelectorAll(expandButtonSelector);

    if (expandButtons.length > 0) {
        expandButtons.forEach(button => button.click());
    }

    setTimeout(() => {
        const output = [];
        const seen = new Set();
        const turns = document.querySelectorAll('.query-content, .response-content');

        turns.forEach(turn => {
            let label = '';
            let text = '';

            if (turn.classList.contains('query-content')) {
                label = '【You】';
                const lineElements = turn.querySelectorAll('.query-text-line');
                text = Array.from(lineElements).map(p => p.innerText).join('\n').trim();
                
            } else if (turn.classList.contains('response-content')) {
                label = '【Gemini】';
                const textElement = turn.querySelector('.markdown');
                if (textElement) {
                    text = textElement.innerText.trim();
                }
            }

            if (label && text && !seen.has(text)) {
                seen.add(text);
                output.push(`${label}\n${text}`);
            }
        });

        const fullConversation = output.join('\n\n————————————————————\n\n');
        if (fullConversation) {
            const blob = new Blob([fullConversation], { type: 'text/plain;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'gemini_conversation.txt';
            link.click();
            URL.revokeObjectURL(link.href);
        } else {
            alert('Failed to capture content. The page structure may have changed.');
        }
    }, 1500);

})();
```

💡 **Credit**：靈感來自 ChatGPT 對話擷取器，感謝原創[@dami0130](https://www.threads.com/@dami0130?igshid=NTc4MTIwNjQ2YQ%3D%3D)  & [@kiyokawa.ma](https://www.threads.com/@kiyokawa.ma?igshid=NTc4MTIwNjQ2YQ%3D%3D)