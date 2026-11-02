// ============================================================
// A5「本週」：解析 Google 日曆私密 iCal（.ics），給 worker.js 的
// fetchGoogleCalendarEvents_() 用。只處理單次事件與簡單重複規則
// （RRULE FREQ=DAILY/WEEKLY，含 BYDAY/UNTIL/COUNT/INTERVAL），
// 不保證處理「每月第N個星期幾」這類複雜規則（docs/PROPOSAL-A5-weekly.md 已記過這個限制）。
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
function expandRecurrence_(startDate, rrule, horizonStart, horizonEnd) {
  const freq = rrule.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return []; // 月/年重複這次不支援

  const interval = parseInt(rrule.INTERVAL || '1', 10) || 1;
  const until = rrule.UNTIL ? parseIcsDateOnly_(rrule.UNTIL) : null;
  const count = rrule.COUNT ? parseInt(rrule.COUNT, 10) : null;
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const allowedDow = rrule.BYDAY ? rrule.BYDAY.split(',').map(d => DOW[d]).filter(n => n !== undefined) : null;
  const startWeekStart = startOfWeekMonday_(startDate);

  const scanEnd = (until && until < horizonEnd) ? until : horizonEnd;
  const dates = [];
  let occurrences = 0;
  let cur = new Date(startDate);
  let guard = 0;
  while (cur <= scanEnd && guard < 2000) {
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
