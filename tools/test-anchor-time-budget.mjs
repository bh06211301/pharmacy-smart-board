// 2026-11-27：外勤模式「錨點時間餘裕判斷」純邏輯測試。
// 2026-11-28：使用者審查後修正一個算式錯誤（規格本身的錯，不是實作錯）——判斷「夠不夠」
// 不能拿 slackMin(=workEndMin−finishMin) 去扣 anchorReserveMin，finishMin 已經累加了所有
// 未完成列（含錨點）的成本，等於把錨點的時間扣了兩次，會產生假警報。改用 timeLeftMin
// (=workEndMin−baseline) 判斷，finishMin 只保留給 tight 提示顯示「預估收工 HH:MM」用。
// 跟 field-v2 那組測試檔同一個慣例：複製貼上 field-v2.html 的純邏輯函式，不是 import
// （field-v2.html 只是一份內嵌 <script> 的靜態頁面，沒有對外匯出）。改動 field-v2.html 的
// fv2AnchorBudget_／fv2AnchorSuggestion_／fv2ResolveWorkEndTime_ 時，這份測試也要同步複製貼上。
// 執行：node tools/test-anchor-time-budget.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 原封不動複製自 field-v2.html（2026-11-28 版）----
const TODAY_PLAN_ANCHOR_SOURCES_ = ['錨點', '送貨', '待追蹤', '本週排', '寄賣對帳'];
const TODAY_PLAN_DONE_STATUSES_ = ['完成', '跳過'];

function fv2HHMMToMin_(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function fv2NumOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const SR_WORK_END_TIME_DEFAULT_ = '17:30';
function fv2ResolveWorkEndTime_(rawStr, todayStr) {
  if (!rawStr) return SR_WORK_END_TIME_DEFAULT_;
  let obj;
  try { obj = JSON.parse(rawStr); } catch (e) { return SR_WORK_END_TIME_DEFAULT_; }
  if (!obj || obj.date !== todayStr || !/^\d{1,2}:\d{2}$/.test(obj.value || '')) return SR_WORK_END_TIME_DEFAULT_;
  return obj.value;
}

function fv2AnchorBudget_(rows, nowMin, departMin, workEndMin) {
  const isAnchor = r => TODAY_PLAN_ANCHOR_SOURCES_.indexOf(r.source) >= 0;
  const isDone = r => TODAY_PLAN_DONE_STATUSES_.indexOf(r.status) >= 0;
  const hasAnchor = rows.some(isAnchor);
  if (!hasAnchor) return { hasAnchor: false, dataIncomplete: false };

  const firstPendingIdx = rows.findIndex(r => !isDone(r));
  if (firstPendingIdx < 0) {
    return { hasAnchor: true, dataIncomplete: false, allDone: true, finishMin: null, slackMin: null, timeLeftMin: null, anchorReserveMin: 0, freeMin: null };
  }

  let baselineMin = null;
  if (firstPendingIdx === 0) {
    baselineMin = departMin;
  } else {
    const prev = rows[firstPendingIdx - 1];
    const prevArrival = fv2HHMMToMin_(prev.arrival);
    const prevStay = fv2NumOrNull_(prev.stayMin);
    baselineMin = (prevArrival !== null && prevStay !== null) ? prevArrival + prevStay : null;
  }
  if (baselineMin === null) return { hasAnchor: true, dataIncomplete: true };

  const baseline = Math.max(nowMin, baselineMin);
  let cum = baseline;
  let anchorReserveMin = 0;
  let nextCost = null;
  for (let i = firstPendingIdx; i < rows.length; i++) {
    const row = rows[i];
    if (isDone(row)) continue;
    const arrival = fv2HHMMToMin_(row.arrival);
    const stay = fv2NumOrNull_(row.stayMin);
    let legMin = null;
    if (i === 0) {
      legMin = (arrival !== null && departMin !== null) ? arrival - departMin : null;
    } else {
      const prevArrival = fv2HHMMToMin_(rows[i - 1].arrival);
      const prevStay = fv2NumOrNull_(rows[i - 1].stayMin);
      legMin = (arrival !== null && prevArrival !== null && prevStay !== null) ? arrival - prevArrival - prevStay : null;
    }
    if (legMin === null || stay === null) return { hasAnchor: true, dataIncomplete: true };
    const cost = legMin + stay;
    if (nextCost === null) nextCost = cost;
    cum += cost;
    if (isAnchor(row)) anchorReserveMin += cost;
  }

  const finishMin = cum;
  const slackMin = workEndMin - finishMin; // 只保留供參考/顯示，不用於任何判斷
  const timeLeftMin = workEndMin - baseline; // 判斷用：從「現在」算到工作結束
  const freeMin = timeLeftMin - anchorReserveMin;
  return { hasAnchor: true, dataIncomplete: false, allDone: false, baseline, finishMin, slackMin, timeLeftMin, anchorReserveMin, freeMin, nextCost };
}

function fv2FindNextRow_(rows) {
  let idx = rows.findIndex(r => r.status === '已到');
  if (idx < 0) idx = rows.findIndex(r => ['完成', '跳過', '未完成'].indexOf(r.status) < 0);
  return idx >= 0 ? rows[idx] : null;
}
function fv2AnchorSuggestion_(budget, nextRow) {
  if (!budget || !budget.hasAnchor || budget.dataIncomplete || budget.allDone || !nextRow) return null;
  const isAnchor = TODAY_PLAN_ANCHOR_SOURCES_.indexOf(nextRow.source) >= 0;
  if (isAnchor) return null;
  if (budget.timeLeftMin < budget.anchorReserveMin) {
    return { type: 'atrisk', deficitMin: Math.round(budget.anchorReserveMin - budget.timeLeftMin) };
  }
  if (nextRow.status === '已到') return null; // 已經在店裡，go/tight建議沒有意義；上面的atrisk不受這條影響
  if (budget.nextCost === null) return null;
  const freeMin = budget.timeLeftMin - budget.anchorReserveMin;
  if (freeMin >= budget.nextCost) return { type: 'go' };
  return { type: 'tight', cost: Math.round(budget.nextCost) };
}

// ---- assert helper（跟 tools/test-region-followups.mjs 同一套慣例） ----
let total = 0, passed = 0;
function assertEqual(name, got, expect) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) passed++;
  else console.error(`✗ ${name}\n  got:    ${JSON.stringify(got)}\n  expect: ${JSON.stringify(expect)}`);
}
function assertTrue(name, cond) {
  total++;
  if (cond) passed++;
  else console.error(`✗ ${name}`);
}

