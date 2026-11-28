// 等價性驗證（唯讀，一次性腳本，分支 fix/order-raw-csv-read）：
// 對 SHEET_ORDER／SHEET_ORDER_MASTER，比較 gviz 原本讀到的值 vs. export CSV 經
// order-csv-reader.js 轉換後的值。要求：gviz 有值（非null）的儲存格，轉換後必須完全相同
// （數字比數值、日期轉成同一個 Date(y,m,d) 字面值、文字比字串）；唯一允許的差異是
// 「gviz 原本被漏讀(null)、CSV轉換後有值」這種補回的情況。
// 只送 GET，不寫入，不帶任何金鑰/token。
// 執行：node tools/verify-order-csv-equivalence.mjs

import {
  ORDER_SHEET_COLUMN_TYPES_,
  ORDER_MASTER_SHEET_COLUMN_TYPES_,
  parseExportCsv_,
  exportRowsToGvizShape_,
} from '../order-csv-reader.js';

const TARGETS = [
  { label: 'SHEET_ORDER（訂單明細）', sheetId: '13HB7e9mzL0H6Nhfyl-AKhjO8M_GElnqPldTk-u-0ni8', gid: 0, columnTypes: ORDER_SHEET_COLUMN_TYPES_ },
  { label: 'SHEET_ORDER_MASTER（訂單主檔）', sheetId: '1qa5aqeAPZlo8hyNMA6xD4VCk334B3pnhKyLSkBbhcmo', gid: 0, columnTypes: ORDER_MASTER_SHEET_COLUMN_TYPES_ },
];

async function fetchGvizJson_(sheetId) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`);
  const text = await res.text();
  const m = text.match(/^.*?({.*}).*$/s);
  const data = JSON.parse(m[1]);
  const cols = (data?.table?.cols || []).map(c => c.label);
  const rows = data?.table?.rows || [];
  return { cols, rows };
}

async function fetchExportCsv_(sheetId, gid) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`);
  const text = await res.text();
  const table = parseExportCsv_(text);
  const header = table[0] || [];
  const rows = table.slice(1).filter(r => !(r.length === 1 && r[0] === ''));
  return { header, rows };
}

async function verifyOne_(target) {
  console.log(`\n===== ${target.label} =====`);
  const [gviz, exp] = await Promise.all([
    fetchGvizJson_(target.sheetId),
    fetchExportCsv_(target.sheetId, target.gid),
  ]);
  const converted = exportRowsToGvizShape_(exp.header, exp.rows, target.columnTypes);

  const minLen = Math.min(gviz.rows.length, converted.rows.length);
  if (gviz.rows.length !== converted.rows.length) {
    console.log(`  ⚠ 列數不同：gviz=${gviz.rows.length}　轉換後=${converted.rows.length}（轉換後應該 >= gviz，因為CSV不會漏讀空白列以外的列；差異應該等於全空白列數）`);
  }

  let totalCells = 0, sameCount = 0, recoveredCount = 0, mismatchCount = 0;
  const mismatches = [];

  for (let i = 0; i < minLen; i++) {
    const gRow = gviz.rows[i];
    const cRow = converted.rows[i];
    gviz.cols.forEach((label, ci) => {
      if (!(label in target.columnTypes)) return; // schema沒定義的欄位不比對（通常是空白佔位欄）
      totalCells++;
      const gCell = gRow.c[ci];
      const gVal = gCell ? gCell.v : null;
      const cCell = cRow.c[ci];
      const cVal = cCell ? cCell.v : null;

      if (gVal === null || gVal === undefined || gVal === '') {
        if (cVal !== null && cVal !== undefined && cVal !== '') {
          recoveredCount++; // gviz原本漏讀，CSV轉換後補回來了——預期內的差異
        } else {
          sameCount++; // 兩邊都是空
        }
        return;
      }

      // gviz 有值：比對是否完全相同
      let equal;
      if (typeof gVal === 'number') {
        equal = Math.abs(Number(cVal) - gVal) < 1e-9;
      } else {
        equal = String(gVal) === String(cVal);
      }
      if (equal) {
        sameCount++;
      } else {
        mismatchCount++;
        if (mismatches.length < 15) {
          mismatches.push({ row: i, col: label, gviz: gVal, converted: cVal });
        }
      }
    });
  }

  console.log(`  比對儲存格數：${totalCells}`);
  console.log(`  相同：${sameCount}`);
  console.log(`  補回（gviz原本null，轉換後有值）：${recoveredCount}`);
  console.log(`  不一致：${mismatchCount}`);
  if (mismatches.length) {
    console.log('  不一致樣本：');
    mismatches.forEach(m => console.log(`    列${m.row} 欄「${m.col}」 gviz=${JSON.stringify(m.gviz)} 轉換後=${JSON.stringify(m.converted)}`));
  }

  return { label: target.label, totalCells, sameCount, recoveredCount, mismatchCount };
}

async function main() {
  const results = [];
  for (const t of TARGETS) results.push(await verifyOne_(t));
  console.log('\n\n========== 總表 ==========');
  results.forEach(r => {
    console.log(`${r.label}：總${r.totalCells}　相同${r.sameCount}　補回${r.recoveredCount}　不一致${r.mismatchCount}`);
  });
  const anyMismatch = results.some(r => r.mismatchCount > 0);
  if (anyMismatch) {
    console.error('\n⚠ 發現不一致，轉換邏輯需要修正（見上方樣本）');
    process.exit(1);
  }
  console.log('\n全部通過：gviz有值的儲存格轉換後完全相同，唯一差異是補回原本被漏讀的儲存格。');
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
