// 2026-11-24：驗證 worker.js buildTodayRegions_() 新增的 followupStores/followupStoreCount
// 聚合邏輯（planner.html「今天可以跑的區」卡片要顯示「有未完成待追蹤的店與事項」）。
// 跟 field-v2 那組測試檔同一個慣例：複製貼上 worker.js 的純邏輯函式，不是 import（worker.js
// 只有 `export default { fetch }`，沒有對外匯出這些內部函式）。
// 執行：node tools/test-region-followups.mjs

// ---- 從 worker.js 複製的最小依賴（regionMinutesOf_ 用空 districtCoords，回 null，不影響測試）----
const PLANNER_CONFIG = {
  regionGroups: [
    { key: 'A', label: 'A區', districts: ['中山區', '大同區'] },
    { key: 'B', label: 'B區', districts: ['信義區', '大安區'] },
  ],
  regionFallbackLabel: '其他',
  regionHomeBase: { lat: 25.06, lng: 121.64 },
  districtCoords: {},
};

function haversineKm_(a, b) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function estimateDriveMinutes_(km) {
  const roadKm = km * 1.3;
  const speedKmh = km <= 20 ? 28 : 50;
  return Math.round(roadKm / speedKmh * 60);
}
function regionGroupOf_(city, district) {
  for (const g of PLANNER_CONFIG.regionGroups) {
    if (g.cities && g.cities.indexOf(city) >= 0) return g;
    if (g.districts && g.districts.indexOf(district) >= 0) return g;
  }
  return null;
}
function regionMinutesOf_(group) {
  const keys = [...(group.cities || []), ...(group.districts || [])];
  const mins = keys
    .map(k => PLANNER_CONFIG.districtCoords[k])
    .filter(Boolean)
    .map(coord => estimateDriveMinutes_(haversineKm_(PLANNER_CONFIG.regionHomeBase, coord)));
  if (!mins.length) return null;
  return Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
}

// ---- 原封不動複製自 worker.js（2026-11-24 新增 followupStores 聚合後的版本）----
function buildTodayRegions_(list, anchors, allPharmacies) {
  const byGroupKey = {};
  PLANNER_CONFIG.regionGroups.forEach(g => { byGroupKey[g.key] = { key: g.key, label: g.label, newStoreCount: 0, maxRatio: 0, customerDueCount: 0, deliveryCount: 0 }; });
  const fallback = { key: 'other', label: PLANNER_CONFIG.regionFallbackLabel, newStoreCount: 0, maxRatio: 0, customerDueCount: 0, deliveryCount: 0 };
  function bucketOf(city, district) {
    const g = regionGroupOf_(city, district);
    return g ? byGroupKey[g.key] : fallback;
  }
  const followupMaps = new Map();
  function followupMapOf(bucket) {
    if (!followupMaps.has(bucket)) followupMaps.set(bucket, new Map());
    return followupMaps.get(bucket);
  }
  function addFollowup(bucket, id, name, items) {
    if (!items || !items.length) return;
    const map = followupMapOf(bucket);
    const entry = map.get(id) || { id, name, items: new Set() };
    if (!entry.name) entry.name = name;
    items.forEach(it => { if (it) entry.items.add(it); });
    map.set(id, entry);
  }
  list.forEach(item => {
    const b = bucketOf(item.city, item.district);
    if (item.type === 'new-store') {
      b.newStoreCount += 1;
      if (item.ratio !== null && item.ratio > b.maxRatio) b.maxRatio = item.ratio;
    } else if (item.type === 'customer' && item.ratio >= 1) {
      b.customerDueCount += 1;
    }
    if (item.type === 'customer' && item.followupItems && item.followupItems.length) {
      addFollowup(b, item.id, item.name, item.followupItems);
    }
  });
  const pharmacyById = {};
  allPharmacies.forEach(p => { pharmacyById[p.id] = p; });
  const screeningById = {};
  list.filter(item => item.type === 'new-store').forEach(item => { screeningById[item.id] = item; });
  anchors.forEach(a => {
    const p = pharmacyById[a.id] || screeningById[a.id];
    const b = p ? bucketOf(p.city, p.district) : fallback;
    if (a.source === '送貨') {
      b.deliveryCount += 1;
    } else if (a.source === '待追蹤') {
      addFollowup(b, a.id, a.name, a.item ? [a.item] : []);
    }
  });
  function withFollowup(base, bucket, estimateMinutes) {
    const followupStores = Array.from(followupMapOf(bucket).values())
      .map(s => ({ id: s.id, name: s.name, items: Array.from(s.items) }));
    return { ...base, estimateMinutes, followupStores, followupStoreCount: followupStores.length };
  }
  const groups = PLANNER_CONFIG.regionGroups.map(g => withFollowup(byGroupKey[g.key], byGroupKey[g.key], regionMinutesOf_(g)));
  if (fallback.newStoreCount || fallback.customerDueCount || fallback.deliveryCount || followupMapOf(fallback).size) {
    groups.push(withFollowup(fallback, fallback, null));
  }
  groups.sort((a, b) => {
    const aHas = a.newStoreCount > 0;
    const bHas = b.newStoreCount > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (b.maxRatio !== a.maxRatio) return b.maxRatio - a.maxRatio;
    return b.newStoreCount - a.newStoreCount;
  });
  return groups;
}

