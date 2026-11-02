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
| 1.4 | Apps Script 編輯器「部署 → 管理部署」確認存取權限仍是「所有人」 | 每次改部署設定都要重新核對這點，**你操作** |
| 1.5 | `curl` GET `GAS_VISIT_URL`（`doGet` 只回 `{status:'ok'}`，不是寫入）確認基本回應正常 | 2026-11-02 補：拜訪紀錄 App 下午要用這支 GAS，部署後先確認沒壞 |

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

**2026-11-02 部署當下的實際狀況（@3 出過問題，補修到 @4）**：

2.3 部署成 `@3` 後，照 1.5 的習慣順手做了一次唯讀 curl GET 核對，發現回應變成 Google 登入頁（926KB HTML），不是預期的 JSON——`SCREENING_API_URL` 當下真的斷了。查證過程：先排除網路/curl問題（同時測 `GAS_VISIT_URL` 還正常）、排除生效延遲（重試超過35秒都一樣），最後用 Apps Script API 直接查兩個專案的 `projects.deployments.get`，找到根因：**`gas-backend` 的 `access` 是 `ANYONE_ANONYMOUS`（真公開），`new-pharmacy-screening` 本機 `appsscript.json` 裡寫的是 `ANYONE`**——這兩個名字長得很像但完全不同（`ANYONE` 在 Apps Script API 裡的實際意思是「需要 Google 帳號登入才能用」，不是「任何人」）。

這個錯值**不是這次改動造成的，是本機檔案早就存在的舊錯誤**：`@2`（原始部署）當初建立時用的是正確值，部署版本建立後就凍結，manifest 後來跑偏成 `ANYONE` 也不會影響已經存在的 `@2`；一直到這次 `clasp deploy -i` 建立全新的 `@3`，才把「當下的」manifest 值真正烤進新版本，問題才第一次浮現。影響範圍：`@3` 存活期間（約7分鐘）`SCREENING_API_URL` 需要登入才能打，當時還在線上的 `worker.js`（舊版）呼叫這支時 `.then(r => r.json())` 會因為收到 HTML 而拋錯，`/api/plan` 這段時間應該會直接噴錯——沒有任何資料被寫壞或遺失，純粹是讀取端短暫不可用。

修法：把本機 `appsscript.json` 的 `access` 改回 `ANYONE_ANONYMOUS` → `clasp push`（一般 push 顯示「Skipping push」，是非互動模式下對 manifest/權限變更的確認提示被自動略過，改用 `clasp push --force` 才真的推上去）→ 用 Apps Script API 唯讀核對編輯器裡的內容確實已經更新 → 重新 `clasp deploy -i` 同一個 deployment（`@3→@4`）→ 唯讀核對 `entryPointConfig.access` 確實是 `ANYONE_ANONYMOUS` → curl 確認恢復正常（`rows: 59`，跟修復前筆數一致）。2.4 使用者在 Apps Script 編輯器肉眼複查過 `@4` 存取權限，確認是「所有人」。

**教訓（已經寫進 SPEC.md 第11節，另一條記錄「兩個 repo 都沒有遠端備份」）**：這個 bug 能悄悄存在的根本原因是 `new-pharmacy-screening` 當時完全沒有 git 版控，manifest 什麼時候跑偏、是誰改的，完全沒有歷史可查。部署當天已經補上本機 git（`new-pharmacy-screening` 新建 repo＋第一個 commit，`gas-backend` 補 commit 了一直沒進版控的 11/1＋A10 兩批改動並合併回 main），但兩個都還只在本機、沒有遠端備份，之後需要單獨評估。**以後任何 Apps Script 專案的 `clasp deploy -i` 之前，建議先核對本機 manifest 的 `webapp.access` 是不是 `ANYONE_ANONYMOUS`（不是 `ANYONE`），不要只在部署完才用 curl 事後發現。**

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
| 3.1.6 | `curl .../api/plan`，確認 `recommended` 筆數還是 60（53 正式客戶＋7 新店）、`badges.newStoreStuck` 還是 7 | 2026-11-02 補：倍數起算日邏輯改了（見 3.1.4），正式資料還沒有任何階段歷程，這兩個數字部署前後應該完全不變——不一樣就代表邏輯有問題，要停下來查 |

**回退方式**：`npx wrangler rollback <3.1.3 記下的 id>`。Secrets／KV／R2 內容不受影響。

### 3.2 前端（GitHub Pages）

**2026-11-02 改法**：這次的 7 個檔案已經在 `feature/a10-funnel` 分支上 commit 並推到遠端，不在 `main` 工作目錄重新指名 `git add`（工作目錄還有 `apple-preview/*.html` 刪除、`.claude/commands/` 等跟這次無關的異動，維持不動、不進這次的 commit）。改成合併分支：

| # | 步驟 | 備註 |
|---|---|---|
| 3.2.1 | `git checkout main && git merge feature/a10-funnel` | 有衝突就停下來回報，不自己判斷怎麼解 |
| 3.2.2 | 合併後 `wrangler dev` 跑一次，確認 A1（`planner.html`）、A10（`funnel.html`）都正常載入、資料正常 | 這一步通過才繼續，不是合併完就直接推 |
| 3.2.3 | 確認 `.dev.vars`、`CLAUDE.md`、`screenshots/` 沒有被帶進來 | 已經在 `.gitignore`，推前再看一次 `git status` 確認 |
| 3.2.4 | `git push` | GitHub Pages 自動更新，`funnel.html` 上線，主選單「新店開發」連結生效 |

