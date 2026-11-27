// ============================================================
// 店端效期功能 — 推估／提醒純函式（分支1：feature/shelf-expiry-estimate）
// 不依賴 DOM／網路／Worker 環境，純資料進、純資料出，方便單元測試與未來被 worker.js import。
// 設計依據：docs/店端效期_設計方案.md 第5、6節。
// parseOrderNoDate 的解析規則需跟 worker.js 既有的 extractDate（約 L1417）／
// extractOrderDateFromNo（約 L1849）兩處重複邏輯保持一致，三處邏輯分家會導致同一張單解析出不同日期。
// ============================================================

// 訂單編號格式：YYMMDDNN → '2026-01-12'；解析失敗回 null（worker.js 既有兩處邏輯回傳的是空字串，
// 這裡改回 null 讓呼叫端用 if (date) 判斷時更直覺，邏輯本身與 worker.js 完全一致）。
export function parseOrderNoDate(orderNo) {
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
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 接受 '28/5'、'28/05'、'2028/5'、'2028-05' 等，統一輸出 'YY/MM'；無法解析回 null。
export function normalizeYearMonth(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{2}|\d{4})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  const yearPart = m[1];
  const yy = yearPart.length === 4 ? (parseInt(yearPart, 10) % 100) : parseInt(yearPart, 10);
  return `${String(yy).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

// 某店某產品的效期推估：取這家店最近一次進貨日，往前後 windowDays 天視窗內，
// 找「其他店同產品、且已有已知效期」的記錄，取最接近的一筆。
// targetStoreOrders: [{date:'YYYY-MM-DD', qty}]
// otherStoreOrders:  [{storeId, date:'YYYY-MM-DD', expiryYearMonth?}]（只有帶 expiryYearMonth 的才算候選）
export function estimateShelfExpiry({ targetStoreOrders = [], otherStoreOrders = [], windowDays = 14 } = {}) {
  const none = { yearMonth: null, confidence: 'none', matchedStoreId: null, matchedDate: null, alternatives: [] };

  const targetDates = (targetStoreOrders || [])
    .filter(o => o && o.date)
    .map(o => o.date)
    .sort((a, b) => (a < b ? 1 : (a > b ? -1 : 0))); // 新到舊
  if (!targetDates.length) return none;

  const targetDate = targetDates[0]; // 最近一次進貨日
  const targetMs = Date.parse(`${targetDate}T00:00:00Z`);
  const windowMs = windowDays * 86400000;

  const candidates = (otherStoreOrders || [])
    .filter(o => o && o.date && o.expiryYearMonth)
    .map(o => ({ ...o, diffMs: Math.abs(Date.parse(`${o.date}T00:00:00Z`) - targetMs) }))
    .filter(o => o.diffMs <= windowMs)
    .sort((a, b) => a.diffMs - b.diffMs);

  if (!candidates.length) return none;

  const best = candidates[0];
  const distinctYearMonths = new Set(candidates.map(c => c.expiryYearMonth));
  // 視窗內若存在不同效期的候選，代表有歧義，需要人工判斷（confidence:'medium'）；
  // 若視窗內多筆候選都指向同一個效期年月，則不構成歧義，仍視為 'high'。
  const confidence = distinctYearMonths.size > 1 ? 'medium' : 'high';

  return {
    yearMonth: best.expiryYearMonth,
    confidence,
    matchedStoreId: best.storeId ?? null,
    matchedDate: best.date,
    alternatives: candidates.slice(1).map(c => ({
      yearMonth: c.expiryYearMonth,
      storeId: c.storeId ?? null,
      date: c.date,
    })),
  };
}

// 日曆月數差（today - last），處理月底邊界：例如 last=2026-01-31, today=2026-02-28（2月沒有31日）
// 應視為「剛好 1 個月」，不是 0 個月。
function calendarMonthsBetween_(today, last) {
  let months = (today.getFullYear() - last.getFullYear()) * 12 + (today.getMonth() - last.getMonth());
  if (today.getDate() < last.getDate()) {
    const lastDayOfTodayMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    if (today.getDate() !== lastDayOfTodayMonth) {
      months -= 1;
    }
  }
  return months;
}

function toDate_(input) {
  return input instanceof Date ? input : new Date(input);
}

// 該店該產品是否該去看效期：距今月數 >= 門檻，且「沒有實看記錄」或「實看記錄日期早於最近一次進貨日」。
// latestObservation：該店該產品最近一筆「實看」記錄 { date } 或 null。
export function needsExpiryCheck({ today, lastDeliveryDate, monthsThreshold = 4, latestObservation = null } = {}) {
  if (!today || !lastDeliveryDate) return false;
  const todayDate = toDate_(today);
  const lastDate = toDate_(lastDeliveryDate);
  const months = calendarMonthsBetween_(todayDate, lastDate);
  if (months < monthsThreshold) return false;
  if (!latestObservation || !latestObservation.date) return true;
  const obsDate = toDate_(latestObservation.date);
  return obsDate < lastDate;
}

// 同店同產品多筆「店端效期」記錄時，取目前應顯示的那一筆：
// 來源優先序 手動指定 ≥ 實看 > 推估；同優先序取記錄日期最新。
export function pickCurrentRecord(records) {
  if (!records || !records.length) return null;
  const rank_ = source => (source === '手動指定' || source === '實看') ? 2 : 1;
  return records.slice().sort((a, b) => {
    const rankDiff = rank_(b.source) - rank_(a.source);
    if (rankDiff !== 0) return rankDiff;
    const ad = a.date || '', bd = b.date || '';
    return ad < bd ? 1 : (ad > bd ? -1 : 0);
  })[0];
}
