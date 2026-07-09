# 系統一致性全體審視

對 pharmacy-smart-board 專案進行完整的前後端一致性審視，找出所有矛盾、不一致、潛在 bug。

## 執行步驟

**第一步：讀取合約基準**
- 讀取 `worker.js` 頂部的「資料合約」區塊，取得欄位清單、象限清單、API 期望欄位
- 讀取 `index.html` 中的 `QMETA` 定義與 `TYPE_ICON` 定義

**第二步：逐項核對以下清單**

### A. 欄位名稱一致性
- 搜尋 `index.html` 中所有呼叫 `todoApiCreate(` 的地方，核對傳入的欄位名稱是否符合 worker.js allowedFields
- 特別確認：是否有用 `solution` 而非 `resolution`
- 搜尋所有 `renderNewPhCard`、`renderTodoCard`、`renderPendingNewPhCard` 中讀取的欄位，是否與 KV 儲存欄位名稱一致

### B. /add-visit 呼叫一致性
- 找出 `index.html` 中所有呼叫 `/add-visit` 的地方
- 找出 `field.html` 中所有呼叫 `/add-visit` 的地方
- 對照 worker.js 合約，核對兩者傳入的欄位是否相同、是否都有傳 `pharmacyId`

### C. 象限值一致性
- 取出前端 `QMETA` 的所有 key
- 取出 `worker.js` handleAiTodoSuggest 中 AI prompt 內的象限選項
- 確認兩者列出的值是否一致

### D. worker.js PUT allowedFields 完整性
- 找出 `handleTodosV2` 中的 `allowedFields` 陣列
- 對照合約欄位清單，確認每個欄位都在 allowedFields 中

### E. index.html vs field.html 同步性
- 對比兩個頁面中「拜訪目的」下拉選項是否一致
- 確認兩個頁面的打卡/新增拜訪流程邏輯是否對齊

**第三步：輸出報告**

用以下格式列出每個問題：
```
🔴/🟠/🟡 [嚴重程度]
問題：[清楚說明矛盾在哪裡]
涉及：[檔案名稱:行號]
修正：[建議改法]
```

最後統計：高風險 X 個、中風險 X 個、低風險 X 個

**第四步：詢問使用者**

「以上共發現 X 個問題，是否要全部修正？」
