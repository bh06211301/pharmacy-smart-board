// 2026-11-26：field-v2.html 新增 ?voice=1（iPhone 捷徑直接進記錄畫面）這次改動的邏輯測試。
// 跟既有測試檔同一個慣例（見 tools/test-map-dad-stores.mjs）：原封不動複製 field-v2.html 裡的
// 純邏輯函式，把模組級變數（FV2、navigator.geolocation）改成參數傳入，不開瀏覽器、不呼叫真實
// API／定位，只驗證決策邏輯本身。
// 執行：node tools/test-field-voice-entry.mjs

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${label}`); }
}

// ---- 原封不動複製自 field-v2.html：VOICE_ENTRY 的參數判斷 ----
// const VOICE_ENTRY = new URLSearchParams(location.search).get('voice') === '1';
function parseVoiceEntry(search) {
  return new URLSearchParams(search).get('voice') === '1';
}

// ---- 原封不動複製自 field-v2.html：haversineKm_ ----
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- 原封不動複製自 field-v2.html：fv2VoiceCoord_（fv2StoreMeta_ 查詢改成直接傳 ph/rec 進來）----
function voiceCoordFor(ph, rec) {
  const lat = ph?.confirmedLat ?? ph?.lat ?? rec?.lat;
  const lng = ph?.confirmedLng ?? ph?.lng ?? rec?.lng;
  return (lat != null && lng != null) ? { lat, lng } : null;
}

// ---- 原封不動複製自 field-v2.html：fv2VoiceEntry_ + fv2VoiceLocateAndSuggest_ 合併，
// geolocation 結果改成直接傳入（success: {lat,lng} 或 null 代表失敗/被拒絕/逾時/沒有定位 API），
// coordByKey 模擬 fv2StoreMeta_ 查完座標後的結果 ----
function decideVoiceAction(rows, coordByKey, geoResult) {
  const arrived = rows.find(r => r.status === '已到');
  if (arrived) return { action: 'record', key: arrived.storeId || arrived.address };

  if (!geoResult) return { action: 'list' }; // 沒有定位 API / 被拒絕 / 逾時 / 失敗

  const withCoord = rows
    .map(r => ({ row: r, coord: coordByKey(r.storeId || r.address) }))
    .filter(x => x.coord);
  if (!withCoord.length) return { action: 'list' }; // 今日行程沒有任何店有座標

  withCoord.forEach(x => { x.distKm = haversineKm(geoResult.lat, geoResult.lng, x.coord.lat, x.coord.lng); });
  withCoord.sort((a, b) => a.distKm - b.distKm);
  const nearest = withCoord[0];
  return { action: 'suggest', key: nearest.row.storeId || nearest.row.address, distKm: nearest.distKm };
}

// ============================================================
// 假資料：3 家今日行程店，C002 刻意不給座標（模擬「這家沒有座標」被排除的情境）
// ============================================================
const rowsNoArrived = [
  { storeId: 'C001', status: '待去' },
  { storeId: 'C002', status: '待去' }, // 沒有座標
  { storeId: 'C003', status: '待去' },
];
const rowsWithArrived = [
  { storeId: 'C001', status: '待去' },
  { storeId: 'C002', status: '已到' },
  { storeId: 'C003', status: '待去' },
];
// 假座標：測試者定位在 (25.0, 121.5)；C003 比 C001 更近
const fakeCoords = {
  C001: { lat: 25.2, lng: 121.8 }, // 較遠
  C003: { lat: 25.01, lng: 121.51 }, // 較近
  // C002 沒有座標
};
function coordByKey(key) {
  const c = fakeCoords[key];
  return c ? { lat: c.lat, lng: c.lng } : null;
}
const noCoordCount = rowsNoArrived.filter(r => !coordByKey(r.storeId)).length;

// ============================================================
// 1. 無參數：VOICE_ENTRY 一律 false，行為不變
// ============================================================
assert(parseVoiceEntry('') === false, '無參數：voice 不存在時 VOICE_ENTRY 為 false');
assert(parseVoiceEntry('?test=1') === false, '無參數（只有 test=1）：VOICE_ENTRY 仍為 false');

// ============================================================
// 2. voice=1 有已到站：直接帶入該店，不理會定位
// ============================================================
{
  const result = decideVoiceAction(rowsWithArrived, coordByKey, { lat: 25.0, lng: 121.5 });
  assert(result.action === 'record', 'voice=1 有已到站：action 是 record');
  assert(result.key === 'C002', 'voice=1 有已到站：帶入的是狀態已到的那家（C002）');
}
// 即使定位失敗，有已到站一樣直接帶入（不受定位結果影響）
{
  const result = decideVoiceAction(rowsWithArrived, coordByKey, null);
  assert(result.action === 'record' && result.key === 'C002', 'voice=1 有已到站：定位失敗也不影響，一樣直接帶入');
}

// ============================================================
// 3. voice=1 無已到站、定位成功：建議最近一家，且排除沒有座標的店
// ============================================================
{
  const result = decideVoiceAction(rowsNoArrived, coordByKey, { lat: 25.0, lng: 121.5 });
  assert(result.action === 'suggest', 'voice=1 無已到站、定位成功：action 是 suggest');
  assert(result.key === 'C003', 'voice=1 無已到站、定位成功：建議距離較近的 C003，不是較遠的 C001');
  assert(result.key !== 'C002', 'voice=1 無已到站、定位成功：沒有座標的 C002 被排除在建議之外');
}

// ============================================================
// 4. 定位被拒絕 / 逾時（geoResult 為 null）：顯示清單，不強制選
// ============================================================
{
  const result = decideVoiceAction(rowsNoArrived, coordByKey, null);
  assert(result.action === 'list', 'voice=1 無已到站、定位被拒絕或逾時：fallback 顯示清單');
}

// ============================================================
// 5. 今日行程全部店家都沒有座標：即使定位成功也 fallback 顯示清單
// ============================================================
{
  const result = decideVoiceAction(rowsNoArrived, () => null, { lat: 25.0, lng: 121.5 });
  assert(result.action === 'list', '今日行程所有店都沒有座標：即使定位成功仍 fallback 顯示清單');
}

// ============================================================
// 6. 參數值不合法（voice=abc、voice=true 等）：等同沒帶參數
// ============================================================
assert(parseVoiceEntry('?voice=abc') === false, 'voice=abc：視為不合法，VOICE_ENTRY 為 false');
assert(parseVoiceEntry('?voice=true') === false, 'voice=true：視為不合法，VOICE_ENTRY 為 false');
assert(parseVoiceEntry('?voice=2') === false, 'voice=2：視為不合法，VOICE_ENTRY 為 false');
assert(parseVoiceEntry('?voice=1') === true, 'voice=1：才是合法值，VOICE_ENTRY 為 true');

// ============================================================
// 7. 確認 field-v2.html 實際程式碼裡 VOICE_ENTRY 的判斷寫法跟這份測試複製的一致，
// 避免兩邊邏輯分岔（跟既有測試檔「原封不動複製」慣例配套，之後程式改了這條測試會跟著紅燈提醒）
// ============================================================
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'field-v2.html'), 'utf8');
assert(
  html.includes(`const VOICE_ENTRY = new URLSearchParams(location.search).get('voice') === '1';`),
  'field-v2.html 裡 VOICE_ENTRY 的判斷寫法跟這份測試複製的一致'
);
assert(html.includes('fv2VoiceEntry_'), 'field-v2.html 裡有 fv2VoiceEntry_ 函式');
assert(html.includes('fv2VoiceLocateAndSuggest_'), 'field-v2.html 裡有 fv2VoiceLocateAndSuggest_ 函式');
assert(html.includes("fv2LoadAll().then(() => { if (VOICE_ENTRY) fv2VoiceEntry_(); }).catch(() => {});"),
  'field-v2.html 裡初始化流程是等 fv2LoadAll() resolve 後才判斷 VOICE_ENTRY（不是同步區塊決定）');
assert(html.includes('id="voice-suggest-card"'), 'field-v2.html 裡有定位建議確認卡片的 DOM');
const micBtnMatches = [...html.matchAll(/<button class="mic-btn">🎙<\/button><span class="stop-sub">按住說話，自動轉文字<\/span>/g)];
assert(micBtnMatches.length === 2, '麥克風按鈕的兩處標記維持原樣（文案/屬性都沒被改動）');

console.log(`（假資料中 ${noCoordCount} 家店沒有座標，已被排除在定位建議之外）`);
console.log(`\n共 ${pass + fail} 筆斷言，通過 ${pass}，失敗 ${fail}`);
if (fail > 0) process.exit(1);
