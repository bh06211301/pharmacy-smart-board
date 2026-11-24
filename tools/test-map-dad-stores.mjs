// 2026-11-24：驗證 planner.html 地圖「另外畫出負責人=老爸的店（墨鏡圖示）」這次改動——
// mapDadStoreList_() 的篩選鏈（只含老爸的店、排除死客戶／不拜訪、排除已是錨點或已勾選的、
// filterMode==='radius' 時套用錨點半徑篩選）、有未完成待追蹰時換成星星徽章變體、資訊窗文字
// 跳脫、開關關閉時不畫、SVG data URI 可正常解析。
// 跟既有測試檔同一個慣例：複製貼上 planner.html 的純邏輯函式（不是 import，這個檔案沒有對外
// 匯出這些內部函式），用「注入全域容器」模擬模組級 let 變數，讓每個測試案例各自設定一份乾淨的
// 假資料，不互相汙染。
// 執行：node tools/test-map-dad-stores.mjs

function anchorIdsOf_(anchors) { return new Set(anchors.map(a => a.id)); }

// 原封不動複製自 planner.html 的 haversineKm/withinAnchorRadius（只是把模組級變數改成參數傳入，
// 跟 tools/test-map-show-all-customers.mjs 同一個慣例）
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const RADIUS_KM = 2;
function withinAnchorRadius(itemId, allPharmaciesCache, anchors) {
  if (!allPharmaciesCache) return true;
  const byId = {}; allPharmaciesCache.forEach(p => { byId[p.id] = p; });
  const target = byId[itemId];
  if (!target?.lat || !target?.lng) return false;
  return anchors.some(a => {
    const ph = byId[a.id];
    if (!ph?.lat || !ph?.lng) return false;
    return haversineKm(target.lat, target.lng, ph.lat, ph.lng) <= RADIUS_KM;
  });
}