**回退方式**：`git revert <merge commit>` 再 push，不用 `git reset --hard`（`main` 是共用分支）。

---

## 4. 部署順序與依賴關係

- Worker 的 `POST /api/funnel/result` 會呼叫 gas-backend 的 `addStageHistory` 跟 new-pharmacy-screening 的 `stageAction`，**兩個 GAS 都部署完，Worker 才能正常運作**；反過來兩個 GAS 先部署、Worker 還沒部署沒有風險（新增的 action 不會被任何現有呼叫端誤觸發）。
- 前端 `funnel.html` 依賴 Worker 的新端點，**Worker 部署完，前端才有意義**；前端先部署也沒風險（主選單連結點過去只會看到 API 404，不影響其他頁面）。

建議順序：**1（gas-backend）→ 2（new-pharmacy-screening）→ 3.1（Worker）→ 3.2（前端）**，任一步有問題就停下來回報，不要往下做。

---

## 5. 部署後驗證（你操作）

**2026-11-02 改法：「維持」「推進」會寫入真實業務紀錄（推進會真的改篩選分頁階段、維持會讓那家店倍數歸零重算），
沒有真的拜訪不能按——這兩項延後到你實際拜訪新店時再驗證，不是這次部署的一部分。** 這次部署當下只驗 5.1、5.4、5.5。

| # | 項目 | 預期結果 | 結果 |
|---|---|---|---|
| 5.1 | 打開 `funnel.html`，確認六欄看板、頂部數字正常顯示 | 跟 2026-11-02 的截圖一致 | ✅ |
| 5.4 | 挑一家你真的要去的開發中新店，按「排進某天」，選一個你真的打算去的日期送出 | A3 待追蹤頁看得到這筆，期限類型「指定日期前」 | ✅ A3 出現、主選單待追蹤徽章顯示 1 |
| 5.5 | **木木好藥局（id `ce73d892dd`）按「確認已建檔」，填入 `C137`，送出** | 篩選分頁該列「目前階段」變「轉正式」；「階段歷程」多一筆「正式代號=C137」；之後 A10 頂部「轉正式家數」變成 1。**這一步同時是功能驗證、也是補正 SPEC 第 11 節待辦記錄的木木好藥局真實資料缺口**，不用另外跑一次性腳本 | ✅ |

**5.5 收尾唯讀驗證（2026-11-02，事後用 gviz／doGet 查正式資料確認，沒有寫入任何東西）**：
- 「階段歷程」分頁：`事件ID=Ha1bc6975｜店代號=ce73d892dd｜店名=木木好藥局｜從階段=初訪後｜到階段=轉正式｜日期=2026-11-02｜來源=A10｜正式代號=C137`，只有這一筆，沒有多餘測試列。
- 「篩選」分頁：id=`ce73d892dd` 那列 `目前階段=轉正式`、`進入階段日期=2026-11-02`，總筆數仍是 59（沒有新增/遺失列）。
- `/api/funnel/overview`：`top.convertedInPeriod=1`、`top.developing=11`，轉正式欄卡片 `customerId:"C137"`，跟篩選/階段歷程兩邊資料一致。

**部署後追加的兩個畫面問題（2026-11-02 使用後發現，已修好並重新部署驗證）**：
1. 六欄看板太寬、「放棄」欄被切掉拉不過去——改成六欄平均分配寬度（不再沿用 A1 三欄用的 `--sr-col-min`），900px 以下自動上下堆疊。
2. 「轉正式」「放棄」是終點階段，卡片不該再顯示倍數/下一步/操作按鈕——改顯示正式代號／放棄原因；`worker.js` 的 `/api/funnel/overview` 卡片同步補上 `customerId`／`dropReason` 兩個欄位（沿用既有的階段歷程/篩選分頁資料，沒有新增呼叫或端點）。
兩項都在 `wrangler dev` 用 Playwright 截圖（1440px 寬螢幕、500px 窄螢幕）驗證過，使用者確認後才 `wrangler deploy`（部署前版本 `16708e1a-4720-4d3d-88ec-cbf4ad20d485`，部署後 `91acfbd5-60e9-48e0-95c6-9bbad4fe8957`）＋ push main＋確認 GitHub Pages 更新。

**延後驗證（等實際拜訪新店時再做，不是這次部署範圍）**：
| # | 項目 | 預期結果 |
|---|---|---|
| 5.2 | 挑一家真實開發中新店，「記結果」→「維持」→確認送出 | 篩選分頁該店「進入階段日期」不變；「階段歷程」分頁多一筆「從＝到＝目前階段」 |
| 5.3 | 同一家店再「記結果」→「推進」→確認送出 | 篩選分頁該店「目前階段」真的推進一階；「階段歷程」多一筆 |

**2026-11-02 部署完成。** 第 1～3 節、5.1/5.4/5.5 全部通過。5.2、5.3 等使用者實際拜訪新店時再驗證，不是這次部署的一部分。
