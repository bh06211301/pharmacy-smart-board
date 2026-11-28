// ============================================================
// SHEET_ORDER（訂單明細）／SHEET_ORDER_MASTER（訂單主檔）改用 export?format=csv 讀取的
// 純轉換函式（分支 fix/order-raw-csv-read）。不依賴 DOM／fetch／Worker 環境，方便單元測試。
//
// 背景：2026-11-27 稽核發現 gviz（tqx=out:json）對這兩張表的部分欄位（訂單編號、明細ID、
// 借出/歸還日期等）會整欄把格式跟多數樣本不符的儲存格清成 null——因為 gviz 用少量樣本推斷
// 整欄的型態，混格式的欄位就會中獎。export?format=csv 拿到的是原始顯示字串，不會有這個問題，
// 但要自己把字串轉回跟 gviz 相同的 {rows:[{c:[{v}...]}], colMap} 形狀，讓既有 handler
// （用 colMap/row.c[i].v 介面）不需要改。
//
// 欄位型態用「寫死的schema」而不是重新推斷型態——重新推斷正是 gviz 會出錯的做法。
// schema 來源：2026-11-27 直接讀 gviz 的 cols[].type 取得，之後若試算表欄位有新增/改名/
// 改變型態，要同步更新這裡（跟 worker.js 裡任何讀取邏輯一樣，本來就要跟著表結構變動維護）。
//
// ⚠️ export CSV 讀到的是「顯示文字」（Google試算表儲存格的格式化顯示值），不是底層的完整
// 數值精度。如果試算表把某欄的顯示格式設成「只顯示整數」或「只顯示小數點後兩位」之類的格式，
// CSV 讀到的字串就已經被截斷/四捨五入過，這裡的轉換函式無從分辨「真的只有這麼多位」還是
// 「被格式設定藏起來了」——跟 gviz 讀 f（格式化值）會遇到同樣的風險，但 gviz 讀 v（底層值）
// 本來是不會有這個問題的，改走 CSV 等於主動放棄這層保障。如果之後要改任何一欄的數字顯示格式
// （含小計、總金額、數量、單價等），改之前要先重跑 tools/verify-order-csv-equivalence.mjs
// 確認「CSV轉換後的值」跟「gviz原本讀到的值」還是對得上，不要假設格式改了沒事。
// ============================================================

export const ORDER_SHEET_COLUMN_TYPES_ = {
  '明細ID': 'number',
  '訂單編號': 'number',
  '分類篩選': 'string',
  '產品ID': 'string',
  '數量': 'number',
  '單價': 'number',
  '小計': 'number',
  '效期': 'string',
  '實體_歷史購買提示': 'string',
  '店名_備份': 'string',
  '理貨位置': 'string',
  '單件體積': 'number',
  '總體積': 'number',
  '明細類型': 'string',
  '適用促銷比例': 'string',
  '備註': 'string',
  '已購累積量': 'number',
  '已贈累積量': 'number',
};

export const ORDER_MASTER_SHEET_COLUMN_TYPES_ = {
  '訂單編號': 'number',
  '訂單日期': 'date',
  '店名': 'string',
  '店名_中文': 'string',
  '總金額': 'number',
  '訂單狀態': 'string',
  '備註': 'string',
  '縣市': 'string',
  '行政區': 'string',
  '紅單實體狀態': 'string',
  '所屬資料夾': 'string',
  '[客戶地址_顯示]': 'string',
  '借出日期': 'date',
  '歸還日期': 'date',
  '貨運公司': 'string',
};

