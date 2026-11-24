// 2026-11-24：驗證 planner.html「①今天一定要去」卡片新增的「送貨／請款」切換邏輯——
// anchorVisitTypes_／dadReminderHtml／toggleAnchorVisitType／todayListTypeTags_ 的「類型」欄聚合，
// 以及 worker.js handlePlannerPlan 還原今日行程錨點時的合併邏輯（2026-11-24 修正：遇到已存在的
// 送貨錨點不再整筆略過，改成補上存過的 types）。
// 跟既有測試檔同一個慣例：複製貼上 planner.html／worker.js 的純邏輯函式（不是 import，這兩個檔案
// 都沒有對外匯出這些內部函式）。DOM 相關的部分（renderAnchors/renderRecommend 等）用假的 no-op
// 取代，只測資料邏輯本身。
// 執行：node tools/test-anchor-type-toggle.mjs

// ---- 從 planner.html 複製的最小依賴 ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function anchorSourceTag_(source) {
  if (source === '送貨') return '送貨';
  if (source === '待追蹤') return '待追蹤';
  if (source === '本週排') return '本週排';
  if (source === '今天可以跑的區') return '新店';
  if (source === '手動') return '錨點';
  if (source === '該對帳' || source === '寄賣待整理') return '寄賣對帳';
  return '錨點';
}

function anchorTypeLabel(a) {
  return a.source === '待追蹤' ? '待追蹤' : a.source === '送貨' ? '送貨' : a.source || '手動';
}

function anchorVisitTypes_(a) {
  if (a.visitTypes) return a.visitTypes;
  if (anchorSourceTag_(a.source) !== '送貨') return null;
  const restored = Array.isArray(a.types) ? a.types.filter(t => t === '送貨' || t === '請款') : [];
  a.visitTypes = restored.length ? restored : ['送貨'];
  return a.visitTypes;
}

function anchorTypeAreaHtml_(a) {
  const types = anchorVisitTypes_(a);
  if (!types) return `<span class="anchor-type">${escapeHtml(anchorTypeLabel(a))}</span>`;
  return `<span class="anchor-type-group">${['送貨', '請款'].map(t => `
    <button type="button" class="anchor-type-toggle${types.includes(t) ? ' active' : ''}"
      data-action="toggle-anchor-visit-type" data-id="${escapeHtml(a.id)}" data-type="${escapeHtml(t)}">${escapeHtml(t)}</button>
  `).join('')}</span>`;
}

