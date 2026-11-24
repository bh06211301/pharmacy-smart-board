// 2026-11-24：驗證 planner.html 地圖「不受清單收合影響，一律畫出倍數<1 的店」的改動——
// mapCandidateList_() 跟清單用的 visibleRecommendList() 共用「排除錨點」「filterMode===radius
// 時篩錨點半徑內」這兩段，但不套用 groupExpanded 收合。
// 跟既有測試檔同一個慣例：複製貼上 planner.html 的純邏輯函式（不是 import，這個檔案沒有對外
// 匯出這些內部函式），用「注入全域容器」模擬模組級 let 變數，讓每個測試案例各自設定一份乾淨的
// 假資料，不互相汙染。
// 執行：node tools/test-map-show-all-customers.mjs

function anchorIdsOf_(anchors) { return new Set(anchors.map(a => a.id)); }

// 原封不動複製自 planner.html 的 withinAnchorRadius（只是把模組級變數改成參數傳入）
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

// ---- 原封不動複製自 planner.html（2026-11-24 新增/改動的部分）----
function visibleRecommendList(planData, anchors, filterMode, groupExpanded, allPharmaciesCache) {
  if (!planData) return [];
  const excludeIds = anchorIdsOf_(anchors);
  let list = (planData.recommended || []).filter(item => !excludeIds.has(item.id));
  if (filterMode === 'radius') list = list.filter(item => withinAnchorRadius(item.id, allPharmaciesCache, anchors));
  const customerList = list.filter(x => x.type === 'customer');
  const newStoreList = list.filter(x => x.type === 'new-store');
  function part(items, groupKey) {
    const due = items.filter(x => x.ratio >= 1);
    const notYet = items.filter(x => x.ratio < 1);
    return groupExpanded[groupKey] ? due.concat(notYet) : due;
  }
  return part(newStoreList, 'newStore').concat(part(customerList, 'customer'));
}

function mapCandidateList_(planData, anchors, filterMode, allPharmaciesCache) {
  if (!planData) return [];
  const excludeIds = anchorIdsOf_(anchors);
  let list = (planData.recommended || []).filter(item => !excludeIds.has(item.id));
  if (filterMode === 'radius') list = list.filter(item => withinAnchorRadius(item.id, allPharmaciesCache, anchors));
  return list;
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

const GROUP_COLLAPSED = { customer: false, newStore: false };
const GROUP_EXPANDED = { customer: true, newStore: true };

// ---- 折疊狀態下，mapCandidateList_ 仍包含倍數 < 1 的店（customer 與 new-store 都要）----
{
  const planData = {
    recommended: [
      { id: 'C1', type: 'customer', ratio: 1.5 },
      { id: 'C2', type: 'customer', ratio: 0.3 },
      { id: 'N1', type: 'new-store', ratio: 2 },
      { id: 'N2', type: 'new-store', ratio: 0.1 },
    ],
  };
  const anchors = [];
  const ids = mapCandidateList_(planData, anchors, 'all', null).map(x => x.id);
  assertEqual('折疊狀態：mapCandidateList_ 包含全部 4 家（含倍數<1）', ids.sort(), ['C1', 'C2', 'N1', 'N2']);

  const listIds = visibleRecommendList(planData, anchors, 'all', GROUP_COLLAPSED, null).map(x => x.id);
  assertEqual('折疊狀態：visibleRecommendList 行為不變，只有倍數>=1 的 2 家', listIds.sort(), ['C1', 'N1']);
}

// ---- 排除錨點：anchors 裡的店不會出現在 mapCandidateList_ ----
{
  const planData = { recommended: [{ id: 'C1', type: 'customer', ratio: 1.5 }, { id: 'C2', type: 'customer', ratio: 0.3 }] };
  const anchors = [{ id: 'C1', source: '送貨' }];
  const ids = mapCandidateList_(planData, anchors, 'all', null).map(x => x.id);
  assertEqual('排除錨點：C1 是錨點，不出現在候選清單', ids, ['C2']);
}

// ---- radius 模式：mapCandidateList_ 仍套用錨點半徑篩選 ----
{
  const planData = {
    recommended: [
      { id: 'C1', type: 'customer', ratio: 0.5 }, // 在錨點附近
      { id: 'C2', type: 'customer', ratio: 0.5 }, // 離錨點太遠
    ],
  };
  const anchors = [{ id: 'A1', source: '送貨' }];
  const allPharmaciesCache = [
    { id: 'A1', lat: 25.05, lng: 121.52 },
    { id: 'C1', lat: 25.051, lng: 121.521 }, // 幾乎同一點，在 2km 內
    { id: 'C2', lat: 25.30, lng: 121.90 },   // 遠超過 2km
  ];
  const idsRadius = mapCandidateList_(planData, anchors, 'radius', allPharmaciesCache).map(x => x.id);
  assertEqual('radius 模式：只留半徑內的 C1（倍數<1 也一樣套用半徑篩選）', idsRadius, ['C1']);
  const idsAll = mapCandidateList_(planData, anchors, 'all', allPharmaciesCache).map(x => x.id);
  assertEqual('all 模式：不篩半徑，C1/C2 都在', idsAll.sort(), ['C1', 'C2']);
}

// ---- 清單的 visibleRecommendList 行為完全不變（展開時含倍數<1，收合時不含）----
{
  const planData = { recommended: [{ id: 'C1', type: 'customer', ratio: 1.5 }, { id: 'C2', type: 'customer', ratio: 0.3 }] };
  const anchors = [];
  assertEqual('展開時：visibleRecommendList 包含倍數<1 的店', visibleRecommendList(planData, anchors, 'all', GROUP_EXPANDED, null).map(x => x.id).sort(), ['C1', 'C2']);
  assertEqual('收合時：visibleRecommendList 不包含倍數<1 的店', visibleRecommendList(planData, anchors, 'all', GROUP_COLLAPSED, null).map(x => x.id), ['C1']);
}

// ---- 已勾選（selectedCol2Ids）的店若同時出現在候選清單，renderMap() 的 ③ 迴圈只畫一次 ----
// （對應 renderMap() 裡 `mapCandidates_.forEach(item => { if (selectedCol2Ids.has(item.id)) return; ...})`，
// 這裡直接模擬那段去重邏輯，驗證 mapCandidateList_ 回傳的清單經過這段過濾後不會跟②重複。）
{
  const planData = {
    recommended: [
      { id: 'C1', type: 'customer', ratio: 0.2 }, // 已勾選＋倍數<1
      { id: 'C2', type: 'customer', ratio: 1.8 }, // 沒勾選
    ],
  };
  const anchors = [];
  const selectedCol2Ids = new Set(['C1']);
  const mapCandidates = mapCandidateList_(planData, anchors, 'all', null);
  const thirdCircleIds = mapCandidates.filter(item => !selectedCol2Ids.has(item.id)).map(x => x.id);
  assertEqual('③ 去重：已勾選的 C1 不會在③候選店迴圈裡重複出現', thirdCircleIds, ['C2']);
  assertTrue('②：C1（倍數<1 但已勾選）仍然會被畫出來（存在於 mapCandidateList_ 結果中）', mapCandidates.some(x => x.id === 'C1'));
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
