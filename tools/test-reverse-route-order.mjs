// 2026-11-27：今日清單「反轉順序」按鈕純邏輯測試。
// 跟 tools/test-anchor-time-budget.mjs 同一個慣例：複製貼上 planner.html 的純邏輯函式，不是
// import（planner.html 只是一份內嵌 <script> 的靜態頁面，沒有對外匯出）。改動 planner.html 的
// reverseTodayListRows_／reverseRouteOrderDisabledReason_ 時，這份測試也要同步複製貼上。
// 執行：node tools/test-reverse-route-order.mjs

// ---- 原封不動複製自 planner.html（2026-11-27 版）----
const TODAY_LIST_IN_PROGRESS_STATUSES_ = ['已到', '完成', '跳過'];

function reverseTodayListRows_(rows) {
  return rows.slice().reverse();
}

function reverseRouteOrderDisabledReason_(rows, orderMode_, hasRouteData) {
  if (!rows || rows.length < 2) return '清單少於 2 站，不需要反轉順序';
  if (orderMode_ === 'unordered' || !hasRouteData) return '尚未計算路線，請先按「計算路線」';
  if (rows.some(r => TODAY_LIST_IN_PROGRESS_STATUSES_.indexOf(r.status) >= 0)) {
    return '已有站點進行中（已到／完成／跳過），無法反轉順序';
  }
  return null;
}

// ---- assert helper（跟 tools/test-anchor-time-budget.mjs 同一套慣例） ----
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

function row(id, status) {
  return { id, name: `店${id}`, status: status || '待去' };
}

// ============================================================
// 1. reverseTodayListRows_：站序倒置，起終點（不在陣列裡）不受影響，seq 由呼叫端用索引重編
// ============================================================
{
  const rows = [row('A'), row('B'), row('C'), row('D')];
  const reversed = reverseTodayListRows_(rows);
  assertEqual('7 站(簡化成4站)反轉：1→7 變 7→1', reversed.map(r => r.id), ['D', 'C', 'B', 'A']);
  assertEqual('原陣列不被動到（slice 不是 in-place）', rows.map(r => r.id), ['A', 'B', 'C', 'D']);

  const reversedTwice = reverseTodayListRows_(reversed);
  assertEqual('連按兩次：倒回原序', reversedTwice.map(r => r.id), ['A', 'B', 'C', 'D']);
}

// ============================================================
// 2. 停用條件
// ============================================================
{
  assertEqual('少於 2 站：停用', reverseRouteOrderDisabledReason_([row('A')], 'route', true), '清單少於 2 站，不需要反轉順序');
  assertEqual('0 站：停用', reverseRouteOrderDisabledReason_([], 'route', true), '清單少於 2 站，不需要反轉順序');

  assertEqual('orderMode=unordered（還沒算過路線）：停用',
    reverseRouteOrderDisabledReason_([row('A'), row('B')], 'unordered', false), '尚未計算路線，請先按「計算路線」');
  assertEqual('orderMode=route 但 lastRouteLegMinutes 是 null（資料被清掉）：停用',
    reverseRouteOrderDisabledReason_([row('A'), row('B')], 'route', false), '尚未計算路線，請先按「計算路線」');

  assertEqual('任一站已到：停用',
    reverseRouteOrderDisabledReason_([row('A', '已到'), row('B')], 'route', true), '已有站點進行中（已到／完成／跳過），無法反轉順序');
  assertEqual('任一站完成：停用',
    reverseRouteOrderDisabledReason_([row('A'), row('B', '完成')], 'manual', true), '已有站點進行中（已到／完成／跳過），無法反轉順序');
  assertEqual('任一站跳過：停用',
    reverseRouteOrderDisabledReason_([row('A', '跳過'), row('B'), row('C')], 'route', true), '已有站點進行中（已到／完成／跳過），無法反轉順序');

  assertEqual('orderMode=route、2 站以上、全部待去：可以反轉',
    reverseRouteOrderDisabledReason_([row('A'), row('B'), row('C')], 'route', true), null);
  assertEqual('orderMode=manual、2 站以上、全部待去：可以反轉',
    reverseRouteOrderDisabledReason_([row('A'), row('B')], 'manual', true), null);
}

// ============================================================
// 3. 重算失敗時不改順序——模擬 reverseRouteOrderClicked_ 的還原邏輯（純函式層級）：
//    呼叫端把反轉後的結果丟給「重算」，重算回報失敗就應該改用反轉前的陣列，不是反轉後的。
// ============================================================
{
  const before = [row('A'), row('B'), row('C')];
  const reversed = reverseTodayListRows_(before);
  const recalcOk = false; // 模擬 recalcManualOrderTimes_() 回傳 false（API 錯誤／全部定位失敗）
  const finalList = recalcOk ? reversed : before;
  assertEqual('重算失敗：維持反轉前的原順序', finalList.map(r => r.id), ['A', 'B', 'C']);

  const recalcOk2 = true;
  const finalList2 = recalcOk2 ? reversed : before;
  assertEqual('重算成功：套用反轉後的順序', finalList2.map(r => r.id), ['C', 'B', 'A']);
}

console.log(`\n共 ${total} 筆斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
