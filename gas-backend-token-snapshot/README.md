# gas-backend token 保護版本快照

`gas-backend/` 本身不是 git repo（只用 clasp push/deploy），沒辦法真的把那邊的改動放進 git 分支。
這個資料夾存的是 `feature/planner-token` 分支新增的 token 驗證邏輯套用在
`PlannerActions.js`、`VisitAppWebhook.js` 的完整版本快照，供之後要部署這個功能時參考比對。

## 部署步驟（密鑰設定好之後）

1. 把這兩個檔案的內容複製覆蓋回 `開發業務工具/gas-backend/PlannerActions.js`、
   `開發業務工具/gas-backend/VisitAppWebhook.js`（那邊才是 clasp 實際會 push 的位置）。
2. 確認三處密鑰已經設定好且值一致：
   - GAS 指令碼屬性 `PLANNER_API_TOKEN`（AppSheet_AI_Backend 專案，專案設定→指令碼屬性）
   - `wrangler secret put PLANNER_API_TOKEN`（正式環境）
   - `pharmacy-smart-board/.dev.vars` 加一行 `PLANNER_API_TOKEN=同樣的值`（本機測試用）
3. `cd gas-backend && npx @google/clasp push && npx @google/clasp deploy -i AKfycbxBDS60OKaAhxeS53qrN7O1TbbN_wHSaJgwKJeFVjgr8ZuxpS-RV6aRu-uEwTJwKvzN9g -d "說明"`
   （用 `-i` 更新既有部署，不要新增部署）
4. 把這個分支的 `worker.js`（`handlePlannerRules`/`handlePlannerFollowups` 讀 `env.PLANNER_API_TOKEN`
   代填）合併或複製回主要工作分支，並用 `wrangler dev` 重新驗證一次新增/完成待追蹤。

對應的 CLAUDE.md 待辦：「PLANNER_API_TOKEN 密鑰保護已寫好在 feature/planner-token，需先設定 GAS
指令碼屬性、wrangler secret、.dev.vars 三處後才能部署。」