// 小工具：建一列今日行程資料，預設非錨點/待去
function row(seq, source, status, arrival, stayMin) {
  return { seq, name: `店${seq}`, source, status, arrival, stayMin };
}

// ============================================================
// 1. 三處 TODAY_PLAN_ANCHOR_SOURCES_ 集合必須一致（worker.js／planner.html／field-v2.html）
// ============================================================
{
  const workerJs = readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const plannerHtml = readFileSync(path.join(__dirname, '..', 'planner.html'), 'utf8');
  const fieldV2Html = readFileSync(path.join(__dirname, '..', 'field-v2.html'), 'utf8');
  const extract = (src, label) => {
    const m = src.match(/const TODAY_PLAN_ANCHOR_SOURCES_ = (\[[^\]]*\]);/);
    assertTrue(`${label} 找到 TODAY_PLAN_ANCHOR_SOURCES_ 定義`, !!m);
    return m ? JSON.parse(m[1].replace(/'/g, '"')) : null;
  };
  const w = extract(workerJs, 'worker.js');
  const p = extract(plannerHtml, 'planner.html');
  const f = extract(fieldV2Html, 'field-v2.html');
  assertEqual('worker.js 跟測試檔複製的集合一致', w, TODAY_PLAN_ANCHOR_SOURCES_);
  assertEqual('planner.html 跟測試檔複製的集合一致', p, TODAY_PLAN_ANCHOR_SOURCES_);
  assertEqual('field-v2.html 跟測試檔複製的集合一致', f, TODAY_PLAN_ANCHOR_SOURCES_);
  assertEqual('worker.js／planner.html／field-v2.html 三處完全一致', w, p);
  assertEqual('worker.js／field-v2.html 三處完全一致', w, f);
}

// ============================================================
// 2. 無錨點：不顯示任何提示
// ============================================================
{
  const rows = [
    row(1, '第②欄', '完成', '09:00', 20),
    row(2, '第②欄', '待去', '10:00', 20),
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60 + 30, 8 * 60, 17 * 60 + 30);
  assertEqual('無錨點：hasAnchor=false', budget.hasAnchor, false);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('無錨點：不顯示任何提示', sug, null);
}

// ============================================================
// 3. 錨點在前（已完成）：不納入預留，下一家一般店判斷照常
// ============================================================
{
  const rows = [
    row(1, '錨點', '完成', '09:00', 15),   // 已完成的錨點，不該計入成本/預留
    row(2, '第②欄', '待去', '09:45', 20),  // legMin = 09:45-(09:00+15)=30，cost=30+20=50
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60 + 15, 8 * 60, 17 * 60 + 30);
  assertEqual('錨點在前且已完成：anchorReserveMin=0', budget.anchorReserveMin, 0);
  assertEqual('錨點在前且已完成：nextCost=50（legMin30+stay20）', budget.nextCost, 50);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('錨點已完成、下一家一般店、餘裕充足：順路可去', sug, { type: 'go' });
}

// ============================================================
// 4. 錨點在後（未完成）：下一家是一般店，要算出 anchorReserveMin > 0
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),      // 下一家：legMin 用 departMin=9:00 反推 =30，cost=50
    row(2, '錨點', '未完成', '10:10', 15),      // legMin=10:10-(09:30+20)=20，cost=35（未完成錨點要計入）
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 17 * 60 + 30);
  assertEqual('錨點在後、未完成：anchorReserveMin=35', budget.anchorReserveMin, 35);
  assertEqual('下一家（一般店）nextCost=50', budget.nextCost, 50);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('餘裕充足：順路可去', sug.type, 'go');
}

