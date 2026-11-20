// 2026-11-20：驗證 field-v2.html「標籤與後續提醒」改版的純邏輯函式——
// fv2RuleTagHints_／fv2MergeTagHints_／fv2ShouldAutoCheckFollowup_／fv2FollowupItemText_。
// 跟 field-v2.html 裡的實作保持同一份邏輯（複製貼上，不是 import，因為 field-v2.html 沒有對外匯出函式，
// 比照 test-red-slip-workdays.mjs 的既有慣例）。
// 執行：node tools/test-tag-followup-rules.mjs

const FV2_TAG_HINTS_ = {
  '缺貨': /缺貨|沒貨|斷貨|沒庫存|快賣完|補貨/i,
  '客訴': /客訴|投訴|抱怨|退貨|退換|不滿|不好用/i,
  '價格': /太貴|很貴|價格|價錢|議價|殺價|折扣|便宜/i,
  '競品': /競品|別家|別牌|其他廠牌|別的牌子|他牌/i,
  '滿意': /滿意|很好|不錯|喜歡|回購|好評/i,
};

function fv2RuleTagHints_(text) {
  const t = String(text || '');
  if (!t) return [];
  const hints = [];
  for (const tag of Object.keys(FV2_TAG_HINTS_)) {
    const m = t.match(FV2_TAG_HINTS_[tag]);
    if (m) hints.push({ tag, source: 'rule', evidence: m[0] });
  }
  return hints;
}

function fv2MergeTagHints_(ruleHints, aiHints) {
  const map = {};
  (ruleHints || []).forEach(h => { map[h.tag] = h; });
  (aiHints || []).forEach(h => { map[h.tag] = h; });
  return Object.values(map);
}

function fv2ShouldAutoCheckFollowup_(nextAction, urgent, selectedTags) {
  if (String(nextAction || '').trim()) return true;
  if (String(urgent || '').trim()) return true;
  if (selectedTags.indexOf('缺貨') >= 0) return true;
  if (selectedTags.indexOf('客訴') >= 0) return true;
  return false;
}

function fv2FollowupItemText_(nextAction, urgent, selectedTags) {
  const na = String(nextAction || '').trim();
  if (na) return na;
  const ur = String(urgent || '').trim();
  if (ur) return ur;
  if (selectedTags.indexOf('缺貨') >= 0) return '缺貨';
  if (selectedTags.indexOf('客訴') >= 0) return '客訴';
  return '';
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

// ---- fv2RuleTagHints_：關鍵字規則命中 ----
assertEqual('缺貨關鍵字「沒貨」命中', fv2RuleTagHints_('老闆說沒貨了').map(h => h.tag), ['缺貨']);
assertEqual('缺貨規則不再因單字「缺」命中（已移除）', fv2RuleTagHints_('今天人手有點缺').map(h => h.tag), []);
assertEqual('客訴關鍵字「客訴」命中', fv2RuleTagHints_('客人客訴要退貨').map(h => h.tag).sort(), ['客訴']);
assertEqual('客訴規則不再因「有問題」命中（已移除）', fv2RuleTagHints_('機台好像有問題').map(h => h.tag), []);
assertEqual('客訴關鍵字「不好用」仍命中', fv2RuleTagHints_('說這個不好用').map(h => h.tag), ['客訴']);
assertEqual('價格關鍵字「很貴」命中', fv2RuleTagHints_('客人說很貴').map(h => h.tag), ['價格']);
assertEqual('競品關鍵字「別家」命中', fv2RuleTagHints_('客人在比較別家的產品').map(h => h.tag), ['競品']);
assertEqual('滿意關鍵字「回購」命中', fv2RuleTagHints_('客人說要回購').map(h => h.tag), ['滿意']);
assertEqual('其他沒有關鍵字規則，永遠不會被命中', fv2RuleTagHints_('隨便打一些字其他其他').map(h => h.tag), []);
assertEqual('空字串不命中任何標籤', fv2RuleTagHints_(''), []);
assertEqual('null 文字不報錯、回傳空陣列', fv2RuleTagHints_(null), []);

// ---- fv2MergeTagHints_：rule 與 ai 合併，同 tag 時 ai 蓋過 rule ----
assertEqual(
  'rule 與 ai 沒有重疊時合併兩者',
  fv2MergeTagHints_([{ tag: '缺貨', source: 'rule', evidence: '沒貨' }], [{ tag: '價格', source: 'ai', evidence: '貴' }])
    .map(h => h.tag).sort(),
  ['價格', '缺貨']
);
assertEqual(
  '同一個 tag 兩個來源都命中時，ai 蓋過 rule',
  fv2MergeTagHints_([{ tag: '缺貨', source: 'rule', evidence: '沒貨' }], [{ tag: '缺貨', source: 'ai', evidence: 'AI判斷' }]),
  [{ tag: '缺貨', source: 'ai', evidence: 'AI判斷' }]
);
assertEqual('兩個來源都空陣列，回傳空陣列', fv2MergeTagHints_([], []), []);

// ---- fv2ShouldAutoCheckFollowup_：自動勾選「同時建立待追蹤」規則 ----
assertEqual('下次要記得有內容 → 自動勾', fv2ShouldAutoCheckFollowup_('帶新品試用包', '', []), true);
assertEqual('緊急問題有內容 → 自動勾', fv2ShouldAutoCheckFollowup_('', '客人很生氣', []), true);
assertEqual('選了缺貨標籤 → 自動勾', fv2ShouldAutoCheckFollowup_('', '', ['缺貨']), true);
assertEqual('選了客訴標籤 → 自動勾', fv2ShouldAutoCheckFollowup_('', '', ['客訴']), true);
assertEqual('只選了價格標籤（非缺貨/客訴）→ 不自動勾', fv2ShouldAutoCheckFollowup_('', '', ['價格']), false);
assertEqual('下次要記得/緊急問題皆空白、標籤也沒選 → 不自動勾', fv2ShouldAutoCheckFollowup_('', '', []), false);
assertEqual('下次要記得只有空白字元（trim後為空）→ 不自動勾', fv2ShouldAutoCheckFollowup_('   ', '', []), false);

// ---- fv2FollowupItemText_：待追蹤 item 內容優先序 ----
assertEqual(
  '下次要記得優先於緊急問題與標籤',
  fv2FollowupItemText_('帶新品試用包', '客人很生氣', ['缺貨']),
  '帶新品試用包'
);
assertEqual('沒有下次要記得時用緊急問題', fv2FollowupItemText_('', '客人很生氣', ['缺貨']), '客人很生氣');
assertEqual('都沒有文字時，缺貨優先於客訴', fv2FollowupItemText_('', '', ['客訴', '缺貨']), '缺貨');
assertEqual('只選客訴時回傳客訴', fv2FollowupItemText_('', '', ['客訴']), '客訴');
assertEqual('都沒有內容時回傳空字串（不再建立泛用「拜訪後續」）', fv2FollowupItemText_('', '', []), '');
assertEqual('只選了價格標籤，沒有其他文字 → 回傳空字串', fv2FollowupItemText_('', '', ['價格']), '');

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
