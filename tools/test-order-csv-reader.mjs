// order-csv-reader.js 單元測試（分支 fix/order-raw-csv-read）。
// 直接 import 真實模組，執行：node tools/test-order-csv-reader.mjs

import {
  parseExportCsv_,
  parseExportDateCell_,
  exportCellToGvizValue_,
  exportRowsToGvizShape_,
  isBlankCsvRow_,
  ORDER_SHEET_COLUMN_TYPES_,
  ORDER_MASTER_SHEET_COLUMN_TYPES_,
} from '../order-csv-reader.js';

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

// ---- parseExportCsv_ ----
assertEqual('基本逗號分隔', parseExportCsv_('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
assertEqual('雙引號包住含逗號的欄位', parseExportCsv_('a,b\n"1,000",2\n'), [['a', 'b'], ['1,000', '2']]);
assertEqual('雙引號內的雙引號跳脫', parseExportCsv_('a\n"he said ""hi"""\n'), [['a'], ['he said "hi"']]);
assertEqual('欄位內換行（雙引號包住）', parseExportCsv_('a,b\n"line1\nline2",2\n'), [['a', 'b'], ['line1\nline2', '2']]);
assertEqual('CRLF換行', parseExportCsv_('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
assertEqual('空輸入回空陣列', parseExportCsv_(''), []);

// ---- parseExportDateCell_ ----
assertEqual('yyyy/m/d格式', parseExportDateCell_('2026/11/6'), { y: 2026, m0: 10, d: 6 });
assertEqual('yyyy/mm/dd格式（有補零）', parseExportDateCell_('2026/01/02'), { y: 2026, m0: 0, d: 2 });
assertEqual('JS Date.toString()格式', parseExportDateCell_('Sun Aug 16 2026 00:00:00 GMT+0800 (台北標準時間)'), { y: 2026, m0: 7, d: 16 });
assertEqual('JS Date.toString()格式（12月）', parseExportDateCell_('Tue Dec 1 2026 00:00:00 GMT+0800 (台北標準時間)'), { y: 2026, m0: 11, d: 1 });
assertEqual('空字串回null', parseExportDateCell_(''), null);
assertEqual('無法辨識格式回null', parseExportDateCell_('not a date'), null);
assertEqual('null輸入回null', parseExportDateCell_(null), null);

// ---- exportCellToGvizValue_ ----
assertEqual('number型態：純數字字串', exportCellToGvizValue_('1000', 'number'), 1000);
assertEqual('number型態：含千分位逗號', exportCellToGvizValue_('1,000', 'number'), 1000);
assertEqual('number型態：空字串回null', exportCellToGvizValue_('', 'number'), null);
assertEqual('number型態：純空白仍回null', exportCellToGvizValue_('   ', 'number'), null);
assertEqual('number型態：11碼訂單編號不失真', exportCellToGvizValue_('20260114001', 'number'), 20260114001);
assertEqual('date型態：yyyy/m/d', exportCellToGvizValue_('2026/11/6', 'date'), 'Date(2026,10,6)');
assertEqual('date型態：空字串回null', exportCellToGvizValue_('', 'date'), null);
assertEqual('string型態：原樣保留', exportCellToGvizValue_('3A', 'string'), '3A');
assertEqual('string型態：空字串回null', exportCellToGvizValue_('', 'string'), null);
// 2026-11-27 等價性測試抓到的真實案例：單一空格字元，gviz不會當成空白，要原樣保留
assertEqual('string型態：純空格字元不是null（跟gviz行為一致）', exportCellToGvizValue_(' ', 'string'), ' ');
assertEqual('未知型態預設當string', exportCellToGvizValue_('x', undefined), 'x');

// ---- isBlankCsvRow_ ----
assertTrue('全部欄位都是空字串才算空白列', isBlankCsvRow_(['', '', '']));
assertTrue('有一欄有值就不算空白列', !isBlankCsvRow_(['', 'x', '']));
assertTrue('只有純空白字元的欄位（trim後為空）仍算空白列', isBlankCsvRow_(['', '  ', '']));

// ---- exportRowsToGvizShape_ ----
{
  const header = ['訂單編號', '店名_備份', '數量'];
  const types = { '訂單編號': 'number', '店名_備份': 'string', '數量': 'number' };
  const dataRows = [
    ['8', 'C018', '2'],
    ['', '', ''], // 完全空白列，應該被跳過
    ['20260114001', 'C001', '3'],
  ];
  const result = exportRowsToGvizShape_(header, dataRows, types);
  assertEqual('colMap正確', result.colMap, { '訂單編號': 0, '店名_備份': 1, '數量': 2 });
  assertEqual('空白列被跳過，剩兩列', result.rows.length, 2);
  assertEqual('第一列轉換正確', result.rows[0], { c: [{ v: 8 }, { v: 'C018' }, { v: 2 }] });
  assertEqual('第二列（原第三列）轉換正確', result.rows[1], { c: [{ v: 20260114001 }, { v: 'C001' }, { v: 3 }] });
}

// ---- schema 常數本身的基本檢查（避免手寫schema時打錯鍵名） ----
assertTrue('ORDER_SHEET_COLUMN_TYPES_ 含訂單編號', ORDER_SHEET_COLUMN_TYPES_['訂單編號'] === 'number');
assertTrue('ORDER_MASTER_SHEET_COLUMN_TYPES_ 含借出日期為date', ORDER_MASTER_SHEET_COLUMN_TYPES_['借出日期'] === 'date');

console.log(`${passed}/${total} passed`);
if (passed !== total) process.exit(1);
