// 2026-11-27：field-v2.html 新增 ?voice=1&text=…（iPhone 捷徑「聽寫文字」原樣帶進拜訪內容框）的邏輯測試。
// 慣例同 tools/test-field-voice-entry.mjs：原封不動複製 field-v2.html 裡的純邏輯函式，DOM／location／
// history／toast 用假物件代替，不開瀏覽器、不呼叫任何真實 API／定位。另外用 Function.prototype.toString
// 比對複製的函式跟 field-v2.html 裡的原文完全一致，避免兩邊之後改到不同步。
// 執行：node tools/test-field-voice-dictation.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'field-v2.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${label}`); }
}

// ============================================================
// 假環境：document（只有用到的幾個元素）、location、history、fv2Toast_
// ============================================================
let innerHtmlWrites = 0;
function makeEl(id) {
  const el = {
    id, value: '', hidden: true, events: [],
    dispatchEvent(ev) { this.events.push(ev.type); return true; },
  };
  Object.defineProperty(el, 'innerHTML', { set() { innerHtmlWrites++; }, get() { return ''; } });
  return el;
}
let els = {};
let createdElements = 0;
globalThis.document = {
  getElementById: (id) => els[id] || null,
  createElement: () => { createdElements++; return makeEl('x'); },
};
let replaceCalls = [];
let toasts = [];
function fv2Toast_(msg, isError) { toasts.push({ msg, isError }); }
let VOICE_ENTRY = false;

function resetEnv(search, { voice } = {}) {
  els = {
    'voice-text-pending-note': makeEl('voice-text-pending-note'),
    'record-customer-content': makeEl('record-customer-content'),
    'record-newstore-content': makeEl('record-newstore-content'),
  };
  innerHtmlWrites = 0;
  createdElements = 0;
  replaceCalls = [];
  toasts = [];
  fv2VoicePendingText_ = null;
  lastStore = null;
  VOICE_ENTRY = voice !== undefined ? voice : new URLSearchParams(search).get('voice') === '1';
  const href = 'https://bh06211301.github.io/pharmacy-smart-board/field-v2.html' + search;
  globalThis.location = { search, href };
  globalThis.history = { state: null, replaceState: (_s, _t, url) => { replaceCalls.push(url); } };
}