// ============================================================
// 5. 餘裕足夠：可自由使用時間 >= 下一家成本 → 順路可去
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),
    row(2, '錨點', '未完成', '10:10', 15),
  ];
  // 工作結束拉長到 20:00，餘裕變得很大
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 20 * 60);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('工作結束時間夠晚：順路可去', sug, { type: 'go' });
}

// ============================================================
// 6. 餘裕不足：可自由使用時間 < 下一家成本，但整體還夠跑完錨點 → 橘色提示
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),      // nextCost=50
    row(2, '錨點', '未完成', '10:10', 15),      // anchorReserveMin=35
  ];
  // baseline=9:00(540)。workEndMin=10:00(600) → timeLeftMin=60 >= 35(不是atrisk)，
  // freeMin=60-35=25 < nextCost(50) → tight
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 10 * 60);
  assertTrue('timeLeftMin(60) >= 預留(35)，不是 atrisk', budget.timeLeftMin >= budget.anchorReserveMin);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('可自由使用時間不足下一家成本：橘色提示 tight', sug.type, 'tight');
  assertEqual('tight 提示附帶的 cost', sug.cost, 50);
}

// ============================================================
// 7. 餘裕小於預留：紅字「錨點今天去不了」
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),
    row(2, '錨點', '未完成', '10:10', 15), // anchorReserveMin=35
  ];
  // baseline=9:00(540)。workEndMin=9:30(570) → timeLeftMin=30 < 35(anchorReserveMin) → atrisk，缺5分鐘
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 9 * 60 + 30);
  assertTrue('timeLeftMin < anchorReserveMin', budget.timeLeftMin < budget.anchorReserveMin);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('錨點今天去不了', sug.type, 'atrisk');
  assertEqual('缺額分鐘數 = anchorReserveMin - timeLeftMin', sug.deficitMin, Math.round(budget.anchorReserveMin - budget.timeLeftMin));
  assertEqual('缺額剛好是5分鐘', sug.deficitMin, 5);
}

// ============================================================
// 7b. 使用者提出的反例：現在10:00、工作結束11:30，剩 A(一般30)+B(錨點35)+C(一般20)＝85分鐘，
// 其實夠用（90分鐘可用）。舊算式用 slackMin(=5) 跟 anchorReserveMin(35) 比會誤判成 atrisk，
// 絕不能再出現這個假警報。
// ============================================================
{
  const departMin = 10 * 60; // 10:00，剛好等於 nowMin，baseline = 10:00
  const rows = [
    row(1, '第②欄', '待去', fmtMin_(departMin + 20), 10),              // legMin=20,stay=10 → cost=30
    row(2, '錨點', '未完成', fmtMin_(departMin + 20 + 10 + 20), 15),    // legMin=20,stay=15 → cost=35
    row(3, '第②欄', '未完成', fmtMin_(departMin + 20 + 10 + 20 + 15 + 10), 10), // legMin=10,stay=10 → cost=20
  ];
  const budget = fv2AnchorBudget_(rows, 10 * 60, departMin, 11 * 60 + 30);
  assertEqual('反例：anchorReserveMin=35（只有B）', budget.anchorReserveMin, 35);
  assertEqual('反例：finishMin = baseline+30+35+20 = 11:25', budget.finishMin, 10 * 60 + 85);
  assertEqual('反例：timeLeftMin = workEnd(11:30)-baseline(10:00) = 90', budget.timeLeftMin, 90);
  // 舊算式會算出的 slackMin（僅供對照，不是本次判斷依據）：90-85=5，5<35 會誤判 atrisk
  assertEqual('對照：舊 slackMin 確實只有5（說明問題所在，不是判斷依據）', budget.slackMin, 5);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertTrue('反例：絕不能是 atrisk', sug.type !== 'atrisk');
  assertTrue('反例：必須是 go 或 tight', sug.type === 'go' || sug.type === 'tight');
  assertEqual('反例：freeMin(90-35=55) >= nextCost(30) → go', sug.type, 'go');
}

