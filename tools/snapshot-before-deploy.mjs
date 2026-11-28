// 部署前快照（唯讀，一次性腳本，分支 fix/order-raw-csv-read）。
// 對「目前線上版本」（尚未部署這次的修正）打下列 GET 端點，存成本機檔案，供部署後比對。
// 只送 GET，/api/red-slips 帶 ?fresh=1（唯讀，不寫 KV，見 worker.js 既有註解）。
// 輸出放在 tools/snapshots/before/，這個資料夾不進 git（含店家資料）。
// 執行：node tools/snapshot-before-deploy.mjs
// 2026-11-28：加上 --help/-h，印用法後直接結束，不送任何請求——這支腳本會真的打線上API，
// 之前曾經為了看內容誤用 --help 當參數，結果照樣整批打下去還覆蓋了快照檔案（見commit紀錄），
// 之後任何未知參數一律當成 --help 處理，不要悄悄當沒事繼續執行。

import fs from 'node:fs';
import path from 'node:path';

if (process.argv.slice(2).length > 0) {
  console.log(`用法：node tools/snapshot-before-deploy.mjs
不接受任何參數（含 --help/-h）。偵測到參數就只印這段說明、不送任何請求、不寫檔。
環境變數 SMARTROUTE_WORKER_BASE 可覆蓋預設的 Worker base URL。`);
  process.exit(0);
}

const BASE = process.env.SMARTROUTE_WORKER_BASE || 'https://still-meadow-0efd.bh06211301.workers.dev';
const OUT_DIR = path.join(process.cwd(), 'tools', 'snapshots', 'before');
const STORES = ['C074', 'C070', 'C037']; // C037 是已知含11碼訂單編號的店

fs.mkdirSync(OUT_DIR, { recursive: true });

function tsStamp_() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function fetchJson_(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __parseError: true, raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function saveSnapshot_(name, urlPath) {
  const { status, json } = await fetchJson_(urlPath);
  const stamp = tsStamp_();
  const file = path.join(OUT_DIR, `${name}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ urlPath, status, fetchedAt: new Date().toISOString(), data: json }, null, 2));
  return { name, file, status, json };
}

function countOf_(json, key) {
  if (!json) return null;
  if (Array.isArray(json[key])) return json[key].length;
  return null;
}

async function main() {
  const results = [];

  results.push(await saveSnapshot_('today-orders', '/today-orders'));
  results.push(await saveSnapshot_('invoice-tasks', '/invoice-tasks'));
  results.push(await saveSnapshot_('red-slips-fresh', '/api/red-slips?fresh=1'));

  for (const store of STORES) {
    results.push(await saveSnapshot_(`pharmacy-profile_${store}`, `/pharmacy-profile?pharmacy=${store}`));
    results.push(await saveSnapshot_(`api-store_${store}`, `/api/store?id=${store}`));
    results.push(await saveSnapshot_(`api-store-timeline_${store}`, `/api/store-timeline?id=${store}`));
  }

  console.log('=== 快照檔案清單與筆數 ===');
  results.forEach(r => {
    let count = '—';
    if (r.name === 'today-orders') count = countOf_(r.json, 'orders');
    else if (r.name === 'invoice-tasks') count = `invoicing=${countOf_(r.json, 'invoicing')}, collection=${countOf_(r.json, 'collection')}`;
    else if (r.name === 'red-slips-fresh') count = `toDrawer=${countOf_(r.json, 'toDrawer')}, canMail=${countOf_(r.json, 'canMail')}, items=${countOf_(r.json, 'items')}`;
    else if (r.name.startsWith('pharmacy-profile')) count = `orders=${countOf_(r.json, 'orders')}, returns=${countOf_(r.json, 'returns')}`;
    else if (r.name.startsWith('api-store-timeline')) count = `events=${countOf_(r.json, 'events')}`;
    else if (r.name.startsWith('api-store')) count = JSON.stringify(Object.keys(r.json || {}));
    console.log(`${r.name}: HTTP${r.status} -> ${path.basename(r.file)} (${count})`);
  });
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