// ---- 原封不動複製自 field-v2.html ----
const FV2_VOICE_TEXT_MAX_ = 2000;
function fv2VoiceParseText_(search) {
  const parts = String(search || '').replace(/^\?/, '').split('&');
  const part = parts.find(x => x === 'text' || x.indexOf('text=') === 0);
  if (part === undefined) return null;
  let text;
  try {
    text = decodeURIComponent(part.slice(5).replace(/\+/g, ' '));
  } catch (e) {
    return null;
  }
  if (!text.trim()) return null;
  const chars = Array.from(text); // 以字元（code point）計算，避免把 emoji 等切成半個
  if (chars.length > FV2_VOICE_TEXT_MAX_) return { text: chars.slice(0, FV2_VOICE_TEXT_MAX_).join(''), truncated: true };
  return { text, truncated: false };
}
function fv2VoiceUrlWithoutText_(href) {
  const u = new URL(href);
  u.searchParams.delete('text');
  const qs = u.searchParams.toString();
  return u.pathname + (qs ? '?' + qs : '') + u.hash;
}
function fv2VoiceMergeText_(existing, incoming) {
  const cur = String(existing || '');
  if (!cur.trim()) return incoming;
  return cur + (cur.endsWith('\n') ? '' : '\n') + incoming;
}
let fv2VoicePendingText_ = null; // 還沒帶入記錄畫面的語音文字（只存在記憶體）
function fv2VoiceShowPendingNote_(show) {
  const el = document.getElementById('voice-text-pending-note');
  if (el) el.hidden = !show;
}
function fv2VoiceApplyPendingText_(textareaId) {
  if (fv2VoicePendingText_ === null) return;
  const el = document.getElementById(textareaId);
  if (!el) return;
  el.value = fv2VoiceMergeText_(el.value, fv2VoicePendingText_);
  fv2VoicePendingText_ = null;
  fv2VoiceShowPendingNote_(false);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function fv2VoiceInitText_() {
  if (!VOICE_ENTRY) return;
  const parsed = fv2VoiceParseText_(location.search);
  if (new URLSearchParams(location.search).has('text')) {
    try { history.replaceState(history.state, '', fv2VoiceUrlWithoutText_(location.href)); } catch (e) {}
  }
  if (!parsed) return;
  fv2VoicePendingText_ = parsed.text;
  fv2VoiceShowPendingNote_(true);
  if (parsed.truncated) fv2Toast_(`語音文字超過 ${FV2_VOICE_TEXT_MAX_} 字，只帶入前 ${FV2_VOICE_TEXT_MAX_} 字`, true);
}

// ---- 模擬 fv2DoRecord_ 的進畫面順序：render（換店才清空）→ showScreen → 帶入暫存文字 ----
// （render 的「同一家店保留草稿、換店清空」規則來自 fv2RenderRecordCustomer／fv2RenderRecordNewstore）
let lastStore = null;
function simulateDoRecord(key, isNewStore) {
  const id = isNewStore ? 'record-newstore-content' : 'record-customer-content';
  if (key !== lastStore) { els[id].value = ''; lastStore = key; }
  fv2VoiceApplyPendingText_(id);
}
// 模擬 fv2VoiceEntry_ 的決策結果（決策本身已由 test-field-voice-entry.mjs 涵蓋）
function enc(s) { return encodeURIComponent(s); }

// ============================================================
// 1. 無 text：行為跟現在一致
// ============================================================
resetEnv('?test=1&voice=1');
fv2VoiceInitText_();
assert(fv2VoicePendingText_ === null, '無 text：沒有暫存文字');
assert(els['voice-text-pending-note'].hidden === true, '無 text：清單提示行維持隱藏');
assert(replaceCalls.length === 0, '無 text：不呼叫 replaceState（網址不動）');
assert(toasts.length === 0, '無 text：不跳任何提示');
simulateDoRecord('C001', false);
assert(els['record-customer-content'].value === '', '無 text：進記錄畫面拜訪內容框是空的');
assert(els['record-customer-content'].events.length === 0, '無 text：不額外觸發 input 事件');

// ============================================================
// 2. 有 text、有已到站：載入後直接進記錄畫面並帶入
// ============================================================
const said = '今天老闆說維他命缺貨，下週要補兩盒';
resetEnv(`?test=1&voice=1&text=${enc(said)}`);
fv2VoiceInitText_();
assert(fv2VoicePendingText_ === said, '已到站：讀到並暫存文字');
assert(els['voice-text-pending-note'].hidden === false, '已到站：載入期間先顯示提示行');
simulateDoRecord('C001', false); // fv2VoiceEntry_ 找到已到站 → fv2DoRecord_
assert(els['record-customer-content'].value === said, '已到站：拜訪內容框帶入原文');
assert(fv2VoicePendingText_ === null, '已到站：帶入後清掉暫存');
assert(els['voice-text-pending-note'].hidden === true, '已到站：帶入後隱藏提示行');
assert(els['record-customer-content'].events.join(',') === 'input', '已到站：帶入後補發一次 input（讓既有標籤建議接手）');

// ============================================================
// 3. 有 text、定位建議：按確認前不帶入，確認後才帶入
// ============================================================
resetEnv(`?test=1&voice=1&text=${enc(said)}`);
fv2VoiceInitText_();
assert(els['record-customer-content'].value === '', '定位建議：按確認前拜訪內容框還是空的');
assert(fv2VoicePendingText_ === said, '定位建議：按確認前文字仍暫存在記憶體');
simulateDoRecord('C003', false); // 使用者按「記錄這家」
assert(els['record-customer-content'].value === said, '定位建議：確認後帶入原文');
assert(fv2VoicePendingText_ === null, '定位建議：確認後清掉暫存');

// ============================================================
// 4. 有 text、定位失敗停在清單：暫存、提示行，手動進新店畫面才帶入，只帶一次
// ============================================================
resetEnv(`?voice=1&text=${enc(said)}`);
fv2VoiceInitText_();
assert(els['voice-text-pending-note'].hidden === false, '定位失敗：清單上顯示「已收到語音文字」提示行');
assert(fv2VoicePendingText_ === said, '定位失敗：文字暫存在記憶體');
simulateDoRecord('N010', true); // 手動點新店的「記錄這家」
assert(els['record-newstore-content'].value === said, '定位失敗：手動進新店記錄畫面時帶入');
assert(els['voice-text-pending-note'].hidden === true, '定位失敗：帶入後提示行隱藏');
simulateDoRecord('C001', false); // 之後再進別家
assert(els['record-customer-content'].value === '', '定位失敗：帶入過一次後，再進別家不會重複帶入');

// ============================================================
// 5. text 格式錯誤：忽略，但網址上的 text 一樣要清掉
// ============================================================
resetEnv('?voice=1&text=%E4%B8');
fv2VoiceInitText_();
assert(fv2VoiceParseText_('?voice=1&text=%E4%B8') === null, '格式錯誤：不完整的 %E4%B8 解析為 null');
assert(fv2VoiceParseText_('?voice=1&text=%ZZ') === null, '格式錯誤：%ZZ 解析為 null');
assert(fv2VoicePendingText_ === null, '格式錯誤：不暫存任何文字');
assert(els['voice-text-pending-note'].hidden === true, '格式錯誤：不顯示提示行');
assert(replaceCalls.length === 1 && !replaceCalls[0].includes('text'), '格式錯誤：網址上的 text 一樣被清掉');
assert(fv2VoiceParseText_('?voice=1&text=') === null, '空字串 text 視為沒有文字');
assert(fv2VoiceParseText_('?voice=1&text=%20%20') === null, '只有空白的 text 視為沒有文字');

// ============================================================
// 6. text 超過上限：截斷成 2000 字，畫面提示一次
// ============================================================
const longText = '藥'.repeat(2500);
resetEnv(`?voice=1&text=${enc(longText)}`);
fv2VoiceInitText_();
assert(Array.from(fv2VoicePendingText_).length === 2000, '超過上限：截斷成 2000 字');
assert(toasts.length === 1 && toasts[0].msg.includes('2000'), '超過上限：只提示一次，訊息含上限字數');
simulateDoRecord('C001', false);
assert(toasts.length === 1, '超過上限：進記錄畫面時不再重複提示');
const exact = fv2VoiceParseText_(`?voice=1&text=${enc('藥'.repeat(2000))}`);
assert(exact && exact.truncated === false, '剛好 2000 字不截斷');
const emojiCut = fv2VoiceParseText_(`?voice=1&text=${enc('a'.repeat(1999) + '😀😀')}`);
assert(emojiCut.truncated === true && emojiCut.text.endsWith('😀') && Array.from(emojiCut.text).length === 2000,
  '超過上限：以字元截斷，不會把 emoji 切成半個');

// ============================================================
// 7. text 含 <script>：只當純文字放進 .value，不寫 innerHTML、不建立元素
// ============================================================
const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
resetEnv(`?voice=1&text=${enc(xss)}`);
fv2VoiceInitText_();
simulateDoRecord('C001', false);
assert(els['record-customer-content'].value === xss, '<script>：原樣當文字放進拜訪內容框');
assert(innerHtmlWrites === 0, '<script>：整個流程沒有任何 innerHTML 寫入');
assert(createdElements === 0, '<script>：沒有建立任何新元素');

// ============================================================
// 8. 已有手打內容：附加在後面並換行，不覆蓋
// ============================================================
resetEnv(`?voice=1&text=${enc('語音補充')}`);
fv2VoiceInitText_();
lastStore = 'C001';
els['record-customer-content'].value = '手打的內容';
simulateDoRecord('C001', false); // 同一家店重進：草稿保留
assert(els['record-customer-content'].value === '手打的內容\n語音補充', '已有手打內容：附加在後面並換行');
assert(fv2VoiceMergeText_('第一行\n', '語音') === '第一行\n語音', '手打內容已經以換行結尾：不多加空行');
assert(fv2VoiceMergeText_('   ', '語音') === '語音', '手打內容只有空白：直接放入');
assert(fv2VoiceMergeText_('', '語音') === '語音', '拜訪內容框是空的：直接放入');

// ============================================================
// 9. replaceState 清掉 text，其他參數與 hash 保留；+ 與 %2B 的解碼
// ============================================================
resetEnv(`?test=1&voice=1&text=${enc(said)}&dev=1`);
fv2VoiceInitText_();
assert(replaceCalls.length === 1, 'replaceState：讀取後呼叫一次');
assert(replaceCalls[0] === '/pharmacy-smart-board/field-v2.html?test=1&voice=1&dev=1', 'replaceState：只拿掉 text，test／voice／dev 保留');
assert(fv2VoiceUrlWithoutText_('https://a.test/p.html?voice=1&text=abc#x') === '/p.html?voice=1#x', 'replaceState：hash 保留');
assert(fv2VoiceUrlWithoutText_('https://a.test/p.html?text=abc') === '/p.html', 'replaceState：只有 text 時網址變成乾淨路徑');
assert(fv2VoiceParseText_('?voice=1&text=a+b').text === 'a b', '解碼：+ 視為空白');
assert(fv2VoiceParseText_('?voice=1&text=1%2B1').text === '1+1', '解碼：%2B 還原成 +');
assert(fv2VoiceParseText_('?voice=1&textx=abc') === null, '解碼：textx 之類的參數名不會被誤認成 text');

// ============================================================
// 10. 沒有 voice=1：text 完全被忽略
// ============================================================
resetEnv(`?test=1&text=${enc(said)}`);
fv2VoiceInitText_();
assert(fv2VoicePendingText_ === null, '沒有 voice=1：不暫存文字');
assert(replaceCalls.length === 0, '沒有 voice=1：網址不動');
assert(els['voice-text-pending-note'].hidden === true, '沒有 voice=1：不顯示提示行');
resetEnv(`?voice=abc&text=${enc(said)}`);
fv2VoiceInitText_();
assert(fv2VoicePendingText_ === null, 'voice=abc：一樣忽略 text');

// ============================================================
// 11. 靜態檢查：複製的函式跟 field-v2.html 原文一致，插入點與既有行為沒被改動
// ============================================================
[fv2VoiceParseText_, fv2VoiceUrlWithoutText_, fv2VoiceMergeText_, fv2VoiceShowPendingNote_,
  fv2VoiceApplyPendingText_, fv2VoiceInitText_].forEach(fn => {
  assert(html.includes(fn.toString().replace(/\r\n/g, '\n')), `field-v2.html 裡的 ${fn.name} 跟測試複製的版本一致`);
});
assert(html.includes('const FV2_VOICE_TEXT_MAX_ = 2000;'), 'field-v2.html 上限常數為 2000');
const doRecordSrc = (html.match(/function fv2DoRecord_\(key\) \{[\s\S]*?\n\}\n/) || [''])[0];
assert(/showScreen\('3b-record-newstore'\);\n\s*fv2VoiceApplyPendingText_\('record-newstore-content'\);/.test(doRecordSrc),
  'fv2DoRecord_：新店畫面在 render＋showScreen 之後才帶入');
assert(/showScreen\('3-record-customer'\);\n\s*fv2VoiceApplyPendingText_\('record-customer-content'\);/.test(doRecordSrc),
  'fv2DoRecord_：客戶畫面在 render＋showScreen 之後才帶入');
assert(html.includes("showScreen('1-home');\nfv2VoiceInitText_();\nfv2LoadAll().then("),
  '頁面載入時同步讀取並清網址（在 fv2LoadAll 之前）');
assert(/<div id="voice-text-pending-note" class="dad-note" hidden>已收到語音文字，進入記錄畫面後會帶入<\/div>/.test(html),
  '清單上有預設隱藏的提示行');
const voiceBlock = (html.match(/\/\/ ---- \?voice=1&text=…[\s\S]*?function fv2VoiceEntry_\(\)/) || [''])[0];
assert(voiceBlock.length > 0, '找得到語音文字程式區塊');
assert(!/fetch\(|WORKER|sheetName|\/api\//.test(voiceBlock), '語音文字區塊沒有任何網路呼叫或寫入路徑');
assert(!/innerHTML|insertAdjacentHTML|outerHTML/.test(voiceBlock), '語音文字區塊沒有任何 HTML 插入');
assert([...html.matchAll(/<button class="mic-btn">🎙<\/button>/g)].length === 2, '麥克風按鈕兩處維持原樣');
assert(!/mic-btn['"]?\)?\.addEventListener|querySelector(All)?\(['"]\.mic-btn/.test(html), '麥克風按鈕沒有被接上任何事件');

console.log(`\n共 ${pass + fail} 筆斷言，通過 ${pass}，失敗 ${fail}`);
if (fail > 0) process.exit(1);