// ---- HTML 跳脫（planner.html 既有的 escapeHtml，複製同一份邏輯）----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function regionFollowupText_(g) {
  const stores = g.followupStores || [];
  if (!stores.length) return '';
  const shown = stores.slice(0, 3).map(s => {
    const items = (s.items || []).join('、');
    return `${escapeHtml(s.name)} ${escapeHtml(items)}`;
  }).join('｜');
  const more = stores.length > 3 ? `（另 ${stores.length - 3} 家）` : '';
  return `待追蹤 ${g.followupStoreCount} 家：${shown}${more}`;
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

const allPharmacies = [
  { id: 'P1', name: 'P1藥局', city: '台北市', district: '中山區' },
  { id: 'P2', name: 'P2藥局', city: '台北市', district: '信義區' },
  { id: 'P3', name: 'P3藥局', city: '台北市', district: '中山區' },
];

// ---- 只有 followupItems（list 裡 type==='customer'）----
{
  const list = [
    { id: 'P1', name: 'P1藥局', type: 'customer', city: '台北市', district: '中山區', ratio: 0.5, followupItems: ['D3 兩盒'] },
  ];
  const groups = buildTodayRegions_(list, [], allPharmacies);
  const a = groups.find(g => g.key === 'A');
  assertEqual('只有 followupItems：A區 followupStoreCount=1', a.followupStoreCount, 1);
  assertEqual('只有 followupItems：店名與事項正確', a.followupStores, [{ id: 'P1', name: 'P1藥局', items: ['D3 兩盒'] }]);
}

// ---- 只有 anchors 裡 source==='待追蹤'（已到期）----
{
  const list = [];
  const anchors = [{ id: 'P2', name: 'P2藥局', source: '待追蹤', item: '補貨D5', deadline: '2026-11-20' }];
  const groups = buildTodayRegions_(list, anchors, allPharmacies);
  const b = groups.find(g => g.key === 'B');
  assertEqual('只有到期待追蹤：B區 followupStoreCount=1', b.followupStoreCount, 1);
  assertEqual('只有到期待追蹤：店名與事項正確', b.followupStores, [{ id: 'P2', name: 'P2藥局', items: ['補貨D5'] }]);
}

// ---- 兩者並存，同一家店要合併成一筆、事項去重 ----
{
  const list = [
    { id: 'P1', name: 'P1藥局', type: 'customer', city: '台北市', district: '中山區', ratio: 0.5, followupItems: ['D3 兩盒'] },
  ];
  const anchors = [
    { id: 'P1', name: 'P1藥局', source: '待追蹤', item: '補貨D5', deadline: '2026-11-20' },
    { id: 'P1', name: 'P1藥局', source: '待追蹤', item: 'D3 兩盒', deadline: '2026-11-21' }, // 重複事項，應去重
  ];
  const groups = buildTodayRegions_(list, anchors, allPharmacies);
  const a = groups.find(g => g.key === 'A');
  assertEqual('合併去重：A區只有 1 家（不是 2 家）', a.followupStoreCount, 1);
  assertEqual(
    '合併去重：事項合併且去重（D3 兩盒只出現一次）',
    a.followupStores[0].items.slice().sort(),
    ['D3 兩盒', '補貨D5'].sort()
  );
}