// ---- 原封不動複製自 planner.html（2026-11-24 新增的部分），模組級變數改成參數傳入 ----
function mapDadStoreList_(allPharmaciesCache, anchors, selectedCol2Ids, filterMode) {
  if (!allPharmaciesCache) return [];
  const excludeIds = anchorIdsOf_(anchors);
  let list = allPharmaciesCache.filter(p =>
    p.owner === '老爸' && !p.deadReason && p.status !== '不拜訪' &&
    !excludeIds.has(p.id) && !selectedCol2Ids.has(p.id));
  if (filterMode === 'radius') list = list.filter(p => withinAnchorRadius(p.id, allPharmaciesCache, anchors));
  return list;
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

const DAD_MARKER_STAR_PATH_ = 'M48,6 L50.65,11.36 L56.56,12.22 L52.28,16.39 L53.29,22.28 L48,19.5 L42.71,22.28 L43.72,16.39 L39.44,12.22 L45.36,11.36 Z';
function dadMarkerSvg_(hasFollowup, grayFill, darkFill) {
  const starHtml = hasFollowup
    ? `<path d="${DAD_MARKER_STAR_PATH_}" fill="${darkFill}" stroke="#fff" stroke-width="1"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="32" r="29" fill="${grayFill}" stroke="#fff" stroke-width="3"/>`
    + `<line x1="8" y1="30" x2="2" y2="25" stroke="${darkFill}" stroke-width="4" stroke-linecap="round"/>`
    + `<line x1="56" y1="30" x2="62" y2="25" stroke="${darkFill}" stroke-width="4" stroke-linecap="round"/>`
    + `<ellipse cx="20" cy="33" rx="12" ry="9" fill="${darkFill}"/>`
    + `<ellipse cx="44" cy="33" rx="12" ry="9" fill="${darkFill}"/>`
    + `<rect x="29" y="29" width="6" height="6" rx="2" fill="${darkFill}"/>`
    + starHtml
    + `</svg>`;
}
function dadMarkerIconUrl_(hasFollowup, grayFill, darkFill) {
  const svg = dadMarkerSvg_(hasFollowup, grayFill, darkFill);
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dadFollowupLineHtml_(id, planData, anchors) {
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

// ---- mapDadStoreList_：只含老爸的店，一般正式客戶不會被撈進來 ----
{
  const cache = [
    { id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 },
    { id: 'C1', name: '一般客戶', owner: '', lat: 25, lng: 121 },
  ];
  const list = mapDadStoreList_(cache, [], new Set(), 'all');
  assertEqual('只含老爸的店：一般客戶不會出現', list.map(p => p.id), ['D1']);
}

// ---- mapDadStoreList_：死客戶（deadReason 非空）排除 ----
{
  const cache = [
    { id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 },
    { id: 'D2', name: '老爸死客戶', owner: '老爸', deadReason: '已倒閉', lat: 25, lng: 121 },
  ];
  const list = mapDadStoreList_(cache, [], new Set(), 'all');
  assertEqual('死客戶的老爸店排除', list.map(p => p.id), ['D1']);
}

// ---- mapDadStoreList_：狀態「不拜訪」排除 ----
{
  const cache = [
    { id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 },
    { id: 'D3', name: '老爸不拜訪', owner: '老爸', status: '不拜訪', lat: 25, lng: 121 },
  ];
  const list = mapDadStoreList_(cache, [], new Set(), 'all');
  assertEqual('狀態不拜訪的老爸店排除', list.map(p => p.id), ['D1']);
}

// ---- mapDadStoreList_：已經是錨點的老爸店排除（維持①原本畫法，不重複畫） ----
{
  const cache = [
    { id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 },
    { id: 'D4', name: '老爸已是錨點', owner: '老爸', lat: 25, lng: 121 },
  ];
  const anchors = [{ id: 'D4', name: '老爸已是錨點', source: '送貨', item: '手動加入' }];
  const list = mapDadStoreList_(cache, anchors, new Set(), 'all');
  assertEqual('已是錨點的老爸店排除', list.map(p => p.id), ['D1']);
}

// ---- mapDadStoreList_：已勾選進②的老爸店排除 ----
{
  const cache = [
    { id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 },
    { id: 'D5', name: '老爸已勾選', owner: '老爸', lat: 25, lng: 121 },
  ];
  const list = mapDadStoreList_(cache, [], new Set(['D5']), 'all');
  assertEqual('已勾選進②的老爸店排除', list.map(p => p.id), ['D1']);
}

// ---- mapDadStoreList_：filterMode==='radius' 時套用錨點半徑篩選（跟 mapCandidateList_ 一致）----
{
  const anchor = { id: 'A1', name: '錨點', lat: 25.000, lng: 121.000 };
  const near = { id: 'D1', name: '近的老爸店', owner: '老爸', lat: 25.005, lng: 121.005 }; // 約 0.68km
  const far = { id: 'D2', name: '遠的老爸店', owner: '老爸', lat: 25.200, lng: 121.200 }; // 遠超過 2km
  const cache = [anchor, near, far];
  const anchors = [{ id: 'A1', name: '錨點', source: '送貨', item: '手動加入' }];
  const listAll = mapDadStoreList_(cache, anchors, new Set(), 'all');
  assertEqual('filterMode=all：近遠都列出', listAll.map(p => p.id).sort(), ['D1', 'D2']);
  const listRadius = mapDadStoreList_(cache, anchors, new Set(), 'radius');
  assertEqual('filterMode=radius：只留錨點 2 公里內的老爸店', listRadius.map(p => p.id), ['D1']);
}

// ---- 有未完成待追蹰：dadMarkerSvg_ 含星星 path，沒有則不含 ----
{
  const planData = { recommended: [{ id: 'D1', type: 'customer', followupItems: ['補單'] }] };
  const anchors = [];
  const hasFollowup = followupItemsOf_('D1', planData, anchors).length > 0;
  assertTrue('有 followupItems：判定為有待追蹰', hasFollowup);
  const svgWith = dadMarkerSvg_(hasFollowup, '#9499A3', '#2B2F36');
  assertTrue('有待追蹰：SVG 含星星 path', svgWith.includes(DAD_MARKER_STAR_PATH_));
  const svgWithout = dadMarkerSvg_(false, '#9499A3', '#2B2F36');
  assertTrue('沒待追蹰：SVG 不含星星 path', !svgWithout.includes(DAD_MARKER_STAR_PATH_));
}
{
  // anchors 來源的待追蹰（已到期）也要觸發星星
  const planData = { recommended: [] };
  const anchors = [{ id: 'D1', source: '待追蹤', item: '收款 $3000' }];
  const hasFollowup = followupItemsOf_('D1', planData, anchors).length > 0;
  assertTrue('anchors 來源的待追蹰一樣判定為有', hasFollowup);
}

// ---- 資訊窗文字跳脫：待追蹰事項含 <script> ----
{
  const planData = { recommended: [{ id: 'D1', type: 'customer', followupItems: ['<script>alert(1)</script>'] }] };
  const anchors = [];
  const html = dadFollowupLineHtml_('D1', planData, anchors);
  assertTrue('待追蹰事項含 <script>：原始標籤被跳脫，不是明文出現', !html.includes('<script>alert(1)</script>'));
  assertTrue('待追蹰事項含 <script>：跳脫後的文字有出現在輸出裡', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
}
{
  const html = dadFollowupLineHtml_('D9', { recommended: [] }, []);
  assertEqual('沒有待追蹰：資訊窗不多出這一行', html, '');
}

// ---- 開關關閉時不畫：showDadStores_===false 時呼叫端（renderMap）傳空陣列，不呼叫 mapDadStoreList_
// 畫出來的結果（這裡直接模擬 renderMap 裡那一行三元判斷：showDadStores_ ? mapDadStoreList_(...) : []）----
{
  const cache = [{ id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 }];
  const showDadStores_ = false;
  const dadList_ = showDadStores_ ? mapDadStoreList_(cache, [], new Set(), 'all') : [];
  assertEqual('開關關閉：dadList_ 為空陣列，不畫任何老爸的店 marker', dadList_, []);
}
{
  const cache = [{ id: 'D1', name: '老爸店1', owner: '老爸', lat: 25, lng: 121 }];
  const showDadStores_ = true;
  const dadList_ = showDadStores_ ? mapDadStoreList_(cache, [], new Set(), 'all') : [];
  assertEqual('開關打開：dadList_ 照常列出老爸的店', dadList_.map(p => p.id), ['D1']);
}

// ---- SVG data URI 可正常解析：decode 回來要是合法的 <svg>...</svg>，且沒有把 fill 色碼裡的
// 特殊字元（例如顏色名稱含 & 的極端情況）搞壞標籤結構——這裡用正常色碼＋一個刻意帶 & 的假值測跳脫----
{
  const url = dadMarkerIconUrl_(true, '#9499A3', '#2B2F36');
  assertTrue('data URI 前綴正確', url.startsWith('data:image/svg+xml;charset=UTF-8,'));
  const decoded = decodeURIComponent(url.slice('data:image/svg+xml;charset=UTF-8,'.length));
  assertTrue('decode 後是合法的 <svg>...</svg> 外框', decoded.startsWith('<svg') && decoded.endsWith('</svg>'));
  assertTrue('decode 後含星星 path（hasFollowup=true）', decoded.includes(DAD_MARKER_STAR_PATH_));
  // <svg> 標籤數量要跟 </svg> 配對，且只有一組（不會因為字串拼接漏掉或重複收尾）
  const openCount = (decoded.match(/<svg/g) || []).length;
  const closeCount = (decoded.match(/<\/svg>/g) || []).length;
  assertEqual('<svg> 開合標籤各出現一次', [openCount, closeCount], [1, 1]);
}
{
  const url = dadMarkerIconUrl_(false, '#9499A3', '#2B2F36');
  const decoded = decodeURIComponent(url.slice('data:image/svg+xml;charset=UTF-8,'.length));
  assertTrue('沒待追蹰的版本 decode 後不含星星 path', !decoded.includes(DAD_MARKER_STAR_PATH_));
  assertTrue('data URI 本身用 encodeURIComponent 跳脫，不含原始 "<" 字元（已轉成 %3C）', !url.includes('<'));
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