// ============================================================
// 8. 工作結束時間被修改：同一份今日行程，不同工作結束時間要算出不同結果
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),
    row(2, '錨點', '未完成', '10:10', 15),
  ];
  const nowMin = 9 * 60, departMin = 9 * 60;
  const early = fv2AnchorBudget_(rows, nowMin, departMin, 9 * 60 + 20); // 來不及（timeLeftMin=20<35）
  const late = fv2AnchorBudget_(rows, nowMin, departMin, 20 * 60);      // 很夠
  assertTrue('工作結束時間改早：timeLeftMin 變小', early.timeLeftMin < late.timeLeftMin);
  const sugEarly = fv2AnchorSuggestion_(early, fv2FindNextRow_(rows));
  const sugLate = fv2AnchorSuggestion_(late, fv2FindNextRow_(rows));
  assertEqual('改早：錨點去不了', sugEarly.type, 'atrisk');
  assertEqual('改晚：順路可去', sugLate.type, 'go');
}

// ============================================================
// 8b. 邊界值：剩餘時間剛好等於預留（不是 atrisk）／少1分鐘（atrisk，缺1分鐘）
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20), // nextCost=50
    row(2, '錨點', '未完成', '10:10', 15), // anchorReserveMin=35
  ];
  const nowMin = 9 * 60, departMin = 9 * 60; // baseline=9:00(540)
  // 剛好等於：workEndMin=540+35=575（9:35）→ timeLeftMin=35=anchorReserveMin，不是 atrisk（嚴格小於才算）
  const exact = fv2AnchorBudget_(rows, nowMin, departMin, 575);
  assertEqual('timeLeftMin 剛好等於 anchorReserveMin：35', exact.timeLeftMin, exact.anchorReserveMin);
  const sugExact = fv2AnchorSuggestion_(exact, fv2FindNextRow_(rows));
  assertTrue('剛好相等：不是 atrisk', sugExact.type !== 'atrisk');
  assertEqual('剛好相等：freeMin=0 < nextCost(50) → tight', sugExact.type, 'tight');

  // 少1分鐘：workEndMin=574（9:34）→ timeLeftMin=34 < 35 → atrisk，缺1分鐘
  const short1 = fv2AnchorBudget_(rows, nowMin, departMin, 574);
  const sugShort1 = fv2AnchorSuggestion_(short1, fv2FindNextRow_(rows));
  assertEqual('少1分鐘：atrisk', sugShort1.type, 'atrisk');
  assertEqual('少1分鐘：缺額剛好是1分鐘', sugShort1.deficitMin, 1);
}

// ============================================================
// 9. 各段車程缺值：要保守處理（dataIncomplete），不報錯、不給假數字
// ============================================================
{
  const rows = [
    row(1, '第②欄', '待去', '', 20),          // arrival 是空字串（例如定位失敗沒算到路線）
    row(2, '錨點', '未完成', '10:10', 15),
  ];
  let threw = false;
  let budget;
  try { budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 17 * 60 + 30); } catch (e) { threw = true; }
  assertTrue('arrival 缺值不會丟出例外', !threw);
  assertEqual('arrival 缺值：dataIncomplete=true', budget.dataIncomplete, true);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('dataIncomplete 時不顯示任何提示', sug, null);
}
{
  // stayMin 缺值（空字串）一樣要保守處理
  const rows = [
    row(1, '第②欄', '待去', '09:30', ''),
    row(2, '錨點', '未完成', '10:10', 15),
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 17 * 60 + 30);
  assertEqual('stayMin 缺值：dataIncomplete=true', budget.dataIncomplete, true);
}
{
  // 整天還沒開始（第一列本身未完成）又沒有 departMin：没有基準點可用
  const rows = [
    row(1, '第②欄', '待去', '09:30', 20),
    row(2, '錨點', '未完成', '10:10', 15),
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60, null, 17 * 60 + 30);
  assertEqual('沒有 departMin 又還沒開始：dataIncomplete=true', budget.dataIncomplete, true);
}