// ---- 以下這組測試用「注入全域容器」模擬 planner.html 的模組級 let/全域變數 ----
// （真正的 planner.html 用頂層 let anchors / allPharmaciesCache，這裡用一個可變物件包起來，
// 讓每個測試案例可以各自設定一份乾淨的假資料，不互相汙染）。
function makeEnv_(anchorsList, pharmacies) {
  const state = { anchors: anchorsList, allPharmaciesCache: pharmacies };

  function isDadStore(id) {
    const ph = (state.allPharmaciesCache || []).find(p => p.id === id);
    return !!ph && ph.owner === '老爸';
  }
  function dadReminderHtml(id) {
    if (!isDadStore(id)) return '';
    const a = state.anchors.find(x => x.id === id);
    const types = a ? anchorVisitTypes_(a) : null;
    const lines = [];
    if (!types || types.includes('送貨')) lines.push('<div>送貨：帳單要還給老爸</div>');
    if (!types || types.includes('請款')) lines.push('<div>請款：收到的錢要交給老爸</div>');
    if (!lines.length) return '';
    return `<div class="anchor-dad-reminder">${lines.join('')}</div>`;
  }
  // toggleAnchorVisitType 的同步部分（移除 render/syncTodayList_/flushTodayPlanSave_ 這些
  // DOM／網路呼叫，只留資料變動本身——這些呼叫端在真正的 planner.html 裡不影響這支邏輯對不對，
  // 已經在 Playwright 畫面驗證那邊涵蓋）。
  function toggleAnchorVisitType(id, type) {
    const a = state.anchors.find(x => x.id === id);
    if (!a) return;
    const types = anchorVisitTypes_(a);
    if (!types) return;
    if (types.includes(type)) {
      if (types.length <= 1) return;
      a.visitTypes = types.filter(t => t !== type);
    } else {
      a.visitTypes = [...types, type];
    }
  }
  // todayListTypeTags_ 簡化版：只保留跟 anchors 相關的部分（selectedCol2Ids 那段跟這次改動無關，
  // 不是這個函式在這次改動裡新增/修改的部分，省略不影響要驗證的行為）。
  function todayListTypeTagsForAnchors_(id) {
    const tags = new Set();
    state.anchors.filter(a => a.id === id).forEach(a => {
      const types = anchorVisitTypes_(a);
      if (types) types.forEach(t => tags.add(t));
      else tags.add(anchorSourceTag_(a.source));
    });
    return [...tags];
  }

  return { state, isDadStore, dadReminderHtml, toggleAnchorVisitType, todayListTypeTagsForAnchors_ };
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
function assertTrue(name, cond) {
  total++;
  if (cond) passed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
}

const dadPharmacy = { id: 'P1', name: '老爸的店', owner: '老爸' };
const normalPharmacy = { id: 'P2', name: '一般客戶', owner: '業務' };

// ---- 三種選擇對應的紅框內容：只送貨 ----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨' };
  const env = makeEnv_([anchor], [dadPharmacy]);
  const html = env.dadReminderHtml('P1');
  assertTrue('只送貨：紅框含送貨那行', html.includes('送貨：帳單要還給老爸'));
  assertTrue('只送貨：紅框不含請款那行', !html.includes('請款：收到的錢要交給老爸'));
}

// ---- 三種選擇：只請款 ----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨', visitTypes: ['請款'] };
  const env = makeEnv_([anchor], [dadPharmacy]);
  const html = env.dadReminderHtml('P1');
  assertTrue('只請款：紅框含請款那行', html.includes('請款：收到的錢要交給老爸'));
  assertTrue('只請款：紅框不含送貨那行', !html.includes('送貨：帳單要還給老爸'));
}

// ---- 三種選擇：兩個都選 ----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨', visitTypes: ['送貨', '請款'] };
  const env = makeEnv_([anchor], [dadPharmacy]);
  const html = env.dadReminderHtml('P1');
  assertTrue('兩個都選：紅框含送貨那行', html.includes('送貨：帳單要還給老爸'));
  assertTrue('兩個都選：紅框含請款那行', html.includes('請款：收到的錢要交給老爸'));
}

// ---- 至少選一個的限制：只剩一個時再點掉它，應該不變 ----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨', visitTypes: ['送貨'] };
  const env = makeEnv_([anchor], [dadPharmacy]);
  env.toggleAnchorVisitType('P1', '送貨'); // 想取消唯一剩下的選項
  assertEqual('至少選一個：取消最後一個選項不會變化', anchor.visitTypes, ['送貨']);
  env.toggleAnchorVisitType('P1', '請款'); // 加選第二個，允許
  assertEqual('至少選一個：加選第二個選項正常生效', anchor.visitTypes.slice().sort(), ['請款', '送貨'].sort());
  env.toggleAnchorVisitType('P1', '送貨'); // 兩個選一個時取消其中一個，允許（還剩一個）
  assertEqual('至少選一個：兩個選一個時取消其中一個會生效', anchor.visitTypes, ['請款']);
  env.toggleAnchorVisitType('P1', '請款'); // 現在只剩請款，再取消應該被擋下
  assertEqual('至少選一個：剩最後一個「請款」時取消會被擋下', anchor.visitTypes, ['請款']);
}

// ---- 非老爸的店不受影響：紅框永遠不顯示，不管切換狀態 ----
{
  const anchor = { id: 'P2', name: '一般客戶', source: '送貨', visitTypes: ['請款'] };
  const env = makeEnv_([anchor], [normalPharmacy]);
  assertEqual('非老爸的店：不管選什麼，紅框都是空字串', env.dadReminderHtml('P2'), '');
}

