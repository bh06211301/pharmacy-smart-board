// 2026-11-27：驗證店端效期_分支2 寫入路徑的純邏輯（欄位驗證／效期年月正規化／來源枚舉／
// 記錄ID重複拒絕／必填缺漏），全部用 mock，不送任何真實請求。
// 跟 GAS（gas-backend/ShelfExpiryActions.js）、Worker（worker.js 的 handleAddShelfExpiry／
// handleGetShelfExpiry）的實作保持同一份邏輯（複製貼上，不是 import——兩邊都是沒有對外匯出
// 函式的檔案，比照 test-tag-followup-rules.mjs 的既有慣例）。
// 執行：node tools/test-shelf-expiry-write.mjs

// ---- 複製自 gas-backend/PlannerSetup.js 的常數 ----
const PLANNER_SHELF_EXPIRY_SHEET = '店端效期';
const PLANNER_SHELF_EXPIRY_TEST_SHEET = '店端效期_TEST';
const PLANNER_SHELF_EXPIRY_SOURCES = ['實看', '推估', '手動指定'];

// ---- 複製自 gas-backend/ShelfExpiryActions.js ----
const SHELF_EXPIRY_YEAR_MONTH_RE_ = /^\d{2}\/(0[1-9]|1[0-2])$/;

function normalizeShelfExpiryYearMonth_(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{2})\/(\d{1,2})$/);
  if (!m) return s;
  const mm = m[2].length === 1 ? '0' + m[2] : m[2];
  return m[1] + '/' + mm;
}

// 把 gas-backend 的 handleAddShelfExpiry_ 改寫成不碰 SpreadsheetApp 的純函式版本：
// existingIds 模擬「分頁目前已有的記錄ID集合」，取代真正的 findRow_ 查表。
// 回傳 { ok: true, recordId, outOfStock } 或丟 Error——錯誤訊息跟 GAS 版逐字一致，
// 確保兩邊不會不小心長出不一樣的驗證規則。
function addShelfExpiryPure_(data, existingIds) {
  const { recordId, storeId, productId, source, recordDate, note, outOfStock, expiryKey } = data;
  if (!recordId) throw new Error('缺少記錄ID');
  if (!storeId) throw new Error('缺少店家代號');
  if (!productId) throw new Error('缺少產品編號');
  if (!recordDate) throw new Error('缺少記錄日期');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(recordDate))) throw new Error('記錄日期格式不合法：' + recordDate);
  if (!source || PLANNER_SHELF_EXPIRY_SOURCES.indexOf(source) < 0) throw new Error('來源不合法：' + source);

  const expiryYearMonth = normalizeShelfExpiryYearMonth_(data.expiryYearMonth);
  if (!SHELF_EXPIRY_YEAR_MONTH_RE_.test(expiryYearMonth)) throw new Error('效期年月格式不合法：' + data.expiryYearMonth);

  const sheetName = data.sheetName || PLANNER_SHELF_EXPIRY_SHEET;
  if (sheetName !== PLANNER_SHELF_EXPIRY_SHEET && sheetName !== PLANNER_SHELF_EXPIRY_TEST_SHEET) {
    throw new Error('不合法的 sheetName：' + sheetName);
  }

  if (existingIds.has(recordId)) {
    throw new Error('記錄ID重複，拒絕寫入：' + recordId);
  }

  const outOfStockFlag = outOfStock !== undefined ? !!outOfStock : (source === '手動指定');

  return { ok: true, recordId, expiryYearMonth, sheetName, outOfStock: outOfStockFlag, note: note || '', expiryKey: expiryKey || '' };
}

// ---- 複製自 worker.js 的白名單（Worker 端唯一跟 GAS 重複的驗證：sheetName 白名單） ----
const SHELF_EXPIRY_SHEET_NAME = '店端效期';
const SHELF_EXPIRY_TEST_SHEET_NAME = '店端效期_TEST';
const SHELF_EXPIRY_SHEET_WHITELIST = [SHELF_EXPIRY_SHEET_NAME, SHELF_EXPIRY_TEST_SHEET_NAME];

// ---- 複製自 worker.js 的 gvizCellIsTrue_（庫外旗標讀取，2026-11-27 審查補）----
// 寫入時是字串 "TRUE"/"FALSE"，但 Sheets 可能自動偵測成真正的布林值，gviz 讀回來型態不保證，
// 這支要同時相容兩種型態，不能只用 `=== 'TRUE'` 字串比較。
function gvizCellIsTrue_(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  return String(v).trim().toUpperCase() === 'TRUE';
}

