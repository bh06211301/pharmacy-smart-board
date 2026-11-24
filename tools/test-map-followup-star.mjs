// 2026-11-24：驗證 planner.html 地圖「有未完成待追蹤的店＝星星形狀」改動——followupItemsOf_()
// 的資料合併去重邏輯、markerIconPathAndScale_() 依有無待追蹤決定 icon（星星 vs 圓點，顏色/描邊
// 完全不變），以及 openMapInfo() 待追蹤文字列的 HTML 跳脫。
// 跟既有測試檔同一個慣例：複製貼上 planner.html 的純邏輯函式（不是 import，這個檔案沒有對外
// 匯出這些內部函式），用假的 google.maps stub 取代真正的 SDK，只測資料邏輯跟字串輸出本身。
// 執行：node tools/test-map-followup-star.mjs

// ---- 假的 google.maps stub（markerIconPathAndScale_ 只用到 SymbolPath.CIRCLE 這個常數）----
global.google = { maps: { SymbolPath: { CIRCLE: 'CIRCLE' } } };

// ---- 原封不動複製自 planner.html（2026-11-24 新增的部分）----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function followupItemsOf_(id, planData, anchors) {
  const result = [];
  const seen = new Set();
  const rec = (planData?.recommended || []).find(x => x.id === id);
  (rec?.followupItems || []).forEach(it => { if (it && !seen.has(it)) { seen.add(it); result.push(it); } });
  anchors.filter(a => a.id === id && a.source === '待追蹤').forEach(a => {
    if (a.item && !seen.has(a.item)) { seen.add(a.item); result.push(a.item); }
  });
  return result;
}

const FOLLOWUP_STAR_PATH_ = 'M0,-1 L0.2939,-0.4045 L0.9511,-0.309 L0.4755,0.1545 L0.5878,0.809 L0,0.5 L-0.5878,0.809 L-0.4755,0.1545 L-0.9511,-0.309 L-0.2939,-0.4045 Z';
const FOLLOWUP_STAR_SCALE_UP_BIG_ = 1.15;
const FOLLOWUP_STAR_SCALE_UP_SMALL_ = 1.3;
function markerIconPathAndScale_(id, baseScale, scaleUpFactor, planData, anchors) {
  const hasFollowup = followupItemsOf_(id, planData, anchors).length > 0;
  return hasFollowup
    ? { path: FOLLOWUP_STAR_PATH_, scale: baseScale * scaleUpFactor }
    : { path: google.maps.SymbolPath.CIRCLE, scale: baseScale };
}

