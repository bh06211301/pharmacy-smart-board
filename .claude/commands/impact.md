# 新需求影響範圍分析

在實作任何新功能前，先分析影響範圍，列出所有需要同步修改的地方，避免遺漏造成前後端矛盾。

## 使用方式

用一句話描述你的需求，然後呼叫這個指令。
例如：`/impact 新增一個「聯絡電話」欄位到新開藥局卡片`

## 執行步驟

**第一步：讀取合約**
- 讀取 `worker.js` 頂部「資料合約」區塊，了解現有欄位與 API 結構

**第二步：依需求類型分析影響**

### 如果是「新增欄位到待辦事項」
需要同步修改：
1. `worker.js` — `handleTodosV2` POST 的 `newTodo` 物件初始化（加入新欄位）
2. `worker.js` — PUT 的 `allowedFields` 陣列（讓前端可以更新此欄位）
3. `worker.js` — 頂部「資料合約」區塊（更新文件）
4. `index.html` — `todoApiCreate` 呼叫處（視情況補上欄位）
5. `index.html` — `renderTodoCard` / `renderNewPhCard`（若需要顯示）
6. `index.html` — `quickAddNewPh`（若新藥局也需要此欄位）
7. `CLAUDE.md` — 待辦資料結構欄位清單

### 如果是「新增/修改 API endpoint」
需要同步修改：
1. `worker.js` — 新增路由與 handler
2. `index.html` — 所有需要呼叫此 API 的地方
3. `field.html` — 若外勤模式也需要此功能
4. `CLAUDE.md` — 後端 Endpoints 清單

### 如果是「新增象限/任務類型」
需要同步修改：
1. `index.html` — `QMETA` 物件
2. `index.html` — `renderEisenhower` 的迴圈清單
3. `index.html` — HTML 中的 ondrop 目標區塊
4. `index.html` — 新增待辦 Modal 的 `<select>` 選項
5. `worker.js` — `handleAiTodoSuggest` 的 AI prompt 象限說明
6. `worker.js` — 頂部「資料合約」有效象限值

### 如果是「修改拜訪紀錄流程」
需要同步修改：
1. `index.html` — `submitNewVisit` 函式
2. `field.html` — 打卡送出函式
3. `worker.js` — `handleAddVisit` 的 gasPayload
4. Google Apps Script — `VisitAppWebhook.js`（若有欄位變更）

**第三步：輸出清單**

列出所有需要修改的地方，格式如下：
```
待修改清單（共 X 處）：
☐ worker.js — [具體說明]
☐ index.html — [具體說明]
☐ field.html — [具體說明（若需要）]
☐ CLAUDE.md — [具體說明（若需要）]
```

**第四步：確認後再實作**

輸出清單後，問使用者：「確認這個範圍後開始實作？」
等使用者確認再動手，不要直接開始改 code。