// 簡易 CSV 解析：處理雙引號包住的欄位、欄內逗號、欄內換行、\r\n 換行。
export function parseExportCsv_(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // 忽略，跟後面的 \n 一起處理換行
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTH_ABBR_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// export CSV 的日期欄觀察到兩種顯示格式：
//   1. 'yyyy/m/d'（例如 '2026/11/6'，SHEET_ORDER_MASTER 三個日期欄最常見的格式）
//   2. JS Date.toString() 格式（例如 'Sun Aug 16 2026 00:00:00 GMT+0800 (台北標準時間)'，
//      少數舊資料/特定輸入方式會變成這樣）
// 兩種都用字串直接抽年月日，不經過 new Date() 轉換，避免時區換算把日期拉早/拉晚一天。
// 解析失敗回 null（呼叫端視同這格空白，不會比 gviz 更差——gviz 遇到這種情況本來就是 null）。
export function parseExportDateCell_(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return { y: parseInt(m[1], 10), m0: parseInt(m[2], 10) - 1, d: parseInt(m[3], 10) };
  m = s.match(/^\w{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (m) {
    const mi = MONTH_ABBR_.indexOf(m[1]);
    if (mi >= 0) return { y: parseInt(m[3], 10), m0: mi, d: parseInt(m[2], 10) };
  }
  return null;
}

// 把 export CSV 的一個原始字串，依欄位型態轉成跟 gviz cell.v 相同形狀的值。
// 真正的空字串（長度0）才回 null（gviz 對空白儲存格的 v 就是 null）；純空白字元（例如
// 使用者不小心打了一個全形/半形空格）gviz 會原樣保留成字串，不是 null，這裡要跟它一致
// （2026-11-27 等價性測試抓到的真實案例：SHEET_ORDER_MASTER 某列「[客戶地址_顯示]」欄
// 存的就是單一個空格字元）——只有 number/date 兩種型態才需要 trim 過再判斷能不能解析。
export function exportCellToGvizValue_(raw, type) {
  const s = String(raw ?? '');
  if (s === '') return null;
  if (type === 'number') {
    const cleaned = s.replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const parsed = parseExportDateCell_(s);
    return parsed ? `Date(${parsed.y},${parsed.m0},${parsed.d})` : null;
  }
  return s;
}

// gviz 會整列跳過完全空白的列（每一欄都是空字串），export CSV 會保留它們——兩邊列數要能
// 對齊比較，這裡也跳過，行為才會跟 gviz 一致（2026-11-27 稽核：SHEET_ORDER 16列、
// SHEET_ORDER_MASTER 5列都屬於這種完全空白列，不是哪一欄特別漏讀）。
export function isBlankCsvRow_(rowArr) {
  return rowArr.every(v => String(v ?? '').trim() === '');
}

// 欄位對不上的保護：CSV 標題列必須跟 schema「數量、順序、名稱」完全一致，才信任這份 CSV。
// 任何一種不符（多一欄、少一欄、順序換位、欄名改了）都當作「這份 CSV 不可信」處理——
// 不是因為順序理論上一定會讀錯（exportRowsToGvizShape_ 是用欄名查表、不是用位置），而是
// 「標題跟寫死的schema對不上」本身就代表試算表結構變了，我們沒有同步更新schema，繼續讀
// 下去可能把新欄位誤判成舊欄位的型態（例如新插入一欄剛好也是純數字，被當成訂單編號解析）。
// 呼叫端收到 ok:false 要整個退回 gviz，不能只挑欄位部分相信。
export function validateCsvHeader_(headerRow, columnTypes) {
  const expected = Object.keys(columnTypes);
  if (!Array.isArray(headerRow) || headerRow.length !== expected.length) {
    return { ok: false, reason: `欄位數量不符：預期${expected.length}欄，實際${headerRow ? headerRow.length : 0}欄` };
  }
  for (let i = 0; i < expected.length; i++) {
    if (headerRow[i] !== expected[i]) {
      return { ok: false, reason: `第${i + 1}欄不符：預期「${expected[i]}」，實際「${headerRow[i]}」` };
    }
  }
  return { ok: true, reason: null };
}

// 把「標題列 + 資料列」轉成跟 fetchGvizSheetRaw_() 回傳相同形狀：{ rows, colMap }。
// rows[i].c[j] 是 { v } 或 null（gviz 對空白儲存格就是整個 c[j] 為 null，不是 {v:null}），
// 跟既有的 gvizGet()／row.c[i]?.v 用法完全相容。
export function exportRowsToGvizShape_(headerRow, dataRows, columnTypes) {
  const colMap = {};
  headerRow.forEach((label, i) => { colMap[label] = i; });
  const rows = dataRows
    .filter(rowArr => !isBlankCsvRow_(rowArr))
    .map(rowArr => ({
      c: headerRow.map((label, i) => {
        const type = columnTypes[label] || 'string';
        const v = exportCellToGvizValue_(rowArr[i], type);
        return v === null ? null : { v };
      }),
    }));
  return { rows, colMap };
}

// ============================================================
// handleStoreTimeline（A8 時間軸）用：同店叫貨明細依「可辨識的訂單」分組成一筆事件。
// 原本用 `o.orderNo || o.date` 當 key，兩者都空的列會全部共用同一個 key `''`，被誤合併成
// 一筆（2026-11-28 發現）。訂單編號/日期都沒有時，改用「這一列在陣列中的位置」當獨立 key，
// 保證每一列各自成一筆事件，不會被不相關的列誤合併。
// ============================================================
export function orderTimelineGroupKey_(order, rowIndex) {
  if (order.orderNo) return `no:${order.orderNo}`;
  if (order.date) return `date:${order.date}`;
  return `row:${rowIndex}`;
}

export function groupOrdersForTimeline_(orders) {
  const groups = {};
  orders.forEach((o, idx) => {
    const key = orderTimelineGroupKey_(o, idx);
    if (!groups[key]) groups[key] = { orderNo: o.orderNo, date: o.date, items: [], total: 0 };
    groups[key].items.push(`${o.productName}×${o.qty}`);
    groups[key].total += o.subtotal;
  });
  return Object.values(groups);
}
