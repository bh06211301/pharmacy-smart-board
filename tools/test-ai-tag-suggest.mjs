// 2026-11-20：驗證 field-v2.html 接上 AI 標籤建議（fv2RequestAiTagHints_）的邏輯。
// 跟 field-v2.html 裡的實作保持同一套演算法（複製貼上，不是 import，因為 field-v2.html 沒有對外
// 匯出函式，比照 test-red-slip-workdays.mjs／test-tag-followup-rules.mjs 的既有慣例）。
// 唯一的差異：debounce／逾時毫秒數改用小很多的測試用常數，純粹是為了讓測試在幾秒內跑完，
// 判斷順序與每一步的行為跟正式程式碼完全一樣（正式常數見 field-v2.html 的
// FV2_AI_TAG_MIN_LEN_／FV2_AI_TAG_DEBOUNCE_MS_／FV2_AI_TAG_TIMEOUT_MS_／FV2_AI_TAG_MAX_CALLS_）。
// 執行：node tools/test-ai-tag-suggest.mjs

const FV2_TAG_ORDER_ = ['競品', '缺貨', '客訴', '價格', '滿意', '其他'];
const WORKER = 'https://fake-worker.test';

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fv2TagHintLineHtml_(hint) {
  const evidence = escapeHtml_(hint.evidence);
  return hint.source === 'ai' ? `建議：AI 判斷（${evidence}）` : `建議：偵測到『${evidence}』`;
}

// ---- 測試用的縮小版時間常數（正式版見上方說明） ----
const FV2_AI_TAG_MIN_LEN_ = 6;
const FV2_AI_TAG_DEBOUNCE_MS_ = 30;
const FV2_AI_TAG_TIMEOUT_MS_ = 60;
const FV2_AI_TAG_MAX_CALLS_ = 3;

// ---- 以下為 fv2RequestAiTagHints_ 及其依賴，演算法與 field-v2.html 逐行一致 ----
let fv2AiTagLastSent_ = '';
let fv2AiTagCallCount_ = 0;
let fv2AiTagDebounceTimer_ = null;
let fv2AiTagController_ = null;
let fv2AiTagRequestSeq_ = 0;
let fv2FakeStoreName_ = '測試藥局';

