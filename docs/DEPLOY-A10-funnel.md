# A10 新店開發：部署清單

> 部署時間由你決定。涵蓋三個獨立專案：`gas-backend`、`new-pharmacy-screening`、`pharmacy-smart-board`（Worker + 前端）。
> 這份清單涵蓋的改動都已經過 `wrangler dev` + 本機 mock GAS 伺服器端對端測試（2026-11-02，覆蓋 keep/advance/drop/confirmed
> 四種動作、以及「篩選分頁寫入失敗→doGet 核對→決定要不要回滾」的全部 3 種核對結果），GAS 兩專案的新函式也都在
> Apps Script 編輯器手動跑過全綠（`testStageHistory`、`testFunnelStageAction`，含既有回歸測試）。

---

## 0. 部署前狀態快照（先做，部署後才知道要退回哪個版本）

| # | 步驟 | 備註 |
|---|---|---|
| 0.1 | 記錄 gas-backend 的 `GAS_VISIT_URL` 部署前版本號 | 2026-11-02 查過：deployment id `AKfycbxBDS60OKaAhxeS53qrN7O1TbbN_wHSaJgwKJeFVjgr8ZuxpS-RV6aRu-uEwTJwKvzN9g` 對應 `@30`（標籤「scheduleAction改名+拜訪紀錄表寫入保護+token保護」）。部署前再查一次確認沒有變動 |
| 0.2 | 記錄 new-pharmacy-screening 的 `SCREENING_API_URL` 部署前版本號 | 2026-11-02 查過：deployment id `AKfycbyUJrKP1PsAOsQx8sVnJE5dwMhsn7LdEdZctsP_Y_T8em7AM5BtubDDpR1eL-1ZLxUNuQ` 對應 `@2`（標籤「SmartRoute v2 第1階段：新店階段追蹤3欄」） |
| 0.3 | 記錄 `still-meadow-0efd` 部署前的版本 id | 2026-11-02 查過：目前 100% 流量版本 `417746e8-86c8-4119-b3a1-17164d34b45b`（2026-11-01 建立），回退用 `npx wrangler rollback 417746e8-86c8-4119-b3a1-17164d34b45b` |

---

## 1. gas-backend（AppSheet_AI_Backend）

| # | 步驟 | 備註 |
|---|---|---|
| 1.1 | 程式碼已經 `clasp push` 到編輯器（2026-11-02 完成，不用再 push） | 跟手動測試用的是同一份，已驗證 `testStageHistory`／`testPlannerActions`／`testVisitGuardRejectsIncomplete` 全綠 |
| 1.2 | `cd gas-backend && npx @google/clasp deployments`，找到 `GAS_VISIT_URL` 對應的 deployment id | 部署前再查一次，避免跟 0.1 之間有人手動改過部署 |
| 1.3 | `npx @google/clasp deploy -i <deploymentId> -d "A10新店開發：階段歷程寫入（addStageHistory/deleteStageHistory）"` | 這步之後 `GAS_VISIT_URL` 才會真的生效新 action |
| 1.4 | Apps Script 編輯器「部署 → 管理部署」確認存取權限仍是「所有人」 | 每次改部署設定都要重新核對這點 |

**回退方式**：`clasp` 沒有直接的部署版本回退指令，在「管理部署」介面手動把同一個 deployment 指回 0.1 記下的舊版本號。

---

## 2. new-pharmacy-screening

| # | 步驟 | 備註 |
|---|---|---|
| 2.1 | 程式碼已經 `clasp push` 到編輯器（2026-11-02 完成，不用再 push） | 已驗證 `testFunnelStageAction`／`testAutoStageLogic` 全綠 |
| 2.2 | `cd new-pharmacy-screening/apps-script && npx @google/clasp deployments`，找到 `SCREENING_API_URL` 對應的 deployment id | 同 0.2，部署前再查一次 |
| 2.3 | `npx @google/clasp deploy -i <deploymentId> -d "A10新店開發：stageAction(advance/drop/confirm)"` | 這步之後 `SCREENING_API_URL` 才會真的生效新邏輯 |
| 2.4 | 確認存取權限仍是「所有人」 | 同上 |

**回退方式**：同上，在「管理部署」介面指回 0.2 記下的舊版本號。

---

## 3. pharmacy-smart-board（Worker + 前端）

### 3.1 Worker

