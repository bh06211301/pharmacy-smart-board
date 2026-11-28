// 2026-11-28：驗證店端效期輸入介面（field-v2.html 分支3）的純邏輯——效期年月輸入正規化
// （fv2NormalizeExpiryInput_）、每產品取「目前有效」一筆（fv2PickCurrentShelfExpiryRecords_）、
// 冪等識別（fv2EnsureIdempotentId_）、送出 payload 組裝（fv2ShelfExpiryPayload_）。
// 跟 field-v2.html 的實作保持同一份邏輯（複製貼上，不是 import——field-v2.html 沒有對外匯出
// 函式，比照 test-tag-followup-rules.mjs／test-shelf-expiry-write.mjs 的既有慣例）。
// 執行：node tools/test-shelf-expiry-ui.mjs

// ---- 複製自 field-v2.html 的 fv2NormalizeExpiryInput_ ----
function fv2NormalizeExpiryInput_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: '請輸入效期年月' };
  let yy, mm, m;
  if ((m = s.match(/^(\d{4})\/(\d{1,2})$/))) { yy = m[1].slice(2); mm = m[2]; }
  else if ((m = s.match(/^(\d{2})\/(\d{1,2})$/))) { yy = m[1]; mm = m[2]; }
  else if ((m = s.match(/^(\d{4})$/))) { yy = s.slice(0, 2); mm = s.slice(2, 4); }
  else return { ok: false, error: '看不懂的格式，請用「28/05」或「2805」這種寫法' };
  const mmNum = parseInt(mm, 10);
  if (!mmNum || mmNum < 1 || mmNum > 12) return { ok: false, error: '月份要在 1~12 之間' };
  const yearMonth = `${yy.padStart(2, '0')}/${String(mmNum).padStart(2, '0')}`;
  const displayText = `20${yy.padStart(2, '0')} 年 ${mmNum} 月`;
  return { ok: true, yearMonth, displayText };
}

// ---- 複製自 field-v2.html 的 fv2PickCurrentShelfExpiryRecords_ ----
const FV2_SHELF_EXPIRY_SOURCE_PRIORITY_ = { '手動指定': 3, '實看': 2, '推估': 1 };
function fv2PickCurrentShelfExpiryRecords_(records) {
  const byProduct = {};
  (records || []).forEach(r => {
    const existing = byProduct[r.productId];
    if (!existing) { byProduct[r.productId] = r; return; }
    const pNew = FV2_SHELF_EXPIRY_SOURCE_PRIORITY_[r.source] || 0;
    const pOld = FV2_SHELF_EXPIRY_SOURCE_PRIORITY_[existing.source] || 0;
    if (pNew > pOld) { byProduct[r.productId] = r; return; }
    if (pNew === pOld && String(r.recordDate || '') > String(existing.recordDate || '')) {
      byProduct[r.productId] = r;
    }
  });
  return byProduct;
}

// ---- 複製自 field-v2.html 的 fv2EnsureIdempotentId_ ----
function fv2EnsureIdempotentId_(currentId, generator) { return currentId || generator(); }

// ---- 複製自 field-v2.html 的 fv2ShelfExpiryPayload_ ----
function fv2ShelfExpiryPayload_({ recordId, storeId, productId, expiryYearMonth, source, outOfStock, note, recordDate, sheetName }) {
  return {
    recordId, storeId, productId, expiryYearMonth, source,
    outOfStock: !!outOfStock, note: note || '', recordDate, sheetName,
  };
}