function followupLineHtml_(id, planData, anchors) {
  const followups = followupItemsOf_(id, planData, anchors);
  return followups.length
    ? `<div class="map-info-line">待追蹤：${followups.map(it => escapeHtml(it)).join('、')}</div>`
    : '';
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

// ---- followupItemsOf_：只有 followupItems（未到期）----
{
  const planData = { recommended: [{ id: 'P1', name: 'P1藥局', type: 'customer', followupItems: ['D3 兩盒', '補單'] }] };
  const anchors = [];
  assertEqual('只有 followupItems：回傳原陣列內容', followupItemsOf_('P1', planData, anchors), ['D3 兩盒', '補單']);
}

// ---- followupItemsOf_：只有 anchors 待追蹤（已到期）----
{
  const planData = { recommended: [] };
  const anchors = [{ id: 'P1', name: 'P1藥局', source: '待追蹤', item: '收款' }];
  assertEqual('只有 anchors 待追蹤：回傳 a.item 包成的陣列', followupItemsOf_('P1', planData, anchors), ['收款']);
}

// ---- followupItemsOf_：兩者並存，去重----
{
  const planData = { recommended: [{ id: 'P1', name: 'P1藥局', type: 'customer', followupItems: ['補單'] }] };
  const anchors = [{ id: 'P1', name: 'P1藥局', source: '待追蹤', item: '補單' }, { id: 'P1', name: 'P1藥局', source: '待追蹤', item: '收款' }];
  assertEqual('兩者並存：重複的「補單」只出現一次，加上 anchors 獨有的「收款」', followupItemsOf_('P1', planData, anchors), ['補單', '收款']);
}

// ---- followupItemsOf_：沒有時為空陣列----
{
  const planData = { recommended: [{ id: 'P1', name: 'P1藥局', type: 'customer', followupItems: [] }] };
  const anchors = [{ id: 'P1', name: 'P1藥局', source: '送貨' }];
  assertEqual('沒有待追蹤：回傳空陣列', followupItemsOf_('P1', planData, anchors), []);
}
{
  // id 不存在於 recommended/anchors 任何一邊
  assertEqual('完全查不到這個 id：回傳空陣列', followupItemsOf_('P9', { recommended: [] }, []), []);
}

// ---- markerIconPathAndScale_：有待追蹤時 icon 為星星且填色與原本一致（填色由呼叫端另外帶，
// 這支只負責 path/scale，所以這裡只驗證 path/scale 正確，填色驗證見下面「原本一致」的組合測試）----
{
  const planData = { recommended: [{ id: 'P1', type: 'customer', followupItems: ['補單'] }] };
  const anchors = [];
  const iconBig = markerIconPathAndScale_('P1', 14, FOLLOWUP_STAR_SCALE_UP_BIG_, planData, anchors);
  assertEqual('大標記有待追蹤：path 是星星', iconBig.path, FOLLOWUP_STAR_PATH_);
  assertEqual('大標記有待追蹤：scale 放大 1.15 倍', iconBig.scale, 14 * 1.15);
  const iconSmall = markerIconPathAndScale_('P1', 7, FOLLOWUP_STAR_SCALE_UP_SMALL_, planData, anchors);
  assertEqual('小標記有待追蹤：path 是星星', iconSmall.path, FOLLOWUP_STAR_PATH_);
  assertEqual('小標記有待追蹤：scale 放大 1.3 倍', iconSmall.scale, 7 * 1.3);
}
// ---- 組合測試：有待追蹤時，完整 icon 物件（含呼叫端帶的填色/描邊）跟原本「只是把 path/scale
// 換成星星」完全一致，其餘欄位不變（對應 renderMap() 的 { ...markerIconPathAndScale_(...), fillColor, ... } 寫法）----
{
  const planData = { recommended: [{ id: 'P1', type: 'customer', followupItems: ['補單'] }] };
  const anchors = [];
  const icon = { ...markerIconPathAndScale_('P1', 14, FOLLOWUP_STAR_SCALE_UP_BIG_, planData, anchors), fillColor: '#111', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 };
  assertEqual('有待追蹤：fillColor/fillOpacity/strokeColor/strokeWeight 原封不動', [icon.fillColor, icon.fillOpacity, icon.strokeColor, icon.strokeWeight], ['#111', 1, '#fff', 2]);
  assertEqual('有待追蹤：path 換成星星', icon.path, FOLLOWUP_STAR_PATH_);
}

// ---- markerIconPathAndScale_：沒待追蹤時 icon 仍為圓點，scale 維持原值不放大----
{
  const planData = { recommended: [{ id: 'P1', type: 'customer', followupItems: [] }] };
  const anchors = [];
  const icon = markerIconPathAndScale_('P1', 14, FOLLOWUP_STAR_SCALE_UP_BIG_, planData, anchors);
  assertEqual('沒待追蹤：path 維持 CIRCLE', icon.path, 'CIRCLE');
  assertEqual('沒待追蹤：scale 維持原值（不放大）', icon.scale, 14);
}

// ---- 空心新店（type: 'new-store'）有待追蹤時一樣換成星星，填色/描邊（白底深描邊）不變----
{
  const planData = { recommended: [{ id: 'N1', type: 'new-store', followupItems: [] }] };
  const anchors = [{ id: 'N1', name: '新店', source: '待追蹤', item: '確認鋪貨' }];
  const icon = { ...markerIconPathAndScale_('N1', 7, FOLLOWUP_STAR_SCALE_UP_SMALL_, planData, anchors), fillColor: '#fff', fillOpacity: 1, strokeColor: '#222', strokeWeight: 2 };
  assertEqual('空心新店有待追蹤：path 換成星星', icon.path, FOLLOWUP_STAR_PATH_);
  assertEqual('空心新店有待追蹤：scale 放大 1.3 倍', icon.scale, 7 * 1.3);
  assertEqual('空心新店有待追蹤：白底深描邊不變', [icon.fillColor, icon.strokeColor], ['#fff', '#222']);
}

// ---- 資訊窗文字跳脫：事項含 <script> ----
{
  const planData = { recommended: [{ id: 'P1', type: 'customer', followupItems: ['<script>alert(1)</script>'] }] };
  const anchors = [];
  const html = followupLineHtml_('P1', planData, anchors);
  assertTrue('待追蹤事項含 <script>：原始標籤被跳脫，不是明文出現', !html.includes('<script>alert(1)</script>'));
  assertTrue('待追蹤事項含 <script>：跳脫後的文字有出現在輸出裡', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
}
// ---- 沒有待追蹤時，資訊窗不多出這一段----
{
  const html = followupLineHtml_('P9', { recommended: [] }, []);
  assertEqual('沒有待追蹤：資訊窗不多出待追蹤那一行', html, '');
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