// ---- 沒有任何待追蹤時為空 ----
{
  const list = [
    { id: 'P1', name: 'P1藥局', type: 'customer', city: '台北市', district: '中山區', ratio: 0.5, followupItems: [] },
  ];
  const groups = buildTodayRegions_(list, [], allPharmacies);
  const a = groups.find(g => g.key === 'A');
  assertEqual('沒有待追蹤：followupStoreCount=0', a.followupStoreCount, 0);
  assertEqual('沒有待追蹤：followupStores 是空陣列', a.followupStores, []);
}

// ---- 店家找不到區域時（anchors 查不到任何藥局/篩選店）歸入「其他」----
{
  const list = [];
  const anchors = [{ id: 'UNKNOWN', name: '查無店家', source: '待追蹤', item: '補貨', deadline: '2026-11-20' }];
  const groups = buildTodayRegions_(list, anchors, allPharmacies);
  const other = groups.find(g => g.key === 'other');
  assertTrue('找不到區域時 fallback「其他」有被建立', !!other);
  assertEqual('fallback「其他」followupStoreCount=1', other.followupStoreCount, 1);
}

// ---- 不影響排序與其他三個統計 ----
{
  const list = [
    { id: 'P1', name: 'P1藥局', type: 'new-store', city: '台北市', district: '信義區', ratio: 2, followupItems: [] },
    { id: 'P3', name: 'P3藥局', type: 'customer', city: '台北市', district: '中山區', ratio: 1.2, followupItems: ['補單'] },
  ];
  const anchors = [{ id: 'P2', name: 'P2藥局', source: '送貨', item: '業務親送訂單', deadline: null }];
  const groups = buildTodayRegions_(list, anchors, allPharmacies);
  // B區（信義區）有新店，應排第一；A區（中山區）沒新店排第二。
  assertEqual('排序不變：B區（有新店）排第一', groups[0].key, 'B');
  assertEqual('排序不變：A區排第二', groups[1].key, 'A');
  const a = groups.find(g => g.key === 'A');
  const b = groups.find(g => g.key === 'B');
  assertEqual('customerDueCount 不受影響：A區=1（P3倍數1.2）', a.customerDueCount, 1);
  assertEqual('newStoreCount 不受影響：B區=1', b.newStoreCount, 1);
  assertEqual('deliveryCount 不受影響：B區=1（P2送貨，信義區）', b.deliveryCount, 1);
  assertEqual('followupStores 本身不影響其他統計：B區 followupStoreCount=0', b.followupStoreCount, 0);
  assertEqual('A區 followupStoreCount=1（P3）', a.followupStoreCount, 1);
}

// ---- HTML 跳脫：事項含 <script> 時被跳脫 ----
{
  const g = {
    followupStoreCount: 1,
    followupStores: [{ id: 'P1', name: '<script>alert(1)</script>', items: ['<img src=x onerror=alert(1)>'] }],
  };
  const text = regionFollowupText_(g);
  assertTrue('跳脫：輸出不含原始 <script> 標籤', !text.includes('<script>'));
  assertTrue('跳脫：輸出不含原始 <img 標籤', !text.includes('<img'));
  assertTrue('跳脫：店名的 < 被轉成 &lt;', text.includes('&lt;script&gt;'));
  assertTrue('跳脫：事項的 < 被轉成 &lt;', text.includes('&lt;img'));
}

console.log(`\n共 ${total} 項斷言，通過 ${passed} 項`);
console.log(passed === total ? '全部通過' : '有測試沒過！');
process.exit(passed === total ? 0 : 1);
