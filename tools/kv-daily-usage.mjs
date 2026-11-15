// TODOS_KV 每日操作數回報（寫入／刪除／讀取），資料來源 Cloudflare GraphQL Analytics。
// 用本機 wrangler 的 OAuth token（~/.wrangler/config/default.toml），token 不印出、不進 repo。
// 用法：node tools/kv-daily-usage.mjs [天數，預設 1=只看昨天(UTC)]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const days = Math.max(1, parseInt(process.argv[2] || '1', 10));
const toml = fs.readFileSync(path.join(os.homedir(), '.wrangler', 'config', 'default.toml'), 'utf8');
const token = (toml.match(/oauth_token\s*=\s*"([^"]+)"/) || [])[1];
if (!token) { console.error('找不到 wrangler oauth_token，先 npx wrangler login'); process.exit(1); }
const ACCOUNT = 'f9c6f3f26e64a3df873681836b9fdbf3';
const NAMESPACE = '85f8b8c8077a42048b8113fd05df020e'; // TODOS_KV
const FREE_DAILY_WRITES = 1000;

const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
const start = new Date(end); start.setUTCDate(start.getUTCDate() - (days - 1));
const iso = d => d.toISOString().slice(0, 10);
const q = `query($a:String!,$s:Date!,$e:Date!){ viewer { accounts(filter:{accountTag:$a}) {
  kvOperationsAdaptiveGroups(limit:1000, filter:{date_geq:$s, date_leq:$e}) {
    sum { requests } dimensions { date actionType namespaceId } } } } }`;
const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q, variables: { a: ACCOUNT, s: iso(start), e: iso(end) } }),
});
const g = await r.json();
if (g.errors) { console.error('GraphQL 錯誤', JSON.stringify(g.errors).slice(0, 300)); process.exit(1); }
const byDate = {};
for (const it of g.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups || []) {
  const { date, actionType, namespaceId } = it.dimensions;
  if (namespaceId !== NAMESPACE) continue; // 只看 TODOS_KV（filter 不接受 namespaceId，改在這裡篩）
  byDate[date] ??= { write: 0, delete: 0, read: 0 };
  byDate[date][actionType] = (byDate[date][actionType] || 0) + it.sum.requests;
}
console.log('TODOS_KV 每日操作數（UTC 日；台灣 08:00 前的操作算前一天）');
console.log('日期        寫入   刪除   讀取   寫入佔免費額度');
for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  const k = iso(d); const v = byDate[k] || { write: 0, delete: 0, read: 0 };
  console.log(`${k}  ${String(v.write).padStart(5)}  ${String(v.delete).padStart(5)}  ${String(v.read).padStart(6)}   ${(v.write / FREE_DAILY_WRITES * 100).toFixed(0)}%`);
}
