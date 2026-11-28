// 唯讀稽核：比較 gviz（tqx=out:json）與 Google 試算表 export?format=csv 兩種讀法，
// 確認 gviz 到底在哪些分頁、哪些欄位會漏讀（整欄被清 null、整列消失、或整頁讀錯）。
// 背景：2026-11-27 發現 gviz 讀 SHEET_ORDER 的「訂單編號」欄時，因為欄位同時混有不同長度的
// 數字格式，gviz 把其中 582 列整欄清成 null，還整體少讀 16 列；export CSV 不會有這個問題。
// 本腳本把同樣的比對方式套用到 worker.js 實際用到的其他分頁，看是不是只有 SHEET_ORDER 中獎。
//
// 分頁的 gid 不是從0連續編號（後建的分頁常是一大串隨機數字），export?format=csv 一定要帶對的
// gid 才讀得到正確分頁。這裡改用 Google 試算表的 /htmlview 端點抓「分頁名稱→gid」對照表
// （公開分頁才看得到，跟 gviz/export 用同一套可視性規則），不用再亂猜 gid。
//
// 只送 GET，不寫入，不帶任何金鑰/token（Sheet ID 都是文件已公開記載、非金鑰的識別碼）。
// 執行：node tools/audit-gviz-vs-export.mjs

const SHEETS_ = {
  SHEET_ORDER:        '13HB7e9mzL0H6Nhfyl-AKhjO8M_GElnqPldTk-u-0ni8',
  SHEET_ORDER_MASTER: '1qa5aqeAPZlo8hyNMA6xD4VCk334B3pnhKyLSkBbhcmo',
  SHEET_PRODUCT:      '1tyJYRWVPl7F5kprBylR_WbbIVayIWQEUxdQ-2sCL-cM',
  SHEET_RETURN:       '1k78DwiqyfoumGy6Fo0r0NuVFO-COoii1UhwTNAH0tW8',
  SHEET_RETURN_ORDER: '1MtWqkS_xG-6A7gKlYFQQ9VUIXizyE0nTBeDoLfcldJs',
  SHEET_PLANNER:      '1wNrA6kUumbJCBpzHz4LY0X5AlQjW6Q9nGtpfVTn67ZY',
  SHEET_INVENTORY:    '1MpGBRGjd5geqU5K3Qh1SVp-RqrBXlasuYQWb2PfSw6w',
  SHEET_PHARMACY:     '1qJ62K5Hd2bKP9DdQTjwJOOy0njNICMSPiayW7YJZdNM',
  SHEET_CONTRACT:     '10zWisKoSqiMS1v6hwzy4lzIs4CkkCBhuhetN7_jlsbU', // 已知未開放「知道連結的人可檢視」
};

// {sheetVar, sheetName}：sheetName=null 代表 worker.js 讀「第一個分頁」（沒有傳 sheetName 參數）
const TARGETS = [
  { sheetVar: 'SHEET_ORDER',        sheetName: null },
  { sheetVar: 'SHEET_ORDER_MASTER', sheetName: null },
  { sheetVar: 'SHEET_PRODUCT',       sheetName: null },
  { sheetVar: 'SHEET_RETURN',        sheetName: null },
  { sheetVar: 'SHEET_RETURN_ORDER',  sheetName: null },
  { sheetVar: 'SHEET_PLANNER',       sheetName: '待追蹤' },
  { sheetVar: 'SHEET_PLANNER',       sheetName: '店家規則' },
  { sheetVar: 'SHEET_PLANNER',       sheetName: '階段歷程' },
  { sheetVar: 'SHEET_PLANNER',       sheetName: '標籤定義' },
  { sheetVar: 'SHEET_PLANNER',       sheetName: '今日行程' },
  { sheetVar: 'SHEET_INVENTORY',     sheetName: '盤點主檔' },
  { sheetVar: 'SHEET_INVENTORY',     sheetName: '盤點明細' },
  { sheetVar: 'SHEET_PHARMACY',      sheetName: '新客戶資料表_AppSheet' },
  { sheetVar: 'SHEET_CONTRACT',      sheetName: '客戶合約' },
];

function parseCsv_(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 忽略 */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 用 /htmlview 取得這份試算表真正存在的「分頁名稱→gid」對照表（公開分頁清單，非 gviz）
const tabListCache_ = {};
async function fetchTabList_(sheetId) {
  if (tabListCache_[sheetId]) return tabListCache_[sheetId];
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;
  const res = await fetch(url);
  const text = await res.text();
  const items = [...text.matchAll(/\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:[^,]*,\s*gid:\s*"(\d+)"/g)]
    .map(m => ({ name: m[1], gid: m[2] }));
  tabListCache_[sheetId] = items;
  return items;
}

async function fetchGvizJson_(sheetId, sheetName) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const url = sheetName ? `${base}&sheet=${encodeURIComponent(sheetName)}` : base;
  const res = await fetch(url);
  const text = await res.text();
  if (/accounts\.google\.com|ServiceLogin/.test(text) || /^<!DOCTYPE html|^<html/i.test(text.trim())) {
    throw new Error('gviz 回應是 Google 登入頁（此分頁未開放「知道連結的人可檢視」）');
  }
  const m = text.match(/^.*?({.*}).*$/s);
  if (!m) throw new Error('gviz 回應格式不符預期');
  const data = JSON.parse(m[1]);
  const cols = (data?.table?.cols || []).map(c => c.label);
  const rows = data?.table?.rows || [];
  return { cols, rows };
}