function fv2ResetAiTagHints_() {
  if (fv2AiTagDebounceTimer_) { clearTimeout(fv2AiTagDebounceTimer_); fv2AiTagDebounceTimer_ = null; }
  if (fv2AiTagController_) { fv2AiTagController_.abort(); fv2AiTagController_ = null; }
  fv2AiTagLastSent_ = '';
  fv2AiTagCallCount_ = 0;
}
function fv2CurrentStoreName_() {
  return fv2FakeStoreName_;
}
function fv2SanitizeAiSuggestions_(suggestions) {
  return (suggestions || [])
    .filter(s => s && typeof s.tag === 'string' && FV2_TAG_ORDER_.indexOf(s.tag) >= 0)
    .map(s => ({ tag: s.tag, source: 'ai', evidence: String(s.reason || '') }));
}
async function fv2CallTagSuggestApi_(text, storeName) {
  const controller = new AbortController();
  fv2AiTagController_ = controller;
  const timeoutId = setTimeout(() => controller.abort(), FV2_AI_TAG_TIMEOUT_MS_);
  try {
    const res = await fetch(`${WORKER}/api/tag-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, storeName }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch (e) { return null; }
    if (!data || data.ok !== true || !Array.isArray(data.suggestions)) return null;
    return data.suggestions;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (fv2AiTagController_ === controller) fv2AiTagController_ = null;
  }
}
function fv2RequestAiTagHints_(text) {
  return new Promise((resolve) => {
    if (fv2AiTagDebounceTimer_) clearTimeout(fv2AiTagDebounceTimer_);
    fv2AiTagDebounceTimer_ = setTimeout(async () => {
      fv2AiTagDebounceTimer_ = null;
      const trimmed = String(text || '').trim();
      if (trimmed.length < FV2_AI_TAG_MIN_LEN_) return resolve(null);
      if (trimmed === fv2AiTagLastSent_) return resolve(null);
      if (fv2AiTagCallCount_ >= FV2_AI_TAG_MAX_CALLS_) return resolve(null);
      fv2AiTagCallCount_++;
      fv2AiTagLastSent_ = trimmed;
      const mySeq = ++fv2AiTagRequestSeq_;
      const storeName = fv2CurrentStoreName_();
      const suggestions = await fv2CallTagSuggestApi_(text, storeName);
      if (mySeq !== fv2AiTagRequestSeq_) return resolve(null);
      if (suggestions === null) return resolve(null);
      resolve(fv2SanitizeAiSuggestions_(suggestions));
    }, FV2_AI_TAG_DEBOUNCE_MS_);
  });
}

// ---- 測試工具 ----
let total = 0;
let passed = 0;
const failures = [];
function assertEqual(name, got, expect) {
  total++;
  const gotStr = JSON.stringify(got);
  const expectStr = JSON.stringify(expect);
  const pass = gotStr === expectStr;
  if (pass) passed++; else failures.push(name);
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}: got=${gotStr} expect=${expectStr}`);
}
function assertTrue(name, cond, detail) {
  total++;
  const pass = !!cond;
  if (pass) passed++; else failures.push(name);
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail !== undefined ? `: ${detail}` : ''}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function resetAllState_() {
  fv2ResetAiTagHints_();
  fv2AiTagRequestSeq_ = 0;
}

// fetch 呼叫次數計數器（用來驗證「少於6字」「重複文字」「第4次」真的沒有打網路）
let fetchCallCount = 0;
let lastFetchInit = null;

function installFetch_(impl) {
  global.fetch = async (url, init) => {
    fetchCallCount++;
    lastFetchInit = init;
    return impl(url, init);
  };
}

(async () => {
  // ---- 1. 成功：回傳的建議只保留畫面上現有標籤，過濾掉不存在的標籤 ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({
    ok: true,
    json: async () => ({ ok: true, suggestions: [{ tag: '缺貨', reason: '客人說沒貨了' }, { tag: '不存在的標籤', reason: 'x' }] }),
  }));
  {
    const hints = await fv2RequestAiTagHints_('客人說這個產品缺貨好幾天了');
    assertEqual('成功：過濾掉不存在的標籤，只留缺貨', hints, [{ tag: '缺貨', source: 'ai', evidence: '客人說沒貨了' }]);
    assertEqual('成功：有真的打到 fetch', fetchCallCount, 1);
  }

  // ---- 2. 逾時：fetch 永遠不 resolve，直到 abort 才 reject ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  {
    const t0 = Date.now();
    const hints = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    const elapsed = Date.now() - t0;
    assertEqual('逾時：靜默回傳 null', hints, null);
    assertTrue('逾時：等待時間涵蓋 debounce+timeout', elapsed >= (FV2_AI_TAG_DEBOUNCE_MS_ + FV2_AI_TAG_TIMEOUT_MS_ - 10), `elapsed=${elapsed}`);
  }

  // ---- 3. 5xx ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'gemini_http_500' }) }));
  {
    const hints = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    assertEqual('5xx：靜默回傳 null', hints, null);
  }

  // ---- 4. 4xx ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'input_too_long' }) }));
  {
    const hints = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    assertEqual('4xx：靜默回傳 null', hints, null);
  }

  // ---- 5. 格式錯誤（ok:true 但 suggestions 不是陣列／整個 json 壞掉）----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: true, json: async () => ({ ok: true, suggestions: '不是陣列' }) }));
  {
    const hints = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    assertEqual('格式錯誤（suggestions 不是陣列）：靜默回傳 null', hints, null);
  }
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }));
  {
    const hints = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    assertEqual('格式錯誤（json() 丟錯）：靜默回傳 null', hints, null);
  }

  // ---- 6. 過期回應：第一次請求還沒回來，文字已經又送出第二次新請求，第一次的結果要被丟棄 ----
  resetAllState_(); fetchCallCount = 0;
  {
    let resolveFirst;
    let callIndex = 0;
    installFetch_((url, init) => {
      callIndex++;
      if (callIndex === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, suggestions: [{ tag: '客訴', reason: '第二次' }] }) });
    });
    const firstPromise = fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    await sleep(FV2_AI_TAG_DEBOUNCE_MS_ + 5); // 讓第一次真的送出網路請求（dispatch，seq=1）
    const secondPromise = fv2RequestAiTagHints_('客人反應這個產品還在客訴中');
    await sleep(FV2_AI_TAG_DEBOUNCE_MS_ + 5); // 讓第二次也真的送出網路請求（dispatch，seq=2）
    resolveFirst({ ok: true, json: async () => ({ ok: true, suggestions: [{ tag: '缺貨', reason: '第一次（應該被丟棄）' }] }) });
    const [firstHints, secondHints] = await Promise.all([firstPromise, secondPromise]);
    assertEqual('過期回應：第一次（較舊）結果被丟棄，回傳 null', firstHints, null);
    assertEqual('過期回應：第二次（最新）結果正常回傳', secondHints, [{ tag: '客訴', source: 'ai', evidence: '第二次' }]);
  }

  // ---- 7. 切店取消：reset 時要 abort 進行中的請求 ----
  resetAllState_(); fetchCallCount = 0;
  {
    let abortedSeen = false;
    installFetch_((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        abortedSeen = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const p = fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    await sleep(FV2_AI_TAG_DEBOUNCE_MS_ + 5); // 等到真的送出網路請求、建立 controller
    fv2ResetAiTagHints_(); // 模擬切店/重設畫面
    const hints = await p;
    assertTrue('切店取消：進行中的請求有被 abort', abortedSeen);
    assertEqual('切店取消：回傳 null', hints, null);
  }

  // ---- 8. 第 4 次不送（同一畫面最多 3 次）----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: true, json: async () => ({ ok: true, suggestions: [] }) }));
  {
    const texts = ['第一次送出的內容ABC', '第二次送出的內容DEF', '第三次送出的內容GHI', '第四次送出的內容JKL'];
    const results = [];
    for (const t of texts) {
      results.push(await fv2RequestAiTagHints_(t));
    }
    assertEqual('第4次不送：前3次都有打到 fetch', fetchCallCount, 3);
    assertEqual('第4次不送：第4次回傳 null（沒有真的打網路）', results[3], null);
  }

  // ---- 9. 少於 6 字不送 ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: true, json: async () => ({ ok: true, suggestions: [] }) }));
  {
    const hints = await fv2RequestAiTagHints_('缺貨了');
    assertEqual('少於6字：回傳 null', hints, null);
    assertEqual('少於6字：完全沒打 fetch', fetchCallCount, 0);
  }

  // ---- 10. 重複文字不送 ----
  resetAllState_(); fetchCallCount = 0;
  installFetch_(async () => ({ ok: true, json: async () => ({ ok: true, suggestions: [{ tag: '缺貨', reason: 'r' }] }) }));
  {
    const first = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    const second = await fv2RequestAiTagHints_('客人反應這個產品一直缺貨'); // 完全相同的文字
    assertEqual('重複文字：第一次正常打 fetch 並回傳結果', first, [{ tag: '缺貨', source: 'ai', evidence: 'r' }]);
    assertEqual('重複文字：第二次回傳 null（跳過）', second, null);
    assertEqual('重複文字：fetch 只被呼叫 1 次', fetchCallCount, 1);
  }

  // ---- 11. 送出內容只有 content／storeName，不送 nextAction/urgent/purpose ----
  resetAllState_(); fetchCallCount = 0; lastFetchInit = null;
  fv2FakeStoreName_ = '幸福藥局';
  installFetch_(async () => ({ ok: true, json: async () => ({ ok: true, suggestions: [] }) }));
  {
    await fv2RequestAiTagHints_('客人反應這個產品一直缺貨');
    const body = JSON.parse(lastFetchInit.body);
    assertEqual('body 只有 content／storeName 兩個欄位', Object.keys(body).sort(), ['content', 'storeName']);
    assertEqual('body.storeName 正確帶出目前店名', body.storeName, '幸福藥局');
  }

  // ---- 12. reason 含 <script> 時顯示要被跳脫 ----
  {
    const hint = { tag: '客訴', source: 'ai', evidence: '<script>alert(1)</script>' };
    const html = fv2TagHintLineHtml_(hint);
    assertTrue('reason 含 <script> 時輸出不含未跳脫的標籤', html.indexOf('<script>') < 0);
    assertTrue('reason 含 <script> 時輸出含跳脫後的文字', html.indexOf('&lt;script&gt;') >= 0);
  }

  console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
  if (failures.length) console.log('失敗項目：\n- ' + failures.join('\n- '));
  console.log(passed === total ? '全部通過' : '有測試沒過！');
  process.exit(passed === total ? 0 : 1);
})();