let total = 0;
let passed = 0;
function assertEqual(name, got, expect) {
  total++;
  const gotStr = JSON.stringify(got);
  const expectStr = JSON.stringify(expect);
  const pass = gotStr === expectStr;
  if (pass) passed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}: got=${gotStr} expect=${expectStr}`);
}

// ==================== 效期年月正規化 ====================
assertEqual('28/05 → 28/05', fv2NormalizeExpiryInput_('28/05'), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('28/5 → 28/05', fv2NormalizeExpiryInput_('28/5'), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('2805 → 28/05', fv2NormalizeExpiryInput_('2805'), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('2028/05 → 28/05', fv2NormalizeExpiryInput_('2028/05'), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('2028/5 → 28/05', fv2NormalizeExpiryInput_('2028/5'), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('前後有空白會先trim', fv2NormalizeExpiryInput_('  28/05  '), { ok: true, yearMonth: '28/05', displayText: '2028 年 5 月' });
assertEqual('月初 28/01', fv2NormalizeExpiryInput_('28/01'), { ok: true, yearMonth: '28/01', displayText: '2028 年 1 月' });
assertEqual('月底 28/12', fv2NormalizeExpiryInput_('28/12'), { ok: true, yearMonth: '28/12', displayText: '2028 年 12 月' });

const invalid2813 = fv2NormalizeExpiryInput_('2813');
assertEqual('2813（4位數但月份=13）不合法', invalid2813.ok, false);
assertEqual('2813 錯誤訊息是月份範圍', invalid2813.error, '月份要在 1~12 之間');

const invalid0 = fv2NormalizeExpiryInput_('0');
assertEqual('單獨 "0" 不合法', invalid0.ok, false);

const invalidBlank = fv2NormalizeExpiryInput_('   ');
assertEqual('空白（純空格）不合法', invalidBlank.ok, false);
assertEqual('空白錯誤訊息', invalidBlank.error, '請輸入效期年月');

const invalidEmpty = fv2NormalizeExpiryInput_('');
assertEqual('空字串不合法', invalidEmpty.ok, false);

const invalidUndef = fv2NormalizeExpiryInput_(undefined);
assertEqual('undefined 不合法，不拋錯', invalidUndef.ok, false);

const invalidMonth00 = fv2NormalizeExpiryInput_('28/00');
assertEqual('28/00 月份=0 不合法', invalidMonth00.ok, false);

const invalidGarbage = fv2NormalizeExpiryInput_('不是日期');
assertEqual('亂字串不合法，不拋錯', invalidGarbage.ok, false);
assertEqual('亂字串錯誤訊息是格式不明', invalidGarbage.error, '看不懂的格式，請用「28/05」或「2805」這種寫法');

const invalid5digit = fv2NormalizeExpiryInput_('28051');
assertEqual('5位數字不合法', invalid5digit.ok, false);

// ==================== 每產品取目前記錄：優先級 + 同級取最新 ====================
{
  const records = [
    { productId: 'P1', source: '推估', recordDate: '2026-11-01' },
    { productId: 'P1', source: '實看', recordDate: '2026-10-01' },
  ];
  const picked = fv2PickCurrentShelfExpiryRecords_(records);
  assertEqual('實看優先於推估（即使推估日期更新）', picked.P1.source, '實看');
}
{
  const records = [
    { productId: 'P1', source: '實看', recordDate: '2026-10-01' },
    { productId: 'P1', source: '手動指定', recordDate: '2026-09-01' },
  ];
  const picked = fv2PickCurrentShelfExpiryRecords_(records);
  assertEqual('手動指定優先於實看（即使實看日期更新）', picked.P1.source, '手動指定');
}
{
  const records = [
    { productId: 'P1', source: '實看', recordDate: '2026-10-01' },
    { productId: 'P1', source: '實看', recordDate: '2026-11-15' },
    { productId: 'P1', source: '實看', recordDate: '2026-10-20' },
  ];
  const picked = fv2PickCurrentShelfExpiryRecords_(records);
  assertEqual('同級（都實看）取最新記錄日期', picked.P1.recordDate, '2026-11-15');
}
{
  const records = [
    { productId: 'P1', source: '實看', recordDate: '2026-10-01' },
    { productId: 'P2', source: '推估', recordDate: '2026-10-01' },
  ];
  const picked = fv2PickCurrentShelfExpiryRecords_(records);
  assertEqual('不同產品各自獨立分組', Object.keys(picked).sort(), ['P1', 'P2']);
}
assertEqual('空陣列回傳空物件', fv2PickCurrentShelfExpiryRecords_([]), {});
assertEqual('undefined 不拋錯，回傳空物件', fv2PickCurrentShelfExpiryRecords_(undefined), {});

// ==================== 冪等識別 ====================
{
  let calls = 0;
  const gen = () => { calls++; return 'new-id-' + calls; };
  const first = fv2EnsureIdempotentId_(null, gen);
  assertEqual('沒有現有ID時呼叫產生器', first, 'new-id-1');
  const second = fv2EnsureIdempotentId_(first, gen);
  assertEqual('已有ID時沿用，不重新產生（同一次送出重試不會變兩筆）', second, 'new-id-1');
  assertEqual('產生器只被呼叫過一次', calls, 1);
}

// ==================== 送出 payload 組裝 ====================
{
  const payload = fv2ShelfExpiryPayload_({
    recordId: 'rec-1', storeId: 'C001', productId: 'P1', expiryYearMonth: '28/05',
    source: '手動指定', outOfStock: true, note: '測試備註', recordDate: '2026-11-28',
    sheetName: '店端效期_TEST',
  });
  assertEqual('payload 欄位齊全', payload, {
    recordId: 'rec-1', storeId: 'C001', productId: 'P1', expiryYearMonth: '28/05',
    source: '手動指定', outOfStock: true, note: '測試備註', recordDate: '2026-11-28',
    sheetName: '店端效期_TEST',
  });
}
{
  const payload = fv2ShelfExpiryPayload_({
    recordId: 'rec-2', storeId: 'C001', productId: 'P1', expiryYearMonth: '28/05',
    source: '實看', outOfStock: undefined, note: undefined, recordDate: '2026-11-28', sheetName: undefined,
  });
  assertEqual('outOfStock 沒給時正規化成 false', payload.outOfStock, false);
  assertEqual('note 沒給時正規化成空字串', payload.note, '');
  assertEqual('sheetName 沒給時維持 undefined（正式模式，Worker決定分頁）', payload.sheetName, undefined);
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