// ---- 非老爸的店：切換功能本身仍然正常運作（只是沒有紅框可看）----
{
  const anchor = { id: 'P2', name: '一般客戶', source: '送貨' };
  const env = makeEnv_([anchor], [normalPharmacy]);
  env.toggleAnchorVisitType('P2', '請款');
  assertEqual('非老爸的店：切換選項不受店家身分影響', anchor.visitTypes.slice().sort(), ['請款', '送貨'].sort());
}

// ---- 非送貨來源的卡片不受影響：維持舊的單一標籤、紅框維持舊的「兩行都顯示」----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '待追蹤', item: '補貨' };
  const env = makeEnv_([anchor], [dadPharmacy]);
  assertEqual('待追蹤來源：anchorVisitTypes_ 回 null（不適用切換）', anchorVisitTypes_(anchor), null);
  const html = env.dadReminderHtml('P1');
  assertTrue('待追蹤來源：維持舊行為，兩行都顯示（含送貨）', html.includes('送貨：帳單要還給老爸'));
  assertTrue('待追蹤來源：維持舊行為，兩行都顯示（含請款）', html.includes('請款：收到的錢要交給老爸'));
  const areaHtml = anchorTypeAreaHtml_(anchor);
  assertTrue('待追蹤來源：右上角維持舊的單一標籤，不是切換按鈕', areaHtml.includes('anchor-type"') && !areaHtml.includes('anchor-type-toggle'));
}

// ---- 存檔的欄位格式：todayListTypeTags_ 要反映使用者實際選擇，不是寫死「送貨」----
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨', visitTypes: ['請款'] };
  const env = makeEnv_([anchor], [dadPharmacy]);
  assertEqual('存檔格式：只選請款時，「類型」標籤只有請款', env.todayListTypeTagsForAnchors_('P1'), ['請款']);
}
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨', visitTypes: ['送貨', '請款'] };
  const env = makeEnv_([anchor], [dadPharmacy]);
  assertEqual('存檔格式：兩個都選時，「類型」標籤兩個都有', env.todayListTypeTagsForAnchors_('P1').slice().sort(), ['請款', '送貨'].sort());
}
{
  const anchor = { id: 'P1', name: '老爸的店', source: '送貨' }; // 還沒切換過，預設
  const env = makeEnv_([anchor], [dadPharmacy]);
  assertEqual('存檔格式：預設維持目前的類型（送貨），行為不變', env.todayListTypeTagsForAnchors_('P1'), ['送貨']);
}
{
  // 非送貨來源完全不受影響：類型標籤還是走舊的 anchorSourceTag_ 推導
  const anchor = { id: 'P3', name: '某店', source: '本週排' };
  const env = makeEnv_([anchor], []);
  assertEqual('存檔格式：非送貨來源（本週排）維持舊的推導邏輯', env.todayListTypeTagsForAnchors_('P3'), ['本週排']);
}

// ---- HTML 跳脫：店名/id 含特殊字元時被跳脫 ----
{
  const anchor = { id: 'p"1', name: '<script>alert(1)</script>', source: '送貨' };
  const html = anchorTypeAreaHtml_(anchor);
  assertTrue('跳脫：data-id 屬性裡的雙引號被轉成 &quot;', html.includes('data-id="p&quot;1"'));
  assertTrue('跳脫：沒有原始未跳脫的雙引號造成屬性斷裂', !html.includes('data-id="p"1"'));
}