async function fetchExportCsvByGid_(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  const text = await res.text();
  if (/accounts\.google\.com|ServiceLogin/.test(text) || /^<!DOCTYPE html|^<html/i.test(text.trim())) {
    return null;
  }
  const table = parseCsv_(text);
  const header = table[0] || [];
  const rows = table.slice(1).filter(r => !(r.length === 1 && r[0] === ''));
  return { header, rows };
}

function classifyColumnValues_(values) {
  let numericLike = 0, textLike = 0, empty = 0;
  values.forEach(v => {
    const s = String(v ?? '').trim();
    if (s === '') { empty++; return; }
    if (/^-?\d+(\.\d+)?$/.test(s)) numericLike++;
    else textLike++;
  });
  return { numericLike, textLike, empty };
}

async function auditOne_(target) {
  const sheetId = SHEETS_[target.sheetVar];
  const label = `${target.sheetVar}${target.sheetName ? `:${target.sheetName}` : '（第一個分頁）'}`;
  console.log(`\n===== ${label} =====`);

  const tabList = await fetchTabList_(sheetId);
  if (!tabList.length) {
    console.log('  /htmlview 讀不到分頁清單（可能整份試算表未開放「知道連結的人可檢視」）');
    return { label, error: '/htmlview 讀不到分頁清單' };
  }

  let gid;
  if (target.sheetName === null) {
    gid = tabList[0].gid; // worker.js 沒傳 sheetName 時讀的「第一個分頁」＝分頁清單裡排第一個
  } else {
    const found = tabList.find(t => t.name === target.sheetName);
    if (!found) {
      console.log(`  ⚠ 分頁名稱「${target.sheetName}」在這份試算表裡不存在！真實分頁清單：${tabList.map(t => t.name).join('、')}`);
      console.log(`     worker.js 用這個名稱呼叫 gviz 時，gviz 不會報錯，會靜默回退讀「${tabList[0].name}」（第一分頁）。`);
      return { label, error: `分頁「${target.sheetName}」不存在，gviz 會靜默回退讀第一分頁「${tabList[0].name}」` };
    }
    gid = found.gid;
  }

  let gvizResult;
  try {
    gvizResult = await fetchGvizJson_(sheetId, target.sheetName);
  } catch (e) {
    console.log(`  gviz 讀取失敗：${e.message}`);
    return { label, error: `gviz 失敗：${e.message}` };
  }

  const exportResult = await fetchExportCsvByGid_(sheetId, gid);
  if (!exportResult) {
    console.log(`  export CSV（gid=${gid}）讀取失敗（可能是登入頁）`);
    return { label, error: `export CSV（gid=${gid}）讀取失敗` };
  }

  const gvizRowCount = gvizResult.rows.length;
  const exportRowCount = exportResult.rows.length;
  console.log(`  gid=${gid}　gviz 列數：${gvizRowCount}　export CSV 列數：${exportRowCount}　差異：${exportRowCount - gvizRowCount}`);

  const minLen = Math.min(gvizRowCount, exportRowCount);
  if (gvizRowCount !== exportRowCount) {
    console.log(`  ⚠ 兩邊列數不同，逐欄比較僅取前 ${minLen} 列做參考（可能因為列移位而失真，詳見下方抽樣判斷）`);
  }

  const header = exportResult.header;
  const diffByCol = {};
  for (let i = 0; i < minLen; i++) {
    const gRow = gvizResult.rows[i];
    const eRow = exportResult.rows[i];
    header.forEach((colLabel, ci) => {
      const gCell = gRow.c[ci];
      const gVal = gCell ? gCell.v : null;
      const eVal = eRow[ci];
      const gEmpty = (gVal === null || gVal === undefined || gVal === '');
      const eHasValue = eVal !== undefined && String(eVal).trim() !== '';
      if (gEmpty && eHasValue) {
        diffByCol[colLabel] = (diffByCol[colLabel] || 0) + 1;
      }
    });
  }

  const diffEntries = Object.entries(diffByCol).filter(([, n]) => n > 0);
  if (!diffEntries.length) {
    console.log('  逐欄比較：沒有發現「gviz為空但export有值」的欄位');
  } else {
    console.log('  逐欄比較：gviz為空但export有值的列數（只列有差異的欄位）：');
    for (const [colLabel, n] of diffEntries) {
      const colIdx = header.indexOf(colLabel);
      const values = exportResult.rows.map(r => r[colIdx]);
      const { numericLike, textLike, empty } = classifyColumnValues_(values);
      console.log(`    ${colLabel}：${n} 列　（該欄在export原始資料中：數字樣${numericLike}、文字樣${textLike}、空白${empty}）`);
    }
  }

  return {
    label,
    gvizRowCount,
    exportRowCount,
    rowCountDiff: exportRowCount - gvizRowCount,
    diffByCol: diffEntries,
  };
}

async function main() {
  const results = [];
  for (const target of TARGETS) {
    const r = await auditOne_(target);
    results.push(r);
  }

  console.log('\n\n========== 總表 ==========');
  results.forEach(r => {
    if (r.error) {
      console.log(`${r.label}：讀取失敗 — ${r.error}`);
    } else {
      const colSummary = r.diffByCol.length
        ? r.diffByCol.map(([c, n]) => `${c}(${n})`).join('、')
        : '無';
      console.log(`${r.label}：列數差=${r.rowCountDiff}（gviz${r.gvizRowCount}/export${r.exportRowCount}），受影響欄位：${colSummary}`);
    }
  });
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