// ============================================================
// 10. 已到／已完成的列不納入成本與預留（錨點已完成或已跳過都不該計入 anchorReserveMin）
// ============================================================
{
  const rows = [
    row(1, '錨點', '完成', '09:00', 15),
    row(2, '錨點', '跳過', '09:30', 15),     // 跳過的錨點一樣不計入
    row(3, '第②欄', '待去', '10:00', 20),     // legMin = 10:00-(09:30+15)=15，cost=35
    row(4, '錨點', '未完成', '10:45', 10),    // legMin = 10:45-(10:00+20)=25，cost=35（唯一該計入的）
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60 + 45, 8 * 60 + 30, 17 * 60 + 30);
  assertEqual('只有未完成的錨點(row4)計入預留：35', budget.anchorReserveMin, 35);
  assertEqual('下一家是 row3，nextCost=35', budget.nextCost, 35);
}

// ============================================================
// 11. 全部站都跑完了：hasAnchor 仍為 true，但不產生提示
// ============================================================
{
  const rows = [
    row(1, '錨點', '完成', '09:00', 15),
    row(2, '第②欄', '跳過', '09:30', 20),
  ];
  const budget = fv2AnchorBudget_(rows, 10 * 60, 8 * 60 + 30, 17 * 60 + 30);
  assertEqual('全部跑完：hasAnchor=true', budget.hasAnchor, true);
  assertEqual('全部跑完：allDone=true', budget.allDone, true);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('全部跑完：沒有下一家可判斷，不顯示提示', sug, null);
}

// ============================================================
// 12. 下一家本身就是錨點：不額外顯示提示（照常走原有畫面）
// ============================================================
{
  const rows = [
    row(1, '錨點', '待去', '09:30', 20),
  ];
  const budget = fv2AnchorBudget_(rows, 9 * 60, 9 * 60, 17 * 60 + 30);
  const sug = fv2AnchorSuggestion_(budget, fv2FindNextRow_(rows));
  assertEqual('下一家本身是錨點：不顯示額外提示', sug, null);
}

// ============================================================
// 13. 下一家狀態是「已到」：不顯示 go／tight，但 atrisk 照常顯示
// ============================================================
{
  const rows = [
    row(1, '第②欄', '已到', '09:30', 20),   // 人已經在店裡，nextCost=50
    row(2, '錨點', '未完成', '10:10', 15),  // anchorReserveMin=35
  ];
  const nowMin = 9 * 60, departMin = 9 * 60;
  // 餘裕充足（本來會是 go）：workEndMin 夠大
  const sufficient = fv2AnchorBudget_(rows, nowMin, departMin, 20 * 60);
  const sugSufficient = fv2AnchorSuggestion_(sufficient, fv2FindNextRow_(rows));
  assertEqual('已到＋餘裕充足：不顯示 go/tight（null）', sugSufficient, null);

  // 餘裕不足（本來會是 tight）：workEndMin=10:00
  const tightCase = fv2AnchorBudget_(rows, nowMin, departMin, 10 * 60);
  const sugTight = fv2AnchorSuggestion_(tightCase, fv2FindNextRow_(rows));
  assertEqual('已到＋餘裕不足下一家成本：不顯示 tight（null）', sugTight, null);

  // 真的去不了錨點（atrisk）：workEndMin=9:30，已到狀態不影響 atrisk 顯示
  const atRiskCase = fv2AnchorBudget_(rows, nowMin, departMin, 9 * 60 + 30);
  const sugAtRisk = fv2AnchorSuggestion_(atRiskCase, fv2FindNextRow_(rows));
  assertEqual('已到＋錨點去不了：atrisk 照常顯示', sugAtRisk.type, 'atrisk');
}

// ============================================================
// 14. 工作結束時間 localStorage 解析（fv2ResolveWorkEndTime_）
// ============================================================
{
  assertEqual('沒存過：回預設 17:30', fv2ResolveWorkEndTime_(null, '2026-11-27'), '17:30');
  assertEqual('壞掉的 JSON：回預設', fv2ResolveWorkEndTime_('{not json', '2026-11-27'), '17:30');
  assertEqual('日期不是今天：回預設（跨日失效）', fv2ResolveWorkEndTime_(JSON.stringify({ date: '2026-11-26', value: '18:00' }), '2026-11-27'), '17:30');
  assertEqual('格式不對的 value：回預設', fv2ResolveWorkEndTime_(JSON.stringify({ date: '2026-11-27', value: 'abc' }), '2026-11-27'), '17:30');
  assertEqual('日期是今天、格式對：用存的值', fv2ResolveWorkEndTime_(JSON.stringify({ date: '2026-11-27', value: '18:00' }), '2026-11-27'), '18:00');
}

function fmtMin_(min) {
  const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

console.log(`\n共 ${total} 筆斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