// ---- 複製自 worker.js 的 gvizCellToIsoDate_（記錄日期讀取，2026-11-27 審查補，方案A）----
// 寫入時是 'YYYY-MM-DD' 文字，但 Sheets 可能自動偵測成真日期，gviz 讀回來是
// 'Date(2026,10,27)'（月份0起算）。使用者決定保留真日期，這支負責轉回 'YYYY-MM-DD'；
// 格式不明原樣傳回，空值/undefined 回傳空字串，不經過 new Date(...)（避免時區風險）。
function gvizCellToIsoDate_(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  const m = s.match(/^Date\((\d+),(\d+),(\d+)\)$/);
  if (!m) return s;
  const mm = String(parseInt(m[2], 10) + 1).padStart(2, '0');
  const dd = String(parseInt(m[3], 10)).padStart(2, '0');
  return `${m[1]}-${mm}-${dd}`;
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

function assertThrows(name, fn, expectMessage) {
  total++;
  let threw = false;
  let message = null;
  try {
    fn();
  } catch (e) {
    threw = true;
    message = e.message;
  }
  const pass = threw && (expectMessage === undefined || message === expectMessage);
  if (pass) passed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}: threw=${threw} message=${JSON.stringify(message)}`);
}

const baseValid = () => ({
  recordId: 'E' + 'abcd1234',
  storeId: 'C999',
  productId: '1A',
  expiryYearMonth: '28/05',
  source: '實看',
  recordDate: '2026-11-27',
});

// ---- Worker/GAS sheetName 白名單一致性 ----
assertEqual(
  'Worker 的 SHELF_EXPIRY_SHEET_WHITELIST 跟 GAS 接受的分頁清單一致',
  SHELF_EXPIRY_SHEET_WHITELIST,
  [PLANNER_SHELF_EXPIRY_SHEET, PLANNER_SHELF_EXPIRY_TEST_SHEET]
);

// ---- 效期年月正規化 ----
assertEqual('28/05 原樣保留', normalizeShelfExpiryYearMonth_('28/05'), '28/05');
assertEqual('28/5 補零成 28/05', normalizeShelfExpiryYearMonth_('28/5'), '28/05');
assertEqual('28/12 原樣保留', normalizeShelfExpiryYearMonth_('28/12'), '28/12');
assertEqual('格式本身不對（年非兩位數）原樣傳回，交給正規表達式擋', normalizeShelfExpiryYearMonth_('8/5'), '8/5');
assertEqual('空字串原樣傳回', normalizeShelfExpiryYearMonth_(''), '');

// ---- 新增：成功案例 ----
{
  const r = addShelfExpiryPure_(baseValid(), new Set());
  assertEqual('合法輸入成功，回傳 recordId', r.ok && r.recordId, true && 'Eabcd1234');
}
{
  const r = addShelfExpiryPure_({ ...baseValid(), expiryYearMonth: '28/5' }, new Set());
  assertEqual('28/5 先正規化成 28/05 再通過驗證', r.expiryYearMonth, '28/05');
}
{
  const r = addShelfExpiryPure_({ ...baseValid(), source: '手動指定', outOfStock: undefined }, new Set());
  assertEqual('來源=手動指定、沒帶 outOfStock 時預設為 true', r.outOfStock, true);
}
{
  const r = addShelfExpiryPure_({ ...baseValid(), source: '推估', outOfStock: undefined }, new Set());
  assertEqual('來源=推估、沒帶 outOfStock 時預設為 false', r.outOfStock, false);
}
{
  const r = addShelfExpiryPure_({ ...baseValid(), source: '手動指定', outOfStock: false }, new Set());
  assertEqual('明確帶 outOfStock:false 時尊重呼叫端的值，不被來源覆蓋', r.outOfStock, false);
}
{
  const r = addShelfExpiryPure_({ ...baseValid(), sheetName: '店端效期_TEST' }, new Set());
  assertEqual('sheetName 帶測試分頁名稱時通過', r.sheetName, '店端效期_TEST');
}

// ---- 必填缺漏 ----
assertThrows('缺記錄ID', () => addShelfExpiryPure_({ ...baseValid(), recordId: '' }, new Set()), '缺少記錄ID');
assertThrows('缺店家代號', () => addShelfExpiryPure_({ ...baseValid(), storeId: '' }, new Set()), '缺少店家代號');
assertThrows('缺產品編號', () => addShelfExpiryPure_({ ...baseValid(), productId: '' }, new Set()), '缺少產品編號');
assertThrows('缺記錄日期', () => addShelfExpiryPure_({ ...baseValid(), recordDate: '' }, new Set()), '缺少記錄日期');

// ---- 記錄日期格式 ----
assertThrows(
  '記錄日期格式錯誤（2026/11/27 不是 YYYY-MM-DD）',
  () => addShelfExpiryPure_({ ...baseValid(), recordDate: '2026/11/27' }, new Set()),
  '記錄日期格式不合法：2026/11/27'
);

// ---- 來源枚舉 ----
assertThrows(
  '來源不在三個選項內',
  () => addShelfExpiryPure_({ ...baseValid(), source: '隨便' }, new Set()),
  '來源不合法：隨便'
);
assertThrows('來源缺漏', () => addShelfExpiryPure_({ ...baseValid(), source: '' }, new Set()), '來源不合法：');

// ---- 效期年月格式 ----
assertThrows(
  '效期年月月份超過12',
  () => addShelfExpiryPure_({ ...baseValid(), expiryYearMonth: '28/13' }, new Set()),
  '效期年月格式不合法：28/13'
);
assertThrows(
  '效期年月年份是4位數',
  () => addShelfExpiryPure_({ ...baseValid(), expiryYearMonth: '2028/05' }, new Set()),
  '效期年月格式不合法：2028/05'
);
assertThrows(
  '效期年月月份是00',
  () => addShelfExpiryPure_({ ...baseValid(), expiryYearMonth: '28/00' }, new Set()),
  '效期年月格式不合法：28/00'
);

// ---- sheetName 白名單 ----
assertThrows(
  'sheetName 不在白名單內',
  () => addShelfExpiryPure_({ ...baseValid(), sheetName: '店端效期_亂打' }, new Set()),
  '不合法的 sheetName：店端效期_亂打'
);

// ---- 記錄ID 重複拒絕 ----
assertThrows(
  '記錄ID 已存在時拒絕寫入',
  () => addShelfExpiryPure_(baseValid(), new Set(['Eabcd1234'])),
  '記錄ID重複，拒絕寫入：Eabcd1234'
);
{
  const r = addShelfExpiryPure_({ ...baseValid(), recordId: '其他ID' }, new Set(['Eabcd1234']));
  assertEqual('不同記錄ID不受既有ID影響，正常寫入', r.recordId, '其他ID');
}

// ---- gvizCellIsTrue_：庫外旗標讀取要同時相容布林與字串（2026-11-27 審查補） ----
assertEqual('布林 true → true', gvizCellIsTrue_(true), true);
assertEqual('字串 "TRUE" → true', gvizCellIsTrue_('TRUE'), true);
assertEqual('字串 "true"（大小寫不同）→ true', gvizCellIsTrue_('true'), true);
assertEqual('布林 false → false', gvizCellIsTrue_(false), false);
assertEqual('字串 "FALSE" → false', gvizCellIsTrue_('FALSE'), false);
assertEqual('空字串 → false', gvizCellIsTrue_(''), false);
assertEqual('undefined → false', gvizCellIsTrue_(undefined), false);

// ---- gvizCellToIsoDate_：記錄日期讀取要能正規化 gviz 日期格式（2026-11-27 審查補，方案A） ----
assertEqual('Date(2026,10,27) → 2026-11-27（月份0起算+1）', gvizCellToIsoDate_('Date(2026,10,27)'), '2026-11-27');
assertEqual('Date(2026,0,1) → 2026-01-01（月初）', gvizCellToIsoDate_('Date(2026,0,1)'), '2026-01-01');
assertEqual('Date(2026,11,31) → 2026-12-31（年底）', gvizCellToIsoDate_('Date(2026,11,31)'), '2026-12-31');
assertEqual('已經是 YYYY-MM-DD 原樣傳回', gvizCellToIsoDate_('2026-11-27'), '2026-11-27');
assertEqual('空字串 → 空字串', gvizCellToIsoDate_(''), '');
assertEqual('undefined → 空字串', gvizCellToIsoDate_(undefined), '');
assertEqual('格式不明字串原樣傳回，不報錯', gvizCellToIsoDate_('不是日期的亂字串'), '不是日期的亂字串');

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
