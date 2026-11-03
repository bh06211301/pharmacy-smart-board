// ============================================================
// A5「本週」／A6「本月」：解析 Google 日曆私密 iCal（.ics），給 worker.js 的
// fetchGoogleCalendarEvents_() 用。只處理單次事件與簡單重複規則
// （RRULE FREQ=DAILY/WEEKLY/MONTHLY/YEARLY，含 BYDAY/BYMONTH/BYMONTHDAY/UNTIL/COUNT/INTERVAL，
// 2026-11-03 從原本只支援 DAILY/WEEKLY 加上 MONTHLY/YEARLY），
// 不保證處理「每月第N個星期幾」這類更複雜的規則（docs/PROPOSAL-A5-weekly.md 已記過這個限制，
// MONTHLY/YEARLY 只支援固定日期，例如「每月5號」「每年12/14」，不支援「每月第二個星期二」）。
// ============================================================

function unfoldIcsLines_(text) {
  const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  rawLines.forEach(line => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length) {
      lines.push(line);
    }
  });
  return lines;
}

function unescapeIcsText_(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcsProperty_(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  parts.slice(1).forEach(p => {
    const eq = p.indexOf('=');
    if (eq >= 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  });
  return { name, params, value };
}

// 只取日期部分（YYYYMMDD 開頭），忽略時區細節——這個用途只需要「哪一天」，不需要精確到分鐘。
function parseIcsDateOnly_(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDate_(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeekMonday_(d) {
  const day = d.getDay(); // 0=週日...6=週六
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// 逐日掃描展開重複事件（只支援 DAILY/WEEKLY），範圍限制在 [horizonStart, horizonEnd] 內，
// 有 guard 上限避免 ICS 格式異常造成無窮迴圈。
//
// 2026-11-03 修正過一個真實 bug：原本不管系列起算日多早，都從 startDate 逐天累加到 horizonStart，
// 如果系列是好幾年前開始的（例如長年每週提醒），光是走到「現在」就可能超過 guard 上限，導致還沒
// 掃到真正有意義的未來範圍就被攔停，整個系列查無任何未來場次（用使用者真實的 Google 日曆 ICS 實測
// 踩到：172 筆事件裡有 2 筆長年每週重複的，解析結果是 0 筆，改好後能正確展開）。
// 修法：沒有 COUNT 限制時，用除法直接跳到 horizonStart 附近對齊週期的那一天/那一週再開始逐日掃描，
// 不用從起算日逐天累加；有 COUNT 限制的系列通常較短，維持原本從起算日開始算（COUNT 用來判斷系列
// 有沒有提早結束），guard 上限放寬到 20000 避免系列起算日較早、COUNT 較大時誤判。
function expandRecurrence_(startDate, rrule, horizonStart, horizonEnd) {
  const freq = rrule.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return [];

  const interval = parseInt(rrule.INTERVAL || '1', 10) || 1;
  const until = rrule.UNTIL ? parseIcsDateOnly_(rrule.UNTIL) : null;
  const count = rrule.COUNT ? parseInt(rrule.COUNT, 10) : null;

  // YEARLY（含 BYMONTH/BYMONTHDAY，沒有就用起算日自己的月/日，典型如生日/紀念日）跟 MONTHLY
  // （含 BYMONTHDAY，典型如「每月5號」；不支援「每月第N個星期幾」這種更複雜的規則）用「逐週期」
  // 直接列舉候選日期，不是逐天掃描——候選數量天生就少（幾年份或幾十個月），用不到 DAILY/WEEKLY
  // 那套「跳到 horizon 附近再逐日掃」的效能優化，直接列舉更直覺、不容易出錯（2026-11-03 新增，
  // 使用者實測發現一筆 12/14 全年重複的全天事件原本完全沒有被展開出來）。
  if (freq === 'YEARLY' || freq === 'MONTHLY') {
    const scanEndYM = (until && until < horizonEnd) ? until : horizonEnd;
    return expandYearlyOrMonthly_(startDate, rrule, freq, interval, count, horizonStart, scanEndYM);
  }

  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const allowedDow = rrule.BYDAY ? rrule.BYDAY.split(',').map(d => DOW[d]).filter(n => n !== undefined) : null;
  const startWeekStart = startOfWeekMonday_(startDate);

  const scanEnd = (until && until < horizonEnd) ? until : horizonEnd;
  const dates = [];

  let cur = new Date(startDate);
  if (count === null && cur < horizonStart) {
    if (freq === 'DAILY') {
      const daysSinceStart = Math.floor((horizonStart - startDate) / 86400000);
      const skip = Math.floor(daysSinceStart / interval) * interval;
      cur = new Date(startDate.getTime() + skip * 86400000);
    } else {
      const weeksSinceStart = Math.floor((startOfWeekMonday_(horizonStart) - startWeekStart) / (7 * 86400000));
      const skip = Math.floor(weeksSinceStart / interval) * interval;
      cur = new Date(startDate.getTime() + skip * 7 * 86400000);
    }
    if (cur < startDate) cur = new Date(startDate); // 保險，不要往回跳到起算日之前
  }

  let occurrences = 0;
  const guardMax = count !== null ? 20000 : 2000;
  let guard = 0;
  while (cur <= scanEnd && guard < guardMax) {
    guard++;
    let hit = false;
    if (freq === 'DAILY') {
      const daysFromStart = Math.round((cur - startDate) / 86400000);
      hit = daysFromStart % interval === 0;
    } else { // WEEKLY
      const curWeekStart = startOfWeekMonday_(cur);
      const weeksFromStart = Math.round((curWeekStart - startWeekStart) / (7 * 86400000));
      if (weeksFromStart % interval === 0) {
        hit = allowedDow ? allowedDow.includes(cur.getDay()) : cur.getDay() === startDate.getDay();
      }
    }
    if (hit) {
      if (cur >= horizonStart) dates.push(new Date(cur));
      occurrences++;
      if (count !== null && occurrences >= count) break;
    }
    cur = new Date(cur.getTime() + 86400000);
  }
  return dates;
}

// YEARLY／MONTHLY 用的候選日期列舉（不支援「每月第N個星期幾」，只支援固定日期）。
// candidate 算出來那個月份沒有這天（例如非閏年的2/29、小月的31號）就直接跳過不硬湊到別天，
// 這是常見 ICS 處理方式的保守做法，不是漏算。
function expandYearlyOrMonthly_(startDate, rrule, freq, interval, count, horizonStart, scanEnd) {
  const byMonth = rrule.BYMONTH ? parseInt(rrule.BYMONTH, 10) : null;   // 只取第一個值，逗號多值這次不展開
  const byMonthDay = rrule.BYMONTHDAY ? parseInt(rrule.BYMONTHDAY, 10) : null;
  const targetMonth = byMonth !== null ? byMonth - 1 : startDate.getMonth(); // 0-based
  const targetDay = byMonthDay !== null ? byMonthDay : startDate.getDate();

  const dates = [];
  let occurrences = 0;
  if (freq === 'YEARLY') {
    const startYear = startDate.getFullYear();
    for (let y = startYear; y <= scanEnd.getFullYear(); y++) {
      if ((y - startYear) % interval !== 0) continue;
      const candidate = new Date(y, targetMonth, targetDay);
      if (candidate.getMonth() !== targetMonth) continue; // 該年該月沒有這一天
      if (candidate < startDate) continue; // 系列開始之前不算
      occurrences++;
      if (count !== null && occurrences > count) break;
      if (candidate >= horizonStart && candidate <= scanEnd) dates.push(candidate);
    }
  } else { // MONTHLY
    const startYear = startDate.getFullYear();
    const startMonthIdx = startDate.getMonth();
    const totalMonthsSpan = (scanEnd.getFullYear() - startYear) * 12 + (scanEnd.getMonth() - startMonthIdx) + 1;
    for (let i = 0; i < totalMonthsSpan && i < 2000; i++) {
      if (i % interval !== 0) continue;
      const y = startYear + Math.floor((startMonthIdx + i) / 12);
      const m = (startMonthIdx + i) % 12;
      const candidate = new Date(y, m, targetDay);
      if (candidate.getMonth() !== m) continue; // 該月沒有這一天（例如31號遇到小月）
      if (candidate < startDate) continue;
      occurrences++;
      if (count !== null && occurrences > count) break;
      if (candidate >= horizonStart && candidate <= scanEnd) dates.push(candidate);
    }
  }
  return dates;
}

// 解析 ICS 文字，回傳 [{date:'YYYY-MM-DD', title, allDay}]，依日期排序、去重。
// 範圍預設抓「現在往前 7 天～往後 100 天」，夠蓋 A5/A6 需要看到的範圍。
export function parseIcsEvents_(icsText, { horizonPastDays = 7, horizonFutureDays = 100 } = {}) {
  const lines = unfoldIcsLines_(icsText);
  const now = new Date();
  const horizonStart = new Date(now); horizonStart.setDate(horizonStart.getDate() - horizonPastDays);
  const horizonEnd = new Date(now); horizonEnd.setDate(horizonEnd.getDate() + horizonFutureDays);

  const events = [];
  let cur = null;
  lines.forEach(line => {
    if (line === 'BEGIN:VEVENT') { cur = {}; return; }
    if (line === 'END:VEVENT') {
      if (cur && cur.dtstart) {
        if (cur.rrule) {
          expandRecurrence_(cur.dtstart, cur.rrule, horizonStart, horizonEnd).forEach(d => {
            events.push({ date: fmtDate_(d), title: cur.summary || '(無標題)', allDay: !!cur.allDay });
          });
        } else if (cur.dtstart >= horizonStart && cur.dtstart <= horizonEnd) {
          events.push({ date: fmtDate_(cur.dtstart), title: cur.summary || '(無標題)', allDay: !!cur.allDay });
        }
      }
      cur = null;
      return;
    }
    if (!cur) return;
    const prop = parseIcsProperty_(line);
    if (!prop) return;
    if (prop.name === 'DTSTART') {
      cur.dtstart = parseIcsDateOnly_(prop.value);
      cur.allDay = prop.params.VALUE === 'DATE';
    } else if (prop.name === 'SUMMARY') {
      cur.summary = unescapeIcsText_(prop.value);
    } else if (prop.name === 'RRULE') {
      const rrule = {};
      prop.value.split(';').forEach(kv => {
        const eq = kv.indexOf('=');
        if (eq > 0) rrule[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
      });
      cur.rrule = rrule;
    }
  });

  const seen = new Set();
  return events
    .filter(e => {
      const key = e.date + '|' + e.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
