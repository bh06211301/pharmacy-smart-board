// 部署後快照（唯讀，一次性腳本，分支 fix/order-raw-csv-read）。
// 跟 snapshot-before-deploy.mjs 打同樣的端點，但因為SWR快取TTL是4分鐘，非fresh=1的端點
// 第一次請求可能還是拿到部署前的舊快取（命中快取直接回，不會等背景刷新），所以每個端點都打
// 兩次：第一次（若快取已過期）觸發背景重新抓取並寫回KV，等幾秒讓ctx.waitUntil()的背景工作
// 完成後，第二次請求才真正拿到新版本的資料，存檔用第二次的結果。
// /api/red-slips?fresh=1 本身就跳過快取，只打一次。
// 只送 GET，不寫入。輸出放在 tools/snapshots/after/，不進 git。
// 執行：node tools/snapshot-after-deploy.mjs
// 2026-11-28：加上 --help/-h，印用法後直接結束，不送任何請求（同 snapshot-before-deploy.mjs
// 的理由，見那支腳本的註解）。

import fs from 'node:fs';
import path from 'node:path';

if (process.argv.slice(2).length > 0) {
  console.log(`用法：node tools/snapshot-after-deploy.mjs
不接受任何參數（含 --help/-h）。偵測到參數就只印這段說明、不送任何請求、不寫檔。
環境變數 SMARTROUTE_WORKER_BASE 可覆蓋預設的 Worker base URL。`);
  process.exit(0);
}

const BASE = process.env.SMARTROUTE_WORKER_BASE || 'https://still-meadow-0efd.bh06211301.workers.dev';
const OUT_DIR = path.join(process.cwd(), 'tools', 'snapshots', 'after');
const STORES = ['C074', 'C070', 'C037'];

fs.mkdirSync(OUT_DIR, { recursive: true });

function tsStamp_() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function sleep_(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson_(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __parseError: true, raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function saveSnapshot_(name, urlPath, { primeFirst = false } = {}) {
  if (primeFirst) {
    await fetchJson_(urlPath); // 第一次：可能觸發背景刷新，結果丟掉不用
    await sleep_(3000); // 給 ctx.waitUntil() 幾秒完成背景寫回KV
  }
  const { status, json } = await fetchJson_(urlPath);
  const stamp = tsStamp_();
  const file = path.join(OUT_DIR, `${name}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ urlPath, status, fetchedAt: new Date().toISOString(), primed: primeFirst, data: json }, null, 2));
  return { name, file, status, json };
}

function countOf_(json, key) {
  if (!json) return null;
  if (Array.isArray(json[key])) return json[key].length;
  return null;
}

async function main() {
  const results = [];

  results.push(await saveSnapshot_('today-orders', '/today-orders', { primeFirst: true }));
  results.push(await saveSnapshot_('invoice-tasks', '/invoice-tasks', { primeFirst: true }));
  results.push(await saveSnapshot_('red-slips-fresh', '/api/red-slips?fresh=1'));

  for (const store of STORES) {
    results.push(await saveSnapshot_(`pharmacy-profile_${store}`, `/pharmacy-profile?pharmacy=${store}`, { primeFirst: true }));
    results.push(await saveSnapshot_(`api-store_${store}`, `/api/store?id=${store}`, { primeFirst: true }));
    results.push(await saveSnapshot_(`api-store-timeline_${store}`, `/api/store-timeline?id=${store}`, { primeFirst: true }));
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
