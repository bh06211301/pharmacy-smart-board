// 店端效期推估／提醒純函式單元測試（分支1：feature/shelf-expiry-estimate）。
// 直接 import ../shelf-expiry-logic.js（真實模組，不是複製貼上），改動該檔時這份測試會跟著跑真邏輯。
// 執行：node tools/test-shelf-expiry-logic.mjs

import {
  parseOrderNoDate,
  normalizeYearMonth,
  estimateShelfExpiry,
  needsExpiryCheck,
  pickCurrentRecord,
} from '../shelf-expiry-logic.js';

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

// ---- parseOrderNoDate ----
assertEqual('訂單編號 YYMMDDNN 正常解析', parseOrderNoDate('26011201'), '2026-01-12');
assertEqual('訂單編號跨年 991231', parseOrderNoDate('99123101'), '2099-12-31');
assertEqual('訂單編號帶非數字字元仍可解析', parseOrderNoDate('26-01-12-01'), '2026-01-12');
assertEqual('訂單編號月份超出範圍回 null', parseOrderNoDate('26133101'), null);
assertEqual('訂單編號日超出範圍回 null', parseOrderNoDate('26013201'), null);
assertEqual('訂單編號太短回 null', parseOrderNoDate('2601'), null);
assertEqual('訂單編號空值回 null', parseOrderNoDate(''), null);
assertEqual('訂單編號 undefined 回 null', parseOrderNoDate(undefined), null);
assertEqual('訂單編號本身已是 YYYY-MM-DD 格式', parseOrderNoDate('2026-01-12'), '2026-01-12');

// 與 worker.js 既有兩處重複邏輯（extractDate L1417、extractOrderDateFromNo L1849）比對一致性：
// 兩處邏輯完全相同，這裡用同一批輸入跑一次 worker.js 的版本（原樣複製，僅回傳空字串而非 null）驗證。
function workerExtractDate_(orderNo) {
  const s = String(orderNo || '').replace(/\D/g, '');
  if (s.length >= 6) {
    const yy = parseInt(s.slice(0, 2), 10);
    const mm = parseInt(s.slice(2, 4), 10);
    const dd = parseInt(s.slice(4, 6), 10);
    if (yy >= 10 && yy <= 99 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  const m = String(orderNo || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
['26011201', '99123101', '26133101', '', '2026-01-12', 'XX010101'].forEach(input => {
  const ours = parseOrderNoDate(input) ?? '';
  assertEqual(`parseOrderNoDate 與 worker.js extractDate 一致（輸入 ${JSON.stringify(input)}）`, ours, workerExtractDate_(input));
});

// ---- normalizeYearMonth ----
assertEqual('28/5 → 28/05', normalizeYearMonth('28/5'), '28/05');
assertEqual('28/05 → 28/05', normalizeYearMonth('28/05'), '28/05');
assertEqual('2028/5 → 28/05', normalizeYearMonth('2028/5'), '28/05');
assertEqual('2028-05 → 28/05', normalizeYearMonth('2028-05'), '28/05');
assertEqual('2005-05 → 05/05（四位數年份個位數年）', normalizeYearMonth('2005-05'), '05/05');
assertEqual('05/05 → 05/05（兩位數年份個位數年）', normalizeYearMonth('05/05'), '05/05');
assertEqual('月份 00 不合法', normalizeYearMonth('28/00'), null);
assertEqual('月份 13 不合法', normalizeYearMonth('28/13'), null);
assertEqual('格式不符回 null', normalizeYearMonth('不是日期'), null);
assertEqual('空字串回 null', normalizeYearMonth(''), null);
assertEqual('null 輸入回 null', normalizeYearMonth(null), null);
assertEqual('undefined 輸入回 null', normalizeYearMonth(undefined), null);
assertEqual('三位數年份不合法', normalizeYearMonth('202/05'), null);
assertEqual('月份單位數不補零前仍需驗證', normalizeYearMonth('28/9'), '28/09');

// ---- estimateShelfExpiry：對照設計方案第5.2節邊界情境表 ----
assertEqual('無任何資料 → none', estimateShelfExpiry({ targetStoreOrders: [], otherStoreOrders: [] }),
  { yearMonth: null, confidence: 'none', matchedStoreId: null, matchedDate: null, alternatives: [] });

assertEqual('視窗內只有一批 → high',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [{ storeId: 'B', date: '2026-07-10', expiryYearMonth: '28/05' }],
    windowDays: 14,
  }),
  { yearMonth: '28/05', confidence: 'high', matchedStoreId: 'B', matchedDate: '2026-07-10', alternatives: [] });

assertEqual('視窗內有兩批不同效期 → medium，另一批放進 alternatives',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [
      { storeId: 'B', date: '2026-07-10', expiryYearMonth: '28/05' },
      { storeId: 'C', date: '2026-06-25', expiryYearMonth: '28/08' },
    ],
    windowDays: 14,
  }),
  {
    // C（6/25，距目標進貨日7/1共6天）比 B（7/10，共9天）更接近，所以最接近的候選是 C
    yearMonth: '28/08', confidence: 'medium', matchedStoreId: 'C', matchedDate: '2026-06-25',
    alternatives: [{ yearMonth: '28/05', storeId: 'B', date: '2026-07-10' }],
  });

assertEqual('視窗內有兩批但效期相同 → 不構成歧義，仍為 high',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [
      { storeId: 'B', date: '2026-07-10', expiryYearMonth: '28/05' },
      { storeId: 'C', date: '2026-06-25', expiryYearMonth: '28/05' },
    ],
    windowDays: 14,
  }).confidence, 'high');

