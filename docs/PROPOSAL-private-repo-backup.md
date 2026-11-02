# 方案：gas-backend、new-pharmacy-screening 推到 GitHub 私有 repo

> 只寫方案，沒有動手實作。對應使用者 2026-11-02 的工作項目 11。背景：A10 部署當天才發現這兩個
> repo 都只存在本機（`gas-backend` 本來只有 1 個 commit、`new-pharmacy-screening` 本次才補
> `git init`），本機硬碟故障就會完全遺失版本歷史，已記錄在 `docs/SPEC.md` 第 11 節待辦。

## 兩個 repo 目前的安全狀態（已經查過，不是臆測）

### new-pharmacy-screening

A10 部署當天已經完整查過一次：`Code.gs`／`Seed.gs`／`CLAUDE.md`／`README.md`／`.clasp.json`
**沒有任何檔案含實際金鑰值**——`API_TOKEN` 真正的密碼值存在 Google PropertiesService（指令碼
屬性），不在任何本機檔案裡，程式碼只引用屬性名稱。目前的 `.gitignore` 已經排除 `CLAUDE.md`
（跟 pharmacy-smart-board 同慣例）。**這個 repo 可以直接推，不用再處理。**

### gas-backend

這次順便查了一次：目前被 git 追蹤的 6 個檔案（`.clasp.json`／`.gitignore`／`PlannerActions.js`／
`PlannerSetup.js`／`VisitAppWebhook.js`／`appsscript.json`）裡沒有任何硬寫的真實金鑰或密碼
（PLANNER_API_TOKEN／SCREENING_API_TOKEN 這些都只存在 Cloudflare Worker 的 secret 跟 Apps
Script 的 PropertiesService，不在這個 repo 的程式碼裡）。

**但發現一個額外狀況**：repo 裡還有一個檔名是中文的舊檔案 `程式碼.js`（127 行，2026-07-06 的
舊檔，比其他檔案早了快 4 個月），內容是處理拜訪語音檔的雛形程式，開頭寫 `const API_KEY =
'YOUR_KEY_HERE';`——**這是一個沒填值的佔位字串，不是真實金鑰外洩**，但看起來是現在架構（
`PlannerActions.js`／`VisitAppWebhook.js` 那一套）之前的舊原型，不確定現在還有沒有在用。**這個
我沒有動它**（只是這次順便發現，記下來），推到私有 repo 前建議你看一眼要不要留著，還是當作
過時程式碼先移除（留著也不會外洩任何東西，只是可能是死程式碼）。

### 兩個 repo 都沒有 `.dev.vars`、`.env` 這類本機密鑰檔——Apps Script 專案本來就不用這種檔案
（密鑰都在 Google 那邊的 PropertiesService），架構上天生比 Cloudflare Worker 少一種外洩風險。

## 建立私有 repo 的步驟

兩個 repo 做法一樣，已經有 `gh` CLI 可以用（這次 session 已經用過 `gh api` 查 GitHub Pages
建置狀態，確認可用）：

```bash
cd gas-backend
gh repo create bh06211301/gas-backend --private --source=. --remote=origin
git push -u origin main
```

`new-pharmacy-screening` 同樣做法（它目前還沒有 remote，`git remote -v` 是空的，流程完全一樣）。

**注意**：如果你的 GitHub 帳號方案是免費版，私有 repo 本身免費（GitHub 私有 repo 早就對所有
方案開放，不用額外付費），這點不用擔心成本。

## 要不要順便做的事（不是必要，列出來給你選）

1. **gas-backend 的 `程式碼.js` 舊檔**：上面提到的，建議你看一眼要不要在推上去之前先移除（用
   `git rm` 或直接刪檔案+commit），避免私有 repo 裡留著一個不確定還在不在用的雛形程式混淆視聽。
   我不會自己決定刪，這個檔案不是我這次 session 建立的。
2. **GitHub Actions 自動備份提醒**：目前兩個 repo 都要「手動 push 才會備份」，如果你希望更保險，
   可以設一個 GitHub Action，定期（例如每週）檢查本機... **不行，GitHub Actions 跑在 GitHub
   的伺服器上，看不到你的本機檔案**，這個方向行不通，備份終究需要你（或我代勞）在本機執行
   `git push`。比較實際的作法是：之後每次改完 gas-backend／new-pharmacy-screening 的程式碼，
   養成習慣（或請我）順手 `git push` 一次，不要等很久才想起來——這也是這次兩個 repo 會變成
   「很久沒 commit」的根本原因（一直用 `clasp push` 直接推上線，没人記得同時顧 git）。
3. **README 要不要寫清楚「這是私有備份，正式運作靠 Apps Script 本身」**：避免以後有人（包含
   未來的我）誤以為這個 GitHub repo 是「部署來源」，實際上部署靠 `clasp push`/`clasp deploy`，
   GitHub 只是版本歷史備份，兩者要分清楚說明。

## 待你確認的問題

1. 確認要用哪個 GitHub 帳號建私有 repo（預設延用 `bh06211301`，跟 `pharmacy-smart-board`／
   `pharmacy-visit-app`／`pharmacy-tools-hub` 這幾個現有 repo 同一個帳號）？
2. `程式碼.js` 這個舊檔案要不要先處理（刪除／確認還在用／其他）？
3. 要不要我在 README 加上「這是備份用，部署靠 clasp」的說明？
