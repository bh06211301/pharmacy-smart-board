// 店端效期推估「涵蓋率」唯讀統計（一次性腳本，分支1：feature/shelf-expiry-estimate）。
// 只送一次 gviz 讀取請求（GET，公開試算表的唯讀端點，不帶任何金鑰/token），不寫入任何東西。
// 讀取方式照抄 worker.js 的 fetchGvizSheetRaw_（約 L1676）：直接 fetch gviz tq JSON，不經 Worker。
// 執行：node tools/stat-shelf-expiry-coverage.mjs
//
// SHEET_ORDER（出貨明細）的試算表 ID 寫在 wrangler.toml 的 [vars]，屬於文件已公開記載的 Sheet ID
// （非金鑰），沿用 CLAUDE.md 記錄的同一個 ID。

import { parseOrderNoDate } from '../shelf-expiry-logic.js';

const SHEET_ORDER_ID = '13HB7e9mzL0H6Nhfyl-AKhjO8M_GElnqPldTk-u-0ni8';
const WINDOW_DAYS = 14;
const MONTHS_BACK = 12;

async function fetchGvizSheetRaw_(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`gviz 讀取失敗：HTTP ${res.status}`);
  }
  const text = await res.text();
  const m = text.match(/^.*?({.*}).*$/s);
  if (!m) throw new Error('gviz 回應格式不符預期（抓不到 JSON 區塊）');
  const data = JSON.parse(m[1]);
  const cols = data?.table?.cols || [];
  const rows = data?.table?.rows || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });
  return { rows, colMap };
}

function gvizGet(row, colMap, label) {
  const i = colMap[label];
  if (i === undefined || !row.c[i]) return '';
  return row.c[i].v ?? '';
}

function main() {
  return fetchGvizSheetRaw_(SHEET_ORDER_ID).then(({ rows, colMap }) => {
    console.log(`原始列數：${rows.length}`);
    console.log(`欄位：${Object.keys(colMap).join('、')}`);

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let parseFailCount = 0;
    const events = []; // { store, product, date }
    const storeSet = new Set();
    const productSet = new Set();

    rows.forEach(row => {
      const store = String(gvizGet(row, colMap, '店名_備份') || '').trim();
      const product = String(gvizGet(row, colMap, '產品ID') || '').trim();
      const orderNo = gvizGet(row, colMap, '訂單編號');
      const date = parseOrderNoDate(orderNo);
      if (!date) {
        parseFailCount++;
        return;
      }
      if (date < cutoffStr) return; // 只統計近12個月
      if (!store || !product) return;
      storeSet.add(store);
      productSet.add(product);
      events.push({ store, product, date });
    });

    console.log(`\n(a) 近${MONTHS_BACK}個月出貨列數：${events.length}，涉及店家數：${storeSet.size}，產品數：${productSet.size}`);
    console.log(`(b) 訂單編號解析失敗列數：${parseFailCount}（${rows.length ? (parseFailCount / rows.length * 100).toFixed(1) : 0}%）`);

    // 依產品分組，依日期排序，統計每一筆事件在前後14天內「其他店同產品」出貨的店數
    const byProduct = {};
    events.forEach(e => {
      if (!byProduct[e.product]) byProduct[e.product] = [];
      byProduct[e.product].push(e);
    });

    const windowMs = WINDOW_DAYS * 86400000;
    const distBuckets = { '0': 0, '1': 0, '2': 0, '3-5': 0, '6+': 0 };
    let atLeastOneCount = 0;
    const perProductCoverage = {}; // product -> { total, covered }

    Object.entries(byProduct).forEach(([product, list]) => {
      perProductCoverage[product] = { total: list.length, covered: 0 };
      list.forEach(e => {
        const ms = Date.parse(`${e.date}T00:00:00Z`);
        const otherStores = new Set();
        list.forEach(other => {
          if (other.store === e.store) return;
          const otherMs = Date.parse(`${other.date}T00:00:00Z`);
          if (Math.abs(otherMs - ms) <= windowMs) otherStores.add(other.store);
        });
        const n = otherStores.size;
        if (n === 0) distBuckets['0']++;
        else if (n === 1) distBuckets['1']++;
        else if (n === 2) distBuckets['2']++;
        else if (n <= 5) distBuckets['3-5']++;
        else distBuckets['6+']++;
        if (n >= 1) {
          atLeastOneCount++;
          perProductCoverage[product].covered++;
        }
      });
    });

    console.log(`\n(c) 「其他店同產品」在前後${WINDOW_DAYS}天內的出貨店數分佈：`);
    Object.entries(distBuckets).forEach(([k, v]) => {
      console.log(`  ${k} 家：${v} 筆（${events.length ? (v / events.length * 100).toFixed(1) : 0}%）`);
    });
    console.log(`  至少1家：${atLeastOneCount} 筆（${events.length ? (atLeastOneCount / events.length * 100).toFixed(1) : 0}%）`);

    const productCoverageList = Object.entries(perProductCoverage)
      .map(([product, v]) => ({ product, total: v.total, covered: v.covered, rate: v.total ? v.covered / v.total : 0 }))
      .filter(v => v.total >= 3); // 樣本太少的產品排除，避免極端值干擾排序
    productCoverageList.sort((a, b) => b.rate - a.rate);

    console.log(`\n(d) 涵蓋率最高 10 個產品（樣本數>=3）：`);
    productCoverageList.slice(0, 10).forEach(v => {
      console.log(`  ${v.product}：${(v.rate * 100).toFixed(1)}%（${v.covered}/${v.total}）`);
    });
    console.log(`\n(d) 涵蓋率最低 10 個產品（樣本數>=3）：`);
    productCoverageList.slice(-10).reverse().forEach(v => {
      console.log(`  ${v.product}：${(v.rate * 100).toFixed(1)}%（${v.covered}/${v.total}）`);
    });

    console.log(`\n結論：推估功能的理論上限（「至少1家其他店在視窗內有同產品出貨」的比例）約 ${events.length ? (atLeastOneCount / events.length * 100).toFixed(1) : 0}%。`);
    console.log(`這只是上限——實際能推估出效期還需要那家其他店「已有已知效期記錄」（實看），目前「店端效期」表尚不存在，真實涵蓋率會更低，要等累積一段時間的實看記錄才能逼近這個上限。`);
  });
}

main().catch(err => {
  console.error(`讀取失敗：${err.message}`);
  process.exit(1);
});