assertEqual('視窗內有資料但其他店都沒有已知效期 → none',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [{ storeId: 'B', date: '2026-07-10' }],
    windowDays: 14,
  }),
  { yearMonth: null, confidence: 'none', matchedStoreId: null, matchedDate: null, alternatives: [] });

assertEqual('多家店同時沒有任何參考 → none',
  estimateShelfExpiry({ targetStoreOrders: [{ date: '2026-07-01' }], otherStoreOrders: [] }),
  { yearMonth: null, confidence: 'none', matchedStoreId: null, matchedDate: null, alternatives: [] });

assertEqual('超出視窗範圍的候選不列入',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [{ storeId: 'B', date: '2026-07-20', expiryYearMonth: '28/05' }], // 19 天 > 14
    windowDays: 14,
  }),
  { yearMonth: null, confidence: 'none', matchedStoreId: null, matchedDate: null, alternatives: [] });

assertEqual('目標店有多筆進貨記錄時取最近一次',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-01-01' }, { date: '2026-07-01' }, { date: '2026-03-01' }],
    otherStoreOrders: [{ storeId: 'B', date: '2026-07-05', expiryYearMonth: '28/05' }],
    windowDays: 14,
  }).matchedDate, '2026-07-05');

assertEqual('視窗邊界：恰好第14天仍算在視窗內',
  estimateShelfExpiry({
    targetStoreOrders: [{ date: '2026-07-01' }],
    otherStoreOrders: [{ storeId: 'B', date: '2026-07-15', expiryYearMonth: '28/05' }], // 恰好 14 天
    windowDays: 14,
  }).confidence, 'high');

// ---- needsExpiryCheck ----
assertTrue('超過門檻且無實看記錄 → true',
  needsExpiryCheck({ today: '2026-11-27', lastDeliveryDate: '2026-07-01', monthsThreshold: 4, latestObservation: null }));

assertTrue('未達門檻 → false',
  !needsExpiryCheck({ today: '2026-11-27', lastDeliveryDate: '2026-09-01', monthsThreshold: 4, latestObservation: null }));

assertTrue('超過門檻但實看記錄晚於最近進貨日 → false',
  !needsExpiryCheck({
    today: '2026-11-27', lastDeliveryDate: '2026-07-01', monthsThreshold: 4,
    latestObservation: { date: '2026-08-01' },
  }));

assertTrue('超過門檻但實看記錄早於最近進貨日 → true',
  needsExpiryCheck({
    today: '2026-11-27', lastDeliveryDate: '2026-07-01', monthsThreshold: 4,
    latestObservation: { date: '2026-01-01' },
  }));

assertTrue('恰好達門檻月數（邊界）→ true',
  needsExpiryCheck({ today: '2026-11-01', lastDeliveryDate: '2026-07-01', monthsThreshold: 4, latestObservation: null }));

// 月底邊界：lastDeliveryDate=1/31，today=2026-02-28（2月沒有31日），應視為「剛好1個月」
assertTrue('月底邊界：1/31 到 2/28（小月）算滿1個月',
  needsExpiryCheck({ today: '2026-02-28', lastDeliveryDate: '2026-01-31', monthsThreshold: 1, latestObservation: null }));

assertTrue('月底邊界：1/31 到 2/27 還沒滿1個月',
  !needsExpiryCheck({ today: '2026-02-27', lastDeliveryDate: '2026-01-31', monthsThreshold: 1, latestObservation: null }));

assertTrue('跨年邊界：11月到隔年3月算滿4個月',
  needsExpiryCheck({ today: '2027-03-01', lastDeliveryDate: '2026-11-01', monthsThreshold: 4, latestObservation: null }));

assertTrue('缺 lastDeliveryDate → false',
  !needsExpiryCheck({ today: '2026-11-27', lastDeliveryDate: null, monthsThreshold: 4 }));

assertTrue('缺 today → false',
  !needsExpiryCheck({ today: null, lastDeliveryDate: '2026-07-01', monthsThreshold: 4 }));

// ---- pickCurrentRecord ----
assertEqual('實看優先於推估',
  pickCurrentRecord([
    { source: '推估', date: '2026-11-01', yearMonth: '28/10' },
    { source: '實看', date: '2026-01-01', yearMonth: '28/05' },
  ]).yearMonth, '28/05');

assertEqual('手動指定優先於推估',
  pickCurrentRecord([
    { source: '推估', date: '2026-11-01', yearMonth: '28/10' },
    { source: '手動指定', date: '2026-01-01', yearMonth: '28/06' },
  ]).yearMonth, '28/06');

assertEqual('手動指定與實看同優先序，取記錄日期最新者',
  pickCurrentRecord([
    { source: '手動指定', date: '2026-01-01', yearMonth: '28/06' },
    { source: '實看', date: '2026-05-01', yearMonth: '28/07' },
  ]).yearMonth, '28/07');

assertEqual('同為推估時取記錄日期最新者',
  pickCurrentRecord([
    { source: '推估', date: '2026-01-01', yearMonth: '28/01' },
    { source: '推估', date: '2026-05-01', yearMonth: '28/02' },
  ]).yearMonth, '28/02');

assertEqual('空陣列回 null', pickCurrentRecord([]), null);
assertEqual('null 輸入回 null', pickCurrentRecord(null), null);

console.log(`${passed}/${total} passed`);
if (passed !== total) process.exit(1);
