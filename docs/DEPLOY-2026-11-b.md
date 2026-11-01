# A2 搜尋/新增規則 + 三頁共用主選單：部署清單（第二批）

> 部署日自行決定。這份文件不含任何密鑰值。
> 涵蓋範圍：`feature/a2-search-nav` 分支（A2 左側店家搜尋框、頁頂「＋新增規則」、
> `followups.html` 隨手新增店名搜尋改用共用元件、A1/A2/A3 共用主選單＋「新店開發」徽章）。
> **這次只動 Worker＋前端，GAS 完全不動**——沒有新的 action、沒有新的 token 需求、沒有新的
> script property，`docs/DEPLOY-2026-11.md` 上一批已經把 GAS 部署過一次，這次不用重跑那份清單。

---

## 0. 部署前檢查

- [ ] 這次 `worker.js` 唯一的改動是 `/api/plan` 回應多了 `badges.newStoreStuck` 一個欄位（純新增，
      既有欄位都沒變），沒有新增/修改任何 wrangler secret 或 `[vars]`，第一批部署清單核對過的
      bindings／secrets 這次不用重查。
- [ ] 確認 `feature/a2-search-nav` 是從正確的 `origin/main`（`230ad32`）開出來的（2026-11-01 查過，
      過程中一度誤從本機舊 `main` 開分支，已經用 `git reset --hard origin/main` 修正過），不是從
      某個更舊的版本接出來的。

---

## 1. Cloudflare（`still-meadow-0efd`）

| # | 步驟 | 備註 |
|---|---|---|
| 1.1 | **先記下來**：`npx wrangler deployments status`，記下目前 100% 流量的 version id | 部署前的狀態快照，回退時優先切回這個 id。寫這份清單當下查到的是 `082e83f2-ec0c-42f4-b585-051b3bfcc107`（2026-11-01 第一批部署的結果），但部署當天要重新查一次，不要直接沿用這個數字——中間可能又有別的改動 |
| 1.2 | `npx wrangler deploy` | 這次沒有新 secret 要補，直接部署 |
| 1.3 | `curl https://still-meadow-0efd.bh06211301.workers.dev/health` 確認健康檢查正常 | 同上一批的做法 |
| 1.4 | 另外用 `curl .../api/plan` 看一下 `badges.newStoreStuck` 這個新欄位有沒有出現、數字看起來合理 | 這是這次唯一的 worker.js 改動，單獨確認一下 |

**Cloudflare 回退方式**：`npx wrangler rollback [1.1 記下的 id]`，即可切回部署前那一版。

---

## 2. 前端（GitHub Pages，`pharmacy-smart-board` repo）

| # | 步驟 | 備註 |
|---|---|---|
| 2.1 | 本機先把 `main` 合併進 `feature/a2-search-nav`（`git merge main`） | 這個分支是從 `origin/main` 開出來的，`main` 這段期間如果沒有其他新 commit，這裡應該是 fast-forward，不會有衝突；如果真的有衝突，停下來回報，不要自己判斷怎麼解（比照上一批的規則） |
| 2.2 | 合併後用 `wrangler dev` 跑一次，確認 A1/A2/A3 都正常載入、主選單跟徽章數字三頁一致 | 通過才繼續，不是合併完就直接推 |
| 2.3 | 都正常才把合併結果快轉回 `main`（`git checkout main && git merge feature/a2-search-nav`） | |
| 2.4 | 確認 `.dev.vars`、`CLAUDE.md`、`screenshots/` 都沒有被加進這次要推的內容 | |
| 2.5 | `git push` 到 `main` | GitHub Pages 自動更新上線 |

**前端回退方式**：`git revert <merge commit>` 再 `git push`。不用 `git reset` 強制推。

---

## 3. 驗證（你操作，Claude 不會代為執行任何寫入）

| # | 驗證項目 | 預期結果 |
|---|---|---|
| 3.1 | 開 A1（`planner.html`）、A2（`store-rules.html`）、A3（`followups.html`），比對三頁主選單 | 分頁籤、「管理」連結、「切回舊版」連結長得一樣，目前所在頁面有標示（底線＋粗體） |
| 3.2 | 比對三頁的「客戶」「新店開發」「待追蹤」徽章數字 | 三頁數字完全一致；0 的徽章不顯示 |
| 3.3 | A2：左側搜尋框輸入店名或代號 | 清單即時過濾；切「有規則／全部」膠囊時搜尋文字不會被清空 |
| 3.4 | A2：頁頂「＋新增規則」，搜尋一家真實店，新增**一條真實規則**（內容你到時候決定），新增後保留不動 | 新增成功，店家清單裡看得到這條規則 |
| 3.5 | A3：隨手新增那排的店名搜尋框，搜尋並選一家店 | 下拉候選正常出現、點選後「已選：」文字正常顯示（這段改成呼叫共用元件，要確認行為沒變） |

全部通過才算這次部署完成。任一項失敗，先回報再決定是否要照上面的回退方式退回。