| # | 步驟 | 備註 |
|---|---|---|
| 3.1.1 | 確認 `wrangler.toml` `[vars]` 沒有缺漏 | 這次沒有新增環境變數，只新增 2 個端點＋改既有 `/api/plan` 的新店倍數起算日邏輯 |
| 3.1.2 | 確認 secrets 已就緒 | 2026-11-02 唯讀查過（`wrangler secret list`）：正式環境已經有 `PLANNER_API_TOKEN`、`SCREENING_API_TOKEN`、`GEMINI_API_KEY`、`OPENROUTER_KEY` 四個，這次不用新增任何 secret |
| 3.1.3 | `npx wrangler deployments status`，記下目前 100% 流量的版本 id | 部署前再查一次確認跟 0.3 一致，沒有其他人同時改過 |
| 3.1.4 | `npx wrangler deploy` | 部署 `worker.js`：新增 `GET /api/funnel/overview`、`POST /api/funnel/result`；`GET /api/plan` 的新店倍數起算日改用「最近一筆階段歷程日期」 |
| 3.1.5 | `curl https://still-meadow-0efd.bh06211301.workers.dev/health` 確認基本健康檢查 | 不能只看 deploy 指令沒報錯就當作沒事 |

**回退方式**：`npx wrangler rollback <3.1.3 記下的 id>`。Secrets／KV／R2 內容不受影響。

### 3.2 前端（GitHub Pages）

| # | 步驟 | 備註 |
|---|---|---|
| 3.2.1 | `git status` 核對要加的檔案 | ⚠️ **目前工作目錄還有跟這次無關的異動**：`apple-preview/*.html` 被刪除、`.claude/commands/`、`盤點QRcode.png`、`自定義指令說明.md` 等未追蹤檔案——這些不是 A10 的一部分，**不要用 `git add -A`** |
| 3.2.2 | 只加這次相關的檔案：`funnel.html`（新）、`planner-nav.js`、`worker.js`、`planner-config.js`、`docs/SPEC.md`、`docs/DEPLOY-2026-11.md`、`docs/DEPLOY-A10-funnel.md` | |
| 3.2.3 | 確認 `.dev.vars`、`CLAUDE.md`、`screenshots/` 沒有被加進來 | 已經在 `.gitignore`，部署前再看一次 `git status` 確認 |
| 3.2.4 | `git add` 上述指名的檔案 → `git commit` → `git push` | GitHub Pages 自動更新，`funnel.html` 上線，主選單「新店開發」連結生效 |

**回退方式**：`git revert <commit>` 再 push，不用 `git reset --hard`（`main` 是共用分支）。

---

## 4. 部署順序與依賴關係

- Worker 的 `POST /api/funnel/result` 會呼叫 gas-backend 的 `addStageHistory` 跟 new-pharmacy-screening 的 `stageAction`，**兩個 GAS 都部署完，Worker 才能正常運作**；反過來兩個 GAS 先部署、Worker 還沒部署沒有風險（新增的 action 不會被任何現有呼叫端誤觸發）。
- 前端 `funnel.html` 依賴 Worker 的新端點，**Worker 部署完，前端才有意義**；前端先部署也沒風險（主選單連結點過去只會看到 API 404，不影響其他頁面）。

建議順序：**1（gas-backend）→ 2（new-pharmacy-screening）→ 3.1（Worker）→ 3.2（前端）**，任一步有問題就停下來回報，不要往下做。

---

## 5. 部署後驗證（你操作）

| # | 項目 | 預期結果 |
|---|---|---|
| 5.1 | 打開 `funnel.html`，確認六欄看板、頂部數字正常顯示 | 跟 2026-11-02 的截圖一致 |
| 5.2 | 挑一家真實開發中新店（例如寶安藥局），「記結果」→「維持」→確認送出 | 篩選分頁該店「進入階段日期」不變；「階段歷程」分頁多一筆「從＝到＝目前階段」 |
| 5.3 | 同一家店再「記結果」→「推進」→確認送出 | 篩選分頁該店「目前階段」真的推進一階；「階段歷程」多一筆 |
| 5.4 | 隨便一家開發中新店按「排進某天」，選一個日期送出 | A3 待追蹤頁看得到這筆，期限類型「指定日期前」 |
| 5.5 | **木木好藥局（id `ce73d892dd`）按「確認已建檔」，填入 `C137`，送出** | 篩選分頁該列「目前階段」變「轉正式」；「階段歷程」多一筆「正式代號=C137」；之後 A10 頂部「轉正式家數」變成 1。**這一步同時是功能驗證、也是補正 SPEC 第 11 節待辦記錄的木木好藥局真實資料缺口**，不用另外跑一次性腳本 |

全部通過才算這次部署完成；任一項失敗，先回報再決定是否要照上面的回退方式退回。