// ---- worker.js handlePlannerPlan 還原今日行程錨點的合併邏輯（2026-11-24 修正）----
// 原封不動複製自 worker.js 的 todayPlanAllRows.forEach 那段（修正後版本）：freshAnchors 是
// 這次請求裡已經算出來的錨點（例如「業務親送訂單」自動偵測的送貨錨點，還沒有 types），
// todayPlanRows 是「今日行程」表今天的列（todayPlanRowToObj_ 轉換後的物件）。
const TODAY_PLAN_ANCHOR_SOURCES_ = ['錨點', '送貨', '待追蹤', '本週排', '寄賣對帳'];
function restoreTodayPlanAnchors_(freshAnchors, todayPlanRows) {
  const anchors = freshAnchors.slice();
  todayPlanRows.forEach(r => {
    if (!TODAY_PLAN_ANCHOR_SOURCES_.includes(r.source) || r.status === '移除') return;
    const existing = anchors.find(a => a.id === r.storeId);
    if (existing) {
      if (existing.source === '送貨' && !existing.types) existing.types = r.types;
      return;
    }
    anchors.push({ id: r.storeId, name: r.name, source: r.source, item: r.autoTask || r.purposeNote || '', deadline: null, types: r.types });
  });
  return anchors;
}

// 情境：今日行程已經存過「類型」=請款，同一天這家店也有「業務親送訂單」自動產生的送貨錨點
// （沒有 types）——還原後應該是同一筆錨點，types 變成存過的 ['請款']，不是維持預設、也不是
// 變成兩筆。
{
  const freshAnchors = [{ id: 'P1', name: '業務親送店', source: '送貨', item: '業務親送訂單', deadline: null }];
  const todayPlanRows = [{ storeId: 'P1', name: '業務親送店', source: '送貨', types: ['請款'], status: '待去' }];
  const result = restoreTodayPlanAnchors_(freshAnchors, todayPlanRows);
  assertEqual('業務親送＋已存請款：還原後只有一筆錨點', result.length, 1);
  assertEqual('業務親送＋已存請款：types 變成存過的請款', result[0].types, ['請款']);
  assertEqual('業務親送＋已存請款：id/來源不變', [result[0].id, result[0].source], ['P1', '送貨']);
}

// 情境：同一天沒有存過今日行程列（todayPlanRows 是空的），業務親送錨點維持原狀（沒有 types，
// 前端 anchorVisitTypes_ 之後會把它當成預設 ['送貨']）。
{
  const freshAnchors = [{ id: 'P1', name: '業務親送店', source: '送貨', item: '業務親送訂單', deadline: null }];
  const result = restoreTodayPlanAnchors_(freshAnchors, []);
  assertEqual('沒存過：還原後只有一筆錨點（原本那筆，沒有被動到）', result.length, 1);
  assertEqual('沒存過：types 維持 undefined（前端之後會當預設送貨）', result[0].types, undefined);
}

// 情境：既有錨點不是送貨來源（例如待追蹤）——不該被這次修正影響，維持「已存在就不新增」，
// 也不會被硬塞 types（「其餘邏輯不動」）。
{
  const freshAnchors = [{ id: 'P1', name: '待追蹤店', source: '待追蹤', item: 'D3 兩盒', deadline: '2026-11-24' }];
  const todayPlanRows = [{ storeId: 'P1', name: '待追蹤店', source: '待追蹤', types: ['待追蹤'], status: '待去' }];
  const result = restoreTodayPlanAnchors_(freshAnchors, todayPlanRows);
  assertEqual('非送貨來源：還原後只有一筆（不新增重複錨點）', result.length, 1);
  assertEqual('非送貨來源：既有錨點的 types 不被動到，維持 undefined', result[0].types, undefined);
}

// 情境：既有送貨錨點「已經有 types」（例如前一次迴圈/呼叫已經補過）——不應該被覆蓋。
{
  const freshAnchors = [{ id: 'P1', name: '業務親送店', source: '送貨', item: '業務親送訂單', deadline: null, types: ['送貨'] }];
  const todayPlanRows = [{ storeId: 'P1', name: '業務親送店', source: '送貨', types: ['請款'], status: '待去' }];
  const result = restoreTodayPlanAnchors_(freshAnchors, todayPlanRows);
  assertEqual('已經有 types 的既有錨點不被覆蓋', result[0].types, ['送貨']);
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
