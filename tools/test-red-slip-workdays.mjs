// 2026-11-16：驗證 handleRedSlips() 的 workdaysBetween_()——紅單超時天數改算工作日（扣掉週六、週日）。
// 跟 worker.js 裡的實作保持同一份邏輯（複製貼上，不是 import，因為 worker.js 沒有對外匯出函式）。
// 執行：node tools/test-red-slip-workdays.mjs

function workdaysBetween_(fromMidnight, toMidnight) {
  let count = 0;
  const cur = new Date(fromMidnight);
  while (cur < toMidnight) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
function d(y, m, day) { return new Date(y, m - 1, day); }

const cases = [
  { name: '週五開、週一檢查',             from: d(2026, 11, 13), to: d(2026, 11, 16), expect: 1 },
  { name: '跨週末（週四開、下週二檢查）', from: d(2026, 11, 12), to: d(2026, 11, 17), expect: 3 },
  { name: '跨兩個週末（整整2週）',        from: d(2026, 11, 6),  to: d(2026, 11, 20), expect: 10 },
  { name: '當天',                         from: d(2026, 11, 16), to: d(2026, 11, 16), expect: 0 },
  { name: '剛好3個工作日（未逾期）',      from: d(2026, 11, 13), to: d(2026, 11, 18), expect: 3 },
  { name: '剛好4個工作日（逾期）',        from: d(2026, 11, 13), to: d(2026, 11, 19), expect: 4 },
];

let allPass = true;
cases.forEach(c => {
  const got = workdaysBetween_(c.from, c.to);
  const overdue = got > 3;
  const pass = got === c.expect;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${c.name}: got=${got} expect=${c.expect} overdue=${overdue}`);
});
console.log(allPass ? '\n全部通過' : '\n有測試沒過！');
process.exit(allPass ? 0 : 1);
